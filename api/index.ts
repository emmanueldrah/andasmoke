import type { ApiRequest, ApiResponse } from '../server-api/_http.js';
import auth from '../server-api/pos-auth.js';
import catalog from '../server-api/catalog.js';
import orders from '../server-api/pos-orders.js';
import posShifts from '../server-api/pos-shifts.js';
import products from '../server-api/products.js';
import promoCodes from '../server-api/promo-codes.js';
import settings from '../server-api/pos-settings.js';

type Handler = (req: ApiRequest, res: ApiResponse) => unknown;
const handlers: Record<string, Handler> = { auth, catalog, orders, 'pos-shifts': posShifts, products, 'promo-codes': promoCodes, settings };

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const rawRoute = req.query.route;
  const route = Array.isArray(rawRoute) ? rawRoute.join('/') : rawRoute;
  const [resource, id] = typeof route === 'string' ? route.split('/') : [];
  if (resource === 'brands') {
    req.query.resource = 'brands';
    return catalog(req, res);
  }
  if (resource === 'categories') {
    return catalog(req, res);
  }
  if (resource === 'admin-accounts') {
    req.query.resource = 'admin-accounts';
    if (id) req.query.id = id;
    return settings(req, res);
  }
  if (resource === 'orders' && id) req.query.id = id;
  if (resource === 'products' && id) req.query.id = id;
  const target = handlers[resource || ''];
  if (!target) return res.status(404).json({ error: 'API route not found' });
  return target(req, res);
}
