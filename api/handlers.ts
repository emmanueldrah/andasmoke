/**
 * Entry point for the bundled local API.
 *
 * Bundled by scripts/build-api.mjs into electron/api-bundle.cjs so the Electron
 * main process can require every handler from one file. Route names match the
 * paths the renderer requests from fetch('/api/...').
 */
/**
 * Data-layer handles, re-exported so a host process (or a test) can close and
 * reopen the SQLite file to prove persistence. The app itself only needs the
 * handlers.
 */
export { closeDataLayer, getDataLayer, getSqliteHandle, resolveDatabasePath } from '../src/db/index.js';

/**
 * Backup helpers, so the Electron main process and the tests drive the same
 * implementation the API handler uses rather than a second copy.
 */
export {
  DAILY_BACKUP_RETENTION,
  WIPE_CONFIRMATION,
  createBackupIfDue,
  createDailyBackup,
  createManualExport,
  findMissingProductImages,
  lastBackupInfo,
  listDailyBackups,
  restoreBackup,
  restoreExport,
  verifyBackup,
  verifyExport,
  wipeData,
} from '../src/lib/backup.js';

export { createZip, readZip } from '../src/lib/zip.js';

// Barcode encoding and labelling, so tests can decode a generated barcode and
// prove it round-trips rather than trusting the encoder.
export {
  DEFAULT_MODULE_WIDTH_MM,
  MIN_BAR_HEIGHT_MM,
  QUIET_ZONE_MODULES,
  decodeCode128,
  encodeCode128,
  nextInternalBarcode,
  planLabel,
  renderLabelSvg,
} from '../src/lib/code128.js';

export {
  BARCODE_DIGITS,
  BARCODE_PREFIX,
  DEFAULT_HARDWARE_SETTINGS,
  DEFAULT_LABEL_SETTINGS,
  DEFAULT_SCANNER_SETTINGS,
  normalizeHardwareSettings,
  normalizeLabelSettings,
  normalizeScannerSettings,
} from '../src/lib/hardware.js';

export { default as auth } from '../server-api/pos-auth.js';
export { default as adminAccounts } from '../server-api/_admin-accounts.js';
export { default as backups } from '../server-api/backups.js';
export { default as heldSales } from '../server-api/held-sales.js';
export { default as stockIn } from '../server-api/stock-in.js';
export { default as reports } from '../server-api/reports.js';
export { default as posImport } from '../server-api/product-import.js';

/** Health probe: the app's "online" light reflects this, not the internet. */
export {
  checkLocalServer,
  currentHealth,
  isHealthRoute,
  startHealthChecks,
  stopHealthChecks,
} from '../src/lib/health.js';

/** Money is held and calculated in integer pesewas throughout. */
export {
  MINOR_PER_MAJOR,
  addMinor,
  applyPercentageMinor,
  formatMinor,
  formatMoney,
  multiplyMinor,
  requireMinor,
  roundMajor,
  toMajor,
  toMinor,
} from '../src/lib/money.js';

/** Ghana-local dates: GMT, no daylight saving, whatever the machine's clock says. */
export {
  addDays,
  endOfGhanaDay,
  formatGhanaDay,
  ghanaDateRange,
  ghanaDateString,
  ghanaTimeString,
  ghanaToday,
  startOfGhanaDay,
} from '../src/lib/ghanaTime.js';

/** CSV reading and writing, shared by the product import and the reports. */
export {
  buildCsv,
  columnIndex,
  columnIndexAny,
  csvField,
  parseCsv,
} from '../src/lib/csv.js';

/** A self-contained PDF writer, so exports need no external service. */
export { buildPdf } from '../src/lib/pdf.js';

/** Internal barcode sequence and label layout. */
export { parseInternalBarcode } from '../src/lib/code128.js';

/** The barcode high-water mark, which must survive a wipe and a restore. */
export { BARCODE_SEQUENCE_KEY, getBarcodeSequence, setBarcodeSequence } from '../src/db/index.js';

/** How long a signed-in till may sit idle. */
export { DEFAULT_IDLE_TIMEOUT_MS, getIdleTimeoutMs, setIdleTimeoutMs } from '../server-api/pos-settings.js';

/** The scientific-notation check, so the CSV rule can be tested directly. */
export { looksLikeScientificNotation } from '../server-api/product-import.js';
export { default as catalog } from '../server-api/catalog.js';
export { default as orders } from '../server-api/pos-orders.js';
export { default as posShifts } from '../server-api/pos-shifts.js';
export { default as products } from '../server-api/products.js';
export { default as promoCodes } from '../server-api/promo-codes.js';
export { default as settings } from '../server-api/pos-settings.js';