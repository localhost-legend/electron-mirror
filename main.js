const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const adb = require('adbkit');
const client = adb.createClient({ host: '127.0.0.1', port: 5037 });
const { spawn } = require('child_process');
const net = require('net');
const WebSocket = require('ws');

let mainWindow;
const SCRCPY_SERVER_PATH = '/opt/homebrew/Cellar/scrcpy/3.3.4/share/scrcpy/scrcpy-server';
const DEVICE_SERIAL = 'emulator-5556';

// State for Magnetic Snap
let currentVideoRatio = 16 / 9;
let currentSidebarWidth = 48; // Dynamic State
let resizeTimeout = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        backgroundColor: '#000',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');
    setupWindowListeners();
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

    // We calculate the TARGET VIDEO WIDTH (Content - Sidebar)
    const videoWidth = cW - SIDEBAR_WIDTH;
    if (videoWidth <= 0) return;

    // Calculate required Height for this Video Width
    const targetVideoHeight = Math.round(videoWidth / currentVideoRatio);

    const targetWindowHeight = targetVideoHeight + chromeHeight;
    const targetWindowWidth = cW + chromeWidth;

    if (Math.abs(wH - targetWindowHeight) > 2) {
        mainWindow.setSize(targetWindowWidth, targetWindowHeight);
    }
}

app.whenReady().then(() => {
    createWindow();
});

// Snap Ratio IPC
ipcMain.on('set-aspect-ratio', (event, width, height) => {
    if (mainWindow) {
        currentVideoRatio = width / height;
        snapWindowToRatio();
    }
});

// Dynamic Sidebar IPC
ipcMain.on('resize-window', (event, sidebarWidth) => {
    if (mainWindow) {
        console.log(`[Main] Sidebar Resize: ${sidebarWidth}`);
        currentSidebarWidth = sidebarWidth;
        snapWindowToRatio();
    }
});

// WebSocket Server (Video/Control)
const wss = new WebSocket.Server({ port: 8080 });
const wssAudio = new WebSocket.Server({ port: 8081 });

console.log("WS (Video/Control) on 8080");
console.log("WS (Audio) on 8081");

let videoSocket = null;
let audioSocket = null;
let controlSocket = null;
let isScrcpyStarted = false;

wss.on('connection', (ws) => {
    console.log("[WSS-Video] Client connected!");
    ws.on('message', (message) => {
        if (controlSocket && !controlSocket.destroyed) {
            try { controlSocket.write(message); } catch (e) { }
        }
    });

    if (!isScrcpyStarted) {
        isScrcpyStarted = true;
        startScrcpy();
    }
});

wssAudio.on('connection', (ws) => {
    console.log("[WSS-Audio] Client connected!");
});

async function startScrcpy() {
    try {
        console.log(`[ADB] Connecting to ${DEVICE_SERIAL}...`);

        await client.push(DEVICE_SERIAL, SCRCPY_SERVER_PATH, '/data/local/tmp/scrcpy-server.jar');
        console.log("[ADB] Server pushed.");

        const port = 27199;
        await client.forward(DEVICE_SERIAL, `tcp:${port}`, 'localabstract:scrcpy');
        console.log(`[ADB] Forward set: tcp:${port} -> localabstract:scrcpy`);

        // HiDPI: max_size=1920
        const cmd = `CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 3.3.4 video_codec=h264 max_size=1920 max_fps=60 tunnel_forward=true control=true audio=true audio_codec=raw audio_encoder=scrcpy send_device_meta=true send_frame_meta=true send_dummy_byte=true send_codec_meta=true`;

        const proc = spawn('adb', ['-s', DEVICE_SERIAL, 'shell', cmd]);

        proc.stdout.on('data', (data) => console.log(`[Server] ${data}`));
        proc.stderr.on('data', (data) => console.error(`[Server ERR] ${data}`));
        proc.on('exit', (code) => console.log(`[Server] Exited with code ${code}`));

        setTimeout(() => {
            console.log("[Node] Connecting to Video Socket...");
            videoSocket = net.connect(port, '127.0.0.1', () => {
                console.log("[Node] Video Socket Connected!");
                videoSocket.on('error', (e) => console.error("[Node] Video Socket Error:", e));
                videoSocket.on('data', (chunk) => {
                    wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(chunk); });
                });

                setTimeout(() => {
                    console.log("[Node] Connecting to Audio Socket...");
                    audioSocket = net.connect(port, '127.0.0.1', () => {
                        console.log("[Node] Audio Socket Connected!");
                        audioSocket.on('error', (e) => console.error("[Node] Audio Socket Error:", e));
                        audioSocket.on('data', (chunk) => {
                            wssAudio.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(chunk); });
                        });

                        setTimeout(() => {
                            console.log("[Node] Connecting to Control Socket...");
                            controlSocket = net.connect(port, '127.0.0.1', () => {
                                console.log("[Node] Control Socket Connected!");
                                controlSocket.on('data', () => { });
                                controlSocket.on('error', (e) => console.error("[Node] Control Socket Error:", e));
                            });
                        }, 200);
                    });
                }, 200);
            });
        }, 2000);

    } catch (e) {
        console.error("Error:", e);
    }
}
