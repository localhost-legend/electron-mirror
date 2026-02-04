import path from 'path';
import fs from 'fs';
import { getInstalledVersion, getScrcpyDir } from './version-manager.js';

function getScrcpyConfig() {
    const version = getInstalledVersion();
    
    if (!version) {
        // If no version is installed, we cannot provide a config.
        // The application should ensure ensureScrcpy() is called before accessing this.
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
        serverPath = path.join(scrcpyDir, 'scrcpy-server');
        adbPath = path.join(scrcpyDir, 'adb'); // Use bundled adb if available, or system adb
        
        // If bundled adb doesn't exist, fallback to system 'adb'
        if (!fs.existsSync(adbPath)) {
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
