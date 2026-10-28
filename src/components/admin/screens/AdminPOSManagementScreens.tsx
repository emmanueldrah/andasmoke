import React, { useMemo, useState } from 'react';
import { AlertTriangle, Edit3, Package, Plus, Save, Tag, Trash2, X, Check, ScanLine } from 'lucide-react';
import { useStore } from '../../../context/StoreContext';
import { useAlert } from '../../../context/AlertContext';
import type { Product, PromoCode } from '../../../types';
import { AdminPageHeader, AdminStatStrip } from '../components/AdminPrimitives';

const inputClass = 'lux-input';
const buttonClass = 'lux-btn lux-btn--primary';
const mutedButton = 'lux-btn lux-btn--outline lux-btn--sm';
const money = (value: number) => `GHS ${Number(value || 0).toFixed(2)}`;

export function AdminInventoryScreen({ onAddProduct }: { onAddProduct?: () => void }) {
  const store = useStore();
  const { showAlert } = useAlert();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Product | null>(null);
  const [quantity, setQuantity] = useState(0);
  const [adjustmentMode, setAdjustmentMode] = useState<'set' | 'add' | 'remove'>('set');

  const rows = useMemo(() => store.products
    .filter(product => `${product.name} ${product.brand} ${product.categoryLabel}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.stockCount - b.stockCount), [store.products, query]);

  const low = store.products.filter(product => product.stockCount > 0 && product.stockCount <= 5).length;
  const out = store.products.filter(product => product.stockCount <= 0).length;

  const save = async () => {
    if (!selected) return;
    const nextQuantity = adjustmentMode === 'add'
      ? selected.stockCount + quantity
      : adjustmentMode === 'remove'
        ? selected.stockCount - quantity
        : quantity;
    await store.updateProductStock(selected.id, Math.max(0, nextQuantity));
    showAlert(`${selected.name} stock updated`, 'success');
    setSelected(null);
  };

  const removeProduct = async (product: Product) => {
    if (!window.confirm(`Remove ${product.name} from inventory?`)) return;
    await store.deleteProduct(product.id);
    showAlert(`${product.name} removed from inventory`, 'success');
  };

  const stockBadge = (count: number) => count === 0
    ? 'lux-chip lux-chip--danger'
    : count <= 5 ? 'lux-chip lux-chip--warning' : 'lux-chip lux-chip--success';
return (
    <div className="space-y-5">
      <AdminPageHeader
        description="Receive deliveries and correct counts without opening a product."
        action={onAddProduct ? (
          <button className={buttonClass} onClick={onAddProduct}><Plus className="h-4 w-4" />Add product</button>
        ) : undefined}
      />

      <AdminStatStrip
        stats={[
          { key: 'skus', label: 'SKUs tracked', value: store.products.length, icon: Package },
          { key: 'units', label: 'Units on hand', value: store.products.reduce((total, product) => total + (product.stockCount || 0), 0), icon: Package, tone: 'accent' },
          { key: 'healthy', label: 'Healthy', value: store.products.length - low - out, icon: Check, tone: 'green' },
          { key: 'low', label: 'Running low', value: low, icon: AlertTriangle, tone: 'amber' },
          { key: 'out', label: 'Out of stock', value: out, icon: X, tone: 'red' },
        ]}
      />

      <div className="relative">
        <ScanLine className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--accent)]" aria-hidden="true" />
        <input
          className={`${inputClass} pl-9`}
          placeholder="Search product, brand, or category"
          value={query}
          onChange={event => setQuery(event.target.value)}
          aria-label="Search inventory"
        />
      </div>

      <div className="lux-card overflow-hidden p-0">
        <div className="divide-y divide-[var(--border-color)]">
          {rows.map(product => (
            <div key={product.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--accent-soft)] sm:flex-nowrap">
              <img src={product.image} alt="" className="h-10 w-10 flex-shrink-0 rounded-lg object-cover" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-[var(--text-primary)]">{product.name}</p>
                <p className="truncate text-[11px] text-[var(--text-muted)]">{product.brand} · {product.categoryLabel}</p>
              </div>
              <span className={`${stockBadge(product.stockCount)} min-w-24 justify-center`}>{product.stockCount} units</span>
              <button className={mutedButton} onClick={() => { setSelected(product); setQuantity(product.stockCount); setAdjustmentMode('set'); }}>
                <Edit3 className="h-4 w-4" />Adjust
              </button>
              <button className="lux-btn lux-btn--danger lux-btn--sm" onClick={() => void removeProduct(product)} title={`Remove ${product.name}`}>
                <Trash2 className="h-4 w-4" />Remove
              </button>
            </div>
          ))}
          {rows.length === 0 && <p className="p-8 text-center text-sm text-[var(--text-muted)]">No products match this search.</p>}
        </div>
      </div>

      {selected && (
        <div className="glass-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="form-sheet w-full max-w-md rounded-xl border p-6" onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[var(--text-primary)]">Adjust stock</h2>
              <button onClick={() => setSelected(null)} aria-label="Close" className="rounded-lg p-1.5 text-[var(--text-subtle)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--text-primary)]"><X className="h-5 w-5" /></button>
            </div>
            <p className="mt-1 text-sm text-[var(--text-muted)]">{selected.name}</p>
            <div className="mt-5 grid grid-cols-3 gap-2">
              {(['set', 'add', 'remove'] as const).map(mode => (
                <button key={mode} type="button" onClick={() => { setAdjustmentMode(mode); setQuantity(mode === 'set' ? selected.stockCount : 1); }} className={`rounded-lg border px-2 py-2 text-xs font-bold capitalize transition-colors ${adjustmentMode === mode ? 'border-transparent bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border-color)] bg-[var(--bg-soft)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>
                  {mode === 'set' ? 'Set total' : mode === 'add' ? 'Receive stock' : 'Remove stock'}
                </button>
              ))}
            </div>
            <label className="lux-label mt-5">{adjustmentMode === 'set' ? 'New quantity' : 'Units to adjust'}</label>
            <input className={`${inputClass} mt-2`} type="number" min="0" value={quantity} onChange={event => setQuantity(Number(event.target.value))} />
            <button className={`${buttonClass} mt-5 w-full`} onClick={() => void save()}><Save className="h-4 w-4" />Save quantity</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AdminPromotionsScreen() {
  const store = useStore();
  const { showAlert } = useAlert();
  const [form, setForm] = useState({ code: '', description: '', discountValue: 10, discountType: 'percentage' as PromoCode['discountType'], minSpend: 0 });

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.code.trim()) return;
    await store.addPromoCode({ ...form, code: form.code.trim().toUpperCase(), minSpend: form.minSpend || undefined, isActive: true });
    showAlert(`${form.code.toUpperCase()} created`, 'success');
    setForm({ code: '', description: '', discountValue: 10, discountType: 'percentage', minSpend: 0 });
  };

  return (
    <div className="space-y-5">
      <AdminPageHeader description="Create discount codes for in-store sales." />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <form onSubmit={event => void add(event)} className="lux-card space-y-4 p-5">
          <h2 className="text-base font-bold text-[var(--text-primary)]">New discount code</h2>
          <input required className={inputClass} placeholder="CODE NAME" value={form.code} onChange={event => setForm({ ...form, code: event.target.value })} />
          <input className={inputClass} placeholder="Internal note (optional)" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} />
          <div className="grid grid-cols-2 gap-3">
            <select className={inputClass} value={form.discountType} onChange={event => setForm({ ...form, discountType: event.target.value as PromoCode['discountType'] })}>
              <option value="percentage">Percentage</option>
              <option value="fixed">Fixed GHS</option>
            </select>
            <input className={inputClass} type="number" min="0" value={form.discountValue} onChange={event => setForm({ ...form, discountValue: Number(event.target.value) })} />
          </div>
          <input className={inputClass} type="number" min="0" placeholder="Minimum sale amount (optional)" value={form.minSpend || ''} onChange={event => setForm({ ...form, minSpend: Number(event.target.value) })} />
          <button className={`${buttonClass} w-full`}><Plus className="h-4 w-4" />Create discount</button>
        </form>

        <div className="space-y-3">
          {store.promoCodes.map(promo => (
            <div key={promo.id} className="lux-card flex flex-wrap items-center gap-3 p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]"><Tag className="h-5 w-5" /></div>
              <div className="min-w-40 flex-1">
                <p className="font-mono font-bold text-[var(--text-primary)]">{promo.code}</p>
                <p className="text-xs text-[var(--text-muted)]">{promo.description || 'No note'} · {promo.usageCount} uses</p>
              </div>
              <span className="text-sm font-bold text-[var(--accent)]">{promo.discountType === 'percentage' ? `${promo.discountValue}% off` : `${money(promo.discountValue)} off`}</span>
              <button className={mutedButton} onClick={() => void store.togglePromoCode(promo.code)}>{promo.isActive ? 'Pause' : 'Activate'}</button>
              <button className="rounded-lg p-2 text-[var(--text-subtle)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]" aria-label={`Delete ${promo.code}`} onClick={() => void store.deletePromoCode(promo.id)}><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          {store.promoCodes.length === 0 && <p className="rounded-xl border border-dashed border-[var(--border-color)] p-8 text-center text-sm text-[var(--text-muted)]">No discounts have been created.</p>}
        </div>
      </div>
    </div>
  );
}
