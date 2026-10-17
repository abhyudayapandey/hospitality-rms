// Long lists show the latest LIST_PAGE rows, then "Show more" (?n=), while their counts have no
// limit (ADR 052): a tab's count is always the whole list, never the rows that fit a page.

export const LIST_PAGE = 30;
const MAX = 500;

/** The ?n= of a list: `page` (LIST_PAGE) by default, at most MAX. */
export function listLimit(n: string | null | undefined, page = LIST_PAGE): number {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX) : page;
}

/**
 * The rows a list shows and the address of its next page (null when all of it shows), with
 * the other filters of `params` kept (ADR 052, 169).
 */
export function listPage<T>(
  rows: readonly T[],
  path: string,
  params: Record<string, string | string[] | undefined>,
  page = LIST_PAGE,
): { shown: T[]; more: string | null } {
  const raw = params.n;
  const n = listLimit(Array.isArray(raw) ? raw[0] : raw, page);
  if (rows.length <= n) return { shown: [...rows], more: null };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === 'n' || v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) q.append(k, x);
  }
  q.set('n', String(n + page));
  return { shown: rows.slice(0, n), more: `${path}?${q.toString()}` };
}
