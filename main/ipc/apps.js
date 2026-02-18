import { ipcMain } from 'electron';
import { listApps, uninstallApp, installApk, launchApp, exportApk } from '../services/apps-service.js';

function registerAppHandlers({ getAdbPath }) {
    ipcMain.handle('list-apps', async (event, filter = 'user') => {
        return listApps(getAdbPath, filter);
    });

    ipcMain.handle('uninstall-app', async (event, packageName) => {
        return uninstallApp(getAdbPath, packageName);
    });

    ipcMain.handle('install-apk', async () => {
        return installApk(getAdbPath);
    });

    ipcMain.handle('launch-app', async (event, packageName) => {
        return launchApp(getAdbPath, packageName);
    });

    ipcMain.handle('export-apk', async (event, packageName) => {
        return exportApk(getAdbPath, packageName);
    });
}

export { registerAppHandlers };
