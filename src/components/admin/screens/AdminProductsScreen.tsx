import React, { useMemo, useState } from 'react';
import {
  Plus,
  Trash2,
  Download,
  Package,
  AlertTriangle,
  X,
  Check,
  Tag,
  ScanLine,
  Minus,
  Eye,
  EyeOff,
  ChevronRight,
} from 'lucide-react';
import { useStore } from '../../../context/StoreContext';
import { useAlert } from '../../../context/AlertContext';
import { Product } from '../../../types';
import { isRenderableProductImage } from '../../../lib/productImages';
import { AdminEmptyState, AdminPageHeader, AdminStatStrip } from '../components/AdminPrimitives';
import { BarcodeLabelsModal } from '../components/BarcodeLabelsModal';

interface ProductsScreenProps {
  onAddProduct?: () => void;
  onEditProduct?: (product: Product) => void;
}

type StockFilter = 'all' | 'in' | 'low' | 'out';
type GroupFilter = 'all' | 'beauty' | 'groceries';

const LOW_STOCK_THRESHOLD = 5;

export const AdminProductsScreen: React.FC<ProductsScreenProps> = ({
  onAddProduct,
  onEditProduct,
}) => {
  const store = useStore();
  const { showAlert } = useAlert();
  const [searchTerm, setSearchTerm] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState<GroupFilter>('all');
  const [stockFilter, setStockFilter] = useState<StockFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [barcodeModalOpen, setBarcodeModalOpen] = useState(false);
  const [barcodeInitialProductId, setBarcodeInitialProductId] = useState<string | undefined>(undefined);

  const stats = useMemo(() => {
    const products = store.products || [];
    return {
      total: products.length,
      available: products.filter(p => p.isPublished !== false).length,
      units: products.reduce((sum, p) => sum + (p.stockCount || 0), 0),
      lowStock: products.filter(p => (p.stockCount || 0) > 0 && (p.stockCount || 0) <= LOW_STOCK_THRESHOLD).length,
      outOfStock: products.filter(p => (p.stockCount || 0) === 0).length,
    };
  }, [store.products]);

  /**
   * One filter pipeline for the whole screen. Barcodes and serial numbers are
   * searched alongside names so a scanner can drive this list directly.
   */
  const filteredProducts = useMemo(() => {
    let products = store.products || [];

    if (departmentFilter !== 'all') products = products.filter(p => p.department === departmentFilter);

    if (stockFilter !== 'all') {
      if (stockFilter === 'out') products = products.filter(p => (p.stockCount || 0) === 0);
      else if (stockFilter === 'low') products = products.filter(p => (p.stockCount || 0) > 0 && (p.stockCount || 0) <= LOW_STOCK_THRESHOLD);
      else if (stockFilter === 'in') products = products.filter(p => (p.stockCount || 0) > LOW_STOCK_THRESHOLD);
    }

    const query = searchTerm.trim().toLowerCase();
    if (query) {
      products = products.filter(p =>
        (p.name || '').toLowerCase().includes(query) ||
        (p.brand || '').toLowerCase().includes(query) ||
        (p.categoryLabel || '').toLowerCase().includes(query) ||
        (p.barcode || '').toLowerCase().includes(query) ||
        (p.serialNumber || '').toLowerCase().includes(query),
      );
    }

    // Restock problems first: that is what a manager opens this screen for.
    return [...products].sort((a, b) => {
      const rank = (p: Product) => (p.stockCount || 0) === 0 ? 0 : (p.stockCount || 0) <= LOW_STOCK_THRESHOLD ? 1 : 2;
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : (a.name || '').localeCompare(b.name || '');
    });
  }, [store.products, departmentFilter, stockFilter, searchTerm]);

  const runProductAction = async (id: string, action: () => Promise<void>) => {
    if (busyId) return;
    setBusyId(id);
    try {
      await action();
    } catch (error: any) {
      showAlert(error?.message || 'That change could not be saved.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  /** Restocking at the counter should never need the edit modal. */
  const adjustStock = (product: Product, delta: number) => {
    const next = Math.max(0, (product.stockCount || 0) + delta);
    if (next === product.stockCount) return;
    void runProductAction(product.id, () => store.updateProductStock(product.id, next, next > 0));
  };

  const handleDeleteProduct = (product: Product) => {
    if (confirmDeleteId !== product.id) {
      setConfirmDeleteId(product.id);
      setTimeout(() => setConfirmDeleteId(null), 4000);
      return;
    }
    void runProductAction(product.id, async () => {
      await store.deleteProduct(product.id);
      showAlert(`${product.name} deleted`, 'success');
    });
  };

  const handleTogglePublish = (product: Product) => {
    const activate = product.isPublished === false;
    void runProductAction(product.id, async () => {
      await store.updateProduct(product.id, { isPublished: activate });
      showAlert(`${product.name} ${activate ? 'is now sellable at the register' : 'is hidden from the register'}`, 'success');
    });
  };

  const handleExport = () => {
    try {
      const csv = [
        ['ID', 'Name', 'Brand', 'Category', 'Price', 'Wholesale', 'Stock', 'Active at POS', 'Barcode', 'Serial'],
        ...filteredProducts.map(p => [
          p.id,
          p.name,
          p.brand,
          p.categoryLabel,
          p.price,
          p.wholesalePrice ?? '',
          p.stockCount,
          p.isPublished !== false ? 'Yes' : 'No',
          p.barcode ?? '',
          p.serialNumber ?? '',
        ]),
      ]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\n');

      const url = window.URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `products-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      window.URL.revokeObjectURL(url);
      showAlert(`Exported ${filteredProducts.length} products`, 'success');
    } catch {
      showAlert('Export failed', 'error');
    }
  };

  const stockTone = (count: number) =>
    count === 0 ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
      : count <= LOW_STOCK_THRESHOLD ? 'bg-[color-mix(in_srgb,var(--highlight)_16%,transparent)] text-[var(--highlight)]'
        : 'bg-[var(--jade-soft)] text-[var(--jade)]';

  const filterPill = (active: boolean) =>
    `rounded-lg px-3 py-2 text-[11px] font-bold transition ${
      active ? 'bg-[var(--accent)] text-white shadow-sm' : 'bg-[var(--bg-soft)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
    }`;

  return (
    <div className="space-y-5">
      <AdminPageHeader
        description="Everything the register can sell. Restock inline, or open a product to change its price and details."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={handleExport} className="lux-btn lux-btn--outline lux-btn--sm">
              <Download className="h-4 w-4" />
              Export
            </button>
            <button
              onClick={() => { setBarcodeInitialProductId(undefined); setBarcodeModalOpen(true); }}
              className="lux-btn lux-btn--outline lux-btn--sm"
            >
              <Tag className="h-4 w-4" />
              Barcode labels
            </button>
            <button onClick={onAddProduct} className="lux-btn lux-btn--primary">
              <Plus className="h-4 w-4" />
              Add product
            </button>
          </div>
        }
      />

      {/* Numbers double as filters, so the count and the action are in one place. */}
      <AdminStatStrip
        stats={[
          { key: 'total', label: 'In catalog', value: stats.total, icon: Package },
          { key: 'active', label: 'Sellable', value: stats.available, icon: Check, tone: 'green' },
          { key: 'units', label: 'Units on hand', value: stats.units, icon: Package, tone: 'accent' },
          {
            key: 'low',
            label: 'Running low',
            value: stats.lowStock,
            icon: AlertTriangle,
            tone: 'amber',
            active: stockFilter === 'low',
            title: 'Show products with 5 or fewer units',
            onClick: () => setStockFilter(stockFilter === 'low' ? 'all' : 'low'),
          },
          {
            key: 'out',
            label: 'Out of stock',
            value: stats.outOfStock,
            icon: X,
            tone: 'red',
            active: stockFilter === 'out',
            title: 'Show products with no units left',
            onClick: () => setStockFilter(stockFilter === 'out' ? 'all' : 'out'),
          },
        ]}
      />

      {/* Toolbar: scan-first search plus filters */}
      <div className="lux-card space-y-3 p-3.5">
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <ScanLine className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--accent)]" aria-hidden="true" />
            <input
              type="search"
              placeholder="Scan a barcode, or search name, brand, category…"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              aria-label="Search products by barcode or name"
              className="lux-input pl-9"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {([
            ['all', 'All groups'],
            ['beauty', 'Shisha & hookah'],
            ['groceries', 'Lounge supplies'],
          ] as Array<[GroupFilter, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setDepartmentFilter(value)}
              className={filterPill(departmentFilter === value)}
            >
              {label}
            </button>
          ))}

          <span aria-hidden="true" className="mx-1 h-5 w-px bg-[var(--border-color)]" />

          {([
            ['all', 'Any stock'],
            ['in', 'In stock'],
            ['low', 'Low'],
            ['out', 'Sold out'],
          ] as Array<[StockFilter, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setStockFilter(value)}
              className={filterPill(stockFilter === value)}
            >
              {label}
            </button>
          ))}

          <span className="ml-auto text-xs text-[var(--text-muted)]">
            <span className="font-bold tabular-nums text-[var(--text-primary)]">{filteredProducts.length}</span>
            {filteredProducts.length === stats.total ? ' products' : ` of ${stats.total}`}
          </span>
        </div>
      </div>

      {/* Dense product list */}
      {filteredProducts.length > 0 ? (
        <ul className="lux-card divide-y divide-[var(--border-color)] overflow-hidden p-0">
          {filteredProducts.map(product => {
            const units = product.stockCount || 0;
            const busy = busyId === product.id;
            const confirming = confirmDeleteId === product.id;
            const hidden = product.isPublished === false;
            const code = product.barcode || product.serialNumber;

            return (
              <li
                key={product.id}
                className={`flex items-center gap-3 px-3 py-2.5 transition hover:bg-[var(--accent-soft)] ${busy ? 'opacity-60' : ''}`}
              >
                {/* Thumbnail */}
                <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-soft)]">
                  {isRenderableProductImage(product.image) ? (
                    <img src={product.image} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>

                {/* Identity */}
                <button
                  type="button"
                  onClick={() => onEditProduct?.(product)}
                  className="min-w-0 flex-1 text-left"
                  title="Edit product"
                  aria-label={`Edit ${product.name}`}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="break-words text-sm font-bold text-[var(--text-primary)]">{product.name}</span>
                    {hidden && (
                      <span className="shrink-0 rounded bg-[var(--bg-soft)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--text-subtle)]">
                        Hidden
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[var(--text-muted)]">
                    <span className="break-words">{product.brand}</span>
                    <span aria-hidden="true">·</span>
                    <span className="break-words">{product.categoryLabel}</span>
                    {code && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="break-all font-mono text-[10px]">{code}</span>
                      </>
                    )}
                  </span>
                </button>

                {/* Price */}
                <div className="hidden w-24 shrink-0 text-right sm:block">
                  <p className="truncate text-sm font-extrabold tabular-nums text-[var(--text-primary)]">
                    {Number(product.price || 0).toFixed(2)}
                  </p>
                  {product.wholesalePrice != null && (
                    <p className="truncate text-[10px] font-bold tabular-nums text-[var(--accent)]">
                      WS {Number(product.wholesalePrice).toFixed(2)}
                    </p>
                  )}
                </div>

                {/* Inline restock stepper */}
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => adjustStock(product, -1)}
                    disabled={busy || units === 0}
                    aria-label={`Reduce stock of ${product.name}`}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-35 disabled:hover:border-[var(--border-color)] disabled:hover:text-[var(--text-muted)]"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <span
                    className={`w-12 rounded-lg px-1 py-1.5 text-center text-xs font-extrabold tabular-nums ${stockTone(units)}`}
                    title={`${units} units on hand`}
                  >
                    {units}
                  </span>
                  <button
                    type="button"
                    onClick={() => adjustStock(product, 1)}
                    disabled={busy}
                    aria-label={`Add one unit of ${product.name}`}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)] transition hover:border-[var(--jade)] hover:text-[var(--jade)] disabled:opacity-35"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Row actions */}
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => handleTogglePublish(product)}
                    disabled={busy}
                    title={hidden ? 'Make sellable at the register' : 'Hide from the register'}
                    aria-label={hidden ? 'Make sellable' : 'Hide from register'}
                    className="grid h-8 w-8 place-items-center rounded-lg text-[var(--text-subtle)] transition hover:bg-[var(--bg-soft)] hover:text-[var(--text-primary)] disabled:opacity-40"
                  >
                    {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setBarcodeInitialProductId(product.id); setBarcodeModalOpen(true); }}
                    title="Print barcode label"
                    aria-label={`Print barcode for ${product.name}`}
                    className="grid h-8 w-8 place-items-center rounded-lg text-[var(--text-subtle)] transition hover:bg-[var(--bg-soft)] hover:text-[var(--text-primary)]"
                  >
                    <Tag className="h-4 w-4" />
                  </button>
                  {/* The product's name is a button that opens this same editor,
                      so the row does not carry a second edit control. */}
                  {confirming ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleDeleteProduct(product)}
                        disabled={busy}
                        className="rounded-lg bg-[var(--danger)] px-2.5 py-1.5 text-[10px] font-bold text-white transition hover:brightness-110"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        aria-label="Cancel delete"
                        className="grid h-8 w-8 place-items-center rounded-lg text-[var(--text-subtle)] transition hover:bg-[var(--bg-soft)]"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleDeleteProduct(product)}
                      disabled={busy}
                      title="Delete product"
                      aria-label={`Delete ${product.name}`}
                      className="grid h-8 w-8 place-items-center rounded-lg text-[var(--text-subtle)] transition hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>

                <ChevronRight
                  className="hidden h-4 w-4 shrink-0 text-[var(--text-subtle)] opacity-40 lg:block"
                  aria-hidden="true"
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <AdminEmptyState
          icon={Package}
          title={stats.total === 0 ? 'Your catalog is empty' : 'No products match these filters'}
          description={
            stats.total === 0
              ? 'Use Add product above to list your first item, then print a barcode label for the shelf.'
              : 'Clear the search, or pick a different stock group to see the rest of the catalog.'
          }
          action={
            stats.total === 0 ? undefined : (
              <button
                onClick={() => { setSearchTerm(''); setStockFilter('all'); setDepartmentFilter('all'); }}
                className="lux-btn lux-btn--outline"
              >
                Clear filters
              </button>
            )
          }
        />
      )}

      {barcodeModalOpen && (
        <BarcodeLabelsModal
          isOpen
          initialProductId={barcodeInitialProductId}
          onClose={() => setBarcodeModalOpen(false)}
        />
      )}
    </div>
  );
};