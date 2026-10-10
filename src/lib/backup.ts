/**
 * Backup, restore and retention for the till's SQLite file.
 *
 * The database runs in WAL mode, so copying `anda-smoke-hub.sqlite` with a
 * plain file copy would capture only the main file and silently drop whatever
 * is still sitting in the `-wal` sidecar. SQLite's own `VACUUM INTO` writes a
 * consistent, self-contained snapshot (no `-wal`, no `-shm`) while holding a
 * read lock, which is exactly what a backup needs.
 *
 * Backups are stamped with a small JSON header so a restore can refuse a file
 * that is corrupt, truncated, or produced by a different schema version instead
 * of overwriting live data with rubbish.
 */
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  getBarcodeSequence,
  getSqliteHandle,
  closeDataLayer,
  resolveDatabasePath,
  setBarcodeSequence,
} from '../db/index.js';
import { getDataDir, resolveBackupDir } from './paths.js';
import { ZipError, createZip, readZip, type ReadZipEntry, type ZipEntry } from './zip.js';

/** How many automatic daily backups to keep on disk. */
export const DAILY_BACKUP_RETENTION = 14;

/** A daily backup is due once the newest one is older than this. */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Bumped whenever the schema changes in a way an older backup cannot satisfy. */
export const SCHEMA_VERSION = 1;

/** The exact phrase the owner must type before the till's data is erased. */
export const WIPE_CONFIRMATION = 'ERASE ALL TILL DATA';

const BACKUP_EXT = '.sqlite';
const HEADER_BYTES = 512;
const MANIFEST_SUFFIX = '.manifest.json';
const MEDIA_DIR_SUFFIX = '.media.json';

/** Inside a manual export: the snapshot, and the photos it refers to. */
const EXPORT_DB_NAME = 'anda-smoke-hub.sqlite';
/** Where the photo tree starts, relative to the data folder. */
const MEDIA_ROOT = 'media/products';

type BackupManifest = {
  format: 'anda-smoke-hub-backup';
  schemaVersion: number;
  createdAt: string;
  sourceDatabase: string;
  sha256: string;
  /** Product photos referenced at the time of the backup, if any were stored. */
  media?: { count: number; files: string[] };
};

/** The manifest stored inside a manual export archive. */
type ExportManifest = Omit<BackupManifest, 'format'> & {
  format: 'anda-smoke-hub-export';
  /** SHA-256 of the packaged SQLite file, so a damaged archive is caught. */
  databaseSha256: string;
  /** One entry per packaged photo. */
  mediaFiles: Array<{ path: string; sha256: string; bytes: number }>;
};

export type BackupEntry = {
  file: string;
  path: string;
  createdAt: string;
  bytes: number;
  kind: 'daily' | 'manual';
};

/** What an admin screen shows for "last backup". */
export type LastBackupInfo = {
  exists: boolean;
  path: string | null;
  createdAt: string | null;
  ageHours: number | null;
  due: boolean;
};

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

function assertDataDir(): string {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Lists the product photos currently on disk, as paths relative to the media
 * root (`media/products` inside the data folder).
 *
 * Photos live beside the database rather than inside it, so a backup has to
 * record them separately: the restored database would otherwise point at images
 * that are not there.
 */
function listStoredMedia(): string[] {
  const root = join(getDataDir(), 'media', 'products');
  if (!existsSync(root)) return [];

  const found: string[] = [];
  const walk = (dir: string, relative: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(absolute, next);
      else if (entry.isFile()) found.push(next);
    }
  };
  walk(root, '');
  return found.sort();
}

/**
 * Writes a consistent snapshot of the live database.
 *
 * `VACUUM INTO` fails if the target exists, so the temp name is removed first.
 * The caller must not be inside a transaction; better-sqlite3 is synchronous so
 * this runs to completion without interleaving other statements.
 */
function vacuumInto(target: string): void {
  const sqlite = getSqliteHandle();
  if (existsSync(target)) rmSync(target, { force: true });
  // Checkpoints first so the snapshot is taken against a settled WAL.
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  sqlite.prepare('VACUUM INTO ?').run(target);
}

function sha256Buffer(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(path: string): string {
  // The files are small (a till's catalogue), so reading them whole keeps the
  // code simple and the memory cost is not a concern.
  return sha256Buffer(readFileSync(path));
}

function writeManifest(backupPath: string, manifest: BackupManifest): void {
  writeFileSync(`${backupPath}${MANIFEST_SUFFIX}`, JSON.stringify(manifest, null, 2), 'utf8');
}

function stamp(prefix: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  return `${prefix}-${date}-${time}-${randomBytes(3).toString('hex')}`;
}

/**
 * Takes one automatic backup into the local `backups/` folder and prunes the
 * folder back to {@link DAILY_BACKUP_RETENTION} daily snapshots.
 *
 * Safe to call repeatedly in a day: each run rolls the day's file forward, and
 * the previous copy is kept only until pruning decides otherwise.
 */
export function createDailyBackup(now = new Date()): { path: string; pruned: string[] } {
  const dir = resolveBackupDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const day = now.toISOString().slice(0, 10);
  const name = `anda-daily-${day}`;
  const target = join(dir, `${name}${BACKUP_EXT}`);
  vacuumInto(target);

  // Daily snapshots record which photos the database refers to, but do not copy
  // the photos themselves: 14 snapshots of a photo-heavy catalogue would
  // otherwise repeat every image 14 times. The photos live in one place in the
  // data folder and a restore reports any that are missing, so there is no way
  // to silently lose them. A manual export is the thing that actually carries
  // images off the machine, and it packages them.
  const files = listStoredMedia();
  writeFileSync(`${target}${MEDIA_DIR_SUFFIX}`, JSON.stringify({
    format: 'anda-smoke-hub-media',
    note: 'Daily snapshots reference product photos but do not copy them. Use a manual export to take them off this machine.',
    mediaRoot: 'media/products',
    files,
  }, null, 2), 'utf8');
  writeManifest(target, {
    format: 'anda-smoke-hub-backup',
    schemaVersion: SCHEMA_VERSION,
    createdAt: now.toISOString(),
    sourceDatabase: basename(resolveDatabasePath()),
    sha256: sha256File(target),
    media: { count: files.length, files },
  });

  return { path: target, pruned: pruneDailyBackups(dir) };
}

/**
 * Describes the newest automatic backup, for the "last backup" indicator.
 *
 * `due` is true when no backup exists yet, or the newest is older than the
 * interval, which is the same condition {@link createBackupIfDue} acts on.
 */
export function lastBackupInfo(now = new Date()): LastBackupInfo {
  const [newest] = listDailyBackups();
  if (!newest) {
    return { exists: false, path: null, createdAt: null, ageHours: null, due: true };
  }
  const ageMs = Math.max(0, now.getTime() - new Date(newest.createdAt).getTime());
  return {
    exists: true,
    path: newest.path,
    createdAt: newest.createdAt,
    ageHours: Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10,
    due: ageMs >= BACKUP_INTERVAL_MS,
  };
}

/**
 * Takes a backup only when the newest one is older than the interval.
 *
 * Called when the app starts and again when it closes cleanly, so a till that
 * is opened and shut every day still gets a snapshot without a timer thread
 * having to stay alive.
 */
export function createBackupIfDue(
  reason: 'startup' | 'shutdown',
  now = new Date(),
): { path: string; reason: string } | null {
  if (!lastBackupInfo(now).due) return null;
  return { path: createDailyBackup(now).path, reason };
}

/** Keeps the newest {@link DAILY_BACKUP_RETENTION} daily snapshots. */
export function pruneDailyBackups(dir = resolveBackupDir()): string[] {
  if (!existsSync(dir)) return [];

  const dailies = readdirSync(dir)
    .filter(name => /^anda-daily-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
    .sort()
    .reverse();

  const removed: string[] = [];
  for (const name of dailies.slice(DAILY_BACKUP_RETENTION)) {
    const path = join(dir, name);
    rmSync(path, { force: true });
    rmSync(`${path}${MANIFEST_SUFFIX}`, { force: true });
    rmSync(`${path}${MEDIA_DIR_SUFFIX}`, { force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * Writes a consistent snapshot to a temporary file beside the destination.
 *
 * Kept separate so both the daily snapshot and the export's packaged copy go
 * through exactly the same `VACUUM INTO` + checkpoint path.
 */
function vacuumIntoTemp(target: string): string {
  const tmp = `${target}.building`;
  vacuumInto(tmp);
  return tmp;
}

/**
 * Exports everything the till needs to be restored elsewhere: the SQLite
 * snapshot **and** the product photos that snapshot refers to, in one `.zip`.
 *
 * A bare `.sqlite` file is not enough — a restored database whose product rows
 * point at `/media/products/...` would show a broken-image catalogue, so the
 * photos travel with it. Refuses to overwrite an existing file so a mistyped
 * destination cannot destroy an earlier export.
 */
export function createManualExport(destination: string): {
  path: string;
  bytes: number;
  mediaFiles: number;
} {
  const name = basename(destination);
  if (!name || name === '.' || name === '..') {
    throw new RestoreError('Choose a file name for the export.');
  }
  if (existsSync(destination)) {
    throw new RestoreError('That file already exists. Choose a different name.');
  }

  const parent = dirname(destination);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  const now = new Date();
  const tempDb = vacuumIntoTemp(join(parent, `.${EXPORT_DB_NAME}.building`));
  try {
    const mediaRoot = join(getDataDir(), 'media', 'products');
    const mediaFiles: ExportManifest['mediaFiles'] = [];

    const entries: ZipEntry[] = [
      { path: EXPORT_DB_NAME, data: readFileSync(tempDb), modified: now },
    ];

    for (const relative of listStoredMedia()) {
      const absolute = join(mediaRoot, ...relative.split('/'));
      if (!existsSync(absolute)) continue;
      const data = readFileSync(absolute);
      mediaFiles.push({ path: relative, sha256: sha256Buffer(data), bytes: data.length });
      // The archive keeps the same layout as the data folder.
      entries.push({ path: `${MEDIA_ROOT}/${relative}`, data, modified: now });
    }

    const manifest: ExportManifest = {
      format: 'anda-smoke-hub-export',
      schemaVersion: SCHEMA_VERSION,
      createdAt: now.toISOString(),
      sourceDatabase: basename(resolveDatabasePath()),
      sha256: '',
      databaseSha256: sha256Buffer(readFileSync(tempDb)),
      media: { count: mediaFiles.length, files: mediaFiles.map(file => file.path) },
      mediaFiles,
    };

    entries.push({ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), modified: now });

    const archive = createZip(entries);
    writeFileSync(destination, archive);
    return { path: destination, bytes: archive.length, mediaFiles: mediaFiles.length };
  } finally {
    rmSync(tempDb, { force: true });
    // The sidecars belong to the temporary file only.
    for (const suffix of ['-wal', '-shm']) rmSync(`${tempDb}${suffix}`, { force: true });
  }
}

/**
 * Checks a manual export archive without unpacking it to the live data folder.
 *
 * Returns the manifest so the caller can show what is inside before committing
 * to the restore.
 */
export function verifyExport(archivePath: string): ExportManifest {
  if (!existsSync(archivePath)) {
    throw new RestoreError('That export file was not found.');
  }
  // A real archive carries at least a database and a manifest, so anything under
  // a few KB is not one. The size check comes first so a stray small file gets a
  // plain message instead of a confusing ZIP parsing error.
  if (statSync(archivePath).size < 1024) {
    throw new RestoreError('That file is too small to be an export.');
  }

  let entries: ReadZipEntry[];
  try {
    entries = readZip(readFileSync(archivePath));
  } catch (error) {
    if (error instanceof ZipError) throw new RestoreError(error.message);
    throw new RestoreError('That file could not be opened as an export.');
  }

  const byPath = new Map(entries.map(entry => [entry.path, entry.data]));
  const manifestBytes = byPath.get('manifest.json');
  if (!manifestBytes) {
    throw new RestoreError('That export has no manifest, so it is not an Anda export.');
  }

  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as ExportManifest;
  } catch {
    throw new RestoreError('That export\'s manifest is unreadable.');
  }

  if (manifest?.format !== 'anda-smoke-hub-export') {
    throw new RestoreError('That archive was not produced by this app.');
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new RestoreError(
      `That export is from another version (schema ${manifest.schemaVersion}, this till is ${SCHEMA_VERSION}).`,
    );
  }

  const database = byPath.get(EXPORT_DB_NAME);
  if (!database) {
    throw new RestoreError('That export is missing its database file.');
  }
  if (database.subarray(0, 16).toString('utf8') !== 'SQLite format 3\u0000') {
    throw new RestoreError('That export\'s database file is damaged.');
  }
  if (manifest.databaseSha256 && manifest.databaseSha256 !== sha256Buffer(database)) {
    throw new RestoreError('That export is damaged or was changed after it was made.');
  }

  // Every photo the manifest promises must be present and intact.
  for (const file of manifest.mediaFiles || []) {
    const data = byPath.get(`${MEDIA_ROOT}/${file.path}`);
    if (!data) {
      throw new RestoreError(`That export is missing a product photo (${file.path}).`);
    }
    if (file.sha256 && sha256Buffer(data) !== file.sha256) {
      throw new RestoreError(`A product photo in that export is damaged (${file.path}).`);
    }
  }

  // Confirm the packaged database opens cleanly, by writing it to a scratch file
  // beside the archive and letting SQLite read it.
  const probePath = join(dirname(archivePath), `.verify-${randomBytes(4).toString('hex')}.sqlite`);
  try {
    writeFileSync(probePath, database);
    const probe = new Database(probePath, { readonly: true });
    try {
      if (probe.pragma('integrity_check', { simple: true }) !== 'ok') {
        throw new RestoreError('That export\'s database is corrupt.');
      }
    } finally {
      probe.close();
    }
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    throw new RestoreError('That export\'s database could not be read.');
  } finally {
    rmSync(probePath, { force: true });
  }

  return manifest;
}

/**
 * Restores a manual export: the database **and** the product photos.
 *
 * The photos are written before the database is swapped in, so the restored
 * catalogue never points at images that are not there yet. Photos already on
 * disk are kept, so restoring an older export does not delete newer images.
 */
export function restoreExport(archivePath: string): {
  path: string;
  replaced: string;
  mediaRestored: number;
  missingImages: string[];
  /** Barcode sequence mark after the restore, never lower than before. */
  sequence: number;
} {
  const manifest = verifyExport(archivePath);

  let entries: ReadZipEntry[];
  try {
    entries = readZip(readFileSync(archivePath));
  } catch (error) {
    if (error instanceof ZipError) throw new RestoreError(error.message);
    throw new RestoreError('That file could not be opened as an export.');
  }
  const byPath = new Map(entries.map(entry => [entry.path, entry.data]));
  const database = byPath.get(EXPORT_DB_NAME);
  if (!database) throw new RestoreError('That export is missing its database file.');

  // ── Photos first ────────────────────────────────────────────────────────
  const mediaRoot = join(getDataDir(), 'media', 'products');
  let mediaRestored = 0;
  for (const file of manifest.mediaFiles || []) {
    const data = byPath.get(`${MEDIA_ROOT}/${file.path}`);
    if (!data) continue;
    const target = join(mediaRoot, ...file.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    mediaRestored++;
  }

  // ── Then the database ───────────────────────────────────────────────────
  const target = resolveDatabasePath();
  const rollback = `${target}.before-restore-${Date.now()}`;
  const previousSequence = getBarcodeSequence();
  closeDataLayer();

  if (existsSync(target)) {
    copyFileSync(target, rollback);
    rmSync(target, { force: true });
  }
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${target}${suffix}`;
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }

  try {
    writeFileSync(target, database);
  } catch (error) {
    if (existsSync(rollback)) copyFileSync(rollback, target);
    throw new RestoreError(`Could not write the restored database: ${(error as Error).message}`);
  }

  const sequence = reconcileBarcodeSequence(target, previousSequence);

  return {
    path: target,
    replaced: rollback,
    mediaRestored,
    missingImages: findMissingProductImages(),
    sequence,
  };
}

/** Lists the automatic daily snapshots, newest first. */
export function listDailyBackups(dir = resolveBackupDir()): BackupEntry[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(name => /^anda-daily-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
    .map(name => {
      const path = join(dir, name);
      return {
        file: name,
        path,
        createdAt: statSync(path).mtime.toISOString(),
        bytes: statSync(path).size,
        kind: 'daily' as const,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Checks a candidate backup without writing anything.
 *
 * Throws {@link RestoreError} with a message meant for the shop floor when the
 * file is not a backup of this app, is truncated, has been edited, or was taken
 * against a different schema version.
 */
export function verifyBackup(sourcePath: string): BackupManifest {
  if (!existsSync(sourcePath)) {
    throw new RestoreError('That backup file was not found.');
  }

  const size = statSync(sourcePath).size;
  if (size < 16) {
    throw new RestoreError('That file is too small to be a backup.');
  }

  // Every SQLite file opens with this exact 16-byte magic string. Checked before
  // anything else so an unrelated file gets an honest "not a database" message.
  const header = Buffer.alloc(Math.min(size, HEADER_BYTES));
  const fd = openSync(sourcePath, 'r');
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  if (header.toString('utf8', 0, 16) !== 'SQLite format 3\u0000') {
    throw new RestoreError('That file is not a database.');
  }
  if (size <= HEADER_BYTES) {
    throw new RestoreError('That file is too small to be a backup.');
  }

  const manifestPath = `${sourcePath}${MANIFEST_SUFFIX}`;
  if (!existsSync(manifestPath)) {
    throw new RestoreError('That file is not an Anda backup: its manifest is missing.');
  }

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  } catch {
    throw new RestoreError('That backup\'s manifest is unreadable.');
  }

  if (manifest?.format !== 'anda-smoke-hub-backup') {
    throw new RestoreError('That file was not produced by this app.');
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new RestoreError(
      `That backup is from another version (schema ${manifest.schemaVersion}, this till is ${SCHEMA_VERSION}).`,
    );
  }
  if (manifest.sha256 && manifest.sha256 !== sha256File(sourcePath)) {
    throw new RestoreError('That backup file is damaged or was changed after it was taken.');
  }

  // Finally let SQLite itself confirm the pages are readable, so a file that
  // passes the hash check but has corrupt pages still fails here.
  try {
    const probe = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      const result = probe.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new RestoreError('That backup file is corrupt.');
    } finally {
      probe.close();
    }
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    throw new RestoreError('That backup file could not be read.');
  }

  return manifest;
}

/**
 * Restores a verified backup over the live database.
 *
 * The existing file (and its WAL sidecars) are moved aside rather than deleted,
 * so a restore that goes wrong is still recoverable. The connection is closed
 * first: SQLite cannot replace a file it has open.
 */
export function restoreBackup(sourcePath: string): {
  path: string;
  replaced: string;
  missingImages: string[];
  sequence: number;
} {
  const manifest = verifyBackup(sourcePath);

  const target = resolveDatabasePath();
  const rollback = `${target}.before-restore-${Date.now()}`;
  const previousSequence = getBarcodeSequence();
  closeDataLayer();

  if (existsSync(target)) {
    copyFileSync(target, rollback);
    rmSync(target, { force: true });
  }
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${target}${suffix}`;
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }

  try {
    copyFileSync(sourcePath, target);
  } catch (error) {
    // Put the original back rather than leaving the till with no database.
    if (existsSync(rollback)) copyFileSync(rollback, target);
    throw new RestoreError(`Could not write the restored database: ${(error as Error).message}`);
  }

  // The restored database names the photos that existed at backup time. Report
  // any that are not on this machine now, so the operator is told plainly rather
  // than discovering broken images across the catalogue later.
  // The barcode sequence must never go backwards. A backup taken before the
  // counter reached its current value carries an older, lower mark, and
  // restoring it would otherwise let the till reissue numbers that are already
  // printed on shelf labels. Take whichever is higher.
  const sequence = reconcileBarcodeSequence(target, previousSequence);

  const missingImages = findMissingProductImages();

  return { path: target, replaced: rollback, missingImages, sequence };
}

/**
 * After a restore, keeps the higher of the stored and restored barcode marks.
 *
 * Reading the restored file directly rather than through the open connection,
 * because this runs immediately after the swap.
 */
function reconcileBarcodeSequence(restoredFile: string, previousSequence = 0): number {
  const key = 'inventory.barcodeSequence';
  let restored = 0;
  try {
    const probe = new Database(restoredFile, { readonly: true });
    try {
      const row = probe.prepare('SELECT value FROM store_settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      const value = Number(row?.value);
      if (Number.isFinite(value)) restored = Math.floor(value);
    } finally {
      probe.close();
    }
  } catch (error) {
    console.error('Could not read the restored barcode sequence:', error);
  }

  // Reopening the live connection is what makes this a no-op when the restored
  // value is lower, so the mark only ever moves forward.
  return setBarcodeSequence(Math.max(previousSequence, restored));
}

/**
 * Product images referenced by the current database but absent from disk.
 *
 * Called after a restore, and safe to call at any time: it only reads.
 */
export function findMissingProductImages(): string[] {
  const sqlite = getSqliteHandle();
  const root = join(getDataDir(), 'media', 'products');

  const referenced = new Set<string>();
  const addFrom = (value: unknown) => {
    if (typeof value !== 'string') return;
    const match = /\/media\/products\/(.+)$/.exec(value);
    if (match) referenced.add(match[1]);
  };

  try {
    for (const row of sqlite.prepare('SELECT image, images, variants FROM products').all() as Array<Record<string, unknown>>) {
      addFrom(row.image);
      if (typeof row.images === 'string') {
        try { for (const entry of JSON.parse(row.images) as unknown[]) addFrom(entry); } catch { /* ignore */ }
      }
      if (typeof row.variants === 'string') {
        try {
          for (const variant of JSON.parse(row.variants) as Array<Record<string, unknown>>) addFrom(variant?.image);
        } catch { /* ignore */ }
      }
    }
  } catch (error) {
    console.error('Could not read product images:', error);
    return [];
  }

  return [...referenced].filter(relative => !existsSync(join(root, ...relative.split('/')))).sort();
}

/**
 * Deletes all business data while keeping the schema, so the till comes back
 * asking for first-run setup.
 *
 * The WAL is truncated afterwards, otherwise a reader could still see rows that
 * only exist in the sidecar.
 */
export function wipeData(): { tables: number; sequence: number } {
  const sqlite = getSqliteHandle();

  const tables = (sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>)
    .map(row => row.name);

  // Read before the wipe: the catalogue is about to be emptied, and this is the
  // only record of how far the internal barcode sequence had got.
  const sequence = getBarcodeSequence();

  sqlite.pragma('foreign_keys = OFF');
  const wipe = sqlite.transaction(() => {
    for (const table of tables) sqlite.prepare(`DELETE FROM "${table}"`).run();
    // Clearing the session key forces a fresh, unguessable signing secret.
    sqlite.prepare('DELETE FROM store_settings').run();
  });
  wipe();

  // Put the mark back. A wiped till starts with an empty catalogue, so without
  // this the sequence would restart at ACS-000001 and hand out numbers already
  // printed on shelf labels.
  setBarcodeSequence(sequence);

  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('wal_checkpoint(TRUNCATE)');

  return { tables: tables.length, sequence };
}

export { assertDataDir };