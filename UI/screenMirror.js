const { ipcRenderer } = window.require('electron');
const path = window.require('path');
const KeyMapperModule = window.require(path.join(__dirname, '..', 'main', 'keymapper.js'));

const canvas = document.getElementById('videoCanvas');
const ctx = canvas.getContext('2d');

let decoder = null;
let audioCtx = null;
let audioGain = null;
let audioStartTime = 0;
let decodedFrames = 0;
let lastFpsTime = performance.now();

// FAILSAFE: Drop initial packets
let audioDropCounter = 5;

let vPendingConfig = null;

function append(buffer, newData) {
    const newBuf = new Uint8Array(buffer.length + newData.length);
    newBuf.set(buffer, 0);
    newBuf.set(newData, buffer.length);
    return newBuf;
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
                if (firstFrame) {
                    markStreamReady();
                }
                firstFrame = false;
            }
            ctx.drawImage(frame, 0, 0);
            decodedFrames += 1;
            const now = performance.now();
            if (now - lastFpsTime >= 1000) {
                const fps = Math.round((decodedFrames * 1000) / (now - lastFpsTime));
                ipcRenderer.send('scrcpy-client-stats', { decodedFps: fps });
                decodedFrames = 0;
                lastFpsTime = now;
            }
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
            // BUT WHO IS MUMU???????????????
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
    const imeBar = document.getElementById('ime-container');
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

    // Key Mapper Init (guarded so video can still work if mapping fails)
    let mapper = null;
    try {
        const KeyMapper = KeyMapperModule?.default || KeyMapperModule?.KeyMapper || KeyMapperModule;
        if (KeyMapper) {
            mapper = new KeyMapper(canvas, null);
            mapper.onInject = (action, xP, yP) => {
                injectTouchNormalized(action, xP, yP);
            };
        }
    } catch (e) {
        console.error('[KeyMapper] init failed:', e);
        mapper = null;
    }

    const btnMapper = document.getElementById('btn-mapper');
    if (btnMapper) {
        btnMapper.onclick = () => {
            if (!mapper) return;
            mapper.toggleEditMode();
            btnMapper.classList.toggle('active');
        };
    }

    // Global Key Listener
    window.addEventListener('keydown', (e) => {
        if (!isKeyboardOpen && mapper) mapper.handleKeyDown(e);
        resumeAudio();
    });
    window.addEventListener('keyup', (e) => {
        if (!isKeyboardOpen && mapper) mapper.handleKeyUp(e);
    });

    // Keyboard Logic
    const toggleKeyboard = () => {
        if (!imeBar || !btnKeyboard || !imeInput) return;
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

    const btnDeviceSettings = document.getElementById('btn-device-settings');
    if (btnDeviceSettings) {
        btnDeviceSettings.onclick = () => {
            ipcRenderer.send('open-device-settings', {});
        };
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    audioGain = audioCtx.createGain();
    audioGain.gain.value = 0.0;
    audioGain.connect(audioCtx.destination);

    const status = document.getElementById('status');
    if (status) status.textContent = "Server Connected. Waiting for Video Stream...";

    const toUint8 = (payload) => {
        if (!payload) return new Uint8Array(0);
        if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
        if (ArrayBuffer.isView(payload)) {
            return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
        }
        // Electron can serialize Buffer as { type: 'Buffer', data: [] }
        if (payload.type === 'Buffer' && Array.isArray(payload.data)) {
            return new Uint8Array(payload.data);
        }
        if (payload.data && Array.isArray(payload.data)) {
            return new Uint8Array(payload.data);
        }
        return new Uint8Array(0);
    };

    let videoDebugCount = 0;
    ipcRenderer.on('scrcpy-video-packet', (event, packet) => {
        const data = toUint8(packet.data ?? packet);
        if (data.length === 0) return;
        const pts = BigInt(packet.pts || 0);
        if (videoDebugCount < 3) {
            const head = Array.from(data.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log(`[Video] packet len=${data.length} pts=${pts.toString()} head=${head}`);
            videoDebugCount += 1;
        }
        handleVideoPayload(data, pts);
    });

    ipcRenderer.on('scrcpy-audio-packet', (event, packet) => {
        if (audioDropCounter > 0) { audioDropCounter--; return; }
        const data = toUint8(packet.data ?? packet);
        if (data.length === 0) return;
        playPCM(data);
    });

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
    if (canvas.width === 0) return;

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
    ipcRenderer.send('scrcpy-input', {
        type: 'touch',
        action,
        pointerId: pointerId.toString(),
        x: Math.round(xP * w),
        y: Math.round(yP * h),
        width: w,
        height: h,
        buttons: { ab, b }
    });
}

function injectTouch(action, clientX, clientY) {
    if (canvas.width === 0) return;

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

    let ab = 0, b = 0;
    if (action === 0) { ab = 1; b = 1; } // Down
    else if (action === 1) { ab = 1; b = 0; } // Up
    else if (action === 2) { ab = 0; b = 1; } // Move

    ipcRenderer.send('scrcpy-input', {
        type: 'touch',
        action,
        pointerId: '-1',
        x: Math.round(x),
        y: Math.round(y),
        width: canvas.width,
        height: canvas.height,
        buttons: { ab, b }
    });
}

function injectKeycode(k) {
    ipcRenderer.send('scrcpy-input', { type: 'keycode', keycode: k });
}

function injectClipboardPaste(text) {
    ipcRenderer.send('scrcpy-input', { type: 'clipboard', text });
}

// --- Stable Sidebar Logic (No Hover) ---
const app = document.getElementById('app');
const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
const sidebarEdgeTrigger = document.getElementById('sidebar-edge-trigger');
const sidebar = document.getElementById('sidebar');
const btnSidebarMore = document.getElementById('btn-sidebar-more');
const sidebarMoreMenu = document.getElementById('sidebar-more-menu');
const SIDEBAR_WIDTH = 56;

let isStreamReady = false;
let isSidebarOpen = true;
let isSidebarCompact = false;
let hasSidebarHiddenActions = false;
let lastSidebarWidth = -1;

function closeSidebarMoreMenu() {
    if (sidebarMoreMenu) {
        sidebarMoreMenu.classList.remove('open');
    }
}

function openSidebarMoreMenu() {
    if (!app || !btnSidebarMore || !sidebarMoreMenu) return;
    syncSidebarMoreMenuItems();

    sidebarMoreMenu.classList.add('open');
    const appRect = app.getBoundingClientRect();
    const btnRect = btnSidebarMore.getBoundingClientRect();
    const menuRect = sidebarMoreMenu.getBoundingClientRect();

    const gap = 8;
    const minMargin = 8;

    let left = btnRect.left - appRect.left - menuRect.width - gap;
    let top = btnRect.bottom - appRect.top - menuRect.height;

    left = Math.max(minMargin, Math.min(left, appRect.width - menuRect.width - minMargin));
    top = Math.max(minMargin, Math.min(top, appRect.height - menuRect.height - minMargin));

    sidebarMoreMenu.style.left = `${left}px`;
    sidebarMoreMenu.style.top = `${top}px`;
}

function setSidebarCompact(compact) {
    isSidebarCompact = !!compact;
    if (sidebar) {
        sidebar.classList.toggle('compact', isSidebarCompact);
    }
    if (!isSidebarCompact) {
        closeSidebarMoreMenu();
    }
}

function getSidebarOverflowCandidates() {
    if (!sidebar) return [];
    return Array.from(sidebar.querySelectorAll(':scope > .btn:not(#btn-sidebar-toggle):not(#btn-sidebar-more)'));
}

function clearSidebarOverflowHidden() {
    for (const el of getSidebarOverflowCandidates()) {
        el.classList.remove('overflow-hidden');
    }
}

function syncSidebarMoreMenuItems() {
    if (!sidebarMoreMenu) return;
    hasSidebarHiddenActions = false;
    const items = sidebarMoreMenu.querySelectorAll('.sidebar-more-item');
    for (const item of items) {
        const targetId = item.getAttribute('data-target');
        const targetButton = targetId ? document.getElementById(targetId) : null;
        if (!targetButton) {
            item.style.display = 'none';
            continue;
        }
        const isHidden = targetButton.classList.contains('overflow-hidden');
        if (isHidden) hasSidebarHiddenActions = true;
        item.style.display = isHidden ? '' : 'none';
    }
    if (sidebar) {
        sidebar.classList.toggle('has-hidden-actions', hasSidebarHiddenActions);
    }
    if (!hasSidebarHiddenActions) {
        closeSidebarMoreMenu();
    }
}

function updateSidebarCompactMode() {
    if (!sidebar || !isStreamReady || !isSidebarOpen) {
        clearSidebarOverflowHidden();
        setSidebarCompact(false);
        syncSidebarMoreMenuItems();
        return;
    }

    clearSidebarOverflowHidden();
    sidebar.classList.remove('compact');

    if (sidebar.scrollHeight <= sidebar.clientHeight + 1) {
        setSidebarCompact(false);
        syncSidebarMoreMenuItems();
        return;
    }

    setSidebarCompact(true);
    const overflowCandidates = getSidebarOverflowCandidates();
    for (let i = overflowCandidates.length - 1; i >= 0; i--) {
        if (sidebar.scrollHeight <= sidebar.clientHeight + 1) break;
        overflowCandidates[i].classList.add('overflow-hidden');
    }
    syncSidebarMoreMenuItems();
}

function applySidebarState() {
    if (!app) return;

    const effectiveSidebarOpen = isStreamReady && isSidebarOpen;

    app.classList.toggle('stream-ready', isStreamReady);
    app.classList.toggle('sidebar-open', effectiveSidebarOpen);

    if (btnSidebarToggle) {
        btnSidebarToggle.title = effectiveSidebarOpen ? "收合側邊欄" : "展開側邊欄";
        btnSidebarToggle.setAttribute('aria-label', effectiveSidebarOpen ? "收合側邊欄" : "展開側邊欄");
    }

    if (sidebarEdgeTrigger) {
        sidebarEdgeTrigger.title = "展開側邊欄";
        sidebarEdgeTrigger.setAttribute('aria-label', "展開側邊欄");
    }
    if (btnSidebarMore) {
        btnSidebarMore.title = "更多功能";
        btnSidebarMore.setAttribute('aria-label', "更多功能");
    }

    const sidebarWidth = effectiveSidebarOpen ? SIDEBAR_WIDTH : 0;
    if (sidebarWidth !== lastSidebarWidth) {
        lastSidebarWidth = sidebarWidth;
        ipcRenderer.send('resize-window', sidebarWidth);
    }

    if (!effectiveSidebarOpen) {
        clearSidebarOverflowHidden();
        setSidebarCompact(false);
    }

    requestAnimationFrame(updateSidebarCompactMode);
}

function toggleSidebar() {
    isSidebarOpen = !isSidebarOpen;
    applySidebarState();
}

if (btnSidebarToggle) {
    btnSidebarToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSidebar();
    });
}

if (sidebarEdgeTrigger) {
    sidebarEdgeTrigger.addEventListener('click', () => {
        if (isStreamReady && !isSidebarOpen) {
            isSidebarOpen = true;
            applySidebarState();
        }
    });
}

if (btnSidebarMore) {
    btnSidebarMore.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isSidebarCompact || !hasSidebarHiddenActions || !sidebarMoreMenu) return;
        if (sidebarMoreMenu.classList.contains('open')) {
            closeSidebarMoreMenu();
            return;
        }
        openSidebarMoreMenu();
    });
}

if (sidebarMoreMenu) {
    sidebarMoreMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.sidebar-more-item');
        if (!item) return;
        const targetId = item.getAttribute('data-target');
        if (!targetId) return;
        const targetButton = document.getElementById(targetId);
        if (targetButton) targetButton.click();
        closeSidebarMoreMenu();
    });
}

document.addEventListener('click', (e) => {
    if (!sidebarMoreMenu || !sidebarMoreMenu.classList.contains('open')) return;
    if (sidebarMoreMenu.contains(e.target) || (btnSidebarMore && btnSidebarMore.contains(e.target))) return;
    closeSidebarMoreMenu();
});

window.addEventListener('resize', () => {
    if (sidebarMoreMenu && sidebarMoreMenu.classList.contains('open')) {
        openSidebarMoreMenu();
    }
    if (!isStreamReady || !isSidebarOpen) return;
    requestAnimationFrame(updateSidebarCompactMode);
});

function markStreamReady() {
    if (isStreamReady) return;
    isStreamReady = true;
    applySidebarState();
}

applySidebarState();

start().then(() => {
    ipcRenderer.send('scrcpy-renderer-ready');
});
