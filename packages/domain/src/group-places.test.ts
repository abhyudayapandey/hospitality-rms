import { describe, expect, it } from 'vitest';
import { ACCESS_GROUPS, groupFitsPlace } from './access';

// Where Admin → Add access offers each group (ADR 151).

describe('groupFitsPlace', () => {
  it('names a place for every product group but self-service', () => {
    const odd = { type: 'org', kind: 'nowhere' };
    expect(
      ACCESS_GROUPS.filter((g) => g.code !== 'SELF' && groupFitsPlace(g.code, odd)).map(
        (g) => g.code,
      ),
    ).toEqual([]);
  });

  it('keeps each group to the places its holders sit at', () => {
    expect(groupFitsPlace('HUB_MANAGER', { type: 'delivery', kind: 'hub' })).toBe(true);
    expect(groupFitsPlace('HUB_MANAGER', { type: 'org', kind: 'outlet' })).toBe(false);
    expect(groupFitsPlace('AREA_MANAGER', { type: 'org', kind: 'outlet' })).toBe(false);
    expect(groupFitsPlace('DEPARTMENT_HEAD', { type: 'org', kind: 'department' })).toBe(true);
    expect(groupFitsPlace('STORE_KEEPER', { type: 'org', kind: 'department' })).toBe(false);
    expect(groupFitsPlace('STORE_KEEPER', { type: 'delivery', kind: 'store' })).toBe(true);
  });

  it("lets a company's own group go anywhere", () => {
    expect(groupFitsPlace('KITCHEN_LEAD', { type: 'org', kind: 'department' })).toBe(true);
  });
});
