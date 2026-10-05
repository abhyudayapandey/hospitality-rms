// "All departments" (ADR 048): rows from several places grouped by the department each
// belongs to, in the order Home uses (ADR 033: Kitchen, Service, Housekeeping, the rest, the
// outlet itself), each section named without its outlet when there is only one. The
// department of a place comes from core.department_of. Pure.

import type { PlaceDepartment } from './today-view';

export interface DepartmentSection<T> {
  key: string;
  label: string;
  rows: T[];
}

export function departmentSections<T extends { org_node_id: string }>(
  rows: readonly T[],
  places: readonly PlaceDepartment[],
  nodeOf: (row: T) => string = (r) => r.org_node_id,
): DepartmentSection<T>[] {
  const of = new Map(places.map((p) => [p.node_id, p]));
  const groups = new Map<string, { place: PlaceDepartment | undefined; rows: T[] }>();
  for (const r of rows) {
    const p = of.get(nodeOf(r));
    const key = p?.department_id ?? `outlet:${p?.outlet_id ?? nodeOf(r)}`;
    const g = groups.get(key) ?? { place: p, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  const oneOutlet = new Set([...groups.values()].map((g) => g.place?.outlet_id ?? '')).size === 1;
  const label = (p: PlaceDepartment | undefined) => {
    if (!p?.department) return oneOutlet ? 'Whole outlet' : (p?.outlet ?? 'Other places');
    const prefix = `${p.outlet} – `;
    return oneOutlet && p.outlet && p.department.startsWith(prefix)
      ? p.department.slice(prefix.length)
      : p.department;
  };
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      rank: g.place?.rank ?? 5,
      outlet: g.place?.outlet ?? '',
      label: label(g.place),
      rows: g.rows,
    }))
    .sort(
      (a, b) =>
        a.rank - b.rank || a.outlet.localeCompare(b.outlet) || a.label.localeCompare(b.label),
    )
    .map(({ key, label: l, rows: r }) => ({ key, label: l, rows: r }));
}
