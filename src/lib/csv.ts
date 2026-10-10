/**
 * CSV, written by hand.
 *
 * A CSV export has to survive a round trip through a spreadsheet, and that is
 * where the interesting cases are:
 *
 *   - A value containing a comma, quote or newline must be quoted, and internal
 *     quotes doubled. "Mango Kush, 450g" otherwise becomes two columns.
 *   - A leading `=` or `+` is a formula to a spreadsheet, not text. Anything
 *     starting with those is prefixed so it cannot execute when the file is
 *     opened.
 *   - Barcodes are text. A 13-digit barcode written as `5012345678900` is read
 *     back as a number and loses its leading zeros the moment anyone edits the
 *     file, so it is quoted and the import reads it as a string.
 */

/** Quotes a single field if it needs it, doubling any internal quotes. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);

  // Defuse spreadsheet formulas. Prefixing with an apostrophe keeps the text
  // visible and inert.
  const formulaSafe = /^[=+\-@\t\r]/.test(text);
  if (formulaSafe) text = `'${text}`;

  if (formulaSafe || /^\d+$/.test(text) || /[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Builds a whole document from a header row and data rows. */
export function buildCsv(table: { header: string[]; rows: string[][] }): string {
  const lines = [table.header.map(csvField).join(',')];
  for (const row of table.rows) {
    lines.push(row.map(csvField).join(','));
  }
  // CRLF: what Excel on Windows expects, and harmless elsewhere.
  return `${lines.join('\r\n')}\r\n`;
}

/** Re-exported for callers that only want the field helper. */
export const csvCell = csvField;

export type ParsedRow = {
  values: string[];
  /** 1-based line number in the original file, for error messages. */
  line: number;
};

export type ParseResult = {
  rows: ParsedRow[];
  /** Non-fatal problems, e.g. a row whose column count does not match. */
  warnings: string[];
};

/**
 * Reads CSV text into rows of raw strings.
 *
 * Deliberately returns every field as a string and does no type conversion: the
 * caller decides that a barcode is text and that a price is a number. Anything
 * that guesses would eventually turn `5012345678900` into a float.
 *
 * Handles a UTF-8 byte-order mark, quoted fields containing commas, quotes and
 * newlines, and both CRLF and LF line endings.
 */
export function parseCsv(text: string): ParseResult {
  const warnings: string[] = [];
  // Strip the BOM Excel writes, so the first header is not called "﻿name".
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: ParsedRow[] = [];
  let values: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let sawAnyContent = false;

  const endField = () => {
    values.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // A trailing newline at the end of the file leaves one empty row; drop it
    // rather than reporting a blank line to the user.
    const isBlank = values.length === 1 && values[0] === '';
    if (!isBlank) rows.push({ values, line: rowStartLine });
    values = [];
    rowStartLine = line;
    sawAnyContent = false;
  };

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          // An escaped quote inside a quoted field.
          field += '"';
          index++;
        } else {
          inQuotes = false;
        }
      } else if (char === '\n') {
        field += '\n';
        line++;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (field !== '') {
        warnings.push(`Line ${line}: a quote in the middle of a value was treated as the start of a quoted field.`);
      }
      inQuotes = true;
      sawAnyContent = true;
      continue;
    }
    if (char === ',') {
      endField();
      sawAnyContent = true;
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      line++;
      endRow();
      continue;
    }
    field += char;
    sawAnyContent = true;
  }

  // Anything left over is the final row, with no trailing newline.
  if (sawAnyContent || field !== '' || values.length > 0) endRow();

  return { rows, warnings };
}

/**
 * Finds a column by header name, case- and space-insensitively.
 *
 * Returns -1 when absent, so the caller can report "no barcode column" rather
 * than silently reading the wrong column.
 */
export function columnIndex(header: string[], name: string): number {
  const wanted = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return header.findIndex(column => {
    const normalized = column.toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalized === wanted || normalized.startsWith(wanted);
  });
}

/** Case-insensitive, punctuation-insensitive header lookup by any of several names. */
export function columnIndexAny(header: string[], names: string[]): number {
  for (const name of names) {
    const index = columnIndex(header, name);
    if (index >= 0) return index;
  }
  return -1;
}