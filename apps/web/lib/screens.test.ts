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
  it('a commis: Make and the recipes, then Shifts & leave and Report a problem (ADR 113)', () => {
    const t = homeTiles(input([['PRODUCTION_TEAM', 'modify']], { production: true, menu: true }));
    expect(t.map((x) => x.label)).toEqual([
      'Make',
      'Recipes',
      'Shifts & leave',
      'Report a problem',
    ]);
  });

  it('a server: Shifts & leave and reporting a problem; their tasks are the Tasks tab', () => {
    expect(homeTiles(input()).map((x) => x.label)).toEqual(['Shifts & leave', 'Report a problem']);
  });

  it('a room attendant: rooms and minibars first', () => {
    const t = homeTiles(
      input([
        ['ROOMS', 'modify'],
        ['MINIBAR', 'modify'],
      ]),
    );
    expect(t.map((x) => x.key)).toEqual(['rooms', 'minibar', 'shifts', 'problem']);
  });

  it("a cashier: the day's import is its own card on Home, never a tile too (SAL-2)", () => {
    const t = homeTiles(input([['POS_IMPORT', 'modify']]));
    expect(t.map((x) => x.key)).not.toContain('posImport');
    expect(screensFor(input([['POS_IMPORT', 'modify']])).map((s) => s.key)).toContain('posImport');
    // a server never sees it
    expect(screensFor(input()).map((s) => s.key)).not.toContain('posImport');
  });

  it('one Shifts & leave tile where they work shifts; Clock and Leave are its tabs', () => {
    const keys = screensFor(input()).map((s) => s.key);
    expect(keys).toContain('shifts');
    expect(keys).not.toContain('clock');
    expect(keys).not.toContain('leave');
    // away from an outlet: leave alone
    const away = screensFor(input([], { atWork: false })).map((s) => s.key);
    expect(away).toContain('leave');
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
    expect(here).toEqual(expect.arrayContaining(['shifts', 'swaps']));
    // the Team side of Roster only for roster builders
    expect(here).not.toContain('roster');
  });

  it('swaps for management only (SW-4): no Swaps for staff, Swaps for roster builders', () => {
    const staff = screensFor(input([['SHIFT_SWAPS', 'modify']], { swapsManagersOnly: true }));
    expect(staff.map((s) => s.key)).not.toContain('swaps');
    const lead = screensFor(
      input(
        [
          ['SHIFT_SWAPS', 'modify'],
          ['ROSTER', 'modify'],
        ],
        { swapsManagersOnly: true },
      ),
    );
    expect(lead.map((s) => s.key)).toContain('swaps');
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
