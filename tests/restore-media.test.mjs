/**
 * Export → wipe → restore: the archive must bring back the database *and* the
 * product photos, and the local server must serve those photos again afterwards.
 *
 * Run with: node tests/restore-media.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const bundlePath = join(root, 'electron/api-bundle.cjs');

function freshBundle() {
  delete require.cache[require.resolve(bundlePath)];
  return require(bundlePath);
}

function fakeResponse() {
  const res = {
    statusCode: 200, headersSent: false, payload: undefined,
    setHeader() {},
    status(c) { res.statusCode = c; return res; },
    json(p) { res.statusCode = res.statusCode || 200; res.payload = p; res.headersSent = true; return res; },
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

// A real 1x1 PNG, so the served bytes are recognisable as an image.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const WALLET = { fullName: 'Walk-in customer', phone: 'In-store sale', city: 'In-store', area: 'Counter' };

test('a manual export is one archive holding the database and its photos, and restore rebuilds both', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-export-media-'));
  const usbDir = mkdtempSync(join(tmpdir(), 'anda-usb-'));
  process.env.ANDA_DATA_DIR = dir;

  const api = freshBundle();
  const mediaRoot = join(dir, 'media', 'products');

  // ── A till with an owner, two photos on two products, and one sale ──────
  const setup = await callApi(api.auth, {
    method: 'POST', query: { action: 'setup' },
    body: { name: 'Ama Boateng', email: 'ama@smokehub.com', pin: '2468' },
  });
  assert.equal(setup.status, 201, `setup failed: ${JSON.stringify(setup.body)}`);
  const ownerToken = setup.body.token;

  const urls = [];
  for (let i = 0; i < 2; i++) {
    const up = await callApi(api.products, {
      method: 'POST', query: { imageUpload: 'true' }, token: ownerToken,
      body: { image: `data:image/png;base64,${PNG_BASE64}` },
    });
    assert.equal(up.status, 201, `photo upload failed: ${JSON.stringify(up.body)}`);
    urls.push(up.body.url);
  }

  for (const [index, id] of ['prod-a', 'prod-b'].entries()) {
    const created = await callApi(api.products, {
      method: 'POST', token: ownerToken,
      body: {
        id, name: `Product ${id}`, brand: 'Anda', department: 'beauty', category: 'skincare',
        categoryLabel: 'Test', price: '25.00', unit: 'box', barcode: `BC-${id}`,
        image: urls[index], images: [urls[index]], description: '', stockCount: 10,
      },
    });
    assert.equal(created.status, 201, `product create failed: ${JSON.stringify(created.body)}`);
  }

  const sale = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: {
      idempotencyKey: `POS-media-${Date.now()}-abcdefgh`,
      subtotal: 25, shippingFee: 0, discount: 0, total: 25,
      paymentMethod: 'cash-on-delivery', cashReceived: 25, shippingAddress: WALLET,
      items: [{ product: { id: 'prod-a', price: 25 }, quantity: 1 }],
    },
  });
  assert.equal(sale.status, 201, `sale failed: ${JSON.stringify(sale.body)}`);

  // Both photos are on disk and referenced.
  for (const url of urls) {
    assert.ok(existsSync(join(mediaRoot, ...url.replace('/media/products/', '').split('/'))),
      `${url} should exist on disk before the export`);
  }
  assert.deepEqual(api.findMissingProductImages(), [], 'no photo should be missing yet');

  // ── The export is a single file that contains both parts ────────────────
  const exportPath = join(usbDir, 'anda-export.zip');
  const exported = await callApi(api.backups, {
    method: 'POST', query: { action: 'export' }, token: ownerToken, body: { path: exportPath },
  });
  assert.equal(exported.status, 201, `export failed: ${JSON.stringify(exported.body)}`);
  assert.equal(exported.body.path, exportPath);
  assert.equal(exported.body.mediaFiles, 2, 'the export must carry both photos');
  assert.ok(exported.body.bytes > 0);
  assert.ok(existsSync(exportPath), 'the archive must exist at the chosen path');

  // One file, readable as a ZIP holding the database, the photos and a manifest.
  const entries = api.readZip(readFileSync(exportPath));
  const paths = entries.map(entry => entry.path).sort();
  assert.deepEqual(paths, [
    'anda-smoke-hub.sqlite',
    'manifest.json',
    `media/products/${urls[0].replace('/media/products/', '')}`,
    `media/products/${urls[1].replace('/media/products/', '')}`,
  ].sort(), `unexpected archive contents: ${JSON.stringify(paths)}`);

  const packagedDb = entries.find(entry => entry.path === 'anda-smoke-hub.sqlite').data;
  assert.equal(packagedDb.subarray(0, 16).toString('utf8'), 'SQLite format 3\u0000',
    'the packaged database must be a real SQLite file');

  // The photo bytes inside the archive are the real image.
  const packagedPhoto = entries.find(entry => entry.path.startsWith('media/products/')).data;
  assert.ok(packagedPhoto.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'the archived photo must still be a PNG');

  // A non-existent destination is refused, so an earlier export is never lost.
  const clash = await callApi(api.backups, {
    method: 'POST', query: { action: 'export' }, token: ownerToken, body: { path: exportPath },
  });
  assert.equal(clash.status, 400, 'export must not overwrite an existing file');

  // ── Verify the export before relying on it ──────────────────────────────
  const verified = await callApi(api.backups, {
    method: 'POST', query: { action: 'verify' }, token: ownerToken, body: { path: exportPath },
  });
  assert.equal(verified.status, 200, `verify failed: ${JSON.stringify(verified.body)}`);
  assert.equal(verified.body.valid, true);
  assert.equal(verified.body.kind, 'export');
  assert.equal(verified.body.mediaFiles, 2);

  // ── Wipe the till ──────────────────────────────────────────────────────
  const wiped = await callApi(api.backups, {
    method: 'POST', query: { action: 'wipe' }, token: ownerToken, body: { confirm: 'ERASE ALL TILL DATA' },
  });
  assert.equal(wiped.status, 200, `wipe failed: ${JSON.stringify(wiped.body)}`);

  // Now destroy the photos too, as if the whole data folder had been lost.
  rmSync(join(dir, 'media'), { recursive: true, force: true });
  assert.equal(api.findMissingProductImages().length, 0,
    'nothing is referenced any more, since the catalogue is empty');

  // ── Restore the archive ────────────────────────────────────────────────
  const restored = await callApi(api.backups, {
    method: 'POST', query: { action: 'restore' }, token: (await relogin(api)).token, body: { path: exportPath },
  });
  assert.equal(restored.status, 200, `restore failed: ${JSON.stringify(restored.body)}`);
  assert.equal(restored.body.restored, true);
  assert.equal(restored.body.kind, 'export');
  assert.equal(restored.body.mediaRestored, 2, 'both photos must be written back');
  assert.deepEqual(restored.body.missingImages, [], 'nothing should be reported missing');

  // ── The photos are on disk again, byte for byte ────────────────────────
  for (const url of urls) {
    const onDisk = join(mediaRoot, ...url.replace('/media/products/', '').split('/'));
    assert.ok(existsSync(onDisk), `${url} must exist again after the restore`);
    assert.ok(readFileSync(onDisk).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      `${url} must be restored intact`);
  }

  // ── The catalogue points at them again, and nothing is missing ──────────
  const reopened = freshBundle();
  assert.deepEqual(reopened.findMissingProductImages(), [],
    'every referenced photo must resolve after the restore');

  const signIn = await callApi(reopened.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email: 'ama@smokehub.com', pin: '2468' },
  });
  assert.equal(signIn.status, 200, 'the owner must sign in again after the restore');
  const token = signIn.body.token;

  const products = await callApi(reopened.products, { token, query: { includeUnpublished: true } });
  for (const id of ['prod-a', 'prod-b']) {
    const product = products.body.products.find(entry => entry.id === id);
    assert.ok(product, `${id} must be back in the catalogue`);
    assert.ok(product.image.startsWith('/media/products/'), `${id} must point at local media again`);
  }

  const orders = await callApi(reopened.orders, { token, query: {} });
  assert.ok(orders.body.orders.some(order => order.id === sale.body.id), 'the sale must be back too');

  // ── And the local server serves the restored images ────────────────────
  const { startLocalServer } = require(join(root, 'electron/local-server.cjs'));
  const { handlers } = require(join(root, 'electron/api-routes.cjs'));
  const { origin, server } = await startLocalServer({
    distDir: join(root, 'dist'),
    handlers,
    host: '127.0.0.1',
    port: 0,
  });

  try {
    for (const url of urls) {
      const response = await fetch(`${origin}${url}`);
      assert.equal(response.status, 200, `${url} should be served again (got ${response.status})`);
      assert.equal(response.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        `${url} must be served as a real PNG`);
      assert.ok(bytes.length > 0, `${url} must not be served empty`);
    }

    // A photo that is genuinely gone is still reported honestly.
    const missing = await fetch(`${origin}/media/products/1999-01-01/not-here.png`);
    assert.equal(missing.status, 404, 'an unknown photo must 404 rather than serve something else');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  reopened.closeDataLayer();
  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
  rmSync(usbDir, { recursive: true, force: true });
});

test('a daily snapshot references photos instead of duplicating them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-daily-media-'));
  process.env.ANDA_DATA_DIR = dir;

  const api = freshBundle();
  const setup = await callApi(api.auth, {
    method: 'POST', query: { action: 'setup' },
    body: { name: 'Ama Boateng', email: 'ama@smokehub.com', pin: '2468' },
  });
  const ownerToken = setup.body.token;

  const up = await callApi(api.products, {
    method: 'POST', query: { imageUpload: 'true' }, token: ownerToken,
    body: { image: `data:image/png;base64,${PNG_BASE64}` },
  });
  assert.equal(up.status, 201);

  const daily = await callApi(api.backups, { method: 'POST', query: { action: 'daily' }, token: ownerToken });
  assert.equal(daily.status, 201);

  // A daily snapshot is a plain SQLite file, not an archive: the photos are
  // stored once in the data folder rather than copied into every snapshot.
  assert.equal(readFileSync(daily.body.path).subarray(0, 16).toString('utf8'), 'SQLite format 3\u0000');

  const manifest = JSON.parse(readFileSync(`${daily.body.path}.manifest.json`, 'utf8'));
  assert.equal(manifest.media.count, 1, 'the manifest records that one photo is referenced');

  const mediaList = JSON.parse(readFileSync(`${daily.body.path}.media.json`, 'utf8'));
  assert.equal(mediaList.files.length, 1, 'the sidecar lists the referenced photo');
  assert.match(mediaList.note, /do not copy them/i,
    'the sidecar should say plainly that photos are not duplicated per snapshot');

  // One copy of the photo on disk, not one per snapshot.
  const photoRoot = join(dir, 'media', 'products');
  let copies = 0;
  const walk = (current) => {
    for (const entry of require('node:fs').readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name));
      else copies++;
    }
  };
  walk(photoRoot);
  assert.equal(copies, 1, 'the photo is stored once and shared by every snapshot');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('a damaged export is refused and leaves the live data alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-bad-export-'));
  const badDir = mkdtempSync(join(tmpdir(), 'anda-bad-export-files-'));
  process.env.ANDA_DATA_DIR = dir;

  const api = freshBundle();
  const setup = await callApi(api.auth, {
    method: 'POST', query: { action: 'setup' },
    body: { name: 'Ama Boateng', email: 'ama@smokehub.com', pin: '2468' },
  });
  const ownerToken = setup.body.token;

  await callApi(api.products, {
    method: 'POST', token: ownerToken,
    body: {
      id: 'keep-me', name: 'Keeper', brand: 'Anda', department: 'beauty', category: 'skincare',
      categoryLabel: 'Test', price: '10.00', unit: 'box', barcode: 'KEEP-1',
      image: '', images: [''], description: '', stockCount: 5,
    },
  });

  const good = join(badDir, 'good.zip');
  const exported = await callApi(api.backups, {
    method: 'POST', query: { action: 'export' }, token: ownerToken, body: { path: good },
  });
  assert.equal(exported.status, 201);

  // ── Not a ZIP at all ───────────────────────────────────────────────────
  // Long enough to get past the size check, so the ZIP reader is what refuses it.
  const notZip = join(badDir, 'plain.zip');
  writeFileSync(notZip, 'hello, this is not an archive. '.repeat(40));
  const checkNotZip = await callApi(api.backups, {
    method: 'POST', query: { action: 'verify' }, token: ownerToken, body: { path: notZip },
  });
  assert.equal(checkNotZip.status, 400);
  assert.match(checkNotZip.body.error, /not a ZIP/i);

  // ── A ZIP with no manifest (not ours) ──────────────────────────────────
  // A valid ZIP that this app did not write. Compressible padding means the
  // archive is large on disk... no: it is deflated, so pad with incompressible
  // bytes to clear the minimum-size check.
  const noManifest = join(badDir, 'no-manifest.zip');
  // Genuinely random bytes, which deflate cannot shrink, so the stored archive
  // clears the minimum-size check.
  const filler = randomBytes(4096);
  writeFileSync(noManifest, api.createZip([
    { path: 'readme.txt', data: filler, modified: new Date() },
  ]));
  assert.ok(statSync(noManifest).size > 1024,
    `the filler archive must clear the size check, is ${statSync(noManifest).size} bytes`);
  const checkNoManifest = await callApi(api.backups, {
    method: 'POST', query: { action: 'verify' }, token: ownerToken, body: { path: noManifest },
  });
  assert.equal(checkNoManifest.status, 400, 'an archive without a manifest is not an Anda export');
  assert.match(checkNoManifest.body.error, /manifest|not an Anda export/i);

  // ── A tampered photo inside a valid archive ────────────────────────────
  const tampered = join(badDir, 'tampered.zip');
  const original = api.readZip(readFileSync(good));
  const photoEntry = original.find(entry => entry.path.startsWith('media/'));
  if (photoEntry) {
    const swapped = Buffer.from(photoEntry.data);
    swapped[0] = 0x00; // no longer a PNG
    writeFileSync(tampered, api.createZip(original.map(entry =>
      entry.path === photoEntry.path ? { ...entry, data: swapped } : entry)));
    const checkTampered = await callApi(api.backups, {
      method: 'POST', query: { action: 'verify' }, token: ownerToken, body: { path: tampered },
    });
    assert.equal(checkTampered.status, 400, 'a modified photo must be refused');
    assert.match(checkTampered.body.error, /damaged|photo/i);
  }

  // ── A refused restore must not touch the live database ────────────────
  const before = await callApi(api.products, { token: ownerToken, query: { includeUnpublished: true } });
  const beforeCount = before.body.products.length;
  const refused = await callApi(api.backups, {
    method: 'POST', query: { action: 'restore' }, token: ownerToken, body: { path: notZip },
  });
  assert.equal(refused.status, 400);
  const after = await callApi(api.products, { token: ownerToken, query: { includeUnpublished: true } });
  assert.equal(after.body.products.length, beforeCount, 'a refused restore must leave the data alone');

  // ── ZIP round-trip itself ──────────────────────────────────────────────
  const text = 'hello world, this compresses well '.repeat(50);
  const roundTrip = api.readZip(api.createZip([
    { path: 'a/b/c.txt', data: Buffer.from(text), modified: new Date(2026, 0, 1) },
    // Large and random: deflate is tried, is not smaller, so it must be stored
    // uncompressed and read back correctly.
    { path: 'tiny.bin', data: randomBytes(300), modified: new Date(2026, 0, 1) },
    { path: 'small.bin', data: Buffer.from([1, 2, 3]), modified: new Date(2026, 0, 1) },
  ]));
  assert.equal(roundTrip.length, 3);
  assert.equal(roundTrip.find(entry => entry.path === 'a/b/c.txt').data.toString('utf8'), text);
  assert.deepEqual([...roundTrip.find(entry => entry.path === 'small.bin').data], [1, 2, 3]);
  assert.equal(roundTrip.find(entry => entry.path === 'tiny.bin').data.length, 300);

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
  rmSync(badDir, { recursive: true, force: true });
});

test('login locks out after five wrong PINs and never records a PIN', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-lockout-'));
  process.env.ANDA_DATA_DIR = dir;

  const api = freshBundle();
  const setup = await callApi(api.auth, {
    method: 'POST', query: { action: 'setup' },
    body: { name: 'Ama Boateng', email: 'ama@smokehub.com', pin: '2468' },
  });
  assert.equal(setup.status, 201);
  const ownerToken = setup.body.token;

  // A second account to lock independently of the owner.
  const cashier = await callApi(api.adminAccounts, {
    method: 'POST', token: ownerToken,
    body: { fullName: 'Kofi Clerk', email: 'kofi@smokehub.com', role: 'cashier', pin: '1357' },
  });
  assert.equal(cashier.status, 201);

  // ── PINs are stored hashed, never in the clear ─────────────────────────
  const sqlite = api.getSqliteHandle();
  const rows = sqlite.prepare('SELECT email, pin_hash FROM admin_sessions').all();
  assert.ok(rows.length >= 2, 'both accounts should exist');
  for (const row of rows) {
    assert.match(row.pin_hash, /^\$2[aby]\$12\$/, `${row.email} must hold a bcrypt hash`);
    assert.ok(!row.pin_hash.includes('2468') && !row.pin_hash.includes('1357'),
      `${row.email} must not have a readable PIN`);
  }
  const raw = JSON.stringify(rows);
  assert.ok(!raw.includes('2468'), 'no PIN may appear anywhere in the accounts table');
  assert.ok(!raw.includes('1357'), 'no PIN may appear anywhere in the accounts table');

  const onDisk = readFileSync(join(dir, 'anda-smoke-hub.sqlite'));
  assert.ok(!onDisk.includes(Buffer.from('2468')), 'the PIN must not be sitting in the database file');
  assert.ok(!onDisk.includes(Buffer.from('1357')), 'the PIN must not be sitting in the database file');

  const tryPin = async (email, pin) => callApi(api.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email, pin },
  });

  // ── Four wrong PINs: still locked to the 401 response, not a 429 ───────
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await tryPin('kofi@smokehub.com', '0000');
    assert.equal(result.status, 401, `attempt ${attempt} should be rejected as wrong, not locked`);
    assert.match(result.body.error, /Incorrect email or PIN/);
  }

  // The correct PIN still works on the fifth try.
  const good = await tryPin('kofi@smokehub.com', '1357');
  assert.equal(good.status, 200, 'the correct PIN must still work before the fifth failure');

  // ── Five wrong PINs in a row locks the account ────────────────────────
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await tryPin('kofi@smokehub.com', '9999');
    assert.equal(result.status, 401, `failure ${attempt} of 4 should still be a plain rejection`);
  }
  const fifth = await tryPin('kofi@smokehub.com', '9999');
  assert.equal(fifth.status, 429, 'the fifth failure must lock the account');
  assert.match(fifth.body.error, /locked/i);
  assert.ok(fifth.body.secondsLeft > 0 && fifth.body.secondsLeft <= 300,
    `lock should be about five minutes, got ${fifth.body.secondsLeft}s`);
  assert.ok(fifth.body.lockedUntil, 'the response should say when the lock lifts');

  // ── The lock is server-side: the correct PIN is now refused too ───────
  const correctButLocked = await tryPin('kofi@smokehub.com', '1357');
  assert.equal(correctButLocked.status, 429, 'even the right PIN must be refused while locked');
  assert.match(correctButLocked.body.error, /locked/i);

  // The lockout is stored in the database, not in process memory.
  const stored = sqlite.prepare('SELECT failed_pin_attempts, locked_until FROM admin_sessions WHERE email = ?').get('kofi@smokehub.com');
  assert.ok(stored.locked_until, 'the lock must persist in the database');
  assert.equal(stored.failed_pin_attempts, 0, 'the counter resets once the lock is applied');

  // ── Other accounts are unaffected ─────────────────────────────────────
  const ownerStillWorks = await tryPin('ama@smokehub.com', '2468');
  assert.equal(ownerStillWorks.status, 200, 'locking one account must not lock others');

  // ── No PIN, and no typed value, appears in the audit log ──────────────
  const audit = await callApi(api.backups, { method: 'GET', query: { action: 'audit' }, token: ownerToken });
  assert.equal(audit.status, 200);
  const serialised = JSON.stringify(audit.body);
  for (const secret of ['2468', '1357', '9999', '0000']) {
    assert.ok(!serialised.includes(secret), `the audit log must not contain the PIN ${secret}`);
  }
  // Nor any hash of them.
  const kofiHash = rows.find(row => row.email === 'kofi@smokehub.com').pin_hash;
  assert.ok(!serialised.includes(kofiHash), 'the audit log must not contain a PIN hash');

  const failures = audit.body.entries.filter(entry => entry.action === 'STAFF_LOGIN_FAILED');
  assert.ok(failures.length >= 8, `each wrong PIN should be recorded, saw ${failures.length}`);
  assert.ok(failures.every(entry => entry.entityId.includes('@')), 'failures record the account, not the PIN');

  const blocked = audit.body.entries.filter(entry => entry.action === 'STAFF_LOGIN_BLOCKED');
  assert.ok(blocked.length >= 1, 'the lockout itself should be recorded');

  // ── An unknown email must not lock anything or leak whether it exists ──
  const unknown = await tryPin('nobody@smokehub.com', '1234');
  assert.equal(unknown.status, 401);
  assert.match(unknown.body.error, /Incorrect email or PIN/,
    'the message must not reveal that the account is unknown');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

/** Creates the new owner a wiped till asks for, and returns their session. */
async function relogin(api) {
  const setup = await callApi(api.auth, {
    method: 'POST', query: { action: 'setup' },
    body: { name: 'New Owner', email: 'new@smokehub.com', pin: '9090' },
  });
  assert.equal(setup.status, 201, 'a wiped till should accept a new super admin');
  return setup.body;
}