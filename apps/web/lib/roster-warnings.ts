// Rostering warnings (ADR 019): rest and weekly hours are shown to whoever assigns or
// approves, who can go ahead anyway. The database words each detail for
// "<name> would have ...".

export const WARNING_CODES = ['REST_RULE', 'WEEKLY_HOURS_CAP'] as const;

/** "Test Commis B 1.0 would have 52 h this week (limit 48 h)." */
export function warningSentence(name: string, detail: string): string {
  return `${name} ${detail}.`;
}

/** "Would have 52 h this week (limit 48 h)", for a list already headed by the name. */
export function warningPhrase(detail: string): string {
  return detail.charAt(0).toUpperCase() + detail.slice(1);
}
