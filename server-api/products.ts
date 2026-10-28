import type { ApiRequest, ApiResponse } from './_http.js';
import { randomUUID } from 'node:crypto';
import { db, getBarcodeSequence, setBarcodeSequence } from '../src/db/index.js';
import { inventoryMovements, posSyncQueue, products } from '../src/db/schema.js';
import { eq, and, or, like, desc, asc, sql, inArray, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { requireAdmin } from './_auth.js';
import { AUDIT_ACTIONS, recordAudit } from './_audit.js';
import { nextInternalBarcode, parseInternalBarcode } from '../src/lib/code128.js';
import { MAX_IMAGE_BYTES, MEDIA_PREFIX } from '../src/lib/media.js';
import { requireMinor } from '../src/lib/money.js';

// Disk writes live in a CommonJS module so the renderer never bundles node:fs.
const { saveProductImage } = require('../electron/media.cjs') as {
  saveProductImage: (dataUrl: unknown) => string;
};

const categoryEnum = [
  'all', 'skincare', 'makeup', 'fragrances', 'body-care', 'beauty-tools',
  'rice-grains', 'cooking-oils', 'seasoning-spices', 'beverages',
  'snacks-sweets', 'household-care', 'daily-essentials', 'new-arrivals',
  'best-sellers', 'offers'
] as const;

const productQuerySchema = z.object({
  category: z.enum(categoryEnum).optional(),
  department: z.enum(['beauty', 'groceries']).optional(),
  brand: z.string().optional(),
  search: z.string().optional(),
  published: z.coerce.boolean().optional().default(true),
  includeUnpublished: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().min(1).max(500).optional().default(100),
  offset: z.coerce.number().min(0).optional().default(0),
  barcode: z.string().trim().min(1).max(128).optional(),
  scanCode: z.string().trim().min(1).max(128).optional(),
});

/** A variation is a sellable SKU: preserve its option combination and inventory. */
const variantItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.union([z.number(), z.string()]).transform(v => Number(v) || 0),
  wholesalePrice: z.union([z.number(), z.string()]).optional().nullable().transform(v =>
    v == null ? undefined : Number(v)
  ),
  image: z.string().optional().nullable().transform(v => v ?? undefined),
  inStock: z.boolean().default(true),
  // Each variation owns its inventory and option combination.
  stockCount: z.union([z.number(), z.string()]).optional().nullable().transform(v =>
    v == null ? 0 : Number(v)
  ),
  barcode: z.string().trim().max(128).optional().nullable().transform(v => v || undefined),
  serialNumber: z.string().trim().max(128).optional().nullable().transform(v => v || undefined),
  options: z.record(z.string()).optional().nullable(),
});

const productCreateSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(255),
  brand: z.string().min(1).max(100),
  department: z.enum(['beauty', 'groceries']),
  category: z.string().min(1),
  categoryLabel: z.string().min(1).max(100),
  price: z.union([z.string(), z.number()]).transform(v => String(v)),
  wholesalePrice: z.union([z.string(), z.number()]).optional().nullable().transform(v =>
    v == null ? null : String(Number(v))
  ),
  costPrice: z.union([z.string(), z.number()]).optional().nullable().transform(v =>
    v == null ? null : String(v)
  ),
  unit: z.string().min(1).max(100),
  barcode: z.string().trim().max(128).optional().nullable().transform(v => v || undefined),
  serialNumber: z.string().trim().max(128).optional().nullable().transform(v => v || undefined),
  image: z.string().max(2_100_000).default(''),
  images: z.array(z.string().max(2_100_000)).default([]),
  inStock: z.boolean().default(true),
  isPublished: z.boolean().default(true),
  stockCount: z.number().int().min(0).default(2),
  reorderLevel: z.number().int().min(0).default(0),
  options: z.array(z.object({ name: z.string().min(1), values: z.array(z.string().min(1)).min(1) })).default([]),
  variants: z.array(variantItemSchema).default([]),
});

const productUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  brand: z.string().min(1).max(100).optional(),
  department: z.enum(['beauty', 'groceries']).optional(),
  category: z.string().min(1).optional(),
  categoryLabel: z.string().min(1).max(100).optional(),
  price: z.union([z.string(), z.number()]).optional().transform(v =>
    v == null ? undefined : String(v)
  ),
  wholesalePrice: z.union([z.string(), z.number()]).optional().nullable().transform(v =>
    v == null ? null : String(Number(v))
  ),
  costPrice: z.union([z.string(), z.number()]).optional().nullable().transform(v =>
    v == null ? null : String(v)
  ),
  unit: z.string().min(1).max(100).optional(),
  barcode: z.string().trim().max(128).optional().nullable().transform(v => v || undefined),
  serialNumber: z.string().trim().max(128).optional().nullable().transform(v => v || undefined),
  image: z.string().max(2_100_000).optional(),
  images: z.array(z.string().max(2_100_000)).optional(),
  inStock: z.boolean().optional(),
  isPublished: z.boolean().optional(),
  stockCount: z.coerce.number().int().min(0).optional(),
  reorderLevel: z.coerce.number().int().min(0).optional(),
  options: z.array(z.object({ name: z.string().min(1), values: z.array(z.string().min(1)).min(1) })).optional(),
  variants: z.array(variantItemSchema).optional(),
}).partial();

const isStorageUrl = (value: unknown) =>
  typeof value === 'string' && value.startsWith(MEDIA_PREFIX);

/** A listing is sellable when its own stock, or at least one of its variants, is available. */
function hasAvailableInventory(product: { stockCount?: number; inStock?: boolean; variants?: Array<{ stockCount?: number; inStock?: boolean }> | null }) {
  const variants = product.variants || [];
  return variants.length > 0
    ? variants.some(variant => Boolean(variant.inStock) && Number(variant.stockCount ?? 0) > 0)
    : Boolean(product.inStock) && Number(product.stockCount ?? 0) > 0;
}

function variantStockTotal(variants: Array<{ stockCount?: number }> | undefined) {
  return (variants || []).reduce((total, variant) => total + Math.max(0, Number(variant.stockCount ?? 0) || 0), 0);
}

function normalizeProductInventory<T extends {
  stockCount: number;
  inStock: boolean;
  variants?: Array<{ stockCount?: number; inStock?: boolean }> | null;
}>(product: T, includeCost = true): T {
  const stockCount = product.variants?.length
    ? variantStockTotal(product.variants)
    : Number(product.stockCount ?? 0);
  const { costPricePesewas, ...visibleProduct } = product as T & { costPricePesewas?: number | null };

  return {
    ...(includeCost ? product : visibleProduct),
    stockCount,
    inStock: hasAvailableInventory({ ...product, stockCount }),
  } as T;
}

/** Writes the photo into the till's own data folder and returns its local URL. */
async function uploadProductImage(dataUrl: unknown) {
  return saveProductImage(dataUrl);
}

/** Move old embedded media only when an admin saves that product. */
async function migrateLegacyProductMedia<T extends { image?: string | null; images?: string[] | null; variants?: Array<{ image?: string | null }> | null }>(product: T): Promise<T> {
  const migrated = new Map<string, string>();
  const move = async (value: string | null | undefined) => {
    if (!value?.startsWith('data:image/')) return value;
    const saved = migrated.get(value) || await uploadProductImage(value);
    migrated.set(value, saved);
    return saved;
  };

  return {
    ...product,
    ...(product.image ? { image: await move(product.image) } : {}),
    ...(product.images ? { images: await Promise.all(product.images.map(move)) } : {}),
    ...(product.variants ? {
      variants: await Promise.all(product.variants.map(async variant => ({
        ...variant,
        ...(variant.image ? { image: await move(variant.image) } : {}),
      }))),
    } : {}),
  } as T;
}

function hasEmbeddedProductMedia(product: { image?: string | null; images?: string[] | null; variants?: Array<{ image?: string | null }> | null }) {
  return Boolean(
    product.image?.startsWith('data:image/') ||
    product.images?.some(image => image.startsWith('data:image/')) ||
    product.variants?.some(variant => variant.image?.startsWith('data:image/'))
  );
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const { method, query, body } = req;

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (method === 'GET') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager', 'Inventory Dispatcher', 'Cashier']);
      if (!auth) return;
      res.setHeader('Cache-Control', 'private, no-store');
      if (query.id && typeof query.id === 'string') {
        const [product] = await db
          .select()
          .from(products)
          .where(eq(products.id, query.id))
          .limit(1);
        if (!product) return res.status(404).json({ error: 'Product not found' });
        return res.status(200).json(normalizeProductInventory(product, auth.adminRole !== 'Cashier'));
      }

      const parsed = productQuerySchema.safeParse(query);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
      }

      const { category, department, brand, search, barcode, scanCode, published, includeUnpublished, limit, offset } = parsed.data;

      // Build WHERE conditions with explicit type so push() is always valid
      const conditions: SQL<unknown>[] = [];

      if (includeUnpublished && auth.adminRole === 'Cashier') {
        conditions.push(eq(products.isPublished, true));
      }
      if (!includeUnpublished && published !== undefined) {
        conditions.push(eq(products.isPublished, published));
      }
      if (category) {
        conditions.push(eq(products.category, category as any));
      }
      if (department) {
        conditions.push(eq(products.department, department));
      }
      if (brand) {
        conditions.push(eq(products.brand, brand));
      }
      if (search) {
        conditions.push(or(
          like(products.name, `%${search}%`),
          like(products.brand, `%${search}%`)
        ) as SQL<unknown>);
      }
      // A scanner lookup is exact: the product's own barcode or serial, and the
      // same fields on any of its variants. SQLite has no JSON containment
      // operator, so variant codes are matched with LIKE over the JSON text,
      // which is safe here because the needle is a fixed `barcode`/`serialNumber`
      // pair with an escaped value.
      const variantCode = (field: 'barcode' | 'serialNumber', value: string) => {
        // Neutralise LIKE wildcards so a code containing % or _ still matches
        // literally instead of turning into a pattern.
        const safe = value.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`);
        const quoted = [`%${field}":"${safe}%`, `%${field}": "${safe}"%`];
        // The ESCAPE clause needs a literal single backslash. A template
        // literal writes `'\'` as the two characters slash-quote, which SQLite
        // reads as an unterminated string and then complains that the escape
        // expression is not one character long. Doubling it is what actually
        // reaches SQLite as `ESCAPE '\'`.
        return or(
          ...quoted.map((pattern) => sql`lower(${products.variants}) LIKE ${pattern} ESCAPE '\\'`)
        ) as SQL<unknown>;
      };

      if (barcode) {
        conditions.push(or(
          eq(products.barcode, barcode),
          eq(products.serialNumber, barcode),
          variantCode('barcode', barcode)
        ) as SQL<unknown>);
      }
      if (scanCode) {
        conditions.push(or(
          eq(products.barcode, scanCode),
          eq(products.serialNumber, scanCode),
          variantCode('barcode', scanCode),
          variantCode('serialNumber', scanCode)
        ) as SQL<unknown>);
      }
      const baseQuery = db.select().from(products);
      const whereQuery = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
      const paginatedQuery = whereQuery.orderBy(desc(products.createdAt)).limit(limit).offset(offset);

      const results = await paginatedQuery;
      const availableResults = !includeUnpublished
        ? results.filter((product: any) => hasAvailableInventory(product))
        : results;
      const liveResults = availableResults.map(product => normalizeProductInventory(product, auth.adminRole !== 'Cashier'));

      const totalQuery = conditions.length > 0
        ? db.select({ count: sql<number>`count(*)` }).from(products).where(and(...conditions))
        : db.select({ count: sql<number>`count(*)` }).from(products);
      const totalResult = await totalQuery;
      const total = Number(totalResult[0]?.count ?? 0);

      return res.status(200).json({
        products: liveResults,
        pagination: { total, limit, offset, hasMore: offset + limit < total },
      });
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (method === 'POST') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager', 'Inventory Dispatcher']);
      if (!auth) return;

      if (query.imageUpload === 'true') {
        return res.status(201).json({ url: await uploadProductImage(body?.image) });
      }

      // ── Assign internal barcodes ─────────────────────────────────────────
      // Issues ACS-000001-style codes to products that have none. Sequential and
      // never reissued, so a code read off a label can always be traced back.
      if (query.assignBarcodes === 'true') {
        // Survives a wipe: a restored or emptied catalogue must never restart the
        // sequence and reissue a number that is already on a shelf label.
        const reservedFrom = getBarcodeSequence();
        const existing = await db.select({ id: products.id, barcode: products.barcode }).from(products);
        const taken = new Set<string>(
          existing.map(row => String(row.barcode || '').trim()).filter(Boolean),
        );
        const serialRows = await db.select({ serialNumber: products.serialNumber }).from(products);
        for (const row of serialRows) {
          const value = String(row.serialNumber || '').trim();
          if (value) taken.add(value);
        }

        // Variants carry their own barcodes; collect those too so an issued code
        // can never collide with one already printed on a shelf label.
        for (const row of existing) {
          const [full] = await db.select({ variants: products.variants }).from(products).where(eq(products.id, row.id)).limit(1);
          for (const variant of (full?.variants || []) as Array<Record<string, unknown>>) {
            for (const field of ['barcode', 'serialNumber']) {
              const value = String(variant?.[field] || '').trim();
              if (value) taken.add(value);
            }
          }
        }

        const needing = existing.filter(row => !String(row.barcode || '').trim()).map(row => row.id);
        const assigned: Array<{ id: string; barcode: string }> = [];
        const skipped: string[] = [];

        let highWater = reservedFrom;
        for (const id of needing) {
          let code: string;
          try {
            code = nextInternalBarcode(taken, highWater);
          } catch (error: any) {
            skipped.push(id);
            console.error('Could not issue a barcode:', error?.message);
            break;
          }
          taken.add(code);
          highWater = setBarcodeSequence(parseInternalBarcode(code) ?? highWater);
          await db.update(products).set({ barcode: code, updatedAt: new Date() }).where(eq(products.id, id));
          assigned.push({ id, barcode: code });
        }

        return res.status(200).json({
          assigned,
          skipped,
          next: assigned.length ? assigned[assigned.length - 1].barcode : null,
          sequence: highWater,
        });
      }
      if (query.migrateImages === 'true') {
        const rows = await db.select().from(products);
        const legacy = rows.filter(hasEmbeddedProductMedia);
        // Keep this bounded so a large catalog never hits the serverless timeout.
        // The admin action can be repeated; each run continues from where it left off.
        const batch = legacy.slice(0, 8);
        let migrated = 0;
        for (const product of batch) {
          const updatedProduct = await migrateLegacyProductMedia(product);
          await db.update(products).set({
            image: updatedProduct.image ?? product.image,
            images: updatedProduct.images ?? product.images,
            variants: updatedProduct.variants ?? product.variants,
            updatedAt: new Date(),
          }).where(eq(products.id, product.id));
          migrated++;
        }
        return res.status(200).json({ migrated, remaining: Math.max(legacy.length - migrated, 0) });
      }

      const parsed = productCreateSchema.safeParse(body);
      if (!parsed.success) {
        console.error('Product validation failed:', JSON.stringify(parsed.error.flatten()));
        return res.status(400).json({ error: 'Invalid product data', details: parsed.error.flatten() });
      }

      const { id: rawId, wholesalePrice, costPrice, ...rest } = parsed.data;
      const productData = {
        ...rest,
        description: '',
        id: rawId || `prod-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        wholesalePrice: wholesalePrice ?? null,
        costPricePesewas: costPrice == null ? null : requireMinor(costPrice, 'cost price'),
      };

      // A product with no available inventory must never be exposed to shoppers.
      const hasVariants = productData.variants.length > 0;
      const totalStock = hasVariants ? variantStockTotal(productData.variants) : productData.stockCount;
      const available = hasAvailableInventory({ ...productData, stockCount: totalStock });
      const [newProduct] = await db.insert(products).values({
        ...productData,
        stockCount: totalStock,
        inStock: available,
        isPublished: available ? productData.isPublished : false,
      } as any).returning();
      await db.insert(posSyncQueue).values({
        action: 'PRODUCT_CREATE',
        payload: newProduct as unknown as Record<string, unknown>,
        idempotencyKey: `PRODUCT_UPSERT:${newProduct.id}:${randomUUID()}`,
      });
      return res.status(201).json(newProduct);
    }

    // ── PATCH ─────────────────────────────────────────────────────────────────
    if (method === 'PATCH') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager', 'Inventory Dispatcher']);
      if (!auth) return;

      const parsed = productUpdateSchema.safeParse(body);
      if (!parsed.success) {
        console.error('Product update validation failed:', JSON.stringify(parsed.error.flatten()));
        return res.status(400).json({ error: 'Invalid product data', details: parsed.error.flatten() });
      }

      const { id } = query;
      if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: 'Product ID is required' });
      }

      const [existing] = await db.select({
        name: products.name,
        price: products.price,
        wholesalePrice: products.wholesalePrice,
        stockCount: products.stockCount,
        inStock: products.inStock,
        variants: products.variants,
      }).from(products).where(eq(products.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'Product not found' });

      const { wholesalePrice, costPrice, ...rest } = parsed.data;
      let mediaSafeRest = rest;
      try {
        mediaSafeRest = await migrateLegacyProductMedia(rest);
      } catch (error: any) {
        console.error('Product media migration during update failed:', error);
        return res.status(400).json({ error: 'Could not move the existing product photos into local storage. Please try saving again.' });
      }
      const updateData: Record<string, unknown> = {
        ...mediaSafeRest,
        ...(rest.price !== undefined ? { pricePesewas: requireMinor(rest.price, 'price') } : {}),
        // wholesalePrice is transformed to string | null; only update if supplied.
        ...(wholesalePrice !== undefined ? { wholesalePrice: wholesalePrice ?? null } : {}),
        ...(costPrice !== undefined ? { costPricePesewas: costPrice == null ? null : requireMinor(costPrice, 'cost price') } : {}),
        updatedAt: new Date(),
      };

      const incomingVariants = mediaSafeRest.variants;
      const existingVariants = existing.variants || [];
      const variantInventoryChanged = incomingVariants !== undefined && (
        incomingVariants.length !== existingVariants.length ||
        incomingVariants.some(variant => {
          const previous = existingVariants.find(item => item.id === variant.id);
          return !previous ||
            Number(variant.stockCount ?? 0) !== Number(previous.stockCount ?? 0) ||
            Boolean(variant.inStock) !== Boolean(previous.inStock);
        })
      );
      const inventoryChanged = mediaSafeRest.stockCount !== undefined ||
        mediaSafeRest.inStock !== undefined ||
        variantInventoryChanged;

      // Only recalculate availability when the stock values themselves change.
      // A normal save that edits text, images, barcode, notes, or publication
      // flags must not silently push a product in or out of stock without a
      // corresponding inventory adjustment.
      const nextInventory = {
        stockCount: mediaSafeRest.stockCount ?? existing.stockCount,
        inStock: mediaSafeRest.inStock ?? existing.inStock,
        variants: mediaSafeRest.variants ?? existing.variants,
      };
      if (inventoryChanged) {
        const available = hasAvailableInventory(nextInventory);
        if (variantInventoryChanged && incomingVariants) {
          updateData.stockCount = variantStockTotal(incomingVariants);
        }
        updateData.inStock = available;
        if (!available) updateData.isPublished = false;
      }

      const [updated] = await db
        .update(products)
        .set(updateData as any)
        .where(eq(products.id, id))
        .returning();
      if (updated) {
        await db.insert(posSyncQueue).values({
          action: 'PRODUCT_UPDATE',
          payload: updated as unknown as Record<string, unknown>,
          idempotencyKey: `PRODUCT_UPSERT:${updated.id}:${randomUUID()}`,
        });
      }

      // Price and stock are money, so each change is recorded on its own: a
      // later question ("who changed this, and when?") then has an answer, and
      // a discount given by mistake is distinguishable from a price edit.
      const priceChanged = (rest.price !== undefined && Number(rest.price) !== Number(existing.price))
        || (wholesalePrice !== undefined && (wholesalePrice ?? null) !== (existing.wholesalePrice ?? null))
        || (rest.variants !== undefined && JSON.stringify(rest.variants) !== JSON.stringify(existing.variants));
      if (priceChanged) {
        await recordAudit(auth, {
          action: AUDIT_ACTIONS.PRICE_CHANGED,
          entityType: 'product',
          entityId: id,
          metadata: {
            name: existing.name,
            previousPrice: Number(existing.price),
            nextPrice: rest.price !== undefined ? Number(rest.price) : Number(existing.price),
            previousWholesale: existing.wholesalePrice ?? null,
            nextWholesale: wholesalePrice !== undefined ? wholesalePrice ?? null : existing.wholesalePrice ?? null,
          },
        });
      }

      if (inventoryChanged) {
        await recordAudit(auth, {
          action: AUDIT_ACTIONS.STOCK_ADJUSTED,
          entityType: 'product',
          entityId: id,
          metadata: {
            name: existing.name,
            previousStock: Number(existing.stockCount),
            nextStock: Number(updated?.stockCount ?? existing.stockCount),
            via: 'product-edit',
          },
        });
      }

      return res.status(200).json(updated);
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (method === 'DELETE') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager', 'Inventory Dispatcher']);
      if (!auth) return;

      const { id } = query;
      if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: 'Product ID is required' });
      }

      const existing = await db.select({ id: products.id, name: products.name }).from(products).where(eq(products.id, id)).limit(1);
      if (!existing[0]) return res.status(404).json({ error: 'Product not found' });

      await db.delete(inventoryMovements).where(eq(inventoryMovements.productId, id));
      const [deleted] = await db.delete(products).where(eq(products.id, id)).returning({ id: products.id, name: products.name });
      if (!deleted) return res.status(404).json({ error: 'Product not found' });
      await db.insert(posSyncQueue).values({
        action: 'PRODUCT_DELETE',
        payload: { id: deleted.id },
        idempotencyKey: `PRODUCT_DELETE:${deleted.id}:${randomUUID()}`,
      });

      await recordAudit(auth, {
        action: AUDIT_ACTIONS.STOCK_ADJUSTED,
        entityType: 'product',
        entityId: id,
        metadata: { event: 'product-deleted', name: deleted.name ?? null, via: 'product-delete' },
      });

      return res.status(200).json({ success: true, id: deleted.id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    // Barcodes and serial numbers are unique, so a duplicate is a mistake the
    // manager needs to see rather than a server fault.
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(error?.message || '')) {
      const field = /products\.barcode/.test(error.message) ? 'barcode' : /serial_number/.test(error.message) ? 'serial number' : 'value';
      return res.status(409).json({ error: `That ${field} is already used by another product.` });
    }
    console.error('Products API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
