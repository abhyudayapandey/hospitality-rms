// Quantities on screen (ADR 054): at most 2 decimals, whole g and ml, no trailing zeros.
// The database keeps 6 (a 100 ml pour from a 750 ml bottle, ADR 015); the screen never shows
// them. No server imports, so forms can use it too.

// things counted one by one show whole (ADR 114, 162): a roll is a roll, not 51.9 of them, and a
// can a can; a bar's part bottle stays (ADR 015). The same rule is inv.qty_text in SQL.
const WHOLE = [
  'g',
  'ml',
  'each',
  'pc',
  'pcs',
  'can',
  'tin',
  'pack',
  'packet',
  'box',
  'roll',
  'piece',
];
const UNIT_DECIMALS: Record<string, number> = Object.fromEntries(
  WHOLE.flatMap((u) => [
    [u, 0],
    [/(x|ch|sh)$/.test(u) ? `${u}es` : `${u}s`, 0],
  ]),
);

/** The number alone, as its unit shows it: "73" for 72.5 each, "19.47" for bottles. */
export function formatNumber(qty: string | number, uom: string): string {
  const digits = UNIT_DECIMALS[uom.trim().toLowerCase()] ?? 2;
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits }).format(Number(qty));
}

// measures never take a plural ("2 kg"); "each" is a word for one of a thing ("2 each")
const MEASURES = new Set(['g', 'kg', 'mg', 'ml', 'cl', 'l', 'ltr', 'each', 'pc', 'pcs']);

/** A unit as many of it are said (ADR 160): "bottle" -> "bottles", "box" -> "boxes"; a measure
 * stays as it is. */
export function unitWord(uom: string, qty: number): string {
  const u = uom.trim();
  if (!u || MEASURES.has(u.toLowerCase()) || Math.abs(qty) === 1) return u;
  if (/s$/i.test(u)) return u;
  return /(x|ch|sh)$/i.test(u) ? `${u}es` : `${u}s`;
}

/** "1,234.5 kg", "0.96 kg", "250 g", "-5.3 kg", "1 bottle", "129 bottles". */
export function formatQty(qty: string | number, uom: string): string {
  const text = formatNumber(qty, uom);
  const shown = Number(text.replace(/,/g, ''));
  return `${text} ${unitWord(uom, shown)}`.trim();
}

/** A count of things in a room or a set (ADR 160): "2", "2 bottles", "1.5 kg"; "each" is not
 * said, since a plain number already means that many. */
export function formatCount(qty: string | number, uom: string): string {
  return ['each', 'pc', 'pcs'].includes(uom) ? formatQty(qty, '') : formatQty(qty, uom);
}

/** A quantity put into a box (Fill to par): at most 2 decimals, no grouping. */
export function inputQty(qty: string | number): string {
  const n = Math.round(Number(qty) * 100) / 100;
  return Number.isFinite(n) ? String(n) : '';
}
