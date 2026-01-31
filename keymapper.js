const { ipcRenderer } = require('electron');

class KeyMapper {
    constructor(canvas, ws) {
        this.canvas = canvas;
        this.ws = ws;
        this.mappings = {};
        this.currentProfile = 'default.json';
        this.isEditMode = false;
        this.activeKeys = new Set();
        this.enabled = true;
        this.overlay = null;
        this.joystickState = { x: 0, y: 0, active: false };

        this.init();
    }

    async init() {
        const alias = await ipcRenderer.invoke('get-device-alias');
        this.currentProfile = (alias ? alias : 'default') + '.json';
        this.createOverlay();
        await this.loadProfile(this.currentProfile);
    }

    createOverlay() {
        this.overlay = document.createElement('div');
        this.overlay.id = 'key-mapper-overlay';
        this.overlay.style.cssText = `
            position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            pointer-events: none; z-index: 50; display: none;
        `;
        document.getElementById('app').appendChild(this.overlay);
        this.renderWidgets();
    }

    async loadProfile(name) {
        this.currentProfile = name;
        this.mappings = await ipcRenderer.invoke('load-keymap', name);
        this.renderWidgets();
        if (this.profileSelect) this.profileSelect.value = name;
    }

    async saveProfile() {
        await ipcRenderer.invoke('save-keymap', this.currentProfile, this.mappings);
    }

    toggleEditMode() {
        this.isEditMode = !this.isEditMode;
        if (this.isEditMode) {
            this.overlay.style.display = 'block';
            this.overlay.style.pointerEvents = 'auto';
            this.overlay.style.background = 'rgba(0,0,0,0.5)';
            // Show Add Button & Profile Manager
            this.showAddButton();
            this.showProfileManager();
        } else {
            this.overlay.style.display = 'block';
            this.overlay.style.pointerEvents = 'none';
            this.overlay.style.background = 'transparent';
            if (this.addButton) this.addButton.style.display = 'none';
            if (this.profileManager) this.profileManager.style.display = 'none';
        }
        this.renderWidgets();
    }

    showAddButton() {
        if (!this.addButton) {
            this.addButton = document.createElement('div');
            this.addButton.style.cssText = "position:absolute; bottom:20px; right:20px; color:#fff; background:#333; padding:12px; border-radius:8px; cursor:pointer; font-weight:bold; box-shadow:0 0 5px #000;";
            this.addButton.textContent = "+ ADD CONTROL";
            this.addButton.onclick = (e) => this.showTypeSelector(e);
            this.overlay.appendChild(this.addButton);
        }
        this.addButton.style.display = 'block';
    }

    async showProfileManager() {
        if (!this.profileManager) {
            this.profileManager = document.createElement('div');
            this.profileManager.style.cssText = "position:absolute; top:10px; left:10px; display:flex; gap:10px; pointer-events:auto;";

            // Selector
            this.profileSelect = document.createElement('select');
            this.profileSelect.style.cssText = "padding:5px; background:#333; color:white; border:1px solid #555; border-radius:4px;";
            this.profileSelect.onchange = (e) => this.loadProfile(e.target.value);

            // Refresh List
            const refreshList = async () => {
                const files = await ipcRenderer.invoke('get-keymaps');
                this.profileSelect.innerHTML = '';
                // Ensure current profile is in list if new
                if (!files.includes(this.currentProfile)) {
                    const opt = document.createElement('option');
                    opt.value = this.currentProfile;
                    opt.text = this.currentProfile + " (New)";
                    this.profileSelect.appendChild(opt);
                }
                files.forEach(f => {
                    const opt = document.createElement('option');
                    opt.value = f;
                    opt.text = f;
                    opt.selected = f === this.currentProfile;
                    this.profileSelect.appendChild(opt);
                });
            };
            await refreshList();
            this.profileManager.appendChild(this.profileSelect);

            // Save As Button
            const saveAsBtn = document.createElement('button');
            saveAsBtn.textContent = "Save As...";
            saveAsBtn.style.cssText = "padding:5px 10px; background:#555; color:white; border:none; border-radius:4px; cursor:pointer;";
            saveAsBtn.style.cssText = "padding:5px 10px; background:#555; color:white; border:none; border-radius:4px; cursor:pointer;";
            saveAsBtn.onclick = async () => {
                // Use Native Save Dialog via Main Process
                const result = await ipcRenderer.invoke('save-keymap-dialog', this.mappings);
                if (result.success) {
                    this.currentProfile = result.filename;
                    await refreshList();
                }
            };
            this.profileManager.appendChild(saveAsBtn);

            // Rename Device Alias Button
            const aliasBtn = document.createElement('button');
            aliasBtn.textContent = "Set Device Alias";
            aliasBtn.style.cssText = "padding:5px 10px; background:#222; color:#aaa; border:1px solid #444; border-radius:4px; cursor:pointer; font-size:12px;";
            aliasBtn.title = "Set a friendly name for this device (e.g. Gaming_Tablet)";
            aliasBtn.onclick = async () => {
                const serial = await ipcRenderer.invoke('get-current-serial');
                const currentAlias = await ipcRenderer.invoke('get-device-alias');
                const newAlias = prompt(`Set alias for device (${serial}):`, currentAlias === serial ? "" : currentAlias);
                if (newAlias && newAlias !== currentAlias) {
                    await ipcRenderer.invoke('set-device-alias', serial, newAlias);
                    // Reload Profile to match new alias
                    this.currentProfile = newAlias + '.json';
                    await this.loadProfile(this.currentProfile);
                    await refreshList();
                }
            };
            this.profileManager.appendChild(aliasBtn);

            this.overlay.appendChild(this.profileManager);
        }
        this.profileManager.style.display = 'flex';
    }

    showTypeSelector(e) {
        e.stopPropagation();
        const selector = document.createElement('div');
        selector.style.cssText = `
            position: absolute; top:0; left:0; width:100%; height:100%;
            background: rgba(0,0,0,0.7); z-index: 60;
            display: flex; align-items: center; justify-content: center;
            pointer-events: auto;
        `;

        const container = document.createElement('div');
        container.style.cssText = `
            background: rgba(30,30,30,0.95); padding: 30px; border-radius: 12px;
            display: grid; grid-template-columns: 1fr 1fr; gap: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            text-align: center; color: white; border: 1px solid #444;
        `;

        container.innerHTML = `<h3 style="grid-column: span 2; margin-top:0; color:#ddd;">Add Controller</h3>`;

        const createOption = (icon, label, type) => {
            const btn = document.createElement('div');
            btn.style.cssText = `
                width: 100px; height: 100px; background: rgba(255,255,255,0.05);
                border: 1px solid #555; border-radius: 8px; cursor: pointer;
                display: flex; flex-direction: column; align-items: center; justify-content: center;
                transition: background 0.2s;
            `;
            btn.onmouseover = () => btn.style.background = 'rgba(255,255,255,0.15)';
            btn.onmouseout = () => btn.style.background = 'rgba(255,255,255,0.05)';
            btn.innerHTML = `<div style="font-size:32px; margin-bottom:10px;">${icon}</div><div style="font-size:14px; color:#aaa;">${label}</div>`;
            btn.onclick = (ev) => {
                ev.stopPropagation();
                selector.remove();
                this.startBinding(type);
            };
            return btn;
        };

        container.appendChild(createOption("⦿", "Tap<br>Spot", 'tap'));
        container.appendChild(createOption("✛", "WASD<br>D-Pad", 'dpad'));

        selector.appendChild(container);
        selector.onclick = () => selector.remove();
        this.overlay.appendChild(selector);
    }

    startBinding(type) {
        const hint = document.createElement('div');
        hint.style.cssText = "position:absolute; top:20px; left:50%; transform:translateX(-50%); color:white; font-size:20px; background:rgba(0,0,0,0.7); padding:10px; border-radius:5px;";
        hint.textContent = type === 'tap' ? "Click where you want the button" : "Click where you want the Joystick Center";
        this.overlay.appendChild(hint);

        const clickHandler = (e) => {
            if (e.target !== this.overlay) return;
            this.overlay.removeEventListener('click', clickHandler);
            hint.remove();

            const rect = this.overlay.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;

            if (type === 'tap') {
                this.bindTapKey(x, y);
            } else {
                // Joystick: Default radius 50px (relative to screen?)
                // Better to store as percentage of width to be responsive
                const rect = this.overlay.getBoundingClientRect();
                const radiusP = 60 / rect.width; // Default ~60px radius
                this.mappings['joystick'] = { type: 'dpad', x, y, radius: radiusP };
                this.saveProfile();
                this.renderWidgets();
            }
        };
        this.overlay.addEventListener('click', clickHandler);
    }

    bindTapKey(x, y) {
        const modal = document.createElement('div');
        modal.style.cssText = `position:absolute; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); display:flex; align-items:center; justify-content:center; color:white; font-size:24px; pointer-events:auto;`;
        modal.textContent = "Press any key to bind...";
        this.overlay.appendChild(modal);
        const onKey = (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            const key = ev.key.toLowerCase();
            document.removeEventListener('keydown', onKey);
            modal.remove();
            this.mappings[key] = { type: 'tap', x, y };
            this.saveProfile();
            this.renderWidgets();
        };
        document.addEventListener('keydown', onKey);
    }

    renderWidgets() {
        this.overlay.innerHTML = '';
        // Re-add Add Button & Profile Manager
        if (this.isEditMode && this.addButton) this.overlay.appendChild(this.addButton);
        if (this.isEditMode && this.profileManager) this.overlay.appendChild(this.profileManager);

        Object.keys(this.mappings).forEach(key => {
            const map = this.mappings[key];
            const el = document.createElement('div');
            el.className = 'key-widget';
            el.style.position = 'absolute';
            el.style.left = (map.x * 100) + '%';
            el.style.top = (map.y * 100) + '%';
            el.style.transform = 'translate(-50%, -50%)';
            el.style.cursor = this.isEditMode ? 'move' : 'default';
            el.style.userSelect = 'none';
            // CRITICAL FIX: In Play Mode, widgets must NOT capture mouse events.
            el.style.pointerEvents = this.isEditMode ? 'auto' : 'none';

            // Calc size in pixels for rendering
            const rect = this.overlay.getBoundingClientRect(); // Might be 0 if hidden?
            // If hidden and no rect, we might have issues. 
            // But renderWidgets is called when edit mode toggles or resizes.
            const w = rect.width || 1000;

            if (map.type === 'tap') {
                el.style.width = '42px'; el.style.height = '42px';
                el.style.background = 'rgba(30, 30, 30, 0.6)';
                el.style.border = this.isEditMode ? '2px solid #fff' : '2px solid rgba(255,255,255,0.3)';
                el.style.borderRadius = '50%';
                el.style.display = 'flex'; el.style.alignItems = 'center'; el.style.justifyContent = 'center';
                el.style.color = 'white'; el.style.fontWeight = 'bold';
                el.style.fontSize = '14px';
                el.textContent = key.toUpperCase();
            } else if (map.type === 'dpad') {
                const rPx = (map.radius || 0.05) * w;
                const sizePx = rPx * 2;
                el.style.width = sizePx + 'px'; el.style.height = sizePx + 'px';
                // Styles matching BlueStacks D-Pad
                el.style.background = 'rgba(20, 20, 20, 0.4)';
                el.style.border = this.isEditMode ? '1px dashed #aaa' : '1px solid rgba(255,255,255,0.2)';
                el.style.borderRadius = '50%';
                el.style.boxShadow = 'inset 0 0 10px rgba(0,0,0,0.5)';
                el.style.display = 'flex'; el.style.alignItems = 'center'; el.style.justifyContent = 'center';

                // Inner Cross
                el.innerHTML = `
                    <div style="position:absolute; top:8%; font-size:12px; color:rgba(255,255,255,0.8);">W</div>
                    <div style="position:absolute; bottom:8%; font-size:12px; color:rgba(255,255,255,0.8);">S</div>
                    <div style="position:absolute; left:8%; font-size:12px; color:rgba(255,255,255,0.8);">A</div>
                    <div style="position:absolute; right:8%; font-size:12px; color:rgba(255,255,255,0.8);">D</div>
                    <div style="width:30%; height:30%; border:1px solid rgba(255,255,255,0.3); border-radius:50%;"></div>
                    ${this.isEditMode ? `<div style="position:absolute; bottom:-20px; font-size:10px; color:#aaa;">Size: ${Math.round(rPx)}</div>` : ''}
                `;
            }

            if (this.isEditMode) {
                el.onmousedown = (e) => this.dragElement(el, key, e);
                // Resize with Wheel
                el.onwheel = (e) => {
                    e.preventDefault();
                    const delta = e.deltaY > 0 ? -0.005 : 0.005; // Adjust sensitivity
                    if (map.type === 'dpad') {
                        map.radius = Math.max(0.02, (map.radius || 0.05) + delta);
                        this.saveProfile();
                        this.renderWidgets();
                    }
                };

                el.oncontextmenu = (e) => {
                    e.preventDefault();
                    if (confirm(`Delete ${map.type} mapping?`)) {
                        delete this.mappings[key];
                        this.saveMappings();
                        this.renderWidgets();
                    }
                };

                // Add "X" Delete Button
                const delBtn = document.createElement('div');
                delBtn.style.cssText = `
                    position: absolute; top: -8px; right: -8px;
                    width: 18px; height: 18px; background: red;
                    color: white; border-radius: 50%; border: 2px solid white;
                    font-size: 12px; font-weight: bold; line-height: 16px;
                    text-align: center; cursor: pointer; box-shadow: 0 0 5px rgba(0,0,0,0.5);
                    display: flex; align-items: center; justify-content: center;
                `;
                delBtn.textContent = '×';
                delBtn.onmousedown = (e) => e.stopPropagation(); // Prevent drag start
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (confirm(`Delete ${map.type} mapping?`)) {
                        delete this.mappings[key];
                        this.saveMappings();
                        this.renderWidgets();
                    }
                };
                el.appendChild(delBtn);
            }
            this.overlay.appendChild(el);
        });
    }

    dragElement(elm, key, e) {
        e.preventDefault();
        let startX = e.clientX, startY = e.clientY;
        const onMouseMove = (e) => {
            e.preventDefault();
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            startX = e.clientX; startY = e.clientY;
            elm.style.top = (elm.offsetTop + dy) + "px";
            elm.style.left = (elm.offsetLeft + dx) + "px";
        };
        const onMouseUp = () => {
            document.removeEventListener('mouseup', onMouseUp);
            document.removeEventListener('mousemove', onMouseMove);
            const rect = this.overlay.getBoundingClientRect();
            this.mappings[key].x = elm.offsetLeft / rect.width;
            this.mappings[key].y = elm.offsetTop / rect.height;
            this.saveProfile();
        };
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('mousemove', onMouseMove);
    }

    // --- Input Handling ---

    handleKeyDown(e) {
        if (!this.enabled || this.isEditMode) return;
        const key = e.key.toLowerCase();

        // Tap handling
        if (this.mappings[key] && !this.activeKeys.has(key)) {
            this.activeKeys.add(key);
            const map = this.mappings[key];
            // Pass unique pointerID based on Key CharCode to avoid conflict
            this.injectTouch(0, map.x, map.y, BigInt(key.charCodeAt(0)));
        }

        // Joystick Handling (W/A/S/D)
        if (['w', 'a', 's', 'd'].includes(key)) {
            this.activeKeys.add(key);
            this.updateJoystick();
        }
    }

    handleKeyUp(e) {
        if (!this.enabled || this.isEditMode) return;
        const key = e.key.toLowerCase();

        if (this.mappings[key] && this.activeKeys.has(key)) {
            this.activeKeys.delete(key);
            const map = this.mappings[key];
            this.injectTouch(1, map.x, map.y, BigInt(key.charCodeAt(0)));
        }

        if (['w', 'a', 's', 'd'].includes(key)) {
            this.activeKeys.delete(key);
            this.updateJoystick();
        }
    }

    updateJoystick() {
        const joy = this.mappings['joystick'];
        if (!joy) return;

        // Calculate Vector
        let dx = 0, dy = 0;
        if (this.activeKeys.has('w')) dy -= 1;
        if (this.activeKeys.has('s')) dy += 1;
        if (this.activeKeys.has('a')) dx -= 1;
        if (this.activeKeys.has('d')) dx += 1;

        // Normalize
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) { dx /= len; dy /= len; }

        const POINTER_ID = 100n; // Reserved for Joystick

        // Use the configured Radius! 
        // Aspect ratio correction? 
        // radius is stored as % of WIDTH.
        // yP needs to be % of HEIGHT.
        // So dy * radius * (width/height) ?
        // Scrcpy injectTouchNormalized takes 0..1 x, 0..1 y.

        // x offset detected is map.radius (0.05 of width)
        // y offset needs to be converted.
        const rect = this.overlay.getBoundingClientRect();
        const aspect = rect.width / rect.height;

        const radiusW = (joy.radius || 0.05);
        const radiusH = radiusW * aspect;

        const targetX = joy.x + (dx * radiusW);
        const targetY = joy.y + (dy * radiusH);

        if (len > 0) {
            if (!this.joystickState.active) {
                // Start Touch at Center
                this.injectTouch(0, joy.x, joy.y, POINTER_ID);
                this.joystickState.active = true;
                // Immediate Move to Target
                setTimeout(() => this.injectTouch(2, targetX, targetY, POINTER_ID), 10);
            } else {
                // Move Touch
                this.injectTouch(2, targetX, targetY, POINTER_ID);
            }
        } else {
            if (this.joystickState.active) {
                this.injectTouch(1, joy.x, joy.y, POINTER_ID); // Up
                this.joystickState.active = false;
            }
        }
    }

    injectTouch(action, xP, yP, id) {
        if (this.onInject) this.onInject(action, xP, yP, id);
    }
}

module.exports = KeyMapper;
