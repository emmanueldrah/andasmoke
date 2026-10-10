/**
 * Code 128 barcode encoding, decoding and labelling.
 *
 * Encoded symbols are kept as modules (a bar or a space, one module wide) rather
 * than as pixels, because a label must be printed at true physical size: scaling
 * an image to fit a box rounds module boundaries and blurs the narrow bars, which
 * is the single most common reason a "good" barcode will not scan. Working in
 * modules and laying out in millimetres means a printed bar is always a whole
 * number of modules wide.
 *
 * The module width below is the smallest that reliably scans on a low-cost
 * handheld at label-printing resolution, and the quiet zone follows ISO/IEC
 * 15417: ten times the module width, minimum, on both sides.
 */
import {
  BARCODE_DIGITS,
  BARCODE_PREFIX,
  DEFAULT_LABEL_SETTINGS,
  type LabelSettings,
} from './hardware';

/**
 * Bar width for a printed label, in millimetres.
 *
 * ISO/IEC 15417 gives 0.264 mm as the narrowest element width a Code 128 symbol
 * may use. Printing at exactly that keeps an internal code inside a 50 mm label
 * without going below what the standard allows, which is what makes short
 * internal codes printable on the small rolls most shops actually load.
 */
export const DEFAULT_MODULE_WIDTH_MM = 0.264;
/** Minimum bar height. Below ~10 mm many scanners struggle with skew. */
export const MIN_BAR_HEIGHT_MM = 12;
/** Quiet zone, as required by ISO/IEC 15417. */
export const QUIET_ZONE_MODULES = 10;

/**
 * The 107 Code 128 symbol patterns. Each digit is a run width; every symbol
 * alternates bar/space starting with a bar and totals 11 modules, except the stop
 * pattern which totals 13.
 */
const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

/** Reverse lookup, built once, for decoding. */
const PATTERN_TO_SYMBOL = new Map<string, number>(
  CODE128_PATTERNS.map((pattern, symbol) => [pattern, symbol]),
);

const START_B = 104;
const STOP = 106;

/** Characters Code 128 subset B can encode. */
const isEncodable = (text: string) =>
  text.length > 0 && [...text].every(character => {
    const code = character.charCodeAt(0);
    return code >= 32 && code <= 126;
  });

/**
 * Encodes text into a run-length module pattern: 1 is a bar, 0 is a space, one
 * module each.
 */
export function encodeCode128(text: string): number[] {
  if (!isEncodable(text)) {
    throw new Error('A barcode may only contain letters, digits and simple punctuation.');
  }

  const values = [...text].map(character => character.charCodeAt(0) - 32);

  // Modulo 103 weighted checksum, over the start character and the data.
  let checksum = START_B;
  values.forEach((value, index) => { checksum += (index + 1) * value; });
  checksum %= 103;

  const modules: number[] = [];
  for (const symbol of [START_B, ...values, checksum, STOP]) {
    const pattern = CODE128_PATTERNS[symbol];
    if (!pattern) throw new Error('Code 128 symbol out of range.');
    let isBar = true;
    for (const runWidth of pattern) {
      const width = Number(runWidth);
      for (let i = 0; i < width; i++) modules.push(isBar ? 1 : 0);
      isBar = !isBar;
    }
  }
  return modules;
}

const gcdOf = (a: number, b: number): number => (b === 0 ? a : gcdOf(b, a % b));

export type DecodedCode128 = {
  text: string;
  /** False when the checksum did not match, so a bad read is not trusted. */
  checksumValid: boolean;
};

/**
 * Reads a module pattern back into the text it encodes.
 *
 * Reads run lengths rather than assuming a module width, which is how a real
 * scanner sees it. Used to prove a generated barcode decodes to the same string,
 * and it deliberately throws when the pattern cannot be read, rather than
 * returning a partial answer.
 */
export function decodeCode128(modules: number[]): DecodedCode128 {
  if (!modules.length) throw new Error('Empty barcode.');

  // Skip any leading quiet zone. The *trailing* quiet zone is deliberately not
  // trimmed: the stop pattern ends in spaces, so trailing zeros cannot be told
  // apart from it. Parsing stops at the stop symbol instead.
  let cursor = 0;
  while (cursor < modules.length && modules[cursor] === 0) cursor++;
  if (cursor >= modules.length) throw new Error('Unreadable barcode: no bars found.');

  const symbols: number[] = [];

  while (cursor < modules.length) {
    // Read the next runs. A data symbol has six; the stop has seven.
    const runs: number[] = [];
    let current = modules[cursor];
    let run = 0;
    for (let i = cursor; i < modules.length; i++) {
      if (modules[i] === current) run++;
      else { runs.push(run); current = modules[i]; run = 1; }
      if (runs.length === 7) break;
    }
    // A final run that reaches the end of the input is still a run.
    if (run > 0 && runs.length < 7) runs.push(run);
    if (runs.length < 6) throw new Error('Unreadable barcode: truncated symbol.');

    // Patterns are defined relative to the symbol's narrowest bar, so a symbol
    // drawn at any scale is read by dividing out the common factor. This is how
    // a real scanner measures: it never assumes a module width.
    const gcd = runs.slice(0, 6).reduce((a, b) => gcdOf(a, b));
    const normalized = runs.map(width => width / gcd);

    const six = normalized.slice(0, 6).join('');
    let symbol = PATTERN_TO_SYMBOL.get(six);
    let consumed = runs.slice(0, 6).reduce((sum, width) => sum + width, 0);

    if (symbol === undefined) {
      // The stop pattern is seven runs wide.
      if (runs.length === 7 && normalized.join('') === CODE128_PATTERNS[STOP]) break;
      throw new Error('Unreadable barcode: an unknown symbol pattern was found.');
    }

    if (symbol === STOP) {
      if (runs.length === 7) break;
      throw new Error('Unreadable barcode: unexpected stop pattern.');
    }

    symbols.push(symbol);
    // Advance by the widths actually measured, not a fixed 11 modules, so a
    // symbol drawn at a different scale still reads.
    cursor += consumed;
    if (consumed <= 0) throw new Error('Unreadable barcode: no progress.');
  }

  if (symbols[0] !== START_B) throw new Error('Unreadable barcode: missing start character.');
  const data = symbols.slice(1);
  if (!data.length) throw new Error('Unreadable barcode: no data.');

  const received = data.pop() as number;
  let expected = START_B;
  data.forEach((value, index) => { expected += (index + 1) * value; });
  expected %= 103;

  const text = data.map(value => String.fromCharCode(value + 32)).join('');
  return { text, checksumValid: expected === received };
}

/**
 * Reads the sequence number out of an internal code, or null if it is not one.
 */
export function parseInternalBarcode(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = new RegExp(`^${BARCODE_PREFIX}(\\d{${BARCODE_DIGITS}})$`).exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

/**
 * Issues the next unused internal barcode.
 *
 * Sequential (ACS-000001, ACS-000002, …) rather than random, so a barcode can be
 * read to the till's eye and typed back in if a label is lost. The counter moves
 * past every code found in `taken` and past `reservedFrom`, so a code is never
 * reissued even after a deletion.
 *
 * `reservedFrom` is the till's stored high-water mark. It matters because a
 * wipe empties the catalogue: without it the sequence would restart at 000001
 * and hand out codes already printed on shelf labels.
 */
export function nextInternalBarcode(
  taken: Iterable<string> | Set<string>,
  reservedFrom = 0,
): string {
  const used = taken instanceof Set ? taken : new Set(taken);

  let highest = Math.max(0, Number(reservedFrom) || 0);
  for (const code of used) {
    const value = parseInternalBarcode(code);
    if (value !== null && value > highest) highest = value;
  }

  // Never hand out 000000.
  const next = highest + 1;
  if (next > 10 ** BARCODE_DIGITS - 1) {
    throw new Error('The barcode sequence is exhausted. Use a supplier barcode for this product.');
  }
  return `${BARCODE_PREFIX}${String(next).padStart(BARCODE_DIGITS, '0')}`;
}

export type LabelLayout = {
  widthMm: number;
  heightMm: number;
  moduleWidthMm: number;
  barHeightMm: number;
  quietZoneMm: number;
  /** True when the code will not fit the label at a scannable bar width. */
  overflow: boolean;
  /** Barcode symbol width plus both quiet zones, in millimetres. */
  symbolWidthMm: number;
};

/**
 * Works out whether a code fits the label, and at what bar width.
 *
 * The bar width is reduced only as far as the minimum that still scans, so a
 * short code is not needlessly shrunk; if it will not fit even then, the caller
 * is told to pick a wider label rather than printing something unreadable.
 */
export function planLabel(
  text: string,
  label: LabelSettings = DEFAULT_LABEL_SETTINGS,
): LabelLayout {
  const modules = encodeCode128(text).length + QUIET_ZONE_MODULES * 2;

  const availableWidthMm = label.widthMm - 2;
  const wantedModuleMm = availableWidthMm / modules;
  const moduleWidthMm = Math.max(DEFAULT_MODULE_WIDTH_MM, Math.floor(wantedModuleMm * 1000) / 1000);
  const symbolWidthMm = modules * moduleWidthMm;
  const quietZoneMm = QUIET_ZONE_MODULES * moduleWidthMm;

  // Leave room for the human-readable line under the bars.
  const textHeightMm = 4;
  const barHeightMm = Math.max(MIN_BAR_HEIGHT_MM, Math.floor((label.heightMm - 2 - textHeightMm) * 100) / 100);

  return {
    widthMm: label.widthMm,
    heightMm: label.heightMm,
    moduleWidthMm,
    barHeightMm,
    quietZoneMm,
    symbolWidthMm,
    overflow: symbolWidthMm > label.widthMm || barHeightMm + textHeightMm > label.heightMm,
  };
}

/**
 * Builds the SVG for one label.
 *
 * Sized in millimetres with `shape-rendering: crispEdges` and no raster scaling,
 * so the printer lays down whole modules. The bars are grouped into runs to keep
 * the markup small, which also stops a browser from introducing seams between
 * adjacent rects.
 */
export function renderLabelSvg(
  text: string,
  label: LabelSettings = DEFAULT_LABEL_SETTINGS,
  options: { productName?: string; price?: string } = {},
): string {
  const code = text.trim();
  if (!code) throw new Error('A label needs a barcode.');

  const layout = planLabel(code, label);
  const bars = encodeCode128(code);

  const totalWidthMm = label.widthMm;
  const totalHeightMm = label.heightMm;
  const originXmm = (layout.quietZoneMm);
  const originYmm = 2;
  const textYmm = originYmm + layout.barHeightMm + 3.2;
  const fontSizeMm = Math.max(2.2, Math.min(3.2, layout.barHeightMm / 6));

  // Merge runs of modules into single rects: fewer elements, and no seams.
  const rects: string[] = [];
  let runStart = -1;
  for (let i = 0; i <= bars.length; i++) {
    const isBar = i < bars.length && bars[i] === 1;
    if (isBar) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const x = originXmm + runStart * layout.moduleWidthMm;
      const width = (i - runStart) * layout.moduleWidthMm;
      // Snap to three decimals so the printer gets exact millimetres.
      rects.push(`<rect x="${x.toFixed(3)}" y="${originYmm}" width="${width.toFixed(3)}" height="${layout.barHeightMm.toFixed(2)}" fill="#000000" />`);
      runStart = -1;
    }
  }

  const caption = options.productName
    ? `<text x="${(totalWidthMm / 2).toFixed(2)}" y="${(totalHeightMm - 1.2).toFixed(2)} font-family="Arial, Helvetica, sans-serif" font-size="2.4" font-weight="700" text-anchor="middle" fill="#000000">${escapeXml(options.productName).slice(0, 42)}</text>`
    : '';

  const price = options.price
    ? `<text x="${(totalWidthMm / 2).toFixed(2)}" y="${(totalHeightMm - 3.8).toFixed(2)}" font-family="Arial, Helvetica, sans-serif" font-size="3" font-weight="700" text-anchor="middle" fill="#000000">${escapeXml(options.price)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidthMm}mm" height="${totalHeightMm}mm" viewBox="0 0 ${totalWidthMm} ${totalHeightMm}" shape-rendering="crispEdges">
  <rect x="0" y="0" width="${totalWidthMm}" height="${totalHeightMm}" fill="#ffffff" />
  <g>${rects.join('')}</g>
  <text x="${(totalWidthMm / 2).toFixed(2)}" y="${textYmm.toFixed(2)}" font-family="'Courier New', monospace" font-size="${fontSizeMm.toFixed(2)}" font-weight="700" text-anchor="middle" fill="#000000" letter-spacing="${(layout.moduleWidthMm * 2).toFixed(3)}">${escapeXml(code)}</text>
  ${price}
  ${caption}
</svg>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}