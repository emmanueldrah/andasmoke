import type { ApiRequest, ApiResponse } from './_http.js';
import { inArray } from 'drizzle-orm';
import { db, getSetting, setSetting } from '../src/db/index.js';
import { storeSettings } from '../src/db/schema.js';
import { resolveStorePhone } from '../src/lib/storeContact.js';
import { normalizeHardwareSettings } from '../src/lib/hardware.js';
import { requireAdmin } from './_auth.js';
import handleAdminAccounts from './_admin-accounts.js';

const receiptSettingKeys = ['storeName', 'storeEmail', 'storePhone', 'storeAddress'] as const;

/** Where the till's hardware behaviour is stored. */
const HARDWARE_KEY = 'hardware.settings';

/** How long a signed-in till may sit idle before the session is dropped. */
export const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // one day

const IDLE_TIMEOUT_KEY = 'session.idleTimeoutMs';

export function getIdleTimeoutMs(): number {
  const stored = Number(getSetting(IDLE_TIMEOUT_KEY));
  // Clamped to a practical range so managers can balance convenience and security.
  return Number.isFinite(stored) && stored > 0
    ? Math.min(Math.max(stored, 5 * 60 * 1000), 7 * 24 * 60 * 60 * 1000)
    : DEFAULT_IDLE_TIMEOUT_MS;
}

/** Stores the idle timeout, clamped to the same range it is read back under. */
export function setIdleTimeoutMs(value: number): number {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return getIdleTimeoutMs();
  const clamped = Math.min(Math.max(requested, 5 * 60 * 1000), 7 * 24 * 60 * 60 * 1000);
  setSetting(IDLE_TIMEOUT_KEY, String(Math.floor(clamped)));
  return clamped;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.query.resource === 'admin-accounts') return handleAdminAccounts(req, res);

  // ── Hardware settings (scanner timing, label size) ──────────────────────
  // Readable by any signed-in staff member, because the scanner's behaviour
  // affects cashiers too; only a manager may change them.
  if (req.query.resource === 'hardware') {
    const auth = await requireAdmin(req, res, req.method === 'GET'
      ? undefined
      : ['Super Admin', 'Store Manager']);
    if (!auth) return;
    res.setHeader('Cache-Control', 'private, no-store');

    if (req.method === 'GET') {
      const stored = getSetting(HARDWARE_KEY);
      return res.status(200).json(normalizeHardwareSettings(stored ? JSON.parse(stored) : null));
    }

    if (req.method === 'PUT' || req.method === 'PATCH' || req.method === 'POST') {
      const cleaned = normalizeHardwareSettings(req.body);
      setSetting(HARDWARE_KEY, JSON.stringify(cleaned));
      return res.status(200).json(cleaned);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'POS settings are read-only.' });
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  res.setHeader('Cache-Control', 'private, no-store');

  try {
    // The hardware settings ride along with the receipt settings so the counter
    // has one read for everything it needs to boot.
    const rows = await db.select().from(storeSettings).where(inArray(storeSettings.key, [...receiptSettingKeys]));
    const settings = rows.map(row => row.key === 'storePhone'
      ? { ...row, value: resolveStorePhone(row.value) }
      : row);
    const storedHardware = getSetting(HARDWARE_KEY);
    return res.status(200).json({
      settings,
      hardware: normalizeHardwareSettings(storedHardware ? JSON.parse(storedHardware) : null),
    });
  } catch (error) {
    console.error('POS receipt settings error:', error);
    return res.status(500).json({ error: 'Could not load receipt settings.' });
  }
}