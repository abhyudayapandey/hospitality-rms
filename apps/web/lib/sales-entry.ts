// Daily sales entry helpers (UX-4, ADR 035): search, copy a day, the total as you type.
// Pure, so they can be unit tested.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Saturday" for 2026-10-03 (the date's own day, no time zone involved). */
export function weekdayName(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

/** Whether a menu item matches what was typed: any word, in its name or code. */
export function matchesSearch(row: { name: string; code: string }, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${row.name} ${row.code}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * The quantities after copying another day's: every item that day had becomes that
 * number; items it didn't have are left as they are. Returns the new map and how many
 * items changed.
 */
export function copyQuantities(
  current: Readonly<Record<string, string>>,
  from: Readonly<Record<string, number>>,
): { qty: Record<string, string>; changed: number } {
  const qty = { ...current };
  let changed = 0;
  for (const [id, n] of Object.entries(from)) {
    if (!(id in qty)) continue;
    if (qty[id] !== String(n)) changed++;
    qty[id] = String(n);
  }
  return { qty, changed };
}

/** Items sold in all, from what is typed (blanks and nonsense count as nothing). */
export function totalSold(qty: Readonly<Record<string, string>>): number {
  return Object.values(qty).reduce((t, v) => {
    const n = Number(v);
    return t + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}
