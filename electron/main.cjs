const { app } = require('electron');
const path = require('node:path');

app.setName('anda-smoke-hub-pos');
process.env.ANDA_DATA_DIR = process.env.ANDA_DATA_DIR || app.getPath('userData');
const CLOUD_API_ORIGIN = (process.env.ANDA_CLOUD_API_ORIGIN || 'https://andasmoke.vercel.app').replace(/\/+$/, '');

const { startLocalServer } = require('./local-server.cjs');

const DIST_DIR = path.join(__dirname, '..', 'dist');

async function boot() {
  const { origin } = await startLocalServer({
    distDir: DIST_DIR,
    cloudApiOrigin: CLOUD_API_ORIGIN,
    host: '127.0.0.1',
    port: 0,
  });
  console.log('[pos] local server on ' + origin);
  console.log('[pos] hosted API at ' + CLOUD_API_ORIGIN);
  return origin;
}

app.whenReady().then(async () => {
  const origin = await boot();

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
    icon: path.join(DIST_DIR, 'brand-mark.ico'),
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

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) win.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});