// A small RFC 4180 CSV reader: comma separated, double-quoted fields may hold commas,
// quotes ("") and line breaks. Enough for the onboarding files; no dependency needed.

export interface CsvTable {
  header: string[];
  /** Data rows keyed by header; `line` is the 1-based line in the file (header is line 1). */
  rows: { line: number; values: Record<string, string> }[];
}

export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
  }
}

export function parseCsv(text: string): CsvTable {
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // byte order mark
  const endRecord = () => {
    fields.push(field);
    if (!(fields.length === 1 && fields[0] === '')) records.push({ line: start, fields });
    fields = [];
    field = '';
  };
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
    } else if (ch === '"') {
      if (field !== '') throw new CsvError('a quote may only start a field', line);
      quoted = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      start = line;
    } else {
      field += ch;
    }
  }
  if (quoted) throw new CsvError('a quoted field is not closed', start);
  endRecord();

  const [head, ...body] = records;
  if (!head) return { header: [], rows: [] };
  const header = head.fields.map((h) => h.trim());
  return {
    header,
    rows: body.map((r) => {
      if (r.fields.length !== header.length) {
        throw new CsvError(`expected ${header.length} columns, found ${r.fields.length}`, r.line);
      }
      const values: Record<string, string> = {};
      header.forEach((h, k) => (values[h] = r.fields[k]!.trim()));
      return { line: r.line, values };
    }),
  };
}

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

/** Writes a table back out: the header, then each row in the header's order. */
export function writeCsv(
  header: readonly string[],
  rows: readonly Record<string, string>[],
): string {
  return (
    [header.join(','), ...rows.map((r) => header.map((h) => cell(r[h] ?? '')).join(','))].join(
      '\n',
    ) + '\n'
  );
}
