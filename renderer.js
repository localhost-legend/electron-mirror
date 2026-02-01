const { ipcRenderer } = window.require('electron');
const KeyMapperModule = window.require('./keymapper.js');

const canvas = document.getElementById('videoCanvas');
const ctx = canvas.getContext('2d');

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
            if (status) {
                status.textContent = "Rendering...";
                setTimeout(() => status.style.display = 'none', 100);
            }

            // Hide Loading Overlay
            const loader = document.getElementById('loading-overlay');
            if (loader) {
                loader.style.opacity = '0';
                setTimeout(() => loader.style.display = 'none', 500);
            }

            if (firstFrame || canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                canvas.width = frame.displayWidth;
                canvas.height = frame.displayHeight;
                ipcRenderer.send('set-aspect-ratio', frame.displayWidth, frame.displayHeight);
                firstFrame = false;
            }
            ctx.drawImage(frame, 0, 0);
            frame.close();
        },
        error: (e) => {
            console.error("Decoder Error:", e);
            const status = document.getElementById('status');
            if (status) {
                status.style.display = 'block';
                status.style.color = 'red';
                status.textContent = `Decoder Error: ${e.message}`;
            }
        }
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

        // Conditional Reconfiguration Logic
        // 1. MuMu sends a non-standard config (possibly raw Annex B or just incompatible).
        //    For MuMu, we MUST NOT reconfigure. The initial 'avc1.42001E' works fine.
        // 2. BlueStacks sends a standard AVCC config (starts with 0x01).
        //    For BlueStacks, we MUST reconfigure because it's usually High Profile.

        if (payload.length >= 4 && payload[0] === 0x01) { // Standard AVCC signature
            try {
                const profile = payload[1].toString(16).padStart(2, '0');
                const compat = payload[2].toString(16).padStart(2, '0');
                const level = payload[3].toString(16).padStart(2, '0');
                const codec = `avc1.${profile}${compat}${level}`;

                console.log(`[Video] Standard AVCC Detected. Reconfiguring decoder to: ${codec}`);

                if (decoder.state !== 'closed') {
                    decoder.configure({
                        codec: codec,
                        description: payload,
                        optimizeForLatency: true
                    });
                }
            } catch (e) {
                console.error("[Video] AVCC Reconfig Error:", e);
                // Fallback: If strict parsing fails, do nothing and hope initial config works.
            }
        } else {
            // Non-standard header (MuMu). 
            // Do NOT touch the decoder. Maintain the initial 'avc1.42001E' state.
            console.log("[Video] Non-standard config (MuMu?). Skipping reconfiguration.");
        }
    } else {
        let dataToFeed = payload;
        const naluType = payload[4] & 0x1f;
        const type = (isKeyFrame || naluType === 5) ? 'key' : 'delta';

        if (type === 'key' && vPendingConfig) {
            // For some streams, we might need to prepend config.
            // But for MuMu, it seems just feeding the keyframe is fine (or the config is implied).
            // We'll trust the flow that worked before.
            dataToFeed = append(vPendingConfig, payload);
            // Keep vPendingConfig for future resets
        }

        try {
            if (decoder.state === 'configured') decoder.decode(new EncodedVideoChunk({
                type,
                timestamp: Number(rawPTS),
                data: dataToFeed
            }));
        } catch (e) {
            console.error("[Video] Decode error:", e);
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

    // --- Global UI State & Selectors ---
    const imeBar = document.getElementById('ime-bar');
    const imeInput = document.getElementById('ime-input');
    const btnKeyboard = document.getElementById('btn-keyboard');
    const btnSend = document.getElementById('btn-send');
    let isKeyboardOpen = false;

    // Debug Logs from Backend
    ipcRenderer.on('server-log', (event, msg) => {
        console.log("[Backend]", msg);
        const status = document.getElementById('status');
        if (status && status.style.display !== 'none') {
            status.innerHTML += `<br/><span style="font-size:12px; color:#aaa">${msg}</span>`;
        }
    });

    // Connection Failsafe (from Launcher)
    ipcRenderer.on('connection-failed', (event, err) => {
        alert("Connection Failed: " + err);
        window.close();
    });

    // Key Mapper Init
    const KeyMapper = KeyMapperModule?.default || KeyMapperModule?.KeyMapper || KeyMapperModule;
    const mapper = new KeyMapper(canvas, ws);
    mapper.onInject = (action, xP, yP) => {
        injectTouchNormalized(action, xP, yP);
    };

    const btnMapper = document.getElementById('btn-mapper');
    if (btnMapper) {
        btnMapper.onclick = () => {
            mapper.toggleEditMode();
            btnMapper.classList.toggle('active');
        };
    }

    // Global Key Listener
    window.addEventListener('keydown', (e) => {
        if (!isKeyboardOpen) mapper.handleKeyDown(e);
        resumeAudio();
    });
    window.addEventListener('keyup', (e) => {
        if (!isKeyboardOpen) mapper.handleKeyUp(e);
    });

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

    // Return to Overview
    const btnReturnOverview = document.getElementById('btn-return-overview');
    if (btnReturnOverview) {
        btnReturnOverview.onclick = () => {
            ipcRenderer.send('return-to-overview');
        };
    }

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
    ws.onopen = () => {
        console.log("Connected to WS");
        const status = document.getElementById('status');
        if (status) status.textContent = "Server Connected. Waiting for Video Stream...";
    };

    ws.onmessage = async (event) => {
        const data = new Uint8Array(await event.data.arrayBuffer());

        // Update Status only if still visible
        const status = document.getElementById('status');
        if (status && status.style.display !== 'none') {
            status.textContent = `Receiving Video... (${videoBuffer.length + data.length} bytes buffered)`;
        }

        // Protocol Parsing
        videoBuffer = append(videoBuffer, data);
        parseVideo();
    };

    // Proper Mouse Events with Cleanup
    const onMouseMove = (ev) => injectTouch(2, ev.clientX, ev.clientY);
    const onMouseUp = (ev) => {
        injectTouch(1, ev.clientX, ev.clientY);
        canvas.removeEventListener('mousemove', onMouseMove);
        canvas.removeEventListener('mouseup', onMouseUp);
        canvas.removeEventListener('mouseleave', onMouseUp);
    };

    canvas.addEventListener('mousedown', (e) => {
        injectTouch(0, e.clientX, e.clientY);
        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('mouseleave', onMouseUp);
    });

    // Loading Failsafe: Remove overlay after 10s if video never starts
    setTimeout(() => {
        const loader = document.getElementById('loading-overlay');
        if (loader && loader.style.opacity !== '0') {
            loader.style.opacity = '0';
            setTimeout(() => loader.style.display = 'none', 500);
            console.warn("Loading overlay force-hidden after timeout");
        }
    }, 10000);
}

function injectTouchNormalized(action, xP, yP, pointerId = -1n) {
    if (!ws || ws.readyState !== WebSocket.OPEN || canvas.width === 0) return;

    // Scrcpy Protocol:
    // type(1) | action(1) | pointerId(8) | x(4) | y(4) | w(2) | h(2) | pressure(2) | buttons(4)

    const w = canvas.width;
    const h = canvas.height;

    const buffer = new ArrayBuffer(32);
    const view = new DataView(buffer);
    view.setUint8(0, 2); // Type: INJECT_TOUCH_EVENT
    view.setUint8(1, action);
    view.setBigUint64(2, BigInt(pointerId)); // Support multi-touch
    view.setUint32(10, Math.round(xP * w), false);
    view.setUint32(14, Math.round(yP * h), false);
    view.setUint16(18, w, false);
    view.setUint16(20, h, false);
    view.setUint16(22, 0xffff, false); // Pressure

    let ab = 0, b = 0; // Buttons (Primary)
    if (action === 0 || action === 2) { ab = 1; b = 1; } // Down or Move
    view.setUint32(24, ab, false); view.setUint32(28, b, false);
    ws.send(buffer);
}

function injectTouch(action, clientX, clientY) {
    if (!ws || ws.readyState !== WebSocket.OPEN || canvas.width === 0) return;

    const rect = canvas.getBoundingClientRect();
    const videoAspect = canvas.width / canvas.height;
    const rectAspect = rect.width / rect.height;

    let renderW, renderH, offsetX, offsetY;

    if (rectAspect > videoAspect) {
        // Pillarbox (black bars on sides)
        renderH = rect.height;
        renderW = renderH * videoAspect;
        offsetX = (rect.width - renderW) / 2;
        offsetY = 0;
    } else {
        // Letterbox (black bars on top/bottom)
        renderW = rect.width;
        renderH = renderW / videoAspect;
        offsetX = 0;
        offsetY = (rect.height - renderH) / 2;
    }

    // Map client coordinates to video coordinates
    const x = (clientX - rect.left - offsetX) * (canvas.width / renderW);
    const y = (clientY - rect.top - offsetY) * (canvas.height / renderH);

    // Ignore clicks outside the video area
    if (x < 0 || x > canvas.width || y < 0 || y > canvas.height) return;

    const buffer = new ArrayBuffer(32);
    const view = new DataView(buffer);
    view.setUint8(0, 2); view.setUint8(1, action);
    view.setBigUint64(2, -1n); // PointerID -1 for mouse
    view.setUint32(10, Math.round(x), false); view.setUint32(14, Math.round(y), false);
    view.setUint16(18, canvas.width, false); view.setUint16(20, canvas.height, false);
    view.setUint16(22, 0xffff, false);

    let ab = 0, b = 0;
    if (action === 0) { ab = 1; b = 1; } // Down
    else if (action === 1) { ab = 1; b = 0; } // Up
    else if (action === 2) { ab = 0; b = 1; } // Move
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

// --- Unified Sidebar Logic ---
const sidebar = document.getElementById('sidebar');
const sidebarTrigger = document.getElementById('sidebar-trigger');
const btnPin = document.getElementById('btn-pin');

const SidebarMode = {
    PINNED: 'pinned',     // Always visible, pushes content
    FLOATING: 'floating'  // Auto-hide, overlays content on hover
};

let currentSidebarMode = SidebarMode.PINNED;
let isFullscreen = false;

function setSidebarMode(mode) {
    currentSidebarMode = mode;

    // Clear state classes
    sidebar.classList.remove('pinned', 'floating', 'revealed');

    if (mode === SidebarMode.PINNED) {
        sidebar.classList.add('pinned');
        if (btnPin) {
            btnPin.classList.add('active');
            btnPin.title = "切換為自動隱藏 (懸浮)";
        }
    } else {
        sidebar.classList.add('floating');
        if (btnPin) {
            btnPin.classList.remove('active');
            btnPin.title = "切換為常駐顯示 (釘選)";
        }
    }
}

// Hover Detection (Trigger Reveal)
if (sidebarTrigger) {
    sidebarTrigger.addEventListener('mouseenter', () => {
        if (currentSidebarMode === SidebarMode.FLOATING) {
            sidebar.classList.add('revealed');
        }
    });
}

// Hide when leaving sidebar area
if (sidebar) {
    sidebar.addEventListener('mouseleave', () => {
        if (currentSidebarMode === SidebarMode.FLOATING) {
            sidebar.classList.remove('revealed');
        }
    });
}

// Pin/Unpin Toggle (Unified Control)
if (btnPin) {
    btnPin.addEventListener('click', (e) => {
        e.stopPropagation();
        const nextMode = (currentSidebarMode === SidebarMode.PINNED) ? SidebarMode.FLOATING : SidebarMode.PINNED;
        setSidebarMode(nextMode);
    });
}

// Fullscreen adaptation (Optional: could force floating in FS, but let's trust user preference)
ipcRenderer.on('fullscreen-change', (event, full) => {
    isFullscreen = full;
    // UI can adapt here if needed, but current unified logic handles both window/FS
});

// Initialize
setSidebarMode(SidebarMode.PINNED);

start();
