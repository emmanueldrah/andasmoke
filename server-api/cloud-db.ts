import { Pool, type PoolClient } from '@neondatabase/serverless';

const globalState = globalThis as typeof globalThis & {
  __andaCloudPool?: Pool;
  __andaCloudSchema?: Promise<void>;
};

function resolveDatabaseUrl(): string {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.DATABASE_URL_UNPOOLED,
    process.env.DATABASE_POSTGRES_URL,
    process.env.DATABASE_POSTGRES_URL_NO_SSL,
    process.env.DATABASE_POSTGRES_PRISMA_URL,
  ].filter((value): value is string => Boolean(value && value.trim()));

  if (candidates.length > 0) return candidates[0].trim();

  const host = process.env.DATABASE_POSTGRES_HOST || process.env.DATABASE_PGHOST;
  const user = process.env.DATABASE_POSTGRES_USER || process.env.DATABASE_PGUSER;
  const password = process.env.DATABASE_POSTGRES_PASSWORD || process.env.DATABASE_PGPASSWORD;
  const database = process.env.DATABASE_POSTGRES_DATABASE || process.env.DATABASE_PGDATABASE;

  if (host && user && password && database) {
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/${database}?sslmode=require`;
  }

  throw new Error('No Neon/Postgres database URL is configured for the Vercel POS API.');
}

export function getCloudPool(): Pool {
  const connectionString = resolveDatabaseUrl();
  if (!globalState.__andaCloudPool) {
    globalState.__andaCloudPool = new Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalState.__andaCloudPool;
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS products (
    id text PRIMARY KEY, name text NOT NULL, brand text NOT NULL, department text NOT NULL,
    category text NOT NULL, category_label text NOT NULL, price double precision NOT NULL,
    price_pesewas integer, cost_price_pesewas integer, reorder_level integer NOT NULL DEFAULT 0,
    wholesale_price double precision, delivery_price double precision, original_price double precision,
    discount_badge text, unit text NOT NULL, barcode text UNIQUE, serial_number text UNIQUE,
    image text NOT NULL DEFAULT '', images jsonb NOT NULL DEFAULT '[]'::jsonb,
    description text NOT NULL DEFAULT '', highlights jsonb NOT NULL DEFAULT '[]'::jsonb,
    badge text, in_stock boolean NOT NULL DEFAULT true, is_published boolean NOT NULL DEFAULT true,
    stock_count integer NOT NULL DEFAULT 0, options jsonb NOT NULL DEFAULT '[]'::jsonb,
    rating double precision NOT NULL DEFAULT 5, review_count integer NOT NULL DEFAULT 0,
    origin text, routine_step text, skin_type jsonb, skin_concern jsonb, pack_size text,
    storage_info text, shelf_life text, variants jsonb NOT NULL DEFAULT '[]'::jsonb,
    details jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS categories (
    id text PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL, department text NOT NULL,
    image text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', is_active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS brands (
    id text PRIMARY KEY, name text NOT NULL UNIQUE, is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    id text PRIMARY KEY, admin_name text NOT NULL, admin_role text NOT NULL, email text NOT NULL UNIQUE,
    phone text NOT NULL DEFAULT '', avatar text, pin_hash text NOT NULL, is_active boolean NOT NULL DEFAULT true,
    last_login_at timestamptz, failed_pin_attempts integer NOT NULL DEFAULT 0,
    locked_until timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  'ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS avatar text',
  `CREATE TABLE IF NOT EXISTS store_settings (
    id text PRIMARY KEY, key text NOT NULL UNIQUE, value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS promo_codes (
    id text PRIMARY KEY, code text NOT NULL UNIQUE, discount_type text NOT NULL,
    discount_value double precision NOT NULL, discount_value_pesewas integer, min_spend double precision,
    min_spend_pesewas integer, free_shipping boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT true, usage_count integer NOT NULL DEFAULT 0,
    max_usage integer, description text, expiry_date timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id text PRIMARY KEY, order_number text NOT NULL UNIQUE, user_id text, items jsonb NOT NULL,
    subtotal double precision NOT NULL, subtotal_pesewas integer NOT NULL DEFAULT 0,
    shipping_fee double precision NOT NULL DEFAULT 0, discount double precision NOT NULL DEFAULT 0,
    discount_pesewas integer NOT NULL DEFAULT 0, total double precision NOT NULL,
    total_pesewas integer NOT NULL DEFAULT 0, payment_method text NOT NULL,
    payment_status text NOT NULL DEFAULT 'pending', order_source text NOT NULL DEFAULT 'pos',
    delivery_method text NOT NULL DEFAULT 'store-pickup', shipping_address jsonb NOT NULL,
    status text NOT NULL DEFAULT 'Delivered', estimated_delivery_time text, applied_promo_code text,
    payment_reference text UNIQUE, payment_sender_phone text, idempotency_key text UNIQUE,
    cashier_name text, rider_info jsonb, admin_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
    voided_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS pos_payments (
    id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    method text NOT NULL, status text NOT NULL, amount double precision NOT NULL,
    amount_pesewas integer NOT NULL DEFAULT 0, tendered_pesewas integer, change_pesewas integer,
    reference text, cash_received double precision, change_given double precision,
    cashier_name text, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS inventory_movements (
    id text PRIMARY KEY, product_id text NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    variant_id text, order_id text REFERENCES orders(id) ON DELETE RESTRICT, movement_type text NOT NULL,
    quantity integer NOT NULL, quantity_before integer NOT NULL, quantity_after integer NOT NULL,
    actor_name text, reason text, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id text PRIMARY KEY, action text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
    actor_name text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS held_sales (
    id text PRIMARY KEY, ticket_label text NOT NULL, device_id text, items jsonb NOT NULL DEFAULT '[]'::jsonb,
    subtotal double precision NOT NULL DEFAULT 0, discount double precision NOT NULL DEFAULT 0,
    total double precision NOT NULL DEFAULT 0, promo_code text, payment_method text,
    cash_received double precision, held_by text, created_at timestamptz NOT NULL DEFAULT now(), recalled_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS pos_shifts (
    id text PRIMARY KEY, device_id text NOT NULL, cashier_name text NOT NULL,
    status text NOT NULL DEFAULT 'OPEN', opening_cash double precision NOT NULL DEFAULT 0,
    expected_cash double precision, actual_cash double precision, difference double precision,
    opening_cash_pesewas integer NOT NULL DEFAULT 0, expected_cash_pesewas integer,
    actual_cash_pesewas integer, difference_pesewas integer,
    opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz, notes text
  )`,
  `CREATE TABLE IF NOT EXISTS shift_cash_movements (
    id text PRIMARY KEY, shift_id text NOT NULL REFERENCES pos_shifts(id) ON DELETE CASCADE,
    amount_pesewas integer NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  'CREATE INDEX IF NOT EXISTS cloud_products_published_idx ON products (is_published)',
  'CREATE INDEX IF NOT EXISTS cloud_products_category_idx ON products (category)',
  'CREATE INDEX IF NOT EXISTS cloud_orders_created_idx ON orders (created_at)',
  'CREATE INDEX IF NOT EXISTS cloud_orders_source_idx ON orders (order_source)',
  'CREATE INDEX IF NOT EXISTS cloud_payments_order_idx ON pos_payments (order_id)',
  'CREATE INDEX IF NOT EXISTS cloud_movements_product_idx ON inventory_movements (product_id)',
  'CREATE INDEX IF NOT EXISTS cloud_audit_created_idx ON audit_logs (created_at)',
  'CREATE INDEX IF NOT EXISTS cloud_held_created_idx ON held_sales (created_at)',
  'CREATE INDEX IF NOT EXISTS cloud_shifts_device_idx ON pos_shifts (device_id, status)',
];

export async function ensureCloudSchema(client?: PoolClient): Promise<void> {
  if (!globalState.__andaCloudSchema) {
    globalState.__andaCloudSchema = (async () => {
      const connection = client ?? await getCloudPool().connect();
      const shouldRelease = !client;
      try {
        await connection.query('BEGIN');
        for (const statement of schemaStatements) await connection.query(statement);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined);
        globalState.__andaCloudSchema = undefined;
        throw error;
      } finally {
        if (shouldRelease) connection.release();
      }
    })();
  }
  await globalState.__andaCloudSchema;
}

export async function withCloudTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getCloudPool().connect();
  try {
    await ensureCloudSchema(client);
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function fromDbRow<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

export function parseJsonSetting(value: string | null | undefined, fallback: unknown = null): unknown {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
