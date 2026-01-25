const { ipcRenderer } = require('electron');

const deviceListEl = document.getElementById('device-list');
const loadingEl = document.getElementById('loading');
const btnRefresh = document.getElementById('btn-refresh');

async function refreshDevices() {
    loadingEl.style.display = 'block';
    deviceListEl.innerHTML = '';

    try {
        const devices = await ipcRenderer.invoke('get-devices');
        loadingEl.style.display = 'none';

        if (devices.length === 0) {
            deviceListEl.innerHTML = '<div style="padding:20px; text-align:center; color:#888;">No devices found.<br>Check ADB connection.</div>';
            return;
        }

        devices.forEach(device => {
            const item = document.createElement('div');
            item.className = 'device-item';

            const infoDiv = document.createElement('div');
            infoDiv.className = 'device-info';

            const displayName = device.alias ? `${device.alias} (${device.model})` : device.model;
            const modelSpan = document.createElement('span');
            modelSpan.className = 'device-model';
            modelSpan.textContent = displayName;

            const serialSpan = document.createElement('span');
            serialSpan.className = 'device-serial';
            serialSpan.textContent = device.id;

            infoDiv.appendChild(modelSpan);
            infoDiv.appendChild(serialSpan);

            // Action Buttons Container
            const actionDiv = document.createElement('div');
            actionDiv.style.display = 'flex';
            actionDiv.style.gap = '10px';

            // Edit API Button
            const editBtn = document.createElement('button');
            editBtn.innerHTML = '✎';
            editBtn.style.cssText = "padding:8px 12px; background:#444; border:none; color:#ddd; border-radius:6px; cursor:pointer;";
            editBtn.title = "Rename Device";
            editBtn.onclick = async (e) => {
                e.stopPropagation();
                const newAlias = prompt("Set Device Name:", device.alias || "");
                if (newAlias !== null) {
                    await ipcRenderer.invoke('set-device-alias', device.id, newAlias);
                    refreshDevices();
                }
            };

            const btn = document.createElement('button');
            btn.className = 'btn-connect';
            btn.textContent = 'Connect';
            btn.onclick = () => connect(device.id);

            actionDiv.appendChild(editBtn);
            actionDiv.appendChild(btn);

            item.appendChild(infoDiv);
            item.appendChild(actionDiv);
            deviceListEl.appendChild(item);
        });

    } catch (err) {
        loadingEl.textContent = 'Error: ' + err.message;
    }
}

function connect(serial) {
    loadingEl.style.display = 'block';
    loadingEl.textContent = `Connecting to ${serial}...`;
    ipcRenderer.send('connect-device', serial);
}

btnRefresh.onclick = refreshDevices;

// Initial Load
refreshDevices();
