/**
 * Anda C Smoke Hub — data layer.
 *
 * Every read and write in the app goes through this module. Today the only
 * implementation is `local` (a SQLite file owned by this machine). A hosted
 * implementation can be added later by implementing the same surface and
 * selecting it here, without touching any call site.
 *
 * The database lives beside the app's user data so it survives restarts and
 * can be copied to USB. WAL is enabled so a power cut during a sale cannot
 * corrupt committed transactions.
 */
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from '../db/schema.js';
import { DB_FILE_NAME, resolveDatabasePath } from '../lib/paths.js';

export type DataLayer = BetterSQLite3Database<typeof schema>;

/** Connection settings for the active implementation. */
export type DataLayerConfig = {
  implementation: 'local';
  /** Absolute path to the SQLite file. */
  file: string;
};

export const DATA_LAYER_IMPLEMENTATION = 'local' as const;

let connection: { sqlite: Database.Database; db: DataLayer } | null = null;

/**
 * Where the database file lives.
 *
 * Electron passes `app.getPath('userData')`. Standalone runs (tests, tooling)
 * fall back to `./.data` beside the project so nothing is written into the
 * source tree during development.
 */
export { resolveDatabasePath };

function createTables(sqlite: Database.Database): void {
  // Hand-written DDL mirrors schema.ts. Kept explicit so the SQLite file can be
  // opened by any tool, and so a later hosted migration has one source to diff.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL,
      department TEXT NOT NULL, category TEXT NOT NULL, category_label TEXT NOT NULL,
      price REAL NOT NULL, wholesale_price REAL, delivery_price REAL, original_price REAL,
      discount_badge TEXT, unit TEXT NOT NULL, barcode TEXT, serial_number TEXT,
      image TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL,
      highlights TEXT NOT NULL DEFAULT '[]', badge TEXT,
      in_stock INTEGER NOT NULL DEFAULT 1, is_published INTEGER NOT NULL DEFAULT 1,
      stock_count INTEGER NOT NULL DEFAULT 2,
      options TEXT DEFAULT '[]', rating REAL NOT NULL DEFAULT 5, review_count INTEGER NOT NULL DEFAULT 0,
      origin TEXT, routine_step TEXT, skin_type TEXT DEFAULT '[]', skin_concern TEXT DEFAULT '[]',
      pack_size TEXT, storage_info TEXT, shelf_life TEXT, variants TEXT DEFAULT '[]', details TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_idx ON products (barcode);
    CREATE UNIQUE INDEX IF NOT EXISTS products_serial_number_idx ON products (serial_number);
    CREATE INDEX IF NOT EXISTS products_category_idx ON products (category);
    CREATE INDEX IF NOT EXISTS products_department_idx ON products (department);
    CREATE INDEX IF NOT EXISTS products_published_idx ON products (is_published);
    CREATE INDEX IF NOT EXISTS products_brand_idx ON products (brand);

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      department TEXT NOT NULL, image TEXT NOT NULL, description TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL, phone TEXT NOT NULL,
      profile_image TEXT, password_hash TEXT, saved_addresses TEXT DEFAULT '[]',
      saved_item_ids TEXT DEFAULT '[]', loyalty_points INTEGER NOT NULL DEFAULT 0,
      is_wholesale INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
      admin_notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, order_number TEXT NOT NULL UNIQUE, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      items TEXT NOT NULL,
      subtotal REAL NOT NULL, shipping_fee REAL NOT NULL, discount REAL NOT NULL DEFAULT 0, total REAL NOT NULL,
      payment_method TEXT NOT NULL, payment_status TEXT NOT NULL DEFAULT 'pending',
      order_source TEXT NOT NULL DEFAULT 'website', delivery_method TEXT NOT NULL,
      shipping_address TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Confirmed',
      estimated_delivery_time TEXT, applied_promo_code TEXT, payment_reference TEXT,
      payment_sender_phone TEXT, idempotency_key TEXT, cashier_name TEXT,
      rider_info TEXT, admin_notes TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS orders_order_number_idx ON orders (order_number);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_reference_idx ON orders (payment_reference);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_idx ON orders (idempotency_key);
    CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders (user_id);
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
    CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at);

    CREATE TABLE IF NOT EXISTS pos_payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      method TEXT NOT NULL, status TEXT NOT NULL, amount REAL NOT NULL, reference TEXT,
      cash_received REAL, change_given REAL, cashier_name TEXT, created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      variant_id TEXT, order_id TEXT REFERENCES orders(id) ON DELETE RESTRICT,
      movement_type TEXT NOT NULL, quantity INTEGER NOT NULL,
      quantity_before INTEGER NOT NULL, quantity_after INTEGER NOT NULL,
      actor_name TEXT, reason TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inventory_movements_product_idx ON inventory_movements (product_id);
    CREATE INDEX IF NOT EXISTS inventory_movements_order_idx ON inventory_movements (order_id);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      actor_name TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at);
    CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action);
    CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

    CREATE TABLE IF NOT EXISTS held_sales (
      id TEXT PRIMARY KEY, ticket_label TEXT NOT NULL, device_id TEXT,
      items TEXT NOT NULL DEFAULT '[]',
      subtotal REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
      promo_code TEXT, payment_method TEXT, cash_received REAL,
      held_by TEXT, created_at INTEGER NOT NULL, recalled_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS held_sales_created_at_idx ON held_sales (created_at);

    CREATE TABLE IF NOT EXISTS pos_shifts (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, cashier_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN', opening_cash REAL NOT NULL,
      expected_cash REAL, actual_cash REAL, difference REAL,
      opened_at INTEGER NOT NULL, closed_at INTEGER, notes TEXT
    );
    CREATE INDEX IF NOT EXISTS pos_shifts_device_idx ON pos_shifts (device_id);
    CREATE INDEX IF NOT EXISTS pos_shifts_status_idx ON pos_shifts (status);

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      author_name TEXT NOT NULL, rating INTEGER NOT NULL, title TEXT, comment TEXT NOT NULL,
      verified_purchase INTEGER NOT NULL DEFAULT 0, skin_type TEXT, images TEXT DEFAULT '[]',
      helpful_count INTEGER NOT NULL DEFAULT 0, admin_reply TEXT,
      is_approved INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reviews_product_id_idx ON reviews (product_id);
    CREATE INDEX IF NOT EXISTS reviews_user_id_idx ON reviews (user_id);
    CREATE INDEX IF NOT EXISTS reviews_approved_idx ON reviews (is_approved);

    CREATE TABLE IF NOT EXISTS promo_codes (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, discount_type TEXT NOT NULL,
      discount_value REAL NOT NULL, min_spend REAL, free_shipping INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1, usage_count INTEGER NOT NULL DEFAULT 0,
      max_usage INTEGER, description TEXT, expiry_date INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_code_idx ON promo_codes (code);
    CREATE INDEX IF NOT EXISTS promo_codes_active_idx ON promo_codes (is_active);

    CREATE TABLE IF NOT EXISTS flash_deals (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT, description TEXT, badge_text TEXT,
      discount_percentage INTEGER NOT NULL, hours_remaining INTEGER NOT NULL DEFAULT 0,
      minutes_remaining INTEGER NOT NULL DEFAULT 0, seconds_remaining INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1, expires_at INTEGER NOT NULL, background_gradient TEXT,
      product_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS flash_deals_active_idx ON flash_deals (is_active);
    CREATE INDEX IF NOT EXISTS flash_deals_expires_at_idx ON flash_deals (expires_at);

    CREATE TABLE IF NOT EXISTS store_settings (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL, updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY, admin_name TEXT NOT NULL, admin_role TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE, phone TEXT NOT NULL DEFAULT '',
      pin_hash TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
      last_login_at INTEGER,
      failed_pin_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
      action_url TEXT, is_read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications (user_id);
    CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications (created_at);
    CREATE INDEX IF NOT EXISTS notifications_read_idx ON notifications (is_read);

    CREATE TABLE IF NOT EXISTS carts (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT, items TEXT NOT NULL DEFAULT '[]', promo_code TEXT,
      discount_amount REAL DEFAULT 0, has_free_shipping_coupon INTEGER DEFAULT 0,
      selected_samples TEXT DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS carts_user_id_idx ON carts (user_id);
    CREATE INDEX IF NOT EXISTS carts_session_id_idx ON carts (session_id);

    CREATE TABLE IF NOT EXISTS wishlists (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wishlists_user_id_idx ON wishlists (user_id);
    CREATE INDEX IF NOT EXISTS wishlists_session_id_idx ON wishlists (session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS wishlists_unique_user_product ON wishlists (user_id, product_id);
    CREATE UNIQUE INDEX IF NOT EXISTS wishlists_unique_session_product ON wishlists (session_id, product_id);
  `);

  addMissingColumns(sqlite);
  removeLegacyPaymentUniqueness(sqlite);
  backfillPesewas(sqlite);
}

/** Rebuilds early payment tables whose inline UNIQUE blocked split tenders. */
function removeLegacyPaymentUniqueness(sqlite: Database.Database): void {
  const indexes = sqlite.prepare('PRAGMA index_list("pos_payments")').all() as Array<{
    name: string;
    unique: number;
  }>;
  const hasUniqueOrderId = indexes.some(index => {
    if (!index.unique) return false;
    const columns = sqlite.prepare(`PRAGMA index_info("${index.name.replace(/"/g, '""')}")`).all() as Array<{ name: string | null }>;
    return columns.map(column => column.name).join(',') === 'order_id';
  });
  if (!hasUniqueOrderId) return;

  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE pos_payments_migrating (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
        method TEXT NOT NULL, status TEXT NOT NULL, amount REAL NOT NULL,
        amount_pesewas INTEGER NOT NULL DEFAULT 0, tendered_pesewas INTEGER,
        change_pesewas INTEGER, reference TEXT, cash_received REAL,
        change_given REAL, cashier_name TEXT, created_at INTEGER NOT NULL
      );
      INSERT INTO pos_payments_migrating (
        id, order_id, method, status, amount, amount_pesewas, tendered_pesewas,
        change_pesewas, reference, cash_received, change_given, cashier_name, created_at
      ) SELECT
        id, order_id, method, status, amount, amount_pesewas, tendered_pesewas,
        change_pesewas, reference, cash_received, change_given, cashier_name, created_at
      FROM pos_payments;
      DROP TABLE pos_payments;
      ALTER TABLE pos_payments_migrating RENAME TO pos_payments;
    `);
  })();
}

/**
 * Adds columns introduced after a till was first installed.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so an upgrade
 * would otherwise leave the new column missing and every write naming it would
 * fail. SQLite has no `ADD COLUMN IF NOT EXISTS`, so check first.
 */
function addMissingColumns(sqlite: Database.Database): void {
  const ensure = (table: string, column: string, definition: string) => {
    const existing = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    if (existing.some(info => info.name === column)) return;
    sqlite.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  };

  // Login lockout counters.
  ensure('admin_sessions', 'failed_pin_attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensure('admin_sessions', 'locked_until', 'INTEGER');

  // ── Money in integer minor units (pesewas) ──────────────────────────────
  // The REAL columns above stay as display mirrors for older screens and
  // reports; these are the authoritative figures every calculation uses. Adding
  // rather than converting keeps an existing till readable while it migrates.
  ensure('products', 'price_pesewas', 'INTEGER');
  ensure('products', 'cost_price_pesewas', 'INTEGER');
  ensure('products', 'reorder_level', 'INTEGER NOT NULL DEFAULT 0');

  ensure('orders', 'subtotal_pesewas', 'INTEGER NOT NULL DEFAULT 0');
  ensure('orders', 'discount_pesewas', 'INTEGER NOT NULL DEFAULT 0');
  ensure('orders', 'total_pesewas', 'INTEGER NOT NULL DEFAULT 0');

  ensure('pos_payments', 'amount_pesewas', 'INTEGER NOT NULL DEFAULT 0');
  ensure('pos_payments', 'tendered_pesewas', 'INTEGER');
  ensure('pos_payments', 'change_pesewas', 'INTEGER');

  ensure('pos_shifts', 'opening_cash_pesewas', 'INTEGER NOT NULL DEFAULT 0');
  ensure('pos_shifts', 'expected_cash_pesewas', 'INTEGER');
  ensure('pos_shifts', 'actual_cash_pesewas', 'INTEGER');
  ensure('pos_shifts', 'difference_pesewas', 'INTEGER');

  ensure('promo_codes', 'discount_value_pesewas', 'INTEGER');
  ensure('promo_codes', 'min_spend_pesewas', 'INTEGER');

  // Lines voided from a completed sale, kept off the cash figures but shown
  // separately in reports.
  ensure('orders', 'voided_lines', "TEXT NOT NULL DEFAULT '[]'");

  // Cash the cashier moved by hand during a shift: a float top-up, a payout.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS shift_cash_movements (
      id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES pos_shifts(id) ON DELETE CASCADE,
      amount_pesewas INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shift_cash_movements_shift_idx ON shift_cash_movements (shift_id);
  `);
}

/**
 * Copies the legacy REAL money columns into their pesewa counterparts.
 *
 * Runs once, on first use after an upgrade. Conversion goes through a string so
 * the value is rounded once at the decimal point rather than being multiplied by
 * 100 in floating point, which is what loses the odd pesewa.
 */
export function backfillPesewas(sqlite: Database.Database): void {
  const has = (table: string, column: string) =>
    (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
      .some(info => info.name === column);

  const copy = (table: string, from: string, to: string) => {
    if (!has(table, to)) return;
    const rows = sqlite.prepare(`SELECT id, ${from} AS value FROM "${table}" WHERE ${to} IS NULL`).all() as
      Array<{ id: string; value: number | null }>;
    if (!rows.length) return;
    const update = sqlite.prepare(`UPDATE "${table}" SET ${to} = ? WHERE id = ?`);
    sqlite.transaction(() => {
      for (const row of rows) {
        if (row.value == null) continue;
        update.run(Math.round(Number(row.value) * 100), row.id);
      }
    })();
  };

  copy('products', 'price', 'price_pesewas');
  copy('products', 'wholesale_price', 'cost_price_pesewas');
  copy('orders', 'subtotal', 'subtotal_pesewas');
  copy('orders', 'discount', 'discount_pesewas');
  copy('orders', 'total', 'total_pesewas');
  copy('pos_payments', 'amount', 'amount_pesewas');
  copy('pos_payments', 'cash_received', 'tendered_pesewas');
  copy('pos_payments', 'change_given', 'change_pesewas');
  copy('pos_shifts', 'opening_cash', 'opening_cash_pesewas');
  copy('promo_codes', 'discount_value', 'discount_value_pesewas');
  copy('promo_codes', 'min_spend', 'min_spend_pesewas');
}

/**
 * Opens (once) the local SQLite database and returns the Drizzle instance.
 * Subsequent calls reuse the same connection.
 */
export function getDataLayer(config?: Partial<DataLayerConfig>): DataLayer {
  if (connection) return connection.db;

  const file = config?.file || resolveDatabasePath();
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sqlite = new Database(file);
  // WAL keeps reads fast and, more importantly, means a power cut can only
  // ever lose the last uncommitted transaction rather than the whole file.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  createTables(sqlite);

  connection = { sqlite, db: drizzle(sqlite, { schema }) };
  return connection.db;
}

/**
 * Lazy handle so call sites can `import { db }` and keep working, while the
 * actual file is opened on first use. Methods are bound to the real instance
 * so Drizzle's builders keep their internal state.
 */
export const db: DataLayer = new Proxy({} as DataLayer, {
  get(_target, property) {
    const real = getDataLayer() as unknown as Record<string | symbol, unknown>;
    const value = real[property];
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

/**
 * Reads a plain-text value stored by {@link setSetting}. These are internal
 * keys (such as the session signing key), not shop settings, so they are kept
 * as raw strings to avoid any JSON round-tripping.
 */
/**
 * Internal-barcode sequence high-water mark.
 *
 * Kept separately from the products, because a wipe empties the catalogue. If
 * the counter were derived only from existing barcodes it would restart at 000001
 * and hand out numbers already printed on shelf labels. This is bumped on every
 * issue and restored along with the database.
 */
export const BARCODE_SEQUENCE_KEY = 'inventory.barcodeSequence';

export function getBarcodeSequence(): number {
  const stored = Number(getSetting(BARCODE_SEQUENCE_KEY));
  return Number.isFinite(stored) && stored > 0 ? Math.floor(stored) : 0;
}

/** Records the highest internal code issued so far. Never moves backwards. */
export function setBarcodeSequence(value: number): number {
  const next = Math.max(getBarcodeSequence(), Math.floor(Number(value) || 0));
  if (next > 0) setSetting(BARCODE_SEQUENCE_KEY, String(next));
  return next;
}

export function getSetting(key: string): string | null {
  const row = getSqliteHandle().prepare('SELECT value FROM store_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getSqliteHandle()
    .prepare(
      `INSERT INTO store_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, Math.floor(Date.now() / 1000));
}

/** Raw handle, for pragmas, backups and integrity checks. */
export function getSqliteHandle(): Database.Database {
  getDataLayer();
  if (!connection) throw new Error('Data layer failed to initialise');
  return connection.sqlite;
}

export function closeDataLayer(): void {
  connection?.sqlite.close();
  connection = null;
}

export { schema };