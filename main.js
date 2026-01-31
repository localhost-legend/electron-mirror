const fs = require('fs');
require('dotenv').config();
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const adb = require('adbkit');
const client = adb.createClient({ host: '127.0.0.1', port: 5037 });
const { spawn, exec } = require('child_process');
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

let overviewWindow;

function createOverviewWindow() {
    overviewWindow = new BrowserWindow({
        width: 900,
        height: 650,
        center: true,
        title: "Tango Native - Overview",
        backgroundColor: '#0f0f1a',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    overviewWindow.loadFile('overview.html');
    overviewWindow.on('closed', () => {
        overviewWindow = null;
    });
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


    // Cleanup scrcpy when window closes
    mainWindow.on('closed', () => {
        stopScrcpy();
        mainWindow = null;
    });

    // Fullscreen Events for Sidebar Logic
    mainWindow.on('enter-full-screen', () => {
        mainWindow.webContents.send('fullscreen-change', true);
    });
    mainWindow.on('leave-full-screen', () => {
        mainWindow.webContents.send('fullscreen-change', false);
    });
}

function setupWindowListeners() {
    // Debounced Magnetic Snap (Restored for Windowed Mode)
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

    // Calculate chrome (titlebar) size
    const chromeHeight = wH - cH;
    const chromeWidth = wW - cW;

    // In Absolute Overlay mode, Video Width == Content Width
    // We ignore sidebar width for the ratio calculation to ensure perfect video fit
    const videoRatio = currentVideoRatio || (9 / 16);

    // Ideal dimensions based on current height
    // Width = Height * Ratio
    const targetContentWidth = Math.round(cH * videoRatio);
    const targetWindowWidth = targetContentWidth + chromeWidth;

    // Check if the current width is already close enough (avoid infinite loops)
    if (Math.abs(wW - targetWindowWidth) > 2) {
        mainWindow.setSize(targetWindowWidth, wH);
    }

    // Note: We snap width to match height. 
    // This provides a predictable resize behavior (user adjusts height, width follows).
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

// Helper to launch screen mirror
async function launchScreenMirror() {
    console.log('[Main] Launching Screen Mirror...');
    try {
        await startScrcpy();
        // Open Main Mirror (Overview stays open)
        createMainWindow();
    } catch (e) {
        console.error('[Main] Scrcpy Failed:', e);
        // If failed, fallback to overview or show error
        if (overviewWindow && !overviewWindow.isDestroyed()) {
            overviewWindow.webContents.send('scrcpy-failed', e.message);
        } else {
            // If overview was not open (e.g. direct launch), open it to show error
            createOverviewWindow();
            // Wait for load then send error
            setTimeout(() => {
                if (overviewWindow) overviewWindow.webContents.send('scrcpy-failed', e.message);
            }, 1000);
        }
    }
}

ipcMain.on('connect-device', async (event, serial) => {
    console.log(`[Launcher] Selected device: ${serial}`);
    SELECTED_SERIAL = serial;

    // Auto-launch Screen Mirror
    await launchScreenMirror();
});

// Start Screen Mirror from Overview
ipcMain.on('start-screen-mirror', async () => {
    // If Scrcpy is already running and window exists, just focus it
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        // Optional: Close overview if desired, but user might want both.
        // Let's keep overview open for now as it's a "manager"
        return;
    }

    await launchScreenMirror();
});

// Disconnect - Close everything
ipcMain.on('disconnect-device', () => {
    console.log('[Overview] Disconnecting...');
    SELECTED_SERIAL = null;
    isScrcpyStarted = false;
    if (overviewWindow) {
        overviewWindow.close();
        overviewWindow = null;
    }
    if (mainWindow) {
        mainWindow.close();
        mainWindow = null;
    }
    // Launcher stays open
});

// View Info / Open Overview (keep Main Window open)
ipcMain.on('return-to-overview', () => {
    console.log('[Main] Opening Overview...');

    if (overviewWindow && !overviewWindow.isDestroyed()) {
        overviewWindow.show();
        overviewWindow.focus();
    } else {
        createOverviewWindow();
    }
});

// Snap Ratio IPC
ipcMain.on('set-aspect-ratio', (event, width, height) => {
    if (mainWindow) {
        currentVideoRatio = width / height;
        // Snap immediately on first load (to auto-remove black bars)
        snapWindowToRatio();
    }
});

// Dynamic Sidebar IPC (Just for state update)
ipcMain.on('resize-window', (event, sidebarWidth) => {
    if (mainWindow) {
        console.log(`[Main] Sidebar Resize: ${sidebarWidth}`);
        currentSidebarWidth = sidebarWidth;
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

// --- Device Info for Overview Dashboard ---
ipcMain.handle('get-device-info', async (event, serial) => {
    const s = serial || SELECTED_SERIAL;
    if (!s) return null;

    try {
        const props = await client.getProperties(s);

        // Helper to run shell command and return output
        const shell = async (cmd) => {
            return new Promise((resolve) => {
                const { exec } = require('child_process');
                exec(`${ADB_PATH} -s ${s} shell ${cmd}`, (err, stdout) => {
                    resolve(stdout ? stdout.trim() : '');
                });
            });
        };

        // Battery info
        const batteryOutput = await shell('dumpsys battery');
        const batteryMatch = batteryOutput.match(/level: (\d+)/);
        const chargingMatch = batteryOutput.match(/status: (\d+)/);
        const battery = batteryMatch ? parseInt(batteryMatch[1]) : null;
        const isCharging = chargingMatch ? chargingMatch[1] === '2' || chargingMatch[1] === '5' : false;

        // Storage info (data partition)
        const dfOutput = await shell('df /data | tail -1');
        const dfParts = dfOutput.split(/\s+/);
        let storageUsed = null, storageTotal = null;
        if (dfParts.length >= 4) {
            storageTotal = parseInt(dfParts[1]) / 1024 / 1024; // GB
            storageUsed = parseInt(dfParts[2]) / 1024 / 1024; // GB
        }

        // Memory info
        const memOutput = await shell('cat /proc/meminfo');
        const memTotalMatch = memOutput.match(/MemTotal:\s+(\d+)/);
        const memAvailMatch = memOutput.match(/MemAvailable:\s+(\d+)/);
        let memTotal = null, memUsed = null;
        if (memTotalMatch && memAvailMatch) {
            memTotal = parseInt(memTotalMatch[1]) / 1024 / 1024; // GB
            const memAvail = parseInt(memAvailMatch[1]) / 1024 / 1024; // GB
            memUsed = memTotal - memAvail;
        }

        // Wi-Fi info
        const wifiOutput = await shell('dumpsys wifi | grep "mWifiInfo"');
        const ssidMatch = wifiOutput.match(/SSID: ([^,]+)/);
        const ssid = ssidMatch ? ssidMatch[1].replace(/"/g, '') : null;

        // IP address
        const ipOutput = await shell('ip addr show wlan0 | grep "inet "');
        const ipMatch = ipOutput.match(/inet (\d+\.\d+\.\d+\.\d+)/);
        const ipAddress = ipMatch ? ipMatch[1] : null;

        return {
            manufacturer: props['ro.product.manufacturer'] || 'Unknown',
            model: props['ro.product.model'] || 'Android Device',
            androidVersion: props['ro.build.version.release'] || 'Unknown',
            sdkVersion: props['ro.build.version.sdk'] || 'Unknown',
            battery,
            isCharging,
            storageUsed: storageUsed ? storageUsed.toFixed(2) : null,
            storageTotal: storageTotal ? storageTotal.toFixed(2) : null,
            memUsed: memUsed ? memUsed.toFixed(2) : null,
            memTotal: memTotal ? memTotal.toFixed(2) : null,
            ssid,
            ipAddress,
            serial: s
        };
    } catch (e) {
        console.error('get-device-info error:', e);
        return null;
    }
});

// File Browser: List directory
ipcMain.handle('list-files', async (event, path = '/sdcard') => {
    const s = SELECTED_SERIAL;
    console.log('[list-files] SELECTED_SERIAL:', s, 'path:', path);
    if (!s) {
        console.log('[list-files] No serial selected!');
        return [];
    }

    try {
        // Add trailing slash to handle symlinks like /sdcard
        const targetPath = path.endsWith('/') ? path : path + '/';
        const cmd = `${ADB_PATH} -s ${s} shell ls -la "${targetPath}"`;
        console.log('[list-files] Running:', cmd);

        const output = await new Promise((resolve, reject) => {
            exec(cmd, (err, stdout, stderr) => {
                if (err) {
                    console.log('[list-files] Error:', err.message);
                    reject(err);
                } else {
                    console.log('[list-files] Output length:', stdout.length);
                    resolve(stdout);
                }
            });
        });

        const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('total'));
        console.log('[list-files] Lines to parse:', lines.length);
        const files = [];

        for (const line of lines) {
            // More flexible parsing: split by whitespace
            const parts = line.trim().split(/\s+/);
            if (parts.length < 7) continue;

            const perms = parts[0];
            // Find the date field (YYYY-MM-DD format)
            let dateIdx = parts.findIndex(p => /^\d{4}-\d{2}-\d{2}$/.test(p));
            if (dateIdx === -1) continue;

            const size = parseInt(parts[dateIdx - 1]) || 0;
            const date = parts[dateIdx] + ' ' + parts[dateIdx + 1];
            const name = parts.slice(dateIdx + 2).join(' ').split(' -> ')[0]; // Handle symlinks

            if (!name || name === '.' || name === '..') continue;

            files.push({
                name,
                isDirectory: perms.startsWith('d'),
                isLink: perms.startsWith('l'),
                size,
                date,
                path: `${path}/${name}`.replace(/\/+/g, '/')
            });
        }
        return files;
    } catch (e) {
        console.error('list-files error:', e);
        return [];
    }
});

// File Browser: Pull file to local
ipcMain.handle('pull-file', async (event, remotePath) => {
    const s = SELECTED_SERIAL;
    if (!s) return null;

    const { dialog } = require('electron');
    const fileName = remotePath.split('/').pop();
    const result = await dialog.showSaveDialog({
        defaultPath: fileName,
        title: '儲存檔案'
    });

    if (result.canceled) return null;

    try {
        await new Promise((resolve, reject) => {
            exec(`${ADB_PATH} -s ${s} pull "${remotePath}" "${result.filePath}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return result.filePath;
    } catch (e) {
        console.error('pull-file error:', e);
        return null;
    }
});

// File Browser: Push file to device
ipcMain.handle('push-file', async (event, remotePath) => {
    const s = SELECTED_SERIAL;
    if (!s) return false;

    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
        title: '選擇檔案上傳',
        properties: ['openFile']
    });

    if (result.canceled) return false;

    try {
        await new Promise((resolve, reject) => {
            exec(`${ADB_PATH} -s ${s} push "${result.filePaths[0]}" "${remotePath}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return true;
    } catch (e) {
        console.error('push-file error:', e);
        return false;
    }
});

// File Browser: Delete file
ipcMain.handle('delete-file', async (event, remotePath) => {
    const s = SELECTED_SERIAL;
    if (!s) return false;

    try {
        await new Promise((resolve, reject) => {
            exec(`${ADB_PATH} -s ${s} shell rm -rf "${remotePath}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return true;
    } catch (e) {
        console.error('delete-file error:', e);
        return false;
    }
});

// App Manager: List installed apps (with filter)
ipcMain.handle('list-apps', async (event, filter = 'user') => {
    const s = SELECTED_SERIAL;
    if (!s) return [];

    try {
        // -3 = third party, -s = system, no flag = all
        const flag = filter === 'user' ? '-3' : filter === 'system' ? '-s' : '';
        const output = await new Promise((resolve, reject) => {
            exec(`${ADB_PATH} -s ${s} shell pm list packages ${flag}`, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });

        const packages = output.split('\n')
            .filter(l => l.startsWith('package:'))
            .map(l => l.replace('package:', '').trim())
            .filter(p => p);

        // Get app labels (simplified - use last part of package name)
        return packages.map(pkg => ({
            package: pkg,
            name: pkg.split('.').pop()
        }));
    } catch (e) {
        console.error('list-apps error:', e);
        return [];
    }
});

// App Manager: Uninstall app
ipcMain.handle('uninstall-app', async (event, packageName) => {
    const s = SELECTED_SERIAL;
    if (!s) return false;

    try {
        await new Promise((resolve, reject) => {
            exec(`${ADB_PATH} -s ${s} uninstall "${packageName}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return true;
    } catch (e) {
        console.error('uninstall-app error:', e);
        return false;
    }
});

// App Manager: Install APK
ipcMain.handle('install-apk', async () => {
    const s = SELECTED_SERIAL;
    if (!s) return false;

    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
        title: '選擇 APK 檔案',
        filters: [{ name: 'APK', extensions: ['apk'] }],
        properties: ['openFile']
    });

    if (result.canceled) return false;

    try {
        await new Promise((resolve, reject) => {
            exec(`${ADB_PATH} -s ${s} install -r "${result.filePaths[0]}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return true;
    } catch (e) {
        console.error('install-apk error:', e);
        return false;
    }
});

// App Manager: Launch app
ipcMain.handle('launch-app', async (event, packageName) => {
    const s = SELECTED_SERIAL;
    if (!s) return false;

    try {
        await new Promise((resolve, reject) => {
            exec(`${ADB_PATH} -s ${s} shell monkey -p "${packageName}" -c android.intent.category.LAUNCHER 1`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return true;
    } catch (e) {
        console.error('launch-app error:', e);
        return false;
    }
});

// App Manager: Export APK
ipcMain.handle('export-apk', async (event, packageName) => {
    const s = SELECTED_SERIAL;
    if (!s) return null;

    try {
        // Get APK path on device
        const pathOutput = await new Promise((resolve, reject) => {
            exec(`${ADB_PATH} -s ${s} shell pm path "${packageName}"`, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });

        const apkPath = pathOutput.split(':')[1]?.trim();
        if (!apkPath) return null;

        // Show save dialog
        const { dialog } = require('electron');
        const result = await dialog.showSaveDialog({
            defaultPath: packageName + '.apk',
            title: '導出 APK',
            filters: [{ name: 'APK', extensions: ['apk'] }]
        });

        if (result.canceled) return null;

        // Pull APK
        await new Promise((resolve, reject) => {
            exec(`${ADB_PATH} -s ${s} pull "${apkPath}" "${result.filePath}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        return result.filePath;
    } catch (e) {
        console.error('export-apk error:', e);
        return null;
    }
});

// ============== Notification Center ==============
let notificationCache = [];
let notificationWatcher = null;

// Get notifications from Android using dumpsys
ipcMain.handle('get-notifications', async () => {
    const s = SELECTED_SERIAL;
    if (!s) return [];

    try {
        const output = await new Promise((resolve, reject) => {
            exec(`${ADB_PATH} -s ${s} shell dumpsys notification --noredact`, { maxBuffer: 1024 * 1024 * 5 }, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });

        const notifications = [];
        const lines = output.split('\n');
        let current = null;
        let inNotificationRecord = false;

        for (const line of lines) {
            // Look for actual notification records (not just any pkg= reference)
            if (line.includes('NotificationRecord(') && line.includes('pkg=')) {
                inNotificationRecord = true;
                const pkgMatch = line.match(/pkg=([^\s\)]+)/);
                if (pkgMatch) {
                    // Save previous if it has a title
                    if (current && current.title) {
                        notifications.push(current);
                    }
                    current = {
                        package: pkgMatch[1],
                        app: pkgMatch[1].split('.').pop(),
                        title: null,
                        text: null
                    };
                }
            }

            if (current && inNotificationRecord) {
                // Parse title
                if (line.includes('android.title=String (')) {
                    const titleMatch = line.match(/android\.title=String \(([^)]+)\)/);
                    if (titleMatch) current.title = titleMatch[1].trim();
                } else if (line.includes('android.title=') && !line.includes('android.title=null')) {
                    const titleMatch = line.match(/android\.title=(.+)/);
                    if (titleMatch && titleMatch[1] !== 'null') {
                        current.title = titleMatch[1].trim();
                    }
                }

                // Parse text
                if (line.includes('android.text=String (')) {
                    const textMatch = line.match(/android\.text=String \(([^)]+)\)/);
                    if (textMatch) current.text = textMatch[1].trim();
                } else if (line.includes('android.text=') && !line.includes('android.text=null')) {
                    const textMatch = line.match(/android\.text=(.+)/);
                    if (textMatch && textMatch[1] !== 'null') {
                        current.text = textMatch[1].trim();
                    }
                }
            }
        }

        // Add last one if it has a title
        if (current && current.title) {
            notifications.push(current);
        }

        // Filter out duplicates and system notifications without meaningful content
        const seen = new Set();
        const filtered = notifications.filter(n => {
            if (!n.title || n.title === '通知' || n.title === 'null') return false;
            const key = n.package + ':' + n.title;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        notificationCache = filtered.slice(0, 20); // Limit to 20
        return notificationCache;
    } catch (e) {
        console.error('get-notifications error:', e);
        return [];
    }
});

// Clear all notifications
ipcMain.handle('clear-notifications', async () => {
    const s = SELECTED_SERIAL;
    if (!s) return false;

    try {
        await new Promise((resolve, reject) => {
            exec(`${ADB_PATH} -s ${s} shell service call notification 1`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        notificationCache = [];
        return true;
    } catch (e) {
        console.error('clear-notifications error:', e);
        return false;
    }
});

// Start watching for new notifications (polling-based for simplicity)
function startNotificationWatcher(serial) {
    if (notificationWatcher) clearInterval(notificationWatcher);

    let lastCount = 0;
    notificationWatcher = setInterval(async () => {
        if (!SELECTED_SERIAL) return;

        try {
            const output = await new Promise((resolve, reject) => {
                exec(`${ADB_PATH} -s ${serial} shell dumpsys notification --noredact | grep -c "pkg="`, (err, stdout) => {
                    resolve(stdout?.trim() || '0');
                });
            });

            const count = parseInt(output) || 0;
            if (count > lastCount) {
                // New notification detected - get full list and send to system
                const notifs = await ipcMain.handle('get-notifications');
                if (notifs && notifs.length > 0) {
                    const newest = notifs[0];

                    // Send to system notification (macOS/Windows)
                    const { Notification } = require('electron');
                    if (Notification.isSupported()) {
                        const n = new Notification({
                            title: newest.title || newest.app,
                            body: newest.text || '',
                            silent: false
                        });
                        n.on('click', () => {
                            // Launch the app when notification is clicked
                            if (newest.package) {
                                exec(`${ADB_PATH} -s ${serial} shell monkey -p "${newest.package}" -c android.intent.category.LAUNCHER 1`);
                            }
                        });
                        n.show();
                    }

                    // Send to overview window
                    if (overviewWindow && !overviewWindow.isDestroyed()) {
                        overviewWindow.webContents.send('new-notification', newest);
                    }
                }
            }
            lastCount = count;
        } catch (e) {
            // Ignore errors in watcher
        }
    }, 3000); // Check every 3 seconds
}

function stopNotificationWatcher() {
    if (notificationWatcher) {
        clearInterval(notificationWatcher);
        notificationWatcher = null;
    }
}


// WebSocket Server (Video/Control)
const wss = new WebSocket.Server({ port: 8080 });
const wssAudio = new WebSocket.Server({ port: 8081 });

console.log("WS (Video/Control) on 8080");
console.log("WS (Audio) on 8081");

let videoSocket = null, audioSocket = null, controlSocket = null;
let isScrcpyStarted = false;
let scrcpyProc = null; // Track scrcpy process for cleanup

// Stream History Buffer
let streamHistory = [];

// Cleanup function for reconnection
function stopScrcpy() {
    console.log('[Main] Stopping scrcpy and cleaning up...');

    // Kill scrcpy process
    if (scrcpyProc && !scrcpyProc.killed) {
        scrcpyProc.kill();
        scrcpyProc = null;
    }

    // Close sockets
    if (videoSocket) { try { videoSocket.destroy(); } catch (e) { } videoSocket = null; }
    if (audioSocket) { try { audioSocket.destroy(); } catch (e) { } audioSocket = null; }
    if (controlSocket) { try { controlSocket.destroy(); } catch (e) { } controlSocket = null; }

    // Clear buffer
    streamHistory = [];

    // Reset state
    isScrcpyStarted = false;

    console.log('[Main] Cleanup complete');
}

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
        scrcpyProc = proc; // Save for cleanup
        logProc(proc);

        // SAFE MODE: 2s delay
        setTimeout(() => connectSockets(port), 2000);

    } catch (e) {
        log(`Scrcpy Start Error: ${e.message}`);
        isScrcpyStarted = false;
        throw e;
    }
}
