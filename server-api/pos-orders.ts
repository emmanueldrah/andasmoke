import type { ApiRequest, ApiResponse } from './_http.js';
import { randomBytes } from 'crypto';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../src/db/index.js';
import { auditLogs, inventoryMovements, orders, posPayments, products, promoCodes } from '../src/db/schema.js';
import { requireAdmin } from './_auth.js';
import {
  applyPercentageMinor,
  formatMoney,
  multiplyMinor,
  requireMinor,
  toMajor,
} from '../src/lib/money.js';

const saleSchema = z.object({
  items: z.array(z.object({
    product: z.object({ id: z.string(), price: z.coerce.number() }),
    quantity: z.number().int().positive(),
    selectedVariant: z.object({ id: z.string() }).optional(),
    priceType: z.enum(['retail', 'wholesale']).optional(),
  })).min(1),
  subtotal: z.coerce.number().positive(),
  shippingFee: z.coerce.number().min(0),
  discount: z.coerce.number().min(0),
  total: z.coerce.number().positive(),
  appliedPromoCode: z.string().trim().max(50).optional(),
  paymentMethod: z.enum(['cash-on-delivery', 'momo-mtn']),
  paymentReference: z.string().trim().max(100).optional(),
  paymentSenderPhone: z.string().trim().max(50).optional(),
  cashReceived: z.coerce.number().nonnegative().optional(),
  idempotencyKey: z.string().trim().min(12).max(160),
  deviceId: z.string().trim().max(100).optional(),
  shippingAddress: z.object({
    fullName: z.string().min(1),
    phone: z.string().min(1),
    city: z.string().min(1),
    area: z.string().min(1),
  }),
});

/**
 * One tender towards a sale.
 *
 * `tendered` is what the customer handed over, which may exceed the amount they
 * are paying for when the tender is cash: that surplus becomes change.
 */
const tenderSchema = z.object({
  method: z.enum(['cash-on-delivery', 'momo-mtn']),
  // Minor units. Required, so the server never has to guess what was paid with.
  amount: z.number().int().positive('Enter an amount greater than zero.'),
  reference: z.string().trim().max(100).optional(),
  senderPhone: z.string().trim().max(50).optional(),
});

/**
 * Refunds and voids both move stock back and change the till's takings, so
 * each needs a written reason that lands in the audit log.
 */
const reasonSchema = z.object({
  reason: z.string().trim().min(3, 'A reason of at least 3 characters is required.').max(200),
});
const refundSchema = reasonSchema.extend({ orderId: z.string().uuid() });
/**
 * Kept for the few places that still hold a cedi float. Every calculation that
 * decides what a customer pays uses integer pesewas instead; see money.ts.
 */
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function createOrderNumber() {
  const now = new Date();
  const date = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `POS-${date}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method === 'GET') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager', 'Inventory Dispatcher', 'Cashier']);
      if (!auth) return;
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const results = await db.select().from(orders)
        .where(eq(orders.orderSource, 'pos'))
        .orderBy(desc(orders.createdAt)).limit(limit).offset(offset);
      return res.status(200).json({ orders: results, pagination: { limit, offset } });
    }

    if (req.method === 'POST' && req.query.action === 'refund') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager']);
      if (!auth) return;
      const parsed = refundSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'A valid POS sale and a reason are required for a refund.', details: parsed.error.flatten() });
      }
      const refundReason = parsed.data.reason;

      // SQLite: better-sqlite3 is synchronous and single-writer, so the whole
      // callback is atomic on its own. No row locks and no advisory locks are
      // needed — the unique index on idempotencyKey is the duplicate guard.
      const refunded = db.transaction((tx) => {
        const [order] = tx.select().from(orders).where(eq(orders.id, parsed.data.orderId)).limit(1).all();
        if (!order || order.orderSource !== 'pos') throw new Error('POS sale not found.');
        if (order.status === 'Refunded') throw new Error('This POS sale has already been refunded.');

        const productIds = [...new Set(order.items.map(item => item.product.id))].sort();
        const locked = tx.select().from(products).where(inArray(products.id, productIds)).orderBy(asc(products.id)).all();
        const byId = new Map(locked.map(product => [product.id, product]));
        for (const item of order.items) {
          const product = byId.get(item.product.id);
          if (!product) continue;
          const variantId = item.selectedVariant?.id;
          if (variantId) {
            const priorVariant = (product.variants || []).find(variant => variant.id === variantId);
            if (!priorVariant) throw new Error(`Variation for ${product.name} no longer exists.`);
            const nextVariants = (product.variants || []).map(variant => variant.id === variantId
              ? { ...variant, stockCount: Number(variant.stockCount || 0) + item.quantity, inStock: true }
              : variant);
            const nextStock = nextVariants.reduce((sum, variant) => sum + Number(variant.stockCount || 0), 0);
            tx.update(products).set({ variants: nextVariants, stockCount: nextStock, inStock: true, isPublished: true, updatedAt: new Date() }).where(eq(products.id, product.id)).run();
            tx.insert(inventoryMovements).values({ productId: product.id, variantId, orderId: order.id, movementType: 'POS_REFUND', quantity: item.quantity, quantityBefore: Number(priorVariant.stockCount || 0), quantityAfter: Number(priorVariant.stockCount || 0) + item.quantity, actorName: auth.adminName, reason: `Refund: ${refundReason}` }).run();
            byId.set(product.id, { ...product, variants: nextVariants, stockCount: nextStock, inStock: true, isPublished: true });
          } else {
            const nextStock = product.stockCount + item.quantity;
            tx.update(products).set({ stockCount: nextStock, inStock: true, isPublished: true, updatedAt: new Date() }).where(eq(products.id, product.id)).run();
            tx.insert(inventoryMovements).values({ productId: product.id, orderId: order.id, movementType: 'POS_REFUND', quantity: item.quantity, quantityBefore: product.stockCount, quantityAfter: nextStock, actorName: auth.adminName, reason: `Refund: ${refundReason}` }).run();
            byId.set(product.id, { ...product, stockCount: nextStock, inStock: true, isPublished: true });
          }
        }

        tx.update(posPayments).set({ status: 'REFUNDED' }).where(eq(posPayments.orderId, order.id)).run();
        tx.insert(auditLogs).values({ action: 'POS_SALE_REFUNDED', entityType: 'order', entityId: order.id, actorName: auth.adminName, metadata: { orderNumber: order.orderNumber, adminId: auth.sub, reason: refundReason } }).run();
        const [updated] = tx.update(orders).set({ status: 'Refunded', updatedAt: new Date() }).where(eq(orders.id, order.id)).returning().all();
        return updated;
      });
      return res.status(200).json(refunded);
    }

    if (req.method === 'POST' && !req.query.action) {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager', 'Cashier']);
      if (!auth) return;
      if (req.query.channel !== 'pos') return res.status(404).json({ error: 'POS sales only.' });
      const parsed = saleSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid POS sale.', details: parsed.error.flatten() });

      const sale = parsed.data;

      // A cashier may ring up a plain sale, but handing out money needs a
      // manager. Without this a cashier could discount their own ticket.
      if (sale.appliedPromoCode || sale.discount > 0) {
        if (auth.adminRole === 'Cashier') {
          return res.status(403).json({ error: 'Only a manager can apply a promo or discount. Ask a manager to approve this sale.' });
        }
      }
      if (sale.shippingFee !== 0) return res.status(400).json({ error: 'Counter sales cannot include delivery fees.' });
      const hasExplicitTenders = Array.isArray(req.body?.tenders) && req.body.tenders.length > 0;
      if (!hasExplicitTenders && sale.paymentMethod === 'momo-mtn' && (!sale.paymentReference || !sale.paymentSenderPhone)) {
        return res.status(400).json({ error: 'Mobile-money reference and sender phone are required.' });
      }

      const created = db.transaction((tx) => {
        const [existing] = tx.select().from(orders).where(eq(orders.idempotencyKey, sale.idempotencyKey)).limit(1).all();
        if (existing) return existing;

        const productIds = [...new Set(sale.items.map(item => item.product.id))].sort();
        const lockedProducts = tx.select().from(products).where(inArray(products.id, productIds)).orderBy(asc(products.id)).all();
        const byId = new Map(lockedProducts.map(product => [product.id, product]));
        const productQuantities = new Map<string, number>();
        const variantQuantities = new Map<string, number>();
        // All arithmetic below is in pesewas, so the total a customer is charged
        // is exactly the sum of the printed lines.
        let calculatedSubtotal = 0;

        const verifiedItems = sale.items.map(item => {
          const product = byId.get(item.product.id);
          if (!product || !product.isPublished) throw new Error(`Product is unavailable: ${item.product.id}`);
          const variantId = item.selectedVariant?.id;
          const variant = variantId ? (product.variants || []).find(entry => entry.id === variantId) : undefined;
          if (variantId && !variant) throw new Error(`Product variation is unavailable: ${product.name}`);
          if ((product.variants || []).length > 0 && !variant) throw new Error(`Choose a variation for ${product.name}.`);
          const key = variant ? `${product.id}:${variant.id}` : product.id;
          const quantities = variant ? variantQuantities : productQuantities;
          quantities.set(key, (quantities.get(key) || 0) + item.quantity);
          // Unit price in pesewas. The product row carries the authoritative integer
          // where one exists; the REAL column is the fallback for rows written
          // before the migration.
          const retailMinor = product.pricePesewas ?? requireMinor(variant?.price ?? product.price, 'price');
          const wholesaleMinor = variant?.wholesalePrice != null
            ? requireMinor(variant.wholesalePrice, 'wholesale price')
            : product.wholesalePrice != null
              ? requireMinor(product.wholesalePrice, 'wholesale price')
              : null;

          // Older clients signal wholesale by sending the wholesale unit price.
          const enteredMinor = requireMinor(item.product.price, 'price');
          const priceType = item.priceType ?? (wholesaleMinor != null && Math.abs(enteredMinor - wholesaleMinor) <= 1 ? 'wholesale' : 'retail');
          if (priceType === 'wholesale' && wholesaleMinor == null) throw new Error(`Wholesale price is not set for ${product.name}.`);
          const unitPriceMinor = priceType === 'wholesale' ? wholesaleMinor! : retailMinor;
          const unitPrice = toMajor(unitPriceMinor);
          // Rounded per line in pesewas, so the printed lines add up to the printed total.
          calculatedSubtotal += unitPriceMinor * item.quantity;
          return {
            product: {
              id: product.id,
              name: product.name,
              brand: product.brand,
              price: unitPrice,
              image: variant?.image || product.image,
              unit: product.unit,
              category: product.category,
              inStock: product.inStock,
              stockCount: product.stockCount,
            },
            quantity: item.quantity,
            selectedVariant: variant ? { id: variant.id, name: variant.name, price: unitPrice, inStock: variant.inStock } : undefined,
            priceType,
          };
        });

        // ── Split payments ─────────────────────────────────────────────────
        // One tender, or several. Either way the amounts must add up to the sale
        // exactly: a shortfall means the customer has not paid, and an excess on
        // a card or mobile-money tender means the till would owe money it cannot
        // give back.
        const tenders = (req.body?.tenders as unknown[] | undefined) ?? null;
        let tenderRows: Array<z.infer<typeof tenderSchema>>;

        if (Array.isArray(tenders) && tenders.length > 0) {
          const parsedTenders = z.array(tenderSchema).min(1).max(4).safeParse(tenders);
          if (!parsedTenders.success) {
            throw new Error('One of the payments is not valid.');
          }
          tenderRows = parsedTenders.data;
        } else {
          // The single-tender form the counter sends.
          const cashTendered = sale.paymentMethod === 'cash-on-delivery' && sale.cashReceived != null
            ? requireMinor(sale.cashReceived, 'cash received')
            : null;
          tenderRows = [{
            method: sale.paymentMethod,
            amount: cashTendered != null ? Math.min(cashTendered, calculatedSubtotal) : 0,
            reference: sale.paymentReference || undefined,
            senderPhone: sale.paymentSenderPhone || undefined,
          }];
        }

        let discount = 0;
        let promoCode: string | undefined;
        let promoUsageCount = 0;
        if (sale.appliedPromoCode) {
          const [promo] = tx.select().from(promoCodes).where(eq(promoCodes.code, sale.appliedPromoCode.toUpperCase())).limit(1).all();
          if (!promo || !promo.isActive || (promo.expiryDate && promo.expiryDate < new Date()) || (promo.maxUsage != null && promo.usageCount >= promo.maxUsage)) {
            throw new Error('Promo code is no longer valid.');
          }
          if (promo.minSpend != null && calculatedSubtotal < (promo.minSpendPesewas ?? requireMinor(promo.minSpend, 'minimum spend'))) {
            throw new Error('Sale does not meet the promo minimum.');
          }
          discount = promo.discountType === 'percentage'
            ? applyPercentageMinor(calculatedSubtotal, Math.round(Number(promo.discountValue)))
            : Math.min(calculatedSubtotal, promo.discountValuePesewas ?? requireMinor(promo.discountValue, 'discount'));
          promoCode = promo.code;
          promoUsageCount = promo.usageCount;
        }

        const total = calculatedSubtotal - discount;

        // The client's figures are a convenience, not the truth. Compare in
        // pesewas so a stale or tampered total cannot slip through on a
        // rounding difference.
        const claimedSubtotal = requireMinor(sale.subtotal, 'subtotal');
        const claimedDiscount = requireMinor(sale.discount, 'discount');
        const claimedTotal = requireMinor(sale.total, 'total');
        if (claimedSubtotal !== calculatedSubtotal || claimedDiscount !== discount || claimedTotal !== total) {
          throw new Error('Sale pricing changed. Review the ticket and try again.');
        }

        // ── The tenders must cover the total exactly ───────────────────────
        let change = 0;
        const appliedTenders: typeof tenderRows = [];

        for (const tender of tenderRows) {
          if (tender.method === 'momo-mtn' && (!tender.reference || !tender.senderPhone)) {
            throw new Error('Mobile-money reference and sender phone are required.');
          }
          const remaining = total - appliedTenders.reduce((sum, applied) => sum + applied.amount, 0);
          if (tender.amount > remaining) {
            if (tender.method === 'cash-on-delivery') {
              // Cash may exceed what is owed: the surplus is change.
              change = tender.amount - remaining;
              appliedTenders.push({ ...tender, amount: remaining });
            } else {
              // A card or mobile-money tender is an exact amount: there is no
              // drawer to hand change from, so an overpayment is a mistake.
              throw new Error(
                `The ${tender.method === 'momo-mtn' ? 'mobile money' : 'non-cash'} payment is ${formatMoney(tender.amount - remaining)} more than is still owed. A non-cash payment must match the amount exactly.`,
              );
            }
          } else {
            appliedTenders.push(tender);
          }
        }

        const tendered = appliedTenders.reduce((sum, tender) => sum + tender.amount, 0);
        if (tendered !== total) {
          throw new Error(
            tendered < total
              ? `The payments are ${formatMoney(total - tendered)} short of the sale total.`
              : `The payments do not match the sale total.`,
          );
        }

        for (const [id, quantity] of productQuantities) {
          const product = byId.get(id)!;
          if (!product.inStock || product.stockCount < quantity) throw new Error(`Insufficient stock for ${product.name}.`);
        }
        for (const [key, quantity] of variantQuantities) {
          const [productId, variantId] = key.split(':');
          const variant = byId.get(productId)?.variants?.find(entry => entry.id === variantId);
          if (!variant || !variant.inStock || Number(variant.stockCount || 0) < quantity) throw new Error('A selected variation has insufficient stock.');
        }

        const orderNumber = createOrderNumber();
        const [order] = tx.insert(orders).values({
          orderNumber,
          items: verifiedItems,
          // The REAL columns are display mirrors; the pesewa columns are what
          // every calculation reads.
          subtotal: toMajor(calculatedSubtotal),
          subtotalPesewas: calculatedSubtotal,
          shippingFee: 0,
          discount: toMajor(discount),
          discountPesewas: discount,
          total: toMajor(total),
          totalPesewas: total,
          paymentMethod: appliedTenders[0]?.method || sale.paymentMethod,
          paymentStatus: 'paid',
          orderSource: 'pos',
          deliveryMethod: 'store-pickup',
          shippingAddress: { ...sale.shippingAddress, email: undefined },
          status: 'Delivered',
          appliedPromoCode: promoCode,
          paymentReference: appliedTenders.find(t => t.method === 'momo-mtn')?.reference || undefined,
          paymentSenderPhone: appliedTenders.find(t => t.method === 'momo-mtn')?.senderPhone || undefined,
          idempotencyKey: sale.idempotencyKey,
          cashierName: auth.adminName || auth.email,
        }).returning().all();

        if (promoCode) tx.update(promoCodes).set({ usageCount: promoUsageCount + 1, updatedAt: new Date() }).where(eq(promoCodes.code, promoCode)).run();
        // Discounts are money leaving the till, so record what was given away.
        if (promoCode || discount > 0) {
          tx.insert(auditLogs).values({
            action: 'POS_DISCOUNT_APPLIED',
            entityType: 'order',
            entityId: order.id,
            actorName: auth.adminName,
            metadata: {
              orderNumber,
              adminId: auth.sub,
              promoCode: promoCode ?? null,
              discount: toMajor(discount),
              discountType: promoCode ? (discount === calculatedSubtotal ? 'full' : 'promo') : 'manual',
              subtotal: calculatedSubtotal,
              total,
              appliedByRole: auth.adminRole ?? null,
            },
          }).run();
        }

        // One payment row per tender, so a split sale can be reconciled tender
        // by tender rather than only as a whole.
        for (const tender of appliedTenders) {
          tx.insert(posPayments).values({
            orderId: order.id,
            method: tender.method,
            status: 'SUCCESS',
            amount: toMajor(tender.amount),
            amountPesewas: tender.amount,
            reference: tender.reference || undefined,
            // Change is recorded on the cash tender only, because that is the
            // only place money physically leaves the drawer.
            cashReceived: tender.method === 'cash-on-delivery' ? toMajor(tender.amount + change) : undefined,
            tenderedPesewas: tender.method === 'cash-on-delivery' ? tender.amount + change : null,
            changeGiven: change > 0 && tender.method === 'cash-on-delivery' ? toMajor(change) : undefined,
            changePesewas: change > 0 && tender.method === 'cash-on-delivery' ? change : null,
            cashierName: auth.adminName || auth.email,
          }).run();
        }

        for (const [id, quantity] of productQuantities) {
          const product = byId.get(id)!;
          const nextStock = product.stockCount - quantity;
          tx.update(products).set({ stockCount: nextStock, inStock: nextStock > 0, isPublished: nextStock > 0, updatedAt: new Date() }).where(eq(products.id, id)).run();
          tx.insert(inventoryMovements).values({ productId: id, orderId: order.id, movementType: 'POS_SALE', quantity: -quantity, quantityBefore: product.stockCount, quantityAfter: nextStock, actorName: auth.adminName, reason: `POS sale ${order.orderNumber}` }).run();
        }
        for (const [key, quantity] of variantQuantities) {
          const [productId, variantId] = key.split(':');
          const product = byId.get(productId)!;
          const variants = (product.variants || []).map(variant => variant.id === variantId
            ? { ...variant, stockCount: Math.max(0, Number(variant.stockCount || 0) - quantity), inStock: Number(variant.stockCount || 0) - quantity > 0 }
            : variant);
          const nextStock = variants.reduce((sum, variant) => sum + Math.max(0, Number(variant.stockCount || 0)), 0);
          const priorStock = Number(product.variants?.find(variant => variant.id === variantId)?.stockCount || 0);
          tx.update(products).set({ variants, stockCount: nextStock, inStock: nextStock > 0, isPublished: nextStock > 0, updatedAt: new Date() }).where(eq(products.id, productId)).run();
          tx.insert(inventoryMovements).values({ productId, variantId, orderId: order.id, movementType: 'POS_SALE', quantity: -quantity, quantityBefore: priorStock, quantityAfter: Math.max(0, priorStock - quantity), actorName: auth.adminName, reason: `POS sale ${order.orderNumber}` }).run();
        }
        const linesVoided = verifiedItems.map(item => `${item.product.name} x${item.quantity}`);
        tx.insert(auditLogs).values({ action: 'POS_SALE_COMPLETED', entityType: 'order', entityId: order.id, actorName: auth.adminName, metadata: { orderNumber, total, wholesaleQuantity: verifiedItems.filter(item => item.priceType === 'wholesale').reduce((sum, item) => sum + item.quantity, 0), idempotencyKey: sale.idempotencyKey, deviceId: sale.deviceId || null, adminId: auth.sub, paymentMethod: sale.paymentMethod, voidedLines: linesVoided } }).run();
        return order;
      });
      return res.status(201).json(created);
    }

/**
 * Voids one line of a **completed** sale and puts its stock back.
 *
 * Scope matters here, because there are two different things people call
 * "voiding a line":
 *
 *   - Taking a line off the *unsaved ticket*. That never touched the database
 *     or the till's takings, so it is purely local to the screen: the cashier
 *     can do it freely, no reason needed, and nothing is recorded. That action
 *     does not come through the API at all.
 *   - Cancelling a line on a sale that was *already rung up*. Stock and money
 *     have moved, so this needs a manager and a written reason, and the stock
 *     is returned. This endpoint is that action.
 *
 * A whole-sale refund is handled by `?action=refund`.
 */
    if (req.method === 'POST' && req.query.action === 'void-line') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager']);
      if (!auth) return;

      const parsed = z.object({
        orderId: z.string().uuid(),
        productId: z.string().min(1),
        quantity: z.number().int().positive(),
        variantId: z.string().min(1).optional(),
        reason: z.string().trim().min(3, 'A reason of at least 3 characters is required.').max(200),
      }).safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'A completed sale, the line, and a reason are all required to void a line.', details: parsed.error.flatten() });
      }
      const { orderId, productId, variantId } = parsed.data;
      const voidReason = parsed.data.reason;

      const voided = db.transaction((tx) => {
        const [order] = tx.select().from(orders).where(eq(orders.id, orderId)).limit(1).all();
        if (!order || order.orderSource !== 'pos') throw new Error('POS sale not found.');
        if (order.status === 'Refunded') throw new Error('This POS sale has already been refunded.');

        const line = (order.items || []).find((item: any) =>
          item.product?.id === productId && (!variantId || item.selectedVariant?.id === variantId));
        if (!line) throw new Error('That line is not on this sale.');
        const alreadyVoided = Array.isArray((order as any).voidedLines) && (order as any).voidedLines.includes(`${productId}:${variantId ?? ''}:${parsed.data.quantity}`);
        if (alreadyVoided) throw new Error('That line has already been voided.');

        const [product] = tx.select().from(products).where(eq(products.id, productId)).limit(1).all();
        if (!product) throw new Error('Product not found.');

        let quantityAfter: number;
        if (variantId) {
          const prior = (product.variants || []).find((variant: any) => variant.id === variantId);
          if (!prior) throw new Error('That variation no longer exists.');
          const variants = (product.variants || []).map((variant: any) => variant.id === variantId
            ? { ...variant, stockCount: Number(variant.stockCount || 0) + parsed.data.quantity, inStock: true }
            : variant);
          quantityAfter = variants.reduce((sum: number, variant: any) => sum + Number(variant.stockCount || 0), 0);
          tx.update(products).set({ variants, stockCount: quantityAfter, inStock: true, updatedAt: new Date() }).where(eq(products.id, productId)).run();
        } else {
          quantityAfter = product.stockCount + parsed.data.quantity;
          tx.update(products).set({ stockCount: quantityAfter, inStock: true, updatedAt: new Date() }).where(eq(products.id, productId)).run();
        }

        tx.insert(inventoryMovements).values({
          productId, variantId, orderId, movementType: 'POS_LINE_VOID',
          quantity: parsed.data.quantity, quantityBefore: product.stockCount, quantityAfter,
          actorName: auth.adminName, reason: `Line void: ${voidReason}`,
        }).run();

        const voidedLines = [...((order as any).voidedLines || []), `${productId}:${variantId ?? ''}:${parsed.data.quantity}`];
        tx.insert(auditLogs).values({
          action: 'POS_LINE_VOIDED', entityType: 'order', entityId: order.id, actorName: auth.adminName,
          metadata: { orderNumber: order.orderNumber, adminId: auth.sub, reason: voidReason, productId, variantId: variantId ?? null, quantity: parsed.data.quantity, productName: line.product?.name ?? null },
        }).run();

        return { orderId, productId, variantId: variantId ?? null, quantity: parsed.data.quantity, reason: voidReason, stockAfter: quantityAfter };
      });

      return res.status(201).json({ voided: true, ...voided });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('POS orders API error:', error);
    if (typeof error?.message === 'string' && /stock|pricing changed|promo code|cash received|variation/i.test(error.message)) {
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({ error: error?.message || 'POS sale failed.' });
  }
}