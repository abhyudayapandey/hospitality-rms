import { DEFAULT_TZ, formatDay, localDate } from './dates';

// Shelf life wording (Prompt 10): "Use within N days", or hours under a day. Whole days
// and hours round down, so the label never promises longer than the item keeps.

/** A prep item's shelf life: 72 -> "Use within 3 days", 36 -> "1 day", 8 -> "8 hours". */
export function shelfLifeText(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours) || hours <= 0) return '';
  const h = Math.max(1, Math.floor(hours));
  if (h < 24) return `Use within ${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.floor(h / 24);
  return `Use within ${d} day${d === 1 ? '' : 's'}`;
}

/** A batch's use-by, as a date only (the time of day doesn't matter on the floor):
 * "Use by Mon, 5 Oct", or "Expired". */
export function useByText(
  expiresAt: Date | string,
  tz: string = DEFAULT_TZ,
  now: Date = new Date(),
): string {
  if (new Date(expiresAt).getTime() <= now.getTime()) return 'Expired';
  return `Use by ${formatDay(localDate(expiresAt, tz))}`;
}
