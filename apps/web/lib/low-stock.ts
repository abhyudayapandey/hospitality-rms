// "Running low" (ADR 141, was ADR 034): below its par. Each line says both what is left of the
// par and how long that lasts at the rate the store used it over the last two weeks:
// "14 of 20 kg (~1 day left)". Pure, so it can be unit tested; the same rule counts low items
// on Home (lib/today.ts).

/** Days of use the rate is taken over. */
export const USE_DAYS = 14;
export interface StockFigures {
  on_hand: string | number;
  par_level: string | number;
  /** what went out over the last USE_DAYS days (use, sales, transfers out, wastage) */
  used: string | number | null;
}

/** How many days what is on hand lasts at the recent rate; null when it isn't used. */
export function daysLeft(f: StockFigures): number | null {
  const used = Number(f.used ?? 0);
  if (!(used > 0)) return null;
  return Math.max(0, Number(f.on_hand)) / (used / USE_DAYS);
}

export function isLow(f: StockFigures): boolean {
  return Number(f.par_level) > 0 && Number(f.on_hand) < Number(f.par_level);
}

/** "~2 days left", "under a day left", "none left"; '' when it isn't used. */
export function lastsText(f: StockFigures): string {
  if (Number(f.on_hand) <= 0) return 'none left';
  const d = daysLeft(f);
  if (d === null) return '';
  if (d < 1) return 'under a day left';
  const n = Math.floor(d);
  return `~${n} ${n === 1 ? 'day' : 'days'} left`;
}
