import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCESS_GROUPS, ROLES, expandDuty, levelOf, type Access } from '@outlet-ops/domain';
import { navProfile, visibleNav } from './nav';
import { meGroups, meTiles, screensFor, type ScreenInput } from './screens';

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
    // a recipe to read: only those who hold a recipe or menu grant (ADR 123); a cook reads
    // the recipe of a prep task on the task
    menu: ['MENU', 'DERIVED_MENU', 'RECIPES', 'RECIPES_TEAM'].some((d) => access.has(d)),
    reports: navProfile(groups) === 'frontline' ? 'mine' : 'business',
    atWork: !['(company)', '(area)'].includes(home),
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

// after their own work: their day (ADR 113)
const DAY = ['shifts', 'sops', 'problem'];

describe('Me tiles per person (ADR 106)', () => {
  it("a pool attendant: his department's store, then his day, then the rest", () => {
    const t = tiles(['WORKS_SHIFTS', 'USES_DEPARTMENT_STORE'], 'HOUSEKEEPING');
    expect(t.mine).toEqual(['stock', ...DAY]);
    // what every shift worker may open follows, shown too (ADR 125)
    expect(t.more).toEqual(expect.arrayContaining(['logbook', 'registers', 'events', 'count']));
  });

  it('a commis: Make, opened packs, linen and breakage; no recipes (ADR 123)', () => {
    expect(role('COMMIS').mine).toEqual(['make', 'opened', 'linen', 'breakage', ...DAY]);
  });

  it('a server: linen and breakage, then their day; a security guard: their day only', () => {
    expect(role('SERVER').mine).toEqual(['linen', 'breakage', ...DAY]);
    expect(role('SECURITY_GUARD').mine).toEqual(DAY);
  });

  it('a room attendant: rooms and minibars first; a cashier: importing sales', () => {
    expect(role('ROOM_ATTENDANT').mine).toEqual(['rooms', 'minibar', 'linen', 'breakage', ...DAY]);
    expect(role('CASHIER').mine).toEqual(['posImport', ...DAY]);
  });

  it('the accountant: bills and orders; the sales manager: events (ADR 109)', () => {
    expect(role('ACCOUNTANT').mine).toEqual(['orders', 'bills', ...DAY]);
    expect(role('SALES_MANAGER').mine).toEqual(['events', ...DAY]);
  });

  it('a department head: training and the department’s jobs, not the stock tabs', () => {
    const t = role('EXECUTIVE_HOUSEKEEPER');
    expect(t.mine).toEqual(expect.arrayContaining(['minibar', 'rooms', 'training', 'audits']));
    // the department's work first (ADR 113), reading the sales folded away
    expect(t.mine.slice(0, 2)).toEqual(['rooms', 'minibar']);
    expect(t.mine).not.toContain('sales');
    for (const k of ['count', 'wastage', 'orders', 'bills']) {
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
      // every screen but Swaps, which is in Roster and Shifts & leave (ADR 164)
      const all = screensFor(t.i)
        .filter((s) => !nav.has(s.href) && s.key !== 'swaps')
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
    expect(byKey.size).toBeGreaterThan(36);
    expect(new Set(icons).size, [...byKey].map(([k, v]) => `${k}:${v}`).join(' ')).toBe(
      icons.length,
    );
  });
});

describe('Me under headings (ADR 132)', () => {
  const groups = (code: string) => {
    const r = ROLES.find((x) => x.code === code)!;
    const i = inputFor(r.formatDuties?.hotel ?? r.duties, r.formatHome?.hotel ?? r.home);
    return meGroups(i, new Set(visibleNav(i).map((n) => n.href)));
  };

  it('the GM: My work, My day, Team, Admin; every tile once, in the same order as before', () => {
    const r = ROLES.find((x) => x.code === 'GENERAL_MANAGER')!;
    const i = inputFor(r.formatDuties?.hotel ?? r.duties, r.formatHome?.hotel ?? r.home);
    const hide = new Set(visibleNav(i).map((n) => n.href));
    const g = meGroups(i, hide);
    expect(g.map((x) => x.title).slice(0, 4)).toEqual(['My work', 'My day', 'Team', 'Admin']);
    const keys = g.flatMap((x) => x.screens.map((s) => s.key));
    const { mine, more } = meTiles(i, hide);
    expect([...keys].sort()).toEqual([...mine, ...more].map((s) => s.key).sort());
    expect(new Set(keys).size).toBe(keys.length);
    const of = (title: string) => g.find((x) => x.title === title)!.screens.map((s) => s.key);
    expect(of('My day')).toEqual(expect.arrayContaining(['shifts', 'sops', 'problem']));
    expect(of('Team')).toContain('roster');
    expect(of('Admin')).toEqual(expect.arrayContaining(['compliance', 'audits']));
    expect(of('My work')).toEqual(expect.arrayContaining(['rooms', 'stock']));
  });

  it('no one has a Swaps tile on Me: it is in Roster and Shifts & leave (ADR 164)', () => {
    for (const r of ROLES) {
      const keys = groups(r.code).flatMap((g) => g.screens.map((s) => s.key));
      expect(keys, r.code).not.toContain('swaps');
    }
  });

  it('the cost controller keeps the excise register under My work, not Admin (ADR 164)', () => {
    const g = groups('COST_CONTROLLER');
    const of = (title: string) => g.find((x) => x.title === title)?.screens.map((s) => s.key) ?? [];
    expect(of('My work')).toContain('excise');
    expect(of('Admin')).not.toContain('excise');
  });

  it('a server: their work and their day first, no Team or Admin heading', () => {
    const titles = groups('SERVER').map((x) => x.title);
    expect(titles.slice(0, 2)).toEqual(['My work', 'My day']);
    expect(titles).not.toContain('Team');
    expect(titles).not.toContain('Admin');
  });
});
