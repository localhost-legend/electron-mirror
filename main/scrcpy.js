import fs from 'fs';
import net from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import state from './state.js';
import { client } from './adb.js';

let wss = null;
let wssAudio = null;

function initWebSocketServers() {
    if (wss || wssAudio) return;

    wss = new WebSocketServer({ port: 8080 });
    wssAudio = new WebSocketServer({ port: 8081 });

    console.log('WS (Video/Control) on 8080');
    console.log('WS (Audio) on 8081');

    wss.on('connection', (ws) => {
        console.log('[WSS-Video] Desktop Client connected');

        if (state.streamHistory.length > 0) {
            console.log(`[WSS] Sending ${state.streamHistory.length} buffered chunks to new client`);
            state.streamHistory.forEach(chunk => ws.send(chunk));
        }

        ws.on('message', (msg) => {
            if (state.controlSocket && !state.controlSocket.destroyed) {
                try { state.controlSocket.write(msg); } catch (e) { }
            }
        });
    });

    wssAudio.on('connection', () => {
        console.log('[WSS-Audio] Client connected!');
    });
}

function log(msg) {
    console.log(msg);
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('server-log', msg);
    }
}

function connectSockets(port) {
    log('[Node] Connecting to Video Socket...');
    state.videoSocket = net.connect(port, '127.0.0.1', () => {
        log('[Node] Video Socket Connected!');

        state.videoSocket.on('data', (d) => {
            if (state.streamHistory.length === 0) log(`[Node] First Video Packet: ${d.length} bytes`);

            if (wss.clients.size === 0 || state.streamHistory.length < 100) {
                state.streamHistory.push(d);
                if (state.streamHistory.length > 5000) state.streamHistory.shift();
            }
            wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(d); });
        });

        state.videoSocket.on('error', (e) => log(`[Node] Video Socket Error: ${e.message}`));

        setTimeout(() => {
            log('[Node] Connecting to Audio...');
            state.audioSocket = net.connect(port, '127.0.0.1', () => {
                log('[Node] Audio Connected');
                state.audioSocket.on('data', (d) => {
                    wssAudio.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(d); });
                });

                setTimeout(() => {
                    state.controlSocket = net.connect(port, '127.0.0.1', () => log('[Node] Control Connected'));
                }, 100);
            });
        }, 100);
    });
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

        const cmd = `CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server ${scrcpyVersion} video_codec=h264 max_size=1920 max_fps=60 tunnel_forward=true control=true audio=true audio_codec=raw audio_encoder=scrcpy send_device_meta=true send_frame_meta=true send_dummy_byte=true send_codec_meta=true`;

        const logProc = (proc) => {
            proc.stdout.on('data', (d) => log(`${d}`));
            proc.stderr.on('data', (d) => console.error(`[Server ERR] ${d}`));
            proc.on('exit', (code) => log(`Exited with code ${code}`));
        };

        let proc;
        if (process.platform === 'win32') {
            proc = spawn(adbPath, ['-s', serial, 'shell', cmd]);
        } else {
            proc = spawn(adbPath, ['-s', serial, 'shell', cmd]);
        }
        state.scrcpyProc = proc;
        logProc(proc);

        setTimeout(() => connectSockets(port), 2000);

    } catch (e) {
        log(`Scrcpy Start Error: ${e.message}`);
        state.isScrcpyStarted = false;
        throw e;
    }
}

export {
    initWebSocketServers,
    startScrcpy,
    stopScrcpy
};
