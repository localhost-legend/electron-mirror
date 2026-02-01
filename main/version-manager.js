import fs from 'fs';
import path from 'path';
import https from 'https';
import os from 'os';
import { execSync } from 'child_process';
import { Octokit, App } from 'octokit';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get platform-specific file extension
function getPlatformFileInfo() {
    const platform = process.platform;

    if (platform === 'win32') {
        return {
            pattern: 'scrcpy-win64-v',
            extension: '.zip'
        };
    } else if (platform === 'darwin') { // usability unknown
        const arch = os.arch(); // x64 or arm64
        const archMap = { 'x64': 'x86_64', 'arm64': 'arm64' };
        return {
            pattern: `scrcpy-macos-${archMap[arch] || arch}-v`,
            extension: '.tar.gz'
        };
    }

    throw new Error(`Unsupported platform: ${platform}`);
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

// Get installed version from directory name
function getInstalledVersion() {
    const platform = process.platform;
    const appDir = path.dirname(path.dirname(__filename));

    if (platform === 'win32') {
        const pattern = /scrcpy-win64-v(.+)/;
        const dirs = fs.readdirSync(appDir).filter(d => pattern.test(d));
        if (dirs.length > 0) {
            const match = dirs[0].match(pattern);
            return match ? match[1] : null;
        }
    } else if (platform === 'darwin') { // usability unknown
        // For macOS, we check the homebrew installation or bundled version
        try {
            const output = execSync('scrcpy --version', { encoding: 'utf-8' }).trim();
            const match = output.match(/scrcpy (\d+\.\d+\.\d+)/);
            return match ? match[1] : null;
        } catch (e) {
            return null;
        }
    }

    return null;
}

// Get scrcpy directory path for current platform
function getScrcpyDir(version) {
    const platform = process.platform;
    const appDir = path.dirname(path.dirname(__filename));

    if (platform === 'win32') {
        return path.join(appDir, `scrcpy-win64-v${version}`);
    } else if (platform === 'darwin') { //usability unknown
        // For macOS, scrcpy is typically installed via homebrew
        return `/opt/homebrew/Cellar/scrcpy/${version}`;
    }

    throw new Error(`Unsupported platform: ${platform}`);
}

// Check if version is installed
function isVersionInstalled(version) {
    const scrcpyDir = getScrcpyDir(version);
    return fs.existsSync(scrcpyDir);
}

// Download file from GitHub releases
async function downloadScrcpy(version) {
    console.log(`[VersionManager] Downloading scrcpy version ${version}...`);
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
    fs.mkdirSync(targetDir, { recursive: true });

    if (extension === '.zip') {
        execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${tmpPath}' -DestinationPath '${targetDir}' -Force"`);
        const entries = fs.readdirSync(targetDir, { withFileTypes: true });
        const innerDir = entries.find(e => e.isDirectory() && e.name.startsWith('scrcpy-win64-v'));
        if (innerDir) {
            const innerPath = path.join(targetDir, innerDir.name);
            for (const item of fs.readdirSync(innerPath)) {
                fs.renameSync(path.join(innerPath, item), path.join(targetDir, item));
            }
            fs.rmdirSync(innerPath);
        }
    } else {
        console.warn('Wrong extension for current platform');
    }

    fs.unlinkSync(tmpPath);
    return targetDir;
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
