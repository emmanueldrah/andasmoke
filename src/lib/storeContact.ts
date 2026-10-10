/** POS receipt contact details. */
export const BUSINESS_PHONE = '0553346776';

const LEGACY_BUSINESS_DIGITS = new Set(['233592153306', '0592153306', '592153306']);

const toDigits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

/**
 * Returns the business number, replacing blanks and any previously configured
 * number with the current line. A different, deliberately configured number is
 * preserved so an admin can still point the storefront at another line.
 */
export const resolveStorePhone = (value: unknown): string => {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!raw) return BUSINESS_PHONE;
  return LEGACY_BUSINESS_DIGITS.has(toDigits(raw)) ? BUSINESS_PHONE : raw;
};