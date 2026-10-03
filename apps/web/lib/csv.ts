// CSV export of the reports (R-4, ADR 031). Pure. A cell that a spreadsheet would read as a
// formula (=, +, -, @, tab or carriage return first) gets a leading apostrophe, unless it
// is a plain number, so an item or supplier name can never run in someone's spreadsheet.

export type Cell = string | number | boolean | null | undefined;

const NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A CSV file: a header row, then one row per record; CRLF line ends, as Excel expects. */
export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** A file name for a download: letters, digits and dashes. */
export function csvName(...parts: string[]): string {
  return `${parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}.csv`;
}
