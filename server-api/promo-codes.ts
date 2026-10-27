import type { ApiRequest, ApiResponse } from './_http.js';
import { db } from '../src/db/index.js';
import { promoCodes } from '../src/db/schema.js';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireAdmin } from './_auth.js';
import { AUDIT_ACTIONS, recordAudit } from './_audit.js';
import { cloudConnection, forwardToCloud, isCloudConfigured } from './_cloud-proxy.js';

const promoCreateSchema = z.object({
  id: z.string().optional(),
  code: z.string().min(1).max(50).toUpperCase(),
  discountType: z.enum(['percentage', 'fixed']),
  discountValue: z.number().positive(),
  minSpend: z.number().min(0).optional(),
  isActive: z.boolean().default(true),
  maxUsage: z.number().int().positive().optional(),
  description: z.string().optional(),
  expiryDate: z.string().datetime().optional().nullable(),
});

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const { method, query, body } = req;

  try {
    if (method === 'GET') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager', 'Cashier']);
      if (!auth) return;
      const connection = cloudConnection(req);
      if (connection) {
        await forwardToCloud(req, res, 'promo-codes', connection.origin, connection.token);
        return;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      const results = await db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt));
      return res.status(200).json(results);
    }

    if (method === 'POST') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager']);
      if (!auth) return;
      const connection = cloudConnection(req);
      if (connection) {
        await forwardToCloud(req, res, 'promo-codes', connection.origin, connection.token);
        return;
      }
      if (isCloudConfigured()) {
        return res.status(409).json({ error: 'Connect to the cloud to sync promotions across devices.' });
      }

      const parsed = promoCreateSchema.safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid promo code data', details: parsed.error.flatten() });
      }

      const [newPromo] = await db.insert(promoCodes).values({
        ...parsed.data,
        id: parsed.data.id || `promo-${Date.now()}`,
        discountValue: parsed.data.discountValue,
        minSpend: parsed.data.minSpend,
        expiryDate: parsed.data.expiryDate ? new Date(parsed.data.expiryDate) : null,
      }).returning();

      await recordAudit(auth, {
        action: AUDIT_ACTIONS.DISCOUNT_CHANGED,
        entityType: 'promo_code',
        entityId: newPromo.id,
        metadata: { event: 'created', code: newPromo.code, discountType: newPromo.discountType, discountValue: newPromo.discountValue },
      });

      return res.status(201).json(newPromo);
    }

    if (method === 'PATCH') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager']);
      if (!auth) return;
      const connection = cloudConnection(req);
      if (connection) {
        await forwardToCloud(req, res, 'promo-codes', connection.origin, connection.token);
        return;
      }
      if (isCloudConfigured()) {
        return res.status(409).json({ error: 'Connect to the cloud to sync promotions across devices.' });
      }

      const { id } = query;
      if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: 'Promo code ID is required' });
      }

      const parsed = z.object({
        isActive: z.boolean().optional(),
        discountType: z.enum(['percentage', 'fixed']).optional(),
        discountValue: z.number().positive().optional(),
        minSpend: z.number().min(0).optional(),
        expiryDate: z.string().datetime().optional().nullable(),
        code: z.string().min(1).max(50).optional(),
      }).safeParse(body);

      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid promo update', details: parsed.error.flatten() });
      }

      const updateData = {
        ...parsed.data,
        discountValue: parsed.data.discountValue,
        minSpend: parsed.data.minSpend,
        expiryDate: parsed.data.expiryDate !== undefined ? (parsed.data.expiryDate ? new Date(parsed.data.expiryDate) : null) : undefined,
        updatedAt: new Date(),
      };

      const [previous] = await db.select().from(promoCodes).where(eq(promoCodes.id, id)).limit(1);

      const [updated] = await db.update(promoCodes).set(updateData).where(eq(promoCodes.id, id)).returning();
      if (!updated) {
        return res.status(404).json({ error: 'Promo code not found' });
      }

      await recordAudit(auth, {
        action: AUDIT_ACTIONS.DISCOUNT_CHANGED,
        entityType: 'promo_code',
        entityId: id,
        metadata: {
          event: 'updated',
          code: updated.code,
          previousIsActive: Boolean(previous?.isActive),
          isActive: Boolean(updated.isActive),
          previousDiscountValue: previous?.discountValue ?? null,
          discountValue: updated.discountValue,
        },
      });

      return res.status(200).json(updated);
    }

    if (method === 'DELETE') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager']);
      if (!auth) return;
      const connection = cloudConnection(req);
      if (connection) {
        await forwardToCloud(req, res, 'promo-codes', connection.origin, connection.token);
        return;
      }
      if (isCloudConfigured()) {
        return res.status(409).json({ error: 'Connect to the cloud to sync promotions across devices.' });
      }

      const { id } = query;
      if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: 'Promo code ID is required' });
      }

      const [deleted] = await db.delete(promoCodes).where(eq(promoCodes.id, id)).returning({ id: promoCodes.id, code: promoCodes.code });
      if (!deleted) {
        return res.status(404).json({ error: 'Promo code not found' });
      }

      await recordAudit(auth, {
        action: AUDIT_ACTIONS.DISCOUNT_CHANGED,
        entityType: 'promo_code',
        entityId: id,
        metadata: { event: 'deleted', code: deleted.code },
      });

      return res.status(200).json({ success: true, id: deleted.id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Promo Codes API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}