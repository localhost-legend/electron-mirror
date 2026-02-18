import { dialog } from 'electron';
import { exec } from 'child_process';
import state from '../state.js';

async function listFiles(getAdbPath, path = '/sdcard') {
    const s = state.selectedSerial;
    console.log('[list-files] SELECTED_SERIAL:', s, 'path:', path);
    if (!s) {
        console.log('[list-files] No serial selected!');
        return [];
    }

    try {
        const targetPath = path.endsWith('/') ? path : path + '/';
        const cmd = `${getAdbPath()} -s ${s} shell ls -la "${targetPath}"`;
        console.log('[list-files] Running:', cmd);

        const output = await new Promise((resolve, reject) => {
            exec(cmd, (err, stdout) => {
                if (err) {
                    console.log('[list-files] Error:', err.message);
                    reject(err);
                } else {
                    console.log('[list-files] Output length:', stdout.length);
                    resolve(stdout);
                }
            });
        });

        const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('total'));
        console.log('[list-files] Lines to parse:', lines.length);
        const files = [];

        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 7) continue;

            const perms = parts[0];
            let dateIdx = parts.findIndex(p => /^\d{4}-\d{2}-\d{2}$/.test(p));
            if (dateIdx === -1) continue;

            const size = parseInt(parts[dateIdx - 1]) || 0;
            const date = parts[dateIdx] + ' ' + parts[dateIdx + 1];
            const name = parts.slice(dateIdx + 2).join(' ').split(' -> ')[0];

            if (!name || name === '.' || name === '..') continue;

            files.push({
                name,
                isDirectory: perms.startsWith('d'),
                isLink: perms.startsWith('l'),
                size,
                date,
                path: `${path}/${name}`.replace(/\/+/g, '/')
            });
        }
        return files;
    } catch (e) {
        console.error('list-files error:', e);
        return [];
    }
}

async function pullFile(getAdbPath, remotePath) {
    const s = state.selectedSerial;
    if (!s) return null;

    const fileName = remotePath.split('/').pop();
    const result = await dialog.showSaveDialog({
        defaultPath: fileName,
        title: '儲存檔案'
    });

    if (result.canceled) return null;

    try {
        await new Promise((resolve, reject) => {
            exec(`${getAdbPath()} -s ${s} pull "${remotePath}" "${result.filePath}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return result.filePath;
    } catch (e) {
        console.error('pull-file error:', e);
        return null;
    }
}

async function pushFile(getAdbPath, remotePath) {
    const s = state.selectedSerial;
    if (!s) return false;

    const result = await dialog.showOpenDialog({
        title: '選擇檔案上傳',
        properties: ['openFile']
    });

    if (result.canceled) return false;

    try {
        await new Promise((resolve, reject) => {
            exec(`${getAdbPath()} -s ${s} push "${result.filePaths[0]}" "${remotePath}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return true;
    } catch (e) {
        console.error('push-file error:', e);
        return false;
    }
}

async function deleteFile(getAdbPath, remotePath) {
    const s = state.selectedSerial;
    if (!s) return false;

    try {
        await new Promise((resolve, reject) => {
            exec(`${getAdbPath()} -s ${s} shell rm -rf "${remotePath}"`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return true;
    } catch (e) {
        console.error('delete-file error:', e);
        return false;
    }
}

export { listFiles, pullFile, pushFile, deleteFile };
