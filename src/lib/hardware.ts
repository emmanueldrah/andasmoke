/**
 * Till-wide settings that are not shop identity: hardware behaviour.
 *
 * These live in the database's `store_settings` table like any other setting, so
 * they survive a restart and follow the till to another machine when it is
 * restored. Each has a default, so a setting that was never saved still works.
 */

/**
 * How fast keystrokes must arrive to be treated as a scanner rather than typing.
 *
 * A USB or Bluetooth barcode scanner sends its payload in roughly 2-10 ms per
 * character; a person types at 100-250 ms. The gap is an *average* across the
 * burst, so one slow character on a busy machine does not break a real scan.
 */
export type ScannerSettings = {
  /** Average milliseconds per character at or below which a burst is a scan. */
  maxAverageGapMs: number;
  /** Fewest characters in a burst that can be a barcode. */
  minChars: number;
  /** Longest total burst, in milliseconds, still treated as one scan. */
  maxBurstMs: number;
  /** A pause longer than this ends the current burst. */
  pauseResetMs: number;
  /** Longest code accepted, as a guard against a pasted paragraph. */
  maxCodeLength: number;
};

export const DEFAULT_SCANNER_SETTINGS: ScannerSettings = {
  maxAverageGapMs: 45,
  minChars: 8,
  maxBurstMs: 2500,
  pauseResetMs: 250,
  maxCodeLength: 128,
};

/**
 * Physical label dimensions, in millimetres.
 *
 * Printed at true size so a thermal printer produces bars the width they were
 * encoded at. The defaults suit a common 50x30 mm roll.
 */
export type LabelSettings = {
  widthMm: number;
  heightMm: number;
};

export const DEFAULT_LABEL_SETTINGS: LabelSettings = {
  widthMm: 50,
  heightMm: 30,
};

/** Barcode prefix for codes this till issues itself. */
export const BARCODE_PREFIX = 'ACS-';
/** How many digits follow the prefix: ACS-000001 upward. */
export const BARCODE_DIGITS = 6;

export type HardwareSettings = {
  scanner: ScannerSettings;
  label: LabelSettings;
};

export const DEFAULT_HARDWARE_SETTINGS: HardwareSettings = {
  scanner: DEFAULT_SCANNER_SETTINGS,
  label: DEFAULT_LABEL_SETTINGS,
};

function positiveNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  // Clamp rather than reject: a mistyped 5000 should not break scanning.
  return Math.min(Math.max(parsed, min), max);
}

/** Coerces whatever came out of storage into safe, usable numbers. */
export function normalizeScannerSettings(raw: unknown): ScannerSettings {
  const source = (raw || {}) as Partial<ScannerSettings>;
  return {
    maxAverageGapMs: positiveNumber(source.maxAverageGapMs, DEFAULT_SCANNER_SETTINGS.maxAverageGapMs, 5, 500),
    minChars: Math.round(positiveNumber(source.minChars, DEFAULT_SCANNER_SETTINGS.minChars, 3, 64)),
    maxBurstMs: positiveNumber(source.maxBurstMs, DEFAULT_SCANNER_SETTINGS.maxBurstMs, 200, 30_000),
    pauseResetMs: positiveNumber(source.pauseResetMs, DEFAULT_SCANNER_SETTINGS.pauseResetMs, 50, 5_000),
    maxCodeLength: Math.round(positiveNumber(source.maxCodeLength, DEFAULT_SCANNER_SETTINGS.maxCodeLength, 8, 512)),
  };
}

export function normalizeLabelSettings(raw: unknown): LabelSettings {
  const source = (raw || {}) as Partial<LabelSettings>;
  return {
    widthMm: positiveNumber(source.widthMm, DEFAULT_LABEL_SETTINGS.widthMm, 20, 300),
    heightMm: positiveNumber(source.heightMm, DEFAULT_LABEL_SETTINGS.heightMm, 10, 300),
  };
}

export function normalizeHardwareSettings(raw: unknown): HardwareSettings {
  const source = (raw || {}) as { scanner?: unknown; label?: unknown };
  return { scanner: normalizeScannerSettings(source.scanner), label: normalizeLabelSettings(source.label) };
}