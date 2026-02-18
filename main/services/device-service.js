import fs from 'fs';
import nodePath from 'path';
import { exec } from 'child_process';
import state from '../state.js';
import { client, setTrackedDevice, clearTrackedDevice } from '../adb.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEVICES_FILE = nodePath.join(__dirname, '..', '..', 'devices.json');
const DEFAULT_SETTINGS = {
    maxFps: 60,
    maxSizePercent: 100,
    bitRateMbps: 0
};
let deviceConfig = {};
if (fs.existsSync(DEVICES_FILE)) {
    try { deviceConfig = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); } catch (e) { }
}

function loadDeviceConfig() {
    if (!fs.existsSync(DEVICES_FILE)) {
        deviceConfig = {};
        return;
    }
    try {
        deviceConfig = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
    } catch (e) {
        deviceConfig = {};
    }
}

function saveDeviceConfig() {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(deviceConfig, null, 2));
}

async function listDevices() {
    loadDeviceConfig();
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
}

async function connectDevice(payload, { launchScreenMirror }) {
    const serial = typeof payload === 'string' ? payload : payload?.serial;
    const alias = typeof payload === 'object' ? payload?.alias : null;
    const model = typeof payload === 'object' ? payload?.model : null;

    console.log(`[Launcher] Selected device: ${serial}`);
    state.selectedSerial = serial;
    state.selectedAlias = alias || null;
    state.selectedModel = model || null;
    setTrackedDevice(serial);

    await launchScreenMirror();
}

function disconnectDevice() {
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
}

function getDeviceAlias(serial) {
    loadDeviceConfig();
    const s = serial || state.selectedSerial;
    if (deviceConfig[s] && deviceConfig[s].alias) {
        return deviceConfig[s].alias;
    }
    return s || 'default';
}

function setDeviceAlias(serial, alias) {
    if (!deviceConfig[serial]) deviceConfig[serial] = {};
    deviceConfig[serial].alias = alias;
    saveDeviceConfig();
    if (serial === state.selectedSerial) {
        state.selectedAlias = alias;
        const title = alias || state.selectedModel || state.selectedSerial || 'Screen Mirror';
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
            state.mainWindow.setTitle(title);
        }
    }
    return true;
}

function getDeviceSettings(serial) {
    loadDeviceConfig();
    const s = serial || state.selectedSerial;
    if (!s) return { ...DEFAULT_SETTINGS };
    const entry = deviceConfig[s] || {};
    return { ...DEFAULT_SETTINGS, ...(entry.settings || {}) };
}

function setDeviceSettings(serial, settings = {}) {
    if (!serial) return { ...DEFAULT_SETTINGS };
    if (!deviceConfig[serial]) deviceConfig[serial] = {};
    deviceConfig[serial].settings = {
        ...DEFAULT_SETTINGS,
        ...(settings || {})
    };
    saveDeviceConfig();
    return deviceConfig[serial].settings;
}

async function getDeviceDisplaySize(getAdbPath, serial) {
    const s = serial || state.selectedSerial;
    if (!s) return null;
    try {
        const output = await new Promise((resolve) => {
            exec(`${getAdbPath()} -s ${s} shell wm size`, (err, stdout) => {
                resolve(stdout ? stdout.trim() : '');
            });
        });
        if (!output) return null;

        const physical = output.match(/Physical size:\s*(\d+)\s*x\s*(\d+)/i);
        const override = output.match(/Override size:\s*(\d+)\s*x\s*(\d+)/i);
        const match = override || physical;
        if (!match) return null;

        const width = parseInt(match[1], 10);
        const height = parseInt(match[2], 10);
        if (!width || !height) return null;

        return {
            width,
            height,
            longSide: Math.max(width, height),
            shortSide: Math.min(width, height),
            source: override ? 'override' : 'physical'
        };
    } catch (e) {
        return null;
    }
}

async function getDeviceSummary(serial) {
    const s = serial || state.selectedSerial;
    if (!s) return null;
    let model = null;
    try {
        const props = await client.getProperties(s);
        model = props['ro.product.model'] || null;
    } catch (e) { }
    return {
        serial: s,
        alias: getDeviceAlias(s),
        model
    };
}

function getCurrentSerial() {
    return state.selectedSerial;
}

async function getDeviceInfo(getAdbPath, serial) {
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
}

export {
    listDevices,
    connectDevice,
    disconnectDevice,
    getDeviceAlias,
    setDeviceAlias,
    getDeviceSettings,
    setDeviceSettings,
    getDeviceSummary,
    getDeviceDisplaySize,
    getCurrentSerial,
    getDeviceInfo
};
