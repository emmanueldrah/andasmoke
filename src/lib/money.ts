/**
 * Money, in integer minor units.
 *
 * Ghana's pesewa is the minor unit: 100 pesewas make one cedi. Amounts are held
 * and calculated as whole pesewas — a number of pence, not a floating-point
 * cedi value — because binary floating point cannot represent 0.10 exactly, so
 * adding prices in a till produces a total that is a fraction of a pesewa off and
 * a cash drawer that never balances.
 *
 * Every amount that crosses a boundary is an integer. Conversion to a
 * human-readable string happens only at the edges: the API, a receipt, a report.
 */

/** Minor units in one cedi. */
export const MINOR_PER_MAJOR = 100;

/** Largest amount that can be handled without exceeding a safe integer. */
export const MAX_MINOR = Number.MAX_SAFE_INTEGER;

/**
 * Parses anything a form, a CSV file or a JSON body might supply into pesewas.
 *
 * Rejects anything that is not a plain decimal number rather than coercing it.
 * `parseFloat('12abc')` is 12 and `parseFloat('5.01E+12')` is a completely
 * different barcode, so silently accepting them would corrupt data.
 */
export function toMinor(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * MINOR_PER_MAJOR) : null;
  }
  if (typeof value === 'bigint') return Number(value);

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Scientific notation is never valid money: it is how a 13-digit barcode
  // arrives from a spreadsheet, and accepting it would turn 5012345678900 into
  // 5.01E+12's worth of cedi.
  if (/[eE]/.test(trimmed)) return null;

  // Accept an optional thousands separator only if it is properly grouped, so a
  // typo like 1,5 is rejected rather than read as 15.
  const normalised = /^[+-]?\d{1,3}(,\d{3})*(\.\d+)?$/.test(trimmed)
    ? trimmed.replace(/,/g, '')
    : /^[+-]?\d*\.?\d+$/.test(trimmed) ? trimmed : null;
  if (normalised === null) return null;

  const major = Number(normalised);
  if (!Number.isFinite(major)) return null;

  const minor = Math.round(major * MINOR_PER_MAJOR);
  return Math.abs(minor) <= MAX_MINOR ? minor : null;
}

/** Like {@link toMinor} but throws, for call sites where a number is required. */
export function requireMinor(value: unknown, label = 'amount'): number {
  const minor = toMinor(value);
  if (minor === null) throw new RangeError(`${label} is not a valid amount: ${JSON.stringify(value)}`);
  return minor;
}

/** Converts pesewas back to a cedi number, for display or storage as REAL. */
export function toMajor(minor: number): number {
  return roundMajor(minor / MINOR_PER_MAJOR);
}

/**
 * Formats pesewas for display.
 *
 * Always shows two decimals, so a receipt column always lines up and a cashier
 * can see at a glance that change was given.
 */
export function formatMinor(minor: number): string {
  const negative = minor < 0;
  const absolute = Math.abs(Math.round(minor));
  const major = Math.floor(absolute / MINOR_PER_MAJOR);
  const rest = String(absolute % MINOR_PER_MAJOR).padStart(2, '0');
  return `${negative ? '-' : ''}${major}.${rest}`;
}

/** Formats as a currency amount, e.g. `GH¢ 45.00`. */
export function formatMoney(minor: number, symbol = 'GH¢ '): string {
  const text = formatMinor(minor);
  return text.startsWith('-') ? `-${symbol}${text.slice(1)}` : `${symbol}${text}`;
}

/** Rounds a cedi float to two decimals without the usual float artefacts. */
export function roundMajor(value: number): number {
  return Math.round((value + Number.EPSILON) * MINOR_PER_MAJOR) / MINOR_PER_MAJOR;
}

/** Adds amounts, guarding the 32-bit range a careless caller could reach. */
export function addMinor(...amounts: number[]): number {
  const total = amounts.reduce((sum, amount) => sum + Math.round(amount), 0);
  if (Math.abs(total) > MAX_MINOR) throw new RangeError('Amount is too large to handle safely.');
  return total;
}

/**
 * Applies a discount to a pesewa amount.
 *
 * Rounded half-up on the result, so a percentage discount on an odd number of
 * pesewas lands on a value a customer can be charged, rather than on a
 * fraction that cannot exist in a till.
 */
export function applyPercentageMinor(amount: number, percent: number): number {
  return Math.round((Math.round(amount) * percent) / 100);
}

/**
 * Multiplies an amount by a quantity, rounding half-up on the final pesewa.
 *
 * Rounding per line rather than on the total keeps the printed line figures
 * adding up to the printed total.
 */
export function multiplyMinor(unit: number, quantity: number): number {
  return Math.round(Math.round(unit) * Math.round(quantity));
}