/**
 * Dev-only seed: adds a small amount of realistic content to the local dev
 * database through the running API so pages can be audited with real data.
 * Safe to re-run; skips anything that already exists.
 */
const BASE = 'http://127.0.0.1:4310';

async function call(path, { method = 'GET', token, body, query } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

const login = await call('/api/auth', {
  method: 'POST',
  query: { action: 'admin' },
  body: { email: 'audit@andasmoke.local', pin: '246810' },
});
if (login.status !== 200) throw new Error('login failed: ' + JSON.stringify(login));
const token = login.body.token;
console.log('login ok');

const products = [
  { id: 'seed-p1', name: 'Al Fakher Double Apple 250g', brand: 'Al Fakher', department: 'groceries', category: 'shisha', categoryLabel: 'Shisha Flavours', price: '120.00', unit: 'tin', barcode: 'ACS-000101', image: '', images: [''], description: 'Classic double apple molasses.', stockCount: 42 },
  { id: 'seed-p2', name: 'Starbuzz Blue Mist 100g', brand: 'Starbuzz', department: 'groceries', category: 'shisha', categoryLabel: 'Shisha Flavours', price: '95.00', unit: 'tin', barcode: 'ACS-000102', image: '', images: [''], description: 'Blueberry mint.', stockCount: 7 },
  { id: 'seed-p3', name: 'Khalifa Coconut Charcoal 1kg', brand: 'Khalifa', department: 'groceries', category: 'charcoal', categoryLabel: 'Charcoal', price: '60.00', unit: 'box', barcode: 'ACS-000103', image: '', images: [''], description: 'Natural coconut coals.', stockCount: 3 },
  { id: 'seed-p4', name: 'Disposable Vape Grape Ice', brand: 'Vapo', department: 'beauty', category: 'disposables', categoryLabel: 'Disposables', price: '80.00', unit: 'stick', barcode: 'ACS-000104', image: '', images: [''], description: '', stockCount: 15 },
  { id: 'seed-p5', name: 'Hygiene Mouth Tip Pack 50', brand: 'Anda', department: 'beauty', category: 'mouthtips', categoryLabel: 'Accessories', price: '25.00', unit: 'pack', barcode: 'ACS-000105', image: '', images: [''], description: '', stockCount: 0 },
];

for (const p of products) {
  const exists = await call('/api/products/' + p.id, { token });
  if (exists.status === 200) { console.log('product exists:', p.name); continue; }
  const created = await call('/api/products', { method: 'POST', token, body: p });
  console.log('product:', created.status, p.name, created.status >= 400 ? JSON.stringify(created.body) : '');
}

const promo = await call('/api/promo-codes', { method: 'POST', token, body: { code: 'SAVE10', discountType: 'percentage', discountValue: 10, minSpend: 0, isActive: true } });
console.log('promo:', promo.status, promo.status >= 400 && promo.status !== 409 ? JSON.stringify(promo.body) : '');
const promo2 = await call('/api/promo-codes', { method: 'POST', token, body: { code: 'FLAT20', discountType: 'fixed', discountValue: 20, minSpend: 100, isActive: true } });
console.log('promo2:', promo2.status, promo2.status >= 400 && promo2.status !== 409 ? JSON.stringify(promo2.body) : '');

const staff = await call('/api/admin-accounts', { method: 'POST', token, body: { fullName: 'Akosua Cashier', email: 'akosua@andasmoke.local', role: 'cashier', pin: '135724' } });
console.log('staff:', staff.status, staff.status >= 400 && staff.status !== 409 ? JSON.stringify(staff.body) : '');

// A couple of recorded sales so the counter history has content.
const sale = async (key, items, cash) => {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const res = await call('/api/orders', {
    method: 'POST',
    query: { channel: 'pos' },
    token,
    body: {
      idempotencyKey: key,
      subtotal,
      shippingFee: 0,
      discount: 0,
      total: subtotal,
      paymentMethod: 'cash-on-delivery',
      cashReceived: cash,
      shippingAddress: { fullName: 'Walk-in customer', phone: 'In-store sale', city: 'In-store', area: 'Counter' },
      items: items.map(i => ({ product: { id: i.id, price: i.price }, quantity: i.qty })),
    },
  });
  console.log('sale:', res.status, key, res.status >= 400 ? JSON.stringify(res.body).slice(0, 200) : '');
};

await sale(`POS-seed-${Date.now()}-a`, [{ id: 'seed-p1', price: 120, qty: 1 }, { id: 'seed-p3', price: 60, qty: 2 }], 250);
await sale(`POS-seed-${Date.now()}-b`, [{ id: 'seed-p4', price: 80, qty: 1 }], 100);
console.log('done');
