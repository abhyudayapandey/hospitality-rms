// A form that asks for stock (ADR 101): the items below par first, under "Running short", then
// the rest under their category, A to Z, those with none last under "Other". Each item once.

export interface ItemSection<T> {
  key: string;
  label: string;
  short: boolean;
  rows: T[];
}

export function shortFirst<T extends { name: string; category?: string | null }>(
  rows: readonly T[],
  isShort: (row: T) => boolean,
): ItemSection<T>[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const short = rows.filter(isShort).sort(byName);
  const rest = new Map<string, T[]>();
  for (const r of rows) {
    if (isShort(r)) continue;
    const c = r.category?.trim() || '';
    rest.set(c, [...(rest.get(c) ?? []), r]);
  }
  const cats = [...rest.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (rest.has('')) cats.push('');
  return [
    ...(short.length ? [{ key: 'short', label: 'Running short', short: true, rows: short }] : []),
    ...cats.map((c) => ({
      key: `cat-${c || 'other'}`,
      label: c || 'Other',
      short: false,
      rows: rest.get(c)!.sort(byName),
    })),
  ];
}

/** How much a − or + moves a quantity: 100 for grams and millilitres, else 1. */
export function qtyStep(uom: string): number {
  return uom === 'g' || uom === 'ml' ? 100 : 1;
}
