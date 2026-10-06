// The Stock screen's tabs (ADR 053, 054): up to 4, then a "More" button that shows the rest in
// the same row and turns into "Less". Tabs keep their order; when the screen you are on is
// one of the rest, the row opens already showing them. Pure, for tests.

export const SHOWN_TABS = 4;

/** `tabs` in their usual order; `active` is the screen's href. */
export function splitTabs<T extends { href: string }>(
  tabs: readonly T[],
  active: string,
  max = SHOWN_TABS,
): { shown: T[]; more: T[]; open: boolean } {
  if (tabs.length <= max + 1) return { shown: [...tabs], more: [], open: false };
  const more = tabs.slice(max);
  return { shown: tabs.slice(0, max), more, open: more.some((t) => t.href === active) };
}
