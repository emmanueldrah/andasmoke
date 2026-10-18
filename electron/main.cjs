const { app } = require('electron');
const path = require('node:path');

app.setName('anda-smoke-hub-pos');

/* Unpackaged dev runs share the project's .data folder with `npm run dev:api`,
   so the desktop till and the browser show the same products and sales. A
   packaged install keeps its own database under %APPDATA%. */
const ROOT_DIR = path.join(__dirname, '..');
if (!app.isPackaged && !process.env.ANDA_DATA_DIR) {
  process.env.ANDA_DATA_DIR = path.join(ROOT_DIR, '.data');
}
process.env.ANDA_DATA_DIR = process.env.ANDA_DATA_DIR || app.getPath('userData');
process.env.ANDA_CLOUD_API_ORIGIN = (process.env.ANDA_CLOUD_API_ORIGIN || 'https://andasmoke.vercel.app').replace(/\/+$/, '');
const CLOUD_API_ORIGIN = process.env.ANDA_CLOUD_API_ORIGIN;

/* Windows groups taskbar buttons by AppUserModelID. Without this the taskbar
   shows the generic Electron icon instead of the shop emblem, even though the
   BrowserWindow has an icon set. */
if (process.platform === 'win32') {
  app.setAppUserModelId('gh.anda.smokehub.pos');
}

const { startLocalServer } = require('./local-server.cjs');
const { handlers } = require('./api-routes.cjs');

const DIST_DIR = path.join(ROOT_DIR, 'dist');

/* Window/taskbar icon. Prefer the built copy, but fall back to public/ so dev
   runs still carry the emblem before the first `npm run build`. */
const ICON_CANDIDATES = [
  path.join(DIST_DIR, 'brand-mark.ico'),
  path.join(ROOT_DIR, 'public', 'brand-mark.ico'),
];
function resolveAppIcon() {
  const fs = require('node:fs');
  return ICON_CANDIDATES.find(p => fs.existsSync(p));
}

/* `npm run pos:desktop:dev` passes --dev-url=http://127.0.0.1:3000. The window
   then loads Vite directly: source edits hot-reload, and /api is proxied to
   the dev API, so the desktop app and the browser stay identical. */
const devUrlArg = process.argv.find(a => a.startsWith('--dev-url='));
const DEV_URL = devUrlArg ? devUrlArg.slice('--dev-url='.length) : (process.env.ANDA_DEV_URL || null);

async function boot() {
  const { origin } = await startLocalServer({
    distDir: DIST_DIR,
    handlers,
    cloudApiOrigin: CLOUD_API_ORIGIN,
    host: '127.0.0.1',
    port: 4311,
  });
  console.log('[pos] local server on ' + origin);
  console.log('[pos] hosted API at ' + CLOUD_API_ORIGIN);
  return origin;
}

app.whenReady().then(async () => {
  // In dev-URL mode the renderer comes from Vite (port 3000) and its /api and
  // /media calls are proxied to the dev API, which reads the same .data
  // database. No local server needed.
  const origin = DEV_URL ? DEV_URL : await boot();
  if (DEV_URL) console.log('[pos] dev mode: loading ' + DEV_URL + ' (edit src/ and the window hot-reloads)');

  const { BrowserWindow, ipcMain } = require('electron');

  // Receipt printing goes through the main process; the renderer is sandboxed.
  ipcMain.handle('pos:print', (event) => new Promise((resolve, reject) => {
    event.sender.print({ silent: false, printBackground: true }, (success, errorType) => {
      success ? resolve(true) : reject(new Error(errorType || 'Printing was cancelled'));
    });
  }));

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Anda C Smoke Hub POS',
    icon: resolveAppIcon(),
    backgroundColor: '#faf6f0',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.loadURL(origin + '/');

  win.webContents.on('did-fail-load', (_e, code) => {
    if (code === -3) return;
    console.error('[pos] renderer failed to load, code ' + code);
  });

  // ── Background Auto-Updater (packaged production installs) ───────────────
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on('update-downloaded', (info) => {
        console.log('[updater] Update downloaded:', info?.version);
        win.webContents.send('pos:update-downloaded', { version: info?.version });
      });

      autoUpdater.on('error', (err) => {
        console.warn('[updater] Update check:', err?.message || err);
      });

      ipcMain.handle('pos:restart-and-install', () => {
        autoUpdater.quitAndInstall();
      });

      // Check for updates 15s after startup
      setTimeout(() => {
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      }, 15_000);

      // Check periodically every 2 hours
      setInterval(() => {
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      }, 2 * 60 * 60 * 1000);
    } catch (updaterErr) {
      console.warn('[updater] Could not start updater:', updaterErr);
    }
  }

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) win.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});