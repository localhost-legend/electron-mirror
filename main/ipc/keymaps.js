import { ipcMain } from 'electron';
import { getKeymaps, saveKeymap, saveKeymapDialog, loadKeymap } from '../services/keymaps-service.js';

function registerKeymapHandlers() {
    ipcMain.handle('get-keymaps', async () => {
        return getKeymaps();
    });

    ipcMain.handle('save-keymap', async (event, name, data) => {
        return saveKeymap(name, data);
    });

    ipcMain.handle('save-keymap-dialog', async (event, data) => {
        return saveKeymapDialog(data);
    });

    ipcMain.handle('load-keymap', async (event, name) => {
        return loadKeymap(name);
    });
}

export { registerKeymapHandlers };
