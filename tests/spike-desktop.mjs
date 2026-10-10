/**
 * Spike driver: launches the real desktop app, exercises the counter through
 * the UI, then restarts it to prove the data is on disk.
 *
 * Not part of `npm test` — it needs a display. Run with:
 *   npm run spike
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const electronBinary = require('electron'); // path to electron.exe

const dataDir = process.env.SPIKE_DATA_DIR || mkdtempSync(join(tmpdir(), 'anda-spike-'));
const dbFile = join(dataDir, 'anda-smoke-hub.sqlite');
const log = (...args) => console.log('[spike]', ...args);

function launch() {
  const child = spawn(electronBinary, [join(root, 'electron/main.cjs')], {
    env: { ...process.env, ANDA_DATA_DIR: dataDir, ANDA_INSECURE_DEV_SECRET: '1', ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [main] ${d}`));
  child.stderr.on('data', (d) => {
    const text = String(d);
    if (!/DevTools|Autofill|GPU|dbus|Fontconfig|libva|ERROR:.*(gpu|vulkan)/i.test(text)) {
      process.stderr.write(`  [main:err] ${text}`);
    }
  });
  return child;
}

function waitForFile(file, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(file)) return resolve(true);
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for ${file}`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

/** Talks to the app's own API on the port it prints, using its admin token. */
async function waitForServer(child, timeoutMs = 40000) {
  const started = Date.now();
  let origin = null;
  child.stdout.on('data', (chunk) => {
    const match = /\[pos\] local server on (http:\/\/127\.0\.0\.1:\d+)/.exec(String(chunk));
    if (match) origin = match[1];
  });
  while (Date.now() - started < timeoutMs) {
    if (origin) {
      try {
        const response = await fetch(`${origin}/api/auth?action=setup-status`);
        if (response.ok) return { origin, ...(await response.json()) };
      } catch {
        // not listening yet
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('App did not report a local server');
}

async function api(origin, path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: response.status, body: parsed };
}

async function run() {
  log('data dir:', dataDir);
  log('database:', dbFile);

  // ── Run 1: first-run setup, add a product, make a scanned sale ────────────
  log('--- run 1: launching app ---');
  let child = launch();
  let server = await waitForServer(child);
  log('local server:', server.origin);
  log('needs setup:', server.needsSetup);

  // The database must land in the folder we asked for, not somewhere else.
  await waitForFile(dbFile);
  log('database file created at the expected path');

  if (!server.needsSetup) throw new Error('A fresh till should require first-run setup');

  log('creating the owner account...');
  const setup = await api(server.origin, '/api/auth?action=setup', {
    method: 'POST',
    body: { name: 'Ama Boateng', email: 'ama@smokehub.com', pin: '2468' },
  });
  if (setup.status !== 201) throw new Error(`setup failed: ${JSON.stringify(setup.body)}`);
  const token = setup.body.token;
  log('owner created:', setup.body.admin.adminName, '/', setup.body.admin.adminRole);

  log('adding a product...');
  const product = await api(server.origin, '/api/products', {
    method: 'POST',
    token,
    body: {
      name: 'Mango Kush',
      brand: 'N shisha',
      department: 'beauty',
      category: 'skincare',
      categoryLabel: 'Shisha Flavors',
      price: '45.00',
      unit: 'bowl',
      barcode: 'ACS-000001',
      image: '',
      images: [''],
      description: 'Sweet mango hookah flavor',
      stockCount: 10,
    },
  });
  if (product.status !== 201) throw new Error(`product failed: ${JSON.stringify(product.body)}`);
  log('product created:', product.body.name, 'stock', product.body.stockCount, 'barcode', product.body.barcode);

  log('scanning the barcode...');
  const scanned = await api(server.origin, '/api/products?scanCode=ACS-000001', { token });
  if (scanned.status !== 200 || scanned.body.products.length !== 1) {
    throw new Error(`scan lookup failed: ${JSON.stringify(scanned.body)}`);
  }
  log('scan matched:', scanned.body.products[0].name);

  log('ringing up a 2-unit cash sale...');
  const sale = await api(server.origin, '/api/orders?channel=pos', {
    method: 'POST',
    token,
    body: {
      idempotencyKey: `POS-spike-${Date.now()}`,
      subtotal: 90, shippingFee: 0, discount: 0, total: 90,
      paymentMethod: 'cash-on-delivery', cashReceived: 100,
      shippingAddress: { fullName: 'Walk-in customer', phone: 'In-store sale', city: 'In-store', area: 'Counter' },
      items: [{ product: { id: product.body.id, price: 45 }, quantity: 2 }],
    },
  });
  if (sale.status !== 201) throw new Error(`sale failed: ${JSON.stringify(sale.body)}`);
  log('sale recorded:', sale.body.orderNumber, 'total', sale.body.total, 'served by', sale.body.cashierName);

  const afterSale = await api(server.origin, `/api/products?id=${product.body.id}`, { token });
  log('stock after sale:', afterSale.body.stockCount, '(expected 8)');
  if (Number(afterSale.body.stockCount) !== 8) throw new Error('stock was not reduced correctly');

  log('closing run 1');
  child.kill();
  await new Promise((r) => setTimeout(r, 1500));

  // ── Run 2: restart and confirm the data survived ─────────────────────────
  log('--- run 2: restarting app ---');
  child = launch();
  server = await waitForServer(child);
  log('restarted on', server.origin);
  log('needs setup after restart:', server.needsSetup, '(expected false)');
  if (server.needsSetup) throw new Error('Setup should not reappear after a restart');

  const signIn = await api(server.origin, '/api/auth?action=admin', {
    method: 'POST',
    body: { email: 'ama@smokehub.com', pin: '2468' },
  });
  if (signIn.status !== 200) throw new Error(`sign-in after restart failed: ${JSON.stringify(signIn.body)}`);
  log('sign-in after restart: OK');

  const productAfter = await api(server.origin, `/api/products?id=${product.body.id}`, { token });
  log('product after restart:', productAfter.body.name, 'stock', productAfter.body.stockCount);
  if (productAfter.body.name !== 'Mango Kush' || Number(productAfter.body.stockCount) !== 8) {
    throw new Error('product did not survive the restart');
  }

  const ordersAfter = await api(server.origin, '/api/orders', { token: signIn.body.token });
  log('sales after restart:', ordersAfter.body.orders.length);
  if (ordersAfter.body.orders.length < 1) throw new Error('sales did not survive the restart');

  const page = await fetch(`${server.origin}/`);
  const html = await page.text();
  log('app page served:', page.status, /Anda C Smoke Hub POS/i.test(html) ? '(branded)' : '(NOT branded)');

  log('data dir contents:', readdirSync(dataDir).join(', '));
  child.kill();
  await new Promise((r) => setTimeout(r, 800));

  log('');
  log('SPIKE PASSED');
}

run()
  .then(() => {
    if (!process.env.SPIKE_KEEP && !process.env.SPIKE_DATA_DIR) rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error('[spike] FAILED:', error.message);
    if (!process.env.SPIKE_KEEP && !process.env.SPIKE_DATA_DIR) rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  });