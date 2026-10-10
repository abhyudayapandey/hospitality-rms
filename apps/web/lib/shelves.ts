// Stock check rows by shelf (ADR 043, 101): the rows come in shelf order; consecutive rows on
// one shelf form a group. A store with no shelves at all gets one group with no heading
// (`shelf` undefined); rows with no shelf at a store that has some go under "Other" (null).

export interface ShelfGroup<T> {
  shelf: string | null | undefined;
  rows: T[];
}

export function shelfGroups<T extends { shelf: string | null }>(rows: T[]): ShelfGroup<T>[] {
  if (!rows.some((r) => r.shelf)) return rows.length ? [{ shelf: undefined, rows }] : [];
  const out: ShelfGroup<T>[] = [];
  const byShelf = new Map<string | null, ShelfGroup<T>>();
  for (const r of rows) {
    const key = r.shelf || null;
    let g = byShelf.get(key);
    if (!g) {
      g = { shelf: key, rows: [] };
      byShelf.set(key, g);
      out.push(g);
    }
    g.rows.push(r);
  }
  // "Other" last
  return [...out.filter((g) => g.shelf !== null), ...out.filter((g) => g.shelf === null)];
}
