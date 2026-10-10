import type { ApiRequest, ApiResponse } from './_http.js';
import { and, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../src/db/index.js';
import { orders, posPayments, posShifts } from '../src/db/schema.js';
import { requireAdmin } from './_auth.js';
import { formatMoney, requireMinor, toMajor } from '../src/lib/money.js';
import {
  endOfGhanaDay,
  formatGhanaDay,
  ghanaDateRange,
  ghanaDateString,
  ghanaToday,
  startOfGhanaDay,
} from '../src/lib/ghanaTime.js';
import { buildCsv, csvCell } from '../src/lib/csv.js';
import { buildPdf } from '../src/lib/pdf.js';

/**
 * Sales reporting.
 *
 * Manager-only in full. A cashier may see their own current shift and nothing
 * else: totals for the whole shop are a management matter, and a till that shows
 * every cashier's takings to every cashier invites arguments at the till.
 *
 * Every figure is in pesewas and reported per Ghana-local day, so a date range
 * means the same set of sales regardless of the machine's clock or timezone.
 */

/** Roles that may see shop-wide reports. */
const MANAGER_ROLES = ['Super Admin', 'Store Manager'] as const;

const rangeSchema = z.object({
  from: z.string().trim(),
  to: z.string().trim(),
});

/** Cap on a single request, so a wide range cannot stall the till. */
const MAX_DAYS = 366;

/** How money is named in a receipt. */
const PAYMENT_LABELS: Record<string, string> = {
  'cash-on-delivery': 'Cash',
  'momo-mtn': 'MTN Mobile Money',
};

type SaleRow = {
  id: string;
  orderNumber: string;
  createdAt: Date;
  total: number;
  discount: number;
  status: string;
  cashierName: string | null;
  appliedPromoCode: string | null;
  voidedLines: unknown;
  items: unknown;
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    const auth = await requireAdmin(req, res);
    if (!auth) return;
    const role = auth.adminRole || '';
    const isManager = (MANAGER_ROLES as readonly string[]).includes(role);
    const cashierName = auth.adminName || auth.email;

    const report = typeof req.query.report === 'string' ? req.query.report : 'summary';
    const format = typeof req.query.format === 'string' ? req.query.format : 'json';
    const parsedRange = rangeSchema.safeParse({
      from: typeof req.query.from === 'string' ? req.query.from : ghanaToday(),
      to: typeof req.query.to === 'string' ? req.query.to : ghanaToday(),
    });
    if (!parsedRange.success) {
      return res.status(400).json({ error: 'Choose a start and end date.' });
    }

    // ── A cashier's own current shift ─────────────────────────────────────
    if (report === 'my-shift') {
      const [shift] = await db.select().from(posShifts)
        .where(and(sql`status = 'OPEN'`, sql`cashier_name = ${cashierName}`))
        .orderBy(sql`opened_at DESC`)
        .limit(1);
      if (!shift) return res.status(200).json({ shift: null, sales: [] });
      const sales = await loadSales(shift.openedAt, new Date(Date.now() + 86_400_000), cashierName);
      return res.status(200).json({
        shift: {
          id: shift.id,
          openedAt: shift.openedAt.toISOString(),
          openingCashPesewas: shift.openingCashPesewas ?? 0,
          openingCash: toMajor(shift.openingCashPesewas ?? 0),
        },
        sales: { ...summarise(sales), days: [] },
      });
    }

    if (!isManager) {
      return res.status(403).json({ error: 'Shop-wide reports are available to the owner and store managers.' });
    }

    const days = ghanaDateRange(parsedRange.data.from, parsedRange.data.to);
    if (days.length === 0) {
      return res.status(400).json({ error: 'The end date is before the start date.' });
    }
    if (days.length > MAX_DAYS) {
      return res.status(400).json({ error: `Choose a range of ${MAX_DAYS} days or fewer.` });
    }

    const from = startOfGhanaDay(days[0]);
    const to = endOfGhanaDay(days[days.length - 1]);
    const sales = await loadSales(from, to);

    const payload = buildReport(report, sales, days, { from: days[0], to: days[days.length - 1] });

    // ── Exports ───────────────────────────────────────────────────────────
    if (format === 'csv') {
      const csv = buildCsv(payload.csv);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      // The BOM makes Excel read the file as UTF-8 rather than the local
      // codepage, which would mangle any non-ASCII product name.
      res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}.csv"`);
      return res.status(200).end(`﻿${csv}`);
    }

    if (format === 'pdf') {
      const pdf = buildPdf({
        title: payload.title,
        subtitle: `${formatGhanaDay(days[0])} to ${formatGhanaDay(days[days.length - 1])}`,
        sections: [payload.pdf],
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}.pdf"`);
      return res.status(200).end(pdf);
    }

    return res.status(200).json(payload.data);
  } catch (error: any) {
    console.error('Reports API error:', error);
    if (/Expected a date|not a real date|before the start date|range of/i.test(error?.message || '')) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Could not build that report.' });
  }
}

/** POS sales in a window, with refunded and voided figures already separated. */
async function loadSales(from: Date, to: Date, cashier?: string): Promise<SaleRow[]> {
  const conditions = [
    sql`order_source = 'pos'`,
    gte(orders.createdAt, from),
    lt(orders.createdAt, to),
  ];
  if (cashier) conditions.push(sql`cashier_name = ${cashier}`);

  const rows = await db.select({
    id: orders.id,
    orderNumber: orders.orderNumber,
    createdAt: orders.createdAt,
    total: orders.totalPesewas,
    discount: orders.discountPesewas,
    status: orders.status,
    cashierName: orders.cashierName,
    appliedPromoCode: orders.appliedPromoCode,
    voidedLines: orders.voidedLines,
    items: orders.items,
  }).from(orders).where(and(...conditions));

// Attach each sale's tenders, so a split payment is counted against the right
  // method rather than against whichever happened to be listed first.
  const ids = rows.map(row => row.id);
  const payments = ids.length
    ? await db.select({
      orderId: posPayments.orderId,
      method: posPayments.method,
      amount: posPayments.amountPesewas,
    }).from(posPayments).where(inArray(posPayments.orderId, ids))
    : [];

  return rows.map(row => ({
    ...row,
    total: Number(row.total) || 0,
    discount: Number(row.discount) || 0,
    tenders: payments.filter(payment => payment.orderId === row.id),
  })) as SaleRow[];
}



/**
 * Rolls sales up into the figures a report needs.
 *
 * A refunded sale contributes nothing to takings but is counted separately, so a
 * day's total is never quietly reduced by a refund that a manager has to then
 * reconcile against a different number.
 */
function summarise(sales: SaleRow[]) {
  const byPayment: Record<string, { amount: number; count: number; refunded: number; refundedCount: number }> = {};
  const byCashier: Record<string, { amount: number; count: number; refunded: number; discounted: number }> = {};
  const byDay: Record<string, { amount: number; count: number; refunded: number; discounted: number }> = {};
  const byProduct: Record<string, { name: string; quantity: number; amount: number }> = {};
  const byCategory: Record<string, { name: string; quantity: number; amount: number }> = {};

  let gross = 0;
  let net = 0;
  let refunded = 0;
  let discounted = 0;
  let voidedLines = 0;

  for (const sale of sales) {
    const total = Number(sale.total) || 0;
    const isRefunded = sale.status === 'Refunded';
    const day = formatDay(sale.createdAt);

    // Split across the tenders recorded for this sale.
    const tenders = (sale as any).tenders as Array<{ method: string; amount: number }> | undefined;
    const tenderRows = tenders && tenders.length
      ? tenders
      : [{ method: 'cash-on-delivery', amount: total }];

    for (const tender of tenderRows) {
      const label = PAYMENT_LABELS[tender.method] || tender.method;
      const bucket = (byPayment[label] ||= { amount: 0, count: 0, refunded: 0, refundedCount: 0 });
      if (isRefunded) {
        bucket.refunded += Number(tender.amount) || 0;
        bucket.refundedCount++;
      } else {
        bucket.amount += Number(tender.amount) || 0;
        bucket.count++;
      }
    }

    const cashier = sale.cashierName || 'Unknown';
    const cashierBucket = (byCashier[cashier] ||= { amount: 0, count: 0, refunded: 0, discounted: 0 });
    const dayBucket = (byDay[day] ||= { amount: 0, count: 0, refunded: 0, discounted: 0 });
    gross += total;

    if (isRefunded) {
      refunded += total;
      cashierBucket.refunded += total;
      dayBucket.refunded += total;
    } else {
      net += total;
      cashierBucket.amount += total;
      cashierBucket.count++;
      dayBucket.amount += total;
      dayBucket.count++;
    }

    if (!isRefunded && Number(sale.discount) > 0) {
      discounted += Number(sale.discount);
      cashierBucket.discounted += Number(sale.discount);
      dayBucket.discounted += Number(sale.discount);
    }

    const voided = Array.isArray(sale.voidedLines) ? sale.voidedLines.length : 0;
    voidedLines += voided;

    // Line-level breakdown, skipping lines that were voided: those goods went
    // back and the money with them.
    for (const entry of (Array.isArray(sale.items) ? sale.items : []) as any[]) {
      const product = entry?.product || {};
      const key = String(product.id || 'unknown');
      const productBucket = (byProduct[key] ||= { name: product.name || key, quantity: 0, amount: 0 });
      const categoryBucket = (byCategory[product.category || 'other'] ||= {
        name: product.categoryLabel || product.category || 'Uncategorised',
        quantity: 0,
        amount: 0,
      });

      const quantity = Number(entry?.quantity) || 0;
      const lineAmount = quantity * requireMinor(product.price, 'price');

      if (!isRefunded) {
        productBucket.quantity += quantity;
        productBucket.amount += lineAmount;
        categoryBucket.quantity += quantity;
        categoryBucket.amount += lineAmount;
      }
    }
  }

  return {
    gross, net, refunded, discounted, voidedLines,
    saleCount: sales.filter(sale => sale.status !== 'Refunded').length,
    refundCount: sales.filter(sale => sale.status === 'Refunded').length,
    byPayment, byCashier, byDay, byProduct, byCategory,
  };
}

function formatDay(instant: Date): string {
  // Ghana-local day, consistent with the date range.
  return ghanaDateString(instant);
}

function buildReport(
  report: string,
  sales: SaleRow[],
  days: string[],
  range: { from: string; to: string },
) {
  const totals = summarise(sales);

  const base = {
    range,
    currency: 'GHS',
    totals: {
      gross: toMajor(totals.gross),
      net: toMajor(totals.net),
      refunded: toMajor(totals.refunded),
      discounted: toMajor(totals.discounted),
      saleCount: totals.saleCount,
      refundCount: totals.refundCount,
      voidedLines: totals.voidedLines,
      grossFormatted: formatMoney(totals.gross),
      netFormatted: formatMoney(totals.net),
      refundedFormatted: formatMoney(totals.refunded),
      discountedFormatted: formatMoney(totals.discounted),
    },
  };

  if (report === 'products' || report === 'categories') {
    const source = report === 'products' ? totals.byProduct : totals.byCategory;
    const rows = Object.entries(source)
      .map(([key, value]) => ({ key, name: value.name, quantity: value.quantity, amount: toMajor(value.amount) }))
      .sort((a, b) => b.amount - a.amount);

    return {
      ...base,
      title: report === 'products' ? 'Sales by product' : 'Sales by category',
      filename: `anda-sales-by-${report}`,
      data: { ...base, rows },
      csv: {
        header: report === 'products'
          ? ['Product ID', 'Product', 'Units sold', 'Amount (GHS)']
          : ['Category', 'Name', 'Units sold', 'Amount (GHS)'],
        rows: rows.map(row => report === 'products'
          ? [row.key, row.name, String(row.quantity), row.amount.toFixed(2)]
          : [row.key, row.name, String(row.quantity), row.amount.toFixed(2)]),
      },
      pdf: {
        table: {
          title: report === 'products' ? 'Sales by product' : 'Sales by category',
          columns: report === 'products' ? ['Product', 'Units', 'Amount'] : ['Category', 'Units', 'Amount'],
          rows: rows.map(row => [row.name, String(row.quantity), `GHS ${row.amount.toFixed(2)}`]),
        },
        keyValues: summaryPairs(base.totals),
      },
    };
  }

  // Daily summary, with the payment and cashier breakdowns alongside it.
  const dayRows = days.map(day => {
    const bucket = totals.byDay[day] || { amount: 0, count: 0, refunded: 0, discounted: 0 };
    return {
      day,
      label: formatGhanaDay(day),
      sales: toMajor(bucket.amount),
      count: bucket.count,
      refunded: toMajor(bucket.refunded),
      discounted: toMajor(bucket.discounted),
      salesFormatted: formatMoney(bucket.amount),
    };
  });

  const paymentRows = Object.entries(totals.byPayment).map(([label, value]) => ({
    method: label,
    amount: toMajor(value.amount),
    count: value.count,
    refunded: toMajor(value.refunded),
    amountFormatted: formatMoney(value.amount),
    refundedFormatted: formatMoney(value.refunded),
  }));

  const cashierRows = Object.entries(totals.byCashier).map(([name, value]) => ({
    cashier: name,
    amount: toMajor(value.amount),
    count: value.count,
    refunded: toMajor(value.refunded),
    discounted: toMajor(value.discounted),
    amountFormatted: formatMoney(value.amount),
    refundedFormatted: formatMoney(value.refunded),
  }));

  return {
    ...base,
    title: 'Sales summary',
    filename: 'anda-sales-summary',
    data: { ...base, days: dayRows, byPayment: paymentRows, byCashier: cashierRows },
    csv: {
      header: ['Day', 'Sales', 'Sales count', 'Refunded', 'Discounts given'],
      rows: dayRows.map(row => [row.day, row.sales.toFixed(2), String(row.count), row.refunded.toFixed(2), row.discounted.toFixed(2)]),
    },
    pdf: {
      table: {
        title: 'Sales by day',
        columns: ['Day', 'Sales', 'Count', 'Refunded', 'Discounts'],
        rows: dayRows.map(row => [row.day, `GHS ${row.sales.toFixed(2)}`, String(row.count), `GHS ${row.refunded.toFixed(2)}`, `GHS ${row.discounted.toFixed(2)}`]),
      },
      keyValues: summaryPairs(base.totals),
      secondTable: {
        title: 'Sales by payment type',
        columns: ['Payment', 'Amount', 'Count', 'Refunded'],
        rows: paymentRows.map(row => [row.method, `GHS ${row.amount.toFixed(2)}`, String(row.count), `GHS ${row.refunded.toFixed(2)}`]),
      },
    },
  };
}

function summaryPairs(totals: {
  grossFormatted: string;
  refundedFormatted: string;
  discountedFormatted: string;
  saleCount: number;
  refundCount: number;
  voidedLines: number;
}): Array<[string, string]> {
  return [
    ['Gross sales', totals.grossFormatted],
    ['Refunds', totals.refundedFormatted],
    ['Discounts given', totals.discountedFormatted],
    ['Sales counted', String(totals.saleCount)],
    ['Refunds counted', String(totals.refundCount)],
    ['Lines voided', String(totals.voidedLines)],
  ];
}

export { summarise, buildReport, csvCell, PAYMENT_LABELS };