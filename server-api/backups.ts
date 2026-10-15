import type { ApiRequest, ApiResponse } from './_http.js';
import { requireAdmin } from './_auth.js';
import { AUDIT_ACTIONS, listAudit, recordAudit } from './_audit.js';
import {
  DAILY_BACKUP_RETENTION,
  RestoreError,
  WIPE_CONFIRMATION,
  createDailyBackup,
  createManualExport,
  lastBackupInfo,
  listDailyBackups,
  restoreBackup,
  restoreExport,
  verifyBackup,
  verifyExport,
  wipeData,
} from '../src/lib/backup.js';
import { db } from '../src/db/index.js';
import { adminSessions } from '../src/db/schema.js';
import { sql } from 'drizzle-orm';

/** Roles allowed to back up, export and restore. */
const MANAGER_ROLES = ['Super Admin', 'Store Manager'] as const;

/**
 * Reading the list shows filesystem paths, so it is manager-only too — same
 * gate as the actions that change the data.
 */
const MANAGER_ONLY_ACTIONS = new Set(['list', 'verify', 'daily', 'export', 'restore', 'audit']);

/** Actions that need the single owner, not a delegated manager. */
const SUPER_ADMIN_ONLY_ACTIONS = new Set(['wipe']);

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const action = typeof req.query.action === 'string' ? req.query.action : '';

  // Wiping and restoring replace the database the session is stored in, and the
  // backup list exposes filesystem paths, so none of these are reachable by a
  // cashier. Wipe additionally requires the owner rather than a delegated manager.
  const requiredRoles = SUPER_ADMIN_ONLY_ACTIONS.has(action)
    ? ['Super Admin'] as const
    : MANAGER_ONLY_ACTIONS.has(action)
      ? MANAGER_ROLES
      : undefined;

  const auth = await requireAdmin(req, res, requiredRoles);
  if (!auth) return;

  try {
    if (req.method === 'GET' && action === 'list') {
      return res.status(200).json({
        retention: DAILY_BACKUP_RETENTION,
        backups: listDailyBackups(),
        last: lastBackupInfo(),
      });
    }

    // Lets the restore screen show whether a file is usable before committing.
    if (req.method === 'POST' && action === 'verify') {
      const source = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!source) return res.status(400).json({ error: 'Choose a backup file to check.' });
      try {
        // An export archive and a local snapshot are both restorable, so accept
        // whichever the operator picked and report which it turned out to be.
        if (source.toLowerCase().endsWith('.zip')) {
          const exportManifest = verifyExport(source);
          return res.status(200).json({
            valid: true,
            kind: 'export',
            createdAt: exportManifest.createdAt,
            schemaVersion: exportManifest.schemaVersion,
            mediaFiles: exportManifest.mediaFiles.length,
          });
        }
        const manifest = verifyBackup(source);
        return res.status(200).json({
          valid: true,
          kind: 'snapshot',
          createdAt: manifest.createdAt,
          schemaVersion: manifest.schemaVersion,
          mediaFiles: 0,
        });
      } catch (error) {
        if (error instanceof RestoreError) return res.status(400).json({ error: error.message });
        throw error;
      }
    }

    if (req.method === 'POST' && action === 'daily') {
      const result = createDailyBackup();
      await recordAudit(auth, {
        action: AUDIT_ACTIONS.DATA_MAINTENANCE,
        entityType: 'backup',
        entityId: result.path,
        metadata: { event: 'daily-backup', pruned: result.pruned.length },
      });
      return res.status(201).json({ path: result.path, pruned: result.pruned, last: lastBackupInfo() });
    }

    // A manual export is one archive holding the database and its product photos,
    // so it can be copied to a USB stick and restored on another machine.
    if (req.method === 'POST' && action === 'export') {
      const destination = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!destination) return res.status(400).json({ error: 'Choose where to save the export.' });
      const result = createManualExport(destination);
      await recordAudit(auth, {
        action: AUDIT_ACTIONS.DATA_MAINTENANCE,
        entityType: 'backup',
        entityId: result.path,
        metadata: { event: 'manual-export', bytes: result.bytes, mediaFiles: result.mediaFiles },
      });
      return res.status(201).json({
        path: result.path,
        bytes: result.bytes,
        mediaFiles: result.mediaFiles,
        last: lastBackupInfo(),
      });
    }

    if (req.method === 'POST' && action === 'restore') {
      const source = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!source) return res.status(400).json({ error: 'Choose a backup file to restore.' });
      try {
        // A .zip is a full export (database + photos); anything else is a local
        // snapshot of the database alone.
        if (source.toLowerCase().endsWith('.zip')) {
          const exported = restoreExport(source);
          await recordAudit(auth, {
            action: AUDIT_ACTIONS.DATA_MAINTENANCE,
            entityType: 'backup',
            entityId: exported.path,
            metadata: { event: 'restore-export', source, previous: exported.replaced, mediaRestored: exported.mediaRestored, missingImages: exported.missingImages.length },
          });
          return res.status(200).json({
            restored: true,
            kind: 'export',
            path: exported.path,
            previous: exported.replaced,
            mediaRestored: exported.mediaRestored,
            missingImages: exported.missingImages,
          });
        }

        const result = restoreBackup(source);
        // The connection was closed by the restore; log after reopening it.
        await recordAudit(auth, {
          action: AUDIT_ACTIONS.DATA_MAINTENANCE,
          entityType: 'backup',
          entityId: result.path,
          metadata: { event: 'restore', source, previous: result.replaced, missingImages: result.missingImages.length },
        });
        return res.status(200).json({
          restored: true,
          // A bare snapshot carries the database only; photos travel in an export.
          kind: 'snapshot',
          path: result.path,
          previous: result.replaced,
          // Photos are not part of the SQLite file, so say plainly if any are
          // referenced but absent rather than showing broken images later.
          missingImages: result.missingImages,
        });
      } catch (error) {
        if (error instanceof RestoreError) return res.status(400).json({ error: error.message });
        throw error;
      }
    }

    if (req.method === 'POST' && action === 'wipe') {
      const confirmation = typeof req.body?.confirm === 'string' ? req.body.confirm.trim() : '';
      if (confirmation !== WIPE_CONFIRMATION) {
        return res.status(400).json({ error: `Type ${WIPE_CONFIRMATION} exactly to confirm erasing all till data.` });
      }

      // Take a backup first: this is the last chance to preserve the data, and
      // it runs before anything is deleted.
      const safety = createDailyBackup();

      const result = wipeData();
      await recordAudit(auth, {
        action: AUDIT_ACTIONS.DATA_MAINTENANCE,
        entityType: 'database',
        entityId: 'wipe',
        metadata: { event: 'wipe', tables: result.tables, safetyBackup: safety.path },
      });
      return res.status(200).json({ wiped: true, tables: result.tables, safetyBackup: safety.path });
    }

    // The audit trail, newest first. Managers only: it records every account's
    // actions, including failed sign-in attempts, so it is not cashier-readable.
    if (req.method === 'GET' && action === 'audit') {
      const limit = Number(req.query.limit) || 200;
      return res.status(200).json({ entries: await listAudit(limit), actions: AUDIT_ACTIONS });
    }

    if (req.method === 'GET' && !action) {
      // Small health payload an admin screen can show at a glance.
      const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(adminSessions);
      return res.status(200).json({ accounts: Number(count || 0), lastBackup: lastBackupInfo() });
    }

    return res.status(400).json({ error: 'Unknown backup action.' });
  } catch (error: any) {
    console.error('Backup API error:', error);
    if (error instanceof RestoreError) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: 'The backup operation failed.' });
  }
}