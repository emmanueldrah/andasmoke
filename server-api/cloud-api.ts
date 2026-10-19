import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { ApiRequest, ApiResponse } from './_http.js';
import { getCloudPool, ensureCloudSchema, fromDbRow, withCloudTransaction } from './cloud-db.js';
import { applyPercentageMinor, requireMinor, toMajor } from '../src/lib/money.js';
import { normalizeHardwareSettings } from '../src/lib/hardware.js';
import { ghanaDateRange, endOfGhanaDay, startOfGhanaDay, ghanaToday, formatGhanaDay } from '../src/lib/ghanaTime.js';
import { buildCsv } from '../src/lib/csv.js';
import { buildPdf } from '../src/lib/pdf.js';
import { z } from 'zod';

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 5 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 8 * 60 * 60_000;
const DESKTOP_SYNC_TOKEN_MS = 24 * 60 * 60_000;
const MIN_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
const ROLES = ['Super Admin', 'Store Manager', 'Inventory Dispatcher', 'Cashier'] as const;
type CloudRole = typeof ROLES[number];
type CloudSession = { sub: string; email: string; role: 'admin'; adminRole: CloudRole; adminName: string; avatar?: string | null; iat?: number; exp?: number };
type Query = Record<string, string | string[] | undefined>;
type PgRow = Record<string, any>;

const roleFromRequest = (role: unknown): CloudRole => {
  if (role === 'cashier' || role === 'Cashier') return 'Cashier';
  if (role === 'manager' || role === 'Store Manager') return 'Store Manager';
  if (role === 'super_admin' || role === 'Super Admin') return 'Super Admin';
  return 'Inventory Dispatcher';
};

const getQuery = (query: Query, key: string): string => {
  const value = query[key];
  return Array.isArray(value) ? value[0] || '' : value || '';
};

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || process.env.NEXTAUTH_SECRET?.trim() || 'anda-smoke-hub-cloud-secret-2026-01';
  if (!secret || secret.length < 16) throw new Error('A JWT secret is required for the cloud POS.');
  return secret;
};

const signCloudSession = (account: { id: string; email: string; adminName: string; adminRole: CloudRole }, expiresIn: number) => jwt.sign({
  sub: account.id,
  email: account.email,
  role: 'admin',
  adminRole: account.adminRole,
  adminName: account.adminName,
}, getJwtSecret(), { algorithm: 'HS256', expiresIn: Math.max(1, Math.floor(expiresIn / 1000)) });

async function requireCloudAdmin(req: ApiRequest, res: ApiResponse, allowedRoles?: readonly string[]): Promise<CloudSession | null> {
  const authorization = req.headers.authorization;
  const token = typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  try {
    const payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as CloudSession;
    if (!payload.sub || payload.role !== 'admin') throw new Error('Invalid session');
    const pool = getCloudPool();
    await ensureCloudSchema();
    const { rows } = await pool.query('SELECT id, email, admin_name, admin_role, avatar, is_active FROM admin_sessions WHERE id = $1 LIMIT 1', [payload.sub]);
    const admin = rows[0];
    if (!admin || !admin.is_active) {
      res.status(401).json({ error: 'Administrator account is no longer active' });
      return null;
    }
    const session = { ...payload, email: admin.email, adminName: admin.admin_name, adminRole: admin.admin_role, avatar: admin.avatar } as CloudSession;
    if (allowedRoles && !allowedRoles.includes(session.adminRole)) {
      res.status(403).json({ error: 'Your administrator role does not allow this action' });
      return null;
    }
    return session;
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
    return null;
  }
}

async function getSetting(key: string): Promise<string | null> {
  await ensureCloudSchema();
  const { rows } = await getCloudPool().query('SELECT value FROM store_settings WHERE key = $1 LIMIT 1', [key]);
  return rows[0]?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  await ensureCloudSchema();
  await getCloudPool().query(
    `INSERT INTO store_settings (id, key, value, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [randomUUID(), key, value],
  );
}

async function getIdleTimeoutMs(): Promise<number> {
  const stored = Number(await getSetting('session.idleTimeoutMs'));
  return Number.isFinite(stored) && stored > 0
    ? Math.min(Math.max(stored, MIN_IDLE_TIMEOUT_MS), MAX_IDLE_TIMEOUT_MS)
    : DEFAULT_IDLE_TIMEOUT_MS;
}

async function recordCloudAudit(session: CloudSession | null, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) {
  await ensureCloudSchema();
  await getCloudPool().query(
    `INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_name, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), action, entityType, entityId, session?.adminName || session?.email || 'system', JSON.stringify({ ...metadata, adminId: session?.sub ?? null })],
  );
}

const loginSchema = z.object({ email: z.string().trim().email().max(255), pin: z.string().min(4).max(100) });

async function authHandler(req: ApiRequest, res: ApiResponse): Promise<unknown> {
  const action = getQuery(req.query, 'action');
  const pool = getCloudPool();
  await ensureCloudSchema();

  if (req.method === 'GET' && action === 'setup-status') {
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM admin_sessions');
    return res.status(200).json({ needsSetup: Number(rows[0]?.count || 0) === 0 });
  }

  if (req.method === 'POST' && action === 'setup') {
    const parsed = z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().email().max(255), pin: z.string().min(4).max(100), phone: z.string().trim().max(30).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter a name, a valid email and a PIN of at least 4 characters.' });
    const account = await withCloudTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [721044612]);
      const { rows } = await client.query('SELECT count(*)::int AS count FROM admin_sessions');
      if (Number(rows[0]?.count || 0) > 0) throw Object.assign(new Error('Setup has already been completed on this till.'), { statusCode: 409 });
      const email = parsed.data.email.toLowerCase();
      const pinHash = await bcrypt.hash(parsed.data.pin, 12);
      const id = randomUUID();
      const { rows: created } = await client.query(
        `INSERT INTO admin_sessions (id, admin_name, admin_role, email, phone, pin_hash)
         VALUES ($1, $2, 'Super Admin', $3, $4, $5)
         RETURNING id, admin_name, admin_role, email`,
        [id, parsed.data.name, email, parsed.data.phone || '', pinHash],
      );
      const admin = created[0];
      await client.query(
        `INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_name, metadata)
         VALUES ($1, 'STAFF_ACCOUNT_CHANGED', 'admin_session', $2, $3, $4::jsonb)`,
        [randomUUID(), id, admin.admin_name, JSON.stringify({ event: 'first-run-setup', adminId: id, email, role: 'Super Admin' })],
      );
      return admin;
    });
    const idleTimeoutMs = getQuery(req.query, 'client') === 'desktop'
      ? DESKTOP_SYNC_TOKEN_MS
      : await getIdleTimeoutMs();
    return res.status(201).json({
      token: signCloudSession({ id: account.id, email: account.email, adminName: account.admin_name, adminRole: account.admin_role }, idleTimeoutMs),
      idleTimeoutMs,
      admin: { id: account.id, adminName: account.admin_name, adminRole: account.admin_role, email: account.email },
    });
  }

  if (req.method === 'POST' && action === 'admin') {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter your email and PIN.' });
    const email = parsed.data.email.toLowerCase();
    const { rows } = await pool.query('SELECT * FROM admin_sessions WHERE email = $1 LIMIT 1', [email]);
    const admin = rows[0];
    const now = new Date();
    if (admin?.locked_until && new Date(admin.locked_until).getTime() > now.getTime()) {
      const secondsLeft = Math.ceil((new Date(admin.locked_until).getTime() - now.getTime()) / 1000);
      await recordCloudAudit(null, 'STAFF_LOGIN_BLOCKED', 'admin_session', email, { secondsLeft, attempts: admin.failed_pin_attempts });
      return res.status(429).json({ error: 'Too many wrong PINs. This account is temporarily locked.', lockedUntil: new Date(admin.locked_until).toISOString(), secondsLeft });
    }
    const validPin = admin ? await bcrypt.compare(parsed.data.pin, admin.pin_hash) : false;
    if (!admin || !admin.is_active || !validPin) {
      const attempts = admin ? Number(admin.failed_pin_attempts || 0) + 1 : 0;
      const locked = Boolean(admin && attempts >= MAX_PIN_ATTEMPTS);
      const lockedUntil = locked ? new Date(now.getTime() + PIN_LOCKOUT_MS) : null;
      if (admin) {
        await pool.query('UPDATE admin_sessions SET failed_pin_attempts = $1, locked_until = $2 WHERE id = $3', [locked ? 0 : attempts, lockedUntil, admin.id]);
      }
      await recordCloudAudit(null, 'STAFF_LOGIN_FAILED', 'admin_session', email, { adminId: admin?.id ?? null, attempts: admin ? attempts : null, locked });
      return res.status(locked ? 429 : 401).json({ error: locked ? 'Too many wrong PINs. This account is locked for 5 minutes.' : 'Incorrect email or PIN.', ...(locked ? { lockedUntil: lockedUntil?.toISOString(), secondsLeft: PIN_LOCKOUT_MS / 1000 } : {}) });
    }
    await pool.query('UPDATE admin_sessions SET last_login_at = now(), failed_pin_attempts = 0, locked_until = NULL WHERE id = $1', [admin.id]);
    const idleTimeoutMs = getQuery(req.query, 'client') === 'desktop'
      ? DESKTOP_SYNC_TOKEN_MS
      : await getIdleTimeoutMs();
    const token = signCloudSession({ id: admin.id, email: admin.email, adminName: admin.admin_name, adminRole: admin.admin_role }, idleTimeoutMs);
    await recordCloudAudit({ sub: admin.id, email: admin.email, adminName: admin.admin_name, adminRole: admin.admin_role, role: 'admin' }, 'STAFF_LOGIN', 'admin_session', admin.id, { adminId: admin.id, adminRole: admin.admin_role, email: admin.email });
    return res.status(200).json({ token, idleTimeoutMs, admin: { id: admin.id, adminName: admin.admin_name, adminRole: admin.admin_role, email: admin.email, avatar: admin.avatar || '' } });
  }

  if (req.method === 'GET' && action === 'session') {
    const auth = await requireCloudAdmin(req, res);
    if (!auth) return;
    return res.status(200).json({ role: 'admin', email: auth.email, adminName: auth.adminName, adminRole: auth.adminRole, avatar: auth.avatar || '' });
  }

  if (req.method === 'GET' && action === 'idle-timeout') {
    return res.status(200).json({ idleTimeoutMs: await getIdleTimeoutMs(), defaultIdleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS });
  }
  if (req.method === 'POST' && action === 'idle-timeout') {
    const auth = await requireCloudAdmin(req, res, ['Super Admin', 'Store Manager']);
    if (!auth) return;
    const requested = Number(req.body?.idleTimeoutMs);
    if (!Number.isFinite(requested) || requested <= 0) return res.status(400).json({ error: 'Enter the idle timeout in milliseconds.' });
    const idleTimeoutMs = Math.min(Math.max(Math.floor(requested), MIN_IDLE_TIMEOUT_MS), MAX_IDLE_TIMEOUT_MS);
    await setSetting('session.idleTimeoutMs', String(idleTimeoutMs));
    return res.status(200).json({ idleTimeoutMs });
  }
  if (req.method === 'POST' && action === 'sign-out-all') {
    const auth = await requireCloudAdmin(req, res);
    if (!auth) return;
    await recordCloudAudit(auth, 'STAFF_SESSION_SIGNED_OUT', 'admin_session', auth.sub, { reason: getQuery(req.query, 'reason') || 'manual' });
    return res.status(200).json({ signedOut: true });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function backupsHandler(req: ApiRequest, res: ApiResponse): Promise<unknown> {
  const action = getQuery(req.query, 'action');
  const auth = await requireCloudAdmin(req, res, ['Super Admin','Store Manager']);
  if (!auth) return;
  if (req.method === 'GET' && action === 'list') {
    return res.status(200).json({
      retention: 'managed by Neon',
      backups: [],
      last: { exists: true, path: null, createdAt: null, ageHours: null, due: false, managedBy: 'Neon' },
    });
  }
  return res.status(501).json({ error: 'This backup operation is managed through Neon database backups.' });
}

function healthHandler(_req: ApiRequest, res: ApiResponse): unknown {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, storage: 'cloud' });
}

const productCreateSchema = z.object({
  id: z.string().optional(), name: z.string().min(1).max(255), brand: z.string().min(1).max(100),
  department: z.enum(['beauty', 'groceries']), category: z.string().min(1), categoryLabel: z.string().min(1).max(100),
  price: z.union([z.string(), z.number()]), wholesalePrice: z.union([z.string(), z.number()]).optional().nullable(),
  costPrice: z.union([z.string(), z.number()]).optional().nullable(), unit: z.string().min(1).max(100),
  barcode: z.string().trim().max(128).optional().nullable(), serialNumber: z.string().trim().max(128).optional().nullable(),
  image: z.string().max(5_000_000).default(''), images: z.array(z.string().max(5_000_000)).default([]),
  inStock: z.boolean().default(true), isPublished: z.boolean().default(true), stockCount: z.number().int().min(0).default(0),
  reorderLevel: z.number().int().min(0).default(0), options: z.array(z.any()).default([]), variants: z.array(z.any()).default([]),
  description: z.string().optional(), highlights: z.array(z.string()).optional(), badge: z.string().nullable().optional(),
  deliveryPrice: z.number().nullable().optional(), originalPrice: z.number().nullable().optional(), discountBadge: z.string().nullable().optional(),
  origin: z.string().nullable().optional(), routineStep: z.string().nullable().optional(), skinType: z.array(z.string()).optional(),
  skinConcern: z.array(z.string()).optional(), packSize: z.string().nullable().optional(), storageInfo: z.string().nullable().optional(),
  shelfLife: z.string().nullable().optional(), details: z.any().optional(),
});

const productUpdateSchema = productCreateSchema.partial().omit({ id: true });
const categoryValues = ['all', 'skincare', 'makeup', 'fragrances', 'body-care', 'beauty-tools', 'rice-grains', 'cooking-oils', 'seasoning-spices', 'beverages', 'snacks-sweets', 'household-care', 'daily-essentials', 'new-arrivals', 'best-sellers', 'offers'];
const productColumnMap: Record<string, string> = {
  name: 'name', brand: 'brand', department: 'department', category: 'category', categoryLabel: 'category_label',
  price: 'price', wholesalePrice: 'wholesale_price', costPrice: 'cost_price_pesewas', unit: 'unit', barcode: 'barcode',
  serialNumber: 'serial_number', image: 'image', images: 'images', inStock: 'in_stock', isPublished: 'is_published',
  stockCount: 'stock_count', reorderLevel: 'reorder_level', options: 'options', variants: 'variants', description: 'description',
  highlights: 'highlights', badge: 'badge', deliveryPrice: 'delivery_price', originalPrice: 'original_price', discountBadge: 'discount_badge',
  origin: 'origin', routineStep: 'routine_step', skinType: 'skin_type', skinConcern: 'skin_concern', packSize: 'pack_size',
  storageInfo: 'storage_info', shelfLife: 'shelf_life', details: 'details',
};

function normalizeProduct(row: PgRow, includeCost: boolean) {
  const product = fromDbRow(row);
  const variants = Array.isArray(product.variants) ? product.variants as Array<PgRow> : [];
  const stockCount = variants.length ? variants.reduce((sum, variant) => sum + Math.max(0, Number(variant.stockCount || 0)), 0) : Number(product.stockCount || 0);
  product.stockCount = stockCount;
  product.inStock = variants.length ? variants.some(variant => variant.inStock && Number(variant.stockCount || 0) > 0) : Boolean(product.inStock) && stockCount > 0;
  if (!includeCost) delete product.costPricePesewas;
  return product;
}

async function productsHandler(req: ApiRequest, res: ApiResponse, subpath = ''): Promise<unknown> {
  const auth = await requireCloudAdmin(req, res, ['Super Admin', 'Store Manager', 'Inventory Dispatcher', 'Cashier']);
  if (!auth) return;
  const pool = getCloudPool();
  const id = subpath || getQuery(req.query, 'id');
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'private, no-store');
    if (id) {
      const { rows } = await pool.query('SELECT * FROM products WHERE id = $1 LIMIT 1', [id]);
      if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
      return res.status(200).json(normalizeProduct(rows[0], auth.adminRole !== 'Cashier'));
    }
    const limit = Math.min(Math.max(Number(getQuery(req.query, 'limit')) || 100, 1), 500);
    const offset = Math.max(Number(getQuery(req.query, 'offset')) || 0, 0);
    const includeUnpublished = getQuery(req.query, 'includeUnpublished') === 'true' && auth.adminRole !== 'Cashier';
    const search = getQuery(req.query, 'search');
    const barcode = getQuery(req.query, 'barcode') || getQuery(req.query, 'scanCode');
    const category = getQuery(req.query, 'category');
    const department = getQuery(req.query, 'department');
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (sqlText: string, value: unknown) => { values.push(value); conditions.push(sqlText.replace('?', `$${values.length}`)); };
    if (!includeUnpublished) conditions.push('is_published = true');
    if (search) add('(name ILIKE ? OR brand ILIKE ?)', `%${search}%`);
    if (search) { values.pop(); conditions.pop(); values.push(`%${search}%`); conditions.push(`(name ILIKE $${values.length} OR brand ILIKE $${values.length})`); }
    if (category && category !== 'all') add('category = ?', category);
    if (department) add('department = ?', department);
    if (barcode) add('(barcode = ? OR serial_number = ? OR variants::text LIKE ?)', barcode);
    if (barcode) { values.pop(); conditions.pop(); values.push(barcode); conditions.push(`(barcode = $${values.length} OR serial_number = $${values.length} OR variants::text LIKE $${values.length + 1})`); values.push(`%${barcode}%`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await pool.query(`SELECT count(*)::int AS count FROM products ${where}`, values);
    const listValues = [...values, limit, offset];
    const { rows } = await pool.query(`SELECT * FROM products ${where} ORDER BY created_at DESC LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`, listValues);
    const normalized = rows.map(row => normalizeProduct(row, auth.adminRole !== 'Cashier'))
      .filter(product => includeUnpublished || product.inStock);
    return res.status(200).json({ products: normalized, pagination: { total: Number(count.rows[0]?.count || 0), limit, offset, hasMore: offset + limit < Number(count.rows[0]?.count || 0) } });
  }

  if (req.method === 'POST') {
    if (getQuery(req.query, 'imageUpload') === 'true') {
      const image = typeof req.body?.image === 'string' ? req.body.image : '';
      if (!image.startsWith('data:image/')) return res.status(400).json({ error: 'Choose a valid product image.' });
      return res.status(201).json({ url: image });
    }
    if (getQuery(req.query, 'assignBarcodes') === 'true') {
      if (!['Super Admin','Store Manager','Inventory Dispatcher'].includes(auth.adminRole)) return res.status(403).json({ error: 'Your administrator role does not allow this action' });
      return withCloudTransaction(async client => {
        const { rows } = await client.query('SELECT id,barcode,serial_number FROM products ORDER BY created_at,id FOR UPDATE');
        const taken = new Set<string>();
        let highWater = Number((await client.query("SELECT value FROM store_settings WHERE key='inventory.barcodeSequence' LIMIT 1")).rows[0]?.value || 0);
        for (const row of rows) {
          if (row.barcode) {
            taken.add(String(row.barcode));
            const match = /^ACS-(\d{6})$/.exec(String(row.barcode));
            if (match) highWater = Math.max(highWater, Number(match[1]));
          }
          if (row.serial_number) taken.add(String(row.serial_number));
        }
        const needing = rows.filter(row => !row.barcode);
        const assigned: Array<{id:string;barcode:string}> = [];
        const skipped: string[] = [];
        for (const product of needing) {
          let number = highWater + 1;
          while (taken.has(`ACS-${String(number).padStart(6,'0')}`)) number++;
          if (number > 999999) { skipped.push(product.id); continue; }
          const barcode = `ACS-${String(number).padStart(6,'0')}`;
          taken.add(barcode);
          highWater = number;
          await client.query('UPDATE products SET barcode=$1,updated_at=now() WHERE id=$2',[barcode,product.id]);
          assigned.push({id:product.id,barcode});
        }
        await client.query("INSERT INTO store_settings(id,key,value,updated_at) VALUES($1,'inventory.barcodeSequence',$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[randomUUID(),String(highWater)]);
        return res.status(200).json({assigned,skipped,next:assigned.at(-1)?.barcode||null,sequence:highWater});
      });
    }
    const parsed = productCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid product data', details: parsed.error.flatten() });
    const data = parsed.data;
    const pricePesewas = requireMinor(data.price, 'price');
    const costPricePesewas = data.costPrice == null ? null : requireMinor(data.costPrice, 'cost price');
    const productId = data.id || `prod-${randomUUID()}`;
    // Column names and values are declared side by side, and the jsonb cast is
    // decided from the column itself. Deriving it from an index offset is how
    // every product create started failing: the cast landed on name, brand,
    // department, category, category_label, price and price_pesewas, so
    // Postgres answered 'column "price" is of type double precision but
    // expression is of type jsonb' before a row was written.
    const insertColumns = ['id','name','brand','department','category','category_label','price','price_pesewas',
      'cost_price_pesewas','reorder_level','wholesale_price','unit','barcode','serial_number','image','images',
      'description','highlights','badge','in_stock','is_published','stock_count','options','variants',
      'delivery_price','original_price','discount_badge','origin','routine_step','skin_type','skin_concern',
      'pack_size','storage_info','shelf_life','details'];
    const jsonbColumns = new Set(['images','highlights','options','variants','skin_type','skin_concern','details']);
    const values = [productId, data.name, data.brand, data.department, data.category, data.categoryLabel, pricePesewas / 100, pricePesewas, costPricePesewas,
      data.reorderLevel, data.wholesalePrice == null ? null : Number(data.wholesalePrice), data.unit, data.barcode || null, data.serialNumber || null,
      data.image, JSON.stringify(data.images), data.description || '', JSON.stringify(data.highlights || []), data.badge || null,
      data.stockCount > 0 && data.inStock, data.stockCount > 0 && data.isPublished, data.stockCount,
      JSON.stringify(data.options), JSON.stringify(data.variants), data.deliveryPrice ?? null, data.originalPrice ?? null,
      data.discountBadge ?? null, data.origin ?? null, data.routineStep ?? null, JSON.stringify(data.skinType || []),
      JSON.stringify(data.skinConcern || []), data.packSize ?? null, data.storageInfo ?? null, data.shelfLife ?? null,
      JSON.stringify(data.details ?? null)];
    if (values.length !== insertColumns.length) {
      return res.status(500).json({ error: `Product insert is misaligned: ${insertColumns.length} columns but ${values.length} values.` });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO products (${insertColumns.join(',')})
         VALUES (${insertColumns.map((column, index) => `$${index + 1}${jsonbColumns.has(column) ? '::jsonb' : ''}`).join(',')}) RETURNING *`,
        values,
      );
      return res.status(201).json(normalizeProduct(rows[0], auth.adminRole !== 'Cashier'));
    } catch (error: any) {
      if (error?.code === '23505') return res.status(409).json({ error: 'That barcode or serial number is already used by another product.' });
      throw error;
    }
  }

  if (req.method === 'PATCH') {
    if (!id) return res.status(400).json({ error: 'Product ID is required' });
    const parsed = productUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid product data', details: parsed.error.flatten() });
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, rawValue] of Object.entries(parsed.data)) {
      const column = productColumnMap[key];
      if (!column) continue;
      let value: unknown = rawValue;
      if (['images','options','variants','highlights','skinType','skinConcern','details'].includes(key)) value = JSON.stringify(rawValue ?? []);
      if (key === 'price') {
        const minor = requireMinor(rawValue, 'price');
        values.push(minor / 100); assignments.push(`price = $${values.length}`);
        values.push(minor); assignments.push(`price_pesewas = $${values.length}`);
        continue;
      }
      if (key === 'costPrice') {
        value = rawValue == null ? null : requireMinor(rawValue, 'cost price');
        values.push(value); assignments.push(`cost_price_pesewas = $${values.length}`); continue;
      }
      values.push(value); assignments.push(`${column} = $${values.length}${['images','options','variants','highlights','skinType','skinConcern','details'].includes(key) ? '::jsonb' : ''}`);
    }
    if (!assignments.length) return res.status(400).json({ error: 'No product fields to update.' });
    values.push(id);
    const { rows } = await pool.query(`UPDATE products SET ${assignments.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`, values);
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    return res.status(200).json(normalizeProduct(rows[0], auth.adminRole !== 'Cashier'));
  }

  if (req.method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'Product ID is required' });
    const { rows } = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
    return res.status(200).json({ success: true, id: rows[0].id });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function catalogHandler(req: ApiRequest, res: ApiResponse): Promise<unknown> {
  const resource = getQuery(req.query, 'resource') === 'categories' ? 'categories' : 'brands';
  const auth = await requireCloudAdmin(req, res, req.method === 'GET' ? ROLES : ['Super Admin', 'Store Manager']);
  if (!auth) return;
  const pool = getCloudPool();
  const id = getQuery(req.query, 'id');
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'private, no-store');
    const values: unknown[] = [];
    const where: string[] = [];
    if (id) { values.push(resource === 'brands' ? id : id); where.push(`id = $${values.length}`); }
    const department = getQuery(req.query, 'department');
    if (department && resource === 'categories') { values.push(department); where.push(`department = $${values.length}`); }
    const active = getQuery(req.query, 'active');
    if (active) { values.push(active === 'true'); where.push(`is_active = $${values.length}`); }
    const sort = resource === 'brands' ? 'name' : 'sort_order';
    const { rows } = await pool.query(`SELECT * FROM ${resource} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${sort}`, values);
    if (id && !rows[0]) return res.status(404).json({ error: `${resource === 'brands' ? 'Brand' : 'Category'} not found` });
    return res.status(200).json(id ? fromDbRow(rows[0]) : rows.map(fromDbRow));
  }
  if (req.method === 'POST') {
    if (resource === 'brands') {
      const parsed = z.object({ name: z.string().trim().min(1).max(100), isActive: z.boolean().default(true) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid brand data' });
      const { rows } = await pool.query('INSERT INTO brands (id,name,is_active) VALUES ($1,$2,$3) RETURNING *', [randomUUID(), parsed.data.name, parsed.data.isActive]);
      return res.status(201).json(fromDbRow(rows[0]));
    }
    const parsed = z.object({ id: z.string().min(1), slug: z.string().min(1), name: z.string().min(1), department: z.enum(['beauty','groceries']), image: z.string().default(''), description: z.string().default(''), isActive: z.boolean().default(true), sortOrder: z.number().int().default(0) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid category data' });
    const data = parsed.data;
    const { rows } = await pool.query('INSERT INTO categories(id,slug,name,department,image,description,is_active,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [data.id,data.slug,data.name,data.department,data.image,data.description,data.isActive,data.sortOrder]);
    return res.status(201).json(fromDbRow(rows[0]));
  }
  if (req.method === 'PATCH' && id) {
    const mapping: Record<string,string> = resource === 'brands'
      ? { name:'name', isActive:'is_active' }
      : { slug:'slug', name:'name', department:'department', image:'image', description:'description', isActive:'is_active', sortOrder:'sort_order' };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key,column] of Object.entries(mapping)) {
      if (req.body?.[key] === undefined) continue;
      values.push(req.body[key]);
      sets.push(`${column} = $${values.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update.' });
    sets.push('updated_at = now()');
    values.push(id);
    const { rows } = await pool.query(`UPDATE ${resource} SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    return rows[0] ? res.status(200).json(fromDbRow(rows[0])) : res.status(404).json({ error: 'Not found' });
  }
  if (req.method === 'DELETE' && id) {
    const keyColumn = resource === 'brands' ? 'name' : 'id';
    const { rows } = await pool.query(`DELETE FROM ${resource} WHERE ${keyColumn} = $1 RETURNING id`, [id]);
    return rows[0] ? res.status(200).json({ success: true, id: rows[0].id }) : res.status(404).json({ error: 'Not found' });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function settingsHandler(req: ApiRequest, res: ApiResponse): Promise<unknown> {
  const resource = getQuery(req.query, 'resource');
  if (resource === 'hardware') {
    const auth = await requireCloudAdmin(req, res, req.method === 'GET' ? ROLES : ['Super Admin','Store Manager']);
    if (!auth) return;
    const stored = await getSetting('hardware.settings');
    if (req.method === 'GET') return res.status(200).json(normalizeHardwareSettings(stored ? JSON.parse(stored) : null));
    if (!['PUT','PATCH','POST'].includes(req.method || '')) return res.status(405).json({ error: 'Method not allowed' });
    const cleaned = normalizeHardwareSettings(req.body);
    await setSetting('hardware.settings', JSON.stringify(cleaned));
    return res.status(200).json(cleaned);
  }
  const auth = await requireCloudAdmin(req, res);
  if (!auth) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'POS settings are read-only.' });
  const { rows } = await getCloudPool().query('SELECT key, value FROM store_settings WHERE key = ANY($1::text[])', [['storeName','storeEmail','storePhone','storeAddress']]);
  return res.status(200).json({ settings: rows.map(fromDbRow), hardware: normalizeHardwareSettings(JSON.parse(await getSetting('hardware.settings') || 'null')) });
}

async function ordersHandler(req: ApiRequest, res: ApiResponse): Promise<unknown> {
  const pool = getCloudPool();
  const auth = await requireCloudAdmin(req, res, ROLES);
  if (!auth) return;
  if (req.method === 'GET') {
    const limit = Math.min(Math.max(Number(getQuery(req.query, 'limit')) || 50, 1), 100);
    const id = getQuery(req.query, 'id');
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (id) { values.push(id); conditions.push(`id = $${values.length}`); }
    if (auth.adminRole === 'Cashier') {
      values.push(auth.adminName || auth.email);
      conditions.push(`order_source = 'pos' AND cashier_name = $${values.length}`);
    }
    values.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    return res.status(200).json(id ? (rows[0] ? fromDbRow(rows[0]) : { error: 'Order not found' }) : { orders: rows.map(fromDbRow) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (getQuery(req.query, 'action') === 'refund') {
    if (!['Super Admin','Store Manager'].includes(auth.adminRole)) return res.status(403).json({ error: 'Only a manager can refund a sale.' });
    const parsed = z.object({ orderId: z.string().uuid(), reason: z.string().trim().min(3).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'A refund reason is required.' });
    const refunded = await withCloudTransaction(async client => {
      const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [parsed.data.orderId]);
      const order = rows[0];
      if (!order || order.order_source !== 'pos') throw Object.assign(new Error('POS sale not found.'), { statusCode: 404 });
      if (order.status === 'Refunded') throw Object.assign(new Error('This sale has already been refunded.'), { statusCode: 409 });
      for (const item of (order.items || []) as PgRow[]) {
        const productId = item.product?.id;
        if (!productId) continue;
        const { rows: productRows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [productId]);
        const product = productRows[0];
        if (!product) continue;
        const variantId = item.selectedVariant?.id;
        const quantity = Number(item.quantity || 0);
        if (variantId) {
          const variants = Array.isArray(product.variants) ? product.variants : [];
          const nextVariants = variants.map((variant: PgRow) => variant.id === variantId
            ? { ...variant, stockCount: Number(variant.stockCount || 0) + quantity, inStock: true }
            : variant);
          const nextStock = nextVariants.reduce((sum: number, variant: PgRow) => sum + Number(variant.stockCount || 0), 0);
          const prior = variants.find((variant: PgRow) => variant.id === variantId);
          await client.query('UPDATE products SET variants = $1::jsonb, stock_count = $2, in_stock = true, is_published = true, updated_at = now() WHERE id = $3', [JSON.stringify(nextVariants), nextStock, productId]);
          await client.query('INSERT INTO inventory_movements(id,product_id,variant_id,order_id,movement_type,quantity,quantity_before,quantity_after,actor_name,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [randomUUID(), productId, variantId, order.id, 'POS_REFUND', quantity, Number(prior?.stockCount || 0), Number(prior?.stockCount || 0) + quantity, auth.adminName, `Refund: ${parsed.data.reason}`]);
        } else {
          const before = Number(product.stock_count || 0);
          const after = before + quantity;
          await client.query('UPDATE products SET stock_count = $1, in_stock = true, is_published = true, updated_at = now() WHERE id = $2', [after, productId]);
          await client.query('INSERT INTO inventory_movements(id,product_id,order_id,movement_type,quantity,quantity_before,quantity_after,actor_name,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), productId, order.id, 'POS_REFUND', quantity, before, after, auth.adminName, `Refund: ${parsed.data.reason}`]);
        }
      }
      await client.query('UPDATE pos_payments SET status = $1 WHERE order_id = $2', ['REFUNDED', order.id]);
      const { rows: updated } = await client.query("UPDATE orders SET status = 'Refunded', updated_at = now() WHERE id = $1 RETURNING *", [order.id]);
      await client.query('INSERT INTO audit_logs(id,action,entity_type,entity_id,actor_name,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [randomUUID(), 'POS_SALE_REFUNDED', 'order', order.id, auth.adminName, JSON.stringify({ orderNumber: order.order_number, adminId: auth.sub, reason: parsed.data.reason })]);
      return updated[0];
    });
    return res.status(200).json(fromDbRow(refunded));
  }

  if (getQuery(req.query, 'channel') !== 'pos') return res.status(400).json({ error: 'This endpoint accepts counter sales only.' });
  const saleSchema = z.object({
    items: z.array(z.object({ product: z.object({ id: z.string(), price: z.coerce.number() }), quantity: z.number().int().positive(), selectedVariant: z.object({ id: z.string() }).optional() })).min(1),
    subtotal: z.coerce.number().positive(), shippingFee: z.coerce.number().min(0), discount: z.coerce.number().min(0), total: z.coerce.number().positive(),
    appliedPromoCode: z.string().trim().max(50).optional(), paymentMethod: z.enum(['cash-on-delivery','momo-mtn']),
    paymentReference: z.string().trim().max(100).optional(), paymentSenderPhone: z.string().trim().max(50).optional(), cashReceived: z.coerce.number().nonnegative().optional(),
    idempotencyKey: z.string().trim().min(12).max(160), deviceId: z.string().optional(),
    shippingAddress: z.object({ fullName:z.string().min(1), phone:z.string().min(1), city:z.string().min(1), area:z.string().min(1) }),
    tenders: z.array(z.object({ method:z.enum(['cash-on-delivery','momo-mtn']), amount:z.number().int().positive(), reference:z.string().optional(), senderPhone:z.string().optional() })).max(4).optional(),
  }).safeParse(req.body);
  if (!saleSchema.success) return res.status(400).json({ error: 'Invalid sale details.', details: saleSchema.error.flatten() });
  const sale = saleSchema.data;
  if (sale.shippingFee !== 0) return res.status(400).json({ error: 'Counter sales cannot include delivery fees.' });
  if (auth.adminRole === 'Cashier' && (sale.appliedPromoCode || sale.discount > 0)) return res.status(403).json({ error: 'Only a manager can apply a promo or discount.' });
  const created = await withCloudTransaction(async client => {
    const { rows: existingRows } = await client.query('SELECT * FROM orders WHERE idempotency_key = $1 LIMIT 1', [sale.idempotencyKey]);
    if (existingRows[0]) return existingRows[0];
    const itemIds = [...new Set(sale.items.map(item => item.product.id))].sort();
    const { rows: productRows } = await client.query('SELECT * FROM products WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [itemIds]);
    const byId = new Map(productRows.map(product => [product.id, product]));
    const quantities = new Map<string, number>();
    const variantQuantities = new Map<string, number>();
    const verifiedItems: PgRow[] = [];
    let subtotal = 0;
    for (const item of sale.items) {
      const product = byId.get(item.product.id);
      if (!product || !product.is_published) throw Object.assign(new Error(`Product is unavailable: ${item.product.id}`), { statusCode: 409 });
      const variants = Array.isArray(product.variants) ? product.variants : [];
      const variant = item.selectedVariant ? variants.find((entry: PgRow) => entry.id === item.selectedVariant?.id) : undefined;
      if (item.selectedVariant && !variant) throw Object.assign(new Error('Product variation is unavailable.'), { statusCode: 409 });
      if (variants.length && !variant) throw Object.assign(new Error(`Choose a variation for ${product.name}.`), { statusCode: 409 });
      const map = variant ? variantQuantities : quantities;
      const key = variant ? `${product.id}:${variant.id}` : product.id;
      map.set(key, (map.get(key) || 0) + item.quantity);
      const retail = Number(product.price_pesewas ?? requireMinor(variant?.price ?? product.price, 'price'));
      const wholesale = variant?.wholesalePrice != null ? requireMinor(variant.wholesalePrice, 'wholesale price') : product.wholesale_price != null ? requireMinor(product.wholesale_price, 'wholesale price') : null;
      const entered = requireMinor(item.product.price, 'price');
      const unit = wholesale != null && Math.abs(entered - wholesale) <= 1 ? wholesale : retail;
      subtotal += unit * item.quantity;
      verifiedItems.push({ product:{id:product.id,name:product.name,brand:product.brand,price:toMajor(unit),image:variant?.image||product.image,unit:product.unit,category:product.category,inStock:Boolean(product.in_stock),stockCount:Number(product.stock_count)}, quantity:item.quantity, selectedVariant:variant?{id:variant.id,name:variant.name,price:toMajor(unit),inStock:Boolean(variant.inStock)}:undefined });
    }
    let discount = 0;
    let promo: PgRow | undefined;
    if (sale.appliedPromoCode) {
      const result = await client.query('SELECT * FROM promo_codes WHERE code = $1 LIMIT 1 FOR UPDATE', [sale.appliedPromoCode.toUpperCase()]);
      promo = result.rows[0];
      if (!promo || !promo.is_active || (promo.expiry_date && new Date(promo.expiry_date).getTime() < Date.now()) || (promo.max_usage != null && promo.usage_count >= promo.max_usage)) throw Object.assign(new Error('Promo code is no longer valid.'), {statusCode:409});
      if (promo.min_spend_pesewas != null && subtotal < Number(promo.min_spend_pesewas)) throw Object.assign(new Error('Sale does not meet the promo minimum.'), {statusCode:409});
      discount = promo.discount_type === 'percentage' ? applyPercentageMinor(subtotal, Math.round(Number(promo.discount_value))) : Math.min(subtotal, Number(promo.discount_value_pesewas ?? requireMinor(promo.discount_value,'discount')));
    }
    const total = subtotal - discount;
    if (requireMinor(sale.subtotal,'subtotal') !== subtotal || requireMinor(sale.discount,'discount') !== discount || requireMinor(sale.total,'total') !== total) throw Object.assign(new Error('Sale pricing changed. Review the ticket and try again.'), { statusCode: 409 });
    const tenders = sale.tenders?.length ? sale.tenders : [{method:sale.paymentMethod,amount:sale.paymentMethod==='cash-on-delivery'&&sale.cashReceived!=null?Math.min(requireMinor(sale.cashReceived,'cash received'),total):total,reference:sale.paymentReference,senderPhone:sale.paymentSenderPhone}];
    let allocated = 0; let change = 0;
    const applied: typeof tenders = [];
    for (const tender of tenders) {
      const remaining = total - allocated;
      if (tender.amount > remaining && tender.method !== 'cash-on-delivery') throw Object.assign(new Error('A non-cash payment must match the amount exactly.'), {statusCode:400});
      const amount = Math.min(tender.amount, remaining);
      change += tender.amount - amount;
      allocated += amount;
      applied.push({...tender, amount});
    }
    if (allocated !== total) throw Object.assign(new Error('The payments do not match the sale total.'), {statusCode:400});
    for (const [productId, quantity] of quantities) { const p=byId.get(productId)!; if (!p.in_stock || Number(p.stock_count)<quantity) throw Object.assign(new Error(`Insufficient stock for ${p.name}.`),{statusCode:409}); }
    for (const [key, quantity] of variantQuantities) { const [productId,variantId]=key.split(':'); const p=byId.get(productId)!; const variant=(p.variants||[]).find((entry:PgRow)=>entry.id===variantId); if(!variant||!variant.inStock||Number(variant.stockCount||0)<quantity) throw Object.assign(new Error('A selected variation has insufficient stock.'),{statusCode:409}); }
    const orderId=randomUUID();
    const date=new Date();
    const orderNumber=`POS-${String(date.getFullYear()).slice(-2)}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}-${randomUUID().slice(0,6).toUpperCase()}`;
    const paymentMethod=applied[0]?.method||sale.paymentMethod;
    const paymentReference=applied.find(t=>t.method==='momo-mtn')?.reference||sale.paymentReference||null;
    const paymentSender=applied.find(t=>t.method==='momo-mtn')?.senderPhone||sale.paymentSenderPhone||null;
    const {rows: orderRows}=await client.query(`INSERT INTO orders(id,order_number,items,subtotal,subtotal_pesewas,shipping_fee,discount,discount_pesewas,total,total_pesewas,payment_method,payment_status,order_source,delivery_method,shipping_address,status,applied_promo_code,payment_reference,payment_sender_phone,idempotency_key,cashier_name)
      VALUES($1,$2,$3::jsonb,$4,$5,0,$6,$7,$8,$9,$10,'paid','pos','store-pickup',$11::jsonb,'Delivered',$12,$13,$14,$15,$16) RETURNING *`,
      [orderId,orderNumber,JSON.stringify(verifiedItems),toMajor(subtotal),subtotal,toMajor(discount),discount,toMajor(total),total,paymentMethod,JSON.stringify(sale.shippingAddress),promo?.code||null,paymentReference,paymentSender,sale.idempotencyKey,auth.adminName||auth.email]);
    if (promo) await client.query('UPDATE promo_codes SET usage_count=usage_count+1,updated_at=now() WHERE code=$1',[promo.code]);
    if (promo || discount > 0) await client.query('INSERT INTO audit_logs(id,action,entity_type,entity_id,actor_name,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[randomUUID(),'POS_DISCOUNT_APPLIED','order',orderId,auth.adminName,JSON.stringify({orderNumber,adminId:auth.sub,promoCode:promo?.code||null,discount:toMajor(discount),subtotal,total:toMajor(total),appliedByRole:auth.adminRole})]);
    for (const tender of applied) await client.query('INSERT INTO pos_payments(id,order_id,method,status,amount,amount_pesewas,tendered_pesewas,change_pesewas,reference,cash_received,change_given,cashier_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[randomUUID(),orderId,tender.method,'SUCCESS',toMajor(tender.amount),tender.amount,tender.method==='cash-on-delivery'?tender.amount+change:null,tender.method==='cash-on-delivery'?change:null,tender.reference||null,tender.method==='cash-on-delivery'?toMajor(tender.amount+change):null,tender.method==='cash-on-delivery'?toMajor(change):null,auth.adminName||auth.email]);
    for (const [productId,quantity] of quantities) { const p=byId.get(productId)!; const after=Number(p.stock_count)-quantity; await client.query('UPDATE products SET stock_count=$1,in_stock=$2,is_published=$2,updated_at=now() WHERE id=$3',[after,after>0,productId]); await client.query('INSERT INTO inventory_movements(id,product_id,order_id,movement_type,quantity,quantity_before,quantity_after,actor_name,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),productId,orderId,'POS_SALE',-quantity,p.stock_count,after,auth.adminName,`POS sale ${orderNumber}`]); }
    for (const [key,quantity] of variantQuantities) { const [productId,variantId]=key.split(':'); const p=byId.get(productId)!; const beforeVariants=p.variants||[]; const before=beforeVariants.find((v:PgRow)=>v.id===variantId); const variants=beforeVariants.map((v:PgRow)=>v.id===variantId?{...v,stockCount:Number(v.stockCount||0)-quantity,inStock:Number(v.stockCount||0)-quantity>0}:v); const after=variants.reduce((sum:number,v:PgRow)=>sum+Number(v.stockCount||0),0); await client.query('UPDATE products SET variants=$1::jsonb,stock_count=$2,in_stock=$3,is_published=$3,updated_at=now() WHERE id=$4',[JSON.stringify(variants),after,after>0,productId]); await client.query('INSERT INTO inventory_movements(id,product_id,variant_id,order_id,movement_type,quantity,quantity_before,quantity_after,actor_name,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),productId,variantId,orderId,'POS_SALE',-quantity,before.stockCount,Number(before.stockCount)-quantity,auth.adminName,`POS sale ${orderNumber}`]); }
    await client.query('INSERT INTO audit_logs(id,action,entity_type,entity_id,actor_name,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[randomUUID(),'POS_SALE_COMPLETED','order',orderId,auth.adminName,JSON.stringify({orderNumber,total:toMajor(total),idempotencyKey:sale.idempotencyKey,adminId:auth.sub,paymentMethod})]);
    return orderRows[0];
  });
  return res.status(201).json(fromDbRow(created));
}

async function reportsHandler(req: ApiRequest, res: ApiResponse): Promise<unknown> {
  const pool = getCloudPool();
  const auth = await requireCloudAdmin(req, res, ROLES);
  if (!auth) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const report = getQuery(req.query, 'report') || 'summary';
  const format = getQuery(req.query, 'format') || 'json';
  const fromDay = getQuery(req.query, 'from') || new Date().toISOString().split('T')[0];
  const toDay = getQuery(req.query, 'to') || new Date().toISOString().split('T')[0];

  const from = new Date(`${fromDay}T00:00:00+00:00`);
  const to = new Date(`${toDay}T23:59:59+00:00`);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    return res.status(400).json({ error: 'Invalid date range.' });
  }
  if (to < from) return res.status(400).json({ error: 'End date is before start date.' });

  const cashierFilter = auth.adminRole === 'Cashier' ? ` AND cashier_name = $${[auth.adminName || auth.email].length + 2}` : '';
  const values: unknown[] = [from, to];
  if (auth.adminRole === 'Cashier') values.push(auth.adminName || auth.email);

  const { rows: orders } = await pool.query(
    `SELECT id, order_number, items, total_pesewas, discount_pesewas, status, cashier_name, applied_promo_code, created_at
     FROM orders WHERE order_source = 'pos' AND created_at >= $1 AND created_at < $2${cashierFilter} ORDER BY created_at DESC`,
    values,
  );

  const { rows: payments } = await pool.query(
    `SELECT order_id, method, amount_pesewas FROM pos_payments WHERE order_id = ANY($1)`,
    [orders.map((o: any) => o.id)],
  );

  const sales = orders.map((o: any) => ({
    ...o,
    total: Number(o.total_pesewas) || 0,
    discount: Number(o.discount_pesewas) || 0,
    tenders: payments.filter((p: any) => p.order_id === o.id).map((p: any) => ({ method: p.method, amount: Number(p.amount_pesewas) || 0 })),
  }));

  const totals = summariseCloud(sales);
  const days = getDaysInRange(fromDay, toDay);

  if (format === 'csv' || format === 'pdf') {
    const payload = buildCloudReport(report, sales, days, { from: fromDay, to: toDay }, totals);
    if (format === 'csv') {
      const csv = buildCloudCsv(payload.csv);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}.csv"`);
      return res.status(200).end(`\uFEFF${csv}`);
    }
    if (format === 'pdf') {
      const pdf = buildCloudPdf({ title: payload.title, subtitle: `${fromDay} to ${toDay}`, sections: [payload.pdf] });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}.pdf"`);
      return res.status(200).end(pdf);
    }
  }

  const data = buildCloudReportData(report, sales, days, { from: fromDay, to: toDay }, totals);
  return res.status(200).json(data);
}

function summariseCloud(sales: any[]) {
  const byPayment: Record<string, { amount: number; count: number; refunded: number; refundedCount: number }> = {};
  const byCashier: Record<string, { amount: number; count: number; refunded: number; discounted: number }> = {};
  const byDay: Record<string, { amount: number; count: number; refunded: number; discounted: number }> = {};
  const byProduct: Record<string, { name: string; quantity: number; amount: number }> = {};
  const byCategory: Record<string, { name: string; quantity: number; amount: number }> = {};

  let gross = 0, net = 0, refunded = 0, discounted = 0, voidedLines = 0;

  for (const sale of sales) {
    const total = Number(sale.total) || 0;
    const isRefunded = sale.status === 'Refunded';
    const day = new Date(sale.created_at).toISOString().split('T')[0];
    const tenders = sale.tenders && sale.tenders.length ? sale.tenders : [{ method: 'cash-on-delivery', amount: total }];

    for (const tender of tenders) {
      const label = tender.method === 'cash-on-delivery' ? 'Cash' : tender.method === 'momo-mtn' ? 'MTN Mobile Money' : tender.method;
      const bucket = (byPayment[label] ||= { amount: 0, count: 0, refunded: 0, refundedCount: 0 });
      if (isRefunded) { bucket.refunded += Number(tender.amount) || 0; bucket.refundedCount++; }
      else { bucket.amount += Number(tender.amount) || 0; bucket.count++; }
    }

    const cashier = sale.cashier_name || 'Unknown';
    const cashierBucket = (byCashier[cashier] ||= { amount: 0, count: 0, refunded: 0, discounted: 0 });
    const dayBucket = (byDay[day] ||= { amount: 0, count: 0, refunded: 0, discounted: 0 });
    gross += total;

    if (isRefunded) { refunded += total; cashierBucket.refunded += total; dayBucket.refunded += total; }
    else { net += total; cashierBucket.amount += total; cashierBucket.count++; dayBucket.amount += total; dayBucket.count++; }

    if (!isRefunded && Number(sale.discount) > 0) { discounted += Number(sale.discount); cashierBucket.discounted += Number(sale.discount); dayBucket.discounted += Number(sale.discount); }

    const voided = Array.isArray(sale.voided_lines) ? sale.voided_lines.length : 0;
    voidedLines += voided;

    for (const entry of (Array.isArray(sale.items) ? sale.items : []) as any[]) {
      const product = entry?.product || {};
      const key = String(product.id || 'unknown');
      const productBucket = (byProduct[key] ||= { name: product.name || key, quantity: 0, amount: 0 });
      const categoryBucket = (byCategory[product.category || 'other'] ||= { name: product.category_label || product.category || 'Uncategorised', quantity: 0, amount: 0 });
      const quantity = Number(entry?.quantity) || 0;
      const lineAmount = quantity * (Number(product.price_pesewas) || Number(product.price) * 100 || 0);
      if (!isRefunded) { productBucket.quantity += quantity; productBucket.amount += lineAmount; categoryBucket.quantity += quantity; categoryBucket.amount += lineAmount; }
    }
  }

  return { gross, net, refunded, discounted, voidedLines, saleCount: sales.filter(s => s.status !== 'Refunded').length, refundCount: sales.filter(s => s.status === 'Refunded').length, byPayment, byCashier, byDay, byProduct, byCategory };
}

function getDaysInRange(from: string, to: string): string[] {
  const days: string[] = [];
  const current = new Date(from);
  const end = new Date(to);
  while (current <= end) { days.push(current.toISOString().split('T')[0]); current.setDate(current.getDate() + 1); }
  return days;
}

function buildCloudReportData(report: string, sales: any[], days: string[], range: { from: string; to: string }, totals: any) {
  const base = {
    range, currency: 'GHS',
    totals: {
      gross: totals.gross / 100, net: totals.net / 100, refunded: totals.refunded / 100, discounted: totals.discounted / 100,
      saleCount: totals.saleCount, refundCount: totals.refundCount, voidedLines: totals.voidedLines,
      grossFormatted: formatCloudMoney(totals.gross), netFormatted: formatCloudMoney(totals.net),
      refundedFormatted: formatCloudMoney(totals.refunded), discountedFormatted: formatCloudMoney(totals.discounted),
    },
  };

  if (report === 'products' || report === 'categories') {
    const source = report === 'products' ? totals.byProduct : totals.byCategory;
    const rows = Object.entries(source).map(([key, value]: [string, any]) => ({ key, name: value.name, quantity: value.quantity, amount: value.amount / 100 })).sort((a, b) => b.amount - a.amount);
    return { ...base, rows };
  }

  const dayRows = days.map(day => {
    const bucket = totals.byDay[day] || { amount: 0, count: 0, refunded: 0, discounted: 0 };
    return { day, label: day, sales: bucket.amount / 100, count: bucket.count, refunded: bucket.refunded / 100, discounted: bucket.discounted / 100, salesFormatted: formatCloudMoney(bucket.amount) };
  });
  const paymentRows = Object.entries(totals.byPayment).map(([label, value]: [string, any]) => ({ method: label, amount: value.amount / 100, count: value.count, refunded: value.refunded / 100, amountFormatted: formatCloudMoney(value.amount), refundedFormatted: formatCloudMoney(value.refunded) }));
  const cashierRows = Object.entries(totals.byCashier).map(([name, value]: [string, any]) => ({ cashier: name, amount: value.amount / 100, count: value.count, refunded: value.refunded / 100, discounted: value.discounted / 100, amountFormatted: formatCloudMoney(value.amount), refundedFormatted: formatCloudMoney(value.refunded) }));

  return { ...base, days: dayRows, byPayment: paymentRows, byCashier: cashierRows };
}

function buildCloudReport(report: string, sales: any[], days: string[], range: { from: string; to: string }, totals: any) {
  const data = buildCloudReportData(report, sales, days, range, totals) as any;
  const title = report === 'products' ? 'Sales by product' : report === 'categories' ? 'Sales by category' : 'Sales summary';
  const filename = `anda-sales-${report}`;

  if (report === 'products' || report === 'categories') {
    return {
      title, filename, data,
      csv: { header: report === 'products' ? ['Product ID', 'Product', 'Units sold', 'Amount (GHS)'] : ['Category', 'Name', 'Units sold', 'Amount (GHS)'], rows: data.rows.map((row: any) => report === 'products' ? [row.key, row.name, String(row.quantity), row.amount.toFixed(2)] : [row.key, row.name, String(row.quantity), row.amount.toFixed(2)]) },
      pdf: { table: { title, columns: report === 'products' ? ['Product', 'Units', 'Amount'] : ['Category', 'Units', 'Amount'], rows: data.rows.map((row: any) => [row.name, String(row.quantity), `GHS ${row.amount.toFixed(2)}`]) }, keyValues: summaryPairsCloud(data.totals) },
    };
  }

  return {
    title, filename, data,
    csv: { header: ['Day', 'Sales', 'Sales count', 'Refunded', 'Discounts given'], rows: data.days.map((row: any) => [row.day, row.sales.toFixed(2), String(row.count), row.refunded.toFixed(2), row.discounted.toFixed(2)]) },
    pdf: { table: { title: 'Sales by day', columns: ['Day', 'Sales', 'Count', 'Refunded', 'Discounts'], rows: data.days.map((row: any) => [row.day, `GHS ${row.sales.toFixed(2)}`, String(row.count), `GHS ${row.refunded.toFixed(2)}`, `GHS ${row.discounted.toFixed(2)}`]) }, keyValues: summaryPairsCloud(data.totals), secondTable: { title: 'Sales by payment type', columns: ['Payment', 'Amount', 'Count', 'Refunded'], rows: data.byPayment.map((row: any) => [row.method, `GHS ${row.amount.toFixed(2)}`, String(row.count), `GHS ${row.refunded.toFixed(2)}`]) } },
  };
}

function buildCloudCsv(csv: { header: string[]; rows: string[][] }): string {
  return [csv.header.join(','), ...csv.rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))].join('\n');
}

function buildCloudPdf(opts: { title: string; subtitle: string; sections: any[] }): string {
  return `%PDF-1.4\n% Report: ${opts.title}\n${opts.subtitle}\n`;
}

function formatCloudMoney(pesewas: number): string {
  return `GH\u20B5 ${(pesewas / 100).toFixed(2)}`;
}

function summaryPairsCloud(totals: any): Array<[string, string]> {
  return [['Gross sales', totals.grossFormatted], ['Refunds', totals.refundedFormatted], ['Discounts given', totals.discountedFormatted], ['Sales counted', String(totals.saleCount)], ['Refunds counted', String(totals.refundCount)], ['Lines voided', String(totals.voidedLines)]];
}

async function heldSalesHandler(req: ApiRequest, res: ApiResponse): Promise<unknown> {
  const auth = await requireCloudAdmin(req, res);
  if (!auth) return;
  const pool = getCloudPool();
  const action = getQuery(req.query, 'action');
  if (req.method === 'GET') {
    const { rows } = await pool.query('SELECT * FROM held_sales ORDER BY created_at DESC LIMIT 100');
    return res.status(200).json({ heldSales: rows.map(fromDbRow) });
  }
  if (req.method === 'POST' && !action) {
    const parsed = z.object({ items:z.array(z.unknown()).min(1), subtotal:z.coerce.number().min(0), discount:z.coerce.number().min(0).default(0), total:z.coerce.number().min(0), promoCode:z.string().optional(), paymentMethod:z.string().optional(), cashReceived:z.coerce.number().nonnegative().optional(), deviceId:z.string().optional(), ticketLabel:z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'That ticket cannot be held.' });
    const data = parsed.data;
    const { rows } = await pool.query('INSERT INTO held_sales(id,ticket_label,device_id,items,subtotal,discount,total,promo_code,payment_method,cash_received,held_by) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [randomUUID(),data.ticketLabel || `Held ${new Date().toLocaleTimeString()}`,data.deviceId || null,JSON.stringify(data.items),data.subtotal,data.discount,data.total,data.promoCode || null,data.paymentMethod || null,data.cashReceived ?? null,auth.adminName || auth.email]);
    await recordCloudAudit(auth, 'POS_HELD_SALE', 'held_sale', rows[0].id, { event:'held', total:data.total, lineCount:data.items.length });
    return res.status(201).json(fromDbRow(rows[0]));
  }
  if (req.method === 'POST' && action === 'recall') {
    const id = String(req.body?.id || getQuery(req.query, 'id'));
    if (!id) return res.status(400).json({ error: 'Which held sale should be recalled?' });
    return withCloudTransaction(async client => {
      const { rows } = await client.query('SELECT * FROM held_sales WHERE id=$1 FOR UPDATE', [id]);
      if (!rows[0]) return res.status(404).json({ error: 'That held sale is no longer available.' });
      if (rows[0].recalled_at) return res.status(409).json({ error: 'That held sale has already been recalled.' });
      const updated = await client.query('UPDATE held_sales SET recalled_at=now() WHERE id=$1 RETURNING *', [id]);
      await recordCloudAudit(auth, 'POS_HELD_SALE', 'held_sale', id, { event:'recalled', total:rows[0].total });
      return res.status(200).json(fromDbRow(updated.rows[0]));
    });
  }
  if (req.method === 'DELETE') {
    const id = getQuery(req.query, 'id');
    if (!id) return res.status(400).json({ error: 'Which held sale should be discarded?' });
    const { rows } = await pool.query('DELETE FROM held_sales WHERE id=$1 RETURNING id', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'That held sale is no longer available.' });
    await recordCloudAudit(auth, 'POS_HELD_SALE', 'held_sale', id, { event:'discarded' });
    return res.status(200).json({ discarded:true, id });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function stockInHandler(req: ApiRequest, res: ApiResponse): Promise<unknown> {
  const auth = await requireCloudAdmin(req, res, ['Super Admin','Store Manager','Inventory Dispatcher']);
  if (!auth) return;
  const pool = getCloudPool();
  if (req.method === 'GET') {
    const limit = Math.min(Math.max(Number(getQuery(req.query,'limit')) || 25,1),100);
    const { rows } = await pool.query('SELECT * FROM inventory_movements ORDER BY created_at DESC LIMIT $1', [limit]);
    return res.status(200).json({ movements:rows.map(fromDbRow) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  const parsed = z.object({ productId:z.string().min(1), variantId:z.string().optional(), quantity:z.number().int().positive().max(100000), reason:z.string().max(200).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error:'Enter a valid quantity.' });
  const data = parsed.data;
  const reason = data.reason?.trim() || 'Stock received';
  try {
    const result = await withCloudTransaction(async client => {
      const { rows } = await client.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [data.productId]);
      const product = rows[0];
      if (!product) throw Object.assign(new Error('That product is not in the catalogue.'), { statusCode:404 });
      const variants: PgRow[] = Array.isArray(product.variants) ? product.variants : [];
      let before = Number(product.stock_count || 0);
      let after: number;
      if (data.variantId) {
        const target = variants.find(variant => variant.id === data.variantId);
        if (!target) throw Object.assign(new Error('That variation no longer exists.'), { statusCode:404 });
        before = Number(target.stockCount || 0);
        const nextVariants = variants.map(variant => variant.id === data.variantId ? { ...variant, stockCount:before + data.quantity, inStock:true } : variant);
        after = nextVariants.reduce((sum,variant) => sum + Number(variant.stockCount || 0),0);
        await client.query('UPDATE products SET variants=$1::jsonb,stock_count=$2,in_stock=$3,is_published=$3,updated_at=now() WHERE id=$4', [JSON.stringify(nextVariants),after,after>0,data.productId]);
      } else {
        after = before + data.quantity;
        await client.query('UPDATE products SET stock_count=$1,in_stock=$2,is_published=$2,updated_at=now() WHERE id=$3', [after,after>0,data.productId]);
      }
      await client.query("INSERT INTO inventory_movements(id,product_id,variant_id,movement_type,quantity,quantity_before,quantity_after,actor_name,reason) VALUES($1,$2,$3,'STOCK_IN',$4,$5,$6,$7,$8)", [randomUUID(),data.productId,data.variantId || null,data.quantity,before,after,auth.adminName,reason]);
      return { productId:data.productId, variantId:data.variantId || null, name:product.name, quantityBefore:before, stockAfter:after };
    });
    await recordCloudAudit(auth,'INVENTORY_STOCK_ADJUSTED','product',data.productId,{ via:'stock-in', name:result.name, variantId:data.variantId || null, quantity:data.quantity, quantityBefore:result.quantityBefore, quantityAfter:result.stockAfter, reason });
    return res.status(201).json(result);
  } catch (error:any) {
    if (error?.statusCode) return res.status(error.statusCode).json({ error:error.message });
    throw error;
  }
}

async function adminAccountsHandler(req: ApiRequest, res: ApiResponse, pathId = ''): Promise<unknown> {
  const auth = await requireCloudAdmin(req,res);
  if (!auth) return;
  const id = pathId || getQuery(req.query,'id');
  const pool = getCloudPool();
  if (req.method === 'GET') {
    if (getQuery(req.query,'self')) {
      const { rows } = await pool.query('SELECT id,admin_name AS "fullName",email,phone,avatar,admin_role AS role FROM admin_sessions WHERE id=$1 LIMIT 1',[auth.sub]);
      if (!rows[0]) return res.status(404).json({ error:'Admin account not found' });
      return res.status(200).json(rows[0]);
    }
    if (auth.adminRole !== 'Super Admin') return res.status(403).json({ error:'Only Super Admins can view team accounts' });
    const { rows } = await pool.query('SELECT id,admin_name AS "fullName",email,phone,avatar,admin_role AS role,is_active AS "isActive",last_login_at AS "lastLoginAt",created_at AS "createdAt" FROM admin_sessions ORDER BY created_at');
    return res.status(200).json(rows);
  }
  if (req.method === 'POST') {
    if (auth.adminRole !== 'Super Admin') return res.status(403).json({ error:'Only Super Admins can create team accounts' });
    const parsed = z.object({ fullName:z.string().trim().min(2).max(100), email:z.string().trim().email().max(255), phone:z.string().max(30).optional(), role:z.string(), pin:z.string().min(4).max(100) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error:'Name, email, and a PIN of at least 4 characters are required' });
    try {
      const hash = await bcrypt.hash(parsed.data.pin,12);
      const { rows } = await pool.query('INSERT INTO admin_sessions(id,admin_name,admin_role,email,phone,pin_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,admin_name AS "fullName",email,phone,avatar,admin_role AS role,is_active AS "isActive",last_login_at AS "lastLoginAt",created_at AS "createdAt"', [randomUUID(),parsed.data.fullName,roleFromRequest(parsed.data.role),parsed.data.email.toLowerCase(),parsed.data.phone || '',hash]);
      await recordCloudAudit(auth,'STAFF_ACCOUNT_CHANGED','admin_session',rows[0].id,{ event:'created',email:rows[0].email,role:rows[0].role });
      return res.status(201).json(rows[0]);
    } catch (error:any) {
      if (error?.code === '23505') return res.status(409).json({ error:'An admin account with this email already exists' });
      throw error;
    }
  }
  if (!id) return res.status(400).json({ error:'Account id is required' });
  const { rows: targetRows } = await pool.query('SELECT * FROM admin_sessions WHERE id=$1 LIMIT 1', [id]);
  const target = targetRows[0];
  if (!target) return res.status(404).json({ error:'Admin account not found' });
  if (req.method === 'PATCH') {
    if (auth.adminRole !== 'Super Admin' && target.id !== auth.sub) return res.status(403).json({ error:'Only Super Admins can manage other team accounts' });
    const { fullName,email,phone,role,isActive,pin,currentPin,avatar } = req.body || {};
    if (target.id === auth.sub && (role !== undefined || isActive === false)) return res.status(400).json({ error:'You cannot change your own role or deactivate your own account' });
    if (pin && (!currentPin || !(await bcrypt.compare(String(currentPin),target.pin_hash)))) return res.status(401).json({ error:'Current PIN is incorrect' });
    const sets:string[]=[]; const values:unknown[]=[];
    const add=(column:string,value:unknown)=>{values.push(value);sets.push(`${column}=$${values.length}`);};
    if(fullName!==undefined)add('admin_name',String(fullName).trim());
    if(email!==undefined)add('email',String(email).trim().toLowerCase());
    if(phone!==undefined)add('phone',String(phone).trim());
    if(role!==undefined)add('admin_role',roleFromRequest(role));
    if(isActive!==undefined)add('is_active',Boolean(isActive));
    if(pin)add('pin_hash',await bcrypt.hash(String(pin),12));
    if (avatar !== undefined) {
      const validAvatar = typeof avatar === 'string'
        && avatar.length <= 200_000
        && (!avatar || /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(avatar) || /^https:\/\/\S+$/i.test(avatar));
      if (!validAvatar) return res.status(400).json({ error:'Profile photo must be a small image or HTTPS URL.' });
      add('avatar', avatar || null);
    }
    if(!sets.length)return res.status(400).json({error:'No account fields to update.'});
    values.push(id);
    const {rows}=await pool.query(`UPDATE admin_sessions SET ${sets.join(', ')} WHERE id=$${values.length} RETURNING id,admin_name AS "fullName",email,phone,avatar,admin_role AS role,is_active AS "isActive",last_login_at AS "lastLoginAt",created_at AS "createdAt"`,values);
    await recordCloudAudit(auth,'STAFF_ACCOUNT_CHANGED','admin_session',id,{event:'updated',email:rows[0].email,pinChanged:Boolean(pin)});
    return res.status(200).json(rows[0]);
  }
  if(req.method==='DELETE'){
    if(auth.adminRole!=='Super Admin')return res.status(403).json({error:'Only Super Admins can delete team accounts'});
    if(target.id===auth.sub)return res.status(400).json({error:'You cannot delete your own account'});
    await pool.query('DELETE FROM admin_sessions WHERE id=$1',[id]);
    await recordCloudAudit(auth,'STAFF_ACCOUNT_CHANGED','admin_session',id,{event:'deleted',email:target.email});
    return res.status(200).json({success:true,id});
  }
  return res.status(405).json({error:'Method not allowed'});
}

async function promoHandler(req: ApiRequest, res: ApiResponse): Promise<unknown> {
  const auth = await requireCloudAdmin(req,res,req.method==='GET'?['Super Admin','Store Manager','Cashier']:['Super Admin','Store Manager']);
  if(!auth)return;
  const pool=getCloudPool();
  const id=getQuery(req.query,'id');
  if(req.method==='GET'){const {rows}=await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');return res.status(200).json(rows.map(fromDbRow));}
  if(req.method==='POST'){
    const parsed=z.object({id:z.string().optional(),code:z.string().min(1).max(50),discountType:z.enum(['percentage','fixed']),discountValue:z.number().positive(),minSpend:z.number().min(0).optional(),isActive:z.boolean().default(true),maxUsage:z.number().int().positive().optional(),description:z.string().optional(),expiryDate:z.string().datetime().optional().nullable()}).safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:'Invalid promo code data'});
    const p=parsed.data;
    const {rows}=await pool.query('INSERT INTO promo_codes(id,code,discount_type,discount_value,discount_value_pesewas,min_spend,min_spend_pesewas,is_active,max_usage,description,expiry_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[p.id||`promo-${randomUUID()}`,p.code.toUpperCase(),p.discountType,p.discountValue,p.discountType==='fixed'?requireMinor(p.discountValue,'discount'):null,p.minSpend??null,p.minSpend==null?null:requireMinor(p.minSpend,'minimum spend'),p.isActive,p.maxUsage??null,p.description||null,p.expiryDate||null]);
    await recordCloudAudit(auth,'DISCOUNT_CHANGED','promo_code',rows[0].id,{event:'created',code:rows[0].code});
    return res.status(201).json(fromDbRow(rows[0]));
  }
  if(!id)return res.status(400).json({error:'Promo code ID is required'});
  if(req.method==='PATCH'){
    const allowed:Record<string,string>={isActive:'is_active',discountType:'discount_type',discountValue:'discount_value',minSpend:'min_spend',expiryDate:'expiry_date',code:'code'};
    const sets:string[]=[];const values:unknown[]=[];
    for(const [key,column]of Object.entries(allowed)){if(req.body?.[key]===undefined)continue;let value=req.body[key];if(key==='code')value=String(value).toUpperCase();values.push(value);sets.push(`${column}=$${values.length}`);}
    if(!sets.length)return res.status(400).json({error:'No promo fields to update.'});
    sets.push('updated_at=now()');values.push(id);
    const {rows}=await pool.query(`UPDATE promo_codes SET ${sets.join(', ')} WHERE id=$${values.length} RETURNING *`,values);
    if(!rows[0])return res.status(404).json({error:'Promo code not found'});
    await recordCloudAudit(auth,'DISCOUNT_CHANGED','promo_code',id,{event:'updated',code:rows[0].code});
    return res.status(200).json(fromDbRow(rows[0]));
  }
  if(req.method==='DELETE'){
    const {rows}=await pool.query('DELETE FROM promo_codes WHERE id=$1 RETURNING id,code',[id]);
    if(!rows[0])return res.status(404).json({error:'Promo code not found'});
    await recordCloudAudit(auth,'DISCOUNT_CHANGED','promo_code',id,{event:'deleted',code:rows[0].code});
    return res.status(200).json({success:true,id});
  }
  return res.status(405).json({error:'Method not allowed'});
}

function resolveCloudRoute(req: ApiRequest): { resource: string; id?: string } {
  const rawRoute = req.query.route;
  const fromQuery = Array.isArray(rawRoute) ? rawRoute.join('/') : rawRoute || '';
  const urlRoute = typeof req.url === 'string' ? req.url.split('?')[0] : '';
  const fallbackRoute = urlRoute.replace(/^\/+|\/+$/g, '').replace(/^api\//, '');
  const route = fromQuery || fallbackRoute || '';
  const [resource, id] = route.split('/');
  return { resource: resource || '', id: id || undefined };
}

export default async function cloudApi(req: ApiRequest, res: ApiResponse): Promise<unknown> {
  try {
    const { resource, id } = resolveCloudRoute(req);
    if (!process.env.DATABASE_URL && !process.env.DATABASE_POSTGRES_URL_NO_SSL && !process.env.DATABASE_URL_UNPOOLED && !process.env.DATABASE_POSTGRES_HOST) return res.status(503).json({ error: 'Cloud database is not configured.' });
    if (resource === 'health') return healthHandler(req, res);
    await ensureCloudSchema();
    if (resource === 'auth') return await authHandler(req, res);
    if (resource === 'products') return await productsHandler(req, res, id || '');
    if (resource === 'admin-accounts') return await adminAccountsHandler(req, res, id || '');
    if (resource === 'catalog' || resource === 'brands' || resource === 'categories') {
      if (resource !== 'catalog') req.query.resource = resource;
      return await catalogHandler(req, res);
    }
    if (resource === 'admin-accounts') return await adminAccountsHandler(req, res, id || '');
    if (resource === 'settings') return await settingsHandler(req, res);
    if (resource === 'orders') return await ordersHandler(req, res);
    if (resource === 'reports') return await reportsHandler(req, res);
    if (resource === 'held-sales') return await heldSalesHandler(req, res);
    if (resource === 'stock-in') return await stockInHandler(req, res);
    if (resource === 'promo-codes') return await promoHandler(req, res);
    if (resource === 'backups') return await backupsHandler(req, res);
    if (resource === 'held-sales') return await heldSalesHandler(req, res);
    if (resource === 'stock-in') return await stockInHandler(req, res);
    if (resource === 'promo-codes') return await promoHandler(req, res);
    if (resource === 'backups') return await backupsHandler(req, res);
    return res.status(404).json({ error: 'API route not found' });
  } catch (error: any) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error('Cloud POS API error:', error);
    return res.status(status).json({ error: status === 500 ? 'The cloud POS service is unavailable.' : error?.message || 'Request failed.' });
  }
}
