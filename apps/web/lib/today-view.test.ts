import { describe, expect, it } from 'vitest';
import {
  clockable,
  doFirst,
  attentionGroups,
  currentShift,
  shiftLine,
  todaysTasks,
  type PlaceDepartment,
} from './today-view';

const TZ = 'Asia/Kolkata';
// 2 Oct 2026, 10:00 in Kolkata
const NOW = new Date('2026-10-02T04:30:00Z');

describe('todaysTasks', () => {
  const t = (id: string, due: string, overdue = false) => ({
    id,
    title: id,
    due_at: new Date(due),
    overdue,
    place_name: 'Kitchen',
  });
  it('overdue first, then due today; not tomorrow; at most three', () => {
    const r = todaysTasks(
      [
        t('later-today', '2026-10-02T12:00:00Z'),
        t('tomorrow', '2026-10-03T05:00:00Z'),
        t('overdue', '2026-10-01T05:00:00Z', true),
        t('earlier-today', '2026-10-02T03:00:00Z'),
        t('evening', '2026-10-02T14:00:00Z'),
      ],
      NOW,
      TZ,
    );
    expect(r.shown.map((x) => x.id)).toEqual(['overdue', 'earlier-today', 'later-today']);
    expect(r.total).toBe(4);
  });
});

describe('currentShift and shiftLine', () => {
  const s = (start: string, end: string) => ({
    start_at: new Date(start),
    end_at: new Date(end),
    node_name: 'Kitchen',
  });
  it('the shift on now, else the next within 24 hours', () => {
    const on = s('2026-10-02T00:30:00Z', '2026-10-02T08:30:00Z');
    const next = s('2026-10-02T16:30:00Z', '2026-10-03T00:30:00Z');
    expect(currentShift([next, on], NOW)).toBe(on);
    expect(currentShift([next], NOW)).toBe(next);
    expect(currentShift([s('2026-10-04T00:30:00Z', '2026-10-04T08:30:00Z')], NOW)).toBeNull();
    expect(currentShift([s('2026-10-01T00:30:00Z', '2026-10-01T08:30:00Z')], NOW)).toBeNull();
  });
  it('reads as today or tomorrow, with the place', () => {
    expect(shiftLine(s('2026-10-02T00:30:00Z', '2026-10-02T08:30:00Z'), NOW, TZ)).toBe(
      'Today 06:00–14:00 · Kitchen',
    );
    expect(shiftLine(s('2026-10-02T19:30:00Z', '2026-10-03T03:30:00Z'), NOW, TZ)).toBe(
      'Tomorrow 01:00–09:00 · Kitchen',
    );
  });
});

describe('attentionGroups (DB-2)', () => {
  const o = 'Test Hotel & Bar 1.0';
  const place = (
    node: string,
    department: string | null,
    rank: number,
    outlet = o,
    outletId = 'o1',
  ): PlaceDepartment => ({
    node_id: node,
    department_id: department ? `d-${outlet}-${department}` : null,
    department: department ? `${outlet} – ${department}` : null,
    rank,
    outlet_id: outletId,
    outlet,
  });
  const places = [
    place('kitchen-store', 'Kitchen', 1),
    place('kitchen', 'Kitchen', 1),
    place('restaurant', 'Restaurant', 2),
    place('bar-store', 'Bar', 2),
    place('hk', 'Housekeeping', 3),
    place('security', 'Security', 4),
    place('outlet', null, 5),
  ];

  it('Kitchen, then service, then housekeeping, then the rest; the outlet itself last', () => {
    const g = attentionGroups(
      [
        { kind: 'flags', node: 'outlet', n: 2 },
        { kind: 'flags', node: 'security', n: 1 },
        { kind: 'repairs', node: 'hk', n: 1 },
        { kind: 'flags', node: 'restaurant', n: 3 },
        { kind: 'lowStock', node: 'bar-store', n: 4 },
        { kind: 'flags', node: 'kitchen', n: 1 },
        { kind: 'lowStock', node: 'kitchen-store', n: 5 },
      ],
      places,
    );
    expect(g.map((x) => x.label)).toEqual([
      'Kitchen',
      'Bar',
      'Restaurant',
      'Housekeeping',
      'Security',
      'Whole outlet',
    ]);
    // a store's counts go to the department it serves; lines in a fixed order
    expect(g[0]!.lines).toEqual([
      { kind: 'lowStock', href: '/stock?all=1&tab=low', n: 5, text: 'items running low' },
      { kind: 'flags', href: '/roster/exceptions?all=1', n: 1, text: 'attendance issue' },
    ]);
    // low stock is red; flags and repairs amber (UX-6)
    expect(g.map((x) => [x.label, x.tone, x.total])).toEqual([
      ['Kitchen', 'bad', 6],
      ['Bar', 'bad', 4],
      ['Restaurant', 'warn', 3],
      ['Housekeeping', 'warn', 1],
      ['Security', 'warn', 1],
      ['Whole outlet', 'warn', 2],
    ]);
  });

  it('open slots link to the first day that has one; zero counts are left out', () => {
    const href = '/roster/week?node=k&week=2026-10-05&day=2026-10-06';
    const g = attentionGroups(
      [
        { kind: 'openSlots', node: 'kitchen', n: 4, href },
        { kind: 'openSlots', node: 'kitchen', n: 1, href: '/later' },
        { kind: 'repairs', node: 'hk', n: 0 },
      ],
      places,
    );
    expect(g).toEqual([
      {
        key: 'd-Test Hotel & Bar 1.0-Kitchen',
        label: 'Kitchen',
        lines: [{ kind: 'openSlots', href, n: 5, text: 'open shifts this week' }],
        total: 5,
        tone: 'warn',
      },
    ]);
    expect(attentionGroups([], places)).toEqual([]);
  });

  it('across outlets the outlet stays in the name', () => {
    const g = attentionGroups(
      [
        { kind: 'flags', node: 'k2', n: 1 },
        { kind: 'flags', node: 'kitchen', n: 1 },
        { kind: 'flags', node: 'o2', n: 1 },
      ],
      [
        ...places,
        place('k2', 'Kitchen', 1, 'Test Bar 3.0', 'o2'),
        place('o2', null, 5, 'Test Bar 3.0', 'o2'),
      ],
    );
    expect(g.map((x) => x.label)).toEqual([
      'Test Bar 3.0 – Kitchen',
      'Test Hotel & Bar 1.0 – Kitchen',
      'Test Bar 3.0',
    ]);
  });
});

describe('clockable: Clock in only near a shift (UX-9)', () => {
  const s = (start: string, end: string) => ({
    start_at: new Date(start),
    end_at: new Date(end),
    node_name: 'Kitchen',
  });
  it('on now, or starting within two hours: yes', () => {
    expect(clockable(s('2026-10-02T00:30:00Z', '2026-10-02T08:30:00Z'), NOW)).toBe(true);
    expect(clockable(s('2026-10-02T06:00:00Z', '2026-10-02T14:00:00Z'), NOW)).toBe(true);
  });
  it('tomorrow, or later today: no; already over: no', () => {
    expect(clockable(s('2026-10-02T16:30:00Z', '2026-10-03T00:30:00Z'), NOW)).toBe(false);
    expect(clockable(s('2026-10-03T00:30:00Z', '2026-10-03T08:30:00Z'), NOW)).toBe(false);
    expect(clockable(s('2026-10-01T20:00:00Z', '2026-10-02T04:00:00Z'), NOW)).toBe(false);
  });
});

describe('doFirst: the ranked list (UX-8)', () => {
  const group = (key: string, lines: [string, number][]) => ({
    key,
    label: key,
    total: lines.reduce((t, [, n]) => t + n, 0),
    tone: 'warn' as const,
    lines: lines.map(([kind, n]) => ({
      kind: kind as 'lowStock' | 'flags' | 'repairs' | 'openSlots',
      href: `/${kind}`,
      text: '',
      n,
    })),
  });
  const attention = [
    group('Kitchen', [
      ['lowStock', 5],
      ['flags', 40],
    ]),
    group('Bar', [
      ['lowStock', 4],
      ['openSlots', 2],
      ['repairs', 1],
    ]),
  ];

  it('adds up over the departments, red first, one line per kind', () => {
    const d = doFirst({ attention, overdueTasks: 3, toAssign: 2 });
    expect(d.map((x) => x.key)).toEqual(['lowStock', 'overdue', 'openSlots', 'flags', 'repairs']);
    expect(d[0]).toMatchObject({ n: 9, text: 'items running low', tone: 'bad' });
    expect(d[1]!.text).toBe('tasks are late');
  });

  it('never more than five, and says "1 repair", not "1 repairs"', () => {
    expect(doFirst({ attention, overdueTasks: 3, toAssign: 2 })).toHaveLength(5);
    const one = doFirst({
      attention: [group('x', [['repairs', 1]])],
      overdueTasks: 0,
      toAssign: 0,
    });
    expect(one).toEqual([expect.objectContaining({ key: 'repairs', text: 'open repair' })]);
  });

  it('nothing to do: an empty list', () => {
    expect(doFirst({ attention: null, overdueTasks: 0, toAssign: 0 })).toEqual([]);
  });

  it('an open slot opens the roster day it is on', () => {
    const a = [group('x', [['openSlots', 1]])];
    expect(
      doFirst({
        attention: a,
        overdueTasks: 0,
        toAssign: 0,
        openSlotsHref: '/roster/week?all=1&week=2026-10-05&day=2026-10-06',
      })[0]!.href,
    ).toBe('/roster/week?all=1&week=2026-10-05&day=2026-10-06');
  });
});

describe('every count that spans places opens its screen with All chosen (ADR 048)', () => {
  const line = (kind: 'lowStock' | 'flags' | 'repairs' | 'openSlots') => ({
    kind,
    href: '',
    text: '',
    n: 1,
  });
  const group = (kinds: ('lowStock' | 'flags' | 'repairs' | 'openSlots')[]) => ({
    key: 'k',
    label: 'Kitchen',
    total: kinds.length,
    tone: 'warn' as const,
    lines: kinds.map(line),
  });

  it('Home links: low stock, attendance, repairs, open shifts', () => {
    const items = doFirst({
      attention: [group(['lowStock', 'flags', 'repairs', 'openSlots'])],
      overdueTasks: 0,
      toAssign: 0,
    });
    const href = Object.fromEntries(items.map((x) => [x.key, x.href]));
    expect(href).toMatchObject({
      lowStock: '/stock?all=1&tab=low',
      flags: '/roster/exceptions?all=1',
      repairs: '/tasks/maintenance?all=1&tab=assign',
      openSlots: '/roster/week?all=1',
    });
  });

  it('one repairs line, tagged Assign; expired items to assign are their own line', () => {
    const items = doFirst({ attention: [group(['repairs'])], overdueTasks: 0, toAssign: 2 });
    expect(items.map((x) => [x.key, x.text, x.action])).toEqual([
      ['repairs', 'open repair', 'Assign'],
      ['toAssign', 'expired items to assign', 'Assign'],
    ]);
  });
});
