// Long lists show the latest LIST_PAGE rows, then "Show more" (?n=), while their counts have no
// limit (ADR 052): a tab's count is always the whole list, never the rows that fit a page.

export const LIST_PAGE = 30;
const MAX = 500;

/** The ?n= of a list: `page` (LIST_PAGE) by default, at most MAX. */
export function listLimit(n: string | null | undefined, page = LIST_PAGE): number {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX) : page;
}
