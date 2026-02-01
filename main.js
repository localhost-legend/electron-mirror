import { app } from 'electron';
import state from './main/state.js';
import { getScrcpyConfig } from './main/config.js';
import { checkForUpdates, downloadScrcpy, fetchLatestVersion } from './main/version-manager.js';
import { createLauncherWindow, createOverviewWindow, createMainWindow, snapWindowToRatio, updateWindowAspectRatio } from './main/windows.js';
import { initWebSocketServers, startScrcpy, stopScrcpy } from './main/scrcpy.js';
import { registerIpcHandlers } from './main/ipc/handlers.js';
import { startDeviceMonitor, clearTrackedDevice, setAdbPath, stopAdbServer } from './main/adb.js';

let scrcpyPaths = null;

async function initializeScrcpy() {
    console.log('[Main] Initializing scrcpy...');
    try {
        scrcpyPaths = getScrcpyConfig();
        if (!scrcpyPaths?.SCRCPY_VERSION || !scrcpyPaths?.SCRCPY_SERVER_PATH || !scrcpyPaths?.ADB_PATH) {
            console.error('[Main] scrcpy not found');
            fetchLatestVersion().then((latestVersion) => {
                console.log('[Main] Latest scrcpy version:', latestVersion);
                downloadScrcpy(latestVersion).then(() => {
                    console.log('[Main] scrcpy downloaded successfully');
                    (async () => {
                        try {
                            await initializeScrcpy();
                        } catch (e) {
                            console.error('[Main] Re-initialization failed:', e);
                        }
                    })();
                }).catch((err) => {
                    console.error('[Main] Failed to download scrcpy:', err);
                });
            });
        } else {
            setAdbPath(scrcpyPaths.ADB_PATH);
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

    startDeviceMonitor({
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
    });
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