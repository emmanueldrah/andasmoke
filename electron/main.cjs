const { app } = require('electron');
const path = require('node:path');

const { startLocalServer } = require('./local-server.cjs');
const { handlers } = require('./api-routes.cjs');
// Re-exported from the API bundle so the main process and the server share one
// backup implementation (VACUUM INTO, retention, media manifest).
const { createBackupIfDue, lastBackupInfo } = require('./api-bundle.cjs');

// Electron derives the userData folder (and so the database location) from the
// app name. Set it before anything reads app.getPath, otherwise a development
// run would scatter data under a folder called "Electron".
app.setName('anda-smoke-hub-pos');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const DB_FILE = 'anda-smoke-hub.sqlite';

/**
 * Where the till keeps its database.
 *
 * Honours ANDA_DATA_DIR when it is already set so tests and tooling can run
 * against a throwaway folder; otherwise it sits beside the app's other data.
 */
function resolveDbPath() {
  const configured = process.env.ANDA_DATA_DIR;
  const dir = configured ? configured : app.getPath('userData');
  process.env.ANDA_DATA_DIR = dir;
  return path.join(dir, DB_FILE);
}

/**
 * Takes the daily backup when it is due.
 *
 * Driven by app start and a clean close rather than a timer, so a till that is
 * opened and shut every day still ends each trading day with a snapshot, and
 * nothing has to stay alive in the background to notice 24 hours passing.
 */
function runDueBackup(reason) {
  try {
    const result = createBackupIfDue(reason);
    if (result) {
      console.log('[pos] daily backup taken on ' + reason + ': ' + result.path);
    }
  } catch (error) {
    // Never let a backup problem stop the till from opening or closing.
    console.error('[pos] daily backup failed: ' + (error && error.message ? error.message : error));
  }
}

async function boot() {
  const dbPath = resolveDbPath();
  runDueBackup('startup');

  const { server, origin } = await startLocalServer({
    distDir: DIST_DIR,
    handlers,
    host: '127.0.0.1',
    port: 0,
  });
  console.log('[pos] local server on ' + origin);
  console.log('[pos] database at ' + dbPath);
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

/**
 * Clean close: one last snapshot if today's is missing, then quit.
 *
 * Runs on will-quit rather than window-all-closed so it also covers quitting
 * from the dock, the task manager, or a session ending. The database connection
 * is not closed first, because VACUUM INTO takes its own read lock safely
 * while the till is still running.
 */
let closed = false;
app.on('will-quit', () => {
  if (closed) return;
  closed = true;
  runDueBackup('shutdown');
  const last = lastBackupInfo();
  if (last.exists) console.log('[pos] last backup: ' + last.createdAt);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});