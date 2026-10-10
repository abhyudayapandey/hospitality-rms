import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCESS_GROUPS, ROLES, expandDuty, levelOf, type Access } from '@outlet-ops/domain';
import { navProfile, visibleNav } from './nav';
import { meTiles, screensFor, type ScreenInput } from './screens';

// Me shows each person's own tiles (ADR 106): worked out for every catalogue role, as a hotel
// (the Passport demo) gives them, from the access their duties stand for.

const PASSPORT = join(__dirname, '../../../docs/onboarding/demo/passport-hotel/06_job_roles.csv');

function inputFor(duties: readonly string[], home: string): ScreenInput {
  const groups = new Set(['SELF']);
  for (const entry of duties) {
    const [code, at] = entry.split('@');
    for (const g of expandDuty(code!, at)) groups.add(g.group);
  }
  const access = new Map<string, Access>();
  for (const g of ACCESS_GROUPS.filter((x) => groups.has(x.code))) {
    for (const [d, a] of Object.entries(g.grants)) {
      if (access.get(d) !== 'modify') access.set(d, a);
    }
  }
  // Make needs a store where something is made (core.screen_places): a kitchen's or a bar's
  const makes = ['KITCHEN', 'BAR', 'BREWHOUSE', 'CENTRAL-KITCHEN-PRODUCTION'].includes(home);
  const production =
    access.has('PRODUCTION_TEAM') || (makes && access.get('PRODUCTION') === 'modify');
  return {
    groups,
    domains: new Set(access.keys()),
    access,
    production,
    // a recipe to read: where things are made, or menu costs
    menu:
      production ||
      access.has('MENU') ||
      (makes && ['RECIPES', 'RECIPES_TEAM'].some((d) => access.has(d))),
    reports: navProfile(groups) === 'frontline' ? 'mine' : 'business',
    atWork: !['(company)', '(area)'].includes(home),
    swapsManagersOnly: true,
    breakfast: false,
  };
}

function tiles(duties: readonly string[], home = 'KITCHEN') {
  const i = inputFor(duties, home);
  const r = meTiles(i, new Set(visibleNav(i).map((n) => n.href)));
  return { mine: r.mine.map((s) => s.key), more: r.more.map((s) => s.key), i };
}

const role = (code: string) => {
  const r = ROLES.find((x) => x.code === code)!;
  return tiles(r.formatDuties?.hotel ?? r.duties, r.formatHome?.hotel ?? r.home);
};

const FIRST = ['clock', 'shifts', 'leave', 'sops', 'problem'];

describe('Me tiles per person (ADR 106)', () => {
  it("a pool attendant: his day's five, then his department's store; the rest under More", () => {
    const t = tiles(['WORKS_SHIFTS', 'USES_DEPARTMENT_STORE'], 'HOUSEKEEPING');
    expect(t.mine).toEqual([...FIRST, 'stock']);
    // what every shift worker may open is still there, folded
    expect(t.more).toEqual(
      expect.arrayContaining(['logbook', 'registers', 'breakage', 'linen', 'events', 'count']),
    );
  });

  it('a commis: Make, the recipes and opened packs', () => {
    expect(role('COMMIS').mine).toEqual([...FIRST, 'make', 'menu', 'opened']);
  });

  it('a server, a security guard: their day only', () => {
    expect(role('SERVER').mine).toEqual(FIRST);
    expect(role('SECURITY_GUARD').mine).toEqual(FIRST);
  });

  it('a room attendant: minibars and rooms; a cashier: importing sales', () => {
    expect(role('ROOM_ATTENDANT').mine).toEqual([...FIRST, 'minibar', 'rooms']);
    expect(role('CASHIER').mine).toEqual([...FIRST, 'posImport']);
  });

  it('the accountant: bills and orders; the sales manager: events (ADR 109)', () => {
    expect(role('ACCOUNTANT').mine).toEqual([...FIRST, 'orders', 'bills']);
    expect(role('SALES_MANAGER').mine).toEqual([...FIRST, 'events']);
  });

  it('a department head: training and the department’s jobs, not the stock tabs', () => {
    const t = role('EXECUTIVE_HOUSEKEEPER');
    expect(t.mine).toEqual(expect.arrayContaining(['minibar', 'rooms', 'training', 'audits']));
    for (const k of ['count', 'wastage', 'orders', 'transfers', 'bills']) {
      expect(t.mine).not.toContain(k);
    }
  });

  it('every role: Me loses nothing, and someone who works has a short list', () => {
    const passport = readFileSync(PASSPORT, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split(','));
    const rows = [
      ...ROLES.map((r) => ({
        code: r.code,
        duties: r.formatDuties?.hotel ?? r.duties,
        home: r.formatHome?.hotel ?? r.home,
      })),
      // the demo's own rows (duties written out) as the hotel loads them
      ...passport
        .filter((c) => c[4])
        .map((c) => ({ code: c[0]!, duties: c[4]!.split(';').map((d) => d.trim()), home: c[3]! })),
    ];
    for (const r of rows) {
      const t = tiles(r.duties, r.home);
      const nav = new Set(visibleNav(t.i).map((n) => n.href));
      const all = screensFor(t.i)
        .filter((s) => !nav.has(s.href))
        .map((s) => s.key);
      expect([...t.mine, ...t.more].sort(), r.code).toEqual([...all].sort());
      expect(new Set([...t.mine, ...t.more]).size, r.code).toBe(all.length);
      if (levelOf(r.duties) === 'works') {
        expect(t.mine.length, `${r.code}: ${t.mine.join(', ')}`).toBeLessThanOrEqual(9);
      }
    }
  });
});

describe('tile pictures (ADR 106)', () => {
  it('no two tiles share an icon', () => {
    const everything: ScreenInput = {
      ...inputFor(['RUNS_OUTLET', 'WORKS_SHIFTS', 'UPLOADS_POS_SALES', 'OPENS_PACKS'], '(outlet)'),
      production: true,
      menu: true,
      breakfast: true,
      reports: 'mine',
    };
    const shown = [
      ...screensFor(everything),
      ...screensFor({ ...everything, reports: 'business', atWork: false }),
      ...screensFor({
        ...inputFor(['WORKS_SHIFTS', 'OPENS_PACKS'], 'KITCHEN'),
        breakfast: true,
      }),
    ];
    const byKey = new Map(shown.map((s) => [s.key, s.icon]));
    const icons = [...byKey.values()];
    expect(byKey.size).toBeGreaterThan(38);
    expect(new Set(icons).size, [...byKey].map(([k, v]) => `${k}:${v}`).join(' ')).toBe(
      icons.length,
    );
  });
});
