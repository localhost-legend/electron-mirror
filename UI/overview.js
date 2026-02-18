const { ipcRenderer, shell } = require('electron');

let currentPath = '/sdcard';
let currentAppFilter = 'user';
let currentAppView = 'grid';
let allApps = [];

// Page Navigation
function switchPage(page) {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });
    document.querySelectorAll('.page-section').forEach(section => {
        section.classList.toggle('active', section.id === `page-${page}`);
    });

    // 快速索引只在檔案管理時展開
    const quickPaths = document.getElementById('quickPaths');
    if (page === 'files') {
        quickPaths.classList.add('expanded');
    } else {
        quickPaths.classList.remove('expanded');
    }

    updateQuickPathActive();

    if (page === 'files') loadFiles(currentPath);
    if (page === 'apps') loadApps();
    if (page === 'notifications') loadNotifications();
}

function updateQuickPathActive() {
    document.querySelectorAll('.quick-path').forEach(item => {
        item.classList.toggle('active', item.dataset.path === currentPath);
    });
}

// Overview
async function loadDeviceInfo() {
    const info = await ipcRenderer.invoke('get-device-info');
    if (!info) {
        document.getElementById('overview-content').innerHTML = `
                    <div class="empty-state">無法獲取裝置資訊</div>
                `;
        return;
    }

    const displayName = info.alias || `${info.manufacturer} ${info.model}`;
    document.getElementById('deviceName').textContent = displayName;
    document.getElementById('deviceSerial').textContent = info.serial;

    const batteryClass = info.isCharging ? 'charging' : (info.battery < 20 ? 'low' : '');

    document.getElementById('overview-content').innerHTML = `
                <div class="info-grid">
                    <div class="info-card">
                        <div class="label">製造商 / 型號</div>
                        <div class="value">${info.manufacturer}</div>
                        <div class="sub-value">${info.model}</div>
                    </div>
                    <div class="info-card">
                        <div class="label">Android 版本</div>
                        <div class="value">Android ${info.androidVersion}</div>
                        <div class="sub-value">SDK ${info.sdkVersion}</div>
                    </div>
                    <div class="info-card">
                        <div class="label">網路</div>
                        <div class="value">${info.ssid || '未連接 Wi-Fi'}</div>
                        <div class="sub-value">${info.ipAddress || '--'}</div>
                    </div>
                    <div class="info-card">
                        <div class="label">電池</div>
                        <div class="value">
                            <div class="battery-bar">
                                <div class="battery-fill ${batteryClass}" style="width: ${info.battery || 0}%"></div>
                            </div>
                            ${info.battery || '--'}%${info.isCharging ? ' ⚡' : ''}
                        </div>
                    </div>
                    <div class="info-card">
                        <div class="label">儲存空間</div>
                        <div class="value">${info.storageUsed || '--'} / ${info.storageTotal || '--'} GB</div>
                    </div>
                    <div class="info-card">
                        <div class="label">記憶體</div>
                        <div class="value">${info.memUsed || '--'} / ${info.memTotal || '--'} GB</div>
                    </div>
                </div>
                <div class="feature-card" onclick="startScreenMirror()">
                    <svg viewBox="0 0 24 24"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>
                    <span class="title">開始螢幕鏡像</span>
                </div>
            `;
}

// File Browser
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

function updateBreadcrumb(path) {
    const parts = path.split('/').filter(p => p);
    let html = '<span onclick="navigateTo(\'/\')">/</span>';
    let accumulated = '';
    for (const part of parts) {
        accumulated += '/' + part;
        const p = accumulated;
        html += `<span class="sep">/</span><span onclick="navigateTo('${p}')">${part}</span>`;
    }
    document.getElementById('breadcrumb').innerHTML = html;
}

async function loadFiles(path) {
    currentPath = path;
    updateBreadcrumb(path);
    updateQuickPathActive();
    document.getElementById('file-content').innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    const files = await ipcRenderer.invoke('list-files', path);

    if (files.length === 0) {
        document.getElementById('file-content').innerHTML = '<div class="empty-state">資料夾為空</div>';
        return;
    }

    files.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return b.isDirectory - a.isDirectory;
        return a.name.localeCompare(b.name);
    });

    document.getElementById('file-content').innerHTML = files.map(f => `
                <div class="file-item" ondblclick="${f.isDirectory ? `navigateTo('${f.path}')` : `downloadFile('${f.path}')`}">
                    <svg viewBox="0 0 24 24">
                        ${f.isDirectory
            ? '<path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>'
            : '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/>'}
                    </svg>
                    <span class="name">${f.name}</span>
                    <span class="size">${f.isDirectory ? '' : formatSize(f.size)}</span>
                    <div class="actions">
                        ${!f.isDirectory ? `
                            <button onclick="event.stopPropagation(); downloadFile('${f.path}')" title="下載">
                                <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                            </button>
                        ` : ''}
                        <button onclick="event.stopPropagation(); deleteFile('${f.path}')" title="刪除">
                            <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                        </button>
                    </div>
                </div>
            `).join('');
}

function navigateTo(path) {
    loadFiles(path);
}

async function downloadFile(path) {
    const result = await ipcRenderer.invoke('pull-file', path);
    if (result) showToast('檔案已儲存: ' + result.split('/').pop());
}

async function uploadFile() {
    const result = await ipcRenderer.invoke('push-file', currentPath);
    if (result) {
        showToast('檔案已上傳');
        loadFiles(currentPath);
    }
}

async function deleteFile(path) {
    if (!confirm('確定要刪除 ' + path.split('/').pop() + '?')) return;
    const result = await ipcRenderer.invoke('delete-file', path);
    if (result) {
        showToast('已刪除');
        loadFiles(currentPath);
    }
}

function copyPath() {
    clipboard.writeText(currentPath);
    showToast('已複製: ' + currentPath);
}

function showGotoModal() {
    document.getElementById('gotoPath').value = currentPath;
    document.getElementById('gotoModal').classList.add('active');
    document.getElementById('gotoPath').focus();
}

function closeGotoModal() {
    document.getElementById('gotoModal').classList.remove('active');
}

function gotoPath() {
    const path = document.getElementById('gotoPath').value.trim();
    if (path) {
        navigateTo(path);
        closeGotoModal();
    }
}

// App Manager
function getGradientClass(pkg) {
    const hash = pkg.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return 'gradient-' + ((hash % 6) + 1);
}

async function loadApps() {
    document.getElementById('app-content').innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    allApps = await ipcRenderer.invoke('list-apps', currentAppFilter);
    renderApps();
}

function renderApps() {
    const searchTerm = document.getElementById('appSearch').value.toLowerCase();
    const filtered = allApps.filter(app =>
        app.name.toLowerCase().includes(searchTerm) ||
        app.package.toLowerCase().includes(searchTerm)
    );

    if (filtered.length === 0) {
        document.getElementById('app-content').innerHTML = '<div class="empty-state">沒有找到應用</div>';
        return;
    }

    const container = document.getElementById('app-content');
    container.className = currentAppView === 'list' ? 'app-grid list-view' : 'app-grid';

    container.innerHTML = filtered.map(app => `
                <div class="app-item">
                    <div class="app-header">
                        <div class="icon ${getGradientClass(app.package)}">
                            <svg viewBox="0 0 24 24"><path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/></svg>
                        </div>
                        <div class="info">
                            <div class="name">${app.name}</div>
                            <div class="package" title="${app.package}">${app.package}</div>
                        </div>
                    </div>
                    <div class="app-actions">
                        <button onclick="launchApp('${app.package}')" title="啟動">▶ 啟動</button>
                        <button onclick="exportApk('${app.package}')" title="導出">📦 導出</button>
                        <button class="danger" onclick="uninstallApp('${app.package}')" title="移除">🗑️</button>
                    </div>
                </div>
            `).join('');
}

function setAppFilter(filter) {
    currentAppFilter = filter;
    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.filter === filter);
    });
    loadApps();
}

function setAppView(view) {
    currentAppView = view;
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    renderApps();
}

function filterApps() {
    renderApps();
}

async function launchApp(packageName) {
    const result = await ipcRenderer.invoke('launch-app', packageName);
    if (result) showToast('應用已啟動');
}

async function exportApk(packageName) {
    showToast('正在導出 APK...');
    const result = await ipcRenderer.invoke('export-apk', packageName);
    if (result) showToast('APK 已導出');
    else showToast('導出失敗');
}

async function uninstallApp(packageName) {
    if (!confirm('確定要移除 ' + packageName + '?')) return;
    const result = await ipcRenderer.invoke('uninstall-app', packageName);
    if (result) {
        showToast('應用已移除');
        loadApps();
    }
}

async function installApk() {
    const result = await ipcRenderer.invoke('install-apk');
    if (result) {
        showToast('APK 安裝成功');
        loadApps();
    }
}

// Notifications
let notifications = [];

async function loadNotifications() {
    const notifs = await ipcRenderer.invoke('get-notifications');
    if (notifs && notifs.length > 0) {
        notifications = notifs;
        renderNotifications();
    }
}

function renderNotifications() {
    if (notifications.length === 0) {
        document.getElementById('notification-content').innerHTML = `
                    <div class="empty-state">
                        <p>📱 暫無通知</p>
                    </div>
                `;
        return;
    }

    document.getElementById('notification-content').innerHTML = notifications.map((n, i) => `
                <div class="info-card" style="margin-bottom: 8px; cursor: pointer;" onclick="openNotification(${i})">
                    <div class="label">${n.app || '未知應用'}</div>
                    <div class="value">${n.title || '通知'}</div>
                    <div class="sub-value">${n.text || ''}</div>
                </div>
            `).join('');
}

async function refreshNotifications() {
    showToast('重新整理通知...');
    await loadNotifications();
}

async function clearAllNotifications() {
    await ipcRenderer.invoke('clear-notifications');
    notifications = [];
    renderNotifications();
    showToast('已清除所有通知');
}

function openNotification(index) {
    const n = notifications[index];
    if (n && n.package) {
        launchApp(n.package);
    }
}

// Listen for new notifications from main process
ipcRenderer.on('new-notification', (event, notif) => {
    notifications.unshift(notif);
    if (document.querySelector('[data-page="notifications"].active')) {
        renderNotifications();
    }
});

function startScreenMirror() {
    ipcRenderer.send('start-screen-mirror');
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2500);
}

// Initial load
loadDeviceInfo();