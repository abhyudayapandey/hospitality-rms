// The two groups of the Main Store's materials (ADR 051 addendum): every store sees both,
// its own first (the database orders them).

export type ItemGroup = 'kitchen_bar' | 'housekeeping';

export const ITEM_GROUP_LABEL: Readonly<Record<ItemGroup, string>> = {
  kitchen_bar: 'Kitchen & Bar items',
  housekeeping: 'Housekeeping items',
};

/** Splits rows into their groups, keeping the order they came in (own group first). */
export function byGroup<T extends { item_group?: string | null }>(
  rows: readonly T[],
): { group: ItemGroup; label: string; rows: T[] }[] {
  const out: { group: ItemGroup; label: string; rows: T[] }[] = [];
  for (const r of rows) {
    const g: ItemGroup = r.item_group === 'housekeeping' ? 'housekeeping' : 'kitchen_bar';
    let bucket = out.find((b) => b.group === g);
    if (!bucket) {
      bucket = { group: g, label: ITEM_GROUP_LABEL[g], rows: [] };
      out.push(bucket);
    }
    bucket.rows.push(r);
  }
  return out;
}
