/**
 * Filesystem locations owned by this till.
 *
 * Kept in one place so the database, product media and backups always agree on
 * which folder they belong to, whichever process is asking. Browser-safe: no
 * Node built-ins are imported here, so the renderer can use it too.
 */
export const DB_FILE_NAME = 'anda-smoke-hub.sqlite';
export const BACKUP_DIR_NAME = 'backups';

/** Joins path segments with forward slashes, which both Windows and POSIX accept. */
function at(...segments: string[]): string {
  return segments.filter(Boolean).join('/');
}

/**
 * The till's data folder.
 *
 * Electron passes `app.getPath('userData')`; standalone runs (tests, tooling)
 * fall back to `./.data` beside the project so nothing is written into the
 * source tree during development.
 */
export function getDataDir(userDataDir?: string): string {
  const base = userDataDir || process.env.ANDA_DATA_DIR || at('..', '.data');
  return base;
}

/** Absolute path to the SQLite file. */
export function resolveDatabasePath(userDataDir?: string): string {
  return at(getDataDir(userDataDir), DB_FILE_NAME);
}

/** Absolute path to the automatic local backup folder. */
export function resolveBackupDir(userDataDir?: string): string {
  return at(getDataDir(userDataDir), BACKUP_DIR_NAME);
}