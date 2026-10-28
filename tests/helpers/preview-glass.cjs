'use strict';

/**
 * Disposable Electron renderer verification; never imports electron/main.cjs.
 * Run AFTER the shared CSS and static build are ready, from the repository:
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/helpers/preview-glass.cjs
 * PREVIEW_GLASS_URL overrides http://127.0.0.1:3006/admin (static assets only).
 * PREVIEW_STRICT_CONTRAST=1 additionally fails conservative contrast estimates.
 * Screenshots and results.json are written to tests/ui-preview-output at runtime.
 * No dependencies, real sessions, desktop bridge, printers, or API are used.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

if (!app || !BrowserWindow) {
  throw new Error('Use Electron with ELECTRON_RUN_AS_NODE unset, not node.');
}

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'tests', 'ui-preview-output');
const TARGET = new URL(process.env.PREVIEW_GLASS_URL || 'http://127.0.0.1:3006/admin');
if (TARGET.protocol !== 'http:' || TARGET.username || TARGET.password || !['127.0.0.1', 'localhost', '[::1]'].includes(TARGET.hostname)) {
  throw new Error('PREVIEW_GLASS_URL must be a local HTTP static origin without credentials.');
}
const CHANNEL = 'preview-glass:trace';
const LOGIN_ONLY = process.env.PREVIEW_GLASS_LOGIN_ONLY === '1';
// The HTTPS protocol handler supplies the optional font CSS without networking.
const SETTLE_MS = 180;
const PAGES = ['Counter', 'Inventory', 'Products', 'Categories', 'Discounts', 'Team', 'Reports', 'Settings', 'About app'];
const SIZES = [
  { name: '1440x900', width: 1440, height: 900, zoom: 1 },
  { name: '1024x768', width: 1024, height: 768, zoom: 1 },
  { name: '1440x900-z125', width: 1440, height: 900, zoom: 1.25 },
  { name: '390x844', width: 390, height: 844, zoom: 1 },
];
const results = {
  startedAt: new Date().toISOString(), target: TARGET.href,
  outputDirectory: OUTPUT, renderer: 'Electron offscreen; isolated disposable session',
  pages: PAGES, sizes: SIZES, captures: [], checks: [], failures: [], warnings: [],
  fetches: [], missingFixtures: [], mutations: [], deniedRequests: [], staticRequests: [],
  console: [], javascriptErrors: [],
  contrastMethod: 'Conservative sRGB ancestor/group-alpha compositing over CSS gradient stops; not a pixel-level assertion. Blur, pseudo-elements, shadows and gradient geometry are not modeled. All selected gradient stops are reported; bounded combinations are flagged. Low estimates warn unless PREVIEW_STRICT_CONTRAST=1.',
};
let win;
let temp;
let finishing = false;
let watchdog;

function fail(kind, detail) { results.failures.push({ kind, detail }); }
function check(name, pass, detail) {
  results.checks.push({ name, pass: Boolean(pass), detail });
  if (!pass) fail(name, detail);
}
function saveResults() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT, 'results.json'), JSON.stringify(results, null, 2));
}
function finish() {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  results.finishedAt = new Date().toISOString();
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (error) { fail('destroy-window', error.message); }
  if (temp) {
    try {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      results.temporaryProfile = { path: temp, removed: true };
    } catch (error) {
      results.temporaryProfile = { path: temp, removed: false };
      results.warnings.push({ kind: 'temporary-profile-cleanup', detail: error.message });
    }
  }
  results.passed = results.failures.length === 0;
  try { saveResults(); } catch (error) { console.error('Could not write preview results:', error); app.exit(1); return; }
  console.log(`${results.passed ? 'PASS' : 'FAIL'}: ${results.captures.length} captures; ${results.failures.length} failures. ${path.join(OUTPUT, 'results.json')}`);
  app.exit(results.passed ? 0 : 1);
}

// These switches and relaxed preload settings belong ONLY to this throwaway app.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('no-proxy-server');
temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-preview-glass-'));
app.setPath('userData', path.join(temp, 'user-data'));
app.setPath('sessionData', path.join(temp, 'session-data'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
fs.mkdirSync(app.getPath('sessionData'), { recursive: true });
app.setAppLogsPath(path.join(temp, 'logs'));
watchdog = setTimeout(() => { fail('watchdog', 'Verification exceeded 240 seconds.'); finish(); }, 240_000);
process.on('uncaughtException', error => { fail('main-exception', error.stack || error.message); finish(); });
process.on('unhandledRejection', error => { fail('main-rejection', String(error?.stack || error)); finish(); });

function makeFixtures() {
  const image = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'public', 'brand-mark.png')).toString('base64')}`;
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const session = { role: 'admin', email: 'preview@example.test', adminName: 'UI Preview', adminRole: 'Super Admin', adminId: 'preview' };
  const categories = [
    { id: 'beverages', slug: 'drinks', name: 'Drinks & Refreshments', department: 'groceries', image, description: 'Disposable beverage fixtures', isActive: true },
    { id: 'snacks-sweets', slug: 'snacks-sweets', name: 'Snacks & Sweets', department: 'groceries', image, description: 'Disposable grocery fixtures', isActive: true },
    { id: 'daily-essentials', slug: 'lounge-supplies', name: 'Lounge Supplies', department: 'groceries', image, description: 'Disposable everyday fixtures', isActive: true },
  ];
  const products = ['Preview Mineral Water', 'Preview Orange Juice', 'Preview Cola', 'Preview Ginger Drink', 'Preview Sparkling Water', 'Preview Iced Tea', 'Preview Coconut Water', 'Preview Lemon Drink'].map((name, index) => ({
    id: `preview-product-${index + 1}`, name, brand: 'Preview', department: 'groceries',
    category: 'beverages', categoryLabel: categories[0].name, price: 12 + index * 3,
    wholesalePrice: 9 + index * 2, unit: 'bottle', barcode: `20000000000${index + 1}`,
    serialNumber: `PREVIEW-${index + 1}`, image, images: [image],
    inStock: true, isPublished: true, stockCount: index === 1 ? 4 : 24 + index * 7,
    options: [], variants: [],
  }));
  const orders = Array.from({ length: 4 }, (_, index) => {
    const product = products[index];
    const quantity = index + 1;
    const total = product.price * quantity;
    return {
      id: `preview-order-${index + 1}`, orderNumber: `POS-PREVIEW-000${index + 1}`,
      createdAt: new Date(Date.now() - index * 900_000).toISOString(),
      items: [{ product, quantity, priceType: 'retail' }], subtotal: total, shippingFee: 0,
      discount: 0, total, paymentMethod: 'cash-on-delivery', paymentStatus: 'paid',
      paymentReference: `PREVIEW-CASH-${index + 1}`, orderSource: 'pos', deliveryMethod: 'store-pickup',
      shippingAddress: { fullName: `Preview Customer ${index + 1}`, phone: '0000000000', email: `customer${index + 1}@example.test`, city: 'In-store', area: 'POS counter' },
      status: 'Delivered', cashierName: 'UI Preview', adminName: 'UI Preview',
      payments: [{ method: 'cash-on-delivery', amount: total, tendered: total, change: 0 }],
    };
  });
  const gross = orders.reduce((sum, order) => sum + order.total, 0);
  const money = value => `GHS ${value.toFixed(2)}`;
  const totals = {
    gross, net: gross, refunded: 0, discounted: 0, saleCount: 4, refundCount: 0, voidedLines: 0,
    grossFormatted: money(gross), netFormatted: money(gross), refundedFormatted: money(0), discountedFormatted: money(0),
  };
  return {
    session, products, categories, brands: ['Preview'], orders, version, loginOnly: LOGIN_ONLY,
    settings: { settings: [{ key: 'storeName', value: 'UI Preview' }, { key: 'storePhone', value: '0000000000' }], hardware: {} },
    hardware: {},
    accounts: [
      { id: 'preview', fullName: 'UI Preview', email: 'preview@example.test', phone: '0000000000', role: 'super_admin' },
      { id: 'preview-cashier', fullName: 'Preview Cashier', email: 'cashier@example.test', phone: '0000000001', role: 'cashier' },
    ],
    promos: [{ id: 'preview-promo', code: 'PREVIEW10', discountType: 'percentage', discountValue: 10, minSpend: 20, isActive: true, usageCount: 2, description: 'Disposable preview discount', expiryDate: '2099-12-31' }],
    held: { heldSales: [{ id: 'preview-held', ticketLabel: 'Preview held ticket', items: [{ product: products[0], quantity: 2, priceType: 'retail' }], subtotal: 24, discount: 0, total: 24, promoCode: null, paymentMethod: 'cash-on-delivery', cashReceived: 24, heldBy: 'UI Preview', createdAt: now, recalledAt: null }] },
    backups: { last: { exists: true, createdAt: now, ageHours: 1, due: false } },
    health: { ok: true },
    summary: {
      range: { from: day, to: day }, currency: 'GHS', totals,
      days: [{ day, label: day, sales: gross, count: 4, refunded: 0, discounted: 0, salesFormatted: money(gross) }],
      byPayment: [{ method: 'Cash', amount: gross, count: 4, refunded: 0, amountFormatted: money(gross), refundedFormatted: money(0) }],
      byCashier: [{ cashier: 'UI Preview', amount: gross, count: 4, refunded: 0, discounted: 0, amountFormatted: money(gross), refundedFormatted: money(0) }],
    },
    productReport: { range: { from: day, to: day }, currency: 'GHS', totals, rows: orders.map(order => ({ key: order.items[0].product.id, name: order.items[0].product.name, quantity: order.items[0].quantity, amount: order.total })) },
    categoryReport: { range: { from: day, to: day }, currency: 'GHS', totals, rows: [{ key: 'beverages', name: categories[0].name, quantity: 10, amount: gross }] },
  };
}

// Serialized into a temporary preload and executed in the shared renderer world
// before any application script. Never forwards fetch to a native implementation.
function installPreview(fixtures, origin, channel) {
  const { ipcRenderer } = require('electron');
  const trace = (kind, detail) => ipcRenderer.send(channel, { kind, detail });
  const describeError = error => String(error?.stack || error?.message || error);
  window.addEventListener('error', event => {
    if (event.error || event.message) trace('javascriptError', { message: describeError(event.error || event.message), file: event.filename, line: event.lineno });
    else if (event.target !== window) trace('resourceError', { tag: event.target?.tagName, url: event.target?.src || event.target?.href });
  }, true);
  window.addEventListener('unhandledrejection', event => trace('javascriptError', { message: describeError(event.reason), unhandledRejection: true }));
  window.print = () => { trace('forbiddenAction', { action: 'window.print' }); };
  window.open = () => { trace('forbiddenAction', { action: 'window.open' }); return null; };
  window.confirm = () => { trace('forbiddenAction', { action: 'window.confirm' }); return false; };
  window.alert = message => { trace('forbiddenAction', { action: 'window.alert', message: String(message) }); };
  // Do not define andaPos: the real desktop bridge enables cloud mutation loops.
  localStorage.clear();
  const loginPreview = fixtures.loginOnly || sessionStorage.getItem('preview-glass-login') === '1';
  if (!loginPreview) {
    localStorage.setItem('anda_auth_token', 'ui-preview-token');
    localStorage.setItem('anda_admin_session', JSON.stringify({ ...fixtures.session, isLoggedIn: true }));
  }
  localStorage.setItem('anda_theme_mode', 'dark');
  localStorage.setItem('cr_admin_rail_collapsed', '0');
  localStorage.setItem('anda_categories', JSON.stringify(fixtures.categories));
  localStorage.setItem('anda_brands', JSON.stringify(fixtures.brands));
  localStorage.setItem('anda_admin_accounts', JSON.stringify(fixtures.accounts));

  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, window.location.href);
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    const request = { url: url.href, method };
    trace('fetch', request);
    if (method !== 'GET') {
      trace('mutation', request);
      return jsonResponse({ error: 'Preview forbids every mutation.' }, 403);
    }
    if (url.origin !== origin) {
      trace('deniedFetch', { ...request, reason: 'external origin' });
      return jsonResponse({ error: 'Preview forbids external origins.' }, 403);
    }
    if (url.pathname === '/updates/win/latest.yml') {
      return new Response(`version: ${fixtures.version}\n`, { headers: { 'Content-Type': 'text/yaml' } });
    }
    const endpoint = url.pathname.replace(/^\/api(?=\/|$)/, '').replace(/\/$/, '');
    const resource = url.searchParams.get('resource') || url.searchParams.get('action');
    let data;
    if (endpoint === '/auth' && resource === 'session') {
      if (loginPreview) return jsonResponse({ error: 'No preview session.' }, 401);
      data = fixtures.session;
    } else if (endpoint === '/auth' && resource === 'setup-status') data = { needsSetup: false };
    else if (endpoint === '/products') {
      let products = fixtures.products;
      const scanCode = url.searchParams.get('scanCode');
      if (scanCode) products = products.filter(product => product.barcode === scanCode || product.serialNumber === scanCode);
      const category = url.searchParams.get('category');
      if (category && category !== 'all') products = products.filter(product => product.category === category);
      data = { products };
    } else if (endpoint === '/orders') data = { orders: fixtures.orders };
    else if (endpoint === '/catalog' && resource === 'brands') data = fixtures.brands;
    else if (endpoint === '/catalog' && resource === 'categories') data = fixtures.categories;
    else if (endpoint === '/settings') data = resource === 'hardware' ? fixtures.hardware : fixtures.settings;
    else if (endpoint === '/hardware') data = fixtures.hardware;
    else if (endpoint === '/admin-accounts') data = fixtures.accounts;
    else if (endpoint === '/promo-codes') data = fixtures.promos;
    else if (endpoint === '/held-sales') data = fixtures.held;
    else if (endpoint === '/backups') data = fixtures.backups;
    else if (endpoint === '/health') data = fixtures.health;
    else if (endpoint === '/reports' && !url.searchParams.has('format')) {
      const report = url.searchParams.get('report') || 'summary';
      const source = report === 'summary' ? fixtures.summary : report === 'products' ? fixtures.productReport : report === 'categories' ? fixtures.categoryReport : null;
      if (source) data = { ...source, range: { from: url.searchParams.get('from') || source.range.from, to: url.searchParams.get('to') || source.range.to } };
    }
    if (data === undefined) {
      trace('missingFixture', request);
      data = {};
    }
    return jsonResponse(data);
  };
  Object.defineProperty(window, 'fetch', { configurable: false, writable: false, value: fakeFetch });
  trace('preloadReady', { origin: window.location.origin });
}

const delay = () => new Promise(resolve => setTimeout(resolve, SETTLE_MS));
const execute = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`, true);
async function waitFor(fn, description, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await execute(fn)) return;
    await delay(); // Offscreen windows must NOT wait for requestAnimationFrame.
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function domClick(text, scope, match, index) {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = normalize(text);
  const nodes = [...document.querySelectorAll(`${scope} button`)].filter(button => {
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none' || button.disabled) return false;
    return [button.textContent, button.getAttribute('aria-label'), button.title].some(value => match === 'contains' ? normalize(value).includes(wanted) : normalize(value) === wanted);
  });
  const button = nodes[index];
  if (!button) throw new Error(`Button not found: ${text} in ${scope}`);
  const name = normalize(button.textContent || button.getAttribute('aria-label') || button.title);
  if (/^(complete sale|posting sale|save\b|delete\b|print\b|refund\b|recall\b|hold$|clear all|clear history|remove stock|pause$|activate$|restart\b|sign out|confirm$|export$|csv$|pdf$)/.test(name)) {
    throw new Error(`Unsafe verification click refused: ${name}`);
  }
  button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  button.click();
  return { text: name, scope };
}
async function click(text, scope = 'body', match = 'exact', index = 0) {
  const action = await execute(domClick, text, scope, match, index);
  await delay();
  return action;
}
async function scrollTop() {
  await execute(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); });
  await delay();
}
async function navigate(page) {
  const visibleNav = await execute(() => [...document.querySelectorAll('nav button')].some(button => {
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }));
  if (!visibleNav) await click('Open menu');
  await click(page, 'nav');
  await waitFor(() => Boolean(document.querySelector('.admin-shell__header h1')), 'admin heading');
  check(`navigate:${page}`, await execute(label => document.querySelector('.admin-shell__header h1')?.textContent.trim().toLowerCase() === label.toLowerCase(), page), page);
  await scrollTop();
}

// Executed inside the real renderer; no app state hooks or injected CSS.
function inspectRenderer(expectedTheme, needsFooter) {
  const all = selector => [...document.querySelectorAll(selector)];
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden') return false;
    if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return false;
    // Ignore children clipped by internal scrollers, but retain document overflow.
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const s = getComputedStyle(parent), r = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(s.overflowY) && (rect.bottom <= r.top || rect.top >= r.bottom)) return false;
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && (rect.right <= r.left || rect.left >= r.right)) return false;
    }
    return true;
  };
  const identify = element => ({ tag: element.tagName, id: element.id, className: element.className?.toString(), text: (element.getAttribute('aria-label') || element.textContent || element.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 110) });
  const rectOf = element => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const parseColor = value => {
    const text = String(value || '').trim();
    if (cache.has(text)) return cache.get(text);
    if (!text || !CSS.supports('color', text)) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = text;
    ctx.fillRect(0, 0, 1, 1);
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    const color = [pixel[0] / 255, pixel[1] / 255, pixel[2] / 255, pixel[3] / 255];
    cache.set(text, color);
    return color;
  };
  const transparent = [0, 0, 0, 0];
  const over = (fg, bg) => {
    const alpha = fg[3] + bg[3] * (1 - fg[3]);
    return alpha ? [0, 1, 2].map(i => (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / alpha).concat(alpha) : transparent;
  };
  const opacity = (color, amount) => [color[0], color[1], color[2], color[3] * amount];
  const luminance = color => color.slice(0, 3).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  const splitCSS = value => {
    let depth = 0, start = 0;
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')') depth--;
      else if (value[i] === ',' && depth === 0) { parts.push(value.slice(start, i).trim()); start = i + 1; }
    }
    parts.push(value.slice(start).trim());
    return parts;
  };
  const ownBackground = element => {
    const style = getComputedStyle(element);
    const images = splitCSS(style.backgroundImage).filter(s => s !== 'none');
    let colors = [parseColor(style.backgroundColor) || transparent];
    const gradients = [], unmodeled = [];
    for (const image of images.reverse()) {
      if (!/gradient\(/.test(image)) { unmodeled.push(image); continue; }
      const parts = splitCSS(image.slice(image.indexOf('(') + 1, -1));
      const stops = [];
      for (const part of parts) {
        // Strip zero, one or two CSS stop positions, retaining color functions.
        const candidate = part.replace(/(?:\s+[-+]?\d*\.?\d+(?:%|px|em|rem|deg|turn)?){1,2}\s*$/, '');
        const color = parseColor(candidate);
        if (color) stops.push({ css: part, color });
      }
      gradients.push({ css: image, stops });
      if (!stops.length) { unmodeled.push(image); continue; }
      colors = stops.flatMap(stop => colors.map(bg => over(stop.color, bg)));
      if (colors.length > 512) { unmodeled.push('background combinations bounded at 512'); colors = colors.slice(0, 512); }
    }
    return { colors, gradients, unmodeled };
  };
  const backgroundCache = new Map();
  const background = element => {
    if (!backgroundCache.has(element)) backgroundCache.set(element, ownBackground(element));
    return backgroundCache.get(element);
  };
  const hasBlur = filter => /blur\([\d.]+px\)/.test(filter) && !/blur\(0(?:px)?\)/.test(filter);
  const glass = all('.admin-shell__sidebar, .admin-shell__header, main .lux-card, main .glass-panel, .form-sheet, .admin-login .glass-panel').filter(visible).slice(0, 24).map(element => {
    const s = getComputedStyle(element), b = background(element);
    const filter = s.backdropFilter;
    // Only product tiles intentionally borrow the catalogue's full frost.
    const parentPane = element.matches('.pos-product-tile') ? element.parentElement.closest('.lux-card, .glass-panel') : null;
    const inheritedFilter = parentPane ? getComputedStyle(parentPane).backdropFilter : null;
    return { ...identify(element), rect: rectOf(element), backgroundColor: s.backgroundColor, backgroundImage: s.backgroundImage, backdropFilter: filter, inheritedFilter, opacity: s.opacity, borderColor: s.borderColor, color: s.color,
      blurred: hasBlur(filter) || Boolean(parentPane && hasBlur(inheritedFilter)), translucent: b.colors.some(c => c[3] < 0.999),
      gradientStops: b.gradients, unmodeled: b.unmodeled };
  });
  const rootStyle = getComputedStyle(document.documentElement);
  const primary = parseColor(rootStyle.getPropertyValue('--text-primary'));
  const dialogs = all('.glass-dialog-backdrop .form-sheet').filter(visible).map(element => {
    const s = getComputedStyle(element);
    const actual = parseColor(s.color);
    return { ...identify(element), rect: rectOf(element), color: s.color,
      themeInkMatches: Boolean(primary && actual && primary.slice(0, 3).every((c, i) => Math.abs(c - actual[i]) < 0.012)),
      backgroundColor: s.backgroundColor, backdropFilter: s.backdropFilter };
  });
  const effectiveOpacity = element => {
    let total = 1;
    for (let node = element; node; node = node.parentElement) total *= Number(getComputedStyle(node).opacity);
    return total;
  };
  const labels = all('label, .lux-label').filter(visible).filter(element => !element.classList.contains('sr-only')).map(element => ({ ...identify(element), opacity: effectiveOpacity(element), color: getComputedStyle(element).color }));
  const representatives = [];
  const add = (kind, elements, pseudo = null, limit = 2) => elements.filter(visible).filter(element => !element.closest('[data-print-preview]')).slice(0, limit).forEach(element => representatives.push({ kind, element, pseudo }));
  const textNodes = all('h1, h2, h3, p, span, th, td, b, dt, dd').filter(element => element.textContent.trim());
  for (const token of ['text-primary', 'text-muted', 'text-subtle']) add(token, textNodes.filter(element => String(element.className).includes(`var(--${token})`)));
  add('label', all('label:not(.sr-only), .lux-label'));
  const inputs = all('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select');
  add('input', inputs);
  add('placeholder', inputs.filter(element => element.placeholder && !element.value), '::placeholder');
  add('active-chip', all('[aria-pressed="true"], .lux-chip, nav .is-active'), null, 3);
  add('primary-gold-button', all('.lux-btn--primary, .pos-pay'), null, 3);
  const contrast = representatives.map(({ kind, element, pseudo }) => {
    const s = getComputedStyle(element, pseudo);
    const foreground = parseColor(s.color);
    if (!foreground) return { kind, ...identify(element), skipped: 'Unsupported foreground color' };
    let samples = [{ bg: transparent, ink: pseudo ? opacity(foreground, Number(s.opacity)) : foreground }];
    const gradientStops = [], unmodeled = [];
    for (let node = element; node; node = node.parentElement) {
      const b = background(node), nodeStyle = getComputedStyle(node);
      if (b.gradients.length) gradientStops.push({ element: identify(node), gradients: b.gradients });
      unmodeled.push(...b.unmodeled);
      const next = [];
      // Iterate backgrounds first so every own gold-button stop is evaluated.
      for (const bg of b.colors) for (const sample of samples) {
        next.push({ bg: opacity(over(sample.bg, bg), Number(nodeStyle.opacity)), ink: opacity(over(sample.ink, bg), Number(nodeStyle.opacity)) });
      }
      samples = next;
      if (samples.length > 512) { unmodeled.push('ancestor combinations bounded at 512'); samples = samples.slice(0, 512); }
    }
    const white = [1, 1, 1, 1];
    const scored = samples.map(sample => {
      const bg = over(sample.bg, white), ink = over(sample.ink, white);
      return { ratio: ratio(ink, bg), background: bg, compositedText: ink };
    }).sort((a, b) => a.ratio - b.ratio);
    const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && Number(s.fontWeight) >= 700);
    const threshold = large ? 3 : 4.5;
    return { kind, ...identify(element), pseudo, foreground: s.color, opacity: effectiveOpacity(element), fontSize: s.fontSize, fontWeight: s.fontWeight,
      threshold, minimumRatio: Number(scored[0].ratio.toFixed(3)), maximumRatio: Number(scored[scored.length - 1].ratio.toFixed(3)),
      belowThreshold: scored[0].ratio < threshold, worstSample: scored[0], samples: scored.length,
      gradientStops, unmodeled: [...new Set(unmodeled)], conservative: true, disabled: Boolean(element.disabled) };
  });
  const footer = document.querySelector('.pos-ticket__footer');
  const pay = document.querySelector('.pos-pay');
  const footerRect = footer ? rectOf(footer) : null;
  const payRect = pay ? rectOf(pay) : null;
  const footerVisible = Boolean(footerRect && payRect && footerRect.y >= 0 && footerRect.bottom <= innerHeight + 1 && payRect.y >= 0 && payRect.bottom <= innerHeight + 1 && payRect.right <= innerWidth + 1);
  const width = document.documentElement.clientWidth;
  const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  return {
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', expectedTheme,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, document: { width, scrollWidth, xOverflow: scrollWidth > width + 1 },
    overflowCandidates: all('main *, .form-sheet *').filter(visible).filter(element => {
      const r = element.getBoundingClientRect();
      if (r.left >= -1 && r.right <= width + 1) return false;
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowX)) return false;
      }
      return true;
    }).slice(0, 15).map(element => ({ ...identify(element), rect: rectOf(element) })),
    glass, dialogs, labels, contrast, needsFooter, footerVisible, footerRect, payRect,
    loginClipped: all('.admin-login main input, .admin-login main button, .admin-login main h1, .admin-login main h2, .admin-login main label, .admin-login main p').filter(visible).filter(element => {
      const pane = element.closest('.glass-panel');
      if (!pane) return false;
      const rect = element.getBoundingClientRect(), boundary = pane.getBoundingClientRect();
      return rect.left < boundary.left - 1 || rect.right > boundary.right + 1
        || (!element.matches('input, .truncate') && element.scrollWidth > element.clientWidth + 1);
    }).map(element => ({ ...identify(element), rect: rectOf(element) })),
    cartLines: all('.pos-ticket__lines li').length,
    errorBoundary: /Failed to load|An unexpected error occurred/.test(document.querySelector('main')?.textContent || ''),
    tokens: Object.fromEntries(['--bg-main', '--bg-card', '--sheet-surface', '--text-primary', '--text-muted', '--text-subtle', '--accent', '--accent-ink', '--glass-filter'].map(token => [token, rootStyle.getPropertyValue(token).trim()])),
  };
}

async function capture(theme, size, page, variant = 'page', needsFooter = false) {
  await delay();
  const name = `${theme}-${size.name}-${page.toLowerCase().replace(/\s+/g, '-')}-${variant}`;
  const inspection = await execute(inspectRenderer, theme, needsFooter);
  const entry = { name, theme, size, page, variant, screenshot: path.join(OUTPUT, `${name}.png`), inspection };
  results.captures.push(entry);
  check(`${name}:theme`, inspection.theme === theme, { actual: inspection.theme, expected: theme });
  check(`${name}:no-document-xoverflow`, !inspection.document.xOverflow, inspection.document);
  check(`${name}:no-uncontained-xoverflow`, inspection.overflowCandidates.length === 0, inspection.overflowCandidates);
  check(`${name}:no-render-error-boundary`, !inspection.errorBoundary, page);
  check(`${name}:no-clipped-login-content`, inspection.loginClipped.length === 0, inspection.loginClipped);
  check(`${name}:has-glass-panes`, inspection.glass.length > 0, inspection.glass.length);
  for (const pane of inspection.glass) {
    check(`${name}:glass-pane`, pane.blurred && pane.translucent, pane);
  }
  for (const dialog of inspection.dialogs) check(`${name}:dialog-active-theme`, dialog.themeInkMatches, dialog);
  for (const label of inspection.labels) check(`${name}:label-opacity`, label.opacity >= 0.99, label);
  if (needsFooter) {
    check(`${name}:populated-basket`, inspection.cartLines >= 3, inspection.cartLines);
    check(`${name}:complete-sale-footer-in-viewport`, inspection.footerVisible, { footer: inspection.footerRect, pay: inspection.payRect, viewport: inspection.viewport });
  }
  for (const sample of inspection.contrast.filter(sample => sample.belowThreshold && !sample.disabled)) {
    results.warnings.push({ kind: 'conservative-contrast', capture: name, sample });
    if (process.env.PREVIEW_STRICT_CONTRAST === '1') fail(`${name}:contrast`, sample);
  }
  const image = await win.webContents.capturePage();
  check(`${name}:nonempty-screenshot`, !image.isEmpty(), image.getSize());
  fs.writeFileSync(entry.screenshot, image.toPNG());
  // Finalization/watchdog writes the accumulated JSON once, avoiding quadratic
  // I/O over the large matrix of compositing evidence.
}

async function populateBasket() {
  await waitFor(() => document.querySelectorAll('.pos-product-tile').length === 8, 'eight fixture products');
  for (const product of ['Preview Mineral Water', 'Preview Orange Juice', 'Preview Cola', 'Preview Mineral Water']) {
    await click(product, '.pos-product-grid', 'contains');
  }
  await execute(() => {
    const input = document.querySelector('#pos-cash-received');
    if (!input) throw new Error('Cash input not found');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '100');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await scrollTop();
}
async function setTheme(theme) {
  await navigate('Settings');
  await click(theme, '[aria-label="Appearance theme"]');
  await delay(); // CSS color transitions may outlast a single 180ms settle.
  check(`settings-button:${theme}`, await execute(mode => {
    const group = document.querySelector('[aria-label="Appearance theme"]');
    return [...group.querySelectorAll('button')].some(button => button.textContent.trim().toLowerCase() === mode && button.getAttribute('aria-pressed') === 'true') && localStorage.getItem('anda_theme_mode') === mode;
  }, theme), theme);
  await scrollTop();
}
async function profileCapture(theme, size) {
  await execute(() => {
    const profile = document.querySelector('.profile-management-page');
    if (!profile) throw new Error('Settings profile panel not found');
    profile.scrollIntoView({ block: 'start', behavior: 'instant' });
  });
  await capture(theme, size, 'Settings', 'profile');
  await execute(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await capture(theme, size, 'Settings', 'profile-bottom');
  await scrollTop();
}
async function dialogCapture(theme, size, page, button, variant, closeButton) {
  await click(button, 'main');
  check(`${theme}:${size.name}:${variant}:opened`, await execute(() => Boolean(document.querySelector('.glass-dialog-backdrop .form-sheet'))), button);
  await capture(theme, size, page, variant);
  await click(closeButton, '.glass-dialog-backdrop');
  check(`${theme}:${size.name}:${variant}:closed-without-save`, await execute(() => !document.querySelector('.glass-dialog-backdrop .form-sheet')), closeButton);
  await scrollTop();
}
async function counterExtras(theme, size) {
  await click('Wholesale', '[aria-label="Choose sale type"]');
  await scrollTop();
  await capture(theme, size, 'Counter', 'wholesale');
  await click('Split payment', '.pos-ticket');
  await scrollTop();
  // Wholesale/split/held expansions are not the standard retail footer test.
  await capture(theme, size, 'Counter', 'split-payment');
  await click('Add another payment', '.pos-ticket');
  await scrollTop();
  await capture(theme, size, 'Counter', 'split-payment-two-tenders');
  await click('Remove split payment', '.pos-ticket');
  await click('Tickets', '.pos-ticket', 'contains');
  await waitFor(() => document.querySelector('.pos-ticket')?.textContent.includes('Preview held ticket'), 'held fixture ticket');
  await execute(() => {
    const heading = [...document.querySelectorAll('.pos-ticket h3')].find(element => element.textContent.trim() === 'Held tickets');
    heading.scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  await capture(theme, size, 'Counter', 'held-tickets');
  await click('Close held sales', '.pos-ticket');
  await click('Retail', '[aria-label="Choose sale type"]');
  await scrollTop();
}

async function run() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const fixtures = makeFixtures();
  const preload = path.join(temp, 'preview-preload.cjs');
  fs.writeFileSync(preload, `(${installPreview.toString()})(${JSON.stringify(fixtures)}, ${JSON.stringify(TARGET.origin)}, ${JSON.stringify(CHANNEL)});\n`);
  await app.whenReady();
  win = new BrowserWindow({
    width: 1440, height: 900, useContentSize: true, show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: true, sandbox: false, backgroundThrottling: false,
      nodeIntegration: false, contextIsolation: false, preload,
      partition: `preview-glass-${process.pid}-${Date.now()}`, webSecurity: true,
      spellcheck: false, navigateOnDragDrop: false,
    },
  });
  const contents = win.webContents;
  const session = contents.session;
  // No HTTPS request is forwarded. The optional font CSS is an empty fixture.
  // This harness uses a local HTTP static server, not a hosted HTTPS app.
  if (TARGET.protocol !== 'http:') throw new Error('Use a local HTTP static server for this isolated preview.');
  session.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.origin === 'https://fonts.googleapis.com' && url.pathname === '/css2' && request.method === 'GET') {
      results.optionalFontFixture = { originalUrl: request.url, offline: true };
      return new Response('/* Optional fonts omitted in offline preview. */', { headers: { 'Content-Type': 'text/css', 'Access-Control-Allow-Origin': '*' } });
    }
    fail('unexpected-https-protocol-request', { url: request.url, method: request.method });
    return new Response('Forbidden in isolated preview.', { status: 403 });
  });
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', (event, item) => { event.preventDefault(); fail('download-attempt', item.getURL()); });
  contents.setWindowOpenHandler(details => { fail('popup-attempt', details.url); return { action: 'deny' }; });
  contents.on('will-attach-webview', event => { event.preventDefault(); fail('webview-attempt', 'Webviews are forbidden in the preview.'); });
  ipcMain.on(CHANNEL, (event, record) => {
    if (event.sender !== contents || !record?.kind) return;
    const { kind, detail } = record;
    if (kind === 'fetch') results.fetches.push(detail);
    else if (kind === 'missingFixture') { results.missingFixtures.push(detail); fail('missingFixture', detail); }
    else if (kind === 'mutation') { results.mutations.push(detail); fail('fetch-mutation', detail); }
    else if (kind === 'deniedFetch') { results.deniedRequests.push({ transport: 'fetch', ...detail }); fail('external-fetch-attempt', detail); }
    else if (kind === 'javascriptError') { results.javascriptErrors.push(detail); fail('renderer-javascript-error', detail); }
    else if (kind === 'preloadReady') { results.preloadReady = detail; }
    else fail(kind, detail);
  });
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let url;
    try { url = new URL(details.url); } catch { /* Invalid addresses are denied. */ }
    const method = String(details.method || 'GET').toUpperCase();
    if (url?.origin === 'https://fonts.googleapis.com' && url.pathname === '/css2' && method === 'GET' && details.resourceType === 'stylesheet') {
      // Fulfilled by session.protocol.handle below, never by the network.
      callback({ cancel: false });
      return;
    }
    const api = url && /(?:^|\/)api(?:\/|$)/i.test(decodeURIComponent(url.pathname));
    const localStatic = url && url.origin === TARGET.origin && ['http:', 'https:'].includes(url.protocol) && !api && method === 'GET' && !['xhr', 'webSocket'].includes(details.resourceType);
    const embedded = url && ['data:', 'blob:'].includes(url.protocol) && method === 'GET' && ['image', 'font', 'media'].includes(details.resourceType);
    if (!localStatic && !embedded) {
      const denied = { transport: 'webRequest', url: details.url, method, resourceType: details.resourceType, reason: api ? 'real /api request' : method !== 'GET' ? 'non-GET' : 'external origin or non-static transport' };
      results.deniedRequests.push(denied);
      fail('actual-network-attempt-denied', denied);
      callback({ cancel: true });
      return;
    }
    if (localStatic) results.staticRequests.push({ url: details.url, method, resourceType: details.resourceType });
    callback({ cancel: false });
  });
  // Catch failed static assets as well as JS exceptions and console.error.
  contents.on('console-message', (...args) => {
    const record = typeof args[1] === 'object' && args[1] !== null
      ? args[1] : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
    const item = { level: record.level, message: record.message, lineNumber: record.lineNumber, sourceId: record.sourceId };
    results.console.push(item);
    if (record.level === 'error' || record.level === 3) fail('renderer-console-error', item);
  });
  contents.on('preload-error', (_event, preloadPath, error) => fail('preload-error', { path: preloadPath, error: String(error) }));
  contents.on('render-process-gone', (_event, details) => { if (!finishing) { fail('renderer-process-gone', details); finish(); } });
  contents.on('did-fail-load', (_event, code, description, url) => fail('renderer-load-failed', { code, description, url }));
  contents.on('will-navigate', (event, url) => {
    const next = new URL(url);
    if (next.origin !== TARGET.origin || /(?:^|\/)api(?:\/|$)/i.test(next.pathname)) {
      event.preventDefault(); fail('forbidden-navigation', url);
    }
  });
  contents.setZoomFactor(1);
  await win.loadURL(TARGET.href);
  if (LOGIN_ONLY) await waitFor(() => Boolean(document.querySelector('.admin-login input[type="password"]')), 'sign-in fixture');
  else await waitFor(() => Boolean(document.querySelector('.admin-shell__header h1')), 'authenticated admin portal');
  check('preload-installed-before-app', Boolean(results.preloadReady), results.preloadReady);
  check('no-real-desktop-bridge', await execute(() => !window.andaPos), 'Desktop sync, updates and printer bridge must not exist.');
  for (const theme of LOGIN_ONLY ? [] : ['light', 'dark']) {
    win.setContentSize(1440, 900);
    contents.setZoomFactor(1);
    await setTheme(theme);
    for (const size of SIZES) {
      win.setContentSize(size.width, size.height);
      contents.setZoomFactor(size.zoom);
      await delay();
      for (const page of PAGES) {
        await navigate(page);
        if (page === 'Counter') await populateBasket();
        const standardFooter = page === 'Counter' && size.name === '1440x900';
        await capture(theme, size, page, 'page', standardFooter);
        if (page === 'Counter' && standardFooter) await counterExtras(theme, size);
        const detailed = size.name === '1440x900';
        const dialogSize = detailed || size.name === '390x844';
        if (page === 'Inventory' && dialogSize) await dialogCapture(theme, size, page, 'Adjust', 'adjust-stock', 'Close');
        if (page === 'Products' && dialogSize) {
          await dialogCapture(theme, size, page, 'Add product', 'add-product', 'Cancel');
          await dialogCapture(theme, size, page, 'Barcode labels', 'barcode-labels', 'Close barcode modal');
        }
        if (page === 'Reports' && detailed) {
          await click('Products', 'main');
          await waitFor(() => document.querySelector('main')?.textContent.includes('Sales by product'), 'product report');
          await capture(theme, size, page, 'products-report');
          await click('Categories', 'main');
          await waitFor(() => document.querySelector('main')?.textContent.includes('Sales by category'), 'category report');
          await capture(theme, size, page, 'categories-report');
        }
        if (page === 'Settings' && detailed) await profileCapture(theme, size);
        if (page === 'About app') {
          check(`${theme}:${size.name}:about-current-version`, await execute(version => {
            const text = document.querySelector('main')?.textContent || '';
            return text.includes(version) && text.includes('latest available version');
          }, fixtures.version), fixtures.version);
        }
      }
    }
  }
  // Allow queued IPC/error reports to arrive before declaring success.
  await delay();
  for (const endpoint of LOGIN_ONLY ? [] : ['/auth', '/products', '/orders', '/catalog', '/settings', '/admin-accounts', '/promo-codes', '/held-sales', '/backups', '/health', '/reports', '/updates/win/latest.yml']) {
    check(`fixture-exercised:${endpoint}`, results.fetches.some(item => new URL(item.url).pathname.endsWith(endpoint)), endpoint);
  }
  if (!LOGIN_ONLY) check('all-nine-pages-both-themes-all-sizes', ['light', 'dark'].every(theme => SIZES.every(size => PAGES.every(page => results.captures.some(capture => capture.theme === theme && capture.size.name === size.name && capture.page === page && capture.variant === 'page')))), results.captures.length);
  // Reload into a signed-out fixture. No logout request or credentials are used.
  await execute(() => sessionStorage.setItem('preview-glass-login', '1'));
  await win.loadURL(TARGET.href);
  await waitFor(() => Boolean(document.querySelector('.admin-login input[type="password"]')), 'sign-in fixture');
  for (const theme of ['light', 'dark']) {
    await execute(mode => {
      if (document.documentElement.classList.contains('dark') !== (mode === 'dark')) {
        document.querySelector('.admin-login button[title^="Switch to "]').click();
      }
    }, theme);
    await delay();
    for (const size of SIZES.filter(size => size.name === '1440x900' || size.name === '390x844')) {
      win.setContentSize(size.width, size.height);
      contents.setZoomFactor(1);
      await scrollTop();
      await capture(theme, size, 'Sign in');
      await execute(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
      await capture(theme, size, 'Sign in', 'form-bottom');
    }
  }
  await delay();
  check('sign-in-both-themes-desktop-mobile', ['light', 'dark'].every(theme => ['1440x900', '390x844'].every(size => results.captures.some(capture => capture.theme === theme && capture.size.name === size && capture.page === 'Sign in'))), results.captures.length);
  check('no-missing-fixtures', results.missingFixtures.length === 0, results.missingFixtures);
  check('no-fetch-mutations', results.mutations.length === 0, results.mutations);
  check('no-real-api-or-external-network-attempts', results.deniedRequests.length === 0, results.deniedRequests);
  check('no-javascript-errors', results.javascriptErrors.length === 0, results.javascriptErrors);
}

run().then(finish).catch(error => { fail('verification-aborted', error.stack || error.message); finish(); });
