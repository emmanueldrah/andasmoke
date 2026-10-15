import type { ApiRequest, ApiResponse } from './_http.js';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../src/db/index.js';
import { inventoryMovements, products } from '../src/db/schema.js';
import { requireAdmin } from './_auth.js';
import { AUDIT_ACTIONS, recordAudit } from './_audit.js';

/**
 * Stock-in: goods arriving at the till.
 *
 * Deliberately separate from selling. No money moves and nothing is added to the
 * day's takings — this only raises the quantity on hand and records who added it,
 * so the stock figure a sale draws down can always be reconciled against what was
 * received.
 *
 * The whole adjustment is one transaction, so a failure part-way through cannot
 * leave the quantity raised with no movement row, or the reverse.
 */

const stockInSchema = z.object({
  productId: z.string().trim().min(1),
  variantId: z.string().trim().min(1).optional(),
  quantity: z.number().int().positive('Enter how many units arrived.').max(100_000),
  reason: z.string().trim().max(200).optional(),
});

export default async function handler(req: ApiRequest, res: ApiResponse) {
  // Receiving stock changes the quantity on hand, so it is limited to the roles
  // that already manage the catalogue. A cashier sells what is there; they do
  // not decide what arrived, and giving them that would let a cashier create
  // stock to sell.
  const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager', 'Inventory Dispatcher']);
  if (!auth) return;

  try {
    if (req.method === 'POST' && !req.query.action) {
      const parsed = stockInSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Enter a valid quantity.', details: parsed.error.flatten() });
      }
      const { productId, variantId, quantity } = parsed.data;
      const reason = parsed.data.reason?.trim() || 'Stock received';

      const result = db.transaction((tx) => {
        const [product] = tx.select().from(products).where(eq(products.id, productId)).limit(1).all();
        if (!product) throw new Error('That product is not in the catalogue.');

        let stockAfter: number;

        if (variantId) {
          const variants = product.variants || [];
          const target = variants.find((variant: any) => variant.id === variantId);
          if (!target) throw new Error('That variation no longer exists.');

          const nextVariants = variants.map((variant: any) => variant.id === variantId
            ? { ...variant, stockCount: Math.max(0, Number(variant.stockCount || 0) + quantity), inStock: true }
            : variant);
          stockAfter = nextVariants.reduce(
            (sum: number, variant: any) => sum + Math.max(0, Number(variant.stockCount || 0)),
            0,
          );

          tx.update(products).set({
            variants: nextVariants,
            stockCount: stockAfter,
            inStock: stockAfter > 0,
            isPublished: stockAfter > 0,
            updatedAt: new Date(),
          }).where(eq(products.id, productId)).run();

          tx.insert(inventoryMovements).values({
            productId,
            variantId,
            movementType: 'STOCK_IN',
            quantity,
            quantityBefore: Number(target.stockCount || 0),
            quantityAfter: Number(target.stockCount || 0) + quantity,
            actorName: auth.adminName,
            reason,
          }).run();
        } else {
          stockAfter = Math.max(0, Number(product.stockCount || 0) + quantity);
          tx.update(products).set({
            stockCount: stockAfter,
            inStock: stockAfter > 0,
            // A product that was hidden because it was out of stock comes back
            // as soon as it has something to sell.
            isPublished: stockAfter > 0,
            updatedAt: new Date(),
          }).where(eq(products.id, productId)).run();

          tx.insert(inventoryMovements).values({
            productId,
            movementType: 'STOCK_IN',
            quantity,
            quantityBefore: Number(product.stockCount || 0),
            quantityAfter: stockAfter,
            actorName: auth.adminName,
            reason,
          }).run();
        }

        return {
          productId,
          variantId: variantId ?? null,
          name: product.name,
          quantityBefore: variantId
            ? Number((product.variants || []).find((v: any) => v.id === variantId)?.stockCount || 0)
            : Number(product.stockCount || 0),
          stockAfter,
        };
      });

      await recordAudit(auth, {
        action: AUDIT_ACTIONS.STOCK_ADJUSTED,
        entityType: 'product',
        entityId: productId,
        metadata: {
          via: 'stock-in',
          name: result.name,
          variantId: variantId ?? null,
          quantity,
          quantityBefore: result.quantityBefore,
          quantityAfter: result.stockAfter,
          reason,
        },
      });

      return res.status(201).json(result);
    }

    // Recent movements, for the stock-in screen to show what arrived and when.
    if (req.method === 'GET') {
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
      const rows = await db.select().from(inventoryMovements)
        .orderBy(desc(inventoryMovements.createdAt))
        .limit(limit);
      return res.status(200).json({ movements: rows });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('Stock-in API error:', error);
    if (/not in the catalogue|no longer exists/i.test(error?.message || '')) {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Could not record the stock-in.' });
  }
}