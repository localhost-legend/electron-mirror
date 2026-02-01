import fs from 'fs';
import { execFile } from 'child_process';
import adb from 'adbkit';
import { getScrcpyConfig } from './config.js';

function normalizeAdbPath(candidate) {
    if (candidate && fs.existsSync(candidate)) return candidate;
    return 'adb';
}

let adbPath = normalizeAdbPath(getScrcpyConfig().ADB_PATH);
let client = adb.createClient({ host: '127.0.0.1', port: 5037, bin: adbPath });

let deviceTracker = null;
let trackerOptions = null;
let trackedSerial = null;
const lastDevices = new Map();

function notifyDevicesChanged(eventType, device) {
    if (trackerOptions && typeof trackerOptions.onDevicesChanged === 'function') {
        trackerOptions.onDevicesChanged(Array.from(lastDevices.values()), { eventType, device });
    }
}

function handleTrackedDeviceEvent(eventType, device, previousType) {
    if (!trackedSerial || device.id !== trackedSerial) return;

    const isConnected = device.type === 'device';
    if (trackerOptions && typeof trackerOptions.onTrackedDeviceChange === 'function') {
        trackerOptions.onTrackedDeviceChange({
            serial: device.id,
            type: device.type,
            previousType: previousType || null,
            eventType,
            isConnected
        });
    }

    if (!isConnected && trackerOptions && typeof trackerOptions.onTrackedDeviceDisconnected === 'function') {
        trackerOptions.onTrackedDeviceDisconnected({
            serial: device.id,
            type: device.type,
            previousType: previousType || null,
            eventType
        });
    }
}

function handleDeviceEvent(eventType, device) {
    const previous = lastDevices.get(device.id);
    const previousType = previous ? previous.type : null;

    if (eventType === 'remove') {
        lastDevices.delete(device.id);
    } else {
        lastDevices.set(device.id, device);
    }

    if (trackerOptions) {
        if ((eventType === 'add' || eventType === 'change') && device.type === 'device' && previousType !== 'device') {
            if (typeof trackerOptions.onDeviceConnected === 'function') {
                trackerOptions.onDeviceConnected(device);
            }
        }

        if ((eventType === 'remove' || eventType === 'change') && previousType === 'device' && device.type !== 'device') {
            if (typeof trackerOptions.onDeviceDisconnected === 'function') {
                trackerOptions.onDeviceDisconnected({ id: device.id, type: device.type, previousType });
            }
        }
    }

    handleTrackedDeviceEvent(eventType, device, previousType);
    notifyDevicesChanged(eventType, device);
}

async function startDeviceMonitor(options = {}) {
    trackerOptions = options;
    if (deviceTracker) return deviceTracker;

    try {
        deviceTracker = await client.trackDevices();
    } catch (e) {
        console.error('[ADB] Failed to start device tracker:', e);
        return null;
    }

    deviceTracker.on('add', (device) => handleDeviceEvent('add', device));
    deviceTracker.on('remove', (device) => handleDeviceEvent('remove', device));
    deviceTracker.on('change', (device) => handleDeviceEvent('change', device));
    deviceTracker.on('error', (err) => {
        console.error('[ADB] Device tracker error:', err);
    });
    deviceTracker.on('end', () => {
        deviceTracker = null;
        if (trackerOptions && typeof trackerOptions.onTrackerEnd === 'function') {
            trackerOptions.onTrackerEnd();
        }
        setTimeout(() => startDeviceMonitor(trackerOptions), 1000);
    });

    return deviceTracker;
}

function setTrackedDevice(serial) {
    trackedSerial = serial || null;
}

function clearTrackedDevice(serial) {
    if (!serial || trackedSerial === serial) trackedSerial = null;
}

function setAdbPath(newPath) {
    adbPath = normalizeAdbPath(newPath);
    client = adb.createClient({ host: '127.0.0.1', port: 5037, bin: adbPath });
    return client;
}

async function stopAdbServer() {
    try {
        if (deviceTracker) {
            deviceTracker.removeAllListeners();
            if (typeof deviceTracker.end === 'function') {
                await deviceTracker.end();
            } else if (typeof deviceTracker.close === 'function') {
                deviceTracker.close();
            }
            deviceTracker = null;
        }

        if (client && typeof client.kill === 'function') {
            await client.kill();
            return;
        }

        await new Promise((resolve) => {
            execFile(adbPath || 'adb', ['kill-server'], () => resolve());
        });
    } catch (e) {
        console.error('[ADB] Failed to stop adb server:', e);
    }
}

export {
    adb,
    client,
    startDeviceMonitor,
    setTrackedDevice,
    clearTrackedDevice,
    setAdbPath,
    stopAdbServer
};
