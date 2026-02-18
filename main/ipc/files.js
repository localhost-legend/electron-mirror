import { ipcMain } from 'electron';
import { listFiles, pullFile, pushFile, deleteFile } from '../services/files-service.js';

function registerFileHandlers({ getAdbPath }) {
    ipcMain.handle('list-files', async (event, path = '/sdcard') => {
        return listFiles(getAdbPath, path);
    });

    ipcMain.handle('pull-file', async (event, remotePath) => {
        return pullFile(getAdbPath, remotePath);
    });

    ipcMain.handle('push-file', async (event, remotePath) => {
        return pushFile(getAdbPath, remotePath);
    });

    ipcMain.handle('delete-file', async (event, remotePath) => {
        return deleteFile(getAdbPath, remotePath);
    });
}

export { registerFileHandlers };
