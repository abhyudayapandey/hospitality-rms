import { describe, expect, it } from 'vitest';
import { attentionLines, currentShift, shiftLine, splitShortcuts, todaysTasks } from './today-view';

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

describe('attentionLines', () => {
  it('only lines with something in them, in plain words', () => {
    const none = { belowPar: 0, flags: 0, repairs: 0, openSlots: 0, openSlotHref: null };
    expect(attentionLines({ ...none, belowPar: 3, repairs: 1 })).toEqual([
      { href: '/stock', n: 3, text: 'items below par' },
      { href: '/tasks/maintenance', n: 1, text: 'open repair' },
    ]);
    expect(attentionLines(none)).toEqual([]);
  });
  it('open slots link to the first day that has one', () => {
    const none = { belowPar: 0, flags: 0, repairs: 0, openSlots: 0, openSlotHref: null };
    const href = '/roster/week?node=n1&week=2026-10-05&day=2026-10-06';
    expect(attentionLines({ ...none, openSlots: 4, openSlotHref: href })).toEqual([
      { href, n: 4, text: 'open slots this week' },
    ]);
  });
});
