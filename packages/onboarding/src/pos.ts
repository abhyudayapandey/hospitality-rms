import { unzipSync } from 'fflate';

// Reading a POS's end-of-day "Sale by item" export (SAL-2, ADR 039), as IDSNEXT writes it
// and others alike: a title, then the header `Item | Description | Quantity | Rate | Value |
// Discount`; lines grouped by POS outlet and menu type, each group closed by a total row,
// and `Grand Total` at the end. Excel (.xlsx, read with fflate, which the onboarding upload
// already uses) or CSV. Total rows are skipped, the lines must add up to the Grand Total,
// and an item sold at two rates is one line. The database checks it all again
// (menu.import_pos); this only turns the file into lines.

export const MAX_POS_FILE_BYTES = 5 * 1024 * 1024;
const MAX_XML_BYTES = 40 * 1024 * 1024;

export type PosFileErrorCode =
  | 'POS_FILE_EMPTY'
  | 'POS_FILE_TOO_LARGE'
  | 'POS_FILE_TYPE'
  | 'POS_NO_HEADER'
  | 'POS_BAD_NUMBER'
  | 'POS_NO_GRAND_TOTAL'
  | 'POS_TOTALS_MISMATCH'
  | 'POS_NO_LINES';

export class PosFileError extends Error {
  constructor(
    readonly code: PosFileErrorCode,
    readonly detail?: string,
  ) {
    super(code);
  }
}

export interface PosLine {
  code: string;
  description: string;
  qty: number;
  /** What the POS took for the line, after the discount. */
  value: number;
  discount: number;
}

export interface PosFile {
  fileName: string;
  /** The POS outlet groups the file holds (e.g. `LE CAFE`, `LE CAFE TAKE AWAY`). */
  posOutlets: string[];
  /** The dates the title names, if any (ISO). */
  periodFrom: string | null;
  periodTo: string | null;
  lines: PosLine[];
  totalValue: number;
  totalDiscount: number;
}

const COLUMNS = ['item', 'description', 'quantity', 'rate', 'value', 'discount'] as const;

/** Reads an .xlsx or .csv POS export. */
export function readPosFile(fileName: string, bytes: Uint8Array): PosFile {
  if (bytes.length === 0) throw new PosFileError('POS_FILE_EMPTY');
  if (bytes.length > MAX_POS_FILE_BYTES) throw new PosFileError('POS_FILE_TOO_LARGE');
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  let rows: string[][];
  if (isZip) {
    rows = xlsxRows(bytes);
  } else if (/\.(csv|txt)$/i.test(fileName)) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('windows-1252').decode(bytes);
    }
    rows = csvRows(text);
  } else {
    throw new PosFileError('POS_FILE_TYPE', 'an Excel (.xlsx) or CSV file');
  }
  return readRows(fileName, rows);
}

/** The lines of a grid of cells (exported for tests). */
export function readRows(fileName: string, rows: string[][]): PosFile {
  const headerAt = rows.findIndex((r) => {
    const cells = r.map((c) => c.trim().toLowerCase());
    return COLUMNS.every((c) => cells.includes(c));
  });
  if (headerAt < 0) throw new PosFileError('POS_NO_HEADER', COLUMNS.join(', '));
  const header = rows[headerAt]!.map((c) => c.trim().toLowerCase());
  const col = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<
    (typeof COLUMNS)[number],
    number
  >;

  const dates = rows
    .slice(0, headerAt)
    .flatMap((r) => r.flatMap((c) => datesIn(c)))
    .sort();
  const posOutlets: string[] = [];
  const byCode = new Map<string, PosLine>();
  let grand: { value: number; discount: number } | null = null;
  let expectOutlet = true;

  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i]!;
    const cell = (k: keyof typeof col) => (r[col[k]] ?? '').trim();
    const texts = r.map((c) => c.trim()).filter(Boolean);
    if (texts.length === 0) continue;
    // a total row starts with the word: Item Total, Group Total, Menu Type Total,
    // Restaurant Total, Grand Total (an item line starts with its code)
    const first = texts[0]!;
    if (/\btotal\b/i.test(first)) {
      if (/grand\s+total/i.test(first)) {
        grand = { value: num(cell('value'), i), discount: num(cell('discount') || '0', i) };
      }
      if (/(restaurant|outlet)\s+total/i.test(first)) expectOutlet = true;
      continue;
    }
    const item = cell('item');
    const qty = cell('quantity');
    if (!isCode(item) || qty === '') {
      // a heading: the POS outlet first, then its menu types (Food, Liquor, ...)
      if (expectOutlet) {
        posOutlets.push(texts[0]!);
        expectOutlet = false;
      }
      continue;
    }
    const code = normaliseCode(item);
    const line: PosLine = {
      code,
      description: cell('description').replace(/[.\s]+$/, ''),
      qty: num(qty, i),
      value: num(cell('value'), i),
      discount: num(cell('discount') || '0', i),
    };
    const was = byCode.get(code);
    if (was) {
      was.qty += line.qty;
      was.value += line.value;
      was.discount += line.discount;
    } else {
      byCode.set(code, line);
    }
  }

  const lines = [...byCode.values()].map((l) => ({
    ...l,
    qty: round(l.qty, 3),
    value: round(l.value, 2),
    discount: round(l.discount, 2),
  }));
  if (lines.length === 0) throw new PosFileError('POS_NO_LINES');
  if (!grand) throw new PosFileError('POS_NO_GRAND_TOTAL');
  const sum = round(
    lines.reduce((s, l) => s + l.value, 0),
    2,
  );
  if (sum !== round(grand.value, 2)) {
    throw new PosFileError('POS_TOTALS_MISMATCH', `lines ${sum}, Grand Total ${grand.value}`);
  }
  return {
    fileName,
    posOutlets,
    periodFrom: dates[0] ?? null,
    periodTo: dates.at(-1) ?? null,
    lines: lines.sort((a, b) => a.code.localeCompare(b.code)),
    totalValue: sum,
    totalDiscount: round(
      lines.reduce((s, l) => s + l.discount, 0),
      2,
    ),
  };
}

const isCode = (s: string) => /^[^\s]{1,40}$/.test(s.trim());
/** Excel writes a numeric code as `1023` or `1023.0`. */
const normaliseCode = (s: string) => s.trim().replace(/^(\d+)\.0+$/, '$1');
const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round((n + Number.EPSILON) * f) / f;
};

function num(s: string, row: number): number {
  const cleaned = s.replace(/[,\s₹]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = Number(cleaned);
  if (cleaned === '' || !Number.isFinite(n)) {
    throw new PosFileError('POS_BAD_NUMBER', `row ${row + 1}: "${s}"`);
  }
  return n;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Dates in a title: 01/07/2026, 01-07-2026 (day first), 01-Jul-2026, 1 July 2026, 2026-07-01. */
export function datesIn(text: string): string[] {
  const out: string[] = [];
  const iso = (y: number, m: number, d: number) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d) {
      out.push(t.toISOString().slice(0, 10));
    }
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) iso(+m[1]!, +m[2]!, +m[3]!);
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g))
    iso(+m[3]!, +m[2]!, +m[1]!);
  for (const m of text.matchAll(/\b(\d{1,2})[\s-]([A-Za-z]{3,9})[\s,-]+(\d{4})\b/g)) {
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    if (month >= 0) iso(+m[3]!, month + 1, +m[1]!);
  }
  return out;
}

/** CSV rows of any width (the title lines are shorter than the table). */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// --- .xlsx: the first sheet's cells, as text ---------------------------------------------

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

const textOf = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join('');

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxRows(bytes: Uint8Array): string[][] {
  let files: Record<string, Uint8Array>;
  let total = 0;
  try {
    files = unzipSync(bytes, {
      filter(f) {
        const keep =
          f.name === 'xl/sharedStrings.xml' ||
          f.name === 'xl/workbook.xml' ||
          f.name === 'xl/_rels/workbook.xml.rels' ||
          /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name);
        if (keep && (total += f.originalSize) > MAX_XML_BYTES) {
          throw new PosFileError('POS_FILE_TOO_LARGE');
        }
        return keep;
      },
    });
  } catch (err) {
    if (err instanceof PosFileError) throw err;
    throw new PosFileError('POS_FILE_TYPE', 'not a readable Excel file');
  }
  const td = new TextDecoder();
  const xml = (name: string) => (files[name] ? td.decode(files[name]) : '');
  const shared = [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    textOf(m[1]!),
  );

  // the first sheet in the workbook's order, else the lowest-numbered one
  let sheet = '';
  const firstId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(xml('xl/workbook.xml'))?.[1];
  if (firstId) {
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`).exec(
      xml('xl/_rels/workbook.xml.rels'),
    )?.[1];
    if (rel) sheet = `xl/${rel.replace(/^\/?xl\//, '')}`;
  }
  if (!files[sheet]) {
    sheet =
      Object.keys(files)
        .filter((n) => n.startsWith('xl/worksheets/'))
        .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]))[0] ?? '';
  }
  if (!files[sheet]) throw new PosFileError('POS_FILE_TYPE', 'the Excel file has no sheet');

  const rows: string[][] = [];
  for (const rm of xml(sheet).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cm of rm[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!;
      const body = cm[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (v !== undefined) value = decode(v);
      row[ref ? colIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (c) => c ?? ''));
  }
  return rows;
}
