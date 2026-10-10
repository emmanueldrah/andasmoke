/**
 * Spike verification: the till works end to end on a real SQLite file.
 *
 *   1. a brand new database is created
 *   2. the first super admin is created through the API
 *   3. a product is created and found by its barcode
 *   4. a scanned sale reduces stock and records who served it
 *   5. a replayed sale does not double-charge
 *   6. everything survives a restart (connection closed, file reopened)
 *
 * Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const bundlePath = join(root, 'electron/api-bundle.cjs');

/** Loads a fresh copy of the data layer, bound to ANDA_DATA_DIR. */
function freshBundle() {
  delete require.cache[require.resolve(bundlePath)];
  return require(bundlePath);
}

/** Minimal request/response double, enough for the handlers' `res` usage. */
function fakeResponse() {
  const res = {
    statusCode: 200,
    headersSent: false,
    payload: undefined,
    setHeader() {},
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.statusCode = res.statusCode || 200; res.payload = payload; res.headersSent = true; return res; },
    send(body) { res.payload = body; res.headersSent = true; return res; },
    end() { res.headersSent = true; return res; },
  };
  return res;
}

async function callApi(handler, { method = 'GET', query = {}, body, token } = {}) {
  const req = { method, query, body, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = fakeResponse();
  await handler(req, res);
  return { status: res.statusCode, body: res.payload };
}

const WALLET = { fullName: 'Walk-in customer', phone: 'In-store sale', city: 'In-store', area: 'Counter' };

test('setup, product, scanned sale, and persistence across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-pos-test-'));
  const dbFile = join(dir, 'anda-smoke-hub.sqlite');
  process.env.ANDA_DATA_DIR = dir;

  const api = freshBundle();
  assert.equal(existsSync(dbFile), true, 'SQLite file should be created on first use');

  // ── 1. A brand new till needs setup ──────────────────────────────────────
  const statusBefore = await callApi(api.auth, { query: { action: 'setup-status' } });
  assert.equal(statusBefore.status, 200);
  assert.equal(statusBefore.body.needsSetup, true, 'a new database should need setup');

  // ── 2. Create the first super admin ──────────────────────────────────────
  const setup = await callApi(api.auth, {
    method: 'POST',
    query: { action: 'setup' },
    body: { name: 'Ama Boateng', email: 'Ama@SmokeHub.com', pin: '2468' },
  });
  assert.equal(setup.status, 201, `setup failed: ${JSON.stringify(setup.body)}`);
  assert.equal(setup.body.admin.adminRole, 'Super Admin');
  assert.equal(setup.body.admin.email, 'ama@smokehub.com', 'email should be normalised to lower case');
  const token = setup.body.token;
  assert.ok(token, 'setup should return a session token');

  const secondSetup = await callApi(api.auth, {
    method: 'POST',
    query: { action: 'setup' },
    body: { name: 'Someone Else', email: 'other@smokehub.com', pin: '9999' },
  });
  assert.equal(secondSetup.status, 409, 'setup must refuse to create a second owner');

  // ── 3. Sign in with the created PIN ──────────────────────────────────────
  const signIn = await callApi(api.auth, {
    method: 'POST',
    query: { action: 'admin' },
    body: { email: 'ama@smokehub.com', pin: '2468' },
  });
  assert.equal(signIn.status, 200, 'sign-in with the right PIN should work');

  const badPin = await callApi(api.auth, {
    method: 'POST',
    query: { action: 'admin' },
    body: { email: 'ama@smokehub.com', pin: '0000' },
  });
  assert.equal(badPin.status, 401, 'a wrong PIN must be rejected');

  // ── 4. Create a product with a barcode ───────────────────────────────────
  const product = await callApi(api.products, {
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
  assert.equal(product.status, 201, `product create failed: ${JSON.stringify(product.body)}`);
  assert.equal(product.body.barcode, 'ACS-000001');
  assert.equal(Number(product.body.stockCount), 10);

  // ── 5. Look it up the way a scanner would ────────────────────────────────
  const scanned = await callApi(api.products, { token, query: { scanCode: 'ACS-000001' } });
  assert.equal(scanned.status, 200);
  assert.equal(scanned.body.products.length, 1, 'scanner lookup should find the product');
  assert.equal(scanned.body.products[0].name, 'Mango Kush');

  // ── 6. Ring up a sale ───────────────────────────────────────────────────
  const sale = await callApi(api.orders, {
    method: 'POST',
    query: { channel: 'pos' },
    token,
    body: {
      idempotencyKey: `POS-spike-${Date.now()}`,
      subtotal: 90, shippingFee: 0, discount: 0, total: 90,
      paymentMethod: 'cash-on-delivery', cashReceived: 100,
      shippingAddress: WALLET,
      items: [{ product: { id: product.body.id, price: 45 }, quantity: 2 }],
    },
  });
  assert.equal(sale.status, 201, `sale failed: ${JSON.stringify(sale.body)}`);
  assert.equal(Number(sale.body.total), 90);
  assert.equal(sale.body.cashierName, 'Ama Boateng', 'a sale should record who served it');

  const afterSale = await callApi(api.products, { token, query: { id: product.body.id } });
  assert.equal(Number(afterSale.body.stockCount), 8, 'selling 2 units should leave 8');

  // ── 7. Replaying the same sale must not double-charge ───────────────────
  const replayKey = `POS-spike-${Date.now()}`;
  const saleBody = {
    idempotencyKey: replayKey, subtotal: 45, shippingFee: 0, discount: 0, total: 45,
    paymentMethod: 'cash-on-delivery', cashReceived: 45, shippingAddress: WALLET,
    items: [{ product: { id: product.body.id, price: 45 }, quantity: 1 }],
  };
  const firstSale = await callApi(api.orders, { method: 'POST', query: { channel: 'pos' }, token, body: saleBody });
  assert.equal(firstSale.status, 201);

  const replayed = await callApi(api.orders, { method: 'POST', query: { channel: 'pos' }, token, body: saleBody });
  assert.equal(replayed.status, 201);
  assert.equal(replayed.body.id, firstSale.body.id, 'a replay should return the original sale');

  const afterReplay = await callApi(api.products, { token, query: { id: product.body.id } });
  assert.equal(Number(afterReplay.body.stockCount), 7, 'a replayed sale must not reduce stock twice');

  // ── 8. Persistence: close the file, reopen it, read everything back ─────
  api.closeDataLayer();
  assert.ok(existsSync(dbFile), 'the SQLite file must still be on disk');

  const reopened = freshBundle();
  const productAfterRestart = await callApi(reopened.products, { token, query: { id: product.body.id } });
  assert.equal(productAfterRestart.status, 200, 'the product should survive a restart');
  assert.equal(productAfterRestart.body.name, 'Mango Kush');
  assert.equal(Number(productAfterRestart.body.stockCount), 7, 'stock should survive a restart');

  const ordersAfterRestart = await callApi(reopened.orders, { token });
  assert.equal(ordersAfterRestart.status, 200);
  assert.ok(ordersAfterRestart.body.orders.length >= 2, 'sales should survive a restart');

  // The signing key was persisted, so sign-in still works after a restart.
  const signInAfterRestart = await callApi(reopened.auth, {
    method: 'POST',
    query: { action: 'admin' },
    body: { email: 'ama@smokehub.com', pin: '2468' },
  });
  assert.equal(signInAfterRestart.status, 200, 'sign-in should work after a restart');

  reopened.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('the HTTP server serves the API and the built app on one origin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-pos-http-'));
  process.env.ANDA_DATA_DIR = dir;

  const api = freshBundle();
  const { startLocalServer } = require(join(root, 'electron/local-server.cjs'));
  const { server, origin } = await startLocalServer({
    distDir: join(root, 'dist'),
    handlers: api,
    host: '127.0.0.1',
    port: 0,
  });

  try {
    const setupStatus = await fetch(`${origin}/api/auth?action=setup-status`);
    assert.equal(setupStatus.status, 200);
    assert.deepEqual(await setupStatus.json(), { needsSetup: true });

    const notFound = await fetch(`${origin}/api/nope`);
    assert.equal(notFound.status, 404, 'an unknown API route should 404');

    const index = await fetch(`${origin}/`);
    assert.equal(index.status, 200, 'the built app should be served');
    const html = await index.text();
    assert.match(html, /Anda C Smoke Hub POS/i, 'the served page should carry the shop name');

    // Traversal must never return a file from outside dist/. Some of these paths
    // are normalised by the URL parser and fall back to the SPA, others reach
    // the server's own guard — both are fine. What must never happen is a file
    // from outside dist/ being served, so assert on the content, not the status.
    const rawGet = (rawPath) => new Promise((resolve) => {
      const request = http.request(
        { host: '127.0.0.1', port: new URL(origin).port, path: rawPath, method: 'GET' },
        (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body }));
        },
      );
      request.on('error', () => resolve({ status: 0, body: '' }));
      request.end();
    });

    for (const attempt of [
      '/../package.json',
      '/%2e%2e/package.json',
      '/%2e%2e%2f%2e%2e%2fpackage.json',
      '/assets/%2e%2e/%2e%2e/package.json',
      '/%2e%2e/server-api/_auth.ts',
    ]) {
      const result = await rawGet(attempt);
      assert.ok(
        !result.body.includes('"electron-builder"') && !result.body.includes('JWT_SECRET'),
        `${attempt} leaked a file from outside dist/`,
      );
      assert.ok(!result.body.includes('bcrypt'), `${attempt} leaked server source`);
    }
  } finally {
    server.close();
    api.closeDataLayer();
    rmSync(dir, { recursive: true, force: true });
  }
});