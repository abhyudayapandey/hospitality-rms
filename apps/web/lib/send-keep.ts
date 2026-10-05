// Send stock's "Fill to keep level" (ADR 053): pure, so it can be unit tested.

/** What brings a department's item up to its keep level, at most what the Main Store has. */
export function toKeepLevel(i: { on_hand: string; to_on_hand: string; to_keep: string }): number {
  const need = Number(i.to_keep) - Math.max(0, Number(i.to_on_hand));
  return Math.max(0, Math.min(need, Number(i.on_hand)));
}
