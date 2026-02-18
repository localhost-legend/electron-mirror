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
let launcherMenu = null;
let launcherMenuButton = null;
let hiddenListEl = null;
let addDeviceForm = null;
let addDeviceInput = null;
let toggleStats = null;
let hiddenBackButton = null;

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

launcherMenu = document.getElementById('launcher-menu');
launcherMenuButton = document.getElementById('launcher-menu-button');
hiddenListEl = document.getElementById('hidden-device-list');
addDeviceForm = document.getElementById('add-device-form');
addDeviceInput = document.getElementById('add-device-input');
toggleStats = document.getElementById('toggle-stats');
hiddenBackButton = document.getElementById('hidden-back');

if (launcherMenuButton) {
    launcherMenuButton.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!launcherMenu) return;
        if (launcherMenu.classList.contains('open')) {
            closeLauncherMenu();
        } else {
            openLauncherMenu();
        }
    });
}

if (launcherMenu) {
    launcherMenu.addEventListener('click', async (e) => {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        e.stopPropagation();
        const action = item.getAttribute('data-action');
        const serial = item.getAttribute('data-serial');
        await handleLauncherMenuAction(action, serial);
    });
}

if (toggleStats) {
    toggleStats.addEventListener('change', async () => {
        await ipcRenderer.invoke('set-debug-stats', toggleStats.checked);
    });
}

if (addDeviceInput) {
    addDeviceInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            await handleLauncherMenuAction('confirm-add');
        } else if (e.key === 'Escape') {
            e.preventDefault();
            await handleLauncherMenuAction('cancel-add');
        }
    });
}

function closeContextMenu() {
    if (contextMenu) contextMenu.classList.remove('open');
    contextDevice = null;
}

function closeLauncherMenu() {
    if (launcherMenu) {
        launcherMenu.classList.remove('open');
        launcherMenu.classList.remove('add-device-only');
        launcherMenu.classList.remove('hidden-only');
        launcherMenu.classList.remove('no-scroll');
    }
    if (addDeviceForm) addDeviceForm.classList.add('hidden');
    if (hiddenListEl) hiddenListEl.classList.add('hidden');
    if (hiddenBackButton) hiddenBackButton.classList.add('hidden');
}

function updateLauncherMenuLayout() {
    if (!launcherMenu || !launcherMenuButton) return;
    if (!launcherMenu.classList.contains('open')) return;

    const maxHeight = Math.max(120, window.innerHeight - 16);
    launcherMenu.style.maxHeight = `${maxHeight}px`;
    launcherMenu.style.height = 'auto';
    launcherMenu.style.overflowY = 'auto';

    const rect = launcherMenuButton.getBoundingClientRect();
    const menuRect = launcherMenu.getBoundingClientRect();
    const menuWidth = menuRect.width || 240;
    const menuHeight = Math.min(launcherMenu.scrollHeight, maxHeight);
    launcherMenu.style.height = `${menuHeight}px`;

    const needsScroll = launcherMenu.scrollHeight > menuHeight + 1;
    launcherMenu.classList.toggle('no-scroll', !needsScroll);
    launcherMenu.style.overflowY = needsScroll ? 'auto' : 'hidden';

    const left = Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8);
    const spaceAbove = rect.top - 8;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const preferDown = spaceBelow >= menuHeight || spaceBelow >= spaceAbove;
    const top = preferDown
        ? Math.min(rect.bottom + 8, window.innerHeight - menuHeight - 8)
        : Math.max(8, rect.top - menuHeight - 8);
    launcherMenu.style.left = `${Math.max(8, left)}px`;
    launcherMenu.style.top = `${Math.max(8, top)}px`;
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

function openLauncherMenu() {
    if (!launcherMenu || !launcherMenuButton) return;
    launcherMenu.classList.remove('add-device-only');
    launcherMenu.classList.remove('hidden-only');
    launcherMenu.classList.add('open');
    updateLauncherMenuLayout();

    refreshHiddenList();
    refreshDebugOptions();
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

async function refreshDebugOptions() {
    if (!toggleStats) return;
    try {
        const options = await ipcRenderer.invoke('get-debug-options');
        toggleStats.checked = !!options?.statsEnabled;
    } catch (e) {
        toggleStats.checked = false;
    }
}

async function refreshHiddenList() {
    if (!hiddenListEl) return;
    try {
        const showHiddenMode = launcherMenu && launcherMenu.classList.contains('hidden-only');
        const hidden = await ipcRenderer.invoke('get-hidden-devices');
        const header = `<div class="menu-sublist-title">復原隱藏的裝置</div>`;
        if (!hidden || hidden.length === 0) {
            hiddenListEl.innerHTML = `${header}<div class="menu-empty">沒有隱藏裝置</div>`;
            if (hiddenBackButton) {
                hiddenBackButton.classList.toggle('hidden', !showHiddenMode);
            }
            updateLauncherMenuLayout();
            return;
        }
        hiddenListEl.innerHTML = header + hidden.map((entry) => {
            const label = entry.alias || entry.model || entry.serial;
            const serialAttr = encodeURIComponent(entry.serial);
            return `<button class="menu-item" data-action="restore-hidden" data-serial="${serialAttr}">${label}</button>`;
        }).join('');
        if (hiddenBackButton) {
            hiddenBackButton.classList.toggle('hidden', !showHiddenMode);
        }
        updateLauncherMenuLayout();
    } catch (e) {
        hiddenListEl.innerHTML = `<div class="menu-sublist-title">復原隱藏的裝置</div><div class="menu-empty">讀取失敗</div>`;
        if (hiddenBackButton) {
            const showHiddenMode = launcherMenu && launcherMenu.classList.contains('hidden-only');
            hiddenBackButton.classList.toggle('hidden', !showHiddenMode);
        }
        updateLauncherMenuLayout();
    }
}

async function handleLauncherMenuAction(action, serial) {
    if (action === 'add-device') {
        if (launcherMenu) {
            launcherMenu.classList.add('add-device-only');
            launcherMenu.classList.remove('hidden-only');
        }
        if (addDeviceForm) addDeviceForm.classList.remove('hidden');
        if (addDeviceInput) {
            addDeviceInput.focus();
            addDeviceInput.select();
        }
        updateLauncherMenuLayout();
        return;
    }
    if (action === 'confirm-add') {
        const target = addDeviceInput ? addDeviceInput.value.trim() : '';
        if (!target) {
            showToast('請輸入裝置位址');
            return;
        }
        const result = await ipcRenderer.invoke('adb-connect', target);
        showToast(result?.message || (result?.ok ? '連線完成' : '連線失敗'));
        if (result?.ok && addDeviceInput) {
            addDeviceInput.value = '';
            addDeviceInput.focus();
        }
        if (result?.ok) loadDevices();
        return;
    }
    if (action === 'cancel-add') {
        if (launcherMenu) launcherMenu.classList.remove('add-device-only');
        if (addDeviceForm) addDeviceForm.classList.add('hidden');
        updateLauncherMenuLayout();
        return;
    }
    if (action === 'toggle-hidden') {
        if (launcherMenu) {
            launcherMenu.classList.add('hidden-only');
            launcherMenu.classList.remove('add-device-only');
        }
        if (hiddenListEl) hiddenListEl.classList.remove('hidden');
        if (hiddenBackButton) hiddenBackButton.classList.remove('hidden');
        refreshHiddenList();
        updateLauncherMenuLayout();
        return;
    }
    if (action === 'back-hidden') {
        if (launcherMenu) launcherMenu.classList.remove('hidden-only');
        if (hiddenListEl) hiddenListEl.classList.add('hidden');
        if (hiddenBackButton) hiddenBackButton.classList.add('hidden');
        updateLauncherMenuLayout();
        return;
    }
    if (action === 'restore-hidden' && serial) {
        const resolvedSerial = decodeURIComponent(serial);
        await ipcRenderer.invoke('set-device-hidden', resolvedSerial, false);
        refreshHiddenList();
        loadDevices();
        return;
    }
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
    if (contextMenu && contextMenu.classList.contains('open')) {
        if (!contextMenu.contains(e.target)) {
            closeContextMenu();
        }
    }
    if (launcherMenu && launcherMenu.classList.contains('open')) {
        if (!launcherMenu.contains(e.target) && e.target !== launcherMenuButton) {
            closeLauncherMenu();
        }
    }
});

window.addEventListener('resize', () => {
    closeContextMenu();
    closeLauncherMenu();
});

async function handleContextAction(action) {
    if (!contextDevice) return;
    if (action === 'rename') {
        startInlineRename(contextDevice.serial, contextDevice.alias || '');
    } else if (action === 'settings') {
        ipcRenderer.send('open-device-settings', { serial: contextDevice.serial });
    } else if (action === 'hide') {
        await ipcRenderer.invoke('set-device-hidden', contextDevice.serial, true);
        ipcRenderer.send('refresh-device-list');
        loadDevices();
    } else if (action === 'disconnect') {
        const result = await ipcRenderer.invoke('adb-disconnect', contextDevice.serial);
        showToast(result?.message || (result?.ok ? '已斷線' : '斷線失敗'));
        loadDevices();
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
    refreshDebugOptions();
});
