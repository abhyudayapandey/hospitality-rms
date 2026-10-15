import { formatQty } from './qty';

// "Running low" (ADR 141 with ADR 034): under its par, or lasting LOW_DAYS days or fewer at the
// rate the store used it over the last two weeks (par or no par; never for durable things,
// ADR 076). An item counts once either way. Each line says why: "14 of 20 kg (~1 day left)"
// under par, "4 kg (~1 day left)" with no par. The database has the same rule
// (`inv.running_low`, `inv.recent_use`), which counts low items on Home (lib/today.ts) and
// marks them on the Stock screen's lists (lib/inventory.ts).

/** Days of use the rate is taken over. */
export const USE_DAYS = 14;
/** Low when it lasts this many days or fewer. */
export const LOW_DAYS = 3;
export interface StockFigures {
  on_hand: string | number;
  par_level: string | number;
  /** what went out over the last USE_DAYS days (use, sales, transfers out, wastage) */
  used: string | number | null;
  /** durable things (glasses, linen) have no days on hand (ADR 076) */
  durable?: boolean | null;
  /** the database's answer (`inv.running_low`), when the row carries it */
  low?: boolean | null;
}

/** How many days what is on hand lasts at the recent rate; null when it isn't used. */
export function daysLeft(f: StockFigures): number | null {
  const used = Number(f.used ?? 0);
  if (!(used > 0)) return null;
  return Math.max(0, Number(f.on_hand)) / (used / USE_DAYS);
}

/** Under its par. */
export function isUnderPar(f: StockFigures): boolean {
  return Number(f.par_level) > 0 && Number(f.on_hand) < Number(f.par_level);
}

/** Under its par, or few days of use left (`inv.running_low`). */
export function isLow(f: StockFigures): boolean {
  if (isUnderPar(f)) return true;
  if (f.durable) return false;
  const used = Number(f.used ?? 0);
  return used > 0 && (Math.max(0, Number(f.on_hand)) * USE_DAYS) / used <= LOW_DAYS;
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

/** Why a low line is low, in its own words: "14 of 20 kg (~1 day left)" under its par,
 * "4 kg (~1 day left)" when only the days of use say so; else "par 20 kg", or nothing with no
 * par. */
export function parLine(f: StockFigures, uom: string): string {
  const lasts = lastsText(f);
  const tail = lasts ? ` (${lasts})` : '';
  if (isUnderPar(f)) return `${formatQty(f.on_hand, '')} of ${formatQty(f.par_level, uom)}${tail}`;
  if (f.low ?? isLow(f)) {
    const par = Number(f.par_level) > 0 ? ` · par ${formatQty(f.par_level, uom)}` : '';
    return `${formatQty(f.on_hand, uom)}${tail}${par}`;
  }
  return Number(f.par_level) > 0 ? `par ${formatQty(f.par_level, uom)}` : '';
}
