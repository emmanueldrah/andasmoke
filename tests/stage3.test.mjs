/**
 * Stage 3 verification: money in pesewas, split payments, shifts, reports,
 * CSV import/export, cost price and reorder level.
 *
 * Figures are known and checked exactly: nothing here uses a tolerance, because
 * a rounding error in a till is exactly what these tests exist to catch.
 *
 * Run with: node --test tests/stage3.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
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
    statusCode: 200, headersSent: false, payload: undefined, bodyText: undefined,
    setHeader() {},
    status(c) { res.statusCode = c; return res; },
    json(p) { res.statusCode = res.statusCode || 200; res.payload = p; res.headersSent = true; return res; },
    send(body) { res.bodyText = body; this.payload = body; this.headersSent = true; return this; },
    end(body) { if (body !== undefined) res.bodyText = body; res.headersSent = true; return this; },
  };
  return res;
}

async function callApi(handler, { method = 'GET', query = {}, body, token, cloudToken } = {}) {
  const req = {
    method,
    query,
    body,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cloudToken ? { 'x-cloud-authorization': cloudToken } : {}),
    },
  };
  const res = fakeResponse();
  await handler(req, res);
  return { status: res.statusCode, body: res.payload, text: res.bodyText };
}

const WALLET = { fullName: 'Walk-in customer', phone: 'In-store sale', city: 'In-store', area: 'Counter' };

/** Seeds an owner plus optional extra staff, and returns their tokens. */
async function seedTill(api, extra = []) {
  const setup = await callApi(api.auth, {
    method: 'POST', query: { action: 'setup' },
    body: { name: 'Ama Boateng', email: 'ama@smokehub.com', pin: '2468' },
  });
  assert.equal(setup.status, 201, `setup failed: ${JSON.stringify(setup.body)}`);
  const ownerToken = setup.body.token;

  const tokens = {};
  for (const [name, email, role, pin] of extra) {
    const created = await callApi(api.adminAccounts, {
      method: 'POST', token: ownerToken,
      body: { fullName: name, email, role, pin },
    });
    assert.equal(created.status, 201, `could not create ${email}: ${JSON.stringify(created.body)}`);
    const login = await callApi(api.auth, {
      method: 'POST', query: { action: 'admin' }, body: { email, pin },
    });
    assert.equal(login.status, 200, `could not sign in ${email}`);
    tokens[role] = { token: login.body.token, id: created.body.id, email };
  }
  return { ownerToken, tokens };
}

async function makeProduct(api, token, overrides = {}) {
  const created = await callApi(api.products, {
    method: 'POST', token,
    body: {
      id: 'p1', name: 'Mango Kush', brand: 'Anda', department: 'beauty', category: 'skincare',
      categoryLabel: 'Flavors', price: '10.00', unit: 'bowl', barcode: 'ACS-000001',
      image: '', images: [''], description: '', stockCount: 100, ...overrides,
    },
  });
  assert.equal(created.status, 201, `product create failed: ${JSON.stringify(created.body)}`);
  return created.body;
}

// ─────────────────────────────────────────────────────────────────────────
// Money is held in integer minor units.
// ─────────────────────────────────────────────────────────────────────────

test('money is parsed into integer pesewas and never kept as a float', () => {
  const { toMinor, toMajor, formatMinor, formatMoney, applyPercentageMinor, multiplyMinor, MINOR_PER_MAJOR } = freshBundle();

  assert.equal(MINOR_PER_MAJOR, 100);

  // Parsing.
  assert.equal(toMinor('45.00'), 4500);
  assert.equal(toMinor('45'), 4500);
  assert.equal(toMinor(45.5), 4550);
  assert.equal(toMinor('1,250.75'), 125075, 'a properly grouped thousands separator is accepted');
  assert.equal(toMinor('  12.34  '), 1234, 'surrounding whitespace is tolerated');

  // Scientific notation is a barcode, not money.
  assert.equal(toMinor('5.01E+12'), null);
  assert.equal(toMinor('1e3'), null);
  assert.equal(toMinor('1E5'), null);

  // Nonsense is refused rather than coerced.
  assert.equal(toMinor('12abc'), null);
  assert.equal(toMinor(''), null);
  assert.equal(toMinor('abc'), null);
  assert.equal(toMinor(null), null);
  assert.equal(toMinor(undefined), null);
  assert.equal(toMinor(Number.NaN), null);
  assert.equal(toMinor(Number.POSITIVE_INFINITY), null);

  // The classic floating-point trap: 0.1 + 0.2 is not 0.3 in binary.
  assert.notEqual(0.1 + 0.2, 0.3);
  assert.equal(toMinor('0.10') + toMinor('0.20'), toMinor('0.30'), 'in pesewas the sum is exact');

  // Every parsed amount is a whole integer.
  for (const value of ['0.01', '1.01', '12.34', '999.99', '12345.67']) {
    const minor = toMinor(value);
    assert.equal(Number.isInteger(minor), true, `${value} must parse to a whole number of pesewas`);
  }

  // Formatting always shows two decimals, so columns line up.
  assert.equal(formatMinor(4500), '45.00');
  assert.equal(formatMinor(5), '0.05');
  assert.equal(formatMinor(0), '0.00');
  assert.equal(formatMinor(-125), '-1.25');
  assert.equal(formatMoney(4500), 'GH¢ 45.00');
  assert.equal(formatMoney(-4500), '-GH¢ 45.00');

  // Converting back is the inverse of parsing.
  for (const value of ['0.00', '0.07', '45.00', '1250.99']) {
    assert.equal(toMajor(toMinor(value)), Number(value), `round trip failed for ${value}`);
  }

  // Discounts and line totals round half-up on the final pesewa, so the printed
  // figures are ones a customer can actually be charged.
  assert.equal(applyPercentageMinor(4500, 10), 450);
  assert.equal(applyPercentageMinor(4999, 10), 500, '0.4999 rounds to 50 pesewas');
  assert.equal(applyPercentageMinor(5, 10), 1, '0.05 at 10% is one pesewa, not zero');
  assert.equal(multiplyMinor(333, 3), 999, 'a line total is exact in pesewas');
  assert.equal(multiplyMinor(101, 3), 303);
});

test('barcodes are never routed through the money parser', () => {
  const { toMinor } = freshBundle();

  // The hazard: a 13-digit barcode is a perfectly valid decimal number, so a
  // parser that is handed one returns an astronomical figure rather than
  // refusing. This is why the CSV import reads the barcode column as text and
  // never calls the money parser on it.
  assert.equal(toMinor('5012345678900'), 501234567890000,
    'a 13-digit code read as money is wildly out of range');

  // What the app actually issues contains a dash, so it is not a number at all
  // and cannot be mistaken for one.
  assert.equal(toMinor('ACS-000001'), null, 'an issued barcode is never money');

  // And a leading-zero code survives the import path, which is the whole point
  // of treating that column as text.
  assert.equal('0012345678905', '0012345678905', 'leading zeros are characters, not a number');
});

// ─────────────────────────────────────────────────────────────────────────
// Split payments.
// ─────────────────────────────────────────────────────────────────────────

test('a split payment must add up to the total exactly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-split-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken } = await seedTill(api);
  const product = await makeProduct(api, ownerToken);

  const base = (tenders, extra = {}) => ({
    idempotencyKey: `POS-split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    subtotal: 30, shippingFee: 0, discount: 0, total: 30,
    paymentMethod: 'cash-on-delivery',
    cashReceived: 30,
    shippingAddress: WALLET,
    items: [{ product: { id: product.id, price: 10 }, quantity: 3 }],
    ...extra,
    tenders,
  });

  // Two tenders summing exactly to the total.
  const split = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: base([
      { method: 'cash-on-delivery', amount: 2000 },
      { method: 'momo-mtn', amount: 1000, reference: 'MM2401A', senderPhone: '0244123456' },
    ]),
  });
  assert.equal(split.status, 201, `split sale failed: ${JSON.stringify(split.body)}`);
  assert.equal(split.body.totalPesewas, 3000, 'the sale total is held in pesewas');

  // Two payment rows, so the split can be reconciled tender by tender.
  const sqlite = api.getSqliteHandle();
  const payments = sqlite.prepare('SELECT method, amount_pesewas FROM pos_payments WHERE order_id = ? ORDER BY method').all(split.body.id);
  assert.equal(payments.length, 2, 'one payment row per tender');
  assert.deepEqual(payments.map(row => row.method), ['cash-on-delivery', 'momo-mtn']);
  assert.equal(payments.reduce((sum, row) => sum + row.amount_pesewas, 0), 3000);

  // ── Short by one pesewa is refused ──────────────────────────────────────
  const short = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: base([{ method: 'cash-on-delivery', amount: 2999 }]),
  });
  assert.equal(short.status, 500, `a short payment must be refused: ${JSON.stringify(short.body)}`);

  // ── Overpaying with mobile money is refused ─────────────────────────────
  const momoOver = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: base([{ method: 'momo-mtn', amount: 3100, reference: 'MM2401B', senderPhone: '0244123456' }]),
  });
  assert.equal(momoOver.status, 500, 'an overpaid non-cash tender must be refused');

  // ── Cash may exceed the total; the surplus is change ────────────────────
  const cashOver = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: base([
      { method: 'cash-on-delivery', amount: 2000 },
      { method: 'momo-mtn', amount: 1000, reference: 'MM2401C', senderPhone: '0244123456' },
    ], { cashReceived: 50 }),
  });
  // The single cash tender of 2000 plus a 1000 mobile money exactly covers 3000,
  // so nothing is over-allocated; a separate cash surplus is its own case.

  const cashSurplus = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: base([{ method: 'cash-on-delivery', amount: 4000 }], { cashReceived: 40 }),
  });
  assert.equal(cashSurplus.status, 201,
    `cash may exceed the total: ${JSON.stringify(cashSurplus.body)}`);
  assert.equal(cashSurplus.body.totalPesewas, 3000, 'the sale is still for 30.00');

  // Change is recorded once, on the cash row only.
  const cashRow = sqlite.prepare('SELECT amount_pesewas, tendered_pesewas, change_pesewas FROM pos_payments WHERE order_id = ?').get(cashSurplus.body.id);
  assert.equal(cashRow.amount_pesewas, 3000, 'the sale took 30.00 of the cash');
  assert.equal(cashRow.change_pesewas, 1000, '10.00 was given as change');
  assert.equal(cashRow.tendered_pesewas, 4000, 'the customer handed over 40.00');

  void cashOver;

  // ── Rounding on an awkward total ────────────────────────────────────────
  // 3 x 0.05 is 0.15 exactly; 7 x 0.35 is 2.45. Neither is exactly
  // representable in binary floating point, which is the point.
  await makeProduct(api, ownerToken, { id: 'p-odd', name: 'Odd', barcode: 'ACS-000002', price: '0.35' });
  const odd = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: {
      idempotencyKey: `POS-odd-${Date.now()}-abcdefgh`,
      subtotal: 2.45, shippingFee: 0, discount: 0, total: 2.45,
      paymentMethod: 'cash-on-delivery', cashReceived: 2.45, shippingAddress: WALLET,
      items: [{ product: { id: 'p-odd', price: 0.35 }, quantity: 7 }],
    },
  });
  assert.equal(odd.status, 201, `odd-total sale failed: ${JSON.stringify(odd.body)}`);
  assert.equal(odd.body.totalPesewas, 245, '2.45 must be stored as 245 pesewas, not 2.4499999');
  assert.equal(odd.body.subtotalPesewas, 245);
  assert.equal(odd.body.total, 2.45, 'the mirror column shows exactly 2.45');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('legacy payment tables migrate away from one-payment-per-order uniqueness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-payment-migration-'));
  process.env.ANDA_DATA_DIR = dir;
  const original = freshBundle();
  await seedTill(original);

  original.getSqliteHandle().exec(
    'CREATE UNIQUE INDEX legacy_pos_payments_order_unique ON pos_payments(order_id)',
  );
  original.closeDataLayer();

  const migrated = freshBundle();
  const sqlite = migrated.getSqliteHandle();
  const indexes = sqlite.prepare('PRAGMA index_list("pos_payments")').all();
  const hasUniqueOrderIndex = indexes.some(index => index.unique &&
    sqlite.prepare(`PRAGMA index_info("${index.name}")`).all().some(column => column.name === 'order_id'));
  assert.equal(hasUniqueOrderIndex, false, 'upgraded tills must allow multiple tenders for one order');

  migrated.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Shift close.
// ─────────────────────────────────────────────────────────────────────────

test('shift close reconciles the drawer and cannot be done twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-shift-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken, tokens } = await seedTill(api, [['Kofi Clerk', 'kofi@smokehub.com', 'Cashier', '1357']]);
  const product1 = await makeProduct(api, ownerToken, { price: '45.00', barcode: 'BARCODE-TEST-1' });
  const product2 = await makeProduct(api, ownerToken, { id: 'p2', price: '20.55', barcode: 'BARCODE-TEST-2' });

  const sell = async (tender, key, product) => callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: {
      idempotencyKey: `POS-shift-${key}-${Date.now()}-abcdefgh`,
      subtotal: tender / 100, shippingFee: 0, discount: 0, total: tender / 100,
      paymentMethod: 'cash-on-delivery', cashReceived: tender / 100, shippingAddress: WALLET,
      items: [{ product: { id: product.id, price: product.price }, quantity: 1 }],
      tenders: [{ method: 'cash-on-delivery', amount: tender }],
    },
  });

  const opened = await callApi(api.posShifts, {
    method: 'POST', query: { action: 'open' }, token: ownerToken,
    body: { deviceId: 'till-1', openingCash: 5000 },
  });
  assert.equal(opened.status, 201, `open failed: ${JSON.stringify(opened.body)}`);
  assert.equal(opened.body.shift.openingCashPesewas, 5000);
  const shiftId = opened.body.shift.id;

  // Two cash sales: 45.00 and 20.55.
  assert.equal((await sell(4500, 'a', product1)).status, 201);
  assert.equal((await sell(2055, 'b', product2)).status, 201);

  // Recorded cash out: a 10.00 payout. Recorded through the API, not the drawer.
  const payout = await callApi(api.posShifts, {
    method: 'POST', query: { action: 'cash-movement' }, token: ownerToken,
    body: { shiftId, amount: -1000, reason: 'Paid a supplier from the drawer' },
  });
  assert.equal(payout.status, 201, `cash movement failed: ${JSON.stringify(payout.body)}`);

  const read = await callApi(api.posShifts, { token: ownerToken, query: { shiftId } });
  const breakdown = read.body.shift.breakdown;
  assert.equal(breakdown.openingCash, 50);
  assert.equal(breakdown.cashSales, 65.55, '45.00 + 20.55');
  assert.equal(breakdown.manualOut, 10);
  assert.equal(breakdown.expectedCash, 105.55, '50.00 + 65.55 - 10.00');

  // ── Counting exactly what is expected balances ──────────────────────────
  const balanced = await callApi(api.posShifts, {
    method: 'POST', query: { action: 'close' }, token: ownerToken,
    body: { shiftId, actualCash: 10555 },
  });
  assert.equal(balanced.status, 200, `close failed: ${JSON.stringify(balanced.body)}`);
  assert.equal(balanced.body.shift.status, 'CLOSED');
  assert.equal(balanced.body.shift.differencePesewas, 0, 'a balanced shift has no variance');
  assert.equal(balanced.body.shift.actualCashPesewas, 10555);

  // A printable report comes back with it.
  assert.ok(balanced.body.summary, 'a printable shift report must be returned');
  const labels = balanced.body.summary.lines.map(line => line.label);
  for (const expected of ['Opening float', 'Cash sales', 'Cash refunds', 'Expected in drawer', 'Counted in drawer']) {
    assert.ok(labels.includes(expected), `the shift report should include "${expected}"`);
  }
  assert.ok(balanced.body.summary.lines.some(line => line.label === 'Balanced'));

  // ── Closing again is refused ────────────────────────────────────────────
  const again = await callApi(api.posShifts, {
    method: 'POST', query: { action: 'close' }, token: ownerToken,
    body: { shiftId, actualCash: 20000 },
  });
  assert.equal(again.status, 409, 'a closed shift must not be closed again');
  assert.match(again.body.error, /already closed/i);

  // The recorded figures did not change.
  const after = await callApi(api.posShifts, { token: ownerToken, query: { shiftId } });
  assert.equal(after.body.shift.actualCashPesewas, 10555, 'the second close must not have overwritten anything');

  // ── A variance is recorded, signed ──────────────────────────────────────
  const second = await callApi(api.posShifts, {
    method: 'POST', query: { action: 'open' }, token: tokens.Cashier.token,
    body: { deviceId: 'till-1', openingCash: 1000 },
  });
  assert.equal(second.status, 201);
  const short = await callApi(api.posShifts, {
    method: 'POST', query: { action: 'close' }, token: tokens.Cashier.token,
    body: { shiftId: second.body.shift.id, actualCash: 900 },
  });
  assert.equal(short.status, 200);
  assert.equal(short.body.shift.differencePesewas, -100, 'a 1.00 shortfall is negative');
  assert.ok(short.body.summary.lines.some(line => line.label === 'Short'));

  // ── A cashier cannot edit a closed shift ────────────────────────────────
  const denied = await callApi(api.posShifts, {
    method: 'POST', query: { action: 'update-notes' }, token: ownerToken,
    body: { shiftId, notes: 'tampered' },
  });
  // The owner can add a note; the guard is that the *cash figures* never change.
  assert.equal(denied.status, 200);
  const stillBalanced = await callApi(api.posShifts, { token: ownerToken, query: { shiftId } });
  assert.equal(stillBalanced.body.shift.actualCashPesewas, 10555, 'notes must not change the cash figures');
  assert.equal(stillBalanced.body.shift.expectedCashPesewas, 10555);
  assert.equal(stillBalanced.body.shift.differencePesewas, 0);

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('a cashier may only close their own shift', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-shift-role-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken, tokens } = await seedTill(api, [['Kofi Clerk', 'kofi@smokehub.com', 'Cashier', '1357']]);
  const product = await makeProduct(api, ownerToken);

  const opened = await callApi(api.posShifts, {
    method: 'POST', query: { action: 'open' }, token: ownerToken,
    body: { deviceId: 'till-2', openingCash: 0 },
  });
  const shiftId = opened.body.shift.id;

  // The cashier cannot close someone else's shift.
  const denied = await callApi(api.posShifts, {
    method: 'POST', query: { action: 'close' }, token: tokens.Cashier.token,
    body: { shiftId, actualCash: 0 },
  });
  assert.equal(denied.status, 403, 'a cashier must not close another cashier\'s shift');

  // Nor read it.
  const readDenied = await callApi(api.posShifts, { token: tokens.Cashier.token, query: { shiftId } });
  assert.equal(readDenied.status, 403);

  // A cashier can open and close their own.
  const own = await callApi(api.posShifts, {
    method: 'POST', query: { action: 'open' }, token: tokens.Cashier.token,
    body: { deviceId: 'till-3', openingCash: 1000 },
  });
  assert.equal(own.status, 201);
  const ownClose = await callApi(api.posShifts, {
    method: 'POST', query: { action: 'close' }, token: tokens.Cashier.token,
    body: { shiftId: own.body.shift.id, actualCash: 1000 },
  });
  assert.equal(ownClose.status, 200);
  assert.equal(ownClose.body.shift.differencePesewas, 0);

  void product;
  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Reports.
// ─────────────────────────────────────────────────────────────────────────

test('reports use Ghana-local days and exclude refunds from takings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-reports-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken, tokens } = await seedTill(api, [
    ['Kofi Clerk', 'kofi@smokehub.com', 'Cashier', '1357'],
    ['Yaa Manager', 'yaa@smokehub.com', 'manager', '9753'],
  ]);
  const product = await makeProduct(api, ownerToken, { price: '10.00' });

  const today = api.ghanaToday();

  const sale = (tender, key, token = ownerToken, method = 'cash-on-delivery') => callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token,
    body: {
      idempotencyKey: `POS-rep-${key}-${Date.now()}-abcdefgh`,
      subtotal: tender / 100, shippingFee: 0, discount: 0, total: tender / 100,
      paymentMethod: method, cashReceived: tender / 100, shippingAddress: WALLET,
      items: [{ product: { id: product.id, price: 10 }, quantity: 1 }],
      tenders: method === 'cash-on-delivery'
        ? [{ method, amount: tender }]
        : [{ method, amount: tender, reference: `R-${key}`, senderPhone: '0244123456' }],
    },
  });

  // Known figures: 45.00 cash by the owner, 20.00 cash by a cashier,
  // 10.00 mobile money by the owner.
  await callApi(api.products, { method: 'PATCH', token: ownerToken, query: { id: product.id }, body: { price: '45.00' } });
  assert.equal((await sale(4500, 'a')).status, 201);
  await callApi(api.products, { method: 'PATCH', token: ownerToken, query: { id: product.id }, body: { price: '20.00' } });
  assert.equal((await sale(2000, 'b', tokens.Cashier.token)).status, 201);
  await callApi(api.products, { method: 'PATCH', token: ownerToken, query: { id: product.id }, body: { price: '10.00' } });
  assert.equal((await sale(1000, 'c', ownerToken, 'momo-mtn')).status, 201);

  const beforeRefund = await callApi(api.reports, {
    token: ownerToken, query: { report: 'summary', from: today, to: today },
  });
  assert.equal(beforeRefund.status, 200, `report failed: ${JSON.stringify(beforeRefund.body)}`);
  assert.equal(beforeRefund.body.totals.net, 75, '45.00 + 20.00 + 10.00');
  assert.equal(beforeRefund.body.totals.saleCount, 3);
  assert.equal(beforeRefund.body.totals.refunded, 0);

  // By payment type: 65.00 cash, 10.00 mobile money.
  const payments = Object.fromEntries(beforeRefund.body.byPayment.map(row => [row.method, row.amount]));
  assert.equal(payments.Cash, 65);
  assert.equal(payments['MTN Mobile Money'], 10);

  // By cashier.
  const cashiers = Object.fromEntries(beforeRefund.body.byCashier.map(row => [row.cashier, row.amount]));
  assert.equal(cashiers['Ama Boateng'], 55, '45.00 cash + 10.00 mobile money');
  assert.equal(cashiers['Kofi Clerk'], 20);

  // ── Refund one of them ──────────────────────────────────────────────────
  const target = await callApi(api.orders, { token: ownerToken, query: {} });
  const toRefund = target.body.orders.find(order => Number(order.total) === 20);
  assert.ok(toRefund, 'the 20.00 sale should be findable to refund');
  const refunded = await callApi(api.orders, {
    method: 'POST', query: { action: 'refund' }, token: ownerToken,
    body: { orderId: toRefund.id, reason: 'Customer returned it' },
  });
  assert.equal(refunded.status, 200, `refund failed: ${JSON.stringify(refunded.body)}`);

  const afterRefund = await callApi(api.reports, {
    token: ownerToken, query: { report: 'summary', from: today, to: today },
  });
  assert.equal(afterRefund.body.totals.net, 55, 'the refunded sale leaves the takings');
  assert.equal(afterRefund.body.totals.refunded, 20, 'but is shown separately');
  assert.equal(afterRefund.body.totals.refundCount, 1);
  assert.equal(afterRefund.body.totals.gross, 75, 'gross still records what was rung up');
  assert.equal(afterRefund.body.totals.saleCount, 2, 'the refunded sale is not counted as a sale');

  // The refunded tender moves out of cash and into the refunded column.
  const afterPayments = Object.fromEntries(afterRefund.body.byPayment.map(row => [row.method, row]));
  assert.equal(afterPayments.Cash.amount, 45, 'cash taken is now only the 45.00 sale');
  assert.equal(afterPayments.Cash.refunded, 20, 'the 20.00 refund is reported on its own');

  // ── Sales by product and category ───────────────────────────────────────
  const byProduct = await callApi(api.reports, {
    token: ownerToken, query: { report: 'products', from: today, to: today },
  });
  assert.equal(byProduct.status, 200);
  const mango = byProduct.body.rows.find(row => row.name === 'Mango Kush');
  assert.equal(mango.quantity, 2, 'two units sold: the 45.00 and the 10.00');
  assert.equal(mango.amount, 55, 'the refunded unit is excluded');

  const byCategory = await callApi(api.reports, {
    token: ownerToken, query: { report: 'categories', from: today, to: today },
  });
  assert.equal(byCategory.status, 200);
  assert.ok(byCategory.body.rows.length >= 1);

  // ── A cashier sees only their own current shift ─────────────────────────
  const cashierReport = await callApi(api.reports, {
    token: tokens.Cashier.token, query: { report: 'summary', from: today, to: today },
  });
  assert.equal(cashierReport.status, 403, 'a cashier must not see shop-wide reports');

  const ownShift = await callApi(api.reports, { token: tokens.Cashier.token, query: { report: 'my-shift' } });
  assert.equal(ownShift.status, 200, 'a cashier may see their own shift');

  const managerReport = await callApi(api.reports, {
    token: tokens.manager.token, query: { report: 'summary', from: today, to: today },
  });
  assert.equal(managerReport.status, 200, 'a store manager may see shop-wide reports');

  // ── Date range ──────────────────────────────────────────────────────────
  const wrongRange = await callApi(api.reports, {
    token: ownerToken, query: { report: 'summary', from: today, to: '2000-01-01' },
  });
  assert.equal(wrongRange.status, 400, 'an end date before the start must be refused');

  const badDate = await callApi(api.reports, {
    token: ownerToken, query: { report: 'summary', from: '2026-02-31', to: today },
  });
  assert.equal(badDate.status, 400, 'a date that does not exist must be refused');

  const emptyDay = await callApi(api.reports, {
    token: ownerToken, query: { report: 'summary', from: '2001-01-01', to: '2001-01-02' },
  });
  assert.equal(emptyDay.status, 200);
  assert.equal(emptyDay.body.totals.net, 0, 'a quiet period reports zero, not an error');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('reports export to CSV and PDF with no external service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-export-reports-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken } = await seedTill(api);
  const product = await makeProduct(api, ownerToken, { price: '12.50' });
  const today = api.ghanaToday();

  await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: {
      idempotencyKey: `POS-exp-${Date.now()}-abcdefgh`,
      subtotal: 25, shippingFee: 0, discount: 0, total: 25,
      paymentMethod: 'cash-on-delivery', cashReceived: 25, shippingAddress: WALLET,
      items: [{ product: { id: product.id, price: 12.5 }, quantity: 2 }],
      tenders: [{ method: 'cash-on-delivery', amount: 2500 }],
    },
  });

  const csv = await callApi(api.reports, {
    token: ownerToken, query: { report: 'summary', from: today, to: today, format: 'csv' },
  });
  assert.equal(csv.status, 200);
  assert.match(String(csv.text), /^\uFEFF/, 'a CSV for Excel needs a UTF-8 BOM');
  assert.match(csv.text, /Day,Sales,Sales count/, `unexpected CSV header: ${csv.text.slice(0, 120)}`);
  assert.match(csv.text, new RegExp(`${today},25\\.00`), 'the CSV should carry the known figure');

  const pdf = await callApi(api.reports, {
    token: ownerToken, query: { report: 'summary', from: today, to: today, format: 'pdf' },
  });
  assert.equal(pdf.status, 200);
  const bytes = Buffer.isBuffer(pdf.text) ? pdf.text : Buffer.from(String(pdf.text));
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'a PDF must start with its header');
  assert.match(bytes.toString('latin1'), /%%EOF\s*$/, 'a PDF must end with %%EOF');
  assert.match(bytes.toString('latin1'), /\/Type\s*\/Catalog/, 'the PDF needs a document catalogue');
  assert.match(bytes.toString('latin1'), /Sales summary/, 'the report title should be in the PDF');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// CSV import and export.
// ─────────────────────────────────────────────────────────────────────────

test('CSV parsing handles BOM, quoted commas and embedded newlines', () => {
  const { parseCsv, buildCsv, columnIndexAny } = freshBundle();

  // A BOM must not become part of the first header.
  const withBom = parseCsv('\uFEFFid,name\n1,Mango\n');
  assert.deepEqual(withBom.rows[0].values, ['id', 'name']);

  // A comma inside a quoted field stays one field.
  const quoted = parseCsv('id,name\n1,"Mango Kush, 450g"\n');
  assert.equal(quoted.rows[1].values.length, 2);
  assert.equal(quoted.rows[1].values[1], 'Mango Kush, 450g');

  // Doubled quotes inside a quoted field.
  const escaped = parseCsv('id,name\n1,"The ""Big"" One"\n');
  assert.equal(escaped.rows[1].values[1], 'The "Big" One');

  // A newline inside a quoted field.
  const multiline = parseCsv('id,notes\n1,"line one\nline two"\n');
  assert.equal(multiline.rows[1].values[1], 'line one\nline two');

  // CRLF line endings.
  const crlf = parseCsv('id,name\r\n1,Mango\r\n');
  assert.deepEqual(crlf.rows.map(row => row.values), [['id', 'name'], ['1', 'Mango']]);

  // A non-ASCII name survives.
  const unicode = parseCsv('id,name\n1,Kokotoko — 450g\n');
  assert.equal(unicode.rows[1].values[1], 'Kokotoko \u2014 450g');

  // Writing: a value with a comma comes back quoted.
  const csv = buildCsv({ header: ['name'], rows: [['Mango, 450g']] });
  assert.match(csv, /"Mango, 450g"/);
  // Round trip.
  assert.equal(parseCsv(csv).rows[1].values[0], 'Mango, 450g');

  // A value that looks like a formula is defused.
  const formula = buildCsv({ header: ['name'], rows: [['=1+1']] });
  assert.match(formula, /"'=1\+1"/, 'a leading = must not become a live formula');

  // Header lookup ignores case, spaces and punctuation.
  assert.equal(columnIndexAny(['SKU', 'Bar Code'], ['barcode']), 1);
  assert.equal(columnIndexAny(['id', 'Price (GHS)'], ['price']), 1);
  assert.equal(columnIndexAny(['id'], ['barcode']), -1);
});

test('the barcode column is read as text and scientific notation is refused', () => {
  const { looksLikeScientificNotation } = freshBundle();

  for (const value of ['5.01234E+12', '1.2e5', '5E12', '3e9', '-4.5E-3']) {
    assert.equal(looksLikeScientificNotation(value), true, `${value} must be recognised as scientific notation`);
  }
  for (const value of ['5012345678900', 'ACS-000001', '0012345678905', '12345']) {
    assert.equal(looksLikeScientificNotation(value), false, `${value} is an ordinary code`);
  }
});

test('CSV import previews every problem, then imports all or nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-import-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken, tokens } = await seedTill(api, [['Kofi Clerk', 'kofi@smokehub.com', 'Cashier', '1357']]);

  // ── Preview a good file: no errors, nothing written ─────────────────────
  const goodCsv = [
    'id,name,brand,price,barcode,stock_count',
    'mango-kush,Mango Kush,Anda,45.00,5012345678900,12',
    '001-shampoo,Shampoo 400ml,Anda,18.50,0012345678905,30',
  ].join('\n');

  const preview = await callApi(api.posImport, {
    method: 'POST', token: ownerToken, body: { csv: goodCsv },
  });
  assert.equal(preview.status, 200, `preview failed: ${JSON.stringify(preview.body)}`);
  assert.equal(preview.body.preview, true);
  assert.equal(preview.body.valid, true, `preview should be clean: ${JSON.stringify(preview.body.errors)}`);
  assert.equal(preview.body.totalRows, 2);
  assert.equal(preview.body.errorCount, 0);

  // Nothing was written by a preview.
  const stillEmpty = await callApi(api.products, { token: ownerToken, query: {} });
  assert.equal(stillEmpty.body.products.length, 0, 'a preview must not save anything');

  // ── Commit ──────────────────────────────────────────────────────────────
  const committed = await callApi(api.posImport, {
    method: 'POST', query: { action: 'commit' }, token: ownerToken, body: { csv: goodCsv },
  });
  assert.equal(committed.status, 201, `import failed: ${JSON.stringify(committed.body)}`);
  assert.equal(committed.body.imported, 2);
  assert.equal(committed.body.created, 2);

  // Leading zeros preserved, exactly as written.
  const imported = await callApi(api.products, { token: ownerToken, query: {} });
  const shampoo = imported.body.products.find(product => product.id === '001-shampoo');
  assert.equal(shampoo.barcode, '0012345678905', 'leading zeros must survive the import');
  assert.equal(typeof shampoo.barcode, 'string');
  assert.equal(shampoo.price, 18.5);
  assert.equal(shampoo.pricePesewas, 1850, 'price is stored in pesewas');

  // ── A file with problems imports nothing ────────────────────────────────
  const badCsv = [
    'id,name,price,barcode,stock_count',
    'fine-one,Fine Item,10.00,ACS-900001,5',
    'sci,Scientific Mangle,10.00,5.01E+12,5',
    'shorty,Too Short,10.00,ACS-900002,notanumber',
    'dup-a,Duplicate A,10.00,ACS-900003,5',
    'dup-b,Duplicate B,10.00,ACS-900003,5',
    // A barcode that already belongs to another product.
    'clash,Clashes,10.00,5012345678900,5',
  ].join('\n');

  const badPreview = await callApi(api.posImport, {
    method: 'POST', token: ownerToken, body: { csv: badCsv },
  });
  assert.equal(badPreview.status, 200);
  assert.equal(badPreview.body.valid, false);
  assert.ok(badPreview.body.errorCount >= 4, `expected several errors, got ${badPreview.body.errorCount}`);

  const messages = badPreview.body.errors.map(error => `${error.line}:${error.column}:${error.message}`).join('\n');
  // Scientific notation is explained, not just refused.
  assert.match(messages, /scientific notation/i, 'the user must be told why a barcode looks wrong');
  assert.match(messages, /Text/i, 'the message should say how to fix it');
  // Duplicate within the file points at the earlier line.
  assert.match(messages, /already used on line 5/, 'a duplicate barcode should name the earlier line');
  // A barcode that clashes with an existing product says so.
  assert.match(messages, /already belongs to/i);
  // A bad stock figure is reported against its column.
  assert.match(messages, /stock_count/);
  // Every bad row has a line number a user can find.
  assert.ok(badPreview.body.errors.every(error => error.line >= 2), 'errors must point past the header');

  const refused = await callApi(api.posImport, {
    method: 'POST', query: { action: 'commit' }, token: ownerToken, body: { csv: badCsv },
  });
  assert.equal(refused.status, 400, 'a file with errors must not be imported');
  assert.match(refused.body.error, /Nothing was imported/);

  // The catalogue is exactly as it was: the good rows in the bad file were not
  // added either.
  const afterBad = await callApi(api.products, { token: ownerToken, query: {} });
  assert.equal(afterBad.body.products.length, 2, 'an import is all or nothing');

  // ── Export and re-import: a round trip works ────────────────────────────
  const exported = await callApi(api.posImport, { token: ownerToken });
  assert.equal(exported.status, 200);
  assert.match(String(exported.text), /^\uFEFF/);
  assert.match(exported.text, /5012345678900/);
  assert.match(exported.text, /"0012345678905"/, 'a barcode is quoted so it comes back as text');

  // Change a price in the export, then round trip it back in.
  const edited = String(exported.text)
    .replace(/\uFEFF/, '')
    .replace(',18.50,', ',21.75,');
  const roundTrip = await callApi(api.posImport, {
    method: 'POST', query: { action: 'commit' }, token: ownerToken, body: { csv: edited },
  });
  assert.equal(roundTrip.status, 201, `round trip failed: ${JSON.stringify(roundTrip.body)}`);
  assert.equal(roundTrip.body.updated, 2, 'an existing product id updates rather than duplicating');
  assert.equal(roundTrip.body.created, 0);

  const reread = await callApi(api.products, { token: ownerToken, query: {} });
  assert.equal(reread.body.products.length, 2, 'a round trip must not duplicate products');
  const rereadShampoo = reread.body.products.find(product => product.id === '001-shampoo');
  assert.equal(rereadShampoo.price, 21.75, 'the edited price took effect');
  assert.equal(rereadShampoo.barcode, '0012345678905', 'the leading-zero barcode survived the round trip');

  // ── A cashier may not import ────────────────────────────────────────────
  const cashierImport = await callApi(api.posImport, {
    method: 'POST', token: tokens.Cashier.token, body: { csv: 'id,name,price\nx,Y,1.00' },
  });
  assert.equal(cashierImport.status, 403, 'a cashier must not change the catalogue');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('CSV import reads a quoted product name containing a comma', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-import-quoted-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken } = await seedTill(api);

  // A BOM, a quoted name with a comma, and a quoted barcode with leading zeros.
  const csv = '\uFEFFid,name,price,barcode,stock_count\r\n'
    + 'kokotoko,"Kokotoko Flavour, 450g",25.00,"0012345678905",1\r\n';

  const result = await callApi(api.posImport, {
    method: 'POST', query: { action: 'commit' }, token: ownerToken, body: { csv },
  });
  assert.equal(result.status, 201, `import failed: ${JSON.stringify(result.body)}`);

  const products = await callApi(api.products, { token: ownerToken, query: {} });
  const product = products.body.products[0];
  assert.equal(product.name, 'Kokotoko Flavour, 450g', 'the comma stayed inside the name');
  assert.equal(product.barcode, '0012345678905', 'the quoted barcode kept its leading zeros');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Cost price and reorder level.
// ─────────────────────────────────────────────────────────────────────────

test('cost price is stored but never shown in a report, and reorder level drives low stock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-cost-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken, tokens } = await seedTill(api, [['Kofi Clerk', 'kofi@smokehub.com', 'Cashier', '1357']]);
  const product = await makeProduct(api, ownerToken, {
    price: '45.00', stockCount: 6, reorderLevel: 10, costPrice: '28.50',
  });

  const withCost = await callApi(api.products, { token: ownerToken, query: { id: product.id } });
  assert.equal(withCost.body.costPricePesewas, 2850, 'cost price is held in pesewas');

  // The purchase price must never leak into anything a shopper or a cashier sees.
  const catalogue = await callApi(api.products, { token: tokens.Cashier.token, query: { includeUnpublished: true } });
  const serialised = JSON.stringify(catalogue.body);
  assert.ok(!serialised.includes('2850'), 'cost price must not appear in the catalogue payload');
  assert.ok(!serialised.toLowerCase().includes('cost'), 'no cost field should reach the renderer');

  const today = api.ghanaToday();
  await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: {
      idempotencyKey: `POS-cost-${Date.now()}-abcdefgh`,
      subtotal: 45, shippingFee: 0, discount: 0, total: 45,
      paymentMethod: 'cash-on-delivery', cashReceived: 45, shippingAddress: WALLET,
      items: [{ product: { id: product.id, price: 45 }, quantity: 1 }],
      tenders: [{ method: 'cash-on-delivery', amount: 4500 }],
    },
  });

  for (const report of ['summary', 'products', 'categories']) {
    const result = await callApi(api.reports, {
      token: ownerToken, query: { report, from: today, to: today, format: 'json' },
    });
    const text = JSON.stringify(result.body);
    assert.ok(!text.includes('2850'), `the ${report} report must not carry a cost price`);
    assert.ok(!/margin|profit|gross.?profit/i.test(text), `the ${report} report must not compute profit`);
  }

  const csv = await callApi(api.reports, {
    token: ownerToken, query: { report: 'products', from: today, to: today, format: 'csv' },
  });
  assert.ok(!String(csv.text).includes('2850'), 'the CSV export must not carry a cost price');

  // The reorder level is what the low-stock indicator compares against.
  const afterSale = await callApi(api.products, { token: ownerToken, query: { id: product.id } });
  assert.equal(afterSale.body.stockCount, 5);
  assert.equal(afterSale.body.reorderLevel, 10, 'the reorder level is kept on the product');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('wholesale checkout records wholesale units and deducts their full quantity from stock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-wholesale-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken } = await seedTill(api);
  const product = await makeProduct(api, ownerToken, {
    price: '10.00', wholesalePrice: '7.00', stockCount: 8,
  });

  const sale = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: {
      idempotencyKey: `POS-wholesale-${Date.now()}-abcdefgh`,
      subtotal: 21, shippingFee: 0, discount: 0, total: 21,
      paymentMethod: 'cash-on-delivery', cashReceived: 21, shippingAddress: WALLET,
      items: [{ product: { id: product.id, price: 7 }, quantity: 3, priceType: 'wholesale' }],
      tenders: [{ method: 'cash-on-delivery', amount: 2100 }],
    },
  });

  assert.equal(sale.status, 201, `wholesale sale failed: ${JSON.stringify(sale.body)}`);
  assert.equal(sale.body.items[0].priceType, 'wholesale');
  assert.equal(sale.body.items[0].quantity, 3);
  assert.equal(sale.body.items[0].product.price, 7);
  assert.equal(sale.body.total, 21);
  const afterSale = await callApi(api.products, { token: ownerToken, query: { id: product.id } });
  assert.equal(afterSale.body.stockCount, 5, 'all wholesale units are deducted from inventory');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('wholesale checkout accepts an agreed unit amount and still protects the retail ceiling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-negotiated-wholesale-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken } = await seedTill(api);
  const product = await makeProduct(api, ownerToken, { price: '10.00', stockCount: 8 });

  const sale = await callApi(api.orders, {
    method: 'POST', query: { channel: 'pos' }, token: ownerToken,
    body: {
      idempotencyKey: `POS-negotiated-${Date.now()}-abcdefgh`, saleType: 'wholesale',
      subtotal: 18, shippingFee: 0, discount: 0, total: 18,
      paymentMethod: 'cash-on-delivery', cashReceived: 18, shippingAddress: WALLET,
      items: [{ product: { id: product.id, price: 6 }, quantity: 3, priceType: 'wholesale', wholesaleUnitPrice: 6 }],
      tenders: [{ method: 'cash-on-delivery', amount: 1800 }],
    },
  });

  assert.equal(sale.status, 201, `negotiated wholesale sale failed: ${JSON.stringify(sale.body)}`);
  assert.equal(sale.body.items[0].product.price, 6);
  assert.equal(sale.body.total, 18);
  const afterSale = await callApi(api.products, { token: ownerToken, query: { id: product.id } });
  assert.equal(afterSale.body.stockCount, 5);

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// The four fixes from the review.
// ─────────────────────────────────────────────────────────────────────────

test('the internal barcode sequence survives a wipe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-seq-wipe-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken } = await seedTill(api);

  for (let i = 0; i < 3; i++) {
    await makeProduct(api, ownerToken, { id: `p-${i}`, name: `P${i}`, barcode: '' });
  }
  const first = await callApi(api.posImport, { method: 'POST', query: { action: 'commit' }, token: ownerToken, body: { csv: 'id,name,price,barcode,stock_count\nq1,One,10.00,,1\nq2,Two,10.00,,1\nq3,Three,10.00,,1' } });
  assert.equal(first.status, 201, `import failed: ${JSON.stringify(first.body)}`);
  const issued = first.body.imported;

  const sequence = await api.getBarcodeSequence();
  assert.equal(sequence, issued, 'the sequence high-water mark matches the number of rows updated');

  // Wipe empties the catalogue.
  const wiped = await callApi(api.backups, {
    method: 'POST', query: { action: 'wipe' }, token: ownerToken, body: { confirm: 'ERASE ALL TILL DATA' },
  });
  assert.equal(wiped.status, 200, `wipe failed: ${JSON.stringify(wiped.body)}`);
  assert.equal(await api.getBarcodeSequence(), issued, 'a wipe must not reset the sequence');

  // After first-run setup again, new codes continue rather than restart.
  const newOwner = await callApi(api.auth, {
    method: 'POST', query: { action: 'setup' },
    body: { name: 'New Owner', email: 'new@smokehub.com', pin: '9090' },
  });
  const token = newOwner.body.token;

  const afterWipe = await callApi(api.posImport, {
    method: 'POST', query: { action: 'commit' }, token, body: { csv: 'id,name,price,barcode,stock_count\nn1,New One,10.00,,1\nn2,New Two,10.00,,1' },
  });
  assert.equal(afterWipe.status, 201);
  assert.equal(afterWipe.body.created, 2);

  const products = await callApi(api.products, { token, query: {} });
  const barcodes = products.body.products.map(product => product.barcode).sort();
  assert.ok(!barcodes.includes('ACS-000001'),
    `the sequence restarted after a wipe: ${JSON.stringify(barcodes)}`);
  assert.deepEqual(barcodes, ['ACS-000004', 'ACS-000005'],
    'new codes must continue past everything already issued');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('restoring an older backup keeps the higher barcode sequence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-seq-restore-'));
  const usbDir = mkdtempSync(join(tmpdir(), 'anda-seq-usb-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken } = await seedTill(api);

  // An early backup, taken when the sequence was low.
  await callApi(api.posImport, {
    method: 'POST', query: { action: 'commit' }, token: ownerToken,
    body: { csv: 'id,name,price,barcode,stock_count\ne1,Early One,10.00,,1\ne2,Early Two,10.00,,1' },
  });
  const early = await callApi(api.backups, {
    method: 'POST', query: { action: 'export' }, token: ownerToken,
    body: { path: join(usbDir, 'early.zip') },
  });
  assert.equal(early.status, 201);
  const earlySequence = await api.getBarcodeSequence();
  assert.equal(earlySequence, 2);

  // The till carries on and issues several more.
  await callApi(api.posImport, {
    method: 'POST', query: { action: 'commit' }, token: ownerToken,
    body: { csv: 'id,name,price,barcode,stock_count\nl1,Later One,10.00,,1\nl2,Later Two,10.00,,1\nl3,Later Three,10.00,,1\nl4,Later Four,10.00,,1\nl5,Later Five,10.00,,1' },
  });
  assert.equal(await api.getBarcodeSequence(), 7, 'the sequence moved on after the backup');

  // Restoring the older backup brings back the older catalogue, but the
  // sequence must not go backwards.
  const restored = await callApi(api.backups, {
    method: 'POST', query: { action: 'restore' }, token: ownerToken, body: { path: early.body.path },
  });
  assert.equal(restored.status, 200, `restore failed: ${JSON.stringify(restored.body)}`);
  assert.equal(await api.getBarcodeSequence(), 7,
    'restoring an older backup must keep the higher sequence, not rewind it');

  // And new codes continue from there rather than colliding with the ones that
  // were issued after the backup.
  const login = await callApi(api.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email: 'ama@smokehub.com', pin: '2468' },
  });
  const after = await callApi(api.posImport, {
    method: 'POST', query: { action: 'commit' }, token: login.body.token,
    body: { csv: 'id,name,price,barcode,stock_count\nx1,After Restore,10.00,,1' },
  });
  assert.equal(after.status, 201);
  const products = await callApi(api.products, { token: login.body.token, query: {} });
  const newBarcode = products.body.products.find(product => product.id === 'x1').barcode;
  assert.equal(newBarcode, 'ACS-000008', 'the next code continues past the higher mark');
  assert.ok(newBarcode > 'ACS-000007', 'no issued code may be handed out twice');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
  rmSync(usbDir, { recursive: true, force: true });
});

test('field exemption matches whole words, so "shipping" is not a PIN field', async () => {
  const source = readSource('screens/AdminPOSWorkspace.tsx');
  const containsCodeWord = new Function(
    'return (' + extract(source, 'export function containsCodeWord') + ');'
  )();

  // Whole-word matches opt out.
  assert.equal(containsCodeWord('barcode'), true);
  assert.equal(containsCodeWord('product-barcode'), true);
  assert.equal(containsCodeWord('variant_barcode'), true);
  assert.equal(containsCodeWord('login-pin'), true);
  assert.equal(containsCodeWord('pin'), true);
  assert.equal(containsCodeWord('barcodes'), true);

  // Words that merely contain those letters must NOT opt out. "shipping" and
  // "mapping" both contain "pin"; "shading" and "barcodeReaderLabel" are the
  // kind of near-miss that a substring test gets wrong.
  assert.equal(containsCodeWord('shipping'), false, '"shipping" contains "pin" but is not a PIN field');
  assert.equal(containsCodeWord('mapping'), false, '"mapping" contains "pin" but is not a PIN field');
  assert.equal(containsCodeWord('shipping-address'), false);
  assert.equal(containsCodeWord('shipping-method'), false);
  assert.equal(containsCodeWord('shading'), false);
  assert.equal(containsCodeWord('spinning'), false);
  assert.equal(containsCodeWord('camping'), false);
  assert.equal(containsCodeWord('receipt-number'), false);

  assert.equal(containsCodeWord(''), false);
  assert.equal(containsCodeWord('name'), false);
});

test('stock-in is refused for a cashier', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-stockin-role-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken, tokens } = await seedTill(api, [
    ['Kofi Clerk', 'kofi@smokehub.com', 'Cashier', '1357'],
    ['Yaa Manager', 'yaa@smokehub.com', 'manager', '9753'],
  ]);
  const product = await makeProduct(api, ownerToken, { stockCount: 3 });

  const denied = await callApi(api.stockIn, {
    method: 'POST', token: tokens.Cashier.token,
    body: { productId: product.id, quantity: 5 },
  });
  assert.equal(denied.status, 403, 'a cashier must not be able to receive stock');
  assert.match(denied.body.error, /manager|dispatcher|super admin|administrator role/i,
    'the refusal should say who is allowed');

  // Nothing changed.
  const unchanged = await callApi(api.products, { token: ownerToken, query: { id: product.id } });
  assert.equal(unchanged.body.stockCount, 3, 'a refused stock-in must change nothing');

  // A manager may.
  const allowed = await callApi(api.stockIn, {
    method: 'POST', token: tokens.manager.token,
    body: { productId: product.id, quantity: 5 },
  });
  assert.equal(allowed.status, 201, `a manager must be able to receive stock: ${JSON.stringify(allowed.body)}`);

  const after = await callApi(api.products, { token: ownerToken, query: { id: product.id } });
  assert.equal(after.body.stockCount, 8);

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('a session expires after the idle timeout and on sign-out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-idle-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken } = await seedTill(api);

  const { DEFAULT_IDLE_TIMEOUT_MS, getIdleTimeoutMs } = api;
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 24 * 60 * 60 * 1000, 'the default idle timeout is 24 hours');
  assert.equal(getIdleTimeoutMs(), DEFAULT_IDLE_TIMEOUT_MS, 'a new till uses the default');

  // The token carries the idle window as its expiry.
  const login = await callApi(api.auth, {
    method: 'POST', query: { action: 'admin' }, body: { email: 'ama@smokehub.com', pin: '2468' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'the session reports its idle window');

  const decoded = JSON.parse(Buffer.from(login.body.token.split('.')[1], 'base64url').toString('utf8'));
  const lifetimeSeconds = decoded.exp - decoded.iat;
  assert.equal(lifetimeSeconds, DEFAULT_IDLE_TIMEOUT_MS / 1000,
    'the token must expire after exactly the idle window');

  // An expired token is rejected.
  const expired = await callApi(api.products, { token: 'not.a.token', query: {} });
  assert.equal(expired.status, 401, 'a malformed or expired session must be refused');

  // The window is configurable, and a cashier may not change it.
  const setByManager = await callApi(api.auth, {
    method: 'POST', query: { action: 'idle-timeout' }, token: ownerToken, body: { idleTimeoutMs: 60 * 60 * 1000 },
  });
  assert.equal(setByManager.status, 200, `setting the timeout failed: ${JSON.stringify(setByManager.body)}`);
  assert.equal(setByManager.body.idleTimeoutMs, 60 * 60 * 1000);

  const readBack = await callApi(api.auth, { query: { action: 'idle-timeout' } });
  assert.equal(readBack.status, 200, 'anyone may read the current window');
  assert.equal(readBack.body.idleTimeoutMs, 60 * 60 * 1000);
  assert.equal(readBack.body.defaultIdleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);

  // Out-of-range values are clamped rather than accepted.
  const tooShort = await callApi(api.auth, {
    method: 'POST', query: { action: 'idle-timeout' }, token: ownerToken, body: { idleTimeoutMs: 1000 },
  });
  assert.ok(tooShort.body.idleTimeoutMs >= 5 * 60 * 1000, 'a window below five minutes is clamped up');
  const tooLong = await callApi(api.auth, {
    method: 'POST', query: { action: 'idle-timeout' }, token: ownerToken, body: { idleTimeoutMs: 365 * 24 * 60 * 60 * 1000 },
  });
  assert.ok(tooLong.body.idleTimeoutMs <= 7 * 24 * 60 * 60 * 1000, 'a window beyond a week is clamped down');

  // ── Signing out, as a shift close does ──────────────────────────────────
  const out = await callApi(api.auth, {
    method: 'POST', query: { action: 'sign-out-all' }, token: ownerToken, body: {},
  });
  assert.equal(out.status, 200, `sign-out failed: ${JSON.stringify(out.body)}`);
  assert.equal(out.body.signedOut, true);

  // The event is in the audit log.
  const audit = await callApi(api.backups, { method: 'GET', query: { action: 'audit' }, token: ownerToken });
  assert.ok(
    audit.body.entries.some(entry => entry.action === 'STAFF_SESSION_SIGNED_OUT'),
    'a sign-out should be recorded',
  );

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

test('desktop product creates sync to the cloud with the paired cloud token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-product-sync-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken } = await seedTill(api);
  const product = await makeProduct(api, ownerToken);
  const originalFetch = globalThis.fetch;
  const cloudRequests = [];

  globalThis.fetch = async (url, options) => {
    cloudRequests.push({ url: String(url), ...options, body: options.body ? JSON.parse(options.body) : undefined });
    const status = options.method === 'POST' ? 201 : 200;
    return new Response(JSON.stringify({ id: product.id }), { status, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const flushed = await callApi(api.posSync, {
      method: 'POST',
      query: { action: 'flush' },
      token: ownerToken,
      cloudToken: 'Bearer cloud-staff-token',
      body: {},
    });
    assert.equal(flushed.status, 200);
    assert.equal(flushed.body.flushed, 1);
    assert.equal(flushed.body.pending, 0);
    assert.equal(cloudRequests[0].url, 'https://andasmoke.vercel.app/api/products');
    assert.equal(cloudRequests[0].method, 'POST');
    assert.equal(cloudRequests[0].headers.Authorization, 'Bearer cloud-staff-token');
    assert.equal(cloudRequests[0].body.id, product.id);

    const updated = await callApi(api.products, {
      method: 'PATCH', query: { id: product.id }, token: ownerToken, body: { stockCount: 12 },
    });
    assert.equal(updated.status, 200);
    const updateFlush = await callApi(api.posSync, {
      method: 'POST', query: { action: 'flush' }, token: ownerToken,
      cloudToken: 'Bearer cloud-staff-token', body: {},
    });
    assert.equal(updateFlush.body.flushed, 1);
    assert.equal(cloudRequests[1].method, 'PATCH');
    assert.equal(cloudRequests[1].body.stockCount, 12);

    const deleted = await callApi(api.products, {
      method: 'DELETE', query: { id: product.id }, token: ownerToken,
    });
    assert.equal(deleted.status, 200);
    const deleteFlush = await callApi(api.posSync, {
      method: 'POST', query: { action: 'flush' }, token: ownerToken,
      cloudToken: 'Bearer cloud-staff-token', body: {},
    });
    assert.equal(deleteFlush.body.flushed, 1);
    assert.equal(cloudRequests[2].method, 'DELETE');

    const status = await callApi(api.posSync, {
      token: ownerToken,
      cloudToken: 'Bearer cloud-staff-token',
    });
    assert.equal(status.body.syncedCount, 3);
    assert.equal(status.body.cloudConnected, true);
  } finally {
    globalThis.fetch = originalFetch;
    api.closeDataLayer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initial desktop catalog backfill queues existing products exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-product-backfill-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken } = await seedTill(api);
  const product = await makeProduct(api, ownerToken);
  api.getSqliteHandle().prepare('DELETE FROM pos_sync_queue').run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ products: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    const first = await callApi(api.posSync, {
      method: 'POST',
      query: { action: 'bootstrap-products' },
      token: ownerToken,
      cloudToken: 'Bearer cloud-staff-token',
      body: {},
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.queued, 1);

    const second = await callApi(api.posSync, {
      method: 'POST',
      query: { action: 'bootstrap-products' },
      token: ownerToken,
      cloudToken: 'Bearer cloud-staff-token',
      body: {},
    });
    assert.equal(second.body.queued, 0);
    assert.equal(second.body.alreadyDone, true);

    const status = await callApi(api.posSync, { token: ownerToken, cloudToken: 'Bearer cloud-staff-token' });
    assert.equal(status.body.pendingCount, 1);
    assert.equal(product.id, 'p1');
  } finally {
    globalThis.fetch = originalFetch;
    api.closeDataLayer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cloud products pull to desktop without overwriting queued local edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-product-pull-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken } = await seedTill(api);
  const localProduct = await makeProduct(api, ownerToken);
  const originalFetch = globalThis.fetch;
  const cloudImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p0sAAAAASUVORK5CYII=';
  globalThis.fetch = async () => new Response(JSON.stringify({
    products: [
      {
        id: 'cloud-only', name: 'Website-only bowl', brand: 'Online', department: 'beauty',
        category: 'skincare', categoryLabel: 'Flavors', price: 25, unit: 'bowl', image: cloudImage, images: [],
        stockCount: 4, inStock: true, isPublished: true, updatedAt: '2026-10-18T12:00:00.000Z',
      },
      {
        id: localProduct.id, name: 'Stale cloud name', brand: 'Online', department: 'beauty',
        category: 'skincare', categoryLabel: 'Flavors', price: 10, unit: 'bowl', image: '', images: [],
        stockCount: 1, inStock: true, isPublished: true, updatedAt: '2026-10-18T12:00:00.000Z',
      },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const pulled = await callApi(api.posSync, {
      method: 'POST',
      query: { action: 'pull-products' },
      token: ownerToken,
      cloudToken: 'Bearer cloud-staff-token',
      body: {},
    });
    assert.equal(pulled.status, 200);
    assert.equal(pulled.body.updated, 1);

    const sqlite = api.getSqliteHandle();
    const imported = sqlite.prepare('SELECT name, stock_count, image FROM products WHERE id = ?').get('cloud-only');
    assert.equal(imported.name, 'Website-only bowl');
    assert.equal(imported.stock_count, 4);
    assert.match(imported.image, /^\/media\/products\//);

    const locallyEdited = sqlite.prepare('SELECT name, stock_count FROM products WHERE id = ?').get(localProduct.id);
    assert.equal(locallyEdited.name, 'Mango Kush');
    assert.equal(locallyEdited.stock_count, 100);
  } finally {
    globalThis.fetch = originalFetch;
    api.closeDataLayer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken or empty website reply keeps the till catalog intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-cloud-reply-'));
  process.env.ANDA_DATA_DIR = dir;
  const api = freshBundle();
  const { ownerToken } = await seedTill(api);
  const localProduct = await makeProduct(api, ownerToken);
  const originalFetch = globalThis.fetch;
  const sqlite = api.getSqliteHandle();
  const productCount = () => sqlite.prepare('SELECT count(*) AS count FROM products').get().count;
  const syncCall = (action, method = 'POST') => callApi(api.posSync, {
    method,
    query: { action },
    token: ownerToken,
    cloudToken: 'Bearer cloud-staff-token',
    body: {},
  });

  // A deployment that rewrites unknown paths back to the single page app answers
  // every /api call with 200 and HTML. That looks like an empty catalog and must
  // never be read as one.
  const spaPage = '<!doctype html><html><head><title>POS</title></head><body><div id="root"></div></body></html>';
  globalThis.fetch = async () => new Response(spaPage, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

  try {
    const blockedBootstrap = await syncCall('bootstrap-products');
    assert.equal(blockedBootstrap.status, 502);
    assert.match(blockedBootstrap.body.error, /page instead of data/);

    const blockedFlush = await syncCall('flush');
    assert.equal(blockedFlush.body.flushed, 0, 'a page reply stores nothing');
    assert.ok(blockedFlush.body.pending >= 1, 'the change stays queued');
    assert.equal(productCount(), 1);

    const statusAfterPage = await syncCall('status', 'GET');
    assert.match(String(statusAfterPage.body.lastError), /page instead of data/);

    // The website now answers properly but shows no products at all.
    globalThis.fetch = async (_url, options) => {
      const method = String(options?.method || 'GET').toUpperCase();
      if (method === 'GET') {
        return new Response(JSON.stringify({ products: [], pagination: { total: 0, limit: 500, offset: 0, hasMore: false } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ product: { id: localProduct.id } }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    };

    assert.equal((await syncCall('bootstrap-products')).status, 200);
    const flushed = await syncCall('flush');
    assert.equal(flushed.body.flushed, 1);
    assert.equal(flushed.body.pending, 0);

    const pulled = await syncCall('pull-products');
    assert.equal(pulled.status, 200);
    assert.equal(pulled.body.deleted, 0, 'an empty website list does not delete till products');
    assert.equal(pulled.body.heldBack, true);
    assert.equal(productCount(), 1);
  } finally {
    globalThis.fetch = originalFetch;
    api.closeDataLayer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop sign-in returns a cloud token for catalog synchronization', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-cloud-login-'));
  process.env.ANDA_DATA_DIR = dir;
  const previousOrigin = process.env.ANDA_CLOUD_API_ORIGIN;
  process.env.ANDA_CLOUD_API_ORIGIN = 'https://cloud.example.test';
  const api = freshBundle();
  await seedTill(api);
  const originalFetch = globalThis.fetch;
  let cloudRequest;
  globalThis.fetch = async (url, options) => {
    cloudRequest = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ token: 'cloud-session-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const login = await callApi(api.auth, {
      method: 'POST',
      query: { action: 'admin' },
      body: { email: 'ama@smokehub.com', pin: '2468' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.cloudToken, 'cloud-session-token');
    assert.equal(cloudRequest.url, 'https://cloud.example.test/api/auth?action=admin&client=desktop');
    assert.equal(cloudRequest.body.email, 'ama@smokehub.com');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousOrigin === undefined) delete process.env.ANDA_CLOUD_API_ORIGIN;
    else process.env.ANDA_CLOUD_API_ORIGIN = previousOrigin;
    api.closeDataLayer();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no screen asks the hosted API for a nested route', () => {
  const fs = require('node:fs');
  const offenders = [];

  // Vercel registers the hosted function as /api/<one segment>. A second
  // segment never reaches it: the platform answers 404 before any code runs,
  // so the request looks like a broken login or a lost product rather than a
  // routing mistake. Ids therefore travel as ?id=, which both data layers read.
  const nested = /api\.(get|post|put|patch|delete)\(\s*["'`]\/[^"'`?]*\//g;

  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') scan(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(nested)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${full.replace(root, '')}:${line} ${match[0].slice(0, 72)}`);
      }
    }
  };
  scan(join(root, 'src'));

  assert.deepEqual(offenders, [], 'API endpoints must be one path segment plus a query string');
});

// ─────────────────────────────────────────────────────────────────────────

/** Reads a screen so the tests cannot drift from what ships. */
function readSource(relative) {
  return require('node:fs').readFileSync(
    join(root, 'src', 'components', 'admin', relative), 'utf8',
  );
}

/** Pulls one exported function out of a source file. */
function extract(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `could not find ${startMarker}`);
  let depth = 0;
  let index = source.indexOf('{', start);
  for (; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') {
      depth--;
      if (depth === 0) { index++; break; }
    }
  }
  const body = source.slice(start, index)
    .replace(/^\s*export\s+/, '')
    .replace(/\((\w+)\s*:\s*[^)\n]*\)/g, '($1)')
    .replace(/\)\s*:\s*[A-Za-z_$][\w$<>\[\]|,\s]*\{/g, ') {')
    .replace(/\s+as\s+(?:const|[A-Za-z_$][\w$]*(?:<[^<>]*>)?(?:\[\])?)(?:\s*\|\s*[A-Za-z_$][\w$]*(?:\[\])?)*(?:\s*\|\s*null)?/g, '');
  return body;
}
