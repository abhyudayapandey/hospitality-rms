import { describe, expect, it } from 'vitest';
import { homeTiles, screensFor, type ScreenInput } from './screens';

// Me and Home's tiles (UX-6, ADR 034): every screen a person can open, chosen from their
// domain access; frontline staff see four tiles.

const SELF: [string, 'view' | 'modify'][] = [
  ['ROSTER', 'view'],
  ['TASKS', 'view'],
  ['MAINTENANCE', 'modify'],
  ['LEAVE', 'modify'],
  ['ATTENDANCE', 'modify'],
];

const input = (
  extra: [string, 'view' | 'modify'][] = [],
  f: Partial<ScreenInput> = {},
): ScreenInput => {
  const access = new Map([...SELF, ...extra]);
  return {
    groups: new Set(['SELF', 'STAFF']),
    domains: new Set(access.keys()),
    access,
    menu: false,
    production: false,
    reports: 'mine',
    atWork: true,
    ...f,
  };
};

describe('screens', () => {
  it('a commis: their tasks, Make, their shifts and leave as the four tiles', () => {
    const t = homeTiles(input([['PRODUCTION_TEAM', 'modify']], { production: true, menu: true }));
    expect(t.map((x) => x.label)).toEqual(['My tasks', 'Make', 'My shifts', 'Leave']);
  });

  it('a server: their tasks, shifts, leave and reporting a problem', () => {
    expect(homeTiles(input()).map((x) => x.label)).toEqual([
      'My tasks',
      'My shifts',
      'Leave',
      'Report a problem',
    ]);
  });

  it("a cashier: importing the day's sales comes first (SAL-2)", () => {
    const t = homeTiles(input([['POS_IMPORT', 'modify']]));
    expect(t.map((x) => x.label)).toEqual(['Import sales', 'My tasks', 'My shifts', 'Leave']);
    expect(t[0]!.href).toBe('/menu/sales/import');
    // a server never sees it
    expect(screensFor(input()).map((s) => s.key)).not.toContain('posImport');
  });

  it('shifts, clock and swaps only for people who work at an outlet', () => {
    const away = screensFor(input([['SHIFT_SWAPS', 'modify']], { atWork: false })).map(
      (s) => s.key,
    );
    expect(away).not.toContain('shifts');
    expect(away).not.toContain('clock');
    expect(away).not.toContain('swaps');
    expect(away).toContain('roster');
    const here = screensFor(input([['SHIFT_SWAPS', 'modify']])).map((s) => s.key);
    expect(here).toEqual(expect.arrayContaining(['shifts', 'clock', 'swaps']));
    // the Team side of Roster only for roster builders
    expect(here).not.toContain('roster');
  });

  it('stock screens follow stock access; recipes without menu costs', () => {
    const keeper = screensFor(
      input(
        [
          ['STOCK_LEVELS', 'view'],
          ['STOCK_ADJUSTMENTS', 'modify'],
          ['PURCHASE_ORDERS', 'modify'],
          ['TRANSFERS', 'modify'],
          ['RECIPES', 'view'],
        ],
        { menu: true },
      ),
    );
    expect(keeper.map((s) => s.key)).toEqual(
      expect.arrayContaining(['stock', 'count', 'wastage', 'orders', 'transfers', 'menu']),
    );
    expect(keeper.find((s) => s.key === 'menu')!.label).toBe('Recipes');
    const viewer = screensFor(input([['STOCK_ADJUSTMENTS', 'view']])).map((s) => s.key);
    expect(viewer).not.toContain('count');
    expect(viewer).not.toContain('wastage');
  });

  it('business reports and admin only with access; My week for everyone else', () => {
    const owner = screensFor(
      input([['USER_ACCESS', 'modify']], { reports: 'business', atWork: false }),
    ).map((s) => s.key);
    expect(owner).toEqual(expect.arrayContaining(['reports', 'admin']));
    expect(owner).not.toContain('myWeek');
    const staff = screensFor(input()).map((s) => s.key);
    expect(staff).toContain('myWeek');
    expect(staff).not.toContain('reports');
    expect(staff).not.toContain('admin');
  });
});
