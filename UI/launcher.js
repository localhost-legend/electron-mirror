const { ipcRenderer } = window.require('electron');

const IPC_TIMEOUT_MS = 7000;

function invokeWithTimeout(channel, ...args) {
    if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') {
        return Promise.reject(new Error('ipcRenderer 不可用，請確認 Renderer 權限與設定'));
    }
    return Promise.race([
        ipcRenderer.invoke(channel, ...args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('IPC 請求逾時，可能主程序未回應')), IPC_TIMEOUT_MS))
    ]);
}

let isDownloadingScrcpy = false;
let isAdbReady = false;
let contextDevice = null;
let contextMenu = null;

contextMenu = document.getElementById('device-context-menu');
if (contextMenu) {
    contextMenu.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    contextMenu.addEventListener('click', async (e) => {
        const item = e.target.closest('.context-item');
        if (!item) return;
        e.stopPropagation();
        const action = item.getAttribute('data-action');
        await handleContextAction(action);
    });
}

function closeContextMenu() {
    if (contextMenu) contextMenu.classList.remove('open');
    contextDevice = null;
}

function openContextMenu(x, y, device) {
    if (!contextMenu) return;
    contextDevice = device;
    contextMenu.classList.add('open');

    const { innerWidth, innerHeight } = window;
    const menuRect = contextMenu.getBoundingClientRect();
    const menuWidth = menuRect.width || 160;
    const menuHeight = menuRect.height || 80;

    const left = Math.min(x, innerWidth - menuWidth - 8);
    const top = Math.min(y, innerHeight - menuHeight - 8);

    contextMenu.style.left = `${Math.max(8, left)}px`;
    contextMenu.style.top = `${Math.max(8, top)}px`;
}

async function loadDevices() {
    
    const list = document.getElementById('deviceList');
    if (!list) {
        console.error('deviceList element not found');
        return;
    }

    if (isDownloadingScrcpy) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="spinner" style="margin: auto;"></div>
                <p style="margin-top: 16px;">正在下載 scrcpy...</p>
                <p style="font-size: 12px; margin-top: 8px;">下載完成後會自動重新載入裝置清單</p>
            </div>
        `;
        return;
    }

    if (!isAdbReady) {
        list.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" style="fill: #f39c12;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                <p style="color: #f39c12;">ADB 尚未就緒</p>
                <p style="font-size: 12px; margin-top: 8px;">請等待 scrcpy 下載完成或確認 ADB 已安裝</p>
            </div>
        `;
        return;
    } else {
        list.innerHTML = `
        <div class="empty-state">
            <div class="spinner" style="margin: auto;"></div>
            <p style="margin-top: 16px;">正在搜尋裝置...</p>
        </div>
    `;

        try {
            console.log('Fetching devices from main process...');
            const devices = await invokeWithTimeout('get-devices');
            console.log('Devices:', devices);

            if (devices.length === 0) {
                list.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 24 24"><path d="M15.5 1h-8C6.12 1 5 2.12 5 3.5v17C5 21.88 6.12 23 7.5 23h8c1.38 0 2.5-1.12 2.5-2.5v-17C18 2.12 16.88 1 15.5 1zm-4 21c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4.5-4H7V4h9v14z"/></svg>
                    <p>沒有找到裝置</p>
                    <p style="font-size: 12px; margin-top: 8px;">請確認 ADB 已連接並授權</p>
                </div>
            `;
                return;
            }

            list.innerHTML = devices.map(device => `
            <div class="device-card" data-serial="${device.id}" data-alias="${encodeURIComponent(device.alias || '')}" data-model="${encodeURIComponent(device.model || '')}">
                <div class="device-icon">
                    <svg viewBox="0 0 24 24"><path d="M15.5 1h-8C6.12 1 5 2.12 5 3.5v17C5 21.88 6.12 23 7.5 23h8c1.38 0 2.5-1.12 2.5-2.5v-17C18 2.12 16.88 1 15.5 1zm-4 21c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4.5-4H7V4h9v14z"/></svg>
                </div>
                <div class="device-info">
                    <div class="device-name">${device.alias || device.model}</div>
                    <div class="device-serial">${device.id}</div>
                </div>
                <div class="device-arrow">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>
                </div>
            </div>
        `).join('');

            list.querySelectorAll('.device-card').forEach(card => {
                card.addEventListener('click', () => {
                    const serial = card.dataset.serial;
                    const alias = decodeURIComponent(card.dataset.alias || '');
                    const model = decodeURIComponent(card.dataset.model || '');
                    connectDevice({ serial, alias: alias || null, model: model || null });
                    card.classList.add('connecting');
                });
                card.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    const serial = card.dataset.serial;
                    const alias = decodeURIComponent(card.dataset.alias || '');
                    const model = decodeURIComponent(card.dataset.model || '');
                    openContextMenu(e.clientX, e.clientY, { serial, alias, model });
                });
            });
        } catch (e) {
            const message = e?.message || '';
            if (message === 'SCRCPY_DOWNLOADING' || message === 'ADB_NOT_READY') {
                await refreshScrcpyStatus();
                loadDevices();
                return;
            }
            return;
        }
    }
}

async function refreshScrcpyStatus() {
    try {
        const status = await invokeWithTimeout('get-scrcpy-status');
        isDownloadingScrcpy = !!status?.isScrcpyDownloading;
        isAdbReady = !!status?.isAdbReady;
    } catch (e) {
    }
}

async function connectDevice(device) {
    const payload = typeof device === 'string' ? { serial: device } : device;
    // Just send event - Launcher stays open, no need to change UI
    ipcRenderer.send('connect-device', payload);
}

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 3000);
}

ipcRenderer.on('connection-failed', (event, error) => {
    showToast(`連線失敗：${error}`);
    loadDevices(); // Reload to reset UI
});

ipcRenderer.on('devices-changed', () => {
    loadDevices();
});

ipcRenderer.on('scrcpy-download-start', () => {
    isDownloadingScrcpy = true;
    isAdbReady = false;
    loadDevices();
});

ipcRenderer.on('scrcpy-download-complete', () => {
    isDownloadingScrcpy = false;
    isAdbReady = true;
    loadDevices();
});

ipcRenderer.on('scrcpy-download-failed', (event, message) => {
    isDownloadingScrcpy = false;
    isAdbReady = false;
    const list = document.getElementById('deviceList');
    if (!list) {
        return;
    }
    list.innerHTML = `
        <div class="empty-state">
            <svg viewBox="0 0 24 24" style="fill: #e74c3c;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
            <p style="color: #e74c3c;">下載 scrcpy 失敗</p>
            <p style="font-size: 12px; margin-top: 8px;">${message || '未知錯誤'}</p>
        </div>
    `;
});

ipcRenderer.on('scrcpy-status-changed', (event, status) => {
    isDownloadingScrcpy = !!status?.isScrcpyDownloading;
    isAdbReady = !!status?.isAdbReady;
    loadDevices();
});

// Expose for inline button handler
window.loadDevices = loadDevices;

document.addEventListener('click', (e) => {
    if (!contextMenu || !contextMenu.classList.contains('open')) return;
    if (contextMenu.contains(e.target)) return;
    closeContextMenu();
});

window.addEventListener('resize', () => closeContextMenu());

async function handleContextAction(action) {
    if (!contextDevice) return;
    if (action === 'rename') {
        startInlineRename(contextDevice.serial, contextDevice.alias || '');
    } else if (action === 'settings') {
        ipcRenderer.send('open-device-settings', { serial: contextDevice.serial });
    }
    closeContextMenu();
}

function startInlineRename(serial, currentAlias) {
    const esc = window.CSS && CSS.escape ? CSS.escape(serial) : serial.replace(/["\\]/g, '\\$&');
    const card = document.querySelector(`.device-card[data-serial="${esc}"]`);
    if (!card) return;
    const nameEl = card.querySelector('.device-name');
    if (!nameEl) return;

    // Prevent accidental connect while renaming
    card.classList.add('renaming');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'device-rename-input';
    input.value = currentAlias || nameEl.textContent || '';

    const commit = async () => {
        const next = input.value.trim();
        await ipcRenderer.invoke('set-device-alias', serial, next);
        ipcRenderer.send('refresh-device-list');
        loadDevices();
    };

    const cancel = () => {
        loadDevices();
    };

    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });
    input.addEventListener('blur', () => commit());

    nameEl.replaceWith(input);
    setTimeout(() => {
        input.focus();
        input.select();
    }, 0);
}

// Initial load
window.addEventListener('DOMContentLoaded', () => {
    refreshScrcpyStatus().finally(() => loadDevices());
});
