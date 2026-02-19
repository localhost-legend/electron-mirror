import { ipcMain } from 'electron';
import state from '../state.js';
import { sendInputEvent, handleRendererReady } from '../services/scrcpy-service.js';

function registerScrcpyHandlers({
    launchScreenMirror,
    createOverviewWindow,
    updateWindowAspectRatio
}) {
    ipcMain.on('start-screen-mirror', async () => {
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
            state.mainWindow.show();
            state.mainWindow.focus();
            return;
        }

        await launchScreenMirror();
    });

    ipcMain.on('return-to-overview', () => {
        console.log('[Main] Opening Overview...');

        if (state.overviewWindow && !state.overviewWindow.isDestroyed()) {
            state.overviewWindow.show();
            state.overviewWindow.focus();
        } else {
            createOverviewWindow();
        }
    });

    ipcMain.on('set-aspect-ratio', (event, width, height) => {
        if (state.mainWindow) {
            state.currentVideoRatio = width / height;
            updateWindowAspectRatio();
        }
    });

    ipcMain.on('resize-window', (event, sidebarWidth) => {
        if (state.mainWindow) {
            console.log(`[Main] Sidebar Resize: ${sidebarWidth}`);
            state.currentSidebarWidth = sidebarWidth;
            updateWindowAspectRatio();
        }
    });

    ipcMain.on('scrcpy-input', (event, payload) => {
        sendInputEvent(payload);
    });

    ipcMain.on('scrcpy-renderer-ready', () => {
        console.log('[Main] Renderer ready');
        handleRendererReady();
    });

    ipcMain.on('scrcpy-client-stats', (event, payload) => {
        if (!payload) return;
        if (!state.debugStatsEnabled) return;
        if (payload.decodedFps !== undefined) {
            console.log(`[Stats] decoded_fps=${payload.decodedFps}`);
        }
    });
}

export { registerScrcpyHandlers };
