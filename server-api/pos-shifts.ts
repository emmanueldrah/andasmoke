/**
 * Shift open and close.
 *
 * The point of a shift is to answer one question at the end of a trading session:
 * "is the drawer exactly as it should be?" That needs the opening float, every
 * cash movement since, and the cash the cashier counted.
 *
 * All arithmetic is in pesewas. `expected cash` is derived, never typed in, so a
 * cashier cannot quietly change the answer before comparing it to the drawer.
 *
 * A shift closes once. Re-closing is refused rather than recalculated, because a
 * closed shift is what a manager later reconciles against the bank.
 */
import type { ApiRequest, ApiResponse } from './_http.js';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, getSqliteHandle } from '../src/db/index.js';
import { orders, posPayments, posShifts } from '../src/db/schema.js';
import { requireAdmin } from './_auth.js';
import { AUDIT_ACTIONS, recordAudit } from './_audit.js';
import { formatMoney, toMajor } from '../src/lib/money.js';
import { ghanaDateString } from '../src/lib/ghanaTime.js';

/** Staff who can hold a shift. */
const SHIFT_ROLES = ['Super Admin', 'Store Manager', 'Cashier'] as const;
/** Staff who may close someone else's shift, or edit a closed one. */
const MANAGER_ROLES = ['Super Admin', 'Store Manager'] as const;

const openSchema = z.object({
  deviceId: z.string().trim().min(1).max(100),
  /** Minor units. */
  openingCash: z.number().int().nonnegative(),
});

const closeSchema = z.object({
  shiftId: z.string().uuid(),
  /** Minor units: what the cashier counted in the drawer. */
  actualCash: z.number().int().nonnegative(),
  notes: z.string().trim().max(1000).optional(),
});

/** A cash movement the cashier records by hand, e.g. a float top-up. */
const cashMovementSchema = z.object({
  shiftId: z.string().uuid(),
  /** Minor units, signed: positive puts money in, negative takes it out. */
  amount: z.number().int().refine(value => value !== 0, 'Enter an amount other than zero.'),
  reason: z.string().trim().min(3, 'Say what this cash was for.').max(200),
});

/**
 * Cash the drawer should hold, in pesewas.
 *
 * Opening float, plus cash sales taken, less cash refunded out, plus or minus
 * anything the cashier recorded by hand. Voided lines are excluded: their stock
 * went back but no money ever entered the drawer, so counting them would inflate
 * the expected figure.
 */
async function computeExpectedCash(shift: {
  id: string;
  openedAt: Date;
  cashierName: string;
  openingCashPesewas?: number | null;
}) {
  const opening = shift.openingCashPesewas ?? 0;

  const [sales] = await db.select({ total: sql<number>`coalesce(sum(${posPayments.amountPesewas}), 0)` })
    .from(posPayments)
    .innerJoin(orders, eq(orders.id, posPayments.orderId))
    .where(and(
      eq(posPayments.method, 'cash-on-delivery'),
      eq(orders.orderSource, 'pos'),
      eq(orders.cashierName, shift.cashierName),
      eq(orders.status, 'Delivered'),
      gte(orders.createdAt, shift.openedAt),
    ));
  const cashSales = Number(sales?.total || 0);

  const [refunds] = await db.select({ total: sql<number>`coalesce(sum(${posPayments.amountPesewas}), 0)` })
    .from(posPayments)
    .innerJoin(orders, eq(orders.id, posPayments.orderId))
    .where(and(
      eq(posPayments.method, 'cash-on-delivery'),
      eq(orders.orderSource, 'pos'),
      eq(orders.cashierName, shift.cashierName),
      eq(orders.status, 'Refunded'),
      gte(orders.createdAt, shift.openedAt),
    ));
  const cashRefunds = Number(refunds?.total || 0);

  const movements = listCashMovements(shift.id);
  const manualIn = movements.filter(row => row.amount > 0).reduce((sum, row) => sum + row.amount, 0);
  const manualOut = movements.filter(row => row.amount < 0).reduce((sum, row) => sum + Math.abs(row.amount), 0);

  return {
    opening,
    cashSales,
    cashRefunds,
    manualIn,
    manualOut,
    expected: opening + cashSales - cashRefunds + manualIn - manualOut,
  };
}

type CashMovement = { id: string; shiftId: string; amount: number; reason: string; createdAt: string };

function listCashMovements(shiftId: string): CashMovement[] {
  const rows = getSqliteHandle()
    .prepare('SELECT id, shift_id, amount_pesewas, reason, created_at FROM shift_cash_movements WHERE shift_id = ? ORDER BY created_at ASC')
    .all(shiftId) as Array<{ id: string; shift_id: string; amount_pesewas: number; reason: string; created_at: number }>;
  return rows.map(row => ({
    id: row.id,
    shiftId: row.shift_id,
    amount: Number(row.amount_pesewas || 0),
    reason: row.reason,
    createdAt: new Date(row.created_at * 1000).toISOString(),
  }));
}

function serialiseBasic(shift: typeof posShifts.$inferSelect) {
  const base = {
    ...shift,
    openingCash: toMajor(shift.openingCashPesewas ?? 0),
    expectedCash: shift.expectedCashPesewas == null ? null : toMajor(shift.expectedCashPesewas),
    actualCash: shift.actualCashPesewas == null ? null : toMajor(shift.actualCashPesewas),
    difference: shift.differencePesewas == null ? null : toMajor(shift.differencePesewas),
    openingCashPesewas: shift.openingCashPesewas ?? 0,
    expectedCashPesewas: shift.expectedCashPesewas,
    actualCashPesewas: shift.actualCashPesewas,
    differencePesewas: shift.differencePesewas,
    openedAt: shift.openedAt.toISOString(),
    closedAt: shift.closedAt?.toISOString() || null,
    day: ghanaDateString(shift.openedAt),
  };
  return base;
}

/**
 * Adds the live cash breakdown, which only an open or just-closed shift needs.
 * Recomputed rather than stored, so it always reflects the current drawer.
 */
async function serializeShift(
  shift: typeof posShifts.$inferSelect,
  options: { withSummary?: boolean } = {},
) {
  const base = serialiseBasic(shift);
  if (!options.withSummary) return base;

  const breakdown = await computeExpectedCash(shift);
  const movements = listCashMovements(shift.id);
  return {
    ...base,
    breakdown: {
      ...breakdown,
      // Display mirrors, so a report can print without importing the money module.
      openingCash: toMajor(breakdown.opening),
      cashSales: toMajor(breakdown.cashSales),
      cashRefunds: toMajor(breakdown.cashRefunds),
      manualIn: toMajor(breakdown.manualIn),
      manualOut: toMajor(breakdown.manualOut),
      expectedCash: toMajor(breakdown.expected),
      expectedCashFormatted: formatMoney(breakdown.expected),
    },
    movements,
  };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    const auth = await requireAdmin(req, res, SHIFT_ROLES);
    if (!auth) return;
    const role = auth.adminRole || '';
    const isManager = (MANAGER_ROLES as readonly string[]).includes(role);

    // ── Read ──────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
      const shiftId = typeof req.query.shiftId === 'string' ? req.query.shiftId.trim() : '';

      // A single shift, with its cash breakdown for the close screen.
      if (shiftId) {
        const [shift] = await db.select().from(posShifts).where(eq(posShifts.id, shiftId)).limit(1);
        if (!shift) return res.status(404).json({ error: 'That shift does not exist.' });
        // A cashier may read their own shift, and a manager may read any.
        if (!isManager && shift.cashierName !== (auth.adminName || auth.email)) {
          return res.status(403).json({ error: 'You can only view your own shift.' });
        }
        return res.status(200).json({ shift: await serializeShift(shift, { withSummary: true }) });
      }

      if (!deviceId) return res.status(400).json({ error: 'Device ID or shift ID is required.' });
      const [open] = await db.select().from(posShifts)
        .where(and(eq(posShifts.deviceId, deviceId), eq(posShifts.status, 'OPEN')))
        .orderBy(desc(posShifts.openedAt))
        .limit(1);

      // Past shifts: a manager sees all, a cashier only their own. The device
      // may have changed between sessions, so this asks for the row rather than
      // the list — and tolerates there being none.
      const history = await db.select().from(posShifts)
        .where(eq(posShifts.deviceId, deviceId))
        .orderBy(desc(posShifts.openedAt))
        .limit(20) ?? [];

      return res.status(200).json({
        shift: open ? await serializeShift(open, { withSummary: true }) : null,
        history: history
          .filter(row => isManager || row.cashierName === (auth.adminName || auth.email))
          // A cashier's history is filtered before serialising, so an unauthorised row is
  // never summarised.
        .map(row => serializeShift(row)),
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ── Open ──────────────────────────────────────────────────────────────
    if (req.query.action === 'open') {
      const parsed = openSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Enter the opening cash for the drawer.' });
      }
      const [existing] = await db.select().from(posShifts)
        .where(and(eq(posShifts.deviceId, parsed.data.deviceId), eq(posShifts.status, 'OPEN')))
        .limit(1);
      if (existing) {
        return res.status(409).json({ error: 'This terminal already has an open shift.', shift: await serializeShift(existing) });
      }

      const openingPesewas = parsed.data.openingCash;
      const [shift] = await db.insert(posShifts).values({
        deviceId: parsed.data.deviceId,
        cashierName: auth.adminName || auth.email,
        openingCash: toMajor(openingPesewas),
        openingCashPesewas: openingPesewas,
        status: 'OPEN',
      }).returning();

      return res.status(201).json({ shift: await serializeShift(shift, { withSummary: true }) });
    }

    // ── Recorded cash in/out ──────────────────────────────────────────────
    if (req.query.action === 'cash-movement') {
      const parsed = cashMovementSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Enter the amount and a reason.' });
      }
      const [shift] = await db.select().from(posShifts).where(eq(posShifts.id, parsed.data.shiftId)).limit(1);
      if (!shift) return res.status(404).json({ error: 'That shift does not exist.' });
      if (shift.status !== 'OPEN') {
        return res.status(409).json({ error: 'This shift is already closed.' });
      }
      if (!isManager && shift.cashierName !== (auth.adminName || auth.email)) {
        return res.status(403).json({ error: 'You can only record cash on your own shift.' });
      }

      getSqliteHandle()
        .prepare('INSERT INTO shift_cash_movements (id, shift_id, amount_pesewas, reason, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), shift.id, parsed.data.amount, parsed.data.reason, Math.floor(Date.now() / 1000));

      return res.status(201).json({
        shift: await serializeShift(shift, { withSummary: true }),
      });
    }

    // ── Close ─────────────────────────────────────────────────────────────
    if (req.query.action === 'close') {
      const parsed = closeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Enter the cash you counted in the drawer.' });
      }
      const [shift] = await db.select().from(posShifts).where(eq(posShifts.id, parsed.data.shiftId)).limit(1);
      if (!shift) return res.status(404).json({ error: 'That shift does not exist.' });

      // A closed shift is a manager's record. Closing it twice would change the
      // figures a reconciliation was based on, so it is refused outright.
      if (shift.status !== 'OPEN') {
        return res.status(409).json({
          error: `This shift was already closed on ${shift.closedAt?.toISOString() ?? 'an earlier date'}.`,
          shift: await serializeShift(shift, { withSummary: true }),
        });
      }

      if (!isManager && shift.cashierName !== (auth.adminName || auth.email)) {
        return res.status(403).json({ error: 'Only the cashier who opened this shift, or a manager, can close it.' });
      }

      const breakdown = await computeExpectedCash(shift);
      const actual = parsed.data.actualCash;
      // Negative when the drawer is short. Recorded either way so a variance can
      // be investigated rather than explained away.
      const difference = actual - breakdown.expected;

      const [closed] = await db.update(posShifts)
        .set({
          status: 'CLOSED',
          expectedCash: toMajor(breakdown.expected),
          expectedCashPesewas: breakdown.expected,
          actualCash: toMajor(actual),
          actualCashPesewas: actual,
          difference: toMajor(difference),
          differencePesewas: difference,
          closedAt: new Date(),
          notes: parsed.data.notes || null,
        })
        // Guarding on OPEN as well as the id makes this atomic: two close
        // requests racing cannot both win.
        .where(and(eq(posShifts.id, shift.id), eq(posShifts.status, 'OPEN')))
        .returning();

      if (!closed) {
        return res.status(409).json({ error: 'This shift was closed by someone else a moment ago.' });
      }

      await recordAudit(auth, {
        action: AUDIT_ACTIONS.SHIFT_CLOSED,
        entityType: 'pos_shift',
        entityId: closed.id,
        metadata: {
          cashierName: closed.cashierName,
          openingCash: breakdown.opening,
          cashSales: breakdown.cashSales,
          cashRefunds: breakdown.cashRefunds,
          manualIn: breakdown.manualIn,
          manualOut: breakdown.manualOut,
          expectedCash: breakdown.expected,
          actualCash: actual,
          difference,
          closedByRole: role,
        },
      });

      return res.status(200).json({
        shift: await serializeShift(closed, { withSummary: true }),
        summary: buildShiftReport(closed, breakdown),
      });
    }

    // ── Edit a closed shift ───────────────────────────────────────────────
    // Managers only, and only after the fact. A cashier can never touch a closed
    // shift, and neither can a manager edit the cash figures — those are the
    // point of the record. Only the free-text note is editable.
    if (req.query.action === 'update-notes') {
      const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim().slice(0, 1000) : '';
      const shiftId = typeof req.query.shiftId === 'string' ? req.query.shiftId : typeof req.body?.shiftId === 'string' ? req.body.shiftId : '';
      if (!shiftId) return res.status(400).json({ error: 'Which shift?' });

      const [shift] = await db.select().from(posShifts).where(eq(posShifts.id, shiftId)).limit(1);
      if (!shift) return res.status(404).json({ error: 'That shift does not exist.' });
      if (!isManager) {
        return res.status(403).json({ error: 'Only the owner or a store manager can edit a shift.' });
      }

      const [updated] = await db.update(posShifts).set({ notes: notes || null }).where(eq(posShifts.id, shiftId)).returning();
      return res.status(200).json({ shift: await serializeShift(updated, { withSummary: true }) });
    }

    return res.status(400).json({ error: 'Unknown shift action.' });
  } catch (error) {
    console.error('POS shift error:', error);
    if (/not a valid amount|already been closed|already closed/i.test((error as Error)?.message || '')) {
      return res.status(400).json({ error: (error as Error).message });
    }
    return res.status(500).json({ error: 'POS shift operation failed.' });
  }
}

/** The figures a manager reconciles a shift against. */
function buildShiftReport(shift: typeof posShifts.$inferSelect, breakdown: Awaited<ReturnType<typeof computeExpectedCash>>) {
  const movements = listCashMovements(shift.id);
  return {
    day: ghanaDateString(shift.openedAt),
    openedAt: shift.openedAt.toISOString(),
    closedAt: shift.closedAt?.toISOString() ?? null,
    cashierName: shift.cashierName,
    lines: [
      { label: 'Opening float', amount: breakdown.opening, formatted: formatMoney(breakdown.opening) },
      { label: 'Cash sales', amount: breakdown.cashSales, formatted: formatMoney(breakdown.cashSales) },
      { label: 'Cash refunds', amount: -breakdown.cashRefunds, formatted: formatMoney(-breakdown.cashRefunds) },
      ...(breakdown.manualIn > 0
        ? [{ label: 'Cash paid in', amount: breakdown.manualIn, formatted: formatMoney(breakdown.manualIn) }]
        : []),
      ...(breakdown.manualOut > 0
        ? [{ label: 'Cash paid out', amount: -breakdown.manualOut, formatted: formatMoney(-breakdown.manualOut) }]
        : []),
      { label: 'Expected in drawer', amount: breakdown.expected, formatted: formatMoney(breakdown.expected), bold: true },
      { label: 'Counted in drawer', amount: shift.actualCashPesewas ?? 0, formatted: formatMoney(shift.actualCashPesewas ?? 0), bold: true },
      {
        label: (shift.differencePesewas ?? 0) === 0 ? 'Balanced' : (shift.differencePesewas ?? 0) < 0 ? 'Short' : 'Over',
        amount: shift.differencePesewas ?? 0,
        formatted: formatMoney(shift.differencePesewas ?? 0),
        bold: true,
      },
    ],
    movements,
    notes: shift.notes,
  };
}

export { computeExpectedCash, serializeShift };