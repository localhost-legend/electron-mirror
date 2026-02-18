import fs from 'fs';
import net from 'net';
import { spawn, execFile } from 'child_process';
import state from '../state.js';
import { getDeviceSettings } from './device-service.js';
import { client } from '../adb.js';

let videoBuffer = Buffer.alloc(0);
let audioBuffer = Buffer.alloc(0);
let rendererReady = false;
let clipboardSequence = 0n;
let loggedFirstVideoPacket = false;
let statsTimer = null;
let videoBytes = 0;
let audioBytes = 0;
let videoFrames = 0;

// Video States
const V_DUMMY = 0, V_DEVICE_NAME = 1, V_CODEC_META = 2, V_HEADER = 3, V_PAYLOAD = 4;
let vState = V_DUMMY, vNeeded = 1, vPTS = 0n, vSize = 0;
const CONFIG_FLAG = 1n << 63n;

// Audio States: NO DUMMY BYTE
const A_CODEC_META = 0;
const A_HEADER = 1;
const A_PAYLOAD = 2;
let aState = A_CODEC_META;
let aNeeded = 4;
let aPTS = 0n;
let aSize = 0;

function log(msg) {
    console.log(msg);
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('server-log', msg);
    }
}

function append(buffer, newData) {
    return Buffer.concat([buffer, newData]);
}

function consume(buffer, n) {
    return [buffer.subarray(0, n), buffer.subarray(n)];
}

function queuePacket(packet) {
    state.streamHistory.push(packet);
    if (state.streamHistory.length > 5000) state.streamHistory.shift();
}

function flushStreamHistory() {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
    if (!state.streamHistory.length) return;

    const history = state.streamHistory;
    state.streamHistory = [];

    for (const pkt of history) {
        if (pkt.type === 'video') {
            state.mainWindow.webContents.send('scrcpy-video-packet', pkt.payload);
        } else if (pkt.type === 'audio') {
            state.mainWindow.webContents.send('scrcpy-audio-packet', pkt.payload);
        }
    }
}

function toArrayBuffer(buf) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function emitVideoPacket(pts, payload) {
    if ((pts & CONFIG_FLAG) === 0n) {
        videoFrames += 1;
    }
    const packet = { pts: pts.toString(), data: toArrayBuffer(payload) };
    if (!state.mainWindow || state.mainWindow.isDestroyed() || !rendererReady) {
        queuePacket({ type: 'video', payload: packet });
        return;
    }
    state.mainWindow.webContents.send('scrcpy-video-packet', packet);
}

function emitAudioPacket(payload) {
    if (!state.mainWindow || state.mainWindow.isDestroyed() || !rendererReady) {
        queuePacket({ type: 'audio', payload: { data: toArrayBuffer(payload) } });
        return;
    }
    state.mainWindow.webContents.send('scrcpy-audio-packet', { data: toArrayBuffer(payload) });
}

function parseVideo() {
    while (true) {
        if (videoBuffer.length < vNeeded) return;
        if (vState === V_DUMMY) {
            videoBuffer = consume(videoBuffer, 1)[1]; vState = V_DEVICE_NAME; vNeeded = 64;
        } else if (vState === V_DEVICE_NAME) {
            videoBuffer = consume(videoBuffer, 64)[1]; vState = V_CODEC_META; vNeeded = 12;
        } else if (vState === V_CODEC_META) {
            videoBuffer = consume(videoBuffer, 12)[1]; vState = V_HEADER; vNeeded = 12;
        } else if (vState === V_HEADER) {
            const [header, rest] = consume(videoBuffer, 12);
            videoBuffer = rest;
            vPTS = header.readBigUInt64BE(0);
            vSize = header.readUInt32BE(8);
            vState = V_PAYLOAD; vNeeded = vSize;
        } else if (vState === V_PAYLOAD) {
            const [payload, rest] = consume(videoBuffer, vSize);
            videoBuffer = rest;
            emitVideoPacket(vPTS, payload);
            vState = V_HEADER; vNeeded = 12;
        }
    }
}

function parseAudio() {
    while (true) {
        if (audioBuffer.length < aNeeded) return;

        if (aState === A_CODEC_META) {
            audioBuffer = consume(audioBuffer, 4)[1];
            aState = A_HEADER; aNeeded = 12;
        } else if (aState === A_HEADER) {
            const [header, rest] = consume(audioBuffer, 12);
            audioBuffer = rest;
            aPTS = header.readBigUInt64BE(0);
            aSize = header.readUInt32BE(8);
            if (aSize > 100000) aSize = 0;
            aState = A_PAYLOAD; aNeeded = aSize;
        } else if (aState === A_PAYLOAD) {
            const [payload, rest] = consume(audioBuffer, aSize);
            audioBuffer = rest;
            emitAudioPacket(payload);
            aState = A_HEADER; aNeeded = 12;
        }
    }
}

function connectSockets(port) {
    log('[Node] Connecting to Video Socket...');
    state.videoSocket = net.connect(port, '127.0.0.1', () => {
        log('[Node] Video Socket Connected!');

        state.videoSocket.on('data', (d) => {
            if (!loggedFirstVideoPacket) {
                log(`[Node] First Video Packet: ${d.length} bytes`);
                loggedFirstVideoPacket = true;
            }
            videoBytes += d.length;
            videoBuffer = append(videoBuffer, d);
            parseVideo();
        });

        state.videoSocket.on('error', (e) => log(`[Node] Video Socket Error: ${e.message}`));

        setTimeout(() => {
            log('[Node] Connecting to Audio...');
            state.audioSocket = net.connect(port, '127.0.0.1', () => {
                log('[Node] Audio Connected');
                state.audioSocket.on('data', (d) => {
                    audioBytes += d.length;
                    audioBuffer = append(audioBuffer, d);
                    parseAudio();
                });
                state.audioSocket.on('error', (e) => log(`[Node] Audio Socket Error: ${e.message}`));

                setTimeout(() => {
                    state.controlSocket = net.connect(port, '127.0.0.1', () => log('[Node] Control Connected'));
                    state.controlSocket.on('error', (e) => log(`[Node] Control Socket Error: ${e.message}`));
                }, 100);
            });
        }, 100);
    });

    if (!statsTimer) {
        statsTimer = setInterval(() => {
            const videoKbps = Math.round((videoBytes * 8) / 1000);
            const audioKbps = Math.round((audioBytes * 8) / 1000);
            const fps = videoFrames;

            if (videoKbps || audioKbps || fps) {
                console.log(`[Stats] in=${videoKbps}kbps video, ${audioKbps}kbps audio, packets_fps=${fps}`);
            }

            videoBytes = 0;
            audioBytes = 0;
            videoFrames = 0;
        }, 1000);
    }
}

function stopScrcpy() {
    console.log('[Main] Stopping scrcpy and cleaning up...');

    if (state.scrcpyProc && !state.scrcpyProc.killed) {
        state.scrcpyProc.kill();
        state.scrcpyProc = null;
    }

    if (state.videoSocket) { try { state.videoSocket.destroy(); } catch (e) { } state.videoSocket = null; }
    if (state.audioSocket) { try { state.audioSocket.destroy(); } catch (e) { } state.audioSocket = null; }
    if (state.controlSocket) { try { state.controlSocket.destroy(); } catch (e) { } state.controlSocket = null; }

    state.streamHistory = [];
    state.isScrcpyStarted = false;
    rendererReady = false;
    loggedFirstVideoPacket = false;
    if (statsTimer) {
        clearInterval(statsTimer);
        statsTimer = null;
    }
    videoBytes = 0;
    audioBytes = 0;
    videoFrames = 0;

    videoBuffer = Buffer.alloc(0);
    audioBuffer = Buffer.alloc(0);
    vState = V_DUMMY; vNeeded = 1; vPTS = 0n; vSize = 0;
    aState = A_CODEC_META; aNeeded = 4; aPTS = 0n; aSize = 0;

    console.log('[Main] Cleanup complete');
}

async function startScrcpy({ adbPath, scrcpyServerPath, scrcpyVersion }) {
    if (state.isScrcpyStarted) { log('Scrcpy already started'); return; }
    state.isScrcpyStarted = true;

    try {
        const serial = state.selectedSerial;
        if (!serial) throw new Error('No Serial Selected');

        if (!fs.existsSync(scrcpyServerPath)) {
            throw new Error(`Scrcpy Server JAR not found at: ${scrcpyServerPath}`);
        }

        log(`[ADB] Pushing Server to ${serial}...`);
        const transfer = await client.push(serial, scrcpyServerPath, '/data/local/tmp/scrcpy-server.jar');
        await new Promise((resolve, reject) => {
            transfer.on('end', resolve);
            transfer.on('error', reject);
        });
        log('[ADB] Server pushed.');

        const port = 27199;
        await client.forward(serial, `tcp:${port}`, 'localabstract:scrcpy');
        log(`[ADB] Forwarded tcp:${port}`);

        const settings = getDeviceSettings(serial);
        const maxFps = Math.max(1, Math.min(120, Number(settings.maxFps) || 60));
        const maxSizePercentRaw = Number(settings.maxSizePercent);
        const maxSizePercent = Number.isFinite(maxSizePercentRaw)
            ? Math.max(25, Math.min(100, maxSizePercentRaw))
            : 100;
        const bitRateMbps = Number(settings.bitRateMbps) || 0;

        const displaySize = await new Promise((resolve) => {
            execFile(adbPath, ['-s', serial, 'shell', 'wm', 'size'], (err, stdout) => {
                if (err || !stdout) return resolve(null);
                const output = String(stdout);
                const physical = output.match(/Physical size:\s*(\d+)\s*x\s*(\d+)/i);
                const override = output.match(/Override size:\s*(\d+)\s*x\s*(\d+)/i);
                const match = override || physical;
                if (!match) return resolve(null);
                const width = parseInt(match[1], 10);
                const height = parseInt(match[2], 10);
                if (!width || !height) return resolve(null);
                resolve({ width, height, longSide: Math.max(width, height) });
            });
        });

        let maxSize = 1920;
        if (displaySize && displaySize.longSide) {
            maxSize = Math.round(displaySize.longSide * (maxSizePercent / 100));
        } else if (settings.maxSize) {
            maxSize = Math.round(Number(settings.maxSize) || 1920);
        }
        maxSize = Math.max(320, Math.min(4096, maxSize));

        const opts = [
            'video_codec=h264',
            `max_size=${maxSize}`,
            `max_fps=${maxFps}`,
            'tunnel_forward=true',
            'control=true',
            'audio=true',
            'audio_codec=raw',
            'audio_encoder=scrcpy',
            'send_device_meta=true',
            'send_frame_meta=true',
            'send_dummy_byte=true',
            'send_codec_meta=true'
        ];

        if (bitRateMbps > 0) {
            const bitRate = Math.round(bitRateMbps * 1000000);
            opts.push(`bit_rate=${bitRate}`);
        }

        const cmd = `CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server ${scrcpyVersion} ${opts.join(' ')}`;

        const logProc = (proc) => {
            proc.stdout.on('data', (d) => log(`${d}`));
            proc.stderr.on('data', (d) => console.error(`[Server ERR] ${d}`));
            proc.on('exit', (code) => log(`Exited with code ${code}`));
        };

        const proc = spawn(adbPath, ['-s', serial, 'shell', cmd]);
        state.scrcpyProc = proc;
        logProc(proc);

        setTimeout(() => connectSockets(port), 2000);

    } catch (e) {
        log(`Scrcpy Start Error: ${e.message}`);
        state.isScrcpyStarted = false;
        throw e;
    }
}

function normalizePointerId(pointerId) {
    const id = BigInt(pointerId);
    if (id >= 0) return id;
    return (1n << 64n) + id;
}

function sendControlBuffer(buffer) {
    if (state.controlSocket && !state.controlSocket.destroyed) {
        try { state.controlSocket.write(buffer); } catch (e) { }
    }
}

function injectTouch({ action, x, y, width, height, pointerId = -1, buttons = null }) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const buffer = Buffer.alloc(32);

    buffer.writeUInt8(2, 0);
    buffer.writeUInt8(action, 1);
    buffer.writeBigUInt64BE(normalizePointerId(pointerId), 2);
    buffer.writeUInt32BE(Math.round(x), 10);
    buffer.writeUInt32BE(Math.round(y), 14);
    buffer.writeUInt16BE(w, 18);
    buffer.writeUInt16BE(h, 20);
    buffer.writeUInt16BE(0xffff, 22);

    let ab = 0, b = 0;
    if (buttons && typeof buttons === 'object') {
        ab = buttons.ab || 0;
        b = buttons.b || 0;
    } else if (action === 0 || action === 2) {
        ab = 1; b = 1;
    }
    buffer.writeUInt32BE(ab, 24);
    buffer.writeUInt32BE(b, 28);

    sendControlBuffer(buffer);
}

function injectKeycode({ keycode }) {
    const send = (action) => {
        const b = Buffer.alloc(14);
        b.writeUInt8(0, 0);
        b.writeUInt8(action, 1);
        b.writeUInt32BE(keycode, 2);
        sendControlBuffer(b);
    };
    send(0);
    setTimeout(() => send(1), 50);
}

function injectClipboard({ text }) {
    const bytes = Buffer.from(String(text), 'utf8');
    const len = 1 + 8 + 1 + 4 + bytes.length;
    const buffer = Buffer.alloc(len);

    clipboardSequence += 1n;
    const sequence = clipboardSequence;
    buffer.writeUInt8(9, 0);
    buffer.writeBigUInt64BE(BigInt(sequence), 1);
    buffer.writeUInt8(1, 9);
    buffer.writeUInt32BE(bytes.length, 10);
    bytes.copy(buffer, 14);

    sendControlBuffer(buffer);
}

function sendInputEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'touch') {
        injectTouch(event);
    } else if (event.type === 'keycode') {
        injectKeycode(event);
    } else if (event.type === 'clipboard') {
        injectClipboard(event);
    }
}

function handleRendererReady() {
    rendererReady = true;
    flushStreamHistory();
}

export {
    startScrcpy,
    stopScrcpy,
    sendInputEvent,
    handleRendererReady
};
