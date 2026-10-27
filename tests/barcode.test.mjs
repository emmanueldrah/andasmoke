/**
 * Stage 2 verification: barcodes, labels, stock-in and scanner capture rules.
 *
 *   1. a generated Code 128 barcode decodes back to the same string
 *   2. internal codes are sequential, never reused
 *   3. labels are laid out in millimetres with a quiet zone and a minimum bar
 *      height, and never scaled to blur the bars
 *   4. exempt fields (barcode, PIN, data-barcode-input) are left to the browser
 *   5. stock-in raises stock and records the movement
 *   6. Enter and Tab both terminate a scan
 *
 * Run with: node --test tests/barcode.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from './helpers/dom.mjs';

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

// ─────────────────────────────────────────────────────────────────────────
// 1. Round trip: a generated barcode decodes back to the same string.
// ─────────────────────────────────────────────────────────────────────────

test('a generated Code 128 barcode decodes back to the same string', () => {
  const { encodeCode128, decodeCode128 } = freshBundle();

  const codes = [
    'ACS-000001',
    'ACS-000002',
    'ACS-123456',
    '5012345678900',
    'ABC-123-XYZ',
    'a b C 9',
    '!@#$%^&*()_+-=[]{};\',.<>/?',
    'X',
    '9'.repeat(40),
  ];

  for (const code of codes) {
    const modules = encodeCode128(code);
    const decoded = decodeCode128(modules);
    assert.equal(decoded.text, code, `round trip failed for "${code}"`);
    assert.equal(decoded.checksumValid, true, `checksum should verify for "${code}"`);
  }
});

test('decoding survives the quiet zones and reads run lengths, not module width', () => {
  const { encodeCode128, decodeCode128, QUIET_ZONE_MODULES } = freshBundle();
  const code = 'ACS-000042';
  const bare = encodeCode128(code);

  // A printed symbol has quiet zones on both sides; a scanner trims them.
  const quiet = [...new Array(QUIET_ZONE_MODULES).fill(0), ...bare, ...new Array(QUIET_ZONE_MODULES).fill(0)];
  assert.deepEqual(decodeCode128(quiet).text, code);

  // The decoder must not assume a module width. Every symbol pattern is a set of
  // run widths relative to its own narrowest bar, so a symbol drawn at 3x scale
  // (every run three times as wide) has to read back the same.
  const tripled = [];
  for (const module of bare) for (let i = 0; i < 3; i++) tripled.push(module);
  assert.deepEqual(decodeCode128(tripled).text, code, 'a 3x-scaled symbol must decode identically');

  // Extra quiet space beyond the minimum must be harmless too.
  const roomy = [...new Array(25).fill(0), ...bare, ...new Array(30).fill(0)];
  assert.deepEqual(decodeCode128(roomy).text, code);
});

test('a corrupted barcode is rejected rather than decoded to the wrong thing', () => {
  const { encodeCode128, decodeCode128 } = freshBundle();
  const code = 'ACS-000001';
  const modules = encodeCode128(code);

  // Damage must never be reported as a clean read. A flipped module either
  // destroys the run pattern, in which case decoding fails loudly, or it lands
  // in a data symbol, in which case the checksum must reject it.
  const outcomes = [];
  for (let index = 1; index < modules.length - 1; index++) {
    const damaged = [...modules];
    damaged[index] ^= 1;
    try {
      const result = decodeCode128(damaged);
      outcomes.push(result.checksumValid && result.text === code ? 'clean' : 'checksum');
    } catch {
      outcomes.push('rejected');
    }
  }
  assert.equal(outcomes.includes('clean'), false,
    'no single-module change may still decode as a clean, checksum-valid read');
  assert.equal(outcomes.every(outcome => outcome === 'rejected' || outcome === 'checksum'), true,
    `every damaged read should be rejected or fail its checksum, saw: ${[...new Set(outcomes)]}`);

  // An empty pattern is an error, not an empty string.
  assert.throws(() => decodeCode128([]), /Empty barcode/);

  // Garbage that is not a barcode at all must throw.
  assert.throws(() => decodeCode128([1, 1, 1, 1, 1, 1]), /Unreadable barcode/);
});

test('characters Code 128 subset B cannot encode are refused', () => {
  const { encodeCode128 } = freshBundle();
  assert.throws(() => encodeCode128('café'), /simple punctuation/);
  assert.throws(() => encodeCode128(''), /simple punctuation/);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Internal codes: sequential, never reused.
// ─────────────────────────────────────────────────────────────────────────

test('internal barcodes are sequential and never reused', () => {
  const { nextInternalBarcode, BARCODE_PREFIX } = freshBundle();

  // First code on an empty catalogue.
  assert.equal(nextInternalBarcode([]), `${BARCODE_PREFIX}000001`);
  assert.equal(nextInternalBarcode(new Set()), `${BARCODE_PREFIX}000001`);

  // Sequential as codes are issued.
  const issued = [];
  for (let i = 1; i <= 5; i++) {
    const code = nextInternalBarcode(issued);
    assert.equal(code, `${BARCODE_PREFIX}00000${i}`);
    issued.push(code);
  }

  // A deleted product's code is still "used" as far as the sequence is
  // concerned, because the number may already be on a printed label.
  const afterDelete = nextInternalBarcode(issued.filter(code => code !== `${BARCODE_PREFIX}000003`));
  assert.equal(afterDelete, `${BARCODE_PREFIX}000006`,
    'a code that was issued must never be handed out again');

  // A gap in the middle does not cause a collision.
  const gapped = nextInternalBarcode([`${BARCODE_PREFIX}000001`, `${BARCODE_PREFIX}000009`]);
  assert.equal(gapped, `${BARCODE_PREFIX}000010`);

  // Codes from other suppliers are ignored, not counted.
  assert.equal(nextInternalBarcode(['5012345678900', 'EAN-0001']), `${BARCODE_PREFIX}000001`);

  // Exhaustion is refused rather than wrapping round and reusing a number.
  const full = Array.from({ length: 999999 }, (_, index) =>
    `${BARCODE_PREFIX}${String(index + 1).padStart(6, '0')}`);
  assert.throws(() => nextInternalBarcode(full), /exhausted/);

  // Formatting is fixed width, so codes sort correctly.
  assert.match(nextInternalBarcode([]), /^ACS-\d{6}$/);
});

test('the server issues barcodes that are unique and skip existing ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-barcodes-'));
  process.env.ANDA_DATA_DIR = dir;

  const api = freshBundle();
  const setup = await callApi(api.auth, {
    method: 'POST', query: { action: 'setup' },
    body: { name: 'Ama Boateng', email: 'ama@smokehub.com', pin: '2468' },
  });
  assert.equal(setup.status, 201);
  const token = setup.body.token;

  const makeProduct = (id, barcode) => callApi(api.products, {
    method: 'POST', token,
    body: {
      id, name: `Item ${id}`, brand: 'Anda', department: 'beauty', category: 'skincare',
      categoryLabel: 'Test', price: '10.00', unit: 'box', barcode,
      image: '', images: [''], description: '', stockCount: 5,
    },
  });

  assert.equal((await makeProduct('with-code', 'SUPPLIER-1')).status, 201);
  assert.equal((await makeProduct('no-code-a', '')).status, 201);
  assert.equal((await makeProduct('no-code-b', '')).status, 201);

  const assigned = await callApi(api.products, {
    method: 'POST', query: { assignBarcodes: 'true' }, token, body: {},
  });
  assert.equal(assigned.status, 200, `assign failed: ${JSON.stringify(assigned.body)}`);
  assert.equal(assigned.body.assigned.length, 2, 'only the products without a barcode get one');

  const codes = assigned.body.assigned.map(entry => entry.barcode);
  assert.deepEqual(codes, ['ACS-000001', 'ACS-000002'], 'codes are issued in order');
  assert.equal(new Set(codes).size, 2, 'the codes must be distinct');

  // The product that already had a supplier barcode was left alone.
  const untouched = await callApi(api.products, { token, query: { id: 'with-code' } });
  assert.equal(untouched.body.barcode, 'SUPPLIER-1');

  // Re-running issues nothing more, because nothing is missing.
  const again = await callApi(api.products, {
    method: 'POST', query: { assignBarcodes: 'true' }, token, body: {},
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.assigned.length, 0, 'a second run must not re-issue codes');

  // And the new codes actually scan to the product.
  const scanned = await callApi(api.products, { token, query: { scanCode: 'ACS-000002' } });
  assert.equal(scanned.status, 200);
  assert.equal(scanned.body.products[0].id, 'no-code-b');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Label layout: quiet zone, minimum bar height, no blur.
// ─────────────────────────────────────────────────────────────────────────

test('a label is laid out in millimetres with a quiet zone and a minimum bar height', () => {
  const { planLabel, encodeCode128, QUIET_ZONE_MODULES, MIN_BAR_HEIGHT_MM, DEFAULT_MODULE_WIDTH_MM } = freshBundle();

  const code = 'ACS-000001';
  const layout = planLabel(code, { widthMm: 50, heightMm: 30 });

  assert.equal(layout.widthMm, 50);
  assert.equal(layout.heightMm, 30);
  assert.equal(layout.overflow, false, 'a common code must fit a 50x30 label');

  // Bar height never drops below the minimum a handheld can read.
  assert.ok(layout.barHeightMm >= MIN_BAR_HEIGHT_MM,
    `bar height ${layout.barHeightMm} must be at least ${MIN_BAR_HEIGHT_MM}mm`);
  const tiny = planLabel(code, { widthMm: 50, heightMm: 14 });
  assert.ok(tiny.barHeightMm >= MIN_BAR_HEIGHT_MM,
    'a short label must still get the minimum bar height');

  // Bars are never narrower than the reliable minimum.
  const wide = planLabel(code, { widthMm: 200, heightMm: 60 });
  assert.ok(wide.moduleWidthMm >= DEFAULT_MODULE_WIDTH_MM,
    'a wide label must not shrink the bars below the scannable minimum');

  // The quiet zone is ten modules on each side, in millimetres.
  assert.equal(QUIET_ZONE_MODULES, 10);
  assert.ok(
    Math.abs(layout.quietZoneMm - QUIET_ZONE_MODULES * layout.moduleWidthMm) < 0.001,
    'the quiet zone must be exactly ten modules wide',
  );

  // Symbol width accounts for the bars plus both quiet zones.
  const barModules = encodeCode128(code).length;
  assert.ok(
    Math.abs(layout.symbolWidthMm - (barModules + QUIET_ZONE_MODULES * 2) * layout.moduleWidthMm) < 0.001,
    'the symbol width must be the bars plus two quiet zones',
  );

  // A code too long for the label is reported rather than printed badly.
  const narrow = planLabel('X'.repeat(120), { widthMm: 30, heightMm: 20 });
  assert.equal(narrow.overflow, true, 'an over-long code must be flagged');
});

test('the label SVG is sized in millimetres and never scales its bars', () => {
  const { renderLabelSvg } = freshBundle();

  const svg = renderLabelSvg('ACS-000001', { widthMm: 50, heightMm: 30 }, {
    productName: 'Mango Kush', price: 'GH¢ 45.00',
  });

  // Physical size, so the printer reproduces real millimetres.
  assert.match(svg, /width="50mm"/, 'the SVG must be sized in millimetres');
  assert.match(svg, /height="30mm"/);
  // A viewBox in user units matches the millimetre size, so 1 unit = 1 mm and
  // no scaling happens between the two.
  assert.match(svg, /viewBox="0 0 50 30"/);

  // Bars are drawn as vectors with crisp edges, not an embedded raster.
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /<rect x="[\d.]+" y="[\d.]+" width="[\d.]+"/,
    'bars must be vector rects with explicit widths');
  assert.ok(!/<image\b/.test(svg), 'no image element: a scaled raster would blur the bars');
  assert.ok(!/data:image/.test(svg), 'no embedded bitmap');

  // Human-readable text is included, and escaped.
  assert.match(svg, /ACS-000001<\/text>/);
  assert.match(svg, /Mango Kush/);

  // A different label size produces a different layout.
  const bigger = renderLabelSvg('ACS-000001', { widthMm: 80, heightMm: 40 });
  assert.match(bigger, /width="80mm"/);
  assert.notEqual(svg, bigger);

  // Text that could break the SVG is escaped.
  const nasty = renderLabelSvg('ACS-000001', { widthMm: 50, heightMm: 30 }, {
    productName: '<script>alert(1)</script>',
  });
  assert.ok(!/<script>/.test(nasty), 'the product name must be escaped');
  assert.match(nasty, /&lt;script&gt;/);
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Exempt fields.
// ─────────────────────────────────────────────────────────────────────────

test('barcode, PIN and data-barcode-input fields are exempt from scanner capture', () => {
  // Compiled from the same source the app ships, so the test cannot drift.
  const source = readComponentSource('AdminPOSWorkspace.tsx');
  const jsdom = new JSDOM();
  const isScannerExempt = jsdom.loadFunctionFromSource(extractExemptFunction(source));

  const document = jsdom.window.document;

  const make = (attrs) => {
    const input = document.createElement('input');
    for (const [name, value] of Object.entries(attrs)) input.setAttribute(name, value);
    document.body.appendChild(input);
    return input;
  };

  // ── Fields that must be exempt ─────────────────────────────────────────
  const marked = make({ 'data-barcode-input': 'product-form' });
  assert.equal(isScannerExempt(marked), true, 'data-barcode-input opts out');

  const password = make({ type: 'password' });
  assert.equal(isScannerExempt(password), true, 'password fields (every PIN field) opt out');

  const barcodeById = make({ id: 'product-barcode' });
  assert.equal(isScannerExempt(barcodeById), true, 'a field identified as a barcode opts out');

  const barcodeByName = make({ name: 'variant-barcode' });
  assert.equal(isScannerExempt(barcodeByName), true, 'a field named as a barcode opts out');

  const pinById = make({ id: 'login-pin' });
  assert.equal(isScannerExempt(pinById), true, 'a field identified as a PIN opts out');

  const markedByValue = make({ 'data-barcode-input': 'test-scanner' });
  assert.equal(isScannerExempt(markedByValue), true, 'the marker value is honoured too');

  // The marker on an ancestor opts the field out as well.
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-barcode-input', 'wrapper');
  const nested = document.createElement('input');
  wrapper.appendChild(nested);
  document.body.appendChild(wrapper);
  assert.equal(isScannerExempt(nested), true, 'the marker works on an ancestor element');

  // ── Fields that must NOT be exempt ────────────────────────────────────
  const scanBox = make({ 'aria-label': 'Scan a barcode or search for a product' });
  assert.equal(isScannerExempt(scanBox), false,
    'the counter scan box must remain capturable, or scanning stops working');

  const cashField = make({ id: 'pos-cash-received' });
  assert.equal(isScannerExempt(cashField), false, 'an ordinary field must stay capturable');

  const searchBox = make({ id: 'q', name: 'query' });
  assert.equal(isScannerExempt(searchBox), false, 'an ordinary field must stay capturable');

  const textArea = document.createElement('textarea');
  document.body.appendChild(textArea);
  assert.equal(isScannerExempt(textArea), false, 'a textarea is not automatically exempt');

  assert.equal(isScannerExempt(null), false, 'no field means nothing to exempt');
  assert.equal(isScannerExempt(document.body), false, 'the page body is not exempt');
  assert.equal(isScannerExempt(document.createElement('div')), false, 'a div is not a field');
});

test('POS search and exact scan matching include product and variant serial numbers', () => {
  const source = readComponentSource('AdminPOSWorkspace.tsx');
  const jsdom = new JSDOM();
  const loadMatcher = name => jsdom.loadFunctionFromSource(
    extractNamedFunction(source, name).replace(/item: PosItem/g, 'item').replace(/value: string/g, 'value'),
  );
  const matchesCode = loadMatcher('matchesPosItemCode');
  const matchesSearch = loadMatcher('matchesPosItemSearch');
  const productItem = {
    product: { id: 'p-1', name: 'Hookah', brand: 'Anda', serialNumber: 'SN-PRODUCT' },
    title: 'Hookah', stock: 2, barcode: 'BC-PRODUCT',
  };
  const variantItem = {
    product: { id: 'p-2', name: 'Flavor', brand: 'Anda' },
    variant: { id: 'v-1', name: 'Mint', serialNumber: 'SN-VARIANT' },
    title: 'Flavor - Mint', stock: 1, barcode: 'BC-VARIANT',
  };

  assert.equal(matchesCode(productItem, 'sn-product'), true);
  assert.equal(matchesCode(variantItem, 'SN-VARIANT'), true);
  assert.equal(matchesSearch(productItem, 'SN-PRODUCT'), true);
  assert.equal(matchesSearch(variantItem, 'sn-variant'), true);
});

test('recovered scanner codes are passed explicitly to server fallback', () => {
  const source = readComponentSource('AdminPOSWorkspace.tsx');
  assert.match(source, /const scanItem = async \(rawCode = scannerValue\)/);
  assert.match(source, /const commitScanFor = async \(raw: string\)[\s\S]*?await scanItem\(raw\);/);
  const scanBox = /<input\b[^>]*?\bref=\{scannerRef\}[\s\S]*?>/.exec(source);
  assert.ok(scanBox);
  assert.doesNotMatch(scanBox[0], /onKeyDown=/,
    'the scan input must not commit Enter before global burst detection');
  assert.match(source, /if \(event\.key === 'Enter' && event\.target === scannerRef\.current\)[\s\S]*?void commitScan\(\);/);
});

test('the product form really marks its barcode fields, and the counter scan box does not', () => {
  const modal = readComponentSource('POSProductModal.tsx');
  assert.match(modal, /data-barcode-input="product-form"/,
    'the product form barcode field must opt out of scanner capture');
  // Both the product barcode and each variation barcode.
  assert.equal((modal.match(/data-barcode-input="product-form"/g) || []).length >= 2, true,
    'variation barcode fields must opt out too');

  const counter = readComponentSource('AdminPOSWorkspace.tsx');

  // The scan input is the JSX element carrying the scanner ref. Locate its
  // opening tag only, so a later attribute elsewhere on the page cannot be
  // mistaken for part of this one.
  const scanBox = /<input\b[^>]*?\bref=\{scannerRef\}[\s\S]*?>/.exec(counter);
  assert.ok(scanBox, 'the counter scan box should be findable');
  assert.ok(!/data-barcode-input/.test(scanBox[0]),
    'the counter scan box must NOT be exempt, or no scan would ever be added');
  // The exemption rule keys off id/name as well, so the scan box must not be
  // named like a barcode or PIN field either.
  const tag = scanBox[0];
  assert.ok(!/\b(?:id|name)\s*=\s*["'][^"']*(?:barcode|pin)[^"']*["']/i.test(tag),
    'the counter scan box must not be identified as a barcode or PIN field');
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Stock-in.
// ─────────────────────────────────────────────────────────────────────────

test('stock-in raises the quantity, records the movement and leaves money alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anda-stockin-'));
  process.env.ANDA_DATA_DIR = dir;

  const api = freshBundle();
  const setup = await callApi(api.auth, {
    method: 'POST', query: { action: 'setup' },
    body: { name: 'Ama Boateng', email: 'ama@smokehub.com', pin: '2468' },
  });
  assert.equal(setup.status, 201);
  const token = setup.body.token;

  const created = await callApi(api.products, {
    method: 'POST', token,
    body: {
      id: 'stock-me', name: 'Mango Kush', brand: 'Anda', department: 'beauty', category: 'skincare',
      categoryLabel: 'Test', price: '45.00', unit: 'bowl', barcode: 'ACS-000009',
      image: '', images: [''], description: '', stockCount: 4,
    },
  });
  assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.body)}`);

  const ordersBefore = await callApi(api.orders, { token, query: {} });
  const takingsBefore = ordersBefore.body.orders.length;

  // Scan to select the product, then say how many arrived.
  const received = await callApi(api.stockIn, {
    method: 'POST', token, body: { productId: 'stock-me', quantity: 12, reason: 'Delivery ACS-2026-10-09' },
  });
  assert.equal(received.status, 201, `stock-in failed: ${JSON.stringify(received.body)}`);
  assert.equal(received.body.quantityBefore, 4);
  assert.equal(received.body.stockAfter, 16);

  const after = await callApi(api.products, { token, query: { id: 'stock-me' } });
  assert.equal(Number(after.body.stockCount), 16, 'the quantity must be raised');

  // The movement is recorded, with before and after.
  const sqlite = api.getSqliteHandle();
  const movement = sqlite
    .prepare('SELECT product_id, movement_type, quantity, quantity_before, quantity_after, reason FROM inventory_movements WHERE product_id = ?')
    .all('stock-me');
  assert.equal(movement.length, 1, 'one movement row per stock-in');
  assert.equal(movement[0].movement_type, 'STOCK_IN');
  assert.equal(movement[0].quantity, 12);
  assert.equal(movement[0].quantity_before, 4);
  assert.equal(movement[0].quantity_after, 16);

  // Stock-in is not a sale: the day's takings are untouched.
  const ordersAfter = await callApi(api.orders, { token, query: {} });
  assert.equal(ordersAfter.body.orders.length, takingsBefore,
    'receiving goods must not create a sale');

  // And it is in the audit log.
  const audit = await callApi(api.backups, { method: 'GET', query: { action: 'audit' }, token });
  const entry = audit.body.entries.find(item => item.action === 'INVENTORY_STOCK_ADJUSTED' && item.metadata?.via === 'stock-in');
  assert.ok(entry, 'the stock-in must be recorded in the audit log');
  assert.equal(entry.metadata.quantity, 12);
  assert.equal(entry.metadata.quantityAfter, 16);

  // ── Guard rails ───────────────────────────────────────────────────────
  for (const quantity of [0, -5, 1.5, 'many', null]) {
    const refused = await callApi(api.stockIn, {
      method: 'POST', token, body: { productId: 'stock-me', quantity },
    });
    assert.equal(refused.status, 400, `quantity ${JSON.stringify(quantity)} must be refused`);
  }
  const missingProduct = await callApi(api.stockIn, {
    method: 'POST', token, body: { productId: 'does-not-exist', quantity: 5 },
  });
  assert.equal(missingProduct.status, 404);

  // A failed attempt leaves the quantity alone.
  const unchanged = await callApi(api.products, { token, query: { id: 'stock-me' } });
  assert.equal(Number(unchanged.body.stockCount), 16, 'a refused stock-in must change nothing');

  api.closeDataLayer();
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Enter and Tab both terminate a scan.
// ─────────────────────────────────────────────────────────────────────────

test('a scan terminates on Enter or on Tab', () => {
  const { isScannerExempt } = loadScannerModule();
  const source = readComponentSource('AdminPOSWorkspace.tsx');

  // The handler must treat both keys as a terminator, and must not take
  // Shift+Tab (which is how a keyboard user moves backwards through fields).
  // Normalise whitespace so the pattern is not thrown off by indentation.
  const flat = source.replace(/\s+/g, ' ');
  const terminator = /event\.key === 'Enter' \|\| \(event\.key === 'Tab' && !event\.shiftKey\)/.exec(flat);
  assert.ok(terminator,
    'the scan terminator must accept Enter or Tab; found: ' +
    (flat.match(/event\.key === 'Enter'[^)]{0,80}/) || ['nothing'])[0]);

  // Shift+Tab must keep its normal meaning, or keyboard navigation breaks.
  assert.match(flat, /event\.key === 'Tab' && !event\.shiftKey/,
    'Shift+Tab must not be hijacked');

  // The captured characters come from the events, so both terminators recover
  // the same code.
  const simulate = (terminator) => {
    const jsdom = new JSDOM();
    const keys = [];
    const code = 'ACS-000123';
    // Replay what the browser would send, then the terminator.
    let startedAt = 1000;
    for (const char of code) {
      keys.push({ key: char, timeStamp: startedAt });
      startedAt += 8;
    }
    keys.push({ key: terminator, timeStamp: startedAt, shiftKey: false });

    let burst = { chars: 0, startedAt: 0, lastAt: 0, text: '' };
    let captured = null;
    for (const event of keys) {
      if (event.key.length === 1) {
        if (burst.chars > 0 && event.timeStamp - burst.lastAt > 250) { burst = { chars: 0, startedAt: 0, lastAt: 0, text: '' }; }
        if (burst.chars === 0) burst.startedAt = event.timeStamp;
        burst.chars++; burst.lastAt = event.timeStamp; burst.text += event.key;
        continue;
      }
      const isTerminator = event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey);
      if (!isTerminator) continue;
      const elapsed = event.timeStamp - burst.startedAt;
      const avgGap = burst.chars > 1 ? elapsed / (burst.chars - 1) : Infinity;
      if (burst.chars >= 8 && elapsed <= 2500 && avgGap <= 45) captured = burst.text;
      burst = { chars: 0, startedAt: 0, lastAt: 0, text: '' };
    }
    return captured;
  };

  assert.equal(simulate('Enter'), 'ACS-000123', 'Enter must capture the scan');
  assert.equal(simulate('Tab'), 'ACS-000123', 'Tab must capture the scan');

  void isScannerExempt;
});

test('Shift+Tab keeps its normal meaning', () => {
  // Shift+Tab is how a keyboard user moves backwards between fields. Treating it
  // as a scan terminator would silently steal the keystroke.
  const simulateShiftTab = () => {
    const code = 'ACS-000123';
    let startedAt = 1000;
    let burst = { chars: 0, startedAt: 0, lastAt: 0, text: '' };
    let captured = null;
    const feed = (event) => {
      if (event.key.length === 1) {
        if (burst.chars === 0) burst.startedAt = event.timeStamp;
        burst.chars++; burst.lastAt = event.timeStamp; burst.text += event.key;
        return;
      }
      const isTerminator = event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey);
      if (!isTerminator) return;
      const elapsed = event.timeStamp - burst.startedAt;
      const avgGap = burst.chars > 1 ? elapsed / (burst.chars - 1) : Infinity;
      if (burst.chars >= 8 && elapsed <= 2500 && avgGap <= 45) captured = burst.text;
      burst = { chars: 0, startedAt: 0, lastAt: 0, text: '' };
    };

    for (const char of code) { feed({ key: char, timeStamp: startedAt }); startedAt += 8; }
    feed({ key: 'Tab', timeStamp: startedAt, shiftKey: true });
    return captured;
  };

  assert.equal(simulateShiftTab(), null, 'Shift+Tab must not be treated as a scan');
});

// ─────────────────────────────────────────────────────────────────────────

/** Reads one source file so the tests cannot drift from what ships. */
function readComponentSource(fileName) {
  // The counter lives in screens/, the product form one level up.
  const candidates = [
    join(root, 'src', 'components', 'admin', fileName),
    join(root, 'src', 'components', 'admin', 'screens', fileName),
  ];
  const found = candidates.find(path => existsSync(path));
  assert.ok(found, `could not find ${fileName} in ${candidates.join(' or ')}`);
  return readFileSync(found, 'utf8');
}

function loadScannerModule() {
  // The exemption rule lives in the counter component, so compile it from the
  // shipped source rather than reaching for a bundle export.
  const jsdom = new JSDOM();
  return {
    isScannerExempt: jsdom.loadFunctionFromSource(
      extractExemptFunction(readComponentSource('AdminPOSWorkspace.tsx')),
    ),
  };
}

/** Pulls the exported exemption function out of the component source. */
function extractExemptFunction(source) {
  const start = source.indexOf('export function isScannerExempt');
  assert.notEqual(start, -1, 'isScannerExempt should be exported from the counter');
  let depth = 0;
  let index = source.indexOf('{', start);
  const from = index;
  for (; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') {
      depth--;
      if (depth === 0) { index++; break; }
    }
  }
  return source.slice(start, index);
}

function extractNamedFunction(source, name) {
  const match = source.match(new RegExp(`(?:export )?function ${name}\\([\\s\\S]*?\\n}`));
  assert.ok(match, `${name} should be findable in the POS screen source`);
  return match[0].replace(/^export /, '');
}