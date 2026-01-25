const fs = require('fs');
require('dotenv').config();
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const adb = require('adbkit');
const client = adb.createClient({ host: '127.0.0.1', port: 5037 });
const { spawn } = require('child_process');
const net = require('net');
const WebSocket = require('ws');

let mainWindow;
let launcherWindow;
let SELECTED_SERIAL = process.env.DEVICE_SERIAL || null; // Will be set by Launcher

function getScrcpyConfig() {
    const platform = process.platform;

    if (platform === 'win32') {
        // win32 reference
        const scrcpyDir = path.join(__dirname, 'scrcpy-win64-v3.3.4');
        return {
            scrcpyServerPath: path.join(scrcpyDir, 'scrcpy-server'),
            adbPath: path.join(scrcpyDir, 'adb.exe'),
            deviceSerial: process.env.DEVICE_SERIAL
        };
    }

    if (platform === 'darwin') {
        // macOS reference
        return {
            scrcpyServerPath: process.env.SCRCPY_SERVER_PATH || '/opt/homebrew/Cellar/scrcpy/3.3.4/share/scrcpy/scrcpy-server',
            adbPath: process.env.ADB_PATH || 'adb',
            deviceSerial: process.env.DEVICE_SERIAL
        };
    }

    throw new Error(`Unsupported platform: ${platform}`);
}

const { scrcpyServerPath: SCRCPY_SERVER_PATH, adbPath: ADB_PATH, deviceSerial: DEVICE_SERIAL } = getScrcpyConfig();

// State for Magnetic Snap
let currentVideoRatio = 9 / 16;
let currentSidebarWidth = 48; // Dynamic State
let resizeTimeout = null;

function updateWindowAspectRatio() {
    if (!mainWindow) return;

    const [wW, wH] = mainWindow.getSize();
    const [cW, cH] = mainWindow.getContentSize();

    if (cH <= 0) return;

    const chromeWidth = wW - cW;
    const chromeHeight = wH - cH;

    const videoHeight = cH;
    const videoWidth = Math.max(1, Math.round(videoHeight * currentVideoRatio));
    const contentWidth = videoWidth + currentSidebarWidth;

    const windowWidth = contentWidth + chromeWidth;
    const windowHeight = videoHeight + chromeHeight;

    const targetRatio = windowWidth / windowHeight;
    mainWindow.setAspectRatio(targetRatio);
}

function createLauncherWindow() {
    launcherWindow = new BrowserWindow({
        width: 450,
        height: 600,
        resizable: false,
        title: "Select Device",
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    launcherWindow.loadFile('launcher.html');
}

function createMainWindow() {
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
    const defaultWidth = 1280;
    const defaultHeight = 720;
    const windowWidth = Math.min(defaultWidth, screenWidth);
    const windowHeight = Math.min(defaultHeight, screenHeight);

    mainWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        center: true,
        backgroundColor: '#000',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');
    setupWindowListeners();
    updateWindowAspectRatio();
}

function setupWindowListeners() {
    // Debounced Magnetic Snap
    mainWindow.on('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            snapWindowToRatio();
        }, 200);
    });
}

function snapWindowToRatio() {
    if (!mainWindow || mainWindow.isMaximized() || mainWindow.isFullScreen()) return;

    const [wW, wH] = mainWindow.getSize();
    const [cW, cH] = mainWindow.getContentSize();

    const chromeHeight = wH - cH;
    const chromeWidth = wW - cW;

    // Use dynamic state
    const SIDEBAR_WIDTH = currentSidebarWidth;

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
    const maxContentWidth = Math.max(0, screenWidth - chromeWidth);
    const maxContentHeight = Math.max(0, screenHeight - chromeHeight);

    // Start from current content width, but keep within screen
    let targetContentWidth = Math.min(cW, maxContentWidth);
    let videoWidth = targetContentWidth - SIDEBAR_WIDTH;
    if (videoWidth <= 0) return;

    // Calculate height for this video width
    let targetVideoHeight = Math.round(videoWidth / currentVideoRatio);

    // If height exceeds screen, scale down while keeping ratio
    if (targetVideoHeight > maxContentHeight) {
        targetVideoHeight = maxContentHeight;
        videoWidth = Math.round(targetVideoHeight * currentVideoRatio);
        targetContentWidth = videoWidth + SIDEBAR_WIDTH;
    }

    const targetWindowHeight = targetVideoHeight + chromeHeight;
    const targetWindowWidth = targetContentWidth + chromeWidth;

    if (Math.abs(wH - targetWindowHeight) > 2) {
        mainWindow.setSize(targetWindowWidth, targetWindowHeight);
    }

    updateWindowAspectRatio();
}

app.whenReady().then(() => {
    // If SERIAL is explicitly set in .env, maybe skip launcher? 
    // User requested launcher back, so we ALWAYS show launcher unless they customized logic (or we can auto-connect if env is set, but let's stick to launcher for now as requested).
    createLauncherWindow();
});

// --- IPC Handlers (Launcher) ---
ipcMain.handle('get-devices', async () => {
    try {
        const devices = await client.listDevices();
        // Enrich with model names AND aliases
        const enriched = await Promise.all(devices.map(async (d) => {
            let model = 'Unknown';
            try {
                // adb -s <serial> shell getprop ro.product.model
                const props = await client.getProperties(d.id);
                model = props['ro.product.model'] || 'Android Device';
            } catch (e) { }

            let alias = null;
            if (deviceConfig[d.id] && deviceConfig[d.id].alias) {
                alias = deviceConfig[d.id].alias;
            }

            return { id: d.id, model, alias };
        }));
        return enriched;
    } catch (e) {
        console.error("ADB Error:", e);
        return [];
    }
});

ipcMain.on('connect-device', async (event, serial) => {
    console.log(`[Launcher] Selected device: ${serial}`);
    SELECTED_SERIAL = serial;

    // UI Feedback: Launcher is already showing "Connecting..."

    try {
        await startScrcpy();

        // Success: Close Launcher, Open Main
        if (launcherWindow) {
            launcherWindow.close();
            launcherWindow = null;
        }
        createMainWindow();
    } catch (e) {
        console.error("[Main] Connection Failed:", e);
        // Send error back to launcher
        if (launcherWindow && !launcherWindow.isDestroyed()) {
            launcherWindow.webContents.send('connection-failed', e.message);
        }
    }
});

// Snap Ratio IPC
ipcMain.on('set-aspect-ratio', (event, width, height) => {
    if (mainWindow) {
        currentVideoRatio = width / height;
        snapWindowToRatio();
        updateWindowAspectRatio();
    }
});

// Dynamic Sidebar IPC
ipcMain.on('resize-window', (event, sidebarWidth) => {
    if (mainWindow) {
        console.log(`[Main] Sidebar Resize: ${sidebarWidth}`);
        currentSidebarWidth = sidebarWidth;
        snapWindowToRatio();
        updateWindowAspectRatio();
    }
});

// --- Keymap Profile Management IPC ---
const KEYMAPS_DIR = path.join(__dirname, 'keymaps');
if (!fs.existsSync(KEYMAPS_DIR)) fs.mkdirSync(KEYMAPS_DIR);

ipcMain.handle('get-keymaps', async () => {
    try {
        const files = fs.readdirSync(KEYMAPS_DIR).filter(f => f.endsWith('.json'));
        return files;
    } catch (e) { console.error(e); return []; }
});

ipcMain.handle('save-keymap', async (event, name, data) => {
    try {
        const safeName = name.replace(/[^a-z0-9_\-\.]/gi, '_');
        const filePath = path.join(KEYMAPS_DIR, safeName.endsWith('.json') ? safeName : safeName + '.json');
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return { success: true, filename: path.basename(filePath) };
    } catch (e) { return { success: false, error: e.message }; }
});

const { dialog } = require('electron');
ipcMain.handle('save-keymap-dialog', async (event, data) => {
    // Show native save dialog
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Keymap Profile',
        defaultPath: path.join(KEYMAPS_DIR, 'new_profile.json'),
        filters: [{ name: 'Keymap JSON', extensions: ['json'] }]
    });

    if (result.canceled || !result.filePath) return { success: false };

    try {
        fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2));
        return { success: true, filename: path.basename(result.filePath) };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('load-keymap', async (event, name) => {
    try {
        const filePath = path.join(KEYMAPS_DIR, name);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        return {};
    } catch (e) { return {}; }
});

// --- Device Aliasing (devices.json) ---
const DEVICES_FILE = path.join(__dirname, 'devices.json');
let deviceConfig = {};
if (fs.existsSync(DEVICES_FILE)) {
    try { deviceConfig = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); } catch (e) { }
}

function saveDeviceConfig() {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(deviceConfig, null, 2));
}

ipcMain.handle('get-device-alias', async (event, serial) => {
    // If specific serial provided, check that
    const s = serial || SELECTED_SERIAL;
    if (deviceConfig[s] && deviceConfig[s].alias) {
        return deviceConfig[s].alias;
    }
    return s || 'default';
});

ipcMain.handle('set-device-alias', async (event, serial, alias) => {
    if (!deviceConfig[serial]) deviceConfig[serial] = {};
    deviceConfig[serial].alias = alias;
    saveDeviceConfig();
    return true;
});

ipcMain.handle('get-current-serial', () => SELECTED_SERIAL);


// WebSocket Server (Video/Control)
const wss = new WebSocket.Server({ port: 8080 });
const wssAudio = new WebSocket.Server({ port: 8081 });

console.log("WS (Video/Control) on 8080");
console.log("WS (Audio) on 8081");

let videoSocket = null, audioSocket = null, controlSocket = null;
let isScrcpyStarted = false;

// Stream History Buffer
let streamHistory = [];

wss.on('connection', (ws) => {
    console.log("[WSS-Video] Desktop Client connected");

    // Send History first!
    if (streamHistory.length > 0) {
        console.log(`[WSS] Sending ${streamHistory.length} buffered chunks to new client`);
        streamHistory.forEach(chunk => ws.send(chunk));
    }

    ws.on('message', (msg) => {
        if (controlSocket && !controlSocket.destroyed) {
            try { controlSocket.write(msg); } catch (e) { }
        }
    });
});

wssAudio.on('connection', (ws) => {
    console.log("[WSS-Audio] Client connected!");
});

// Helper to log to console AND frontend
function log(msg) {
    console.log(msg);
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('server-log', msg);
    }
}

function connectSockets(port) {
    log("[Node] Connecting to Video Socket...");
    videoSocket = net.connect(port, '127.0.0.1', () => {
        log("[Node] Video Socket Connected!");

        videoSocket.on('data', (d) => {
            // Log first packet only
            if (streamHistory.length === 0) log(`[Node] First Video Packet: ${d.length} bytes`);

            // 1. Buffer data
            if (wss.clients.size === 0 || streamHistory.length < 100) {
                streamHistory.push(d);
                if (streamHistory.length > 5000) streamHistory.shift();
            }
            // 2. Broadcast
            wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(d); });
        });

        videoSocket.on('error', (e) => log(`[Node] Video Socket Error: ${e.message}`));

        setTimeout(() => {
            log("[Node] Connecting to Audio...");
            audioSocket = net.connect(port, '127.0.0.1', () => {
                log("[Node] Audio Connected");
                audioSocket.on('data', (d) => {
                    wssAudio.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(d); });
                });

                setTimeout(() => {
                    controlSocket = net.connect(port, '127.0.0.1', () => log("[Node] Control Connected"));
                }, 100);
            });
        }, 100);
    });
}

async function startScrcpy() {
    if (isScrcpyStarted) { log("Scrcpy already started"); return; }
    isScrcpyStarted = true;

    try {
        const serial = SELECTED_SERIAL;
        if (!serial) throw new Error("No Serial Selected");

        if (!fs.existsSync(SCRCPY_SERVER_PATH)) {
            throw new Error(`Scrcpy Server JAR not found at: ${SCRCPY_SERVER_PATH}`);
        }

        log(`[ADB] Pushing Server to ${serial}...`);
        const transfer = await client.push(serial, SCRCPY_SERVER_PATH, '/data/local/tmp/scrcpy-server.jar');
        await new Promise((resolve, reject) => {
            transfer.on('end', resolve);
            transfer.on('error', reject);
        });
        log("[ADB] Server pushed.");

        const port = 27199;
        await client.forward(serial, `tcp:${port}`, 'localabstract:scrcpy');
        log(`[ADB] Forwarded tcp:${port}`);

        const cmd = `CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 3.3.4 video_codec=h264 max_size=1920 max_fps=60 tunnel_forward=true control=true audio=true audio_codec=raw audio_encoder=scrcpy send_device_meta=true send_frame_meta=true send_dummy_byte=true send_codec_meta=true`;

        const logProc = (proc) => {
            proc.stdout.on('data', (d) => log(`[Server] ${d}`));
            proc.stderr.on('data', (d) => console.error(`[Server ERR] ${d}`)); // Keep errors in console to avoid spam? No, send partial?
            proc.on('exit', (code) => log(`[Server] Exited with code ${code}`));
        }

        let proc;
        if (process.platform === 'win32') {
            proc = spawn(ADB_PATH, ['-s', serial, 'shell', cmd]);
        } else {
            proc = spawn(ADB_PATH, ['-s', serial, 'shell', cmd]);
        }
        logProc(proc);

        // SAFE MODE: 2s delay
        setTimeout(() => connectSockets(port), 2000);

    } catch (e) {
        log(`Scrcpy Start Error: ${e.message}`);
        isScrcpyStarted = false;
        throw e;
    }
}
