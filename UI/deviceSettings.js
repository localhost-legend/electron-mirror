const { ipcRenderer } = window.require('electron');

function getSerialFromQuery() {
    const params = new URLSearchParams(window.location.search);
    return params.get('serial');
}

function getFocusFromQuery() {
    const params = new URLSearchParams(window.location.search);
    return params.get('focus');
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

async function loadSettings() {
    const serial = getSerialFromQuery();
    if (!serial) return;

    const focus = getFocusFromQuery();

    const data = await ipcRenderer.invoke('get-device-settings', serial);
    if (!data) return;

    const { alias, model, settings, display } = data;

    const aliasInput = document.getElementById('aliasInput');
    const serialText = document.getElementById('serialText');
    const maxFpsInput = document.getElementById('maxFpsInput');
    const sizePercentInput = document.getElementById('sizePercentInput');
    const sizePercentValue = document.getElementById('sizePercentValue');
    const sizePercentHint = document.getElementById('sizePercentHint');
    const bitRateInput = document.getElementById('bitRateInput');
    const subtitle = document.getElementById('deviceSubtitle');

    if (aliasInput) aliasInput.value = alias || '';
    if (serialText) serialText.textContent = serial;
    if (subtitle) subtitle.textContent = model ? `${model}` : serial;

    const longSide = display?.longSide || null;

    if (settings) {
        if (maxFpsInput) maxFpsInput.value = settings.maxFps ?? 60;
        let percent = settings.maxSizePercent ?? null;
        if (percent === null || percent === undefined) {
            const legacy = settings.maxSize;
            if (legacy && longSide) {
                percent = Math.round((legacy / longSide) * 100);
            }
        }
        percent = clampInt(percent ?? 100, 25, 100, 100);

        if (sizePercentInput) {
            sizePercentInput.value = percent;
        }
        if (sizePercentValue) sizePercentValue.textContent = `${percent}%`;
        if (sizePercentHint) {
            const base = display?.longSide && display?.shortSide
                ? `裝置原生解析度：${display.longSide} × ${display.shortSide}`
                : '裝置原生解析度：--';
            const scaled = longSide ? ` · 長邊輸出：約 ${Math.round(longSide * (percent / 100))} px` : '';
            sizePercentHint.textContent = `${base}${scaled}`;
        }
        if (bitRateInput) bitRateInput.value = settings.bitRateMbps ?? 0;

        if (sizePercentInput) {
            sizePercentInput.addEventListener('input', () => {
                const p = clampInt(sizePercentInput.value, 25, 100, 100);
                if (sizePercentValue) sizePercentValue.textContent = `${p}%`;
                if (sizePercentHint) {
                    const base = display?.longSide && display?.shortSide
                        ? `裝置原生解析度：${display.longSide} × ${display.shortSide}`
                        : '裝置原生解析度：--';
                    const scaled = longSide ? ` · 長邊輸出：約 ${Math.round(longSide * (p / 100))} px` : '';
                    sizePercentHint.textContent = `${base}${scaled}`;
                }
            });
        }
    }

    if (focus === 'alias' && aliasInput) {
        setTimeout(() => {
            aliasInput.focus();
            aliasInput.select();
        }, 50);
    }
}

async function saveSettings() {
    const serial = getSerialFromQuery();
    if (!serial) return;

    const aliasInput = document.getElementById('aliasInput');
    const maxFpsInput = document.getElementById('maxFpsInput');
    const sizePercentInput = document.getElementById('sizePercentInput');
    const bitRateInput = document.getElementById('bitRateInput');

    const alias = aliasInput ? aliasInput.value.trim() : '';

    const maxFps = clampNumber(maxFpsInput?.value, 1, 120, 60);
    const maxSizePercent = clampInt(sizePercentInput?.value, 25, 100, 100);
    const bitRateMbps = clampNumber(bitRateInput?.value, 0, 50, 0);

    await ipcRenderer.invoke('set-device-alias', serial, alias);
    await ipcRenderer.invoke('set-device-settings', serial, { maxFps, maxSizePercent, bitRateMbps });
    ipcRenderer.send('refresh-device-list');
    window.close();
}

window.addEventListener('DOMContentLoaded', () => {
    loadSettings();

    const btnSave = document.getElementById('btn-save');
    const btnCancel = document.getElementById('btn-cancel');

    if (btnSave) btnSave.addEventListener('click', saveSettings);
    if (btnCancel) btnCancel.addEventListener('click', () => window.close());
});
