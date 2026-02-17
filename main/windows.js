import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { BrowserWindow, screen } from 'electron';
import state from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let resizeTimeout = null;

const defaultLuncherWindowOptions = {
    windowsetting: {
        width: 450,
        height: 600,
        resizable: false,
        title: 'Select Device',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    }
};
const defaultOverviewWindowOptions = {
    windowsetting: {
        width: 900,
        height: 650,
        resizable: false,
        title: 'Overview',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    }
};


function createLauncherWindow() {
    state.launcherWindow = new BrowserWindow(defaultLuncherWindowOptions.windowsetting
    );
    state.launcherWindow.loadFile(path.join(__dirname,'..', 'UI', 'launcher.html'));
}

function createOverviewWindow() {
    state.overviewWindow = new BrowserWindow(defaultOverviewWindowOptions.windowsetting
    );
    state.overviewWindow.loadFile(path.join(__dirname, '..', 'UI', 'overview.html'));
    state.overviewWindow.on('closed', () => {
        state.overviewWindow = null;
    });
}

function createMainWindow({ onClosed } = {}) {

    /* calculate main window size */
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
    const defaultWidth = 1280;
    const defaultHeight = 720;
    const windowWidth = Math.min(defaultWidth, screenWidth);
    const windowHeight = Math.min(defaultHeight, screenHeight);

    const deviceTitle = state.selectedAlias || state.selectedModel || state.selectedSerial || 'Screen Mirror';
    const defaultMainWindowOptions = {
        windowsetting: {
            width: windowWidth,
            height: windowHeight,
            center: true,
            title: deviceTitle, // display device name instead of "Tango Native", we not even use that thing :'(
            backgroundColor: '#000',
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        }
    };

    state.mainWindow = new BrowserWindow(defaultMainWindowOptions.windowsetting);

    state.mainWindow.loadFile(path.join(__dirname, '..', 'UI', 'screenMirror.html'));
    setupWindowListeners();
    updateWindowAspectRatio();

    state.mainWindow.on('closed', () => {
        if (onClosed) onClosed();
        state.mainWindow = null;
    });

    state.mainWindow.on('enter-full-screen', () => {
        state.mainWindow.webContents.send('fullscreen-change', true);
    });
    state.mainWindow.on('leave-full-screen', () => {
        state.mainWindow.webContents.send('fullscreen-change', false);
    });
}

function setupWindowListeners() {
    if (!state.mainWindow) return;
    state.mainWindow.on('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            snapWindowToRatio();
        }, 200);
    });
}

function snapWindowToRatio() {
    if (!state.mainWindow || state.mainWindow.isMaximized() || state.mainWindow.isFullScreen()) return;

    const [wW, wH] = state.mainWindow.getSize();
    const [cW, cH] = state.mainWindow.getContentSize();

    const chromeHeight = wH - cH;
    const chromeWidth = wW - cW;

    const videoRatio = state.currentVideoRatio || (9 / 16);
    const sidebarWidth = Math.max(0, state.currentSidebarWidth || 0);

    const targetContentWidth = Math.round(cH * videoRatio) + sidebarWidth;
    const targetWindowWidth = targetContentWidth + chromeWidth;

    if (Math.abs(wW - targetWindowWidth) > 2) {
        state.mainWindow.setSize(targetWindowWidth, wH);
    }
}
function updateWindowAspectRatio() {
    if (!state.mainWindow) return;

    const mainWindow = state.mainWindow;
    const [wW, wH] = mainWindow.getSize();
    const [cW, cH] = mainWindow.getContentSize();

    if (cH <= 0) return;

    const chromeWidth = wW - cW;
    const chromeHeight = wH - cH;

    const videoRatio = state.currentVideoRatio || (9 / 16);
    const sidebarWidth = Math.max(0, state.currentSidebarWidth || 0);

    const targetContentWidth = Math.max(1, Math.round(cH * videoRatio) + sidebarWidth);
    const targetWindowWidth = targetContentWidth + chromeWidth;
    const targetWindowHeight = cH + chromeHeight;

    mainWindow.setAspectRatio(videoRatio, {
        width: chromeWidth + sidebarWidth,
        height: chromeHeight
    });

    if (Math.abs(wW - targetWindowWidth) > 2) {
        mainWindow.setSize(targetWindowWidth, wH);
    }
}

export {
    createLauncherWindow,
    createOverviewWindow,
    createMainWindow,
    snapWindowToRatio,
    updateWindowAspectRatio
};
