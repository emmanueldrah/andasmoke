/**
 * One place to write audit rows.
 *
 * Every money- and stock-affecting action lands here so the log is a complete
 * record rather than whatever individual handlers remembered to record. The
 * action names are listed in {@link AUDIT_ACTIONS} so a missing one is obvious.
 */
import type { ApiResponse } from './_http.js';
import { db } from '../src/db/index.js';
import { auditLogs } from '../src/db/schema.js';
import type { AuthSession } from './_auth.js';

/**
 * Every action the till records.
 *
 * Keep this list authoritative: a new action should be added here and nowhere
 * else, so reviewing the log is reviewing this set.
 */
export const AUDIT_ACTIONS = {
  /** Staff signed in successfully. */
  LOGIN: 'STAFF_LOGIN',
  /** Staff signed in with a wrong PIN or unknown email. */
  LOGIN_FAILED: 'STAFF_LOGIN_FAILED',
  /** The till was signed out, for example when a shift closed. */
  SESSION_SIGNED_OUT: 'STAFF_SESSION_SIGNED_OUT',
  /** A sign-in was refused because the account was locked out. */
  LOGIN_BLOCKED: 'STAFF_LOGIN_BLOCKED',
  /** A staff account was created, edited or removed. */
  ACCOUNT_CHANGED: 'STAFF_ACCOUNT_CHANGED',
  /** A completed POS sale. */
  SALE: 'POS_SALE_COMPLETED',
  /** A completed sale was refunded. */
  REFUND: 'POS_SALE_REFUNDED',
  /** A line was removed from an unpaid ticket. */
  VOID_LINE: 'POS_LINE_VOIDED',
  /** A held ticket was put aside or recalled. */
  HELD_SALE: 'POS_HELD_SALE',
  /** Stock was edited outside a sale. */
  STOCK_ADJUSTED: 'INVENTORY_STOCK_ADJUSTED',
  /** A product's price changed. */
  PRICE_CHANGED: 'PRODUCT_PRICE_CHANGED',
  /** The catalogue was changed by a CSV import. */
  PRODUCTS_IMPORTED: 'PRODUCTS_IMPORTED',
/** A promo or discount was created, changed or removed. */
  DISCOUNT_CHANGED: 'DISCOUNT_CHANGED',
  /** A promo or manual discount was applied to a sale. */
  DISCOUNT_APPLIED: 'POS_DISCOUNT_APPLIED',
  /** A shift was closed, with the cash reconciliation recorded. */
  SHIFT_CLOSED: 'POS_SHIFT_CLOSED',
  /** The till's data files were backed up, restored or erased. */
  DATA_MAINTENANCE: 'DATA_MAINTENANCE',
} as const;

export type AuditAction = typeof AUDIT_ACTIONS[keyof typeof AUDIT_ACTIONS];

type AuditEntry = {
  action: AuditAction | string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
};

/**
 * Writes one audit row.
 *
 * Deliberately never throws: a failure to record must not roll back or block
 * the business action that triggered it, so the error is logged instead.
 */
export async function recordAudit(session: AuthSession | null, entry: AuditEntry): Promise<void> {
  try {
    if (!entry.action) {
      console.error('Audit entry with no action was skipped:', entry.entityType, entry.entityId);
      return;
    }
    await db.insert(auditLogs).values({
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      actorName: session?.adminName || session?.email || 'system',
      metadata: { ...(entry.metadata || {}), adminId: session?.sub ?? null },
    });
  } catch (error) {
    console.error('Could not write audit log entry:', error);
  }
}

/** Reads recent entries, newest first, for an admin screen. */
export async function listAudit(limit = 100) {
  const rows = await db.select().from(auditLogs).limit(Math.min(Math.max(limit, 1), 500));
  return rows.reverse();
}

/** Sends a 403 with a consistent body; used when an action needs another role. */
export function forbidden(res: ApiResponse, message: string) {
  return res.status(403).json({ error: message });
}