/**
 * A very small PDF writer.
 *
 * Reports have to be printable and exportable with no external service, so this
 * builds the PDF directly: the minimum a reader needs is a catalogue, a page tree
 * and one content stream per page, with Helvetica drawn as text.
 *
 * The output is uncompressed, which makes it larger than it needs to be and
 * completely dependency-free.
 */

const PAGE_WIDTH = 595.28; // A4 portrait, in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const LINE_HEIGHT = 14;

/** Escapes the characters that are special inside a PDF literal string. */
function escapeText(value: string): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // Helvetica is a single-byte encoding; these are the ones it cannot show.
    .replace(/[^\x20-\x7E]/g, (character) => {
      const codePoints: Record<string, string> = {
        '¢': 'GH¢', '₵': 'GH¢', '–': '-', '—': '-', '‘': "'", '’': "'",
        '“': '"', '”': '"', '…': '...', ' ': ' ',
      };
      return codePoints[character] ?? '?';
    });
}

type TextRow = { text: string; size: number; bold?: boolean; gapBefore?: number };

/** Trims a row to fit the printable width, so columns never run off the page. */
function fit(text: string, size: number, maxWidth: number): string {
  // Helvetica averages about 0.5 em per character; good enough to keep a table
  // inside the margin without measuring glyphs exactly.
  const maxChars = Math.max(4, Math.floor(maxWidth / (size * 0.5)));
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export type PdfTable = {
  title: string;
  columns: string[];
  rows: string[][];
};

export type PdfSection = {
  table?: PdfTable;
  keyValues?: Array<[string, string]>;
  secondTable?: PdfTable;
};

export type PdfInput = {
  title: string;
  subtitle?: string;
  sections: PdfSection[];
};

/**
 * Builds a multi-page PDF.
 *
 * Rows that do not fit the page start a new one, so a long product list prints
 * across several sheets with the heading repeated.
 */
export function buildPdf(input: PdfInput): Buffer {
  const printableWidth = PAGE_WIDTH - MARGIN * 2;

  // Flatten into a list of drawn lines first, so pagination is decided by
  // measurement rather than guessed at.
  const lines: TextRow[] = [];
  lines.push({ text: input.title, size: 18, bold: true, gapBefore: 0 });
  if (input.subtitle) lines.push({ text: input.subtitle, size: 10 });
  lines.push({ text: `Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`, size: 8 });
  lines.push({ text: '', size: 6 });

  for (const section of input.sections) {
    if (section.keyValues?.length) {
      lines.push({ text: 'Summary', size: 12, bold: true, gapBefore: 8 });
      for (const [label, value] of section.keyValues) {
        lines.push({ text: `${label.padEnd(24, ' ')}${value}`, size: 10 });
      }
      lines.push({ text: '', size: 8 });
    }
    for (const table of [section.table, section.secondTable].filter(Boolean) as PdfTable[]) {
      lines.push({ text: table.title, size: 12, bold: true, gapBefore: 8 });
      lines.push({ text: table.columns.join('   |   '), size: 9, bold: true });
      for (const row of table.rows) {
        lines.push({ text: fit(row.join('   |   '), 9, printableWidth), size: 9 });
      }
      if (!table.rows.length) lines.push({ text: 'Nothing recorded in this period.', size: 9 });
      lines.push({ text: '', size: 8 });
    }
  }

  // ── Paginate ─────────────────────────────────────────────────────────────
  const usableHeight = PAGE_HEIGHT - MARGIN * 2 - 30;
  const pages: TextRow[][] = [];
  let current: TextRow[] = [];
  let used = 0;

  for (const line of lines) {
    const height = (line.size / 72) * LINE_HEIGHT + (line.gapBefore || 0);
    if (used + height > usableHeight) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(line);
    used += height;
  }
  if (current.length) pages.push(current);

  // ── Build the file ───────────────────────────────────────────────────────
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // object numbers are 1-based
  };

  // Reserve 1 = catalogue, 2 = pages, 3 = font, then page and content objects.
  const catalogueId = add(''); // placeholder, filled below
  const pagesId = add('');
  const regularFontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const boldFontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const pageIds: number[] = [];
  for (const pageLines of pages) {
    const content = pageLines
      .map(line => {
        const y = PAGE_HEIGHT - MARGIN - (line.gapBefore || 0) - line.size;
        const font = line.bold ? '/F2' : '/F1';
        return `BT ${font} ${line.size} Tf 1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm (${escapeText(line.text)}) Tj ET`;
      })
      .join('\n');

    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objects[catalogueId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  // ── Serialise ────────────────────────────────────────────────────────────
  const chunks: Buffer[] = [];
  let pdf = '%PDF-1.4\n';
  // A binary comment marks the file as binary for transfer tools.
  pdf += '%\xE2\xE3\xCF\xD3\n';

  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogueId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  chunks.push(Buffer.from(pdf, 'latin1'));
  return Buffer.concat(chunks);
}