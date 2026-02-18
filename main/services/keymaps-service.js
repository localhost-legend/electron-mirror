import fs from 'fs';
import nodePath from 'path';
import { dialog } from 'electron';
import state from '../state.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const KEYMAPS_DIR = nodePath.join(__dirname, '..', '..', 'keymaps');
if (!fs.existsSync(KEYMAPS_DIR)) fs.mkdirSync(KEYMAPS_DIR);

function getKeymaps() {
    try {
        return fs.readdirSync(KEYMAPS_DIR).filter(f => f.endsWith('.json'));
    } catch (e) {
        console.error(e);
        return [];
    }
}

function saveKeymap(name, data) {
    try {
        const safeName = name.replace(/[^a-z0-9_\-\.]/gi, '_');
        const filePath = nodePath.join(KEYMAPS_DIR, safeName.endsWith('.json') ? safeName : safeName + '.json');
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return { success: true, filename: nodePath.basename(filePath) };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function saveKeymapDialog(data) {
    const result = await dialog.showSaveDialog(state.mainWindow, {
        title: 'Save Keymap Profile',
        defaultPath: nodePath.join(KEYMAPS_DIR, 'new_profile.json'),
        filters: [{ name: 'Keymap JSON', extensions: ['json'] }]
    });

    if (result.canceled || !result.filePath) return { success: false };

    try {
        fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2));
        return { success: true, filename: nodePath.basename(result.filePath) };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function loadKeymap(name) {
    try {
        const filePath = nodePath.join(KEYMAPS_DIR, name);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        return {};
    } catch (e) {
        return {};
    }
}

export { getKeymaps, saveKeymap, saveKeymapDialog, loadKeymap };
