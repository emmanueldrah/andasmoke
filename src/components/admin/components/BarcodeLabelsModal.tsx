import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  X,
  Printer,
  Barcode,
  Search,
  Save,
  CheckSquare,
  Square,
  Sparkles,
  Layers,
  Filter,
  RefreshCw,
  Tag,
  CheckCircle2,
  AlertTriangle,
  Scissors,
  SlidersHorizontal,
  ChevronRight,
  Eye,
  Settings2,
  Package,
} from 'lucide-react';
import { Product, ProductVariant } from '../../../types';
import { useStore } from '../../../context/StoreContext';
import { useAlert } from '../../../context/AlertContext';
import {
  generateCode128Svg,
  generateUniqueRetailBarcode,
  LABEL_TEMPLATES,
  LabelSheetTemplate,
} from '../../../lib/barcodeGenerator';
import { planLabel, renderLabelSvg } from '../../../lib/code128';

interface BarcodeItem {
  id: string; // product-id or product-id__variant-id
  productId: string;
  variantId?: string;
  productName: string;
  variantName?: string;
  brand: string;
  price: number;
  stockCount: number;
  barcode: string;
  image?: string;
  quantityToPrint: number;
  selected: boolean;
}

interface BarcodeLabelsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialProductId?: string; // If opened for a specific product
}

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const BarcodeLabelsModal: React.FC<BarcodeLabelsModalProps> = ({
  isOpen,
  onClose,
  initialProductId,
}) => {
  const { products, updateProduct, storeSettings } = useStore();
  const { showAlert } = useAlert();

  // Active view tab: 'select' (choose items & counts) or 'preview' (sheet layout)
  const [activeTab, setActiveTab] = useState<'select' | 'preview'>('select');

  // Selected template
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('a4-24');
  const template = useMemo<LabelSheetTemplate>(() => {
    return LABEL_TEMPLATES.find(t => t.id === selectedTemplateId) || LABEL_TEMPLATES[1];
  }, [selectedTemplateId]);

  // Label display options
  const [showStoreName, setShowStoreName] = useState(true);
  const [showProductName, setShowProductName] = useState(true);
  const [showVariantName, setShowVariantName] = useState(true);
  const [showPrice, setShowPrice] = useState(true);
  const [showBarcodeText, setShowBarcodeText] = useState(true);
  const [showCutBorders, setShowCutBorders] = useState(true);

  // Search & Filter
  const [searchTerm, setSearchTerm] = useState('');
  const [filterBarcodeStatus, setFilterBarcodeStatus] = useState<'all' | 'missing' | 'has_barcode'>('all');

  // Items list
  const [items, setItems] = useState<BarcodeItem[]>([]);
  const [isGeneratingBarcodes, setIsGeneratingBarcodes] = useState(false);
  const [isSavingBarcodes, setIsSavingBarcodes] = useState(false);
  const productById = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);

  // Initialize items from products and variants
  useEffect(() => {
    if (!isOpen) return;

    const list: BarcodeItem[] = [];

    (products || []).forEach(product => {
      if (product.variants && product.variants.length > 0) {
        // Add each variant as an individual barcode item
        product.variants.forEach(variant => {
          const isInitial = initialProductId ? product.id === initialProductId : true;
          list.push({
            id: `${product.id}__${variant.id}`,
            productId: product.id,
            variantId: variant.id,
            productName: product.name,
            variantName: variant.name,
            brand: product.brand,
            price: Number(variant.price || product.price || 0),
            stockCount: Number(variant.stockCount || 0),
            barcode: variant.barcode?.trim() || '',
            image: variant.image || product.image,
            quantityToPrint: isInitial ? Math.max(1, Math.min(Number(variant.stockCount || 1), 10)) : 1,
            selected: isInitial,
          });
        });
      } else {
        // Single product item
        const isInitial = initialProductId ? product.id === initialProductId : true;
        list.push({
          id: product.id,
          productId: product.id,
          productName: product.name,
          brand: product.brand,
          price: Number(product.price || 0),
          stockCount: Number(product.stockCount || 0),
          barcode: product.barcode?.trim() || '',
          image: product.image,
          quantityToPrint: isInitial ? Math.max(1, Math.min(Number(product.stockCount || 1), 10)) : 1,
          selected: isInitial,
        });
      }
    });

    setItems(list);
    if (initialProductId) {
      setActiveTab('select');
    }
  }, [isOpen, products, initialProductId]);

  // Filtered items in selection table
  const filteredItems = useMemo(() => {
    const q = searchTerm.toLowerCase().trim();
    return items.filter(item => {
      const matchSearch =
        !q ||
        item.productName.toLowerCase().includes(q) ||
        (item.variantName || '').toLowerCase().includes(q) ||
        item.brand.toLowerCase().includes(q) ||
        item.barcode.toLowerCase().includes(q);

      if (!matchSearch) return false;

      // Barcode status
      if (filterBarcodeStatus === 'missing' && item.barcode) return false;
      if (filterBarcodeStatus === 'has_barcode' && !item.barcode) return false;

      return true;
    });
  }, [items, searchTerm, filterBarcodeStatus]);

  // Selected items & total labels to print
  const selectedItems = useMemo(() => items.filter(i => i.selected), [items]);
  const totalLabelsCount = useMemo(() => {
    return selectedItems.reduce((sum, item) => sum + Math.max(1, item.quantityToPrint), 0);
  }, [selectedItems]);

  const missingBarcodeCount = useMemo(() => {
    return selectedItems.filter(i => !i.barcode.trim()).length;
  }, [selectedItems]);
  const unsavedBarcodeItems = useMemo(() => items.filter(item => {
    const product = productById.get(item.productId);
    const savedBarcode = item.variantId
      ? product?.variants?.find(variant => variant.id === item.variantId)?.barcode || ''
      : product?.barcode || '';
    return item.barcode.trim() !== savedBarcode.trim();
  }), [items, productById]);

  // Selection toggles
  const handleToggleSelectAll = (select: boolean) => {
    setItems(prev =>
      prev.map(item => {
        const isShown = filteredItems.some(f => f.id === item.id);
        return isShown ? { ...item, selected: select } : item;
      })
    );
  };

  const handleToggleItem = (id: string) => {
    setItems(prev =>
      prev.map(item => (item.id === id ? { ...item, selected: !item.selected } : item))
    );
  };

  const handleUpdateQuantity = (id: string, delta: number) => {
    setItems(prev =>
      prev.map(item => {
        if (item.id !== id) return item;
        const next = Math.max(1, Math.min(999, item.quantityToPrint + delta));
        return { ...item, quantityToPrint: next, selected: true };
      })
    );
  };

  const handleSetExactQuantity = (id: string, qty: number) => {
    const valid = Math.max(1, Math.min(999, isNaN(qty) ? 1 : qty));
    setItems(prev =>
      prev.map(item => (item.id === id ? { ...item, quantityToPrint: valid, selected: true } : item))
    );
  };

  const handleUpdateBarcodeText = (id: string, newBarcode: string) => {
    setItems(prev =>
      prev.map(item => (item.id === id ? { ...item, barcode: newBarcode.trim() } : item))
    );
  };

  const handleSaveBarcodeChanges = async () => {
    if (unsavedBarcodeItems.length === 0) return;
    if (unsavedBarcodeItems.some(item => !item.barcode.trim())) {
      showAlert('Enter a barcode for each edited item before saving.', 'error');
      return;
    }

    setIsSavingBarcodes(true);
    let savedCount = 0;
    try {
      const updatesByProduct = new Map<string, BarcodeItem[]>();
      unsavedBarcodeItems.forEach(item => {
        const group = updatesByProduct.get(item.productId) || [];
        group.push(item);
        updatesByProduct.set(item.productId, group);
      });

      for (const [productId, changes] of updatesByProduct) {
        const product = productById.get(productId);
        if (!product) throw new Error('A product could not be found. Refresh the catalog and try again.');

        const productChange = changes.find(item => !item.variantId);
        const updates: Partial<Product> = {};
        if (productChange) updates.barcode = productChange.barcode.trim();
        if (product.variants?.length) {
          updates.variants = product.variants.map(variant => {
            const change = changes.find(item => item.variantId === variant.id);
            return change ? { ...variant, barcode: change.barcode.trim() } : variant;
          });
        }

        await updateProduct(productId, updates);
        savedCount += changes.length;
      }

      showAlert(`Saved ${savedCount} barcode${savedCount === 1 ? '' : 's'} to the product catalog.`, 'success');
    } catch (error: any) {
      const detail = error?.message || 'Please try again.';
      showAlert(savedCount
        ? `Saved ${savedCount} barcode${savedCount === 1 ? '' : 's'}; some changes could not be saved. ${detail}`
        : `Barcode changes could not be saved. ${detail}`, 'error');
    } finally {
      setIsSavingBarcodes(false);
    }
  };

  // Preset batch quantity buttons
  const handleApplyPresetQuantity = (mode: 'one' | 'stock' | 'five') => {
    setItems(prev =>
      prev.map(item => {
        if (!item.selected) return item;
        let qty = 1;
        if (mode === 'stock') qty = Math.max(1, Math.min(100, item.stockCount || 1));
        if (mode === 'five') qty = 5;
        return { ...item, quantityToPrint: qty };
      })
    );
    showAlert(`Applied quantity preset to ${selectedItems.length} items.`, 'success');
  };

  // Auto-generate missing barcodes and save to store database
  const handleAutoGenerateMissing = async () => {
    const missing = selectedItems.filter(i => !i.barcode.trim());
    if (missing.length === 0) {
      showAlert('All selected items already have barcodes!', 'success');
      return;
    }

    setIsGeneratingBarcodes(true);
    try {
      // Gather all existing barcodes to guarantee uniqueness
      const existingBarcodes = new Set<string>();
      products.forEach(p => {
        if (p.barcode) existingBarcodes.add(p.barcode.trim());
        (p.variants || []).forEach(v => {
          if (v.barcode) existingBarcodes.add(v.barcode.trim());
        });
      });

      // Generate a map of item ID -> new unique barcode
      const newBarcodesMap = new Map<string, string>();
      missing.forEach(item => {
        const uniqueCode = generateUniqueRetailBarcode(existingBarcodes);
        existingBarcodes.add(uniqueCode);
        newBarcodesMap.set(item.id, uniqueCode);
      });

      // Update local state immediately
      setItems(prev =>
        prev.map(item => {
          if (newBarcodesMap.has(item.id)) {
            return { ...item, barcode: newBarcodesMap.get(item.id)! };
          }
          return item;
        })
      );

      // Group updates by product to save to database
      const productsToUpdate = new Set<string>(missing.map(m => m.productId));
      let savedCount = 0;

      for (const prodId of productsToUpdate) {
        const originalProduct = products.find(p => p.id === prodId);
        if (!originalProduct) continue;

        let modified = false;
        let nextBarcode = originalProduct.barcode;
        let nextVariants = originalProduct.variants ? [...originalProduct.variants] : undefined;

        // Check if root product needed barcode
        if (newBarcodesMap.has(prodId)) {
          nextBarcode = newBarcodesMap.get(prodId);
          modified = true;
        }

        // Check if any variant of this product needed barcode
        if (nextVariants && nextVariants.length > 0) {
          nextVariants = nextVariants.map(v => {
            const variantKey = `${prodId}__${v.id}`;
            if (newBarcodesMap.has(variantKey)) {
              modified = true;
              return { ...v, barcode: newBarcodesMap.get(variantKey) };
            }
            return v;
          });
        }

        if (modified) {
          await updateProduct(prodId, {
            barcode: nextBarcode,
            ...(nextVariants ? { variants: nextVariants } : {}),
          });
          savedCount++;
        }
      }

      showAlert(
        `Generated and saved ${missing.length} unique barcode${missing.length === 1 ? '' : 's'} across ${savedCount} product${savedCount === 1 ? '' : 's'}!`,
        'success'
      );
    } catch (err: any) {
      showAlert(err?.message || 'Failed to save generated barcodes to database.', 'error');
    } finally {
      setIsGeneratingBarcodes(false);
    }
  };

  // Flattened array of individual sticker labels to print
  const flatLabels = useMemo(() => {
    const list: BarcodeItem[] = [];
    selectedItems.forEach(item => {
      const count = Math.max(1, item.quantityToPrint);
      for (let i = 0; i < count; i++) {
        list.push(item);
      }
    });
    return list;
  }, [selectedItems]);
  const printPages = useMemo(() => {
    const pageSize = Math.max(1, template.labelsPerPage);
    return Array.from({ length: Math.ceil(flatLabels.length / pageSize) }, (_, pageIndex) =>
      flatLabels.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
    );
  }, [flatLabels, template.labelsPerPage]);
  const pageWidthMm = template.pageWidthMm ?? 210;
  const pageHeightMm = template.pageHeightMm ?? 297;
  const previewPageWidth = template.category === 'thermal' ? 340 : 720;
  const previewScale = previewPageWidth / pageWidthMm;

  // Print execution
  const handlePrint = () => {
    if (flatLabels.length === 0) {
      showAlert('Please select at least one product label to print.', 'error');
      return;
    }
    if (unsavedBarcodeItems.some(item => item.selected)) {
      showAlert('Save edited barcodes before printing so the labels match the product catalog.', 'warning');
      return;
    }
    if (missingBarcodeCount > 0) {
      if (
        !window.confirm(
          `${missingBarcodeCount} selected item(s) do not have a barcode number yet. Do you want to print anyway?`
        )
      ) {
        return;
      }
    }

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      showAlert('Allow pop-ups for this site, then try printing again.', 'error');
      return;
    }

    const storeName = escapeHtml(storeSettings.storeName || 'ANDA C SMOKE HUB');
    const pageStyle = `
      @page { size: ${pageWidthMm}mm ${pageHeightMm}mm; margin: 0; }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        padding: 0;
        background: #ffffff;
        color: #111827;
        font-family: Arial, Helvetica, sans-serif;
      }
      body {
        display: block;
      }
      .sheet {
        width: ${pageWidthMm}mm;
        min-height: ${pageHeightMm}mm;
        padding: ${template.category === 'thermal' ? '0' : `${template.pagePaddingTopMm}mm ${template.pagePaddingSideMm}mm 0`};
        display: grid;
        grid-template-columns: repeat(${template.columns}, ${template.labelWidthMm}mm);
        grid-template-rows: repeat(${template.rows}, ${template.labelHeightMm}mm);
        column-gap: ${template.gapXmm}mm;
        row-gap: ${template.gapYmm}mm;
        justify-content: center;
        align-content: start;
        background: #ffffff;
      }
      .sheet + .sheet { page-break-before: always; break-before: page; }
      .label {
        width: ${template.labelWidthMm}mm;
        height: ${template.labelHeightMm}mm;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        background: #ffffff;
        color: #111827;
        overflow: hidden;
        padding: 1.6mm 1.6mm 1.2mm;
      }
      .label.cut-border {
        border: 0.25mm dashed rgba(17, 24, 39, 0.8);
      }
      .meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1mm;
        min-height: 4mm;
        padding-bottom: 0.8mm;
        border-bottom: 0.18mm solid rgba(17, 24, 39, 0.15);
      }
      .store-name {
        max-width: 62%;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        font-size: 5.8pt;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .price {
        margin-left: auto;
        font-size: 9pt;
        font-weight: 900;
        white-space: nowrap;
      }
      .product-name {
        min-width: 0;
        padding-top: 0.7mm;
      }
      .product-brand {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 5.5pt;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(17, 24, 39, 0.7);
      }
      .product-copy {
        display: block;
        font-size: 7.5pt;
        line-height: 1.2;
        font-weight: 800;
        letter-spacing: -0.01em;
        margin-top: 0.6mm;
        color: #111827;
      }
      .barcode-wrap {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        min-height: 14mm;
        margin-top: 1mm;
      }
      /*
       * The bars must NOT be stretched to fit the label.
       *
       * Scaling a barcode rounds module boundaries, and the narrow bars end up
       * blurred — the single most common reason a label that "looks fine" will
       * not scan. Instead the SVG is laid out in millimetres at whole module
       * widths and centred, so the printer reproduces the exact bar sizes.
       */
      .barcode-wrap svg {
        display: block;
        height: auto;
        max-width: 100%;
        shape-rendering: crispEdges;
      }
      /* Silent warning when a code cannot be printed legibly at this size. */
      .barcode-overflow {
        font-size: 6.5pt;
        color: #b91c1c;
        font-weight: 700;
      }
      .missing {
        font-size: 7pt;
        color: rgba(17, 24, 39, 0.6);
        font-style: italic;
      }
      @media print {
        body { margin: 0; }
      }
    `;

    const pagesHtml = printPages.map((pageItems, pageIndex) => `
      <section class="sheet" aria-label="Barcode label sheet ${pageIndex + 1}">
        ${pageItems.map(item => `
          <article class="label${showCutBorders ? ' cut-border' : ''}">
            <div class="meta">
              ${showStoreName ? `<span class="store-name">${storeName}</span>` : '<span></span>'}
              ${showPrice ? `<strong class="price">GH₵ ${Number(item.price).toFixed(2)}</strong>` : ''}
            </div>
            ${showProductName ? `
              <div class="product-name">
                <span class="product-brand">${escapeHtml(item.brand)}</span>
                <span class="product-copy">${escapeHtml(item.productName)}${showVariantName && item.variantName ? ` · ${escapeHtml(item.variantName)}` : ''}</span>
              </div>
            ` : ''}
            <div class="barcode-wrap">
              ${item.barcode ? renderLabelSvg(item.barcode, {
              widthMm: template.labelWidthMm - 3.2,
              heightMm: template.labelHeightMm,
            }) : '<span class="missing">[No Barcode Assigned]</span>'}
            </div>
          </article>
        `).join('')}
      </section>
    `).join('');

    printWindow.document.open();
    printWindow.document.write(`<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Barcode Labels</title>
          <style>${pageStyle}</style>
        </head>
        <body>
          ${pagesHtml}
          <script>window.addEventListener('load', function () { setTimeout(function () { window.focus(); window.print(); }, 250); });</script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,25,38,0.42)] p-2 sm:p-4">
      <div className="form-sheet print:hidden flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-[28px] border">
        <div className="flex items-center justify-between border-b border-[var(--sheet-line)] bg-[var(--sheet-panel)] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
              <Barcode className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-black tracking-tight text-[var(--sheet-ink)]">Barcode Labels</h2>
              <p className="text-xs text-[var(--sheet-ink-4)]">Print clean product stickers for inventory and checkout</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrint}
              disabled={flatLabels.length === 0}
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--sheet-solid)] px-4 py-2 text-xs font-bold text-[var(--sheet-solid-ink)] transition hover:bg-[var(--sheet-solid-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Printer className="h-4 w-4" />
              Print {flatLabels.length} {flatLabels.length === 1 ? 'label' : 'labels'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close barcode modal"
              className="rounded-xl p-2 text-[var(--sheet-ink-5)] transition hover:bg-[var(--sheet-hover)] hover:text-[var(--sheet-ink)]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-[var(--sheet-line)] bg-[var(--sheet-field)] px-5 py-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('select')}
              className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition ${
                activeTab === 'select'
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--sheet-line)] bg-[var(--sheet-field)] text-[var(--sheet-ink-3)] hover:border-[var(--sheet-line-strong)]'
              }`}
            >
              1. Select products
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('preview')}
              className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition ${
                activeTab === 'preview'
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-[var(--sheet-line)] bg-[var(--sheet-field)] text-[var(--sheet-ink-3)] hover:border-[var(--sheet-line-strong)]'
              }`}
            >
              2. Preview & layout
            </button>
          </div>

          {missingBarcodeCount > 0 && (
            <button
              type="button"
              onClick={handleAutoGenerateMissing}
              disabled={isGeneratingBarcodes}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-1.5 text-[11px] font-bold text-[var(--accent)] transition hover:bg-[var(--accent-soft)] disabled:cursor-wait disabled:opacity-60"
            >
              {isGeneratingBarcodes ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {missingBarcodeCount} missing
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'select' ? (
            <div className="space-y-4">
              <div className="flex flex-col gap-3 rounded-2xl border border-[var(--sheet-line)] bg-[var(--sheet-panel)] p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => handleToggleSelectAll(true)} className="rounded-lg border border-[var(--sheet-line)] bg-[var(--sheet-button)] px-3 py-1.5 text-[11px] font-bold text-[var(--sheet-ink-2)] transition hover:bg-[var(--sheet-hover)]">
                    Select all
                  </button>
                  <button type="button" onClick={() => handleToggleSelectAll(false)} className="rounded-lg border border-[var(--sheet-line)] bg-[var(--sheet-button)] px-3 py-1.5 text-[11px] font-bold text-[var(--sheet-ink-2)] transition hover:bg-[var(--sheet-hover)]">
                    Clear all
                  </button>
                  <button type="button" onClick={() => handleApplyPresetQuantity('one')} className="rounded-lg border border-[var(--sheet-line)] bg-[var(--sheet-button)] px-3 py-1.5 text-[11px] font-bold text-[var(--sheet-ink-2)] transition hover:bg-[var(--sheet-hover)]">
                    1 each
                  </button>
                  <button type="button" onClick={() => handleApplyPresetQuantity('stock')} className="rounded-lg border border-[var(--sheet-line)] bg-[var(--sheet-button)] px-3 py-1.5 text-[11px] font-bold text-[var(--sheet-ink-2)] transition hover:bg-[var(--sheet-hover)]">
                    Match stock
                  </button>
                  <button type="button" onClick={() => handleApplyPresetQuantity('five')} className="rounded-lg border border-[var(--sheet-line)] bg-[var(--sheet-button)] px-3 py-1.5 text-[11px] font-bold text-[var(--sheet-ink-2)] transition hover:bg-[var(--sheet-hover)]">
                    5 each
                  </button>
                </div>

                {missingBarcodeCount > 0 && (
                  <button type="button" onClick={handleAutoGenerateMissing} disabled={isGeneratingBarcodes} className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-bold text-[var(--accent-ink)] transition hover:bg-[var(--accent-strong)] disabled:opacity-60">
                    {isGeneratingBarcodes ? 'Generating…' : `Generate ${missingBarcodeCount}`}
                  </button>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sheet-ink-5)]" />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    placeholder="Search inventory..."
                    className="w-full rounded-xl border border-[var(--sheet-line)] bg-[var(--sheet-field)] py-2.5 pl-9 pr-10 text-xs font-medium text-[var(--sheet-ink)] outline-none transition focus:border-[var(--accent)]"
                  />
                  {searchTerm && (
                    <button type="button" onClick={() => setSearchTerm('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--sheet-ink-5)] hover:text-[var(--sheet-ink)]">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <select value={filterBarcodeStatus} onChange={e => setFilterBarcodeStatus(e.target.value as any)} className="rounded-xl border border-[var(--sheet-line)] bg-[var(--sheet-field)] px-3 py-2.5 text-xs font-bold text-[var(--sheet-ink-2)] outline-none">
                  <option value="all">All barcode status</option>
                  <option value="missing">Missing only</option>
                  <option value="has_barcode">With barcode</option>
                </select>
              </div>

              {unsavedBarcodeItems.length > 0 && (
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2.5 text-xs text-[var(--accent)]">
                  <span className="font-semibold">{unsavedBarcodeItems.length} barcode change{unsavedBarcodeItems.length === 1 ? '' : 's'} not saved</span>
                  <button type="button" onClick={() => void handleSaveBarcodeChanges()} disabled={isSavingBarcodes} className="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 font-bold text-[var(--accent-ink)] transition hover:bg-[var(--accent-strong)] disabled:opacity-60">
                    {isSavingBarcodes ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}

              <div className="overflow-hidden rounded-2xl border border-[var(--sheet-line)]">
                <div className="max-h-[56vh] overflow-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead className="sticky top-0 z-10 bg-[var(--sheet-sticky)] text-[10px] uppercase tracking-[0.12em] text-[var(--sheet-ink-4)]">
                      <tr>
                        <th className="px-3 py-2.5 text-center">Print</th>
                        <th className="px-3 py-2.5">Product</th>
                        <th className="px-3 py-2.5">Barcode</th>
                        <th className="px-3 py-2.5 text-right">Price</th>
                        <th className="px-3 py-2.5 text-center">Stock</th>
                        <th className="px-3 py-2.5 text-center">Qty</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--sheet-divide)]">
                      {filteredItems.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-3 py-12 text-center text-[var(--sheet-ink-5)]">No products match your current filters.</td>
                        </tr>
                      ) : (
                        filteredItems.map(item => (
                          <tr key={item.id} className={item.selected ? 'bg-[var(--accent-soft)]' : 'bg-transparent'}>
                            <td className="px-3 py-2.5 text-center">
                              <input type="checkbox" checked={item.selected} onChange={() => handleToggleItem(item.id)} className="h-4 w-4 rounded accent-[var(--sheet-check)]" />
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-2.5">
                                {item.image ? (
                                  <img src={item.image} alt="" className="h-9 w-9 rounded-lg object-cover ring-1 ring-[var(--sheet-line)]" />
                                ) : (
                                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--sheet-chip)] text-xs font-black text-[var(--sheet-ink-4)]">{(item.productName || 'P').charAt(0)}</div>
                                )}
                                <div className="min-w-0">
                                  <p className="truncate font-bold text-[var(--sheet-ink)]">{item.productName}</p>
                                  <p className="truncate text-[11px] text-[var(--sheet-ink-4)]">{item.brand}{item.variantName ? ` · ${item.variantName}` : ''}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <input value={item.barcode} onChange={e => handleUpdateBarcodeText(item.id, e.target.value)} className={`w-full rounded-lg border px-2.5 py-1.5 font-mono text-[11px] outline-none ${item.barcode ? 'border-[var(--sheet-line)] bg-[var(--sheet-panel)] text-[var(--sheet-ink)]' : 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'}`} />
                            </td>
                            <td className="px-3 py-2.5 text-right font-black text-[var(--sheet-ink)]">GH₵ {Number(item.price).toFixed(2)}</td>
                            <td className="px-3 py-2.5 text-center">
                              <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${item.stockCount <= 0 ? 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-300' : item.stockCount <= 5 ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--sheet-chip)] text-[var(--sheet-ink-2)]'}`}>
                                {item.stockCount}
                              </span>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="mx-auto inline-flex items-center overflow-hidden rounded-lg border border-[var(--sheet-line)] bg-[var(--sheet-field)]">
                                <button type="button" onClick={() => handleUpdateQuantity(item.id, -1)} className="px-2 py-1 text-[var(--sheet-ink-4)] transition hover:bg-[var(--sheet-hover)]">-</button>
                                <input type="number" min={1} max={999} value={item.quantityToPrint} onChange={e => handleSetExactQuantity(item.id, parseInt(e.target.value, 10))} className="w-10 border-x border-[var(--sheet-line)] bg-transparent px-1 py-1 text-center text-xs font-bold text-[var(--sheet-ink)] outline-none" />
                                <button type="button" onClick={() => handleUpdateQuantity(item.id, 1)} className="px-2 py-1 text-[var(--sheet-ink-4)] transition hover:bg-[var(--sheet-hover)]">+</button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 pt-1">
                <p className="text-xs text-[var(--sheet-ink-4)]">
                  {totalLabelsCount} labels • {selectedItems.length} products selected
                </p>
                <button type="button" onClick={() => setActiveTab('preview')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-bold text-[var(--accent-ink)] transition hover:bg-[var(--accent-strong)]">
                  Layout preview <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="grid gap-4 rounded-2xl border border-[var(--sheet-line)] bg-[var(--sheet-panel)] p-4 md:grid-cols-[1.8fr_1fr]">
                <div>
                  <p className="mb-2 text-[10px] font-black uppercase tracking-[0.18em] text-[var(--sheet-ink-4)]">Format</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {LABEL_TEMPLATES.map(t => (
                      <button key={t.id} type="button" onClick={() => setSelectedTemplateId(t.id)} className={`rounded-2xl border p-3 text-left transition ${selectedTemplateId === t.id ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--sheet-line)] bg-[var(--sheet-button)] text-[var(--sheet-ink-2)] hover:border-[var(--sheet-line-strong)]'}`}>
                        <p className="text-xs font-black">{t.name}</p>
                        <p className="mt-1 text-[10px] text-[var(--sheet-ink-4)]">{t.description}</p>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-[10px] font-black uppercase tracking-[0.18em] text-[var(--sheet-ink-4)]">Label elements</p>
                  <div className="space-y-2 text-xs text-[var(--sheet-ink-2)]">
                    <label className="flex items-center gap-2"><input type="checkbox" checked={showStoreName} onChange={e => setShowStoreName(e.target.checked)} className="rounded accent-[var(--sheet-check)]" />Store name</label>
                    <label className="flex items-center gap-2"><input type="checkbox" checked={showProductName} onChange={e => setShowProductName(e.target.checked)} className="rounded accent-[var(--sheet-check)]" />Product name</label>
                    <label className="flex items-center gap-2"><input type="checkbox" checked={showPrice} onChange={e => setShowPrice(e.target.checked)} className="rounded accent-[var(--sheet-check)]" />Price</label>
                    <label className="flex items-center gap-2"><input type="checkbox" checked={showBarcodeText} onChange={e => setShowBarcodeText(e.target.checked)} className="rounded accent-[var(--sheet-check)]" />Barcode text</label>
                    <label className="flex items-center gap-2"><input type="checkbox" checked={showCutBorders} onChange={e => setShowCutBorders(e.target.checked)} className="rounded accent-[var(--sheet-check)]" />Cut lines</label>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--sheet-line)] bg-[var(--sheet-panel)] p-3">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[var(--sheet-ink-4)]">Preview</p>
                  <button type="button" onClick={handlePrint} className="inline-flex items-center gap-2 rounded-lg bg-[var(--sheet-solid)] px-3 py-1.5 text-[11px] font-bold text-[var(--sheet-solid-ink)] transition hover:bg-[var(--sheet-solid-hover)]">
                    <Printer className="h-3.5 w-3.5" /> Print now
                  </button>
                </div>

                <div className="flex justify-center overflow-auto rounded-[24px] bg-[var(--sheet-paper-bed)] p-4">
                  <div className="shrink-0 bg-[#ffffff] shadow-xl" style={{ width: `${previewPageWidth}px`, aspectRatio: `${pageWidthMm} / ${pageHeightMm}`, boxSizing: 'border-box', paddingTop: template.category === 'thermal' ? 0 : `${template.pagePaddingTopMm * previewScale}px`, paddingInline: template.category === 'thermal' ? 0 : `${template.pagePaddingSideMm * previewScale}px` }}>
                    <div className="grid h-full w-full" style={{ gridTemplateColumns: `repeat(${template.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${template.rows}, minmax(0, 1fr))`, columnGap: `${template.gapXmm * previewScale}px`, rowGap: `${template.gapYmm * previewScale}px` }}>
                      {flatLabels.slice(0, template.labelsPerPage).map((item, index) => (
                        <div key={`preview-${item.id}-${index}`} className={`flex flex-col justify-between overflow-hidden bg-[#ffffff] px-2 py-1.5 text-black ${showCutBorders ? 'border border-dashed border-[#9c8b7e]' : ''}`} style={{ aspectRatio: `${template.labelWidthMm} / ${template.labelHeightMm}` }}>
                          <div className="flex items-center justify-between gap-1 border-b border-[rgba(77,52,38,0.3)] pb-1">
                            {showStoreName && <span className="truncate text-[7px] font-black uppercase tracking-wide text-[#45342a]">{storeSettings.storeName || 'ANDA C SMOKE HUB'}</span>}
                            {showPrice && <span className="ml-auto whitespace-nowrap text-[10px] font-black">GH₵ {Number(item.price).toFixed(2)}</span>}
                          </div>

                          {showProductName && (
                            <div className="min-w-0 py-1">
                              <p className="truncate text-[6px] font-bold uppercase tracking-wide text-[#55443a]">{item.brand}</p>
                              <p className="line-clamp-2 text-[9px] font-black leading-tight text-[#1b120e]">
                                {item.productName}
                                {showVariantName && item.variantName && <span className="font-medium text-[#45342a]"> · {item.variantName}</span>}
                              </p>
                            </div>
                          )}

                          <div className="flex h-12 w-full items-center justify-center overflow-hidden">
                            {item.barcode ? (
                              <div dangerouslySetInnerHTML={{ __html: generateCode128Svg(item.barcode, { height: 34, showText: showBarcodeText, fontSize: 9, quietZone: 8 }) }} className="h-12 w-full" />
                            ) : (
                              <div className="w-full rounded border border-[var(--accent)] bg-[var(--accent-soft)] px-2 py-1 text-center text-[8px] font-bold text-[var(--accent)]">Barcode needed</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-[var(--sheet-line)] bg-[var(--sheet-panel)] px-5 py-4">
          <p className="text-xs text-[var(--sheet-ink-4)]">{flatLabels.length} labels • {template.name}</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-xl border border-[var(--sheet-line)] bg-[var(--sheet-button)] px-4 py-2 text-xs font-bold text-[var(--sheet-ink-2)] transition hover:bg-[var(--sheet-hover)]">
              Close
            </button>
            <button type="button" onClick={handlePrint} disabled={flatLabels.length === 0} className="rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-bold text-[var(--accent-ink)] transition hover:bg-[var(--accent-strong)] disabled:opacity-60">
              Print now
            </button>
          </div>
        </div>
      </div>

      <div id="barcode-print-root" className="hidden print:block" style={{ width: pageWidthMm + 'mm', height: pageHeightMm + 'mm' }} />
    </div>
  );
};
