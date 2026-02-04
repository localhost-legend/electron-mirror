import fs from 'fs';
import path from 'path';
import https from 'https';
import os from 'os';
import { execSync } from 'child_process';
import { Octokit, App } from 'octokit';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { app } from 'electron';
import state from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getBaseRoot() {
    if (app?.isPackaged) {
        return path.join(process.resourcesPath, 'app.asar.unpacked');
    }
    return path.join(__dirname, '..');
}

// Get platform-specific file extension
function getPlatformFileInfo() {
    const platform = process.platform;

    if (platform === 'win32') {
        return {
            pattern: 'scrcpy-win64-v',
            extension: '.zip'
        };
    } else if (platform === 'darwin') {
        const arch = os.arch(); // x64 or arm64
        const archMap = { 'x64': 'x86_64', 'arm64': 'aarch64' };
        return {
            pattern: `scrcpy-macos-${archMap[arch] || arch}-v`,
            extension: '.tar.gz'
        };
    }

    throw new Error(`Unsupported platform: ${platform}`);
}

// Version comparison helper
function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }

    return 0;
}

// Fetch latest version from GitHub API
async function fetchLatestVersion() {
    const octokit = new Octokit();
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/releases/latest', {
        owner: 'Genymobile',
        repo: 'scrcpy'
    });
    const tag = data.tag_name || '';
    return tag.startsWith('v') ? tag.slice(1) : tag;
}

// Get installed version from directory name in our managed folder
function getInstalledVersion() {
    const appDir = getBaseRoot();

    if (!fs.existsSync(appDir)) {
        return null;
    }

    const { pattern } = getPlatformFileInfo();

    // We look for directories starting with the pattern
    const dirs = fs.readdirSync(appDir).filter(d => d.startsWith(pattern));

    if (dirs.length === 0) {
        return null;
    }

    // Extract versions and find the latest one
    let maxVersion = null;

    for (const dir of dirs) {
        const version = dir.substring(pattern.length);
        if (!maxVersion || compareVersions(version, maxVersion) > 0) {
            maxVersion = version;
        }
    }

    if (maxVersion) {
        return maxVersion;
    }

    // Fallback: Check system installation (e.g. Homebrew on macOS)
    if (process.platform === 'darwin') {
        try {
            const output = execSync('scrcpy --version', { encoding: 'utf-8' }).trim();
            const match = output.match(/scrcpy (\d+\.\d+\.\d+)/);
            if (match) {
                return match[1];
            }
        } catch (e) {
            // Ignore if not found
        }
    }

    return null;
}

// Get scrcpy directory path for current platform
function getScrcpyDir(version) {
    const appDir = getBaseRoot();
    const { pattern } = getPlatformFileInfo();
    const localPath = path.join(appDir, `${pattern}${version}`);

    // If local path exists, use it
    if (fs.existsSync(localPath)) {
        return localPath;
    }

    // Fallback: Return Homebrew path for macOS if local not found
    if (process.platform === 'darwin') {
        return `/opt/homebrew/Cellar/scrcpy/${version}`;
    }

    return localPath;
}

// Check if version is installed
function isVersionInstalled(version) {
    const scrcpyDir = getScrcpyDir(version);
    return fs.existsSync(scrcpyDir);
}

// Download file from GitHub releases
async function downloadScrcpy(version) {
    if (state.isScrcpyDownloading) {
        console.log('[VersionManager] Download already in progress.');
        return;
    }

    state.isScrcpyDownloading = true;
    console.log(`[VersionManager] Downloading scrcpy version ${version}...`);

    try {
        const { pattern, extension } = getPlatformFileInfo();
        const octokit = new Octokit();

        const { data } = await octokit.request('GET /repos/{owner}/{repo}/releases/tags/{tag}', {
            owner: 'Genymobile',
            repo: 'scrcpy',
            tag: `v${version}`
        });

        const asset = data.assets.find(a =>
            a.name.startsWith(`${pattern}${version}`) && a.name.endsWith(extension)
        );

        if (!asset) {
            throw new Error(`No matching asset found for ${version}`);
        }

        const tmpPath = path.join(os.tmpdir(), asset.name);

        console.log(`[VersionManager] Downloading asset ${asset.name}...`);
        const response = await octokit.request('GET {url}', {
            url: asset.url,
            headers: {
                accept: 'application/octet-stream'
            },
            responseType: 'arraybuffer'
        });

        if (response.status !== 200) {
            throw new Error(`Download failed: ${response.status}`);
        }

        fs.writeFileSync(tmpPath, Buffer.from(response.data));

        const targetDir = getScrcpyDir(version);
        const baseRoot = getBaseRoot();

        // Clean up old versions if any
        const oldVersion = getInstalledVersion();
        if (oldVersion && oldVersion !== version) {
            const oldDir = getScrcpyDir(oldVersion);
            if (fs.existsSync(oldDir)) {
                fs.rmSync(oldDir, { recursive: true, force: true });
            }
        }

        fs.mkdirSync(baseRoot, { recursive: true });

        if (extension === '.zip') {
            // Windows
            execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${tmpPath}' -DestinationPath '${baseRoot}' -Force"`);
        } else if (extension === '.tar.gz') {
            // macOS / Linux
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            execSync(`tar -xzf "${tmpPath}" -C "${baseRoot}"`);
        } else {
            console.warn('Wrong extension for current platform');
        }

        fs.unlinkSync(tmpPath);
        console.log(`[VersionManager] Scrcpy ${version} installed successfully.`);
        return targetDir;
    } catch (error) {
        console.error('[VersionManager] Download failed:', error);
        throw error;
    } finally {
        state.isScrcpyDownloading = false;
    }
}

// Check for updates and return version info
async function checkForUpdates() {
    try {
        const latestVersion = await fetchLatestVersion();
        const installedVersion = getInstalledVersion();
        const updateAvailable =
            !!latestVersion &&
            !!installedVersion &&
            compareVersions(latestVersion, installedVersion) > 0;

        return {
            latestVersion,
            installedVersion,
            updateAvailable
        };
    } catch (e) {
        console.error('[VersionManager] Failed to check for updates:', e);
        return {
            latestVersion: null,
            installedVersion: getInstalledVersion(),
            updateAvailable: false,
            error: e.message
        };
    }
}

export {
    fetchLatestVersion,
    getInstalledVersion,
    getScrcpyDir,
    isVersionInstalled,
    downloadScrcpy,
    checkForUpdates,
    getPlatformFileInfo,
    compareVersions
};
