import type { ApiRequest, ApiResponse } from './_http.js';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../src/db/index.js';
import { auditLogs, heldSales } from '../src/db/schema.js';
import { requireAdmin } from './_auth.js';
import { AUDIT_ACTIONS } from './_audit.js';

/**
 * Held (parked) sales.
 *
 * A ticket the cashier sets aside while serving the next customer. Kept in the
 * database so it survives a refresh, a crash, and a shift change — a held sale
 * in browser storage would be lost the moment the till restarted.
 *
 * Recall puts the ticket back on the counter but does **not** delete it: the
 * original record is kept until the sale is rung up or the hold is discarded,
 * so an interrupted recall cannot lose the customer's items.
 */

const holdSchema = z.object({
  items: z.array(z.unknown()).min(1, 'A held sale needs at least one line.'),
  subtotal: z.coerce.number().min(0),
  discount: z.coerce.number().min(0).default(0),
  total: z.coerce.number().min(0),
  promoCode: z.string().trim().max(50).optional(),
  paymentMethod: z.string().trim().max(40).optional(),
  cashReceived: z.coerce.number().nonnegative().optional(),
  deviceId: z.string().trim().max(100).optional(),
  ticketLabel: z.string().trim().max(40).optional(),
});

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    // Any staff member may park or recall their own ticket; recall is part of
    // serving a customer, not a money decision.
    const auth = await requireAdmin(req, res);
    if (!auth) return;

    if (req.method === 'GET') {
      const rows = await db.select().from(heldSales).orderBy(desc(heldSales.createdAt)).limit(100);
      return res.status(200).json({ heldSales: rows });
    }

    if (req.method === 'POST' && !req.query.action) {
      const parsed = holdSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'That ticket cannot be held.', details: parsed.error.flatten() });
      }
      const { items, subtotal, discount, total, promoCode, paymentMethod, cashReceived, deviceId, ticketLabel } = parsed.data;

      const [created] = await db.insert(heldSales).values({
        // Label the ticket so a queue of held sales is recognisable at a glance.
        ticketLabel: ticketLabel || `Held ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        items,
        subtotal,
        discount,
        total,
        promoCode: promoCode || null,
        paymentMethod: paymentMethod || null,
        cashReceived: cashReceived ?? null,
        deviceId: deviceId || null,
        heldBy: auth.adminName || auth.email,
      }).returning();

      await db.insert(auditLogs).values({
        action: AUDIT_ACTIONS.HELD_SALE,
        entityType: 'held_sale',
        entityId: created.id,
        actorName: auth.adminName,
        metadata: { adminId: auth.sub, event: 'held', total, lineCount: items.length },
      });

      return res.status(201).json(created);
    }

    // ── Recall: return the ticket to the counter ───────────────────────────
    if (req.method === 'POST' && req.query.action === 'recall') {
      const id = typeof req.body?.id === 'string' ? req.body.id : typeof req.query.id === 'string' ? req.query.id : '';
      if (!id) return res.status(400).json({ error: 'Which held sale should be recalled?' });

      const [held] = await db.select().from(heldSales).where(eq(heldSales.id, id)).limit(1);
      if (!held) return res.status(404).json({ error: 'That held sale is no longer available.' });
      if (held.recalledAt) {
        return res.status(409).json({ error: 'That held sale has already been recalled.' });
      }

      await db.update(heldSales).set({ recalledAt: new Date() }).where(eq(heldSales.id, id));

      await db.insert(auditLogs).values({
        action: AUDIT_ACTIONS.HELD_SALE,
        entityType: 'held_sale',
        entityId: id,
        actorName: auth.adminName,
        metadata: { adminId: auth.sub, event: 'recalled', total: held.total },
      });

      return res.status(200).json({ ...held, recalledAt: new Date() });
    }

    // ── Discard: throw the hold away without ringing it up ─────────────────
    if (req.method === 'DELETE') {
      const id = typeof req.query.id === 'string' ? req.query.id : '';
      if (!id) return res.status(400).json({ error: 'Which held sale should be discarded?' });

      const [deleted] = await db.delete(heldSales).where(eq(heldSales.id, id)).returning({ id: heldSales.id });
      if (!deleted) return res.status(404).json({ error: 'That held sale is no longer available.' });

      await db.insert(auditLogs).values({
        action: AUDIT_ACTIONS.HELD_SALE,
        entityType: 'held_sale',
        entityId: id,
        actorName: auth.adminName,
        metadata: { adminId: auth.sub, event: 'discarded' },
      });

      return res.status(200).json({ discarded: true, id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Held sales API error:', error);
    if (/already been recalled|no longer available/i.test(error?.message || '')) {
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Could not reach the held sales.' });
  }
}