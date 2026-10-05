// The supply tabs a person sees (ADR 053): up to 4, the rest under "More", so eight pills do
// not push the screen down. The screen they are on is always among the 4. Pure, for tests.

export const SHOWN_TABS = 4;

/** `tabs` in their usual order; `active` is the screen's href. */
export function splitTabs<T extends { href: string }>(
  tabs: readonly T[],
  active: string,
  max = SHOWN_TABS,
): { shown: T[]; more: T[] } {
  if (tabs.length <= max + 1) return { shown: [...tabs], more: [] };
  const shown = tabs.slice(0, max);
  const current = tabs.find((t) => t.href === active);
  if (current && !shown.includes(current)) shown[max - 1] = current;
  return { shown, more: tabs.filter((t) => !shown.includes(t)) };
}
