import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  Clock,
  Barcode,
  Check,
  Minus,
  PackageOpen,
  Plus,
  Printer,
  ReceiptText,
  Search,
  ShoppingBag,
  Smartphone,
  Tag,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useStore } from '../../../context/StoreContext';
import { useAlert } from '../../../context/AlertContext';
import { api, ApiError } from '../../../lib/api';
import { multiplyMinor, toMinor } from '../../../lib/money';
import { checkLocalServer, startHealthChecks, type ServerHealth } from '../../../lib/health';
import { resolveStorePhone } from '../../../lib/storeContact';
import type { Order, PaymentMethod, Product, ProductVariant } from '../../../types';

type PosLine = { product: Product; variant?: ProductVariant; quantity: number; priceType: 'retail' | 'wholesale'; wholesaleUnitPrice?: number };
type PosItem = { product: Product; variant?: ProductVariant; title: string; stock: number; barcode?: string };
type PaymentChoice = 'cash-on-delivery' | 'momo-mtn';

/** A ticket the cashier parked with the Hold button. */
type HeldSale = {
  id: string;
  ticketLabel: string;
  items: PosLine[];
  subtotal: number;
  discount: number;
  total: number;
  promoCode?: string | null;
  paymentMethod?: string | null;
  cashReceived?: number | null;
  heldBy?: string | null;
  createdAt: string;
  recalledAt?: string | null;
};
/**
 * True when the focused field must receive keystrokes exactly as typed.
 *
 * The global scanner capture is a blunt instrument: it takes a burst of fast
 * characters and moves them somewhere else. That is right for the counter's scan
 * box, but wrong anywhere a person is deliberately entering a code, a PIN or a
 * password — there the scanner's output belongs in the field, and taking it out
 * would either lose the value or submit the form from under their fingers.
 *
 * A field opts out by any of:
 *   - `data-barcode-input` on itself or an ancestor (the explicit marker)
 *   - `type="password"`, which covers every PIN field
 *   - an `id`, `name` or `data-barcode-input` value mentioning barcode or pin
 */
export function isScannerExempt(target: EventTarget | HTMLElement | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || element.nodeType !== 1) return false;

  const tag = element.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;

  // The explicit marker, on the field or any container it sits in.
  if (element.closest('[data-barcode-input]')) return true;

  const input = element as HTMLInputElement;
  if (input.type === 'password') return true;

  // Also treat it as an input rather than a lookup target when the field's own
  // identity says it holds a code.
  const identity = [input.id, input.name, input.getAttribute?.('data-barcode-input') || '']
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return identity
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .some(word => word === 'barcode' || word === 'barcodes' || word === 'pin' || word === 'pins');
}

/**
 * True when an identifier names a field that holds a code or a PIN.
 *
 * Matches whole words only, splitting on anything that is not a letter or digit.
 * A plain substring test would exempt unrelated fields whose names merely
 * contain those letters — `shipping` and `mapping` both contain "pin", so a
 * delivery-address field would have been treated as a PIN box and the scanner
 * would have been disabled on it.
 */
export function containsCodeWord(identity: string): boolean {
  return String(identity)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .some(word => word === 'barcode' || word === 'barcodes' || word === 'pin' || word === 'pins');
}

const currency = new Intl.NumberFormat('en-GH', { style: 'currency', currency: 'GHS' });
const lineKey = (line: PosLine | PosItem) => `${line.product.id}:${line.variant?.id || 'base'}`;

/**
 * Scanner detection thresholds.
 *
 * A USB/Bluetooth barcode scanner types its payload far faster than a person
 * can: typically 2-10 ms between characters, against 100-250 ms for deliberate
 * human typing. The judgement is made on the *average* speed of the burst and
 * its total length rather than on the slowest single keystroke, because one
 * delayed character — a busy machine, a browser hiccup — must not turn a real
 * scan into ordinary typing. 45 ms per character is still far away from human
 * speed, so a barcode typed by hand is not mistaken for a scan.
 */
export const SCANNER_MAX_AVG_GAP_MS = 45;
/** The live thresholds come from Settings; these are only the defaults. */
/**
 * A pause this long ends the current burst.
 *
 * Comfortably above the worst single keystroke gap so a brief stall does not
 * split one scan in half, and far below the gap between two deliberate
 * keystrokes by a person.
 */
export const SCANNER_PAUSE_RESET_MS = 250;
/** A 12-digit EAN-13 is 13 characters; anything shorter is not a scan. */
export const SCANNER_MIN_CHARS = 8;
/** Longest total burst still treated as one scan. */
export const SCANNER_BURST_WINDOW_MS = 2_500;
/** Guard so a pasted paragraph is never mistaken for a barcode. */
export const SCANNER_MAX_CODE_LENGTH = 128;

function money(value: number) {
  return currency.format(Number.isFinite(value) ? value : 0);
}

function escapeReceipt(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] || character));
}

export function AdminPOSWorkspace() {
  const { products, loading, error: storeError, fetchProducts, fetchOrders, orders, loadingOrders, storeSettings, validatePromoCode, adminSession, hardwareSettings } = useStore();
  const { showAlert } = useAlert();
  /** Live scanner timing, tuned from Settings rather than compiled in. */
  const scanner = hardwareSettings.scanner;
  const scannerRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<PosLine[]>([]);
  const [saleMode, setSaleMode] = useState<'retail' | 'wholesale'>('retail');
  const [wholesaleBuyer, setWholesaleBuyer] = useState('');
  const [wholesalePhone, setWholesalePhone] = useState('');
  const [payment, setPayment] = useState<PaymentChoice>('cash-on-delivery');
  const [scannerValue, setScannerValue] = useState('');
  const [cashReceived, setCashReceived] = useState('');
  const [reference, setReference] = useState('');
  const [senderPhone, setSenderPhone] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [discountAmount, setDiscountAmount] = useState(0);
  const [discountMessage, setDiscountMessage] = useState('');
  const [discountOpen, setDiscountOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Tickets parked mid-queue, shown in a drawer beside the counter.
  const [heldSales, setHeldSales] = useState<HeldSale[]>([]);
  const [heldSalesOpen, setHeldSalesOpen] = useState(false);
  /** Whether the hosted service is reachable so it can record this sale. */
  const [tillHealth, setTillHealth] = useState<ServerHealth>({
    ok: false, latencyMs: null, lastOkAt: null, checked: false,
  });
  const online = tillHealth.ok;
  useEffect(() => {
    let active = true;
    startHealthChecks();
    // Poll on a timer the component owns, so the indicator follows the same
    // clock as everything else on screen.
    const poll = () => {
      void checkLocalServer().then(health => { if (active) setTillHealth(health); });
    };
    poll();
    const timer = window.setInterval(poll, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const [saleKey, setSaleKey] = useState(() => `POS-${crypto.randomUUID()}`);
  const [deviceId, setDeviceId] = useState(() => {
    const key = 'anda_pos_device_id';
    try {
      const saved = localStorage.getItem(key);
      if (saved) return saved;
      const created = `browser-${crypto.randomUUID()}`;
      localStorage.setItem(key, created);
      return created;
    } catch {
      return 'till-local';
    }
  });

  /* Sales are attributed to whoever is signed in at this terminal. */
  const serverName = (adminSession.adminName || adminSession.email || 'Staff').trim();
  const isCashier = adminSession.adminRole === 'Cashier';
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);


  // The API server runs on this machine, so there is no remote to catch up with.
  // Load the catalogue once, then refresh when the window regains focus.
  useEffect(() => {
    let active = true;
    const loadCatalogue = async () => {
      try {
        await fetchProducts({ includeUnpublished: true });
      } finally {
        if (active) void fetchOrders();
      }
    };
    void loadCatalogue();
    const onFocus = () => { void loadCatalogue(); };
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchOrders, fetchProducts]);

  useEffect(() => {
    const timer = window.setTimeout(() => scannerRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [cart.length, payment, search]);

  const posProducts = products;
  const items = useMemo<PosItem[]>(() => posProducts.flatMap(product => {
    if (product.isPublished === false) return [];
    if (product.variants?.length) {
      return product.variants
        .filter(variant => variant.inStock && Number(variant.stockCount) > 0)
        .map(variant => ({ product, variant, title: `${product.name} - ${variant.name}`, stock: Number(variant.stockCount), barcode: variant.barcode }));
    }
    return product.inStock && Number(product.stockCount) > 0
      ? [{ product, title: product.name, stock: Number(product.stockCount), barcode: product.barcode }]
      : [];
  }), [posProducts]);

  const filteredItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter(item => {
      const searchable = [item.title, item.product.brand, item.product.id, item.variant?.id, item.barcode].filter(Boolean).join(' ').toLowerCase();
      return !needle || searchable.includes(needle);
    });
  }, [items, search]);

  const priceFor = (line: PosLine) => {
    const retailPrice = Number(line.variant?.price ?? line.product.price);
    const wholesalePrice = line.variant?.wholesalePrice ?? line.product.wholesalePrice;
    return line.priceType === 'wholesale'
      ? line.wholesaleUnitPrice ?? (wholesalePrice != null ? Number(wholesalePrice) : retailPrice)
      : retailPrice;
  };
  const hasWholesalePrice = (line: PosLine) => line.variant?.wholesalePrice != null || line.product.wholesalePrice != null;
  const itemCount = cart.reduce((sum, line) => sum + line.quantity, 0);
// Display figures stay in cedis; the money the till acts on is in pesewas, so a
// ticket total is exactly the sum of its printed lines.
  // Held in pesewas end to end; the cedi figures below are for display only.
  const grossSubtotalMinor = cart.reduce(
    (sum, line) => sum + multiplyMinor(toMinor(priceFor(line)) ?? 0, line.quantity),
    0,
  );
  const discountMinor = toMinor(discountAmount) ?? 0;
  const subtotalMinor = Math.max(0, grossSubtotalMinor - discountMinor);
  const grossSubtotal = grossSubtotalMinor / 100;
  const received = Number(cashReceived);
  const subtotal = subtotalMinor / 100;
  const total = subtotal;
  const totalMinor = subtotalMinor;
  const tenderedMinor = Number.isFinite(received) ? Math.round(received * 100) : 0;
  /** True when the customer has been asked for more than one payment. */
  const [splitPayment, setSplitPayment] = useState(false);
  const change = payment === 'cash-on-delivery' && Number.isFinite(received) ? Math.max(0, received - total) : 0;
  const applyDiscount = async () => {
    const code = promoCode.trim();
    if (!code) {
      setDiscountAmount(0);
      setDiscountMessage('Enter a promotion code.');
      return;
    }
    try {
      const result = await validatePromoCode(code, grossSubtotal);
      if (!result.valid) {
        setDiscountAmount(0);
        setDiscountMessage(result.message || 'This promotion is not valid.');
        return;
      }
      setPromoCode(result.promo?.code || code.toUpperCase());
      setDiscountAmount(result.discountAmount);
      setDiscountMessage(`${money(result.discountAmount)} discount applied.`);
    } catch (error: any) {
      setDiscountAmount(0);
      setDiscountMessage(error?.message || 'Could not validate this promotion.');
    }
  };

  const refundLatestSale = async () => {
    const latestSale = (orders || []).find(order => order.orderSource === 'pos' && order.status !== 'Refunded');
    if (!latestSale) {
      showAlert('There are no refundable POS sales.', 'info');
      return;
    }
    if (!window.confirm(`Refund sale ${latestSale.orderNumber} for ${money(Number(latestSale.total))}? Stock will be restored.`)) return;
    const reason = window.prompt('Enter a reason for this refund (at least 3 characters). It is recorded in the audit log.');
    if (reason === null) return;
    if (reason.trim().length < 3) {
      showAlert('A reason is required to refund a sale.', 'warning');
      return;
    }
    try {
      await api.post('/orders?action=refund', { orderId: latestSale.id, reason: reason.trim() });
      showAlert(`Sale ${latestSale.orderNumber} refunded and stock restored.`, 'success');
      await Promise.all([fetchProducts({ includeUnpublished: true }), fetchOrders()]);
    } catch (error: any) {
      showAlert(error?.data?.error || error?.message || 'Could not refund this sale.', 'error');
    }
  };

  const addToCart = (item: PosItem) => {
    setCart(previous => {
      const key = lineKey(item);
      const current = previous.find(line => lineKey(line) === key);
      if (current && current.quantity >= item.stock) {
        showAlert('That item is already at its available stock limit.', 'warning');
        return previous;
      }
      return current
        ? previous.map(line => lineKey(line) === key ? { ...line, quantity: line.quantity + 1 } : line)
        : [...previous, { product: item.product, variant: item.variant, quantity: 1, priceType: saleMode === 'wholesale' && (item.variant?.wholesalePrice ?? item.product.wholesalePrice) != null ? 'wholesale' : 'retail' }];
    });
  };

  const updatePriceType = (line: PosLine, priceType: PosLine['priceType']) => {
    setCart(previous => previous.map(item => lineKey(item) === lineKey(line) ? { ...item, priceType, wholesaleUnitPrice: priceType === 'retail' ? undefined : item.wholesaleUnitPrice } : item));
  };

  const updateWholesaleAmount = (line: PosLine, value: string) => {
    const amount = Number(value);
    setCart(previous => previous.map(item => lineKey(item) === lineKey(line)
      ? { ...item, priceType: 'wholesale', wholesaleUnitPrice: value.trim() && Number.isFinite(amount) && amount > 0 ? amount : undefined }
      : item));
  };

  /** Switch the ticket as a whole without inventing a wholesale price where none exists. */
  const setTicketMode = (mode: 'retail' | 'wholesale') => {
    setSaleMode(mode);
    setCart(previous => previous.map(line => ({
      ...line,
      priceType: mode === 'wholesale' && hasWholesalePrice(line) ? 'wholesale' : 'retail',
      wholesaleUnitPrice: mode === 'retail' ? undefined : line.wholesaleUnitPrice,
    })));
  };

  const updateLine = (line: PosLine, quantity: number) => {
    const max = Number(line.variant?.stockCount ?? line.product.stockCount);
    setCart(previous => quantity <= 0
      ? previous.filter(item => lineKey(item) !== lineKey(line))
      : previous.map(item => lineKey(item) === lineKey(line) ? { ...item, quantity: Math.min(quantity, max) } : item));
  };

  const scanItem = async () => {
    const code = scannerValue.trim();
    const value = code.toLowerCase();
    if (!value) return;

    const local = items.find(item => [item.product.id, item.product.name, item.variant?.id, item.variant?.name, item.barcode].filter(Boolean).some(candidate => String(candidate).toLowerCase() === value));
    if (local) {
      // In stock-in mode a scan selects the item to receive, it does not sell it.
      if (stockInMode) {
        setStockInTarget({
          product: local.product,
          variantId: local.variant?.id,
          label: local.title,
        });
        setStockInQuantity('1');
        return;
      }
      addToCart(local);
      return;
    }

    try {
      const result = await api.get<{ products: Product[] }>(`/products?scanCode=${encodeURIComponent(code)}&limit=1`);
      const product = result.products?.[0];
      const variant = product?.variants?.find(item => [item.id, item.name, item.barcode, item.serialNumber].filter(Boolean).some(candidate => String(candidate).toLowerCase() === value));

      if (product && variant) {
        const label = `${product.name} - ${variant.name}`;
        if (stockInMode) {
          setStockInTarget({ product, variantId: variant.id, label });
          setStockInQuantity('1');
        } else {
          addToCart({ product, variant, title: label, stock: Number(variant.stockCount), barcode: variant.barcode });
        }
      } else if (product && product.variants?.length) {
        if (stockInMode) showAlert('Scan the barcode on the specific variation you are receiving.', 'warning');
        else showAlert('Choose a variation before adding this product.', 'warning');
      } else if (product) {
        if (stockInMode) {
          setStockInTarget({ product, label: product.name });
          setStockInQuantity('1');
        } else {
          addToCart({ product, title: product.name, stock: Number(product.stockCount), barcode: product.barcode });
        }
      } else {
        // Nothing matched. Rather than only complaining, offer the two things a
        // cashier wants here: create the product with this code, or note it as
        // stock arriving.
        offerForUnknownCode(code);
      }
    } catch {
      showAlert('Could not search the catalogue right now.', 'error');
    }
    setScannerValue('');
    scannerRef.current?.focus();
  };

  /**
 * Prints an 80 mm receipt.
 *
 * 80 mm is the standard thermal roll width: about 72 mm of printable area once
 * the margins are taken off, which is roughly 48 characters at a readable size.
 * The layout is built for that width and paginates so a long sale runs onto a
 * second sheet rather than being clipped.
 */
  const printReceipt = (
    order: Order,
    existingWindow?: Window | null,
    paymentSummary?: {
      tenders?: Array<{ method: string; amount: number; tendered: number; reference?: string }>;
      change?: number;
    },
  ) => {
    const receipt = existingWindow || window.open('', '_blank');
    if (!receipt) return;

    const storeName = escapeReceipt(storeSettings.storeName || 'ANDA C SMOKE HUB');
    const storePhoneLine = escapeReceipt(resolveStorePhone(storeSettings.storePhone));
    const tin = storeSettings.tin ? escapeReceipt(storeSettings.tin) : '';
    const logoSrc = storeSettings.logo ? escapeReceipt(storeSettings.logo) : '';
    const servedBy = escapeReceipt(order.cashierName || serverName || 'Staff');
    const servedOn = new Date(order.createdAt);
    const servedDate = servedOn.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const servedTime = servedOn.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    const buyerName = order.shippingAddress?.fullName ? escapeReceipt(order.shippingAddress.fullName) : '';

    /* Items as table rows: name, unit price, quantity, line amount.
       The thermal roll is 72 mm printable, so the table uses fixed-width
       columns that fit without wrapping on the narrow paper. */
    const itemRows = order.items.map(item => {
      const unitPrice = Number(item.selectedVariant?.price ?? item.product.price);
      const variant = item.selectedVariant?.name ? ` (${escapeReceipt(item.selectedVariant.name)})` : '';
      const name = `${escapeReceipt(item.product.name)}${variant}`;
      const lineTotal = money(unitPrice * item.quantity);
      return `<tr>
        <td class="name">${name}<br><span class="qty">${item.quantity} × ${money(unitPrice)}</span></td>
        <td class="amount">${lineTotal}</td>
      </tr>`;
    }).join('');

    /* Payments: cash and MoMo shown separately, with the total tendered and
       any change due. A split sale lists every tender so the till balances. */
    const tenders = paymentSummary?.tenders?.length
      ? paymentSummary.tenders
      : [{ method: order.paymentMethod, amount: Number(order.total), tendered: Number(order.total), reference: order.paymentReference }];
    const cashTenders = tenders.filter(t => t.method === 'cash-on-delivery');
    const momoTenders = tenders.filter(t => t.method !== 'cash-on-delivery');
    const totalPaid = tenders.reduce((sum, t) => sum + Number(t.amount), 0);
    const changeDue = Math.max(0, Number(paymentSummary?.change ?? 0));
    const cashTotal = cashTenders.reduce((sum, t) => sum + Number(t.tendered), 0);
    const cashReference = cashTenders.find(t => t.reference)?.reference;
    const momoReference = momoTenders.find(t => t.reference)?.reference;

    const paymentRows = [
      cashTenders.length ? `<div class="pay-row"><span>Cash${cashReference ? `<em>${escapeReceipt(cashReference)}</em>` : ''}</span><b>${money(cashTotal)}</b></div>` : '',
      momoTenders.length ? `<div class="pay-row"><span>MTN MoMo${momoReference ? `<em>${escapeReceipt(momoReference)}</em>` : ''}</span><b>${money(momoTenders.reduce((s, t) => s + Number(t.amount), 0))}</b></div>` : '',
    ].filter(Boolean).join('');

    /* An 80 mm thermal roll: 72 mm printable, so the page is sized to the
       paper rather than to a sheet of A4. Width is fixed, height grows. */
    receipt.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt ${escapeReceipt(order.orderNumber)}</title><style>
      @page{size:80mm auto;margin:0}
      *{box-sizing:border-box}
      html,body{margin:0;padding:0;background:#fff}
      body{width:72mm;font-family:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:11px;line-height:1.5;color:#111;padding:3mm 0}
      
      /* Header */
      header{text-align:center;padding:2mm 0 4mm}
      .logo{max-width:24mm;max-height:12mm;margin:0 auto 3mm;display:block}
      h1{font-size:15px;font-weight:800;margin:0 0 1mm;letter-spacing:.5px;text-transform:uppercase}
      .tagline{font-size:9px;color:#666;margin:0 0 2mm;letter-spacing:.3px}
      .contact{font-size:10px;color:#444;margin:1mm 0}
      .tin{font-size:9px;font-weight:600;color:#333;margin:1mm 0;padding:1mm 2mm;background:#f5f5f5;border-radius:2px;display:inline-block}
      
      /* Dividers */
      .divider{border:none;border-top:1px dashed #ccc;margin:3mm 0}
      .divider-thick{border:none;border-top:2px solid #111;margin:3mm 0}
      
      /* Meta info */
      .meta{margin:2mm 0}
      .meta-row{display:flex;justify-content:space-between;font-size:10px;margin:1.5mm 0;gap:2mm}
      .meta-row .label{color:#666}
      .meta-row .value{font-weight:600;color:#111;text-align:right}
      .order-num{font-family:"SF Mono",Monaco,"Cascadia Code",monospace;font-size:11px;font-weight:700;letter-spacing:.5px}
      
      /* Items table */
      .items{margin:2mm 0}
      .item-row{display:flex;justify-content:space-between;align-items:flex-start;margin:2mm 0;gap:2mm;padding-bottom:2mm;border-bottom:1px dotted #e5e5e5}
      .item-row:last-child{border-bottom:none}
      .item-name{flex:1;font-size:11px;font-weight:500;color:#111;line-height:1.4}
      .item-qty{font-size:9px;color:#666;margin-top:0.5mm}
      .item-amount{font-size:11px;font-weight:600;color:#111;text-align:right;white-space:nowrap}
      
      /* Totals */
      .totals{margin:2mm 0}
      .total-row{display:flex;justify-content:space-between;font-size:11px;margin:1.5mm 0;gap:2mm}
      .total-row .label{color:#444}
      .total-row .value{font-weight:500;color:#111;text-align:right}
      .total-row.discount .value{color:#059669}
      .grand-total{display:flex;justify-content:space-between;font-size:14px;font-weight:800;margin:3mm 0 2mm;padding-top:2mm;border-top:2px solid #111;gap:2mm}
      .grand-total .label{color:#111}
      .grand-total .value{color:#111;text-align:right}
      
      /* Payment */
      .payment{margin:2mm 0;padding:2mm;background:#fafafa;border-radius:3mm}
      .pay-row{display:flex;justify-content:space-between;font-size:10px;margin:1.5mm 0;gap:2mm}
      .pay-row span{color:#444}
      .pay-row em{font-size:8px;color:#888;font-style:normal;margin-left:1mm}
      .pay-row b{font-weight:600;color:#111;text-align:right}
      .amount-paid{display:flex;justify-content:space-between;font-size:11px;font-weight:600;margin:2mm 0 1mm;padding-top:1.5mm;border-top:1px solid #ddd;gap:2mm}
      .change-due{display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:#059669;margin:1.5mm 0 0;padding-top:1.5mm;border-top:1px solid #059669;gap:2mm}
      
      /* Footer */
      footer{text-align:center;margin-top:4mm;padding-top:3mm;border-top:1px dashed #ccc}
      .thanks{font-size:11px;font-weight:600;color:#111;margin:0 0 1mm}
      .notice{font-size:9px;color:#666;font-style:italic;margin:2mm 0}
      .barcode{font-family:"SF Mono",Monaco,monospace;font-size:10px;letter-spacing:1px;color:#999;margin-top:2mm}
      
      /* Print button */
      button{width:100%;padding:3mm;background:#111;color:#fff;border:0;font-family:inherit;font-size:12px;font-weight:600;margin-top:4mm;cursor:pointer;border-radius:2mm}
      button:hover{background:#333}
      @media print{button{display:none}}
    </style></head><body>
      <header>
        ${logoSrc ? `<img class="logo" src="${logoSrc}" alt="">` : ''}
        <h1>${storeName}</h1>
        <p class="tagline">Your trusted retail partner</p>
        <p class="contact">${escapeReceipt(storeSettings.storeAddress || '')}</p>
        <p class="contact">${storePhoneLine}${storeSettings.storeEmail ? ` · ${escapeReceipt(storeSettings.storeEmail)}` : ''}</p>
        ${tin ? `<div><span class="tin">TIN: ${tin}</span></div>` : ''}
      </header>

      <div class="divider-thick"></div>

      <div class="meta">
        <div class="meta-row"><span class="label">Receipt No.</span><span class="value order-num">${escapeReceipt(order.orderNumber)}</span></div>
        <div class="meta-row"><span class="label">Date & Time</span><span class="value">${escapeReceipt(servedDate)} · ${escapeReceipt(servedTime)}</span></div>
        <div class="meta-row"><span class="label">Cashier</span><span class="value">${servedBy}</span></div>
        ${buyerName ? `<div class="meta-row"><span class="label">Customer</span><span class="value">${buyerName}</span></div>` : ''}
      </div>

      <div class="divider"></div>

      <div class="items">
        ${itemRows}
      </div>

      <div class="divider"></div>

      <div class="totals">
        <div class="total-row"><span class="label">Subtotal</span><span class="value">${money(Number(order.subtotal))}</span></div>
        ${Number(order.discount) > 0 ? `<div class="total-row discount"><span class="label">Discount${order.appliedPromoCode ? ` (${escapeReceipt(order.appliedPromoCode)})` : ''}</span><span class="value">-${money(Number(order.discount))}</span></div>` : ''}
        ${Number(order.shippingFee) > 0 ? `<div class="total-row"><span class="label">Delivery Fee</span><span class="value">${money(Number(order.shippingFee))}</span></div>` : ''}
        <div class="grand-total"><span class="label">TOTAL</span><span class="value">${money(Number(order.total))}</span></div>
      </div>

      <div class="divider"></div>

      <div class="payment">
        ${paymentRows}
        <div class="amount-paid"><span>Amount Paid</span><span>${money(totalPaid)}</span></div>
        ${changeDue > 0 ? `<div class="change-due"><span>Change Due</span><span>${money(changeDue)}</span></div>` : ''}
      </div>

      <footer>
        <p class="thanks">Thank you for your purchase!</p>
        <p class="notice">Goods sold are not returnable.</p>
        <div class="barcode">${escapeReceipt(order.orderNumber)}</div>
      </footer>

      <button onclick="window.print()">Print Receipt</button>
    </body></html>`);
    receipt.document.close();
  };

  /**
   * A split payment: several tenders whose amounts add up to the sale total.
   *
   * Amounts are held in pesewas so the sum is exact. Cash is the only tender
   * that may exceed what is owed — that surplus becomes change — so the counter
   * asks for what the customer handed over rather than the amount to allocate.
   */
  type Tender = {
    id: string;
    method: PaymentChoice;
    /** Minor units. */
    allocated: number;
    /** For cash: what was handed over. For others: the same as allocated. */
    tendered: number;
    reference: string;
    senderPhone: string;
  };

  const [tenders, setTenders] = useState<Tender[]>([]);

  const newTender = (method: PaymentChoice): Tender => ({
    id: crypto.randomUUID(),
    method,
    allocated: 0,
    tendered: 0,
    reference: '',
    senderPhone: '',
  });

  // Keeps a single-tender customer on the familiar path: one row matching the
  // payment they chose, pre-filled with the sale total.
  useEffect(() => {
    if (tenders.length === 1) {
      setTenders(current => current.map(tender => ({
        ...tender,
        method: payment,
        allocated: totalMinor,
        tendered: payment === 'cash-on-delivery' ? (tenderedMinor || totalMinor) : totalMinor,
      })));
      return;
    }
    // No tenders yet: create the first one for the chosen payment method.
    if (!tenders.length) {
      setTenders([{ ...newTender(payment), allocated: totalMinor, tendered: payment === 'cash-on-delivery' ? (tenderedMinor || totalMinor) : totalMinor }]);
      return;
    }
    // Multiple tenders: changing the payment method switches to a fresh single tender.
    setTenders([{ ...newTender(payment), allocated: totalMinor, tendered: payment === 'cash-on-delivery' ? (tenderedMinor || totalMinor) : totalMinor }]);
    setSplitPayment(true);
  }, [payment, totalMinor, tenderedMinor, tenders.length]);

  const allocatedMinor = tenders.reduce((sum, tender) => sum + Math.max(0, tender.allocated), 0);
  const totalTenderedMinor = tenders.reduce((sum, tender) => sum + Math.max(0, tender.tendered), 0);
  const changeMinor = Math.max(0, totalTenderedMinor - allocatedMinor);
  const shortfallMinor = Math.max(0, totalMinor - allocatedMinor);

  const completeSale = async () => {
    if (!cart.length || submitting) return;
    if (saleMode === 'wholesale' && (!wholesaleBuyer.trim() || !wholesalePhone.trim())) {
      showAlert('Add the wholesale buyer name and phone before completing this sale.', 'warning');
      return;
    }
    if (!online) {
      showAlert('The cloud POS service is unavailable. Reconnect before completing a sale.', 'error');
      return;
    }

    // A non-cash tender cannot exceed what is owed: there is no drawer to give
    // change from, and accepting it would leave the till short.
    for (const tender of tenders) {
      if (tender.method !== 'cash-on-delivery' && tender.tendered > tender.allocated + allocatedMinor - totalMinor) {
        showAlert('A mobile-money payment must match the amount it is paying.', 'warning');
        return;
      }
    }

    if (shortfallMinor > 0) {
      showAlert(`The payments are ${money(shortfallMinor / 100)} short of the sale total.`, 'warning');
      return;
    }

    setSubmitting(true);
    const receiptWindow = window.open('', '_blank');
    try {
      const payload = {
        orderSource: 'pos', saleType: saleMode, idempotencyKey: saleKey, subtotal: grossSubtotal, shippingFee: 0, discount: discountMinor / 100, total,
        appliedPromoCode: promoCode.trim() || undefined,
        // Retained for older builds and for the receipt's summary line; the
        // tenders below are what the server uses.
        paymentMethod: payment as PaymentMethod, paymentStatus: 'paid', deliveryMethod: 'store-pickup',
        paymentReference: tenders.find(t => t.method === 'momo-mtn')?.reference.trim() || undefined,
        paymentSenderPhone: tenders.find(t => t.method === 'momo-mtn')?.senderPhone.trim() || undefined,
        cashReceived: tenderedMinor > 0 ? tenderedMinor / 100 : undefined,
        tenders: tenders.map(tender => ({
          method: tender.method,
          amount: tender.allocated,
          reference: tender.reference.trim() || undefined,
          senderPhone: tender.senderPhone.trim() || undefined,
        })),
        shippingAddress: {
          fullName: saleMode === 'wholesale' ? wholesaleBuyer.trim() : 'Walk-in customer',
          phone: saleMode === 'wholesale' ? wholesalePhone.trim() : tenders.find(t => t.method === 'momo-mtn')?.senderPhone.trim() || 'In-store sale',
          city: saleMode === 'wholesale' ? 'Wholesale account' : 'In-store',
          area: saleMode === 'wholesale' ? 'POS wholesale counter' : 'POS counter',
        },
        items: cart.map(line => ({
          product: { id: line.product.id, name: line.product.name, brand: line.product.brand, price: priceFor(line), image: line.variant?.image || line.product.image, unit: line.product.unit, category: line.product.category, inStock: true, stockCount: Number(line.variant?.stockCount ?? line.product.stockCount) },
          quantity: line.quantity,
          selectedVariant: line.variant ? { id: line.variant.id, name: line.variant.name, price: priceFor(line), inStock: true } : undefined,
          priceType: line.priceType,
          wholesaleUnitPrice: line.priceType === 'wholesale' && line.wholesaleUnitPrice != null ? line.wholesaleUnitPrice : undefined,
        })),
      };
      const order = await api.post<Order>('/orders?channel=pos', payload);
      printReceipt(order, receiptWindow, {
        tenders: tenders.map(tender => ({
          method: tender.method,
          amount: tender.allocated / 100,
          tendered: tender.tendered / 100,
          reference: tender.reference.trim() || undefined,
        })),
        change: changeMinor / 100,
      });
      showAlert(`Sale ${order.orderNumber} completed. Stock was updated.`, 'success');
      setCart([]); setCashReceived(''); setReference(''); setSenderPhone(''); setPromoCode(''); setDiscountAmount(0); setDiscountMessage(''); setDiscountOpen(false); setSaleMode('retail'); setWholesaleBuyer(''); setWholesalePhone(''); setSaleKey(`POS-${crypto.randomUUID()}`);
      setTenders([]); setSplitPayment(false);
      await Promise.all([fetchProducts({ includeUnpublished: true }), fetchOrders()]);
    } catch (error: any) {
      receiptWindow?.close();
      const unreachable = error instanceof TypeError || (error instanceof ApiError && (error.status === 408 || error.status === 503));
      showAlert(
        unreachable
          ? 'Cannot reach the cloud POS service. Reconnect, then try this sale again.'
          : error?.data?.error || error?.message || 'Could not complete this sale.',
        'error',
      );
    } finally {
      setSubmitting(false);
      scannerRef.current?.focus();
    }
  };

  /**
   * Parks the current ticket so the next customer can be served.
   *
   * Stored through the API rather than in browser storage, so the ticket
   * survives a refresh, a crash and a shift change.
   */
  const holdSale = async () => {
    if (!cart.length) {
      showAlert('There is no active sale to hold.', 'warning');
      return;
    }
    try {
      await api.post('/held-sales', {
        items: cart,
        subtotal: grossSubtotal,
        discount: discountAmount,
        total: subtotal,
        promoCode: promoCode.trim() || undefined,
        paymentMethod: payment,
        cashReceived: Number(cashReceived) || undefined,
        deviceId,
      });
      setCart([]); setCashReceived(''); setReference(''); setSenderPhone(''); setPromoCode(''); setDiscountAmount(0); setDiscountMessage(''); setDiscountOpen(false);
      setHeldSalesOpen(true);
      showAlert('Sale held. Recall it whenever that customer comes back.', 'success');
    } catch (error: any) {
      showAlert(error?.data?.error || error?.message || 'Could not hold this sale.', 'error');
    } finally {
      scannerRef.current?.focus();
    }
  };

  /** Fetches the parked tickets so the drawer shows what is waiting. */
  const loadHeldSales = useCallback(async () => {
    try {
      const result = await api.get<{ heldSales: HeldSale[] }>('/held-sales');
      setHeldSales(result?.heldSales || []);
    } catch {
      setHeldSales([]);
    }
  }, []);

  useEffect(() => {
    if (heldSalesOpen) void loadHeldSales();
  }, [heldSalesOpen, loadHeldSales]);

  /** Puts a parked ticket back on the counter. */
  const recallHeldSale = async (id: string) => {
    try {
      const held = await api.post<HeldSale>('/held-sales?action=recall', { id });
      setCart((held.items || []).map(item => ({ ...item, priceType: item.priceType ?? 'retail' })) as PosLine[]);
      if (held.promoCode) setPromoCode(held.promoCode);
      if (held.cashReceived) setCashReceived(String(held.cashReceived));
      if (held.paymentMethod) setPayment(held.paymentMethod as PaymentChoice);
      setHeldSalesOpen(false);
      showAlert('Ticket recalled onto the counter.', 'success');
      scannerRef.current?.focus();
    } catch (error: any) {
      showAlert(error?.data?.error || error?.message || 'Could not recall that ticket.', 'error');
    }
  };

  /** Throws a parked ticket away without selling it. */
  const discardHeldSale = async (id: string) => {
    if (!window.confirm('Discard this held ticket? Its items will be lost.')) return;
    try {
      await api.delete(`/held-sales?id=${encodeURIComponent(id)}`);
      await loadHeldSales();
      showAlert('Held ticket discarded.', 'info');
    } catch (error: any) {
      showAlert(error?.data?.error || error?.message || 'Could not discard that ticket.', 'error');
    }
  };

  /**
   * Takes the last line off the ticket being rung up right now.
   *
   * The sale has not been committed yet, so nothing moved in the database or
   * the till's takings: this is a screen-only edit, and any cashier can do it
   * without giving a reason. Voiding a line on a sale that has *already* been
   * rung up is a different action and needs a manager and a written reason.
   */
  const voidLine = () => {
    if (!cart.length) {
      showAlert('There is no line item to remove.', 'warning');
      return;
    }
    setCart(previous => previous.slice(0, -1));
    showAlert('Line removed from this ticket. Nothing was charged.', 'info');
    scannerRef.current?.focus();
  };

  const posHistory = (orders || []).filter(order => order.orderSource === 'pos').slice(0, 12);
  const todayTotal = (orders || [])
    .filter(order => order.orderSource === 'pos' && new Date(order.createdAt).toDateString() === new Date().toDateString())
    .reduce((sum, order) => sum + Number(order.total || 0), 0);
  const lowStockCount = items.filter(item => item.stock <= 5).length;

  /**
   * "Last backup" for the counter, so staff can see at a glance whether the
   * till's data is being protected. Manager-only, so a cashier just sees it
   * hidden rather than an error.
   */
  const [lastBackup, setLastBackup] = useState<{ exists: boolean; createdAt: string | null; ageHours: number | null; due: boolean; managedBy?: string | null } | null>(null);
  const isManager = adminSession.adminRole === 'Super Admin' || adminSession.adminRole === 'Store Manager';
  useEffect(() => {
    if (!isManager) return;
    let active = true;
    const load = () => {
      api.get<{ last: typeof lastBackup }>('/backups?action=list')
        .then(result => { if (active) setLastBackup(result?.last ?? null); })
        .catch(() => { if (active) setLastBackup(null); });
    };
    void load();
    // Refresh on focus so the age shown is not left stale across a long shift.
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => { active = false; window.removeEventListener('focus', onFocus); };
  }, [isManager]);

  /**
   * A scanned code that matched nothing.
   *
   * Rather than only saying "no match", the counter offers the two things a
   * cashier actually wants at that moment: open a new product with the code
   * already filled in, or put the item into stock.
   */
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  /** When true, the next scan selects an item to receive rather than sell it. */
  const [stockInMode, setStockInMode] = useState(false);
  const [stockInTarget, setStockInTarget] = useState<{ product: Product; variantId?: string; label: string } | null>(null);
  const [stockInQuantity, setStockInQuantity] = useState('1');
  const [stockInSaving, setStockInSaving] = useState(false);

  /** Opens the product form for an unknown code, with the code pre-filled. */
  const openNewProductFor = useCallback((code: string) => {
    setUnknownCode(null);
    window.dispatchEvent(new CustomEvent('anda-open-product-form', { detail: { barcode: code } }));
  }, []);

  /** Starts a stock-in for the item that was just scanned. */
  const openStockInFor = useCallback((product: Product, variantId?: string, label?: string) => {
    setUnknownCode(null);
    setStockInTarget({ product, variantId, label: label || product.name });
    setStockInQuantity('1');
  }, []);

  /**
   * Adds units to a scanned product.
   *
   * Stock-in is deliberately not a sale: no money moves, so it is recorded as an
   * inventory adjustment rather than a till transaction, and it does not touch
   * the day's takings.
   */
  const confirmStockIn = async () => {
    if (!stockInTarget) return;
    const quantity = Math.floor(Number(stockInQuantity));
    if (!Number.isFinite(quantity) || quantity < 1) {
      showAlert('Enter how many units arrived.', 'warning');
      return;
    }
    setStockInSaving(true);
    try {
      await api.post('/stock-in', {
        productId: stockInTarget.product.id,
        variantId: stockInTarget.variantId,
        quantity,
      });
      showAlert(`${quantity} unit${quantity === 1 ? '' : 's'} added to ${stockInTarget.label}.`, 'success');
      setStockInTarget(null);
      setStockInMode(false);
      await fetchProducts({ includeUnpublished: true });
    } catch (error: any) {
      showAlert(error?.data?.error || error?.message || 'Could not record the stock-in.', 'error');
    } finally {
      setStockInSaving(false);
      scannerRef.current?.focus();
    }
  };

  /** Called by the scan path when a code matched nothing. */
  const offerForUnknownCode = useCallback((code: string) => {
    setUnknownCode(code);
  }, []);

  /**
   * One field drives the counter. Typing filters the tiles and Enter commits a
   * line: an exact code wins, a single match is added, several matches ask the
   * cashier to tap one, and only a genuine miss falls back to the server scan.
   */
  const commitScan = async () => {
    const value = scannerValue.trim().toLowerCase();
    if (!value) return;
    const exact = items.find(item => [item.product.id, item.product.name, item.variant?.id, item.variant?.name, item.barcode]
      .filter(Boolean)
      .some(candidate => String(candidate).toLowerCase() === value));

    // In stock-in mode a scan selects the item to receive rather than selling
    // it. Handled here as well as in scanItem, because the Enter key on the scan
    // box comes through this path.
    if (stockInMode && exact) {
      setStockInTarget({ product: exact.product, variantId: exact.variant?.id, label: exact.title });
      setStockInQuantity('1');
      setScannerValue('');
      setSearch('');
      scannerRef.current?.focus();
      return;
    }

    if (exact) { addToCart(exact); return; }
    if (filteredItems.length === 1) { addToCart(filteredItems[0]); return; }
    if (filteredItems.length > 1) {
      showAlert(`${filteredItems.length} items match that. Tap the one you want to sell.`, 'info');
      return;
    }
    await scanItem();
  };

  /** The single input feeds both the scanner and the tile filter. */
  const handleScanChange = (value: string) => {
    setScannerValue(value);
    setSearch(value);
  };

  const clearScan = () => {
    setScannerValue('');
    setSearch('');
    scannerRef.current?.focus();
  };

  /**
   * Hardware scanners type like a fast typist and finish with Enter.
   *
   * The scanner's characters go wherever focus happens to be, so if the cashier
   * left the cursor in the cash field the code lands there and the sale is lost.
   * This watches for that pattern — several characters in quick succession,
   * finished by Enter — and once it is confident the keystrokes came from a
   * scanner, pulls focus back to the scan box and re-runs the buffered code
   * through the normal path. Characters are only taken back from a field when
   * they are the tail of a burst that ended in Enter, so ordinary typing and
   * Enter-to-confirm are untouched.
   */
  const scannerBurst = useRef<{ chars: number; startedAt: number; lastAt: number; text: string }>({
    chars: 0,
    startedAt: 0,
    lastAt: 0,
    text: '',
  });

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      // Fields that exist to *receive* a typed code are left alone entirely.
      if (isScannerExempt(target)) {
        scannerBurst.current = { chars: 0, startedAt: 0, lastAt: 0, text: '' };
        return;
      }

      // ── Scanner detection ────────────────────────────────────────────────
      // The characters are accumulated here rather than read back from the
      // field afterwards, so the code is recovered even when it was typed into
      // a field that cannot be read back cleanly, and even when focus was on
      // the page body with no field involved at all.
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const burst = scannerBurst.current;
        const now = event.timeStamp;
        // A long pause means this character starts a new burst: whatever came
        // before was human typing, not one scan.
        if (burst.chars > 0 && now - burst.lastAt > scanner.pauseResetMs) {
          burst.chars = 0;
          burst.text = '';
        }
        if (burst.chars === 0) burst.startedAt = now;
        burst.chars++;
        burst.lastAt = now;
        burst.text += event.key;
        return;
      }

      // Enter and Tab both terminate a scan: most scanners send Enter, but some
        // are configured for Tab, and a till that silently ignored those would
        // look broken for no visible reason.
        if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
        const burst = scannerBurst.current;
        const elapsed = event.timeStamp - burst.startedAt;
        const avgGap = burst.chars > 1 ? elapsed / (burst.chars - 1) : Number.POSITIVE_INFINITY;

        // Judged on the average speed of the burst, so one slow keystroke on a
        // busy machine does not stop a real scan being recognised.
        const looksLikeScanner = burst.chars >= scanner.minChars
          && elapsed <= scanner.maxBurstMs
          && avgGap <= scanner.maxAverageGapMs
          && burst.text.length <= scanner.maxCodeLength;

        const scanned = looksLikeScanner ? burst.text : '';
        scannerBurst.current = { chars: 0, startedAt: 0, lastAt: 0, text: '' };
        if (!looksLikeScanner) return;

        // Take the burst back out of whatever field it landed in, so the code
        // does not stay visible in (or get submitted from) the wrong place.
        if (event.target !== scannerRef.current) {
          const field = event.target as HTMLInputElement | HTMLTextAreaElement | null;
          if (field && typeof field.value === 'string' && field.value.endsWith(scanned)) {
            const kept = field.value.slice(0, field.value.length - scanned.length);
            // Controlled React inputs keep their own copy of the value, so
            // assigning `.value` alone would be overwritten on the next render.
            // Go through React's own value setter and fire the event it
            // listens for, which puts the field back in the component's state.
            const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
            const setter = Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set;
            if (setter) {
              setter.call(field, kept);
              field.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
              field.value = kept;
            }
          }
        }

        // Run the recovered code through the same matching path as a typed one,
        // then hand focus back to the scan box for the next customer.
        event.preventDefault();
        event.stopPropagation();
        setScannerValue(scanned);
        setSearch(scanned);
        void commitScanFor(scanned);
        scannerRef.current?.focus();
        return;
      }

      if ((event.key === 'F4' || event.key === 'F1' || event.key === 'F5' || event.key === 'F3') && !isTyping) {
        // ── Existing shortcuts ──────────────────────────────────────────────
        event.preventDefault();
        if (event.key === 'F4' || event.key === 'F1') {
          if (cart.length) void completeSale();
        } else if (event.key === 'F5') {
          void holdSale();
        } else {
          scannerRef.current?.focus();
          scannerRef.current?.select();
        }
        return;
      }

      // Any other key ends the burst without being a scan.
      scannerBurst.current = { chars: 0, startedAt: 0, lastAt: 0, text: '' };
    };

    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, [cart.length, completeSale, holdSale, scannerValue, scanner]);

  /** Runs a recovered code through the same matching path as a typed one. */
  const commitScanFor = async (raw: string) => {
    const value = raw.trim().toLowerCase();
    if (!value) return;
    const exact = items.find(item => [item.product.id, item.product.name, item.variant?.id, item.variant?.name, item.barcode]
      .filter(Boolean)
      .some(candidate => String(candidate).toLowerCase() === value));
    if (exact) { addToCart(exact); return; }
    await scanItem();
  };

return (
    <div className="min-h-0 space-y-4 text-[var(--text-primary)]">
      {/* ── Counter bar: connectivity + the shift gate, which must be visible
             before a cashier starts selling. ── */}
      <div className="lux-card flex flex-wrap items-center gap-2 px-3 py-2.5">
        <span
          className={`lux-chip ${!online || storeError ? 'lux-chip--warning' : 'lux-chip--success'}`}
          title={online
            ? `Connected${tillHealth.latencyMs != null ? ` (${tillHealth.latencyMs} ms)` : ''}.`
            : 'No connection. Sales cannot be recorded until the register is back online.'}
        >
          {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {!online ? 'Not connected' : storeError ? 'Inventory unavailable' : loading ? 'Loading inventory' : products.length === 0 ? 'Inventory empty' : 'Ready to sell'}
        </span>

        <span className="hidden items-center gap-1.5 text-xs text-[var(--text-muted)] sm:flex">
          Today
          <b className="tabular-nums text-[var(--text-primary)]">{money(todayTotal)}</b>
        </span>

        {lowStockCount > 0 && (
          <span className="lux-chip lux-chip--warning" title="Items with 5 or fewer units left">
            <AlertTriangle className="h-3 w-3" />
            {lowStockCount} low
          </span>
        )}

        {/* Whoever is on this terminal, and when. Every sale is stamped with
            both, so the register always answers "who served, and when". */}
        <div className="ml-auto flex items-center gap-2">
          <span
            className="flex items-center gap-2 rounded-full border border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-card)_70%,transparent)] py-1.5 pl-1.5 pr-3"
            title="This sale will be recorded against your name"
          >
            <span className="grid h-6 w-6 place-items-center rounded-full bg-[var(--accent)] text-[10px] font-extrabold text-[var(--accent-ink)]">
              {(serverName || 'S').charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0">
              <span className="block text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--text-subtle)]">Served by</span>
              <span className="block max-w-32 truncate text-xs font-bold leading-tight text-[var(--text-primary)]">{serverName}</span>
            </span>
          </span>
          <time
            dateTime={now.toISOString()}
            className="hidden items-center gap-1.5 rounded-full border border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-card)_70%,transparent)] px-3 py-2 text-xs font-bold tabular-nums text-[var(--text-primary)] sm:inline-flex"
            title={now.toLocaleString()}
          >
            <Clock className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
            {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* ── LEFT: scan, then stock ── */}
        <div className="min-w-0 space-y-4">
          <section className="lux-card p-3 sm:p-4" aria-label="Sale type">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="eyebrow">Sale type</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">Wholesale applies each available bulk price and keeps the buyer on the sale record.</p>
              </div>
              <div className="inline-flex rounded-xl border border-[var(--border-color)] bg-[var(--bg-soft)] p-1" role="group" aria-label="Choose sale type">
                {(['retail', 'wholesale'] as const).map(mode => (
                  <button key={mode} type="button" aria-pressed={saleMode === mode} onClick={() => setTicketMode(mode)} className={`rounded-lg px-3 py-1.5 text-xs font-bold capitalize transition ${saleMode === mode ? 'bg-[var(--accent)] text-[var(--accent-ink)] shadow-sm' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>
                    {mode}
                  </button>
                ))}
              </div>
            </div>
            {saleMode === 'wholesale' && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="lux-label">Buyer / business
                  <input value={wholesaleBuyer} onChange={event => setWholesaleBuyer(event.target.value)} placeholder="Business or buyer name" className="lux-input mt-1 w-full" />
                </label>
                <label className="lux-label">Buyer phone
                  <input value={wholesalePhone} onChange={event => setWholesalePhone(event.target.value)} placeholder="Phone number" inputMode="tel" className="lux-input mt-1 w-full" />
                </label>
              </div>
            )}
          </section>
          {/* One field: scan a code or type a name. */}
          <div className="lux-card p-3 sm:p-4">
            <div className="flex items-stretch gap-3">
              <label className="relative min-w-0 flex-1">
                <Barcode className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--accent)]" />
                <input
                  ref={scannerRef}
                  value={scannerValue}
                  onChange={event => handleScanChange(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') void commitScan(); }}
                  placeholder="Scan barcode or type a name"
                  aria-label="Scan a barcode or search for a product"
                  className="pos-scan w-full pl-11 pr-11"
                />
                {scannerValue && (
                  <button
                    type="button"
                    onClick={clearScan}
                    aria-label="Clear search"
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--text-subtle)] transition hover:bg-[var(--bg-soft)] hover:text-[var(--text-primary)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </label>

              <button
                type="button"
                onClick={() => void commitScan()}
                disabled={!scannerValue.trim()}
                className="lux-btn lux-btn--primary h-[3.25rem] shrink-0 sm:px-6"
              >
                Add
              </button>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 px-0.5">
              {!isCashier && (
                <button
                  type="button"
                  onClick={() => {
                    setStockInTarget(null);
                    setStockInMode(true);
                    setStockInQuantity('1');
                    setScannerValue('');
                    setSearch('');
                    showAlert('Scan a product to receive stock.', 'info');
                    scannerRef.current?.focus();
                  }}
                  title="Receive stock by scanning a product"
                  className="lux-btn lux-btn--outline lux-btn--sm shrink-0"
                >
                  <PackageOpen className="h-4 w-4" />
                  Stock in
                </button>
              )}

              <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
                <p className="truncate text-[11px] text-[var(--text-muted)]">
                  {search.trim()
                    ? `${filteredItems.length} match${filteredItems.length === 1 ? '' : 'es'} · Enter adds the first result`
                    : `${filteredItems.length} sellable item${filteredItems.length === 1 ? '' : 's'}`}
                </p>
                <kbd className="hidden shrink-0 rounded border border-[var(--border-color)] bg-[var(--bg-soft)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--text-subtle)] sm:block">F3</kbd>
              </div>
            </div>
          </div>

          {/* Stock tiles */}
          <div className="lux-card p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between gap-3 px-1">
              <p className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-[var(--text-subtle)]">Stock</p>
              <span className="text-xs text-[var(--text-muted)]">Tap to add to the ticket</span>
            </div>
            {loading ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }).map((_, index) => <div key={index} className="h-52 animate-pulse rounded-2xl bg-[var(--bg-soft)]" />)}</div>
            ) : filteredItems.length ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {filteredItems.map(item => (
                  <button type="button" key={lineKey(item)} onClick={() => addToCart(item)} className="group lux-card overflow-hidden text-left transition duration-200 hover:-translate-y-0.5 hover:border-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
                    <div className="relative">
                      <img src={item.variant?.image || item.product.image} alt="" className="h-28 w-full object-cover" />
                      <span className={`absolute right-2 top-2 rounded-md px-2 py-0.5 text-[10px] font-bold text-white ${item.stock <= 5 ? 'bg-[var(--highlight)]' : 'bg-black/70'}`}>{item.stock} left</span>
                    </div>
                    <div className="p-3">
                      <p className="line-clamp-2 min-h-10 text-sm font-semibold text-[var(--text-primary)]">{item.product.name}</p>
                      {item.variant && <p className="mt-0.5 truncate text-xs font-semibold text-[var(--accent-strong)]">{item.variant.name}</p>}
                      {item.stock <= 5 && <p className="mt-1 text-[10px] font-extrabold uppercase tracking-wide text-[var(--highlight)]">Low stock</p>}
                      <div className="mt-2.5 flex items-center justify-between gap-2">
                        <span className="text-sm font-bold tabular-nums text-[var(--text-primary)]">{money(saleMode === 'wholesale' && (item.variant?.wholesalePrice ?? item.product.wholesalePrice) != null ? Number(item.variant?.wholesalePrice ?? item.product.wholesalePrice) : Number(item.variant?.price ?? item.product.price))}</span>
                        <span className="rounded-lg bg-[var(--accent-soft)] p-1.5 text-[var(--accent)] transition group-hover:bg-[var(--accent)] group-hover:text-[var(--accent-ink)]"><Plus className="h-4 w-4" /></span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex min-h-56 flex-col items-center justify-center text-center">
                <PackageOpen className="h-9 w-9 text-[var(--text-subtle)]" />
                <p className="mt-3 text-sm font-bold text-[var(--text-primary)]">{search.trim() ? 'Nothing matches that' : 'No stock available'}</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">{search.trim() ? 'Clear the field to see everything in stock.' : 'Add inventory from the Stockroom to start selling.'}</p>
                {search.trim() && (
                  <button type="button" onClick={clearScan} className="lux-btn lux-btn--outline lux-btn--sm mt-4">Clear search</button>
                )}
              </div>
            )}
          </div>


          {/* Recent POS sales */}
          <section className="lux-card p-4 sm:p-5">
            {/* The shell's Refresh already pulls sales again, so the card does
                not carry a second button that does the same thing. */}
            <h2 className="brand-display text-lg font-semibold text-[var(--text-primary)]">Recent POS sales</h2>
            {posHistory.length ? (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[620px] text-left text-sm">
                  <thead className="border-b border-[var(--border-color)] text-[10px] font-extrabold uppercase tracking-wider text-[var(--text-subtle)]">
                    <tr><th className="px-3 py-2">Sale</th><th className="px-3 py-2">Cashier</th><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Payment</th><th className="px-3 py-2">Total</th><th className="px-3 py-2">When</th><th className="px-3 py-2 text-right">Receipt</th></tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-color)]">
                    {posHistory.map(order => (
                      <tr key={order.id}>
                        <td className="px-3 py-3 font-mono text-xs font-bold text-[var(--text-primary)]">{order.orderNumber}</td>
                        <td className="px-3 py-3 text-[var(--text-primary)]">
                          <span className="flex items-center gap-1.5">
                            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--accent-soft)] text-[9px] font-extrabold text-[var(--accent)]">
                              {(order.cashierName || '?').charAt(0).toUpperCase()}
                            </span>
                            <span className="truncate">{order.cashierName || 'Unrecorded'}</span>
                          </span>
                        </td>
                        <td className="px-3 py-3 text-[var(--text-primary)]">
                          <span className="flex items-center gap-1.5"><span>{order.shippingAddress?.fullName || 'Walk-in customer'}</span>{order.items?.some(item => item.priceType === 'wholesale') && <span className="lux-chip lux-chip--neutral text-[9px]">Wholesale</span>}</span>
                        </td>
                        <td className="px-3 py-3 capitalize text-[var(--text-muted)]">{order.paymentMethod.replaceAll('-', ' ')}</td>
                        <td className="px-3 py-3 font-bold tabular-nums text-[var(--text-primary)]">{money(Number(order.total))}</td>
                        <td className="whitespace-nowrap px-3 py-3 text-xs tabular-nums text-[var(--text-muted)]">{new Date(order.createdAt).toLocaleString()}</td>
                        <td className="px-3 py-3 text-right">
                          <button type="button" onClick={() => printReceipt(order)} aria-label={`Print receipt for ${order.orderNumber}`} className="lux-btn lux-btn--outline lux-btn--sm">
                            <Printer className="h-3.5 w-3.5" />
                            Print
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mt-4 rounded-2xl border border-dashed border-[var(--border-color)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">{loadingOrders ? 'Loading sales...' : 'No sales recorded at this register yet.'}</div>
            )}
          </section>
        </div>

{/* ── RIGHT: the ticket. Compact so the basket always has room. ── */}
        <aside className="min-w-0 lg:sticky lg:top-[4.5rem]">
          <section className="lux-card flex max-h-[calc(100vh-5.5rem)] flex-col overflow-hidden p-0">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--border-color)] px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <h2 className="brand-display text-base font-semibold text-[var(--text-primary)]">Current sale</h2>
                {saleMode === 'wholesale' && <span className="lux-chip lux-chip--neutral text-[9px]">Wholesale</span>}
              </div>
              <span className="lux-chip lux-chip--neutral shrink-0">{itemCount} item{itemCount === 1 ? '' : 's'}</span>
            </div>

            {/* Lines. min-h keeps the basket from collapsing when the
                settlement block below it is tall — that squeeze is what made
                this panel feel crowded and clipped the empty state. */}
            <div className="min-h-[9rem] flex-1 overflow-y-auto p-2.5">
              {cart.length ? (
                <ul className="space-y-1.5">
                  {cart.map(line => (
                    <li key={lineKey(line)} className="pos-line">
                      <img src={line.variant?.image || line.product.image} alt="" className="h-10 w-10 shrink-0 rounded-lg border border-[var(--border-color)] object-cover" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="truncate text-[13px] font-bold text-[var(--text-primary)]">{line.product.name}</p>
                          <button type="button" onClick={() => updateLine(line, 0)} aria-label={`Remove ${line.product.name}`} className="shrink-0 text-[var(--text-subtle)] transition hover:text-[var(--danger)]"><Trash2 className="h-4 w-4" /></button>
                        </div>
                        {line.variant && <p className="truncate text-[11px] font-semibold text-[var(--accent-strong)]">{line.variant.name}</p>}
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => updateLine(line, line.quantity - 1)} aria-label="Decrease quantity" className="pos-qty"><Minus className="h-3 w-3" /></button>
                            <b className="min-w-5 text-center text-xs tabular-nums text-[var(--text-primary)]">{line.quantity}</b>
                            <button type="button" onClick={() => updateLine(line, line.quantity + 1)} aria-label="Increase quantity" className="pos-qty"><Plus className="h-3 w-3" /></button>
                          </div>
                          <b className="text-[13px] tabular-nums text-[var(--text-primary)]">{money(priceFor(line) * line.quantity)}</b>
                        </div>
                        {hasWholesalePrice(line) && (
                          <div className="mt-1.5 inline-flex rounded-md border border-[var(--border-color)] bg-[var(--bg-soft)] p-0.5" role="group" aria-label={`${line.product.name} price type`}>
                            {(['retail', 'wholesale'] as const).map(priceType => (
                              <button
                                key={priceType}
                                type="button"
                                aria-pressed={line.priceType === priceType}
                                onClick={() => updatePriceType(line, priceType)}
                                className={`rounded px-2 py-1 text-[10px] font-semibold capitalize transition ${line.priceType === priceType ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                              >
                                {priceType}
                              </button>
                            ))}
                          </div>
                        )}
                        {saleMode === 'wholesale' && (
                          <div className="mt-2 grid grid-cols-2 gap-1.5">
                            <label className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-subtle)]">Qty
                              <input aria-label={`Wholesale quantity for ${line.product.name}`} type="number" min="1" max={Number(line.variant?.stockCount ?? line.product.stockCount)} step="1" value={line.quantity} onChange={event => updateLine(line, Number(event.target.value))} className="lux-input mt-0.5 h-8 w-full px-2 text-xs" />
                            </label>
                            <label className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-subtle)]">Wholesale amount
                              <input aria-label={`Wholesale unit amount for ${line.product.name}`} type="number" min="0.01" max={Number(line.variant?.price ?? line.product.price)} step="0.01" value={line.wholesaleUnitPrice ?? line.variant?.wholesalePrice ?? line.product.wholesalePrice ?? ''} onChange={event => updateWholesaleAmount(line, event.target.value)} placeholder="Per unit" className="lux-input mt-0.5 h-8 w-full px-2 text-xs tabular-nums" />
                            </label>
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex min-h-32 flex-col items-center justify-center px-4 text-center">
                  <ReceiptText className="h-7 w-7 text-[var(--accent)]" />
                  <p className="mt-2 text-[13px] font-bold text-[var(--text-primary)]">No items yet</p>
                  <p className="mt-0.5 max-w-[210px] text-xs leading-5 text-[var(--text-muted)]">Scan a barcode or tap a product tile to start the sale.</p>
                </div>
              )}
            </div>

            {/* Settlement, pinned so the total never scrolls away. */}
            <div className="shrink-0 space-y-2 border-t border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-card)_92%,transparent)] p-2.5">
              {discountAmount > 0 && (
                <div className="flex items-center justify-between text-[13px] text-[var(--jade)]">
                  <span className="flex items-center gap-1.5">
                    <Tag className="h-3.5 w-3.5" />
                    {promoCode}
                  </span>
                  <span className="flex items-center gap-2">
                    <b className="tabular-nums">-{money(discountAmount)}</b>
                    <button
                      type="button"
                      onClick={() => { setDiscountAmount(0); setPromoCode(''); setDiscountMessage(''); }}
                      aria-label="Remove discount"
                      className="text-[var(--text-muted)] transition hover:text-[var(--danger)]"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between text-[13px]">
                <span className="text-[var(--text-muted)]">Subtotal</span>
                <b className="tabular-nums text-[var(--text-primary)]">{money(grossSubtotal)}</b>
              </div>

              <div className="pos-total">
                <span className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-[var(--text-subtle)]">Total due</span>
                <b className="brand-display tabular-nums text-[var(--accent)]">{money(subtotal)}</b>
              </div>

              {/* Discounts are the exception, not the rule, at a counter. Kept
                  one tap away but out of the way until it is actually wanted. */}
              {!isCashier && (
                discountOpen || discountAmount > 0 ? (
                  <div>
                    <div className="flex gap-2">
                      <label className="sr-only" htmlFor="pos-promo-code">Promotion code</label>
                      <input id="pos-promo-code" value={promoCode} onChange={event => { setPromoCode(event.target.value); setDiscountMessage(''); }} placeholder="Discount code" className="lux-input min-w-0 flex-1" />
                      <button type="button" onClick={() => void applyDiscount()} disabled={!promoCode.trim() || !cart.length} className="lux-btn lux-btn--outline lux-btn--sm shrink-0">Apply</button>
                    </div>
                    {discountMessage && <p className={`mt-1 text-[11px] font-bold ${discountAmount > 0 ? 'text-[var(--jade)]' : 'text-[var(--highlight)]'}`}>{discountMessage}</p>}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDiscountOpen(true)}
                    disabled={!cart.length}
                    className="flex w-full items-center gap-1.5 rounded-lg px-1 py-0.5 text-[11px] font-bold text-[var(--text-subtle)] transition hover:text-[var(--accent)] disabled:opacity-40"
                  >
                    <Plus className="h-3 w-3" />
                    Add discount code
                  </button>
                )
              )}

              {/* ── Payment ──────────────────────────────────────────────────
                  One tender by default. "Split payment" adds rows, for the
                  customer who pays part cash and part mobile money. */}
              <div className="grid grid-cols-2 gap-2">
                {([{ id: 'cash-on-delivery', label: 'Cash', icon: Banknote }, { id: 'momo-mtn', label: 'MTN MoMo', icon: Smartphone }] as const).map(option => (
                  <button key={option.id} type="button" disabled={splitPayment} onClick={() => setPayment(option.id)} aria-pressed={payment === option.id} className={`flex items-center justify-center gap-2 rounded-xl border px-2 py-2 text-xs font-bold transition disabled:opacity-40 ${payment === option.id ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'border-[var(--border-color)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]'}`}>
                    <option.icon className="h-4 w-4" />
                    {option.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setSplitPayment(open => !open)}
                className="flex w-full items-center justify-center gap-1.5 text-[11px] font-bold text-[var(--text-subtle)] transition hover:text-[var(--accent)]"
                aria-pressed={splitPayment}
              >
                {splitPayment ? 'Remove split payment' : 'Split payment'}
              </button>

              {splitPayment ? (
                /* One row per tender. Amounts are entered in cedis and held in
                   pesewas, so the running balance is exact. */
                <div className="space-y-2">
                  {tenders.map((tender, index) => {
                    const otherTendersMinor = tenders
                      .filter((_, other) => other !== index)
                      .reduce((sum, other) => sum + Math.max(0, other.allocated), 0);
                    const maxMinor = Math.max(0, totalMinor - otherTendersMinor);
                    return (
                      <div key={tender.id} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-soft)] p-2">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <select
                            aria-label={`Payment ${index + 1} method`}
                            value={tender.method}
                            onChange={event => setTenders(current => current.map(row => row.id === tender.id
                              ? { ...row, method: event.target.value as PaymentChoice }
                              : row))}
                            className="rounded border border-[var(--border-color)] bg-[var(--bg-main)] px-1.5 py-1 text-[11px] font-bold"
                          >
                            <option value="cash-on-delivery">Cash</option>
                            <option value="momo-mtn">MTN MoMo</option>
                          </select>
                          <div className="flex items-center gap-1">
                            {tenders.length > 1 && (
                              <button
                                type="button"
                                onClick={() => setTenders(current => current.filter(row => row.id !== tender.id))}
                                aria-label={`Remove payment ${index + 1}`}
                                className="rounded px-1.5 py-1 text-[var(--text-subtle)] transition hover:text-[var(--danger)]"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-1.5">
                          <div>
                            <label className="sr-only" htmlFor={`pos-tender-amount-${index}`}>Amount paid</label>
                            <input
                              id={`pos-tender-amount-${index}`}
                              type="number"
                              min="0"
                              step="0.01"
                              inputMode="decimal"
                              value={tender.allocated ? tender.allocated / 100 : ''}
                              onChange={event => setTenders(current => current.map(row => row.id === tender.id
                                ? { ...row, allocated: Math.min(maxMinor, Math.max(0, toMinor(event.target.value) ?? 0)) }
                                : row))}
                              placeholder="0.00"
                              className="lux-input text-xs tabular-nums"
                            />
                          </div>
                          {tender.method === 'cash-on-delivery' && (
                            <div>
                              <label className="sr-only" htmlFor={`pos-tender-cash-${index}`}>Cash handed over</label>
                              <input
                                id={`pos-tender-cash-${index}`}
                                type="number"
                                min="0"
                                step="0.01"
                                inputMode="decimal"
                                value={tender.tendered ? tender.tendered / 100 : ''}
                                onChange={event => setTenders(current => current.map(row => row.id === tender.id
                                  ? { ...row, tendered: Math.max(0, toMinor(event.target.value) ?? 0) }
                                  : row))}
                                placeholder="Handed over"
                                className="lux-input text-xs tabular-nums"
                              />
                            </div>
                          )}
                        </div>

                        {tender.method === 'momo-mtn' && (
                          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                            <input
                              aria-label={`Payment ${index + 1} reference`}
                              value={tender.reference}
                              onChange={event => setTenders(current => current.map(row => row.id === tender.id ? { ...row, reference: event.target.value } : row))}
                              placeholder="Ref / Tx ID (optional)"
                              className="lux-input text-xs"
                            />
                            <input
                              aria-label={`Payment ${index + 1} sender phone`}
                              value={tender.senderPhone}
                              onChange={event => setTenders(current => current.map(row => row.id === tender.id ? { ...row, senderPhone: event.target.value } : row))}
                              placeholder="Phone (optional)"
                              className="lux-input text-xs"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() => setTenders(current => [...current, newTender(payment)])}
                    className="lux-btn lux-btn--outline lux-btn--sm w-full"
                  >
                    <Plus className="h-4 w-4" />
                    Add another payment
                  </button>

                  <div className="flex items-center justify-between rounded-lg border border-[var(--border-color)] bg-[var(--bg-soft)] px-2.5 py-2 text-[11px]">
                    <span className="font-bold text-[var(--text-subtle)]">
                      {shortfallMinor > 0
                        ? `Still to pay ${money(shortfallMinor / 100)}`
                        : allocatedMinor > totalMinor
                          ? `Over-allocated by ${money((allocatedMinor - totalMinor) / 100)}`
                          : changeMinor > 0
                            ? `Change ${money(changeMinor / 100)}`
                            : 'Paid in full'}
                    </span>
                    <b className="tabular-nums text-[var(--text-primary)]">{money(allocatedMinor / 100)} / {money(totalMinor / 100)}</b>
                  </div>
                </div>
              ) : payment === 'cash-on-delivery' ? (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="sr-only" htmlFor="pos-cash-received">Cash received</label>
                    <input id="pos-cash-received" type="number" min="0" step="0.01" value={cashReceived} onChange={event => setCashReceived(event.target.value)} placeholder="Cash received" className="lux-input font-bold tabular-nums" />
                  </div>
                  <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-soft)] px-2.5 py-2">
                    <p className="text-[9px] font-extrabold uppercase tracking-[0.14em] text-[var(--text-subtle)]">Change</p>
                    <b className={`block truncate text-sm tabular-nums ${change > 0 ? 'text-[var(--jade)]' : 'text-[var(--text-primary)]'}`}>{money(change)}</b>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="sr-only" htmlFor="pos-payment-reference">Payment reference</label>
                    <input id="pos-payment-reference" value={reference} onChange={event => setReference(event.target.value)} placeholder="Ref / Tx ID (optional)" className="lux-input" />
                  </div>
                  {payment === 'momo-mtn' && (
                    <div>
                      <label className="sr-only" htmlFor="pos-sender-phone">Sender phone</label>
                      <input id="pos-sender-phone" value={senderPhone} onChange={event => setSenderPhone(event.target.value)} placeholder="Phone (optional)" className="lux-input" />
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                disabled={!online || !cart.length || submitting}
                onClick={() => void completeSale()}
                className="pos-pay w-full"
              >
                {submitting ? 'Posting sale…' : 'Complete sale'}
                <ArrowRight className="h-4 w-4" />
                <kbd className="pos-pay__hint">F4</kbd>
              </button>

              {/* Rare actions, kept on one quiet line. */}
              <div className="flex items-center justify-between gap-1 text-[11px] font-bold">
                <button type="button" onClick={() => void holdSale()} title="Hold sale (F5)" className="rounded-md px-2 py-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-soft)] hover:text-[var(--text-primary)]">
                  Hold
                </button>
                <button
                  type="button"
                  onClick={() => setHeldSalesOpen(open => !open)}
                  title="Recall a held sale"
                  aria-expanded={heldSalesOpen}
                  className="rounded-md px-2 py-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-soft)] hover:text-[var(--text-primary)]"
                >
                  Held
                  {heldSales.length > 0 && (
                    <span className="ml-1 rounded-full bg-[var(--accent)] px-1.5 text-[10px] text-white">{heldSales.length}</span>
                  )}
                </button>
                <button type="button" onClick={voidLine} disabled={!cart.length} title="Remove the last line from this unpaid ticket" className="rounded-md px-2 py-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-soft)] hover:text-[var(--text-primary)] disabled:opacity-35">
                  Void line
                </button>
                <button type="button" onClick={() => void refundLatestSale()} className="rounded-md px-2 py-1 text-[var(--text-subtle)] transition hover:text-[var(--danger)]">
                  Refund
                </button>
              </div>

              {/* Last backup, managers only. */}
              {isManager && lastBackup && (
                <p className="flex items-center gap-1.5 text-[11px] text-[var(--text-subtle)]" title={
                  lastBackup.managedBy
                    ? `Persistent cloud storage is managed by ${lastBackup.managedBy}`
                    : lastBackup.exists
                    ? `Last backup: ${new Date(lastBackup.createdAt!).toLocaleString()}`
                    : 'No backup has been taken yet'
                }>
                  <Clock className="h-3 w-3" />
                  {lastBackup.managedBy
                    ? `Cloud storage: ${lastBackup.managedBy}`
                    : lastBackup.exists
                    ? <>Last backup {lastBackup.ageHours !== null && lastBackup.ageHours < 24
                      ? `${Math.max(1, Math.round(lastBackup.ageHours))}h ago`
                      : new Date(lastBackup.createdAt!).toLocaleDateString()}</>
                    : 'No backup yet'}
                </p>
              )}

              {/* A scanned code that matched nothing. Offers the two things a
                  cashier needs at that moment instead of only complaining. */}
              {unknownCode && (
                <div role="alert" className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-3">
                  <p className="text-xs font-bold text-[var(--text-primary)]">
                    Barcode not found: <span className="font-mono">{unknownCode}</span>
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
                    Create it as a new product, or add stock if it is already listed under a different code.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {!isCashier && (
                      <button
                        type="button"
                        onClick={() => openNewProductFor(unknownCode)}
                        className="lux-btn lux-btn--primary lux-btn--sm"
                      >
                        Add as new product
                      </button>
                    )}
                    <button type="button" onClick={() => setUnknownCode(null)} className="lux-btn lux-btn--outline lux-btn--sm">
                      Dismiss
                    </button>
                  </div>
                </div>
              )}

              {/* Stock-in: scan a product, then say how many arrived. */}
              {stockInTarget && (
                <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-3">
                  <p className="text-xs font-bold text-[var(--text-primary)]">Receive stock</p>
                  <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">{stockInTarget.label}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <label className="sr-only" htmlFor="pos-stock-in-qty">Quantity received</label>
                    <input
                      id="pos-stock-in-qty"
                      type="number"
                      min="1"
                      step="1"
                      inputMode="numeric"
                      autoFocus
                      value={stockInQuantity}
                      onChange={event => setStockInQuantity(event.target.value)}
                      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void confirmStockIn(); } }}
                      className="lux-input w-24 text-center font-bold tabular-nums"
                    />
                    <button type="button" disabled={stockInSaving} onClick={() => void confirmStockIn()} className="lux-btn lux-btn--primary lux-btn--sm">
                      {stockInSaving ? 'Saving…' : 'Add to stock'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setStockInTarget(null); setStockInMode(false); }}
                      className="lux-btn lux-btn--outline lux-btn--sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Parked tickets: list, recall, or discard. */}
              {heldSalesOpen && (
                <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--text-muted)]">Held sales</h3>
                    <button type="button" onClick={() => setHeldSalesOpen(false)} aria-label="Close held sales" className="text-[var(--text-subtle)] hover:text-[var(--text-primary)]">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {heldSales.length === 0 ? (
                    <p className="py-3 text-center text-[11px] text-[var(--text-subtle)]">No tickets are on hold.</p>
                  ) : (
                    <ul className="space-y-2">
                      {heldSales.map(held => {
                        const recalled = Boolean(held.recalledAt);
                        return (
                          <li key={held.id} className="rounded-md border border-[var(--border-color)] p-2">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-xs font-bold text-[var(--text-primary)]">{held.ticketLabel}</span>
                              <span className="text-xs font-bold tabular-nums text-[var(--text-primary)]">{money(Number(held.total))}</span>
                            </div>
                            <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">
                              {(held.items || []).length} line{(held.items || []).length === 1 ? '' : 's'}
                              {held.heldBy ? ` · ${held.heldBy}` : ''}
                              {' · '}{new Date(held.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </p>
                            <div className="mt-1.5 flex items-center gap-3 text-[11px] font-bold">
                              <button type="button" disabled={recalled} onClick={() => void recallHeldSale(held.id)} className="text-[var(--jade)] disabled:opacity-40">
                                {recalled ? 'Recalled' : 'Recall'}
                              </button>
                              <button type="button" onClick={() => void discardHeldSale(held.id)} className="text-[var(--danger)]">
                                Discard
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
