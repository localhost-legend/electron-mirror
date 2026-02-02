import { app } from 'electron';
import state from './state.js';
import { getScrcpyConfig } from './config.js';
import { checkForUpdates, downloadScrcpy, fetchLatestVersion } from './version-manager.js';
import { createLauncherWindow, createOverviewWindow, createMainWindow, snapWindowToRatio, updateWindowAspectRatio } from './windows.js';
import { initWebSocketServers, startScrcpy, stopScrcpy } from './scrcpy.js';
import { registerIpcHandlers } from './ipc/handlers.js';
import { startDeviceMonitor, clearTrackedDevice, setAdbPath, stopAdbServer } from './adb.js';

let scrcpyPaths = null;

function notifyLauncher(channel, payload) {
    if (state.launcherWindow && !state.launcherWindow.isDestroyed()) {
        state.launcherWindow.webContents.send(channel, payload);
    }
}

function notifyScrcpyStatus() {
    notifyLauncher('scrcpy-status-changed', {
        isScrcpyDownloading: state.isScrcpyDownloading,
        isAdbReady: state.isAdbReady
    });
}

const deviceMonitorOptions = {
    onDevicesChanged: () => {
        if (state.launcherWindow && !state.launcherWindow.isDestroyed()) {
            state.launcherWindow.webContents.send('devices-changed');
        }
    },
    onTrackedDeviceDisconnected: ({ serial, type }) => {
        console.warn(`[ADB] Tracked device disconnected: ${serial} (${type})`);
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
            state.mainWindow.close();
            clearTrackedDevice(serial);
        }
        if (state.overviewWindow && !state.overviewWindow.isDestroyed()) {
            state.overviewWindow.close();
            clearTrackedDevice(serial);
        }
        if (state.launcherWindow && !state.launcherWindow.isDestroyed()) {
            state.launcherWindow.webContents.send('connection-failed', '裝置已中斷連線');
            clearTrackedDevice(serial);
        }
    }
};

function startDeviceMonitorIfReady() {
    if (!state.isAdbReady || state.isScrcpyDownloading) return;
    startDeviceMonitor(deviceMonitorOptions);
}

async function initializeScrcpy() {
    console.log('[Main] Initializing scrcpy...');
    try {
        scrcpyPaths = getScrcpyConfig();
        if (!scrcpyPaths?.SCRCPY_VERSION || !scrcpyPaths?.SCRCPY_SERVER_PATH || !scrcpyPaths?.ADB_PATH) {
            console.error('[Main] scrcpy not found');
            state.isAdbReady = false;
            state.isScrcpyDownloading = true;
            notifyLauncher('scrcpy-download-start');
            notifyScrcpyStatus();
            fetchLatestVersion().then((latestVersion) => {
                console.log('[Main] Latest scrcpy version:', latestVersion);
                downloadScrcpy(latestVersion).then(() => {
                    console.log('[Main] scrcpy downloaded successfully');
                    state.isScrcpyDownloading = false;
                    notifyLauncher('scrcpy-download-complete');
                    notifyScrcpyStatus();
                    (async () => {
                        try {
                            await initializeScrcpy();
                            startDeviceMonitorIfReady();
                        } catch (e) {
                            console.error('[Main] Re-initialization failed:', e);
                        }
                    })();
                }).catch((err) => {
                    console.error('[Main] Failed to download scrcpy:', err);
                    state.isScrcpyDownloading = false;
                    state.isAdbReady = false;
                    notifyLauncher('scrcpy-download-failed', err?.message || String(err));
                    notifyScrcpyStatus();
                });
            });
        } else {
            setAdbPath(scrcpyPaths.ADB_PATH);
            state.isAdbReady = true;
            state.isScrcpyDownloading = false;
            notifyScrcpyStatus();
        }

        const versionInfo = await checkForUpdates(scrcpyPaths.SCRCPY_VERSION);
        await initWebSocketServers();

        return versionInfo;
    } catch (e) {
        scrcpyPaths = null;
        throw e;
    }
}

async function launchScreenMirror() {
    console.log('[Main] Launching Screen Mirror...');
    try {
        if (!scrcpyPaths) {
            throw new Error('Scrcpy not initialized');
        }
        
        await startScrcpy({ 
            adbPath: scrcpyPaths.ADB_PATH, 
            scrcpyServerPath: scrcpyPaths.SCRCPY_SERVER_PATH,
            scrcpyVersion: scrcpyPaths.SCRCPY_VERSION
        });
        createMainWindow({ onClosed: stopScrcpy });
    } catch (e) {
        console.error('[Main] Scrcpy Failed:', e);
        if (state.overviewWindow && !state.overviewWindow.isDestroyed()) {
            state.overviewWindow.webContents.send('scrcpy-failed', e.message);
        } else {
            createOverviewWindow();
            setTimeout(() => {
                if (state.overviewWindow) state.overviewWindow.webContents.send('scrcpy-failed', e.message);
            }, 1000);
        }
    }
}


app.whenReady().then(async () => {
    try {
        const versionInfo = await initializeScrcpy();
        
        // Notify launcher about version info
        if (versionInfo.updateAvailable) {
            console.log('[Main] Update available for scrcpy:', versionInfo.latestVersion);
        }
    } catch (e) {
        console.error('[Main] Initialization failed:', e.message);
    }
    
    createLauncherWindow();
    if (state.isScrcpyDownloading) {
        notifyLauncher('scrcpy-download-start');
    }

    notifyScrcpyStatus();

    startDeviceMonitorIfReady();
});

let isQuitting = false;

app.on('before-quit', async (event) => {
    if (isQuitting) return;
    event.preventDefault();
    isQuitting = true;
    await stopAdbServer();
    app.quit();
});

registerIpcHandlers({
    adbPath: () => scrcpyPaths?.ADB_PATH,
    launchScreenMirror,
    createOverviewWindow,
    snapWindowToRatio,
    updateWindowAspectRatio
});