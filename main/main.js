import { app } from 'electron';
import state from './state.js';
import { getScrcpyConfig } from './config.js';
import { checkForUpdates, downloadScrcpy } from './version-manager.js';
import { createLauncherWindow, createOverviewWindow, createDeviceSettingsWindow, createMainWindow, snapWindowToRatio, updateWindowAspectRatio } from './windows.js';
import { startScrcpy, stopScrcpy } from './services/scrcpy-service.js';
import { registerIpcHandlers } from './ipc/handlers.js';
import { startDeviceMonitor, clearTrackedDevice, setAdbPath, stopAdbServer, initAdb, client } from './adb.js';

process.on('uncaughtException', (error) => {
    if(error.code === 'ECONNRESET' || error.message.includes('ECONNRESET')) {
        console.warn('[Main] Caught unhandled exception:', error.message); // just ignore, idk why the fuck it happen on windows adb
    }
    console.error('[Main] Uncaught Exception:', error); // for something serious really happen
});

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

const TRACKED_DISCONNECT_GRACE_MS = 8000;
let trackedDisconnectTimer = null;
let trackedDisconnectSerial = null;

function clearTrackedDisconnectTimer() {
    if (trackedDisconnectTimer) {
        clearTimeout(trackedDisconnectTimer);
        trackedDisconnectTimer = null;
    }
    trackedDisconnectSerial = null;
}

async function isTrackedDeviceOnline(serial) {
    if (!serial) return false;
    try {
        const devices = await client.listDevices();
        return devices.some((d) => d.id === serial && d.type === 'device');
    } catch (e) {
        console.warn('[ADB] Failed to check device status:', e);
        return false;
    }
}

function handleTrackedDisconnectNow(serial, type) {
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

function scheduleTrackedDisconnectCheck(serial, type) {
    if (!serial) return;
    if (trackedDisconnectSerial && trackedDisconnectSerial !== serial) {
        clearTrackedDisconnectTimer();
    }
    trackedDisconnectSerial = serial;
    if (trackedDisconnectTimer) return;

    trackedDisconnectTimer = setTimeout(async () => {
        trackedDisconnectTimer = null;
        const stillOnline = await isTrackedDeviceOnline(serial);
        if (stillOnline) {
            console.warn(`[ADB] Tracked device recovered: ${serial}`);
            clearTrackedDisconnectTimer();
            return;
        }
        handleTrackedDisconnectNow(serial, type);
        clearTrackedDisconnectTimer();
    }, TRACKED_DISCONNECT_GRACE_MS);
}

const deviceMonitorOptions = {
    onDevicesChanged: () => {
        if (state.launcherWindow && !state.launcherWindow.isDestroyed()) {
            state.launcherWindow.webContents.send('devices-changed');
        }
    },
    onTrackedDeviceChange: ({ serial, type, isConnected }) => {
        if (trackedDisconnectSerial && serial === trackedDisconnectSerial && isConnected) {
            console.warn(`[ADB] Tracked device reconnected: ${serial} (${type})`);
            clearTrackedDisconnectTimer();
        }
    },
    onTrackedDeviceDisconnected: ({ serial, type, eventType }) => {
        console.warn(`[ADB] Tracked device disconnected: ${serial} (${type})`);
        if (eventType === 'remove') {
            handleTrackedDisconnectNow(serial, type);
            return;
        }
        if (type === 'offline' || type === 'unauthorized') {
            scheduleTrackedDisconnectCheck(serial, type);
            return;
        }
        handleTrackedDisconnectNow(serial, type);
    }
};

function startDeviceMonitorIfReady() {
    if (!state.isAdbReady || state.isScrcpyDownloading) return;
    startDeviceMonitor(deviceMonitorOptions);
}

async function initializeScrcpy() {
    console.log('[Main] Initializing scrcpy...');
    try {
        // Check for updates or missing installation.
        // This does NOT auto-download, just checks status.
        const { latestVersion, installedVersion, updateAvailable } = await checkForUpdates();

        // If we have no version at all, we MUST download
        // If we have an update, we SHOULD download (but logic allows skipping if needed, keeping it simple here)
        if (!installedVersion || updateAvailable) {
            const versionToDownload = latestVersion || 'latest';
            console.log(`[Main] Scrcpy status: installed=${installedVersion}, latest=${latestVersion}. Starting download...`);

            // Explicitly set state and notify
            notifyLauncher('scrcpy-download-start');

            try {
                const downloadPromise = downloadScrcpy(versionToDownload);
                notifyScrcpyStatus();
                await downloadPromise;

                state.isScrcpyDownloading = false;
                notifyLauncher('scrcpy-download-complete');
                notifyScrcpyStatus();
            } catch (err) {
                console.error('[Main] Failed to download scrcpy:', err);
                state.isScrcpyDownloading = false;
                state.isAdbReady = false;
                notifyLauncher('scrcpy-download-failed', err?.message || String(err));
                notifyScrcpyStatus();
                // If we have an installed version (even if update failed), we might fallback?
                // For now, if download fails and we have no version, we are dead.
                if (!installedVersion) throw err;
            }
        }

        // Get config - config.js now handles the "Homebrew fallback" logic implicitly
        // by checking paths if version exists.
        scrcpyPaths = getScrcpyConfig();

        if (!scrcpyPaths || !scrcpyPaths.ADB_PATH) {
            // One last check: maybe config failed because homebrew path wasn't detected by version manager?
            // But version-manager.js fix handles that.
            throw new Error('Failed to obtain valid scrcpy configuration.');
        }

        console.log(`[Main] Scrcpy initialized. Version: ${scrcpyPaths.SCRCPY_VERSION}`);

        setAdbPath(scrcpyPaths.ADB_PATH);
        await initAdb(); // wait for adb to be ready before starting device monitor
        state.isAdbReady = true;
        notifyScrcpyStatus();

        // Start device monitor - SAFE now because download/init is done
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

    // Initialize scrcpy (check/download/update logic handled inside)
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
    createDeviceSettingsWindow,
    snapWindowToRatio,
    updateWindowAspectRatio
});
