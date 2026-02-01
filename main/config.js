import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { app } from 'electron';
import { getInstalledVersion } from './version-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getScrcpyConfig() {
    const platform = process.platform;
    const baseRoot = app?.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked')
        : path.join(__dirname, '..');

    if (platform === 'win32') {
        const installedVersion = getInstalledVersion();
        if (!installedVersion) {
            return {
                SCRCPY_VERSION: null,
                SCRCPY_SERVER_PATH: null,
                ADB_PATH: null
            };
        }
        const baseDir = path.join(baseRoot, `scrcpy-win64-v${installedVersion}`);
        const nestedDir = path.join(baseDir, `scrcpy-win64-v${installedVersion}`);
        const scrcpyDir = fs.existsSync(path.join(baseDir, 'adb.exe')) ? baseDir : nestedDir;
        return {
            SCRCPY_VERSION: installedVersion,
            SCRCPY_SERVER_PATH: path.join(scrcpyDir, 'scrcpy-server'),
            ADB_PATH: path.join(scrcpyDir, 'adb.exe')
        };
    }

    if (platform === 'darwin') { // WON'T WORK!!!!!!!!! NEED TO FIGURE OUT A WAY TO DOWNLOAD SCRCPY FOR MACOS
        return {
            SCRCPY_VERSION: '3.3.4',
            SCRCPY_SERVER_PATH: '/opt/homebrew/Cellar/scrcpy/3.3.4/share/scrcpy/scrcpy-server.jar',
            ADB_PATH: 'adb'
        };
    }

    throw new Error(`Unsupported platform: ${platform}`);
}

export {
    getScrcpyConfig
};
