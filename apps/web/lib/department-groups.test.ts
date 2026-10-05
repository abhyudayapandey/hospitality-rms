import { describe, expect, it } from 'vitest';
import { departmentSections } from './department-groups';
import type { PlaceDepartment } from './today-view';

const o = 'Test Hotel & Bar 1.0';
const place = (node: string, department: string | null, rank: number): PlaceDepartment => ({
  node_id: node,
  department_id: department ? `d-${department}` : null,
  department: department ? `${o} – ${department}` : null,
  rank,
  outlet_id: 'o1',
  outlet: o,
});
const places = [
  place('kitchen', 'Kitchen', 1),
  place('kitchen-store', 'Kitchen', 1),
  place('bar', 'Bar', 2),
  place('outlet', null, 5),
];

describe('All departments (ADR 048)', () => {
  it('Kitchen first, the outlet itself last; one section per department', () => {
    const s = departmentSections(
      [
        { id: 1, org_node_id: 'outlet' },
        { id: 2, org_node_id: 'bar' },
        { id: 3, org_node_id: 'kitchen-store' },
        { id: 4, org_node_id: 'kitchen' },
      ],
      places,
    );
    expect(s.map((x) => x.label)).toEqual(['Kitchen', 'Bar', 'Whole outlet']);
    expect(s[0]!.rows.map((r) => r.id)).toEqual([3, 4]);
  });

  it('keeps the outlet in the name when there are several outlets', () => {
    const two = [
      ...places,
      {
        ...place('x', 'Bar', 2),
        outlet_id: 'o2',
        outlet: 'Test Bar 3.0',
        department_id: 'd-x',
        department: 'Test Bar 3.0 – Bar',
      },
    ];
    const s = departmentSections([{ org_node_id: 'bar' }, { org_node_id: 'x' }], two);
    expect(s.map((x) => x.label)).toEqual(['Test Bar 3.0 – Bar', `${o} – Bar`]);
  });

  it('a place with no department known is its own section', () => {
    const s = departmentSections([{ org_node_id: 'unknown' }], places);
    expect(s).toHaveLength(1);
  });
});
