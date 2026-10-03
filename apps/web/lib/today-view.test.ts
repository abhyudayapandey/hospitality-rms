import { describe, expect, it } from 'vitest';
import {
  attentionGroups,
  currentShift,
  shiftLine,
  splitShortcuts,
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

describe('splitShortcuts', () => {
  it('four on the card, the rest under All screens, no duplicates', () => {
    const r = splitShortcuts([
      { href: '/a', label: 'A' },
      { href: '/b', label: 'B' },
      { href: '/a', label: 'A again' },
      { href: '/c', label: 'C' },
      { href: '/d', label: 'D' },
      { href: '/e', label: 'E' },
    ]);
    expect(r.shortcuts.map((s) => s.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(r.rest.map((s) => s.label)).toEqual(['E']);
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
        { kind: 'belowPar', node: 'bar-store', n: 4 },
        { kind: 'flags', node: 'kitchen', n: 1 },
        { kind: 'belowPar', node: 'kitchen-store', n: 5 },
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
      { href: '/stock', n: 5, text: 'items below par' },
      { href: '/roster/exceptions', n: 1, text: 'attendance flag' },
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
        lines: [{ href, n: 5, text: 'open slots this week' }],
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
