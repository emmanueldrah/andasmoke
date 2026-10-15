import type { ApiRequest, ApiResponse } from './_http.js';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { posSyncQueue } from '../src/db/schema.js';
import { requireAdmin } from './_auth.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    const action = req.query.action || 'status';
    const cloudOrigin = (process.env.ANDA_CLOUD_API_ORIGIN || 'https://andasmoke.vercel.app').replace(/\/+$/, '');

    // ── Status (accessible to all authenticated staff to drive UI indicator) ─
    if (req.method === 'GET' && action === 'status') {
      const [pendingRow] = await db.select({ count: sql<number>`count(*)` })
        .from(posSyncQueue)
        .where(eq(posSyncQueue.status, 'PENDING'));

      const [syncedRow] = await db.select({ count: sql<number>`count(*)` })
        .from(posSyncQueue)
        .where(eq(posSyncQueue.status, 'SYNCED'));

      const [failedRow] = await db.select({ count: sql<number>`count(*)` })
        .from(posSyncQueue)
        .where(eq(posSyncQueue.status, 'FAILED'));

      const [lastSync] = await db.select({ syncedAt: posSyncQueue.syncedAt })
        .from(posSyncQueue)
        .where(eq(posSyncQueue.status, 'SYNCED'))
        .orderBy(desc(posSyncQueue.syncedAt))
        .limit(1);

      return res.status(200).json({
        pendingCount: Number(pendingRow?.count || 0),
        syncedCount: Number(syncedRow?.count || 0),
        failedCount: Number(failedRow?.count || 0),
        lastSyncedAt: lastSync?.syncedAt ? lastSync.syncedAt.toISOString() : null,
        cloudOrigin,
      });
    }

    // ── Flush queue to cloud ─────────────────────────────────────────────
    if (req.method === 'POST' && action === 'flush') {
      const pendingItems = await db.select()
        .from(posSyncQueue)
        .where(eq(posSyncQueue.status, 'PENDING'))
        .orderBy(posSyncQueue.createdAt)
        .limit(25);

      if (pendingItems.length === 0) {
        return res.status(200).json({ flushed: 0, pending: 0, message: 'All sales are already synced' });
      }

      let flushed = 0;
      let isOffline = false;
      const authHeader = req.headers.authorization || '';

      for (const item of pendingItems) {
        try {
          const cloudResponse = await fetch(`${cloudOrigin}/api/orders?channel=pos`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(authHeader ? { Authorization: authHeader } : {}),
            },
            body: JSON.stringify(item.payload),
          });

          const bodyText = await cloudResponse.text();
          let parsed: any = {};
          try { parsed = JSON.parse(bodyText); } catch {}

          // 200/201 = success; 409 with idempotency/existing = already synced
          if (cloudResponse.ok || (cloudResponse.status === 409 && /already|idempotenc/i.test(bodyText))) {
            await db.update(posSyncQueue)
              .set({
                status: 'SYNCED',
                syncedAt: new Date(),
                errorMessage: null,
              })
              .where(eq(posSyncQueue.id, item.id));
            flushed++;
          } else {
            // Server error or rejection
            const nextRetries = item.retryCount + 1;
            await db.update(posSyncQueue)
              .set({
                retryCount: nextRetries,
                errorMessage: parsed.error || bodyText.slice(0, 200),
                status: nextRetries >= 5 ? 'FAILED' : 'PENDING',
              })
              .where(eq(posSyncQueue.id, item.id));
          }
        } catch (fetchErr: any) {
          // Network disconnect / offline
          isOffline = true;
          break;
        }
      }

      const [remainingRow] = await db.select({ count: sql<number>`count(*)` })
        .from(posSyncQueue)
        .where(eq(posSyncQueue.status, 'PENDING'));

      return res.status(200).json({
        flushed,
        pending: Number(remainingRow?.count || 0),
        offline: isOffline,
      });
    }

    return res.status(400).json({ error: 'Unknown sync action' });
  } catch (error: any) {
    console.error('POS sync error:', error);
    return res.status(500).json({ error: error?.message || 'Sync failed' });
  }
}
