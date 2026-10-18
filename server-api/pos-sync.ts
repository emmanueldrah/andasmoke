import type { ApiRequest, ApiResponse } from './_http.js';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, getSetting, setSetting } from '../src/db/index.js';
import { posSyncQueue, products } from '../src/db/schema.js';
import { requireAdmin } from './_auth.js';

const { readStoredProductImage, saveProductImage } = require('../electron/media.cjs') as {
  readStoredProductImage: (value: unknown) => unknown;
  saveProductImage: (value: unknown) => string;
};

function cloudProductPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const product = { ...payload };
  const costPricePesewas = product.costPricePesewas;
  delete product.costPricePesewas;
  delete product.pricePesewas;
  if (costPricePesewas !== undefined) {
    product.costPrice = costPricePesewas == null ? null : Number(costPricePesewas) / 100;
  }
  if (product.image) product.image = readStoredProductImage(product.image);
  if (Array.isArray(product.images)) {
    product.images = product.images.map(image => readStoredProductImage(image));
  }
  if (Array.isArray(product.variants)) {
    product.variants = product.variants.map(variant => {
      if (!variant || typeof variant !== 'object') return variant;
      const entry = { ...(variant as Record<string, unknown>) };
      if (entry.image) entry.image = readStoredProductImage(entry.image);
      return entry;
    });
  }
  if (Buffer.byteLength(JSON.stringify(product), 'utf8') > 4_000_000) {
    throw new Error('Product is too large to sync. Reduce its photos and try again.');
  }
  return product;
}

function readCloudAuthorization(req: ApiRequest): string {
  const header = req.headers['x-cloud-authorization'];
  return typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
    ? header
    : '';
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  try {
    return await response.json() as Record<string, any>;
  } catch {
    return {};
  }
}

async function queueInitialProducts(cloudOrigin: string, cloudAuthorization: string) {
  const marker = 'sync.products.backfill.v1';
  if (getSetting(marker) === 'done') return { queued: 0, alreadyDone: true };

  const cloudIds = new Set<string>();
  let offset = 0;
  while (true) {
    const url = new URL('/api/products', cloudOrigin);
    url.searchParams.set('includeUnpublished', 'true');
    url.searchParams.set('limit', '500');
    url.searchParams.set('offset', String(offset));
    const response = await fetch(url, { headers: { Authorization: cloudAuthorization } });
    const body = await responseJson(response);
    if (!response.ok) throw new Error(body.error || 'Could not read the website product catalog.');
    const page = Array.isArray(body.products) ? body.products : [];
    for (const product of page) if (product?.id) cloudIds.add(String(product.id));
    if (page.length < 500) break;
    offset += page.length;
  }

  const localProducts = await db.select().from(products);
  const queuedChanges = await db.select({ action: posSyncQueue.action, payload: posSyncQueue.payload })
    .from(posSyncQueue)
    .where(inArray(posSyncQueue.action, ['PRODUCT_CREATE', 'PRODUCT_UPDATE', 'PRODUCT_DELETE']));
  const queuedProductIds = new Set(queuedChanges.map(change => String(change.payload.id || '')));
  let queued = 0;
  for (const product of localProducts) {
    if (cloudIds.has(product.id) || queuedProductIds.has(product.id)) continue;
    await db.insert(posSyncQueue).values({
      action: 'PRODUCT_CREATE',
      payload: product as unknown as Record<string, unknown>,
      idempotencyKey: `PRODUCT_BACKFILL:${product.id}`,
    }).onConflictDoNothing();
    queued++;
  }
  setSetting(marker, 'done');
  return { queued, alreadyDone: false };
}

function localProductFromCloud(product: Record<string, any>) {
  const pricePesewas = product.pricePesewas == null
    ? Math.round(Number(product.price || 0) * 100)
    : Number(product.pricePesewas);
  const date = (value: unknown) => {
    const parsed = value instanceof Date ? value : new Date(String(value || ''));
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  };
  const localImage = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    return value.startsWith('data:image/') ? saveProductImage(value) : value;
  };
  const image = localImage(product.image) || '';
  const images = Array.isArray(product.images)
    ? product.images.map(localImage).filter((value): value is string => Boolean(value))
    : [];
  return {
    id: String(product.id),
    name: String(product.name || ''),
    brand: String(product.brand || ''),
    department: product.department,
    category: product.category,
    categoryLabel: String(product.categoryLabel || product.category || ''),
    price: pricePesewas / 100,
    pricePesewas,
    ...(product.costPricePesewas !== undefined ? { costPricePesewas: product.costPricePesewas == null ? null : Number(product.costPricePesewas) } : {}),
    reorderLevel: Number(product.reorderLevel || 0),
    wholesalePrice: product.wholesalePrice == null ? null : Number(product.wholesalePrice),
    deliveryPrice: product.deliveryPrice == null ? null : Number(product.deliveryPrice),
    originalPrice: product.originalPrice == null ? null : Number(product.originalPrice),
    discountBadge: product.discountBadge ?? null,
    unit: String(product.unit || 'each'),
    barcode: product.barcode ?? null,
    serialNumber: product.serialNumber ?? null,
    image,
    images,
    description: String(product.description || ''),
    highlights: Array.isArray(product.highlights) ? product.highlights : [],
    badge: product.badge ?? null,
    inStock: Boolean(product.inStock),
    isPublished: Boolean(product.isPublished),
    stockCount: Math.max(0, Number(product.stockCount || 0)),
    options: Array.isArray(product.options) ? product.options : [],
    rating: Number(product.rating || 5),
    reviewCount: Number(product.reviewCount || 0),
    origin: product.origin ?? null,
    routineStep: product.routineStep ?? null,
    skinType: Array.isArray(product.skinType) ? product.skinType : [],
    skinConcern: Array.isArray(product.skinConcern) ? product.skinConcern : [],
    packSize: product.packSize ?? null,
    storageInfo: product.storageInfo ?? null,
    shelfLife: product.shelfLife ?? null,
    variants: Array.isArray(product.variants) ? product.variants.map(variant => {
      const variantImage = localImage(variant?.image);
      return { ...variant, ...(variantImage ? { image: variantImage } : {}) };
    }) : [],
    details: product.details ?? null,
    createdAt: date(product.createdAt),
    updatedAt: date(product.updatedAt),
  };
}

async function pullCloudProducts(cloudOrigin: string, cloudAuthorization: string, canSeeUnpublished: boolean) {
  const cloudProducts: Record<string, any>[] = [];
  let offset = 0;
  while (true) {
    const url = new URL('/api/products', cloudOrigin);
    url.searchParams.set('limit', '500');
    url.searchParams.set('offset', String(offset));
    if (canSeeUnpublished) url.searchParams.set('includeUnpublished', 'true');
    const response = await fetch(url, { headers: { Authorization: cloudAuthorization } });
    const body = await responseJson(response);
    if (!response.ok) throw new Error(body.error || 'Could not refresh the website catalog.');
    const page = Array.isArray(body.products) ? body.products : [];
    cloudProducts.push(...page);
    if (page.length < 500) break;
    offset += page.length;
  }

  const dirtyQueue = await db.select({ payload: posSyncQueue.payload })
    .from(posSyncQueue)
    .where(and(
      inArray(posSyncQueue.action, ['PRODUCT_CREATE', 'PRODUCT_UPDATE', 'PRODUCT_DELETE']),
      inArray(posSyncQueue.status, ['PENDING', 'FAILED']),
    ));
  const dirtyIds = new Set(dirtyQueue.map(item => String(item.payload.id || '')));
  const localProducts = await db.select().from(products);
  const localById = new Map(localProducts.map(product => [product.id, product]));
  const cloudIds = new Set<string>();
  let updated = 0;

  for (const remote of cloudProducts) {
    const id = String(remote.id || '');
    if (!id) continue;
    cloudIds.add(id);
    if (dirtyIds.has(id)) continue;
    const local = localById.get(id);
    const next = localProductFromCloud(remote);
    if (local && local.updatedAt.getTime() >= next.updatedAt.getTime()) continue;
    await db.insert(products)
      .values(next as typeof products.$inferInsert)
      .onConflictDoUpdate({ target: products.id, set: next });
    updated++;
  }

  let deleted = 0;
  if (canSeeUnpublished && getSetting('sync.products.backfill.v1') === 'done') {
    const removedIds = localProducts
      .filter(product => !cloudIds.has(product.id) && !dirtyIds.has(product.id))
      .map(product => product.id);
    if (removedIds.length) {
      await db.delete(products).where(inArray(products.id, removedIds));
      deleted = removedIds.length;
    }
  }
  return { updated, deleted };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    const action = req.query.action || 'status';
    const cloudOrigin = (process.env.ANDA_CLOUD_API_ORIGIN || 'https://andasmoke.vercel.app').replace(/\/+$/, '');
    const cloudAuthorization = readCloudAuthorization(req);

    if (req.method === 'POST' && action === 'bootstrap-products') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager', 'Inventory Dispatcher']);
      if (!auth) return;
      if (!cloudAuthorization) {
        return res.status(409).json({ error: 'Sign in while online to connect this till to the website catalog.' });
      }
      const result = await queueInitialProducts(cloudOrigin, cloudAuthorization);
      return res.status(200).json(result);
    }

    if (req.method === 'POST' && action === 'pull-products') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager', 'Inventory Dispatcher', 'Cashier']);
      if (!auth) return;
      if (!cloudAuthorization) {
        return res.status(409).json({ error: 'Sign in while online to connect this till to the website catalog.' });
      }
      const result = await pullCloudProducts(
        cloudOrigin,
        cloudAuthorization,
        auth.adminRole !== 'Cashier',
      );
      return res.status(200).json(result);
    }

    // ── Status (accessible to all authenticated staff to drive UI indicator) ─
    if (req.method === 'GET' && action === 'status') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager', 'Inventory Dispatcher', 'Cashier']);
      if (!auth) return;
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
      const [latestFailure] = await db.select({ errorMessage: posSyncQueue.errorMessage })
        .from(posSyncQueue)
        .where(eq(posSyncQueue.status, 'FAILED'))
        .orderBy(desc(posSyncQueue.createdAt))
        .limit(1);

      return res.status(200).json({
        pendingCount: Number(pendingRow?.count || 0),
        syncedCount: Number(syncedRow?.count || 0),
        failedCount: Number(failedRow?.count || 0),
        lastError: latestFailure?.errorMessage || null,
        cloudConnected: Boolean(cloudAuthorization),
        lastSyncedAt: lastSync?.syncedAt ? lastSync.syncedAt.toISOString() : null,
        cloudOrigin,
      });
    }

    // ── Flush queue to cloud ─────────────────────────────────────────────
    if (req.method === 'POST' && action === 'flush') {
      const auth = await requireAdmin(req, res, ['Super Admin', 'Store Manager', 'Inventory Dispatcher', 'Cashier']);
      if (!auth) return;
      if (!cloudAuthorization) {
        return res.status(409).json({ error: 'Sign in while online to connect this till to the website catalog.' });
      }
      if (req.query.retryFailed === 'true') {
        await db.update(posSyncQueue)
          .set({ status: 'PENDING', retryCount: 0, errorMessage: null })
          .where(eq(posSyncQueue.status, 'FAILED'));
      }
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
      for (const item of pendingItems) {
        try {
          let endpoint = `${cloudOrigin}/api/orders?channel=pos`;
          let method = 'POST';
          let body: Record<string, unknown> = item.payload;
          if (item.action === 'PRODUCT_CREATE') {
            endpoint = `${cloudOrigin}/api/products`;
            body = cloudProductPayload(item.payload);
          } else if (item.action === 'PRODUCT_UPDATE') {
            const productId = String(item.payload.id || '');
            if (!productId) throw new Error('Product update is missing its product ID.');
            endpoint = `${cloudOrigin}/api/products?id=${encodeURIComponent(productId)}`;
            method = 'PATCH';
            body = cloudProductPayload(item.payload);
          } else if (item.action === 'PRODUCT_DELETE') {
            const productId = String(item.payload.id || '');
            if (!productId) throw new Error('Product delete is missing its product ID.');
            endpoint = `${cloudOrigin}/api/products?id=${encodeURIComponent(productId)}`;
            method = 'DELETE';
          }

          const cloudResponse = await fetch(endpoint, {
            method,
            headers: {
              'Content-Type': 'application/json',
              Authorization: cloudAuthorization,
            },
            ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
          });

          const bodyText = await cloudResponse.text();
          let parsed: Record<string, any> = {};
          try { parsed = JSON.parse(bodyText); } catch {}
          let alreadyExists = false;
          if (cloudResponse.status === 409 && item.action === 'PRODUCT_CREATE') {
            const productId = String(item.payload.id || '');
            const existing = await fetch(`${cloudOrigin}/api/products?id=${encodeURIComponent(productId)}`, {
              headers: { Authorization: cloudAuthorization },
            });
            alreadyExists = existing.ok;
          }

          const duplicateOrder = item.action === 'POS_ORDER'
            && cloudResponse.status === 409
            && /already|idempotenc/i.test(bodyText);
          if (cloudResponse.ok || alreadyExists || duplicateOrder || (item.action === 'PRODUCT_DELETE' && cloudResponse.status === 404)) {
            await db.update(posSyncQueue)
              .set({
                status: 'SYNCED',
                syncedAt: new Date(),
                errorMessage: null,
              })
              .where(eq(posSyncQueue.id, item.id));
            flushed++;
          } else if (cloudResponse.status === 401) {
            await db.update(posSyncQueue)
              .set({ status: 'FAILED', errorMessage: 'Cloud sign-in expired. Sign in again, then retry syncing.' })
              .where(eq(posSyncQueue.id, item.id));
            break;
          } else {
            // Server error or rejection
            const nextRetries = item.retryCount + 1;
            await db.update(posSyncQueue)
              .set({
                retryCount: nextRetries,
                errorMessage: parsed.error || 'Cloud sync failed.',
                status: nextRetries >= 5 ? 'FAILED' : 'PENDING',
              })
              .where(eq(posSyncQueue.id, item.id));
          }
        } catch (fetchErr: any) {
          // Network disconnect / offline
          if (fetchErr instanceof TypeError || /network|fetch/i.test(fetchErr?.message || '')) {
            isOffline = true;
            break;
          }
          const nextRetries = item.retryCount + 1;
          await db.update(posSyncQueue)
            .set({
              retryCount: nextRetries,
              errorMessage: fetchErr?.message || 'Cloud sync failed.',
              status: nextRetries >= 5 ? 'FAILED' : 'PENDING',
            })
            .where(eq(posSyncQueue.id, item.id));
        }
      }

      const [remainingRow] = await db.select({ count: sql<number>`count(*)` })
        .from(posSyncQueue)
        .where(eq(posSyncQueue.status, 'PENDING'));
      const [failedRow] = await db.select({ count: sql<number>`count(*)` })
        .from(posSyncQueue)
        .where(eq(posSyncQueue.status, 'FAILED'));

      return res.status(200).json({
        flushed,
        pending: Number(remainingRow?.count || 0),
        failed: Number(failedRow?.count || 0),
        offline: isOffline,
      });
    }

    return res.status(400).json({ error: 'Unknown sync action' });
  } catch (error: any) {
    console.error('POS sync error:', error);
    return res.status(500).json({ error: error?.message || 'Sync failed' });
  }
}
