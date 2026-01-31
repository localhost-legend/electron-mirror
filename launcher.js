const { ipcRenderer } = require('electron');

async function loadDevices() {
    const list = document.getElementById('deviceList');
    list.innerHTML = `
        <div class="empty-state">
            <div class="spinner" style="margin: auto;"></div>
            <p style="margin-top: 16px;">正在搜尋裝置...</p>
        </div>
    `;

    try {
        const devices = await ipcRenderer.invoke('get-devices');

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

        list.innerHTML = devices.map(d => `
            <div class="device-card" data-serial="${d.id}" onclick="connectDevice('${d.id}')">
                <div class="device-icon">
                    <svg viewBox="0 0 24 24"><path d="M15.5 1h-8C6.12 1 5 2.12 5 3.5v17C5 21.88 6.12 23 7.5 23h8c1.38 0 2.5-1.12 2.5-2.5v-17C18 2.12 16.88 1 15.5 1zm-4 21c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4.5-4H7V4h9v14z"/></svg>
                </div>
                <div class="device-info">
                    <div class="device-name">${d.alias || d.model}</div>
                    <div class="device-serial">${d.id}</div>
                </div>
                <div class="device-arrow">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>
                </div>
            </div>
        `).join('');
    } catch (e) {
        list.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" style="fill: #e74c3c;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                <p style="color: #e74c3c;">無法連接 ADB</p>
                <p style="font-size: 12px; margin-top: 8px;">${e.message}</p>
            </div>
        `;
    }
}

async function connectDevice(serial) {
    // Just send event - Launcher stays open, no need to change UI
    ipcRenderer.send('connect-device', serial);
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

// Initial load
loadDevices();
