import fs from 'fs';
import nodePath from 'path';
import { ipcMain, dialog, Notification } from 'electron';
import { exec } from 'child_process';
import state from '../state.js';
import { client, setTrackedDevice, clearTrackedDevice } from '../adb.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const KEYMAPS_DIR = nodePath.join(__dirname, '..', '..', 'keymaps');
if (!fs.existsSync(KEYMAPS_DIR)) fs.mkdirSync(KEYMAPS_DIR);

const DEVICES_FILE = nodePath.join(__dirname, '..', '..', 'devices.json');
let deviceConfig = {};
if (fs.existsSync(DEVICES_FILE)) {
    try { deviceConfig = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); } catch (e) { }
}

function saveDeviceConfig() {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(deviceConfig, null, 2));
}

async function getNotifications(adbPath) {
    const s = state.selectedSerial;
    if (!s) return [];

    try {
        const output = await new Promise((resolve, reject) => {
            exec(`${adbPath} -s ${s} shell dumpsys notification --noredact`, { maxBuffer: 1024 * 1024 * 5 }, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });

        const notifications = [];
        const lines = output.split('\n');
        let current = null;
        let inNotificationRecord = false;

        for (const line of lines) {
            if (line.includes('NotificationRecord(') && line.includes('pkg=')) {
                inNotificationRecord = true;
                const pkgMatch = line.match(/pkg=([^\s\)]+)/);
                if (pkgMatch) {
                    if (current && current.title) {
                        notifications.push(current);
                    }
                    current = {
                        package: pkgMatch[1],
                        app: pkgMatch[1].split('.').pop(),
                        title: null,
                        text: null
                    };
                }
            }

            if (current && inNotificationRecord) {
                if (line.includes('android.title=String (')) {
                    const titleMatch = line.match(/android\.title=String \(([^)]+)\)/);
                    if (titleMatch) current.title = titleMatch[1].trim();
                } else if (line.includes('android.title=') && !line.includes('android.title=null')) {
                    const titleMatch = line.match(/android\.title=(.+)/);
                    if (titleMatch && titleMatch[1] !== 'null') {
                        current.title = titleMatch[1].trim();
                    }
                }

                if (line.includes('android.text=String (')) {
                    const textMatch = line.match(/android\.text=String \(([^)]+)\)/);
                    if (textMatch) current.text = textMatch[1].trim();
                } else if (line.includes('android.text=') && !line.includes('android.text=null')) {
                    const textMatch = line.match(/android\.text=(.+)/);
                    if (textMatch && textMatch[1] !== 'null') {
                        current.text = textMatch[1].trim();
                    }
                }
            }
        }

        if (current && current.title) {
            notifications.push(current);
        }

        const seen = new Set();
        const filtered = notifications.filter(n => {
            if (!n.title || n.title === '通知' || n.title === 'null') return false;
            const key = n.package + ':' + n.title;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        state.notificationCache = filtered.slice(0, 20);
        return state.notificationCache;
    } catch (e) {
        console.error('get-notifications error:', e);
        return [];
    }
}

function startNotificationWatcher(adbPath, serial) {
    if (state.notificationWatcher) clearInterval(state.notificationWatcher);

    let lastCount = 0;
    state.notificationWatcher = setInterval(async () => {
        if (!state.selectedSerial) return;

        try {
            const output = await new Promise((resolve) => {
                exec(`${adbPath} -s ${serial} shell dumpsys notification --noredact | grep -c "pkg="`, (err, stdout) => {
                    resolve(stdout?.trim() || '0');
                });
            });

            const count = parseInt(output) || 0;
            if (count > lastCount) {
                const notifs = await getNotifications(adbPath);
                if (notifs && notifs.length > 0) {
                    const newest = notifs[0];

                    if (Notification.isSupported()) {
                        const n = new Notification({
                            title: newest.title || newest.app,
                            body: newest.text || '',
                            silent: false
                        });
                        n.on('click', () => {
                            if (newest.package) {
                                exec(`${adbPath} -s ${serial} shell monkey -p "${newest.package}" -c android.intent.category.LAUNCHER 1`);
                            }
                        });
                        n.show();
                    }

                    if (state.overviewWindow && !state.overviewWindow.isDestroyed()) {
                        state.overviewWindow.webContents.send('new-notification', newest);
                    }
                }
            }
            lastCount = count;
        } catch (e) {
        }
    }, 3000);
}

function stopNotificationWatcher() {
    if (state.notificationWatcher) {
        clearInterval(state.notificationWatcher);
        state.notificationWatcher = null;
    }
}

function registerIpcHandlers({ adbPath, launchScreenMirror, createOverviewWindow, snapWindowToRatio, updateWindowAspectRatio }) {
    const getAdbPath = () => {
        const resolved = typeof adbPath === 'function' ? adbPath() : adbPath;
        return resolved || 'adb';
    };
    ipcMain.handle('get-scrcpy-status', () => ({
        isScrcpyDownloading: state.isScrcpyDownloading,
        isAdbReady: state.isAdbReady
    }));

    ipcMain.handle('get-devices', async () => {
        try {
            if (state.isScrcpyDownloading) {
                throw new Error('SCRCPY_DOWNLOADING');
            }
            if (!state.isAdbReady) {
                throw new Error('ADB_NOT_READY');
            }
            const devices = await client.listDevices();
            const enriched = await Promise.all(devices.map(async (d) => {
                let model = 'Unknown';
                try {
                    const props = await client.getProperties(d.id);
                    model = props['ro.product.model'] || 'Android Device';
                } catch (e) { }

                let alias = null;
                if (deviceConfig[d.id] && deviceConfig[d.id].alias) {
                    alias = deviceConfig[d.id].alias;
                }

                return { id: d.id, model, alias };
            }));
            return enriched;
        } catch (e) {
            console.error('ADB Error:', e);
            throw e;
        }
    });

    ipcMain.on('connect-device', async (event, payload) => {
        const serial = typeof payload === 'string' ? payload : payload?.serial;
        const alias = typeof payload === 'object' ? payload?.alias : null;
        const model = typeof payload === 'object' ? payload?.model : null;

        console.log(`[Launcher] Selected device: ${serial}`);
        state.selectedSerial = serial;
        state.selectedAlias = alias || null;
        state.selectedModel = model || null;
        setTrackedDevice(serial);

        await launchScreenMirror();
    });

    ipcMain.on('start-screen-mirror', async () => {
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
            state.mainWindow.show();
            state.mainWindow.focus();
            return;
        }

        await launchScreenMirror();
    });

    ipcMain.on('disconnect-device', () => {
        console.log('[Overview] Disconnecting...');
        state.selectedSerial = null;
        state.isScrcpyStarted = false;
        clearTrackedDevice();
        if (state.overviewWindow) {
            state.overviewWindow.close();
            state.overviewWindow = null;
        }
        if (state.mainWindow) {
            state.mainWindow.close();
            state.mainWindow = null;
        }
    });

    ipcMain.on('return-to-overview', () => {
        console.log('[Main] Opening Overview...');

        if (state.overviewWindow && !state.overviewWindow.isDestroyed()) {
            state.overviewWindow.show();
            state.overviewWindow.focus();
        } else {
            createOverviewWindow();
        }
    });

    ipcMain.on('set-aspect-ratio', (event, width, height) => {
        if (state.mainWindow) {
            state.currentVideoRatio = width / height;
            updateWindowAspectRatio();
        }
    });

    ipcMain.on('resize-window', (event, sidebarWidth) => {
        if (state.mainWindow) {
            console.log(`[Main] Sidebar Resize: ${sidebarWidth}`);
            state.currentSidebarWidth = sidebarWidth;
            updateWindowAspectRatio();
        }
    });

    ipcMain.handle('get-keymaps', async () => {
        try {
            const files = fs.readdirSync(KEYMAPS_DIR).filter(f => f.endsWith('.json'));
            return files;
        } catch (e) { console.error(e); return []; }
    });

    ipcMain.handle('save-keymap', async (event, name, data) => {
        try {
            const safeName = name.replace(/[^a-z0-9_\-\.]/gi, '_');
            const filePath = nodePath.join(KEYMAPS_DIR, safeName.endsWith('.json') ? safeName : safeName + '.json');
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            return { success: true, filename: nodePath.basename(filePath) };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('save-keymap-dialog', async (event, data) => {
        const result = await dialog.showSaveDialog(state.mainWindow, {
            title: 'Save Keymap Profile',
            defaultPath: nodePath.join(KEYMAPS_DIR, 'new_profile.json'),
            filters: [{ name: 'Keymap JSON', extensions: ['json'] }]
        });

        if (result.canceled || !result.filePath) return { success: false };

        try {
            fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2));
            return { success: true, filename: nodePath.basename(result.filePath) };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('load-keymap', async (event, name) => {
        try {
            const filePath = nodePath.join(KEYMAPS_DIR, name);
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf8'));
            }
            return {};
        } catch (e) { return {}; }
    });

    ipcMain.handle('get-device-alias', async (event, serial) => {
        const s = serial || state.selectedSerial;
        if (deviceConfig[s] && deviceConfig[s].alias) {
            return deviceConfig[s].alias;
        }
        return s || 'default';
    });

    ipcMain.handle('set-device-alias', async (event, serial, alias) => {
        if (!deviceConfig[serial]) deviceConfig[serial] = {};
        deviceConfig[serial].alias = alias;
        saveDeviceConfig();
        return true;
    });

    ipcMain.handle('get-current-serial', () => state.selectedSerial);

    ipcMain.handle('get-device-info', async (event, serial) => {
        const s = serial || state.selectedSerial;
        if (!s) return null;

        try {
            const props = await client.getProperties(s);

            const shell = async (cmd) => {
                return new Promise((resolve) => {
                    exec(`${getAdbPath()} -s ${s} shell ${cmd}`, (err, stdout) => {
                        resolve(stdout ? stdout.trim() : '');
                    });
                });
            };

            const batteryOutput = await shell('dumpsys battery');
            const batteryMatch = batteryOutput.match(/level: (\d+)/);
            const chargingMatch = batteryOutput.match(/status: (\d+)/);
            const battery = batteryMatch ? parseInt(batteryMatch[1]) : null;
            const isCharging = chargingMatch ? chargingMatch[1] === '2' || chargingMatch[1] === '5' : false;

            const dfOutput = await shell('df /data | tail -1');
            const dfParts = dfOutput.split(/\s+/);
            let storageUsed = null, storageTotal = null;
            if (dfParts.length >= 4) {
                storageTotal = parseInt(dfParts[1]) / 1024 / 1024;
                storageUsed = parseInt(dfParts[2]) / 1024 / 1024;
            }

            const memOutput = await shell('cat /proc/meminfo');
            const memTotalMatch = memOutput.match(/MemTotal:\s+(\d+)/);
            const memAvailMatch = memOutput.match(/MemAvailable:\s+(\d+)/);
            let memTotal = null, memUsed = null;
            if (memTotalMatch && memAvailMatch) {
                memTotal = parseInt(memTotalMatch[1]) / 1024 / 1024;
                const memAvail = parseInt(memAvailMatch[1]) / 1024 / 1024;
                memUsed = memTotal - memAvail;
            }

            const wifiOutput = await shell('dumpsys wifi | grep "mWifiInfo"');
            const ssidMatch = wifiOutput.match(/SSID: ([^,]+)/);
            const ssid = ssidMatch ? ssidMatch[1].replace(/"/g, '') : null;

            const ipOutput = await shell('ip addr show wlan0 | grep "inet "');
            const ipMatch = ipOutput.match(/inet (\d+\.\d+\.\d+\.\d+)/);
            const ipAddress = ipMatch ? ipMatch[1] : null;

            let alias = null;
            if (deviceConfig[s] && deviceConfig[s].alias) {
                alias = deviceConfig[s].alias;
            } else if (state.selectedAlias && state.selectedSerial === s) {
                alias = state.selectedAlias;
            }

            return {
                alias,
                manufacturer: props['ro.product.manufacturer'] || 'Unknown',
                model: props['ro.product.model'] || 'Android Device',
                androidVersion: props['ro.build.version.release'] || 'Unknown',
                sdkVersion: props['ro.build.version.sdk'] || 'Unknown',
                battery,
                isCharging,
                storageUsed: storageUsed ? storageUsed.toFixed(2) : null,
                storageTotal: storageTotal ? storageTotal.toFixed(2) : null,
                memUsed: memUsed ? memUsed.toFixed(2) : null,
                memTotal: memTotal ? memTotal.toFixed(2) : null,
                ssid,
                ipAddress,
                serial: s
            };
        } catch (e) {
            console.error('get-device-info error:', e);
            return null;
        }
    });

    ipcMain.handle('list-files', async (event, path = '/sdcard') => {
        const s = state.selectedSerial;
        console.log('[list-files] SELECTED_SERIAL:', s, 'path:', path);
        if (!s) {
            console.log('[list-files] No serial selected!');
            return [];
        }

        try {
            const targetPath = path.endsWith('/') ? path : path + '/';
            const cmd = `${getAdbPath()} -s ${s} shell ls -la "${targetPath}"`;
            console.log('[list-files] Running:', cmd);

            const output = await new Promise((resolve, reject) => {
                exec(cmd, (err, stdout, stderr) => {
                    if (err) {
                        console.log('[list-files] Error:', err.message);
                        reject(err);
                    } else {
                        console.log('[list-files] Output length:', stdout.length);
                        resolve(stdout);
                    }
                });
            });

            const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('total'));
            console.log('[list-files] Lines to parse:', lines.length);
            const files = [];

            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 7) continue;

                const perms = parts[0];
                let dateIdx = parts.findIndex(p => /^\d{4}-\d{2}-\d{2}$/.test(p));
                if (dateIdx === -1) continue;

                const size = parseInt(parts[dateIdx - 1]) || 0;
                const date = parts[dateIdx] + ' ' + parts[dateIdx + 1];
                const name = parts.slice(dateIdx + 2).join(' ').split(' -> ')[0];

                if (!name || name === '.' || name === '..') continue;

                files.push({
                    name,
                    isDirectory: perms.startsWith('d'),
                    isLink: perms.startsWith('l'),
                    size,
                    date,
                    path: `${path}/${name}`.replace(/\/+/g, '/')
                });
            }
            return files;
        } catch (e) {
            console.error('list-files error:', e);
            return [];
        }
    });

    ipcMain.handle('pull-file', async (event, remotePath) => {
        const s = state.selectedSerial;
        if (!s) return null;

        const fileName = remotePath.split('/').pop();
        const result = await dialog.showSaveDialog({
            defaultPath: fileName,
            title: '儲存檔案'
        });

        if (result.canceled) return null;

        try {
            await new Promise((resolve, reject) => {
                exec(`${getAdbPath()} -s ${s} pull "${remotePath}" "${result.filePath}"`, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            return result.filePath;
        } catch (e) {
            console.error('pull-file error:', e);
            return null;
        }
    });

    ipcMain.handle('push-file', async (event, remotePath) => {
        const s = state.selectedSerial;
        if (!s) return false;

        const result = await dialog.showOpenDialog({
            title: '選擇檔案上傳',
            properties: ['openFile']
        });

        if (result.canceled) return false;

        try {
            await new Promise((resolve, reject) => {
                exec(`${getAdbPath()} -s ${s} push "${result.filePaths[0]}" "${remotePath}"`, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            return true;
        } catch (e) {
            console.error('push-file error:', e);
            return false;
        }
    });

    ipcMain.handle('delete-file', async (event, remotePath) => {
        const s = state.selectedSerial;
        if (!s) return false;

        try {
            await new Promise((resolve, reject) => {
                exec(`${getAdbPath()} -s ${s} shell rm -rf "${remotePath}"`, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            return true;
        } catch (e) {
            console.error('delete-file error:', e);
            return false;
        }
    });

    ipcMain.handle('list-apps', async (event, filter = 'user') => {
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
    });

    ipcMain.handle('uninstall-app', async (event, packageName) => {
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
    });

    ipcMain.handle('install-apk', async () => {
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
    });

    ipcMain.handle('launch-app', async (event, packageName) => {
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
    });

    ipcMain.handle('export-apk', async (event, packageName) => {
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
    });

    ipcMain.handle('get-notifications', async () => {
        return getNotifications(getAdbPath());
    });

    ipcMain.handle('clear-notifications', async () => {
        const s = state.selectedSerial;
        if (!s) return false;

        try {
            await new Promise((resolve, reject) => {
                exec(`${getAdbPath()} -s ${s} shell service call notification 1`, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            state.notificationCache = [];
            return true;
        } catch (e) {
            console.error('clear-notifications error:', e);
            return false;
        }
    });

    return {
        startNotificationWatcher: (serial) => startNotificationWatcher(getAdbPath(), serial),
        stopNotificationWatcher
    };
}

export {
    registerIpcHandlers
};
