// "Low stock" (UX-6, ADR 034): an item runs out within three days at the rate the store used
// it over the last two weeks, or has none left. Below its level but hardly used is not low:
// when 14 of 16 items were flagged "below par", nothing stood out. Pure, so it can be unit
// tested; the same rule counts low items on Home (lib/today.ts).

/** Days of use the rate is taken over. */
export const USE_DAYS = 14;
/** Low when it lasts this many days or fewer. */
export const LOW_DAYS = 3;

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
  if (!(Number(f.par_level) > 0)) return false;
  if (Number(f.on_hand) <= 0) return true;
  if (Number(f.on_hand) >= Number(f.par_level)) return false;
  const d = daysLeft(f);
  return d !== null && d <= LOW_DAYS;
}

/** "Lasts 2 days", "Lasts under a day", "None left". */
export function lastsText(f: StockFigures): string {
  if (Number(f.on_hand) <= 0) return 'None left';
  const d = daysLeft(f);
  if (d === null) return '';
  if (d < 1) return 'Lasts under a day';
  const n = Math.floor(d);
  return `Lasts ${n} ${n === 1 ? 'day' : 'days'}`;
}
