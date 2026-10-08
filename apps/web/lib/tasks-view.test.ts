import { describe, expect, it } from 'vitest';
import {
  describeSchedule,
  groupTasks,
  myTaskWho,
  outOfRange,
  overdueWhenGiven,
  parseSteps,
  progress,
  stepsText,
  teamWho,
} from './tasks-view';

describe('my tasks grouping', () => {
  it('puts overdue first, then today, coming up and done (in local days)', () => {
    const now = new Date('2026-10-02T12:00:00Z'); // 17:30 in Kolkata
    const g = groupTasks(
      [
        { id: 'a', title: 'A', due_at: '2026-10-02T10:00:00Z', status: 'open', overdue: true },
        // 23:00 IST today
        { id: 'b', title: 'B', due_at: '2026-10-02T17:30:00Z', status: 'open', overdue: false },
        // 00:30 IST tomorrow
        {
          id: 'c',
          title: 'C',
          due_at: '2026-10-02T19:00:00Z',
          status: 'in_progress',
          overdue: false,
        },
        { id: 'd', title: 'D', due_at: '2026-10-01T10:00:00Z', status: 'done', overdue: false },
      ],
      'Asia/Kolkata',
      now,
    );
    expect(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((t) => t.id)]))).toEqual({
      overdue: ['a'],
      today: ['b'],
      upcoming: ['c'],
      done: ['d'],
    });
  });
});

describe('checklist schedules', () => {
  it('reads as a sentence', () => {
    expect(describeSchedule({ kind: 'daily', times: ['07:00', '15:00'] })).toBe(
      'Daily at 07:00 and 15:00',
    );
    expect(describeSchedule({ kind: 'weekly', weekdays: [1, 4], times: ['09:00'] })).toBe(
      'Mon and Thu at 09:00',
    );
    expect(describeSchedule({ kind: 'every_n_hours', every: 2, from: '08:00', to: '22:00' })).toBe(
      'Every 2 hours, 08:00 to 22:00',
    );
    expect(describeSchedule({ kind: 'every_n_hours', every: 1, from: '22:00', to: '06:00' })).toBe(
      'Every hour, 22:00 to 06:00',
    );
  });
});

describe('steps editor', () => {
  it('reads one step per line: ticks, ranges, text and photos', () => {
    expect(
      parseSteps(
        'Wipe shelves\nFridge 1 | 0-5 °C\nFreezer | -22 to -18 °C\nNotes | text\n\nShelf | photo\nFloor | photo required\nCount | number\nPH | 6.5-',
      ),
    ).toEqual([
      { label: 'Wipe shelves', kind: 'tick' },
      { label: 'Fridge 1', kind: 'number', min: 0, max: 5, unit: '°C' },
      { label: 'Freezer', kind: 'number', min: -22, max: -18, unit: '°C' },
      { label: 'Notes', kind: 'text' },
      { label: 'Shelf', kind: 'photo' },
      { label: 'Floor', kind: 'tick', photo_required: true },
      { label: 'Count', kind: 'number' },
      { label: 'PH', kind: 'number', min: 6.5, max: null, unit: null },
    ]);
  });

  it('explains a line it cannot read', () => {
    expect(parseSteps('Fridge | warm')).toMatch(/^Line 1: after \|/);
    expect(parseSteps('ok\nFridge | 5-0 °C')).toMatch(/^Line 2: the lowest/);
    expect(parseSteps(' | text')).toMatch(/needs a name/);
    expect(parseSteps(Array.from({ length: 31 }, (_, i) => `s${i}`).join('\n'))).toBe(
      'Up to 30 steps.',
    );
  });

  it('writes steps back as the same text', () => {
    const text =
      'Wipe shelves\nFridge 1 | 0-5 °C\nNotes | text\nShelf | photo\nFloor | photo required';
    const steps = parseSteps(text);
    expect(typeof steps).not.toBe('string');
    expect(stepsText(steps as Exclude<typeof steps, string>)).toBe(text);
  });

  it('warns on readings outside the range and shows progress', () => {
    expect(outOfRange(6, 0, 5)).toBe(true);
    expect(outOfRange(-1, 0, null)).toBe(true);
    expect(outOfRange(3, 0, 5)).toBe(false);
    expect(outOfRange(3)).toBe(false);
    expect(progress(3, 4)).toEqual({ text: '3 of 4', pct: 75 });
    expect(progress(0, 0)).toEqual({ text: '0 of 0', pct: 0 });
  });
});

describe('who has a task and when it reached them (ADR 074)', () => {
  it('my tasks: mine, from whom, or my job role or shift before anyone takes it', () => {
    expect(myTaskWho({ taken: true, assign_mode: 'person', assigned_by_name: null })).toBe('You');
    expect(
      myTaskWho({ taken: true, assign_mode: 'person', assigned_by_name: 'Maria Rodrigues' }),
    ).toBe('You, from Maria Rodrigues');
    expect(myTaskWho({ taken: false, assign_mode: 'job_role', assigned_by_name: null })).toBe(
      'Your job role: the first to start takes it',
    );
    expect(myTaskWho({ taken: false, assign_mode: 'on_shift', assigned_by_name: null })).toBe(
      'Whoever is on shift',
    );
  });

  it("a manager's list: You for their own, else the name, else the job role", () => {
    const row = { assignee_user_id: 'u1', assignee_name: 'Pooja Gaonkar', pool: null };
    expect(teamWho(row, 'u1')).toBe('You');
    expect(teamWho(row, 'u2')).toBe('Pooja Gaonkar');
    expect(
      teamWho({ assignee_user_id: null, assignee_name: null, pool: 'Executive Housekeeper' }, 'u1'),
    ).toBe('Executive Housekeeper');
  });

  it('overdue when given: it reached them after it was due', () => {
    const due = '2026-10-05T04:30:00Z';
    expect(overdueWhenGiven({ due_at: due, given: '2026-10-07T13:10:00Z' })).toBe(true);
    expect(overdueWhenGiven({ due_at: due, given: '2026-10-01T09:00:00Z' })).toBe(false);
    expect(overdueWhenGiven({ due_at: due, given: null })).toBe(false);
  });
});
