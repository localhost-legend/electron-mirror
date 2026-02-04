import { app } from 'electron';
import state from './state.js';
import { getScrcpyConfig } from './config.js';
import { ensureScrcpy } from './version-manager.js';
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
        // Notify UI that we are checking/downloading scrcpy
        // Note: We do NOT set state.isScrcpyDownloading = true here manually.
        // The version-manager will handle that flag internally if a download actually occurs.
        notifyLauncher('scrcpy-download-start'); 

        // Ensure scrcpy is installed and up-to-date
        // This handles checking, downloading, and updating logic
        await ensureScrcpy();

        // Now that we are sure scrcpy exists, get the config
        scrcpyPaths = getScrcpyConfig();
        
        if (!scrcpyPaths || !scrcpyPaths.ADB_PATH) {
            throw new Error('Failed to obtain valid scrcpy configuration.');
        }

        console.log(`[Main] Scrcpy initialized. Version: ${scrcpyPaths.SCRCPY_VERSION}`);

        setAdbPath(scrcpyPaths.ADB_PATH);
        state.isAdbReady = true;
        // Ensure flag is reset (though ensureScrcpy should have done it)
        state.isScrcpyDownloading = false;
        
        notifyLauncher('scrcpy-download-complete');
        notifyScrcpyStatus();

        await initWebSocketServers();
        
        // Start device monitor now that ADB is ready
        startDeviceMonitorIfReady();

    } catch (e) {
        console.error('[Main] Scrcpy initialization failed:', e);
        state.isScrcpyDownloading = false;
        state.isAdbReady = false;
        notifyLauncher('scrcpy-download-failed', e.message || String(e));
        notifyScrcpyStatus();
        scrcpyPaths = null;
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
    createLauncherWindow();
    
    // Initialize scrcpy (check/download/update)
    await initializeScrcpy();
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
