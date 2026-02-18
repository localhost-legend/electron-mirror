import { ipcMain } from 'electron';
import state from '../state.js';
import { registerDeviceHandlers } from './devices.js';
import { registerScrcpyHandlers } from './scrcpy.js';
import { registerKeymapHandlers } from './keymaps.js';
import { registerFileHandlers } from './files.js';
import { registerAppHandlers } from './apps.js';
import { registerNotificationHandlers } from './notifications.js';

function registerIpcHandlers({
    adbPath,
    launchScreenMirror,
    createOverviewWindow,
    createDeviceSettingsWindow,
    snapWindowToRatio,
    updateWindowAspectRatio
}) {
    const getAdbPath = () => {
        const resolved = typeof adbPath === 'function' ? adbPath() : adbPath;
        return resolved || 'adb';
    };

    ipcMain.handle('get-scrcpy-status', () => ({
        isScrcpyDownloading: state.isScrcpyDownloading,
        isAdbReady: state.isAdbReady
    }));

    registerDeviceHandlers({
        getAdbPath,
        launchScreenMirror,
        createOverviewWindow,
        createDeviceSettingsWindow
    });

    registerScrcpyHandlers({
        launchScreenMirror,
        createOverviewWindow,
        snapWindowToRatio,
        updateWindowAspectRatio
    });

    registerKeymapHandlers();
    registerFileHandlers({ getAdbPath });
    registerAppHandlers({ getAdbPath });

    const notificationHandlers = registerNotificationHandlers({ getAdbPath });

    return {
        startNotificationWatcher: notificationHandlers.startNotificationWatcher,
        stopNotificationWatcher: notificationHandlers.stopNotificationWatcher
    };
}

export { registerIpcHandlers };
