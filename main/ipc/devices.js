import { ipcMain } from 'electron';
import state from '../state.js';
import {
    listDevices,
    connectDevice,
    disconnectDevice,
    getDeviceAlias,
    setDeviceAlias,
    getDeviceSettings,
    setDeviceSettings,
    getDeviceSummary,
    getDeviceDisplaySize,
    getCurrentSerial,
    getDeviceInfo
} from '../services/device-service.js';

function registerDeviceHandlers({ getAdbPath, launchScreenMirror, createDeviceSettingsWindow }) {
    ipcMain.handle('get-devices', async () => {
        try {
            return await listDevices();
        } catch (e) {
            console.error('ADB Error:', e);
            throw e;
        }
    });

    ipcMain.on('connect-device', async (event, payload) => {
        await connectDevice(payload, { launchScreenMirror });
    });

    ipcMain.on('disconnect-device', () => {
        disconnectDevice();
    });

    ipcMain.handle('get-device-alias', async (event, serial) => {
        return getDeviceAlias(serial);
    });

    ipcMain.handle('set-device-alias', async (event, serial, alias) => {
        return setDeviceAlias(serial, alias);
    });

    ipcMain.handle('get-current-serial', () => getCurrentSerial());

    ipcMain.handle('get-device-info', async (event, serial) => {
        return getDeviceInfo(getAdbPath, serial);
    });

    ipcMain.handle('get-device-settings', async (event, serial) => {
        const summary = await getDeviceSummary(serial);
        const settings = getDeviceSettings(serial);
        const display = await getDeviceDisplaySize(getAdbPath, serial);
        if (!summary) return null;
        return {
            ...summary,
            settings,
            display
        };
    });

    ipcMain.handle('set-device-settings', async (event, serial, settings) => {
        return setDeviceSettings(serial, settings);
    });

    ipcMain.on('open-device-settings', (event, payload = {}) => {
        const serial = payload.serial || payload.id || payload.deviceId || payload.device || undefined;
        const targetSerial = serial || getCurrentSerial();
        if (!targetSerial) return;
        createDeviceSettingsWindow({ serial: targetSerial, focus: payload.focus });
    });

    ipcMain.on('refresh-device-list', () => {
        if (state.launcherWindow && !state.launcherWindow.isDestroyed()) {
            state.launcherWindow.webContents.send('devices-changed');
        }
    });
}

export { registerDeviceHandlers };
