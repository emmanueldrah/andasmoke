import type { ApiRequest, ApiResponse } from './_http.js';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, getBarcodeSequence, setBarcodeSequence } from '../src/db/index.js';
import { products } from '../src/db/schema.js';
import { requireAdmin } from './_auth.js';
import { AUDIT_ACTIONS, recordAudit } from './_audit.js';
import { buildCsv, columnIndexAny, parseCsv } from '../src/lib/csv.js';
import { requireMinor } from '../src/lib/money.js';
import { nextInternalBarcode, parseInternalBarcode } from '../src/lib/code128.js';

/**
 * Product CSV import.
 *
 * The rules here exist because of how spreadsheets mangle barcodes:
 *
 *   - A 13-digit barcode typed into a spreadsheet becomes a number and loses its
 *     leading zeros. `5012345678900` can come back as `5.01234E+12`.
 *   - A barcode that happens to start with `+` or `=` is read as a formula.
 *
 * So a barcode is only ever accepted as text, scientific notation is refused
 * with an explanation, and leading zeros are preserved exactly.
 *
 * Import is all-or-nothing. A file with one bad row imports nothing, because a
 * half-imported catalogue is far harder to notice and fix than a refused file.
 */

/** Roles that may change the catalogue. */
const IMPORT_ROLES = ['Super Admin', 'Store Manager', 'Inventory Dispatcher'] as const;

/** Ceiling on a single file, so a mistake cannot stall the till. */
const MAX_ROWS = 5000;

const CATEGORY_OPTIONS = [
  'skincare', 'makeup', 'fragrances', 'body-care', 'beauty-tools',
  'rice-grains', 'cooking-oils', 'seasoning-spices', 'beverages',
  'snacks-sweets', 'household-care', 'daily-essentials', 'new-arrivals',
  'best-sellers', 'offers',
] as const;
type ProductCategory = typeof CATEGORY_OPTIONS[number];

/** The columns this app reads, and the names a spreadsheet might use. */
const COLUMNS = {
  id: ['id', 'productid', 'sku', 'code'],
  name: ['name', 'productname', 'title', 'item'],
  brand: ['brand'],
  price: ['price', 'sellingprice', 'retailprice', 'amount'],
  barcode: ['barcode', 'ean', 'ean13', 'upc', 'gtin', 'code128'],
  category: ['category'],
  categoryLabel: ['categorylabel', 'label'],
  unit: ['unit', 'unitofmeasure'],
  stockCount: ['stockcount', 'stock', 'quantity', 'qty', 'onhand'],
  costPrice: ['costprice', 'cost', 'buyingprice', 'purchaseprice'],
  reorderLevel: ['reorderlevel', 'reorder', 'reorderpoint', 'minimumstock'],
  description: ['description', 'notes'],
  image: ['image', 'imageurl', 'photo'],
} as const;

/** One row's problem, phrased for whoever has to fix the file. */
type RowError = {
  /** 1-based line in the uploaded file, including the header. */
  line: number;
  column?: string;
  message: string;
  value?: string;
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    const auth = await requireAdmin(req, res, IMPORT_ROLES);
    if (!auth) return;

    // ── Export, so a round trip is possible ───────────────────────────────
    if (req.method === 'GET') {
      const rows = await db.select().from(products);
      const csv = buildCsv({
        header: [
          'id', 'name', 'brand', 'category', 'category_label', 'unit',
          'price', 'barcode', 'stock_count', 'cost_price', 'reorder_level', 'description',
        ],
        rows: rows.map(product => [
          product.id,
          product.name,
          product.brand || '',
          product.category,
          product.categoryLabel || '',
          product.unit || '',
          Number(product.price).toFixed(2),
          // Quoted by the writer: a barcode must come back as text.
          product.barcode || '',
          String(product.stockCount ?? 0),
          product.costPricePesewas == null ? '' : (product.costPricePesewas / 100).toFixed(2),
          String(product.reorderLevel ?? 0),
          product.description || '',
        ]),
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="anda-products.csv"');
      // The BOM makes Excel read the file as UTF-8 instead of the local
      // codepage, which would mangle a non-ASCII product name.
      return res.status(200).end(`﻿${csv}`);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // ── Preview ───────────────────────────────────────────────────────────
    // Parsed and validated but nothing written, so the user sees every problem
    // in the file before committing to it.
    const isCommit = req.query.action === 'commit';
    const text = typeof req.body?.csv === 'string' ? req.body.csv : '';
    if (!text.trim()) {
      return res.status(400).json({ error: 'Choose a CSV file to import.' });
    }

    const outcome = await analyse(text);

    if (!isCommit) {
      return res.status(200).json({
        preview: true,
        valid: outcome.errors.length === 0,
        header: outcome.header,
        rows: outcome.previewRows,
        totalRows: outcome.validRows.length,
        errorCount: outcome.errors.length,
        errors: outcome.errors.slice(0, 100),
        errorCountTotal: outcome.errors.length,
        warnings: outcome.warnings,
      });
    }

    if (outcome.errors.length > 0) {
      return res.status(400).json({
        error: `Nothing was imported: ${outcome.errors.length} problem${outcome.errors.length === 1 ? '' : 's'} in the file. Fix them and upload it again.`,
        errorCount: outcome.errors.length,
        errors: outcome.errors.slice(0, 100),
      });
    }

    // ── Commit, all or nothing ────────────────────────────────────────────
    const created: string[] = [];
    const updated: string[] = [];
    const existingBarcodes = await db.select({ barcode: products.barcode, serialNumber: products.serialNumber }).from(products);
    const taken = new Set(existingBarcodes.flatMap(product => [product.barcode, product.serialNumber].filter((code): code is string => Boolean(code))));
    let highWater = getBarcodeSequence();
    const importRows = outcome.validRows.map(row => {
      if (row.barcode) {
        const sequence = parseInternalBarcode(row.barcode);
        if (sequence !== null) highWater = Math.max(highWater, sequence);
        taken.add(row.barcode);
        return row;
      }
      const barcode = nextInternalBarcode(taken, highWater);
      taken.add(barcode);
      highWater = parseInternalBarcode(barcode) ?? highWater;
      return { ...row, barcode };
    });
    if (highWater > getBarcodeSequence()) setBarcodeSequence(highWater);

    // One transaction for the whole file: a failure half way through must leave
    // the catalogue exactly as it was.
    db.transaction((tx) => {
      for (const row of importRows) {
        const existing = tx.select({ id: products.id }).from(products).where(eq(products.id, row.id)).limit(1).all()[0];

        if (existing) {
          tx.update(products).set({
            name: row.name,
            brand: row.brand,
            department: row.department,
            category: row.category,
            categoryLabel: row.categoryLabel,
            unit: row.unit,
            price: row.price / 100,
            pricePesewas: row.price,
            costPricePesewas: row.costPrice,
            reorderLevel: row.reorderLevel,
            barcode: row.barcode,
            stockCount: row.stockCount,
            description: row.description,
            image: row.image,
            inStock: row.stockCount > 0,
            isPublished: row.stockCount > 0,
            updatedAt: new Date(),
          }).where(eq(products.id, row.id)).run();
          updated.push(row.id);
        } else {
          tx.insert(products).values({
            id: row.id,
            name: row.name,
            brand: row.brand,
            department: row.department,
            category: row.category,
            categoryLabel: row.categoryLabel,
            unit: row.unit,
            price: row.price / 100,
            pricePesewas: row.price,
            costPricePesewas: row.costPrice,
            reorderLevel: row.reorderLevel,
            barcode: row.barcode,
            stockCount: row.stockCount,
            description: row.description,
            image: row.image,
            images: [],
            highlights: [],
            options: [],
            variants: [],
            rating: 5,
            reviewCount: 0,
            inStock: row.stockCount > 0,
            isPublished: row.stockCount > 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          }).run();
          created.push(row.id);
        }
      }
    });

    await recordAudit(auth, {
      action: AUDIT_ACTIONS.PRODUCTS_IMPORTED,
      entityType: 'catalogue',
      entityId: 'csv-import',
      metadata: {
        created: created.length,
        updated: updated.length,
        total: importRows.length,
      },
    });

    return res.status(201).json({
      imported: importRows.length,
      created: created.length,
      updated: updated.length,
    });
  } catch (error: any) {
    console.error('Product import API error:', error);
    return res.status(500).json({ error: 'Could not import that file.' });
  }
}

type ValidRow = {
  id: string;
  name: string;
  brand: string;
  department: 'beauty';
  category: ProductCategory;
  categoryLabel: string;
  unit: string;
  /** Minor units. */
  price: number;
  /** Kept exactly as written, leading zeros and all. */
  barcode: string;
  stockCount: number;
  /** Minor units, or null when not supplied. */
  costPrice: number | null;
  reorderLevel: number;
  description: string;
  image: string;
};

/**
 * Validates a whole file without writing anything.
 *
 * Returns the rows that are usable and every problem found, so a single pass
 * tells the user everything that needs fixing rather than one error per upload.
 */
async function analyse(text: string) {
  const warnings: string[] = [];
  const { rows, warnings: parseWarnings } = parseCsv(text);
  warnings.push(...parseWarnings);

  const errors: RowError[] = [];
  if (rows.length === 0) {
    return { header: [], validRows: [] as ValidRow[], errors: [{ line: 0, message: 'The file is empty.' }], warnings, previewRows: [] };
  }

  const header = rows[0].values.map(value => value.trim());
  const body = rows.slice(1);

  const index: Record<string, number> = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    index[key] = columnIndexAny(header, [...names]);
  }

  if (index.name < 0) {
    errors.push({ line: 1, column: 'name', message: 'The file needs a "name" column.' });
  }
  if (index.price < 0) {
    errors.push({ line: 1, column: 'price', message: 'The file needs a "price" column.' });
  }
  if (errors.length) {
    return { header, validRows: [] as ValidRow[], errors, warnings, previewRows: [] };
  }

  if (body.length > MAX_ROWS) {
    errors.push({ line: 0, message: `This file has ${body.length} rows; the limit is ${MAX_ROWS}.` });
    return { header, validRows: [] as ValidRow[], errors, warnings, previewRows: [] };
  }

  const existingRows = await db.select({
    id: products.id, barcode: products.barcode, serialNumber: products.serialNumber,
  }).from(products);

// Only codes this app issues are treated as belonging to a sequence. A
  // supplier barcode of any shape is left alone.
  const barcodesInUse = new Set<string>();
  for (const row of existingRows) {
    if (row.barcode) {
      const code = String(row.barcode);
      barcodesInUse.add(code);
    }
    if (row.serialNumber) barcodesInUse.add(String(row.serialNumber));
  }
  const idsInUse = new Set(existingRows.map(row => row.id));

  // Codes in the file that follow this app's own sequence. These are assigned in
  // order from the persistent high-water mark, so a file of blank barcodes never
  // reissues a number that is already printed on a shelf label.
  const validRows: ValidRow[] = [];
  const previewRows: Array<Record<string, string>> = [];
  const seenBarcodes = new Map<string, number>();
  const seenIds = new Map<string, number>();

  for (const [offset, row] of body.entries()) {
    const line = row.line;
    const get = (key: string) => (index[key] >= 0 ? (row.values[index[key]] ?? '').trim() : '');
    const before = errors.length;

    const name = get('name');
    const rawPrice = get('price');
    const rawId = get('id');
    const rawBarcode = get('barcode');

    if (!name) {
      errors.push({ line, column: 'name', message: 'The name is empty.' });
    }

    // ── Barcode, strictly as text ─────────────────────────────────────────
    let barcode = '';
    if (rawBarcode) {
      if (looksLikeScientificNotation(rawBarcode)) {
        errors.push({
          line,
          column: 'barcode',
          value: rawBarcode,
          message: `"${rawBarcode}" looks like scientific notation, which is how a spreadsheet mangles a 13-digit barcode. Format the barcode column as Text before saving, or put an apostrophe in front of the number.`,
        });
      } else if (!isPlausibleBarcode(rawBarcode)) {
        errors.push({
          line,
          column: 'barcode',
          value: rawBarcode,
          message: `"${rawBarcode}" is not a valid barcode. Use letters, digits, dashes or a slash.`,
        });
      } else {
        // Leading zeros are kept: the value is never passed through a number.
        barcode = rawBarcode;
        const earlier = seenBarcodes.get(barcode);
        if (earlier !== undefined) {
          errors.push({
            line, column: 'barcode', value: barcode,
            message: `This barcode is already used on line ${earlier} of the same file.`,
          });
        } else {
          seenBarcodes.set(barcode, line);
        }
      }
    }

    // ── Price ────────────────────────────────────────────────────────────
    let price = 0;
    if (!rawPrice) {
      errors.push({ line, column: 'price', message: 'The price is empty.' });
    } else {
      let minor: number | null = null;
      try {
        minor = requireMinor(rawPrice, 'price');
      } catch {
        minor = null;
      }
      if (minor === null) {
        errors.push({
          line, column: 'price', value: rawPrice,
          message: `"${rawPrice}" is not a price. Use digits and at most two decimal places, for example 45.00.`,
        });
      } else if (minor < 0) {
        errors.push({ line, column: 'price', value: rawPrice, message: 'A price cannot be negative.' });
      } else {
        price = minor;
      }
    }

    // ── Cost price and reorder level ─────────────────────────────────────
    const rawCost = get('costPrice');
    let costPrice: number | null = null;
    if (rawCost) {
      try {
        costPrice = requireMinor(rawCost, 'cost price');
      } catch {
        errors.push({
          line, column: 'cost_price', value: rawCost,
          message: `"${rawCost}" is not a cost price.`,
        });
      }
    }

    const rawStock = get('stockCount');
    let stockCount = 0;
    if (rawStock) {
      const parsed = Number(rawStock);
      if (!Number.isInteger(parsed) || parsed < 0) {
        errors.push({ line, column: 'stock_count', value: rawStock, message: `"${rawStock}" is not a whole number of units.` });
      } else {
        stockCount = parsed;
      }
    }

    const rawReorder = get('reorderLevel');
    let reorderLevel = 0;
    if (rawReorder) {
      const parsed = Number(rawReorder);
      if (!Number.isInteger(parsed) || parsed < 0) {
        errors.push({ line, column: 'reorder_level', value: rawReorder, message: `"${rawReorder}" is not a whole number.` });
      } else {
        reorderLevel = parsed;
      }
    }

    // ── Identifier, unique within the file ────────────────────────────────
    const id = normaliseId(rawId || name);
    const earlierId = seenIds.get(id);
    if (earlierId !== undefined) {
      errors.push({ line, column: 'id', value: id, message: `"${id}" is already used on line ${earlierId} of the same file.` });
    } else {
      seenIds.set(id, line);
    }

    // ── Category ─────────────────────────────────────────────────────────
    const rawCategory = get('category');
    const category = normaliseCategory(rawCategory);
    if (rawCategory && !category) {
      errors.push({
        line, column: 'category', value: rawCategory,
        message: `"${rawCategory}" is not a category this app knows. Use one of: ${CATEGORY_OPTIONS.join(', ')}.`,
      });
    }

    if (name && id) {
      const isNew = !idsInUse.has(id);
      // A barcode that already belongs to a *different* product is a clash. An
      // update that keeps its own barcode is fine.
      if (barcode && barcodesInUse.has(barcode)) {
        const owner = existingRows.find(row => row.barcode === barcode || row.serialNumber === barcode);
        if (owner && owner.id !== id) {
          errors.push({
            line, column: 'barcode', value: barcode,
            message: `That barcode already belongs to "${owner.id}".`,
          });
        }
      }

      if (errors.length === before) {
        validRows.push({
          id,
          name,
          brand: get('brand') || 'Anda',
          department: 'beauty',
          category: category || 'daily-essentials',
          categoryLabel: get('categoryLabel') || rawCategory || 'General',
          unit: get('unit') || 'item',
          price,
          // Left blank here when the file had no barcode, so the commit step can
          // assign the next internal code in sequence.
          barcode,
          stockCount,
          costPrice,
          reorderLevel,
          description: get('description'),
          image: get('image'),
        });
      }
    }

    previewRows.push({
      line: String(line),
      id,
      name,
      barcode,
      price: rawPrice,
      stock: rawStock,
      status: errors.length === before ? 'ok' : 'problem',
    });
  }

  return { header, validRows, errors, warnings, previewRows };
}

/**
 * True when a value looks like it came from a spreadsheet that treated a
 * barcode as a number: `5.01234E+12`, `1,2E5`, `3e9`.
 */
export function looksLikeScientificNotation(value: string): boolean {
  return /^[+-]?\d*\.?\d+[eE][+-]?\d+$/.test(value.trim());
}

/** Barcodes are letters, digits, dashes and slashes; nothing else. */
function isPlausibleBarcode(value: string): boolean {
  return /^[A-Za-z0-9._\-/]+$/.test(value);
}

/** Turns a name into a stable id, so a file without ids still imports. */
function normaliseId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `product-${Math.random().toString(36).slice(2, 8)}`;
}

function normaliseCategory(value: string): ProductCategory | null {
  const wanted = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return CATEGORY_OPTIONS.find(option => option.replace(/-/g, '') === wanted) ?? null;
}

export { analyse, inArray };