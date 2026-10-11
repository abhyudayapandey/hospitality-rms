// Quantities on screen (ADR 054): at most 2 decimals, whole g and ml, no trailing zeros.
// The database keeps 6 (a 100 ml pour from a 750 ml bottle, ADR 015); the screen never shows
// them. No server imports, so forms can use it too.

// things counted one by one show whole (ADR 114): a roll is a roll, not 51.9 of them
const UNIT_DECIMALS: Record<string, number> = { g: 0, ml: 0, each: 0, pc: 0, pcs: 0 };

/** "1,234.5 kg", "0.96 kg", "250 g", "-5.3 kg". */
export function formatQty(qty: string | number, uom: string): string {
  const digits = UNIT_DECIMALS[uom] ?? 2;
  const text = new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits }).format(
    Number(qty),
  );
  return `${text} ${uom}`.trim();
}

/** A quantity put into a box (Fill to par): at most 2 decimals, no grouping. */
export function inputQty(qty: string | number): string {
  const n = Math.round(Number(qty) * 100) / 100;
  return Number.isFinite(n) ? String(n) : '';
}
