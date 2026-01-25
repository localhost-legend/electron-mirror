const canvas = document.getElementById('videoCanvas');
const ctx = canvas.getContext('2d');
const { ipcRenderer } = require('electron');

let decoder = null;
let ws = null;
let wsAudio = null;
let audioCtx = null;
let audioGain = null;
let audioStartTime = 0;
let clipboardSequence = 0;

// FAILSAFE: Drop initial packets
let audioDropCounter = 5;

// Buffers
let videoBuffer = new Uint8Array(0);
let audioBuffer = new Uint8Array(0);

// Video States
const V_DUMMY = 0, V_DEVICE_NAME = 1, V_CODEC_META = 2, V_HEADER = 3, V_PAYLOAD = 4;
let vState = V_DUMMY, vNeeded = 1, vPTS = 0n, vSize = 0, vPendingConfig = null;

// Audio States: NO DUMMY BYTE
const A_CODEC_META = 0;
const A_HEADER = 1;
const A_PAYLOAD = 2;
let aState = A_CODEC_META;
let aNeeded = 4;
let aPTS = 0n;
let aSize = 0;

function append(buffer, newData) {
    const newBuf = new Uint8Array(buffer.length + newData.length);
    newBuf.set(buffer, 0);
    newBuf.set(newData, buffer.length);
    return newBuf;
}

function consume(buffer, n) {
    return [buffer.slice(0, n), buffer.slice(n)];
}

async function initDecoder() {
    if (!('VideoDecoder' in window)) return;
    let firstFrame = true;
    decoder = new VideoDecoder({
        output: (frame) => {
            const status = document.getElementById('status');
            if (status) status.style.display = 'none';

            if (firstFrame || canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                canvas.width = frame.displayWidth;
                canvas.height = frame.displayHeight;
                ipcRenderer.send('set-aspect-ratio', frame.displayWidth, frame.displayHeight);
                firstFrame = false;
            }
            ctx.drawImage(frame, 0, 0);
            frame.close();
        },
        error: (e) => console.error(e)
    });
    try { decoder.configure({ codec: 'avc1.42001E', optimizeForLatency: true }); } catch (e) { }
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
            const view = new DataView(header.buffer);
            vPTS = view.getBigUint64(0, false);
            vSize = view.getUint32(8, false);
            vState = V_PAYLOAD; vNeeded = vSize;
        } else if (vState === V_PAYLOAD) {
            const [payload, rest] = consume(videoBuffer, vSize);
            videoBuffer = rest;
            handleVideoPayload(payload, vPTS);
            vState = V_HEADER; vNeeded = 12;
        }
    }
}

function handleVideoPayload(payload, pts) {
    const CONFIG_FLAG = 1n << 63n;
    const KEY_FRAME_FLAG = 1n << 62n;
    const isConfig = (pts & CONFIG_FLAG) !== 0n;
    const isKeyFrame = (pts & KEY_FRAME_FLAG) !== 0n;
    const rawPTS = pts & ~(CONFIG_FLAG | KEY_FRAME_FLAG);

    if (isConfig) {
        vPendingConfig = payload;
    } else {
        let dataToFeed = payload;
        const naluType = payload[4] & 0x1f;
        const type = (isKeyFrame || naluType === 5) ? 'key' : 'delta';
        if (type === 'key' && vPendingConfig) {
            dataToFeed = append(vPendingConfig, payload);
            vPendingConfig = null;
        }
        try {
            if (decoder.state === 'configured') result = decoder.decode(new EncodedVideoChunk({ type, timestamp: Number(rawPTS), data: dataToFeed }));
        } catch (e) { }
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
            const view = new DataView(header.buffer);
            aPTS = view.getBigUint64(0, false);
            aSize = view.getUint32(8, false);
            if (aSize > 100000) aSize = 0;
            aState = A_PAYLOAD; aNeeded = aSize;
        } else if (aState === A_PAYLOAD) {
            const [payload, rest] = consume(audioBuffer, aSize);
            audioBuffer = rest;
            if (audioDropCounter > 0) { audioDropCounter--; } else { playPCM(payload); }
            aState = A_HEADER; aNeeded = 12;
        }
    }
}

async function playPCM(data) {
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (audioGain && audioGain.gain.value < 1.0) audioGain.gain.value = 1.0;

    const rawData = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    const floatData = new Float32Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) floatData[i] = rawData[i] / 32768.0;
    if (floatData.length === 0) return;

    const audioBuffer = audioCtx.createBuffer(2, floatData.length / 2, 48000);
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);

    for (let i = 0; i < floatData.length / 2; i++) {
        left[i] = floatData[i * 2];
        right[i] = floatData[i * 2 + 1];
    }

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioGain);

    if (audioStartTime < audioCtx.currentTime) audioStartTime = audioCtx.currentTime + 0.05;
    source.start(audioStartTime);
    audioStartTime += audioBuffer.duration;
}

async function start() {
    await initDecoder();

    const resumeAudio = async () => { if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume(); };
    window.addEventListener('click', resumeAudio);
    window.addEventListener('keydown', resumeAudio);

    const imeBar = document.getElementById('ime-bar');
    const imeInput = document.getElementById('ime-input');
    const btnKeyboard = document.getElementById('btn-keyboard');
    const btnSend = document.getElementById('btn-send');

    const sidebar = document.getElementById('sidebar');
    const btnCollapse = document.getElementById('btn-collapse');
    const btnExpand = document.getElementById('btn-expand');

    let isKeyboardOpen = false;
    let isSidebarOpen = true;

    // Sidebar Logic (Fix: Explicit/JS Display Toggle)
    const toggleSidebar = (show) => {
        isSidebarOpen = show;
        if (show) {
            sidebar.classList.remove('collapsed');
            btnExpand.style.display = 'none'; // Hide Expand Button
            ipcRenderer.send('resize-window', 48);
        } else {
            sidebar.classList.add('collapsed');
            btnExpand.style.display = 'flex'; // Show Expand Button
            ipcRenderer.send('resize-window', 0);
        }
    };

    btnCollapse.onclick = () => toggleSidebar(false);
    btnExpand.onclick = () => toggleSidebar(true);

    // Keyboard Logic
    const toggleKeyboard = () => {
        isKeyboardOpen = !isKeyboardOpen;
        if (isKeyboardOpen) {
            imeBar.classList.add('visible');
            btnKeyboard.classList.add('active');
            setTimeout(() => imeInput.focus(), 50);
        } else {
            imeBar.classList.remove('visible');
            btnKeyboard.classList.remove('active');
            imeInput.blur();
        }
    };

    const sendText = () => {
        const text = imeInput.value;
        if (text) {
            injectClipboardPaste(text);
            setTimeout(() => { injectKeycode(66); }, 50);
        }
        imeInput.value = '';
    };

    btnKeyboard.onclick = toggleKeyboard;
    btnSend.onclick = sendText;

    imeInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
            if (!e.isComposing) sendText();
        } else if (e.key === 'Escape') {
            toggleKeyboard();
        }
    });

    document.getElementById('btn-back').onclick = () => injectKeycode(4);
    document.getElementById('btn-home').onclick = () => injectKeycode(3);
    document.getElementById('btn-recent').onclick = () => injectKeycode(187);
    document.getElementById('btn-vol-up').onclick = () => injectKeycode(24);
    document.getElementById('btn-vol-down').onclick = () => injectKeycode(25);

    // Websockets
    wsAudio = new WebSocket('ws://localhost:8081');
    wsAudio.binaryType = 'arraybuffer';
    wsAudio.onopen = () => {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        audioGain = audioCtx.createGain();
        audioGain.gain.value = 0.0;
        audioGain.connect(audioCtx.destination);
    };
    wsAudio.onmessage = (event) => {
        audioBuffer = append(audioBuffer, new Uint8Array(event.data));
        parseAudio();
    };

    ws = new WebSocket('ws://localhost:8080');
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => {
        videoBuffer = append(videoBuffer, new Uint8Array(event.data));
        parseVideo();
    };

    canvas.addEventListener('mousedown', (e) => {
        injectTouch(0, e.clientX, e.clientY);
        canvas.addEventListener('mousemove', (ev) => injectTouch(2, ev.clientX, ev.clientY));
    });
    canvas.addEventListener('mouseup', (e) => {
        injectTouch(1, e.clientX, e.clientY);
    });
}

function injectTouch(action, clientX, clientY) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !decoder || canvas.width === 0) return;

    const rect = canvas.getBoundingClientRect();
    const cRatio = rect.width / rect.height;
    const vRatio = canvas.width / canvas.height;
    let rw, rh, ox, oy;
    if (cRatio > vRatio) { rh = rect.height; rw = rh * vRatio; ox = (rect.width - rw) / 2; oy = 0; }
    else { rw = rect.width; rh = rw / vRatio; ox = 0; oy = (rect.height - rh) / 2; }
    if (rw === 0 || rh === 0) return;

    const x = (clientX - rect.left - ox) * (canvas.width / rw);
    const y = (clientY - rect.top - oy) * (canvas.height / rh);

    const buffer = new ArrayBuffer(32);
    const view = new DataView(buffer);
    view.setUint8(0, 2); view.setUint8(1, action);
    view.setBigUint64(2, -1n);
    view.setUint32(10, Math.round(x), false); view.setUint32(14, Math.round(y), false);
    view.setUint16(18, canvas.width, false); view.setUint16(20, canvas.height, false);
    view.setUint16(22, 0xffff, false);

    let ab = 0, b = 0;
    if (action === 0) { ab = 1; b = 1; }
    else if (action === 1) { ab = 1; b = 0; }
    else if (action === 2) { ab = 0; b = 1; }
    view.setUint32(24, ab, false); view.setUint32(28, b, false);
    ws.send(buffer);
}

function injectKeycode(k) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const s = (a) => {
        const b = new ArrayBuffer(14), v = new DataView(b);
        v.setUint8(0, 0); v.setUint8(1, a); v.setUint32(2, k, false);
        ws.send(b);
    };
    s(0); setTimeout(() => s(1), 50);
}

function injectClipboardPaste(text) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);

    const len = 1 + 8 + 1 + 4 + bytes.length;
    const buffer = new ArrayBuffer(len);
    const view = new DataView(buffer);

    clipboardSequence++;

    view.setUint8(0, 9);
    view.setBigUint64(1, BigInt(clipboardSequence));
    view.setUint8(9, 1);
    view.setUint32(10, bytes.length, false);
    new Uint8Array(buffer, 14).set(bytes);

    ws.send(buffer);
}

start();
