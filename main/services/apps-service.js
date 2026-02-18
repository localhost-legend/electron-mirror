import { dialog } from 'electron';
import { exec } from 'child_process';
import state from '../state.js';

async function listApps(getAdbPath, filter = 'user') {
    const s = state.selectedSerial;
    if (!s) return [];

    try {
        const flag = filter === 'user' ? '-3' : filter === 'system' ? '-s' : '';
        const output = await new Promise((resolve, reject) => {
            exec(`${getAdbPath()} -s ${s} shell pm list packages ${flag}`, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });

        const packages = output.split('\n')
            .filter(l => l.startsWith('package:'))
            .map(l => l.replace('package:', '').trim())
            .filter(p => p);

        return packages.map(pkg => ({
            package: pkg,
            name: pkg.split('.').pop()
        }));
    } catch (e) {
        console.error('list-apps error:', e);
        return [];
    }
}

async function uninstallApp(getAdbPath, packageName) {
    const s = state.selectedSerial;
    if (!s) return false;

    try {
        await new Promise((resolve, reject) => {
            exec(`${getAdbPath()} -s ${s} uninstall "${packageName}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return true;
    } catch (e) {
        console.error('uninstall-app error:', e);
        return false;
    }
}

async function installApk(getAdbPath) {
    const s = state.selectedSerial;
    if (!s) return false;

    const result = await dialog.showOpenDialog({
        title: '選擇 APK 檔案',
        filters: [{ name: 'APK', extensions: ['apk'] }],
        properties: ['openFile']
    });

    if (result.canceled) return false;

    try {
        await new Promise((resolve, reject) => {
            exec(`${getAdbPath()} -s ${s} install -r "${result.filePaths[0]}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return true;
    } catch (e) {
        console.error('install-apk error:', e);
        return false;
    }
}

async function launchApp(getAdbPath, packageName) {
    const s = state.selectedSerial;
    if (!s) return false;

    try {
        await new Promise((resolve, reject) => {
            exec(`${getAdbPath()} -s ${s} shell monkey -p "${packageName}" -c android.intent.category.LAUNCHER 1`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return true;
    } catch (e) {
        console.error('launch-app error:', e);
        return false;
    }
}

async function exportApk(getAdbPath, packageName) {
    const s = state.selectedSerial;
    if (!s) return null;

    try {
        const pathOutput = await new Promise((resolve, reject) => {
            exec(`${getAdbPath()} -s ${s} shell pm path "${packageName}"`, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });

        const apkPath = pathOutput.split(':')[1]?.trim();
        if (!apkPath) return null;

        const result = await dialog.showSaveDialog({
            defaultPath: packageName + '.apk',
            title: '導出 APK',
            filters: [{ name: 'APK', extensions: ['apk'] }]
        });

        if (result.canceled) return null;

        await new Promise((resolve, reject) => {
            exec(`${getAdbPath()} -s ${s} pull "${apkPath}" "${result.filePath}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        return result.filePath;
    } catch (e) {
        console.error('export-apk error:', e);
        return null;
    }
}

export { listApps, uninstallApp, installApk, launchApp, exportApk };
