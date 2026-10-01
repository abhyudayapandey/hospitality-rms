// Shelf life wording (Prompt 10): "Use within N days", or hours under a day. Whole days
// and hours round down, so the label never promises longer than the item keeps.

const HOUR_MS = 3_600_000;

/** A prep item's shelf life: 72 -> "Use within 3 days", 36 -> "1 day", 8 -> "8 hours". */
export function shelfLifeText(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours) || hours <= 0) return '';
  const h = Math.max(1, Math.floor(hours));
  if (h < 24) return `Use within ${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.floor(h / 24);
  return `Use within ${d} day${d === 1 ? '' : 's'}`;
}

/** What is left of a batch's life: the same wording, or "Expired". */
export function timeLeftText(expiresAt: Date | string, now: Date = new Date()): string {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (ms <= 0) return 'Expired';
  return shelfLifeText(Math.max(1, Math.floor(ms / HOUR_MS)));
}
