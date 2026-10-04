import { describe, expect, it } from 'vitest';
import { groupNotifications, type NotificationRow, unreadLines } from './notifications-view';

const n = (
  id: string,
  kind: string,
  title: string,
  at: string,
  read = false,
  link: string | null = null,
): NotificationRow => ({
  id,
  kind,
  title,
  body: null,
  link,
  read_at: read ? at : null,
  created_at: at,
});

describe('grouped notifications (U-21)', () => {
  it('one kind on one day becomes one line; a single one stays as it is', () => {
    const g = groupNotifications(
      [
        n('1', 'task_assigned', 'New task: Make Mint Chutney 500 g', '2026-10-03T04:00:00Z'),
        n('2', 'task_assigned', 'New task: Deep clean the chiller', '2026-10-03T05:00:00Z', true),
        n('3', 'task_assigned', 'New task: Descale the oven', '2026-10-03T06:00:00Z'),
        n('4', 'roster_published', 'Your roster is published', '2026-10-03T07:00:00Z', true),
        n('5', 'roster_published', 'Your roster is published', '2026-10-03T07:01:00Z', true),
        n('6', 'maintenance_raised', 'Maintenance: Fridge', '2026-10-03T03:00:00Z', false, '/x'),
      ],
      'Asia/Kolkata',
    );
    expect(g.map((x) => [x.title, x.count, x.unread])).toEqual([
      ['Roster published for 2 weeks', 2, false],
      ['3 new tasks', 3, true],
      ['Maintenance: Fridge', 1, true],
    ]);
    expect(g[1]!.body).toBe('Descale the oven · Deep clean the chiller · Make Mint Chutney 500 g');
    expect(g[1]!.link).toBe('/tasks');
    expect(g[2]!.link).toBe('/x');
  });

  it('different days stay apart (local time)', () => {
    const g = groupNotifications(
      [
        // 23:00 and 01:00 Kolkata on different days
        n('1', 'task_assigned', 'New task: A', '2026-10-02T17:30:00Z'),
        n('2', 'task_assigned', 'New task: B', '2026-10-02T19:30:00Z'),
      ],
      'Asia/Kolkata',
    );
    expect(g.map((x) => x.title)).toEqual(['New task: B', 'New task: A']);
  });

  it('an unknown kind still groups, and long lists say how many more', () => {
    const rows = ['A', 'B', 'C', 'D', 'E'].map((t, i) =>
      n(String(i), 'something_new', `Thing: ${t}`, `2026-10-03T0${i}:00:00Z`),
    );
    const [g] = groupNotifications(rows, 'Asia/Kolkata');
    expect(g!.title).toBe('5 × Thing: E');
    expect(g!.body).toBe('Thing: E · Thing: D · Thing: C · 2 more');
  });

  it('the bell counts the unread lines shown, not the notifications behind them', () => {
    const rows = [
      // the server's Home: two weeks of roster are one line
      n('1', 'roster_published', 'Your roster is published', '2026-10-02T00:00:00Z'),
      n('2', 'roster_published', 'Your roster is published', '2026-10-02T00:00:00Z'),
      n('3', 'task_assigned', 'New task: Wipe down the menu cards', '2026-10-02T09:34:00Z'),
      n('4', 'task_due_soon', 'Due soon: Wipe down the menu cards', '2026-10-03T11:30:00Z'),
      n('5', 'task_overdue', 'Overdue: Old', '2026-10-01T11:30:00Z', true),
    ];
    expect(unreadLines(rows, 'Asia/Kolkata')).toBe(3);
  });
});
