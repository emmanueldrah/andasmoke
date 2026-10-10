import React, { useEffect, useRef, useState } from 'react';
import { Barcode, ImagePlus, Package, Plus, Save, Trash2, X } from 'lucide-react';
import { useStore } from '../../context/StoreContext';
import { useToast } from '../../context/ToastContext';
import { uploadProductImage } from '../../lib/imageUpload';
import type { CategoryType, DepartmentType, Product, ProductVariant } from '../../types';

interface POSProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  productToEdit?: Product | null;
}

type VariantDraft = ProductVariant;

const inputClass = 'lux-input';

const fallbackCategories: Record<DepartmentType, Array<{ value: CategoryType; label: string }>> = {
  beauty: [
    { value: 'skincare', label: 'Shisha flavors' },
    { value: 'makeup', label: 'Hookahs & pipes' },
    { value: 'fragrances', label: 'Coals & heat' },
    { value: 'body-care', label: 'Accessories' },
    { value: 'beauty-tools', label: 'Parts & cleaning' },
  ],
  groceries: [
    { value: 'beverages', label: 'Drinks & refreshments' },
    { value: 'daily-essentials', label: 'Lounge supplies' },
  ],
};

export const POSProductModal: React.FC<POSProductModalProps> = ({ isOpen, onClose, productToEdit }) => {
  const { addProduct, updateProduct, brands, categories } = useStore();
  const { showToast } = useToast();
  const photoInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [department, setDepartment] = useState<DepartmentType>('beauty');
  const [category, setCategory] = useState<CategoryType>('skincare');
  const [price, setPrice] = useState('');
  const [wholesalePrice, setWholesalePrice] = useState('');
  const [unit, setUnit] = useState('');
  const [stockCount, setStockCount] = useState('0');
  const [barcode, setBarcode] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [image, setImage] = useState('');
  const [variants, setVariants] = useState<VariantDraft[]>([]);
  const [isPublished, setIsPublished] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const categoryOptions = [
    ...fallbackCategories[department],
    ...categories.filter(item => item.department === department).map(item => ({ value: item.id, label: item.name })),
  ].filter((item, index, items) => items.findIndex(candidate => candidate.value === item.value) === index);
  const selectedCategory = categories.find(item => item.id === category);
  const variantStock = variants.reduce((total, variant) => total + Math.max(0, Number(variant.stockCount || 0)), 0);

  /**
 * The code the counter scanned and asked us to open with.
 *
 * In a ref, not state: it has to be readable by the effect that fills the form
 * when it opens, and consuming it must not cause a re-render that would re-run
 * that effect and blank the field again.
 */
const scannedBarcode = useRef('');

  useEffect(() => {
    if (!isOpen) return;
    if (productToEdit) {
      setName(productToEdit.name);
      setBrand(productToEdit.brand || '');
      setDepartment(productToEdit.department || 'beauty');
      setCategory(productToEdit.category);
      setPrice(String(productToEdit.price));
      setWholesalePrice(productToEdit.wholesalePrice == null ? '' : String(productToEdit.wholesalePrice));
      setUnit(productToEdit.unit || '');
      setStockCount(String(productToEdit.stockCount || 0));
      setBarcode(productToEdit.barcode || '');
      setSerialNumber(productToEdit.serialNumber || '');
      setImage(productToEdit.image || '');
      setVariants((productToEdit.variants || []).map(variant => ({ ...variant })));
      setIsPublished(productToEdit.isPublished !== false);
    } else {
      setName('');
      setBrand('');
      setDepartment('beauty');
      setCategory('skincare');
      setPrice('');
      setWholesalePrice('');
      setUnit('');
setStockCount('0');
      // A code the counter handed over pre-fills the field. Consumed here so the
      // next ordinary "add product" opens blank.
      setBarcode(scannedBarcode.current);
      scannedBarcode.current = '';
      setSerialNumber('');
      setImage('');
      setVariants([]);
      setIsPublished(true);
    }
    // Deliberately keyed on the open transition only. Including pendingBarcode
    // here would re-run the reset the moment the code was consumed, blanking the
    // field the cashier was looking at.
  }, [isOpen, productToEdit]);

  /**
   * A code the counter scanned that is not in the catalogue yet.
   *
   * Held in state rather than applied straight from the event: the modal is
   * mounted while closed and returns null before rendering, so the event arrives
   * before there is a barcode field to show the value in. Reading it when the
   * form opens is what makes the pre-fill reliable.
   */
useEffect(() => {
    const onOpenForBarcode = (event: Event) => {
      const scanned = (event as CustomEvent<{ barcode: string }>).detail?.barcode;
      if (scanned) scannedBarcode.current = scanned;
    };
    window.addEventListener('anda-open-product-form', onOpenForBarcode);
    return () => window.removeEventListener('anda-open-product-form', onOpenForBarcode);
  }, []);

  if (!isOpen) return null;

  const addVariant = () => setVariants(previous => [...previous, {
    id: `variant-${crypto.randomUUID()}`,
    name: '',
    price: Number(price) || 0,
    inStock: true,
    stockCount: 0,
    image: image || undefined,
  }]);

  const updateVariant = (id: string, updates: Partial<VariantDraft>) => setVariants(previous => previous.map(variant =>
    variant.id === id ? { ...variant, ...updates } : variant
  ));

  const addPhoto = async (file?: File) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      showToast('Choose a JPG, PNG, WEBP, or GIF image under 10MB.');
      return;
    }
    const token = localStorage.getItem('anda_auth_token');
    if (!token) {
      showToast('Administrator session required. Please sign in again.');
      return;
    }
    setIsUploading(true);
    try {
      setImage(await uploadProductImage(file, token));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not upload this photo.');
    } finally {
      setIsUploading(false);
      if (photoInput.current) photoInput.current.value = '';
    }
  };

  const saveProduct = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanName = name.trim();
    const numericPrice = Number(price);
    const numericStock = Math.max(0, Math.floor(Number(stockCount) || 0));
    if (!cleanName) return showToast('Enter a product name.');
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) return showToast('Enter a selling price greater than zero.');
    if (variants.some(variant => !variant.name.trim() || !Number.isFinite(Number(variant.price)) || Number(variant.price) <= 0)) {
      return showToast('Each variation needs a name and valid price.');
    }

    const scanCodes = [barcode.trim(), serialNumber.trim(), ...variants.flatMap(variant => [variant.barcode?.trim() || '', variant.serialNumber?.trim() || ''])].filter(Boolean);
    if (new Set(scanCodes).size !== scanCodes.length) return showToast('Each barcode or serial number must be unique.');

    const categoryLabel = selectedCategory?.name || categoryOptions.find(item => item.value === category)?.label || 'Lounge stock';
    const cleanVariants = variants.map(variant => {
      const quantity = Math.max(0, Math.floor(Number(variant.stockCount) || 0));
      return {
        ...variant,
        name: variant.name.trim(),
        price: Number(variant.price),
        stockCount: quantity,
        inStock: quantity > 0,
        image: variant.image || image || undefined,
        barcode: variant.barcode?.trim() || undefined,
        serialNumber: variant.serialNumber?.trim() || undefined,
      };
    });
    const totalStock = cleanVariants.length ? variantStock : numericStock;
    const payload: Omit<Product, 'id'> = {
      name: cleanName,
      brand: brand.trim() || 'Other',
      department,
      category,
      categoryLabel,
      price: numericPrice,
      wholesalePrice: wholesalePrice ? Number(wholesalePrice) : undefined,
      unit: unit.trim() || 'Each',
      barcode: barcode.trim() || undefined,
      serialNumber: serialNumber.trim() || undefined,
      image,
      images: image ? [image] : [],
      inStock: totalStock > 0,
      isPublished,
      stockCount: totalStock,
      options: [],
      variants: cleanVariants,
    };

    setIsSaving(true);
    try {
      if (productToEdit) {
        await updateProduct(productToEdit.id, payload);
        showToast(`${cleanName} updated.`);
      } else {
        await addProduct(payload);
        showToast(`${cleanName} added to register inventory.`);
      }
      onClose();
    } catch (error: any) {
      showToast(error?.data?.error || error?.message || 'Could not save the product.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 backdrop-blur-sm sm:p-6" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="clay-surface flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-primary)] shadow-[var(--shadow-card)]" role="dialog" aria-modal="true" aria-labelledby="pos-product-title">
        <header className="glass-panel flex items-start justify-between gap-4 border-x-0 border-t-0 px-5 py-4 sm:px-6">
          <div>
            <p className="eyebrow">Stockroom</p>
            <h2 id="pos-product-title" className="brand-display mt-1 text-2xl font-semibold">{productToEdit ? 'Edit product' : 'Add product'}</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Set up a sellable item for the register.</p>
          </div>
          <button type="button" onClick={onClose} disabled={isSaving} aria-label="Close" className="lux-btn lux-btn--ghost lux-btn--sm px-2"><X className="h-4 w-4" /></button>
        </header>

        <form id="pos-product-form" onSubmit={event => void saveProduct(event)} className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="lux-label">Product name</span>
              <input autoFocus required autoComplete="off" value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Double Apple flavor" className="lux-input" />
            </label>

            <label>
              <span className="lux-label">Product group</span>
              <select value={department} onChange={event => {
                const nextDepartment = event.target.value as DepartmentType;
                setDepartment(nextDepartment);
                setCategory(fallbackCategories[nextDepartment][0].value);
              }} className="lux-select">
                <option value="beauty">Shisha & hookah</option>
                <option value="groceries">Lounge supplies</option>
              </select>
            </label>

            <label>
              <span className="lux-label">Category</span>
              <select value={category} onChange={event => setCategory(event.target.value as CategoryType)} className="lux-select">
                {categoryOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>

            <label>
              <span className="lux-label">Brand <span className="font-medium normal-case tracking-normal">(optional)</span></span>
              <input list="pos-product-brands" value={brand} onChange={event => setBrand(event.target.value)} placeholder="Brand or supplier" className="lux-input" />
              <datalist id="pos-product-brands">{brands.map(item => <option key={item} value={item} />)}</datalist>
            </label>

            <label>
              <span className="lux-label">Unit <span className="font-medium normal-case tracking-normal">(optional)</span></span>
              <input value={unit} onChange={event => setUnit(event.target.value)} placeholder="Each, 50g, bottle" className="lux-input" />
            </label>

            <label>
              <span className="lux-label">Selling price (GHS)</span>
              <input required type="number" min="0.01" step="0.01" value={price} onChange={event => setPrice(event.target.value)} placeholder="0.00" className="lux-input font-bold tabular-nums" />
            </label>

            <label>
              <span className="lux-label">Opening stock</span>
              <input type="number" min="0" step="1" value={variants.length ? variantStock : stockCount} readOnly={variants.length > 0} onChange={event => setStockCount(event.target.value)} className="lux-input font-bold tabular-nums" />
              {variants.length > 0 && <span className="mt-1 block text-[11px] text-[var(--text-subtle)]">Total from variations.</span>}
            </label>

            <label>
              <span className="lux-label">Barcode <span className="font-medium normal-case tracking-normal">(optional)</span></span>
              <span className="relative block">
                <Barcode className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-subtle)]" />
                {/* This field exists to receive a typed or scanned code, so it opts out of the
                    counter's global scanner capture: the value must stay put. */}
                <input
                  id="product-barcode"
                  name="barcode"
                  data-barcode-input="product-form"
                  value={barcode}
                  onChange={event => setBarcode(event.target.value)}
                  autoComplete="off"
                  placeholder="Scan or enter code"
                  className="lux-input pl-9"
                />
              </span>
            </label>

            <label>
              <span className="lux-label">Serial number <span className="font-medium normal-case tracking-normal">(optional)</span></span>
              <input value={serialNumber} onChange={event => setSerialNumber(event.target.value)} autoComplete="off" placeholder="Supplier code" className="lux-input" />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-soft)_50%,transparent)] p-3">
            <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" onChange={event => void addPhoto(event.target.files?.[0])} />
            {image ? <img src={image} alt="Product preview" className="h-12 w-12 rounded-md object-cover" /> : <div className="grid h-12 w-12 place-items-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]"><Package className="h-5 w-5" /></div>}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-[var(--text-primary)]">Product photo</p>
              <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Optional. The item can be sold without one.</p>
            </div>
            {image && <button type="button" onClick={() => setImage('')} className="lux-btn lux-btn--ghost lux-btn--sm px-2" aria-label="Remove product photo"><X className="h-4 w-4" /></button>}
            <button type="button" onClick={() => photoInput.current?.click()} disabled={isUploading} className="lux-btn lux-btn--outline lux-btn--sm">
              <ImagePlus className="h-3.5 w-3.5" />{isUploading ? 'Uploading...' : image ? 'Change photo' : 'Add photo'}
            </button>
          </div>

          <details className="mt-4 rounded-lg border border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-soft)_34%,transparent)] p-3">
            <summary className="cursor-pointer text-sm font-bold text-[var(--text-primary)]">Variations <span className="font-normal text-[var(--text-subtle)]">(optional)</span></summary>
            <div className="mt-3 space-y-2">
              {variants.map((variant, index) => (
                <div key={variant.id} className="grid gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-card)] p-3 sm:grid-cols-[1.3fr_1fr_0.7fr_auto]">
                  <input aria-label={`Variation ${index + 1} name`} value={variant.name} onChange={event => updateVariant(variant.id, { name: event.target.value })} placeholder="Variation name" className="lux-input" />
                  <input aria-label={`Variation ${index + 1} price`} type="number" min="0.01" step="0.01" value={variant.price} onChange={event => updateVariant(variant.id, { price: Number(event.target.value) })} placeholder="Price" className="lux-input" />
                  <input aria-label={`Variation ${index + 1} stock`} type="number" min="0" step="1" value={variant.stockCount ?? 0} onChange={event => { const quantity = Math.max(0, Number(event.target.value) || 0); updateVariant(variant.id, { stockCount: quantity, inStock: quantity > 0 }); }} placeholder="Stock" className="lux-input" />
                  <button type="button" aria-label={`Remove variation ${index + 1}`} onClick={() => setVariants(previous => previous.filter(item => item.id !== variant.id))} className="lux-btn lux-btn--ghost lux-btn--sm px-2 text-[var(--danger)]"><Trash2 className="h-4 w-4" /></button>
                  {/* Same exemption as the product's own barcode field. */}
                  <input
                    aria-label={`Variation ${index + 1} barcode`}
                    name="variant-barcode"
                    data-barcode-input="product-form"
                    value={variant.barcode || ''}
                    onChange={event => updateVariant(variant.id, { barcode: event.target.value })}
                    placeholder="Variation barcode (optional)"
                    className="lux-input sm:col-span-2"
                  />
                  <input aria-label={`Variation ${index + 1} serial`} value={variant.serialNumber || ''} onChange={event => updateVariant(variant.id, { serialNumber: event.target.value })} placeholder="Serial number (optional)" className="lux-input sm:col-span-2" />
                </div>
              ))}
              <button type="button" onClick={addVariant} className="lux-btn lux-btn--outline lux-btn--sm"><Plus className="h-3.5 w-3.5" />Add variation</button>
            </div>
          </details>

          <label className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-[var(--border-color)] px-3 py-2.5">
            <span><span className="block text-xs font-bold text-[var(--text-primary)]">Available at register</span><span className="mt-0.5 block text-[11px] text-[var(--text-muted)]">Inactive products stay in inventory but cannot be sold.</span></span>
            <input type="checkbox" checked={isPublished} onChange={event => setIsPublished(event.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          </label>
        </form>

        <footer className="glass-panel flex items-center justify-between gap-3 border-x-0 border-b-0 px-5 py-3 sm:px-6">
          <button type="button" onClick={onClose} disabled={isSaving} className="lux-btn lux-btn--outline">Cancel</button>
          <button type="submit" form="pos-product-form" disabled={isSaving} className="lux-btn lux-btn--primary"><Save className="h-4 w-4" />{isSaving ? 'Saving...' : productToEdit ? 'Save product' : 'Add product'}</button>
        </footer>
      </section>
    </div>
  );
};