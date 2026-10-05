// The standard "search, then show more" for a long list (UX-10). Pure, so it is unit tested;
// components/filter-list.tsx holds the state.

export interface FilterRow {
  key: string;
  /** what the search looks in: names, codes, places */
  text: string;
}

/** Rows whose text has every word asked for (any case); all of them when nothing is asked. */
export function matchRows<T extends FilterRow>(rows: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((r) => {
    const t = r.text.toLowerCase();
    return words.every((w) => t.includes(w));
  });
}

export interface Page<T> {
  shown: T[];
  /** how many more "Show more" would reveal */
  more: number;
  /** how many rows match in all */
  total: number;
}

/**
 * What to show: while searching, every match; otherwise the first `limit`, or all once the
 * person has asked for more.
 */
export function pageRows<T extends FilterRow>(
  rows: readonly T[],
  query: string,
  limit: number,
  all: boolean,
): Page<T> {
  const matched = matchRows(rows, query);
  const searching = query.trim() !== '';
  if (searching || all || matched.length <= limit) {
    return { shown: matched, more: 0, total: matched.length };
  }
  return { shown: matched.slice(0, limit), more: matched.length - limit, total: matched.length };
}
