import React, { useState, useEffect } from 'react';
import { Calendar, Download, FileText, TrendingUp, Package, Layers, User } from 'lucide-react';
import { AdminPageHeader, AdminMetricCard } from '../components/AdminPrimitives';
import { api } from '../../../lib/api';
import { useStore } from '../../../context/StoreContext';
import { useAlert } from '../../../context/AlertContext';
import { formatMoney } from '../../../lib/money';
import { ghanaToday } from '../../../lib/ghanaTime';

type ReportType = 'summary' | 'products' | 'categories';

interface ReportTotals {
  gross: number;
  net: number;
  refunded: number;
  discounted: number;
  saleCount: number;
  refundCount: number;
  voidedLines: number;
  grossFormatted: string;
  netFormatted: string;
  refundedFormatted: string;
  discountedFormatted: string;
}

interface SummaryReport {
  range: { from: string; to: string };
  currency: string;
  totals: ReportTotals;
  days: Array<{
    day: string;
    label: string;
    sales: number;
    count: number;
    refunded: number;
    discounted: number;
    salesFormatted: string;
  }>;
  byPayment: Array<{
    method: string;
    amount: number;
    count: number;
    refunded: number;
    amountFormatted: string;
    refundedFormatted: string;
  }>;
  byCashier: Array<{
    cashier: string;
    amount: number;
    count: number;
    refunded: number;
    discounted: number;
    amountFormatted: string;
    refundedFormatted: string;
  }>;
}

interface ProductCategoryReport {
  range: { from: string; to: string };
  currency: string;
  totals: ReportTotals;
  rows: Array<{
    key: string;
    name: string;
    quantity: number;
    amount: number;
  }>;
}

export function AdminReportsScreen() {
  const store = useStore();
  const { showAlert } = useAlert();
  const isCashier = store.adminSession.adminRole === 'Cashier';

  const [activeReport, setActiveReport] = useState<ReportType>('summary');
  const [fromDate, setFromDate] = useState(ghanaToday());
  const [toDate, setToDate] = useState(ghanaToday());
  const [loading, setLoading] = useState(false);
  const [summaryData, setSummaryData] = useState<SummaryReport | null>(null);
  const [productData, setProductData] = useState<ProductCategoryReport | null>(null);
  const [categoryData, setCategoryData] = useState<ProductCategoryReport | null>(null);

  const loadReport = async (report: ReportType, from: string, to: string) => {
    setLoading(true);
    try {
      const data = await api.get<SummaryReport | ProductCategoryReport>(
        `/reports?report=${report}&from=${from}&to=${to}`,
      );
      if (report === 'summary') setSummaryData(data as SummaryReport);
      else if (report === 'products') setProductData(data as ProductCategoryReport);
      else if (report === 'categories') setCategoryData(data as ProductCategoryReport);
    } catch (error: any) {
      showAlert(error?.message || 'Could not load the report.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isCashier) {
      void loadReport(activeReport, fromDate, toDate);
    }
  }, [activeReport, fromDate, toDate, isCashier]);

  const handleExport = async (format: 'csv' | 'pdf') => {
    try {
      const url = `/reports?report=${activeReport}&from=${fromDate}&to=${toDate}&format=${format}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${localStorage.getItem('admin_token') || ''}` },
      });
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `anda-${activeReport}-${fromDate}-to-${toDate}.${format}`;
      link.click();
      URL.revokeObjectURL(link.href);
      showAlert(`Exported ${activeReport} report as ${format.toUpperCase()}`, 'success');
    } catch (error: any) {
      showAlert(error?.message || 'Export failed.', 'error');
    }
  };

  if (isCashier) {
    return (
      <div className="space-y-5">
        <AdminPageHeader description="See your own shift totals and sales." />
        <CashierShiftView />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AdminPageHeader
        description="Daily sales, product breakdowns, and payment methods for any date range."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => void handleExport('csv')} className="lux-btn lux-btn--outline lux-btn--sm">
              <Download className="h-4 w-4" />
              CSV
            </button>
            <button onClick={() => void handleExport('pdf')} className="lux-btn lux-btn--outline lux-btn--sm">
              <FileText className="h-4 w-4" />
              PDF
            </button>
          </div>
        }
      />

      {/* Report type tabs */}
      <div className="flex flex-wrap gap-2 border-b border-[var(--border-color)] pb-2">
        <button
          onClick={() => setActiveReport('summary')}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition ${
            activeReport === 'summary'
              ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
              : 'text-[var(--text-muted)] hover:bg-[var(--bg-soft)] hover:text-[var(--text-primary)]'
          }`}
        >
          <TrendingUp className="h-4 w-4" />
          Summary
        </button>
        <button
          onClick={() => setActiveReport('products')}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition ${
            activeReport === 'products'
              ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
              : 'text-[var(--text-muted)] hover:bg-[var(--bg-soft)] hover:text-[var(--text-primary)]'
          }`}
        >
          <Package className="h-4 w-4" />
          Products
        </button>
        <button
          onClick={() => setActiveReport('categories')}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition ${
            activeReport === 'categories'
              ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
              : 'text-[var(--text-muted)] hover:bg-[var(--bg-soft)] hover:text-[var(--text-primary)]'
          }`}
        >
          <Layers className="h-4 w-4" />
          Categories
        </button>
      </div>

      {/* Date range picker */}
      <div className="lux-card flex flex-wrap items-center gap-3 p-4">
        <Calendar className="h-5 w-5 text-[var(--accent)]" />
        <label className="flex items-center gap-2">
          <span className="text-sm font-bold text-[var(--text-muted)]">From</span>
          <input
            type="date"
            value={fromDate}
            onChange={e => setFromDate(e.target.value)}
            className="lux-input w-auto"
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-sm font-bold text-[var(--text-muted)]">To</span>
          <input
            type="date"
            value={toDate}
            onChange={e => setToDate(e.target.value)}
            className="lux-input w-auto"
          />
        </label>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--accent)] border-t-transparent" />
        </div>
      )}

      {!loading && activeReport === 'summary' && summaryData && (
        <SummaryView data={summaryData} />
      )}

      {!loading && activeReport === 'products' && productData && (
        <ProductCategoryView data={productData} type="product" />
      )}

      {!loading && activeReport === 'categories' && categoryData && (
        <ProductCategoryView data={categoryData} type="category" />
      )}
    </div>
  );
}

function SummaryView({ data }: { data: SummaryReport }) {
  return (
    <div className="space-y-5">
      {/* Totals */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AdminMetricCard
          label="Net Sales"
          value={data.totals.netFormatted}
          detail={`${data.totals.saleCount} sales`}
          icon={TrendingUp}
          accent="green"
        />
        <AdminMetricCard
          label="Gross Sales"
          value={data.totals.grossFormatted}
          detail="Before refunds"
          icon={TrendingUp}
          accent="neutral"
        />
        <AdminMetricCard
          label="Refunds"
          value={data.totals.refundedFormatted}
          detail={`${data.totals.refundCount} refunds`}
          icon={TrendingUp}
          accent="red"
        />
        <AdminMetricCard
          label="Discounts"
          value={data.totals.discountedFormatted}
          detail="Promo codes applied"
          icon={TrendingUp}
          accent="amber"
        />
      </div>

      {/* Daily breakdown */}
      <div className="lux-card overflow-hidden p-0">
        <div className="border-b border-[var(--border-color)] px-4 py-3">
          <h2 className="font-bold text-[var(--text-primary)]">Sales by day</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-sm">
            <thead className="border-b border-[var(--border-color)] bg-[var(--bg-soft)] text-[10px] font-extrabold uppercase tracking-wider text-[var(--text-subtle)]">
              <tr>
                <th className="px-4 py-2">Day</th>
                <th className="px-4 py-2 text-right">Sales</th>
                <th className="px-4 py-2 text-right">Count</th>
                <th className="px-4 py-2 text-right">Refunded</th>
                <th className="px-4 py-2 text-right">Discounts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-color)]">
              {data.days.map(day => (
                <tr key={day.day} className="hover:bg-[var(--accent-soft)]">
                  <td className="px-4 py-2 font-bold text-[var(--text-primary)]">{day.label}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{day.salesFormatted}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{day.count}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--danger)]">{formatMoney(day.refunded)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--highlight)]">{formatMoney(day.discounted)}</td>
                </tr>
              ))}
              {data.days.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                    No sales in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Payment methods */}
      <div className="lux-card overflow-hidden p-0">
        <div className="border-b border-[var(--border-color)] px-4 py-3">
          <h2 className="font-bold text-[var(--text-primary)]">Sales by payment method</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--border-color)] bg-[var(--bg-soft)] text-[10px] font-extrabold uppercase tracking-wider text-[var(--text-subtle)]">
              <tr>
                <th className="px-4 py-2">Method</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2 text-right">Count</th>
                <th className="px-4 py-2 text-right">Refunded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-color)]">
              {data.byPayment.map(row => (
                <tr key={row.method} className="hover:bg-[var(--accent-soft)]">
                  <td className="px-4 py-2 font-bold text-[var(--text-primary)]">{row.method}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.amountFormatted}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.count}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--danger)]">{row.refundedFormatted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cashiers */}
      <div className="lux-card overflow-hidden p-0">
        <div className="border-b border-[var(--border-color)] px-4 py-3">
          <h2 className="font-bold text-[var(--text-primary)]">Sales by cashier</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--border-color)] bg-[var(--bg-soft)] text-[10px] font-extrabold uppercase tracking-wider text-[var(--text-subtle)]">
              <tr>
                <th className="px-4 py-2">Cashier</th>
                <th className="px-4 py-2 text-right">Sales</th>
                <th className="px-4 py-2 text-right">Count</th>
                <th className="px-4 py-2 text-right">Refunded</th>
                <th className="px-4 py-2 text-right">Discounts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-color)]">
              {data.byCashier.map(row => (
                <tr key={row.cashier} className="hover:bg-[var(--accent-soft)]">
                  <td className="px-4 py-2 font-bold text-[var(--text-primary)]">{row.cashier}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.amountFormatted}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.count}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--danger)]">{row.refundedFormatted}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[var(--highlight)]">{formatMoney(row.discounted)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ProductCategoryView({ data, type }: { data: ProductCategoryReport; type: 'product' | 'category' }) {
  return (
    <div className="space-y-5">
      {/* Totals */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AdminMetricCard
          label="Net Sales"
          value={data.totals.netFormatted}
          detail={`${data.totals.saleCount} sales`}
          icon={TrendingUp}
          accent="green"
        />
        <AdminMetricCard
          label="Gross Sales"
          value={data.totals.grossFormatted}
          detail="Before refunds"
          icon={TrendingUp}
          accent="neutral"
        />
        <AdminMetricCard
          label="Refunds"
          value={data.totals.refundedFormatted}
          detail={`${data.totals.refundCount} refunds`}
          icon={TrendingUp}
          accent="red"
        />
        <AdminMetricCard
          label="Discounts"
          value={data.totals.discountedFormatted}
          detail="Promo codes applied"
          icon={TrendingUp}
          accent="amber"
        />
      </div>

      {/* Product/Category table */}
      <div className="lux-card overflow-hidden p-0">
        <div className="border-b border-[var(--border-color)] px-4 py-3">
          <h2 className="font-bold text-[var(--text-primary)]">
            {type === 'product' ? 'Sales by product' : 'Sales by category'}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--border-color)] bg-[var(--bg-soft)] text-[10px] font-extrabold uppercase tracking-wider text-[var(--text-subtle)]">
              <tr>
                <th className="px-4 py-2">{type === 'product' ? 'Product' : 'Category'}</th>
                <th className="px-4 py-2 text-right">Units sold</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-color)]">
              {data.rows.map(row => (
                <tr key={row.key} className="hover:bg-[var(--accent-soft)]">
                  <td className="px-4 py-2 font-bold text-[var(--text-primary)]">{row.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{row.quantity}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatMoney(row.amount)}</td>
                </tr>
              ))}
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                    No sales in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CashierShiftView() {
  const { showAlert } = useAlert();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<{
    shift: { id: string; openedAt: string; openingCashPesewas: number; openingCash: number } | null;
    sales: { net: number; saleCount: number; netFormatted: string } | null;
  } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const result = await api.get<typeof data>('/reports?report=my-shift');
        setData(result);
      } catch (error: any) {
        showAlert(error?.message || 'Could not load your shift.', 'error');
      } finally {
        setLoading(false);
      }
    })();
  }, [showAlert]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--accent)] border-t-transparent" />
      </div>
    );
  }

  if (!data?.shift) {
    return (
      <div className="lux-card p-8 text-center">
        <User className="mx-auto h-12 w-12 text-[var(--text-muted)]" />
        <p className="mt-4 text-sm text-[var(--text-muted)]">You don't have an open shift right now.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <AdminMetricCard
          label="Your Sales"
          value={data.sales?.netFormatted || 'GHS 0.00'}
          detail={`${data.sales?.saleCount || 0} sales this shift`}
          icon={TrendingUp}
          accent="green"
        />
        <AdminMetricCard
          label="Opening Cash"
          value={`GHS ${data.shift.openingCash.toFixed(2)}`}
          detail="Drawer start"
          icon={TrendingUp}
          accent="neutral"
        />
      </div>
      <div className="lux-card p-5">
        <p className="text-sm text-[var(--text-muted)]">
          Shift opened at {new Date(data.shift.openedAt).toLocaleString('en-GB', { timeZone: 'Africa/Accra' })}
        </p>
      </div>
    </div>
  );
}
