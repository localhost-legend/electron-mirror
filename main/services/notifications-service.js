import { Notification } from 'electron';
import { exec } from 'child_process';
import state from '../state.js';

async function getNotifications(adbPath) {
    const s = state.selectedSerial;
    if (!s) return [];

    try {
        const output = await new Promise((resolve, reject) => {
            exec(`${adbPath} -s ${s} shell dumpsys notification --noredact`, { maxBuffer: 1024 * 1024 * 5 }, (err, stdout) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });

        const notifications = [];
        const lines = output.split('\n');
        let current = null;
        let inNotificationRecord = false;

        for (const line of lines) {
            if (line.includes('NotificationRecord(') && line.includes('pkg=')) {
                inNotificationRecord = true;
                const pkgMatch = line.match(/pkg=([^\s\)]+)/);
                if (pkgMatch) {
                    if (current && current.title) {
                        notifications.push(current);
                    }
                    current = {
                        package: pkgMatch[1],
                        app: pkgMatch[1].split('.').pop(),
                        title: null,
                        text: null
                    };
                }
            }

            if (current && inNotificationRecord) {
                if (line.includes('android.title=String (')) {
                    const titleMatch = line.match(/android\.title=String \(([^)]+)\)/);
                    if (titleMatch) current.title = titleMatch[1].trim();
                } else if (line.includes('android.title=') && !line.includes('android.title=null')) {
                    const titleMatch = line.match(/android\.title=(.+)/);
                    if (titleMatch && titleMatch[1] !== 'null') {
                        current.title = titleMatch[1].trim();
                    }
                }

                if (line.includes('android.text=String (')) {
                    const textMatch = line.match(/android\.text=String \(([^)]+)\)/);
                    if (textMatch) current.text = textMatch[1].trim();
                } else if (line.includes('android.text=') && !line.includes('android.text=null')) {
                    const textMatch = line.match(/android\.text=(.+)/);
                    if (textMatch && textMatch[1] !== 'null') {
                        current.text = textMatch[1].trim();
                    }
                }
            }
        }

        if (current && current.title) {
            notifications.push(current);
        }

        const seen = new Set();
        const filtered = notifications.filter(n => {
            if (!n.title || n.title === '通知' || n.title === 'null') return false;
            const key = n.package + ':' + n.title;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        state.notificationCache = filtered.slice(0, 20);
        return state.notificationCache;
    } catch (e) {
        console.error('get-notifications error:', e);
        return [];
    }
}

function startNotificationWatcher(adbPath, serial) {
    if (state.notificationWatcher) clearInterval(state.notificationWatcher);

    let lastCount = 0;
    state.notificationWatcher = setInterval(async () => {
        if (!state.selectedSerial) return;

        try {
            const output = await new Promise((resolve) => {
                exec(`${adbPath} -s ${serial} shell dumpsys notification --noredact | grep -c "pkg="`, (err, stdout) => {
                    resolve(stdout?.trim() || '0');
                });
            });

            const count = parseInt(output) || 0;
            if (count > lastCount) {
                const notifs = await getNotifications(adbPath);
                if (notifs && notifs.length > 0) {
                    const newest = notifs[0];

                    if (Notification.isSupported()) {
                        const n = new Notification({
                            title: newest.title || newest.app,
                            body: newest.text || '',
                            silent: false
                        });
                        n.on('click', () => {
                            if (newest.package) {
                                exec(`${adbPath} -s ${serial} shell monkey -p "${newest.package}" -c android.intent.category.LAUNCHER 1`);
                            }
                        });
                        n.show();
                    }

                    if (state.overviewWindow && !state.overviewWindow.isDestroyed()) {
                        state.overviewWindow.webContents.send('new-notification', newest);
                    }
                }
            }
            lastCount = count;
        } catch (e) {
        }
    }, 3000);
}

function stopNotificationWatcher() {
    if (state.notificationWatcher) {
        clearInterval(state.notificationWatcher);
        state.notificationWatcher = null;
    }
}

async function clearNotifications(adbPath) {
    const s = state.selectedSerial;
    if (!s) return false;

    try {
        await new Promise((resolve, reject) => {
            exec(`${adbPath} -s ${s} shell service call notification 1`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        state.notificationCache = [];
        return true;
    } catch (e) {
        console.error('clear-notifications error:', e);
        return false;
    }
}

export { getNotifications, startNotificationWatcher, stopNotificationWatcher, clearNotifications };
