import { ipcMain } from 'electron';
import {
    getNotifications,
    startNotificationWatcher,
    stopNotificationWatcher,
    clearNotifications
} from '../services/notifications-service.js';

function registerNotificationHandlers({ getAdbPath }) {
    ipcMain.handle('get-notifications', async () => {
        return getNotifications(getAdbPath());
    });

    ipcMain.handle('clear-notifications', async () => {
        return clearNotifications(getAdbPath());
    });

    return {
        startNotificationWatcher: (serial) => startNotificationWatcher(getAdbPath(), serial),
        stopNotificationWatcher
    };
}

export { registerNotificationHandlers };
