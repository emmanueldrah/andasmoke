/**
 * Route table for the local API server.
 *
 * Each entry is the compiled default export of a handler in ../../server-api.
 * Keeping this in one file means the Electron main process and the dev server
 * register exactly the same routes.
 *
 * Requires ./api-bundle.cjs, which is produced by `npm run build:api`.
 */
const {
  adminAccounts,
  auth,
  backups,
  catalog,
  heldSales,
  orders,
  posImport,
  posShifts,
  products,
  promoCodes,
  reports,
  settings,
  stockIn,
  posSync,
} = require('./api-bundle.cjs');

const handlers = {
  auth,
  'admin-accounts': adminAccounts,
  backups,
  catalog,
  'held-sales': heldSales,
  orders,
  'pos-shifts': posShifts,
  'product-import': posImport,
  products,
  'promo-codes': promoCodes,
  reports,
  settings,
  'stock-in': stockIn,
  'pos-sync': posSync,
};

module.exports = { handlers };