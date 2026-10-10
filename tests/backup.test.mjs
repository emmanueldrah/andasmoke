/**
 * Stage 1 verification: backup, wipe, restore, and the till's money rules.
 *
 *   1. a daily backup is taken with VACUUM INTO (safe under WAL)
 *   2. only the last 14 daily backups are kept
 *   3. a manual export goes to a path the user chose
 *   4. wiping clears the data but keeps the schema, so setup is required again
 *   5. restoring into that fresh database brings every row back
 *   6. corrupt and wrong-version backups are refused
 *   7. a cashier cannot apply a promo or a discount
 *   8. voiding and refunding are both rejected without a reason
 *
 * Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const bundlePath = join(root, 'electron/api-bundle.cjs');

function freshBundle() {
  delete require.cache[require.resolve(bundlePath)];
  return require(bundlePath);
}

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
const SALE = (idempotencyKey, quantity = 1) => ({
  idempotencyKey,
  subtotal: 45 * quantity, shippingFee: 0, discount: 0, total: 45 * quantity,
  paymentMethod: 'cash-on-delivery', cashReceived: 45 * quantity, shippingAddress: WALLET,
  items: [{ product: { id: 'prod-backup-1', price: 45 }, quantity }],
});

/** A till with one owner, one cashier, one product, and a completed sale. */
async function seedTill() {
  const api = freshBundle();
  const setup = await callApi(api.auth, {
    method: 'POST', query: { action: 'setup' },
    body: { name: 'Ama Boateng', email: 'ama@smokehub.com', pin: '2468' },
  });
  assert.equal(setup.status, 201, `setup failed: ${JSON.stringify(setup.body)}`);
  const ownerToken = setup.body.token;

  const cashier = await callApi(api.adminAccounts, {
    method: 'POST', token: ownerToken,
    body: { fullName: 'Kofi Clerk', email: 'kofi@smokehub.com', role: 'cashier', pin: '1357' },
  });
  assert.equal(cashier.status, 201, `cashier create failed: ${JSON.stringify(cashier.body)}`);

  const product = await callApi(api.products, {
    method: 'POST', token: ownerToken,
    body: {
      id: 'prod-backup-1', name: 'Mango Kush', brand: 'N shisha', department: 'beauty',
      category: 'skincare', categoryLabel: 'Shisha Flavors', price: '45.00', unit: 'bowl',
      barcode: 'ACS-000001', image: '', images: [''], description: 'Sweet mango flavor',
      stockCount: 10,
    },
  });
  assert.equal(product.status, 201, `product create failed: ${JSON.stringify(product.body)}`);

  const sale = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken, body: SALE(`POS-backup-${Date.now()}`),
  });
  assert.equal(sale.status, 201, `sale failed: ${JSON.stringify(sale.body)}`);

  return { api, ownerToken, cashier, product: product.body, sale: sale.body };
}

test('daily backups use VACUUM INTO and keep only the last 14', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-backup-'));
  process.env.ANDA_DATA_DIR = dir;

  const { api, ownerToken } = await seedTill();

  // The handler stamps each backup with today's date, so seed a spread of older
  // days by hand to give retention something real to trim.
  const backupDir = join(dir, 'backups');
  mkdirSync(backupDir, { recursive: true });

  const first = await callApi(api.backups, { method: 'POST', query: { action: 'daily' }, token: ownerToken });
  assert.equal(first.status, 201, `daily backup failed: ${JSON.stringify(first.body)}`);
  assert.ok(existsSync(first.body.path), 'the snapshot file should exist');
  assert.ok(!existsSync(`${first.body.path}-wal`), 'a VACUUM INTO snapshot must not need a WAL sidecar');
  assert.ok(!existsSync(`${first.body.path}-shm`), 'a VACUUM INTO snapshot must not need a shared-memory file');
  assert.equal(readFileSync(first.body.path).subarray(0, 16).toString('utf8'), 'SQLite format 3\u0000');

  // Today plus 20 older days = 21 candidates for 14 kept slots.
  const today = new Date().toISOString().slice(0, 10);
  const snapshot = readFileSync(first.body.path);
  const manifest = readFileSync(`${first.body.path}.manifest.json`, 'utf8');
  for (let back = 1; back <= 20; back++) {
    const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    if (day === today) continue;
    const path = join(backupDir, `anda-daily-${day}.sqlite`);
    writeFileSync(path, snapshot);
    writeFileSync(`${path}.manifest.json`, manifest);
  }

  // Taking one more daily backup prunes the folder down to the retention limit.
  await callApi(api.backups, { method: 'POST', query: { action: 'daily' }, token: ownerToken });

  const listed = await callApi(api.backups, { method: 'GET', query: { action: 'list' }, token: ownerToken });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.retention, 14, 'retention policy should be 14 daily backups');
  assert.equal(listed.body.backups.length, 14, 'older daily backups should be pruned');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('a manual export lands at the chosen path and a restore brings the data back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-export-'));
  const exportDir = mkdtempSync(join(tmpdir(), 'anda-usb-'));
  process.env.ANDA_DATA_DIR = dir;

  const { api, ownerToken, product, sale } = await seedTill();

  // ── Manual export to a path the user picked ──────────────────────────────
  const exportPath = join(exportDir, 'anda-manual-backup.zip');
  const exported = await callApi(api.backups, {
    method: 'POST', query: { action: 'export' }, token: ownerToken, body: { path: exportPath },
  });
  assert.equal(exported.status, 201, `export failed: ${JSON.stringify(exported.body)}`);
  assert.equal(exported.body.path, exportPath);
  assert.equal(exported.body.mediaFiles, 0, 'no photos have been uploaded in this test');
  assert.ok(existsSync(exportPath), 'the export should be written where the user asked');

  // Refuses to silently clobber an existing file.
  const clash = await callApi(api.backups, {
    method: 'POST', query: { action: 'export' }, token: ownerToken, body: { path: exportPath },
  });
  assert.equal(clash.status, 400, 'export must not overwrite an existing file');
  assert.match(clash.body.error, /already exists/i);

  // ── Wipe every row, keeping the schema ───────────────────────────────────
  const wipe = await callApi(api.backups, {
    method: 'POST', query: { action: 'wipe' }, token: ownerToken, body: { confirm: 'ERASE ALL TILL DATA' },
  });
  assert.equal(wipe.status, 200, `wipe failed: ${JSON.stringify(wipe.body)}`);
  assert.equal(wipe.body.wiped, true);

  const needsSetup = await callApi(api.auth, { query: { action: 'setup-status' } });
  assert.equal(needsSetup.body.needsSetup, true, 'a wiped till must ask for a new owner');

  const goneProducts = await callApi(api.products, { token: ownerToken, query: {} });
  assert.equal(goneProducts.status, 401, 'the old owner token must not survive a wipe');

  // ── Restore into that fresh, empty database ──────────────────────────────
  const restored = await callApi(api.backups, {
    method: 'POST', query: { action: 'restore' }, token: await reLogin(api), body: { path: exportPath },
  });
  assert.equal(restored.status, 200, `restore failed: ${JSON.stringify(restored.body)}`);
  assert.equal(restored.body.kind, 'export', 'a .zip must restore as an export, not a bare snapshot');

  // The data layer must be reopened against the restored file.
  const reopened = freshBundle();
  const signIn = await callApi(reopened.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email: 'ama@smokehub.com', pin: '2468' },
  });
  assert.equal(signIn.status, 200, 'the original owner should sign in after a restore');
  const restoredToken = signIn.body.token;

  const products = await callApi(reopened.products, { token: restoredToken, query: { includeUnpublished: true } });
  const restoredProduct = products.body.products.find(entry => entry.id === product.id);
  assert.ok(restoredProduct, 'the restored database should contain the product again');
  assert.equal(Number(restoredProduct.stockCount), 9, 'stock should come back as it was at backup time');

  const orders = await callApi(reopened.orders, { token: restoredToken, query: {} });
  assert.ok(
    orders.body.orders.some(order => order.id === sale.id),
    'the restored database should contain the original sale',
  );

  // The wipe and restore each reopen the data layer, so close both copies.
  reopened.closeDataLayer();
  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
  rmSync(exportDir, { recursive: true, force: true });
});

test('restore refuses a corrupt or wrong-version backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-bad-'));
  const badDir = mkdtempSync(join(tmpdir(), 'anda-bad-files-'));
  process.env.ANDA_DATA_DIR = dir;

  const { api, ownerToken } = await seedTill();

  // A daily snapshot is the plain-database form of a backup, so this test uses
  // one: it has a sidecar manifest next to it, which is what is being probed.
  const good = await callApi(api.backups, { method: 'POST', query: { action: 'daily' }, token: ownerToken });
  assert.equal(good.status, 201, `daily backup failed: ${JSON.stringify(good.body)}`);

  // ── Not a database at all ────────────────────────────────────────────────
  const notDb = join(badDir, 'not-a-database.sqlite');
  writeFileSync(notDb, 'this is plain text pretending to be a backup');
  const checkNotDb = await callApi(api.backups, {
    method: 'POST', query: { action: 'verify' }, token: ownerToken, body: { path: notDb },
  });
  assert.equal(checkNotDb.status, 400);
  assert.match(checkNotDb.body.error, /not a database|not an Anda backup/i);

  // ── Truncated snapshot ───────────────────────────────────────────────────
  const truncated = join(badDir, 'truncated.sqlite');
  writeFileSync(truncated, readFileSync(good.body.path).subarray(0, 200));
  const checkTruncated = await callApi(api.backups, {
    method: 'POST', query: { action: 'verify' }, token: ownerToken, body: { path: truncated },
  });
  assert.equal(checkTruncated.status, 400, 'a truncated file must be refused');

  // ── Edited after it was taken (hash mismatch) ────────────────────────────
  const tampered = join(badDir, 'tampered.sqlite');
  const bytes = readFileSync(good.body.path);
  bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
  writeFileSync(tampered, bytes);
  writeFileSync(`${tampered}.manifest.json`, readFileSync(`${good.body.path}.manifest.json`, 'utf8'));
  const checkTampered = await callApi(api.backups, {
    method: 'POST', query: { action: 'verify' }, token: ownerToken, body: { path: tampered },
  });
  assert.equal(checkTampered.status, 400, 'a modified backup must be refused');
  assert.match(checkTampered.body.error, /damaged|changed/i);

  // ── Made by a different schema version ───────────────────────────────────
  const future = join(badDir, 'future.sqlite');
  writeFileSync(future, bytes);
  const manifest = JSON.parse(readFileSync(`${good.body.path}.manifest.json`, 'utf8'));
  writeFileSync(`${future}.manifest.json`, JSON.stringify({ ...manifest, schemaVersion: 99 }));
  const checkFuture = await callApi(api.backups, {
    method: 'POST', query: { action: 'verify' }, token: ownerToken, body: { path: future },
  });
  assert.equal(checkFuture.status, 400, 'a wrong-version backup must be refused');
  assert.match(checkFuture.body.error, /another version/i);

  // ── A refused restore must not touch the live database ───────────────────
  const before = await callApi(api.products, { token: ownerToken, query: { includeUnpublished: true } });
  const beforeCount = before.body.products.length;
  const rejected = await callApi(api.backups, {
    method: 'POST', query: { action: 'restore' }, token: ownerToken, body: { path: future },
  });
  assert.equal(rejected.status, 400);
  const after = await callApi(api.products, { token: ownerToken, query: { includeUnpublished: true } });
  assert.equal(after.body.products.length, beforeCount, 'a refused restore must leave the data alone');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
  rmSync(badDir, { recursive: true, force: true });
});

test('a daily backup is due only after 24 hours, and taken on startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-due-'));
  process.env.ANDA_DATA_DIR = dir;

  const { api, ownerToken } = await seedTill();

  // Nothing backed up yet, so one is due immediately.
  const before = api.lastBackupInfo(new Date());
  assert.equal(before.exists, false, 'a fresh till has no backup yet');
  assert.equal(before.due, true, 'a till with no backup must be due for one');

  // Startup hook takes exactly one.
  const started = api.createBackupIfDue('startup', new Date());
  assert.ok(started, 'the app must take a backup on start when none exists');
  assert.equal(started.reason, 'startup');

  const afterStart = api.lastBackupInfo(new Date());
  assert.equal(afterStart.exists, true);
  assert.equal(afterStart.due, false, 'a backup taken just now is not due again');
  assert.ok(afterStart.ageHours !== null && afterStart.ageHours < 0.2, 'age should be a fraction of an hour');

  // Starting again the same day must not pile up extra snapshots.
  const second = api.createBackupIfDue('startup', new Date());
  assert.equal(second, null, 'starting twice in a day must not back up twice');
  assert.equal(api.listDailyBackups().length, 1, 'only one daily file should exist');

  // Still not due at 23 hours.
  const almost = new Date(Date.now() + 23 * 60 * 60 * 1000);
  assert.equal(api.createBackupIfDue('startup', almost), null, 'not due at 23 hours');
  assert.equal(api.lastBackupInfo(almost).due, false);

  // Due once past 24 hours — this is the clean-close case.
  const overdue = new Date(Date.now() + 25 * 60 * 60 * 1000);
  const onClose = api.createBackupIfDue('shutdown', overdue);
  assert.ok(onClose, 'a backup is due after 24 hours, so a clean close must take one');
  assert.equal(onClose.reason, 'shutdown');

  const afterClose = api.lastBackupInfo(new Date());
  assert.equal(afterClose.exists, true);
  // The new file is dated tomorrow, so it is the newest and nothing is due.
  const files = api.listDailyBackups();
  assert.equal(files.length, 2, 'the overdue close adds a second dated file');
  // The file just written has today's mtime, so the clock is reset for real.
  assert.equal(api.lastBackupInfo(new Date()).due, false, 'the new backup resets the clock');

  // And the API exposes the same indicator to an admin screen.
  const listed = await callApi(api.backups, { method: 'GET', query: { action: 'list' }, token: ownerToken });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.last.exists, true, 'the list should report the last backup');
  assert.ok(listed.body.last.createdAt, 'the indicator needs a timestamp to show');
  assert.equal(typeof listed.body.last.due, 'boolean');
  assert.equal(typeof listed.body.last.ageHours, 'number');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('restoring a snapshot reports product photos that are missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-media-'));
  process.env.ANDA_DATA_DIR = dir;

  const { api, ownerToken } = await seedTill();

  // Upload two photos through the real media handler so they land on disk.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const urls = [];
  for (let i = 0; i < 2; i++) {
    const up = await callApi(api.products, {
      method: 'POST', query: { imageUpload: 'true' }, token: ownerToken, body: { image: png },
    });
    assert.equal(up.status, 201, `photo upload failed: ${JSON.stringify(up.body)}`);
    assert.match(up.body.url, /^\/media\/products\//, 'photos must be stored locally');
    urls.push(up.body.url);
  }

  const patched = await callApi(api.products, {
    method: 'PATCH', token: ownerToken, query: { id: 'prod-backup-1' },
    body: { image: urls[0], images: urls },
  });
  assert.equal(patched.status, 200, `product patch failed: ${JSON.stringify(patched.body)}`);

  assert.deepEqual(api.findMissingProductImages(), [], 'both photos are on disk');

  // ── The snapshot records which photos the database refers to ────────────
  const daily = await callApi(api.backups, { method: 'POST', query: { action: 'daily' }, token: ownerToken });
  assert.equal(daily.status, 201);

  const manifest = JSON.parse(readFileSync(`${daily.body.path}.manifest.json`, 'utf8'));
  assert.equal(manifest.media.count, 2, 'the manifest records how many photos are referenced');

  // ── Delete the photos, as if the folder were lost ────────────────────────
  rmSync(join(dir, 'media'), { recursive: true, force: true });
  assert.equal(api.findMissingProductImages().length, 2, 'both referenced photos are now absent');

  // ── Restore reports the gap instead of failing ───────────────────────────
  const restored = await callApi(api.backups, {
    method: 'POST', query: { action: 'restore' }, token: ownerToken, body: { path: daily.body.path },
  });
  assert.equal(restored.status, 200, `restore should still succeed: ${JSON.stringify(restored.body)}`);
  assert.equal(restored.body.restored, true);
  assert.equal(restored.body.kind, 'snapshot', 'a plain .sqlite file restores as a snapshot');
  assert.equal(restored.body.missingImages.length, 2, 'the restore should warn about the absent photos');
  for (const missing of restored.body.missingImages) {
    assert.ok(typeof missing === 'string' && missing.length > 0, 'each warning names the file');
  }

  // The data came back regardless of the missing photos.
  const reopened = freshBundle();
  const signIn = await callApi(reopened.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email: 'ama@smokehub.com', pin: '2468' },
  });
  assert.equal(signIn.status, 200, 'the database itself restored correctly');
  const products = await callApi(reopened.products, { token: signIn.body.token, query: { includeUnpublished: true } });
  assert.ok(
    products.body.products.some(entry => entry.id === 'prod-backup-1'),
    'the product is back; only its photos are missing',
  );

  // Each restore reopens the data layer in whichever module copy served the
  // request, so close every copy before removing the temp folder.
  reopened.closeDataLayer();
  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('wipe needs the owner, the exact phrase, and backs up before erasing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-wipe-'));
  process.env.ANDA_DATA_DIR = dir;

  const { api, ownerToken } = await seedTill();

  // Give a Store Manager an account so the "owner only" rule can be tested.
  const manager = await callApi(api.adminAccounts, {
    method: 'POST', token: ownerToken,
    body: { fullName: 'Ama Manager', email: 'manager@smokehub.com', role: 'manager', pin: '2468' },
  });
  assert.equal(manager.status, 201);
  const managerToken = (await callApi(api.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email: 'manager@smokehub.com', pin: '2468' },
  })).body.token;

  const PHRASE = 'ERASE ALL TILL DATA';

  // ── An unauthenticated caller cannot wipe ───────────────────────────────
  const anonymous = await callApi(api.backups, {
    method: 'POST', query: { action: 'wipe' }, body: { confirm: PHRASE },
  });
  assert.equal(anonymous.status, 401, 'no session must not wipe');

  const cashierLogin = await callApi(api.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email: 'kofi@smokehub.com', pin: '1357' },
  });
  const byRealCashier = await callApi(api.backups, {
    method: 'POST', query: { action: 'wipe' }, token: cashierLogin.body.token, body: { confirm: PHRASE },
  });
  assert.equal(byRealCashier.status, 403, 'a cashier must not wipe the till');

  // ── A delegated manager cannot wipe either ──────────────────────────────
  const byManager = await callApi(api.backups, {
    method: 'POST', query: { action: 'wipe' }, token: managerToken, body: { confirm: PHRASE },
  });
  assert.equal(byManager.status, 403, 'only the Super Admin may wipe the till');

  // Managers can still back up and list.
  const managerList = await callApi(api.backups, { method: 'GET', query: { action: 'list' }, token: managerToken });
  assert.equal(managerList.status, 200, 'a Store Manager must still be able to list backups');
  const cashierList = await callApi(api.backups, { method: 'GET', query: { action: 'list' }, token: cashierLogin.body.token });
  assert.equal(cashierList.status, 403, 'a cashier must not be able to list backups');
  const cashierAudit = await callApi(api.backups, { method: 'GET', query: { action: 'audit' }, token: cashierLogin.body.token });
  assert.equal(cashierAudit.status, 403, 'a cashier must not be able to read the audit log');

  // ── The wrong phrase is refused, and nothing is erased ──────────────────
  // Surrounding whitespace is forgiven (easy to do when pasting), but the phrase
// itself must be exact: right words, right case, single spaces.
  for (const wrong of ['WIPE', 'wipe', 'erase', 'ERASE  ALL TILL DATA', PHRASE.toLowerCase(), 'ERASE ALL TILL', 'ERASE ALL DATA']) {
    const refused = await callApi(api.backups, {
      method: 'POST', query: { action: 'wipe' }, token: ownerToken, body: { confirm: wrong },
    });
    assert.equal(refused.status, 400, `"${wrong}" must not be accepted as the confirmation`);
    assert.match(refused.body.error, /ERASE ALL TILL DATA/);
  }
  const missingPhrase = await callApi(api.backups, {
    method: 'POST', query: { action: 'wipe' }, token: ownerToken, body: {},
  });
  assert.equal(missingPhrase.status, 400, 'the phrase is mandatory');

  const untouched = await callApi(api.products, { token: ownerToken, query: { includeUnpublished: true } });
  assert.ok(untouched.body.products.length > 0, 'a refused wipe must leave the data alone');
  assert.equal(api.listDailyBackups().length, 0, 'a refused wipe must not create a backup either');

  // ── The correct phrase wipes, after taking a safety backup ───────────────
  const wiped = await callApi(api.backups, {
    method: 'POST', query: { action: 'wipe' }, token: ownerToken, body: { confirm: PHRASE },
  });
  assert.equal(wiped.status, 200, `wipe failed: ${JSON.stringify(wiped.body)}`);
  assert.equal(wiped.body.wiped, true);
  assert.ok(wiped.body.safetyBackup, 'the wipe must report the backup it took first');
  assert.ok(existsSync(wiped.body.safetyBackup), 'that safety backup must exist on disk');

  // The safety backup holds the data that was just erased.
  const safety = api.verifyBackup(wiped.body.safetyBackup);
  assert.equal(safety.schemaVersion, 1);
  const probe = new Database(wiped.body.safetyBackup, { readonly: true });
  const savedCount = probe.prepare('SELECT count(*) AS n FROM products').get().n;
  probe.close();
  assert.ok(Number(savedCount) > 0, 'the safety backup must contain the data that was wiped');

  // The live till is now empty and asks for a new owner.
  const needsSetup = await callApi(api.auth, { query: { action: 'setup-status' } });
  assert.equal(needsSetup.body.needsSetup, true, 'a wiped till must require first-run setup again');
  const oldToken = await callApi(api.products, { token: ownerToken, query: {} });
  assert.equal(oldToken.status, 401, 'the old owner session must not survive the wipe');

  // And the wipe itself is in the audit log.
  const reopened = freshBundle();
  const newOwner = await callApi(reopened.auth, {
    method: 'POST', query: { action: 'setup' },
    body: { name: 'New Owner', email: 'new@smokehub.com', pin: '9090' },
  });
  assert.equal(newOwner.status, 201);
  const entries = await callApi(reopened.backups, {
    method: 'GET', query: { action: 'audit' }, token: newOwner.body.token,
  });
  assert.equal(entries.status, 200);
  const maintenance = entries.body.entries.filter(e => e.action === 'DATA_MAINTENANCE' && e.metadata?.event === 'wipe');
  assert.equal(maintenance.length, 1, 'the wipe should be recorded even though it erased the logs');
  assert.ok(maintenance[0].metadata.safetyBackup, 'the audit entry names the safety backup');

  // The wipe reopens the data layer to write the audit entry, so both module
  // copies hold a file handle before the temp folder can be deleted.
  api.closeDataLayer();
  reopened.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('held sales can be listed, recalled and discarded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-held-'));
  process.env.ANDA_DATA_DIR = dir;

  const { api, ownerToken, product } = await seedTill();

  const ticket = {
    items: [{ product: { id: product.id, name: product.name }, quantity: 2 }],
    subtotal: 90, discount: 0, total: 90,
    paymentMethod: 'cash-on-delivery', cashReceived: 100,
    ticketLabel: 'Held 10:30',
  };

  const held = await callApi(api.heldSales, { method: 'POST', token: ownerToken, body: ticket });
  assert.equal(held.status, 201, `hold failed: ${JSON.stringify(held.body)}`);
  assert.equal(held.body.ticketLabel, 'Held 10:30');
  assert.equal(Number(held.body.total), 90);
  assert.equal(held.body.recalledAt, null);

  const listed = await callApi(api.heldSales, { method: 'GET', token: ownerToken });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.heldSales.length, 1, 'the held ticket should be listed');
  assert.equal(listed.body.heldSales[0].id, held.body.id);

  const recalled = await callApi(api.heldSales, {
    method: 'POST', query: { action: 'recall' }, token: ownerToken, body: { id: held.body.id },
  });
  assert.equal(recalled.status, 200, `recall failed: ${JSON.stringify(recalled.body)}`);
  assert.ok(recalled.body.recalledAt, 'a recalled ticket is marked as such');
  assert.equal(recalled.body.items.length, 1, 'the lines come back for the counter');

  const twice = await callApi(api.heldSales, {
    method: 'POST', query: { action: 'recall' }, token: ownerToken, body: { id: held.body.id },
  });
  assert.equal(twice.status, 409, 'a ticket must not be recalled twice');

  const discarded = await callApi(api.heldSales, {
    method: 'DELETE', query: { id: held.body.id }, token: ownerToken,
  });
  assert.equal(discarded.status, 200);
  const empty = await callApi(api.heldSales, { method: 'GET', token: ownerToken });
  assert.equal(empty.body.heldSales.length, 0, 'a discarded ticket is gone');

  // Holding survives a restart, because it is in the database.
  const second = await callApi(api.heldSales, { method: 'POST', token: ownerToken, body: ticket });
  assert.equal(second.status, 201);
  api.closeDataLayer();
  const reopened = freshBundle();
  const signIn = await callApi(reopened.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email: 'ama@smokehub.com', pin: '2468' },
  });
  const afterRestart = await callApi(reopened.heldSales, { method: 'GET', token: signIn.body.token });
  assert.equal(afterRestart.body.heldSales.length, 1, 'a held ticket must survive a restart');

  reopened.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('voiding a completed line needs a manager and a reason, while unpaid ticket edits need neither', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-void-'));
  process.env.ANDA_DATA_DIR = dir;

  const { api, ownerToken, product } = await seedTill();

  const sale = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken, body: SALE(`POS-void-${Date.now()}-abcdefgh`),
  });
  assert.equal(sale.status, 201, `sale failed: ${JSON.stringify(sale.body)}`);

  // A completed sale's line cannot be voided without a reason.
  const noReason = await callApi(api.orders, {
    method: 'POST', query: { action: 'void-line' }, token: ownerToken,
    body: { orderId: sale.body.id, productId: product.id, quantity: 1 },
  });
  assert.equal(noReason.status, 400, 'voiding a committed line must require a reason');

  const blank = await callApi(api.orders, {
    method: 'POST', query: { action: 'void-line' }, token: ownerToken,
    body: { orderId: sale.body.id, productId: product.id, quantity: 1, reason: '  ' },
  });
  assert.equal(blank.status, 400, 'a blank reason must be refused');

  // Stock is untouched by the refusals.
  let stock = await callApi(api.products, { token: ownerToken, query: { id: product.id } });
  assert.equal(Number(stock.body.stockCount), 8, 'a refused void must not change stock');

  const voided = await callApi(api.orders, {
    method: 'POST', query: { action: 'void-line' }, token: ownerToken,
    body: { orderId: sale.body.id, productId: product.id, quantity: 1, reason: 'Wrong item scanned' },
  });
  assert.equal(voided.status, 201, `void with a reason should work: ${JSON.stringify(voided.body)}`);
  stock = await callApi(api.products, { token: ownerToken, query: { id: product.id } });
  assert.equal(Number(stock.body.stockCount), 9, 'voiding a line returns its stock');

  // The void is in the audit log with the reason.
  const audit = await callApi(api.backups, { method: 'GET', query: { action: 'audit' }, token: ownerToken });
  const voidEntry = audit.body.entries.find(entry => entry.action === 'POS_LINE_VOIDED');
  assert.ok(voidEntry, 'the void must be recorded');
  assert.equal(voidEntry.metadata.reason, 'Wrong item scanned');
  assert.equal(voidEntry.metadata.quantity, 1);

  // A cashier cannot void a committed line even with a reason.
  const cashierLogin = await callApi(api.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email: 'kofi@smokehub.com', pin: '1357' },
  });
  const byCashier = await callApi(api.orders, {
    method: 'POST', query: { action: 'void-line' }, token: cashierLogin.body.token,
    body: { orderId: sale.body.id, productId: product.id, quantity: 1, reason: 'Changed mind' },
  });
  assert.equal(byCashier.status, 403, 'a cashier must not void a committed line');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('the audit log covers login, discounts, prices, stock and backups', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-audit-'));
  process.env.ANDA_DATA_DIR = dir;

  const { api, ownerToken, product } = await seedTill();

  // Failed then successful sign-in.
  await callApi(api.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email: 'ama@smokehub.com', pin: '0000' },
  });
  await callApi(api.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email: 'ama@smokehub.com', pin: '2468' },
  });

  // Discount applied.
  await callApi(api.promoCodes, {
    method: 'POST', token: ownerToken,
    body: { code: 'SAVE10', discountType: 'percentage', discountValue: 10, minSpend: 0, isActive: true },
  });
  await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: {
      idempotencyKey: `POS-audit-${Date.now()}-abcdefgh`,
      subtotal: 45, shippingFee: 0, discount: 4.5, total: 40.5,
      appliedPromoCode: 'SAVE10', paymentMethod: 'cash-on-delivery', cashReceived: 45,
      shippingAddress: WALLET,
      items: [{ product: { id: product.id, price: 45 }, quantity: 1 }],
    },
  });

  // Price change and stock adjustment in one save.
  await callApi(api.products, {
    method: 'PATCH', token: ownerToken, query: { id: product.id },
    body: { price: '50.00', stockCount: 25 },
  });

  // A backup.
  await callApi(api.backups, { method: 'POST', query: { action: 'daily' }, token: ownerToken });

  const result = await callApi(api.backups, { method: 'GET', query: { action: 'audit' }, token: ownerToken });
  assert.equal(result.status, 200);
  const actions = new Set(result.body.entries.map(entry => entry.action));

  for (const expected of [
    'STAFF_LOGIN', 'STAFF_LOGIN_FAILED', 'STAFF_ACCOUNT_CHANGED',
    'POS_SALE_COMPLETED', 'POS_DISCOUNT_APPLIED', 'DISCOUNT_CHANGED',
    'PRODUCT_PRICE_CHANGED', 'INVENTORY_STOCK_ADJUSTED', 'DATA_MAINTENANCE',
  ]) {
    assert.ok(actions.has(expected), `the audit log must record ${expected}`);
  }

  const priceEntry = result.body.entries.find(entry => entry.action === 'PRODUCT_PRICE_CHANGED');
  assert.equal(Number(priceEntry.metadata.previousPrice), 45);
  assert.equal(Number(priceEntry.metadata.nextPrice), 50);

  const stockEntry = result.body.entries.find(entry => entry.action === 'INVENTORY_STOCK_ADJUSTED');
  assert.equal(Number(stockEntry.metadata.previousStock), 8);
  assert.equal(Number(stockEntry.metadata.nextStock), 25);

  const discountEntry = result.body.entries.find(entry => entry.action === 'POS_DISCOUNT_APPLIED');
  assert.equal(discountEntry.metadata.promoCode, 'SAVE10');
  assert.equal(Number(discountEntry.metadata.discount), 4.5);

  const failed = result.body.entries.find(entry => entry.action === 'STAFF_LOGIN_FAILED');
  assert.ok(failed, 'a wrong PIN should be recorded');
  assert.equal(failed.entityId, 'ama@smokehub.com');

  // Entries carry who did it.
  assert.ok(result.body.entries.every(entry => typeof entry.actorName === 'string' && entry.actorName.length > 0));

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('a cashier cannot apply a promo or discount, and refunds need a reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-rules-'));
  process.env.ANDA_DATA_DIR = dir;

  const { api, ownerToken, cashier, product } = await seedTill();

  const cashierLogin = await callApi(api.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email: 'kofi@smokehub.com', pin: '1357' },
  });
  assert.equal(cashierLogin.status, 200, 'the cashier should be able to sign in');
  const cashierToken = cashierLogin.body.token;
  assert.equal(cashier.body.role, 'Cashier');

  const promo = await callApi(api.promoCodes, {
    method: 'POST', token: ownerToken,
    body: { code: 'SAVE10', discountType: 'percentage', discountValue: 10, minSpend: 0, isActive: true },
  });
  assert.equal(promo.status, 201, `promo create failed: ${JSON.stringify(promo.body)}`);

  // ── A plain sale is still fine for a cashier ─────────────────────────────
  const plain = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: cashierToken, body: SALE(`POS-cashier-plain-${Date.now()}`),
  });
  assert.equal(plain.status, 201, `a cashier should still be able to ring up a sale: ${JSON.stringify(plain.body)}`);

  // ── Cashier + promo code is refused ──────────────────────────────────────
  const withPromo = {
    idempotencyKey: `POS-cashier-promo-${Date.now()}`,
    subtotal: 45, shippingFee: 0, discount: 4.5, total: 40.5,
    appliedPromoCode: 'SAVE10', paymentMethod: 'cash-on-delivery',
    cashReceived: 45, shippingAddress: WALLET,
    items: [{ product: { id: product.id, price: 45 }, quantity: 1 }],
  };
  const cashierPromo = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: cashierToken, body: withPromo,
  });
  assert.equal(cashierPromo.status, 403, 'a cashier must not be able to apply a promo');
  assert.match(cashierPromo.body.error, /manager/i);

  // ── Cashier + a manual discount is refused too ───────────────────────────
  const withDiscount = { ...withPromo, idempotencyKey: `POS-cashier-disc-${Date.now()}`, appliedPromoCode: undefined };
  const cashierDiscount = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: cashierToken, body: withDiscount,
  });
  assert.equal(cashierDiscount.status, 403, 'a cashier must not be able to apply a discount');

  // Stock must be untouched by the rejected attempts.
  const stock = await callApi(api.products, { token: ownerToken, query: { id: product.id } });
  assert.equal(Number(stock.body.stockCount), 8, 'rejected sales must not reduce stock');

  // ── The owner can apply the same promo ───────────────────────────────────
  const ownerPromo = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken, body: { ...withPromo, idempotencyKey: `POS-owner-promo-${Date.now()}` },
  });
  assert.equal(ownerPromo.status, 201, `a manager should be able to apply a promo: ${JSON.stringify(ownerPromo.body)}`);
  assert.equal(Number(ownerPromo.body.discount), 4.5);

  // ── Refund without a reason is refused ───────────────────────────────────
  const target = ownerPromo.body;
  const noReason = await callApi(api.orders, {
    method: 'POST', query: { action: 'refund' }, token: ownerToken, body: { orderId: target.id },
  });
  assert.equal(noReason.status, 400, 'a refund without a reason must be refused');

  const blankReason = await callApi(api.orders, {
    method: 'POST', query: { action: 'refund' }, token: ownerToken, body: { orderId: target.id, reason: '  ' },
  });
  assert.equal(blankReason.status, 400, 'a blank reason must be refused');

  const stillSold = await callApi(api.orders, { token: ownerToken, query: {} });
  const untouched = stillSold.body.orders.find(order => order.id === target.id);
  assert.equal(untouched.status, 'Delivered', 'a refused refund must not change the sale');

  // ── Refund with a reason succeeds and records it ─────────────────────────
  const refunded = await callApi(api.orders, {
    method: 'POST', query: { action: 'refund' }, token: ownerToken, body: { orderId: target.id, reason: 'Customer changed mind' },
  });
  assert.equal(refunded.status, 200, `refund with a reason should work: ${JSON.stringify(refunded.body)}`);
  assert.equal(refunded.body.status, 'Refunded');

  // ── Voiding a committed line needs a reason and a manager ────────────────
  // (Voiding a line on the *unpaid* ticket is a screen-only edit that never
  // reaches this API, so there is nothing here to test for it.)
  const voidNoReason = await callApi(api.orders, {
    method: 'POST', query: { action: 'void-line' }, token: ownerToken,
    body: { orderId: ownerPromo.body.id, productId: 'prod-backup-1', quantity: 1 },
  });
  assert.equal(voidNoReason.status, 400, 'voiding a committed line must require a reason');

  // ── A cashier may not void a committed line or refund a sale ─────────────
  const cashierVoid = await callApi(api.orders, {
    method: 'POST', query: { action: 'void-line' }, token: cashierToken,
    body: { orderId: ownerPromo.body.id, productId: 'prod-backup-1', quantity: 1, reason: 'Changed mind' },
  });
  assert.equal(cashierVoid.status, 403, 'a cashier must not be able to void a committed line');

  const cashierRefund = await callApi(api.orders, {
    method: 'POST', query: { action: 'refund' }, token: cashierToken, body: { orderId: plain.body.id, reason: 'Changed mind' },
  });
  assert.equal(cashierRefund.status, 403, 'a cashier must not be able to refund a sale');

  // ── And a cashier cannot reach the data files ────────────────────────────
  const cashierBackup = await callApi(api.backups, {
    method: 'POST', query: { action: 'wipe' }, token: cashierToken, body: { confirm: 'WIPE' },
  });
  assert.equal(cashierBackup.status, 403, 'a cashier must not be able to wipe the till');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

/** Creates the new super admin a wiped till asks for, and returns their token. */
async function reLogin(api) {
  const setup = await callApi(api.auth, {
    method: 'POST', query: { action: 'setup' },
    body: { name: 'New Owner', email: 'new@smokehub.com', pin: '9090' },
  });
  assert.equal(setup.status, 201, 'a wiped till should accept a new super admin');
  return setup.body.token;
}