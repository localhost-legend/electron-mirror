import path from 'path';
import fs from 'fs';
import { getInstalledVersion, getScrcpyDir } from './version-manager.js';

function getScrcpyConfig() {
    const version = getInstalledVersion();

    if (!version) {
        // If no version is installed, we cannot provide a config.
        // The main process should verify installation before accessing this.
        return {
            SCRCPY_VERSION: null,
            SCRCPY_SERVER_PATH: null,
            ADB_PATH: null
        };
    }

    const scrcpyDir = getScrcpyDir(version);
    const platform = process.platform;

    // Construct paths based on platform
    let serverPath;
    let adbPath;

    if (platform === 'win32') {
        serverPath = path.join(scrcpyDir, 'scrcpy-server');
        adbPath = path.join(scrcpyDir, 'adb.exe');
    } else if (platform === 'darwin') {
        const standardServerPath = path.join(scrcpyDir, 'scrcpy-server');
        const homebrewServerPath = path.join(scrcpyDir, 'share/scrcpy/scrcpy-server');
        const homebrewServerJarPath = path.join(scrcpyDir, 'share/scrcpy/scrcpy-server.jar');

        if (fs.existsSync(standardServerPath)) {
            serverPath = standardServerPath;
        } else if (fs.existsSync(homebrewServerPath)) {
            serverPath = homebrewServerPath;
        } else if (fs.existsSync(homebrewServerJarPath)) {
            serverPath = homebrewServerJarPath;
        } else {
            // Fallback to standard if neither found (will likely fail but consistent)
            serverPath = standardServerPath;
        }

        const bundledAdb = path.join(scrcpyDir, 'adb');
        // If bundled adb exists using it, otherwise fallback to system 'adb'
        if (fs.existsSync(bundledAdb)) {
            adbPath = bundledAdb;
        } else {
            adbPath = 'adb';
        }
    } else {
        throw new Error(`Unsupported platform: ${platform}`);
    }

    return {
        SCRCPY_VERSION: version,
        SCRCPY_SERVER_PATH: serverPath,
        ADB_PATH: adbPath
    };
}

export {
    getScrcpyConfig
};
