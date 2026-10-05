import { describe, expect, it } from 'vitest';
import {
  endsNextDay,
  formatDuration,
  inOutLabel,
  nextShift,
  rowTitle,
  statusLabel,
  weekStrip,
  type TimelineRow,
} from './timeline';

// Labels for My shifts and Clock (ADR 018). The rows come from hr.my_timeline; these are
// the brief's examples as the screen shows them.

const TZ = 'Asia/Kolkata';
const at = (hm: string) => `2026-10-05T${hm}:00+05:30`;
const row = (r: Partial<TimelineRow>): TimelineRow => ({
  local_date: '2026-10-05',
  kind: 'shift',
  shift_id: 's1',
  shift_start: at('08:00'),
  shift_end: at('20:00'),
  from_at: null,
  to_at: null,
  minutes: 0,
  status: null,
  late_min: null,
  early_min: null,
  role_code: 'COMMIS',
  place_name: 'Kitchen',
  ...r,
});

describe('formatDuration', () => {
  it('hours and minutes', () => {
    expect(formatDuration(134)).toBe('2 h 14 m');
    expect(formatDuration(45)).toBe('45 m');
    expect(formatDuration(480)).toBe('8 h');
    expect(formatDuration(0)).toBe('0 m');
  });
});

describe('the brief: shift 08:00–20:00', () => {
  it('worked 07:00–19:00: "07:00–08:00 extra before shift" and "08:00–19:00 shift, left 1 h early"', () => {
    const extra = row({
      kind: 'extra_before',
      from_at: at('07:00'),
      to_at: at('08:00'),
      minutes: 60,
    });
    const shift = row({
      from_at: at('08:00'),
      to_at: at('19:00'),
      minutes: 660,
      status: 'left_early',
      early_min: 60,
    });
    expect([rowTitle(extra, TZ), inOutLabel(extra, TZ)]).toEqual([
      'Extra before shift',
      'In 07:00 · Out 08:00',
    ]);
    expect([rowTitle(shift, TZ), inOutLabel(shift, TZ), statusLabel(shift)]).toEqual([
      '08:00–20:00 · Commis',
      'In 08:00 · Out 19:00',
      'Left 1 h early',
    ]);
  });

  it('worked 07:45–20:10: one row, the differences only in In/Out', () => {
    const shift = row({
      from_at: at('07:45'),
      to_at: at('20:10'),
      minutes: 745,
      status: 'on_time',
    });
    expect([inOutLabel(shift, TZ), statusLabel(shift)]).toEqual([
      'In 07:45 · Out 20:10',
      'On time',
    ]);
  });
});

describe('statuses and open sessions', () => {
  it('each status in words; late and early together', () => {
    expect(statusLabel(row({ status: 'late', late_min: 15 }))).toBe('Late 15 m');
    expect(statusLabel(row({ status: 'late', late_min: 30, early_min: 120 }))).toBe(
      'Late 30 m · left 2 h early',
    );
    expect(statusLabel(row({ status: 'no_show' }))).toBe('No-show');
    expect(statusLabel(row({ status: 'missing_clock_out' }))).toBe('Missing clock-out');
    expect(statusLabel(row({ status: 'in_progress' }))).toBe('Clocked in');
    expect(statusLabel(row({ status: 'upcoming' }))).toBeNull();
    expect(statusLabel(row({ kind: 'unrostered', status: 'unrostered' }))).toBe('Not rostered');
  });

  it('an open session has an In and no Out; a no-show has neither', () => {
    expect(inOutLabel(row({ from_at: at('07:58'), status: 'in_progress' }), TZ)).toBe(
      'In 07:58 · still in',
    );
    expect(inOutLabel(row({ status: 'no_show' }), TZ)).toBeNull();
    expect(rowTitle(row({ kind: 'unrostered', shift_id: null }), TZ)).toBe('Unrostered');
  });
});

describe('My shifts leads with the next shift (UX-9)', () => {
  it('a shift past midnight says when it ends, not "+1"', () => {
    const night = row({ shift_start: at('17:00'), shift_end: '2026-10-06T01:00:00+05:30' });
    expect(endsNextDay(night, TZ)).toBe('ends 01:00 next day');
    expect(rowTitle(night, TZ)).toBe('17:00–01:00 · Commis');
    expect(endsNextDay(row({}), TZ)).toBeNull();
  });

  it('job names read as titles: store_keeper is Store keeper', () => {
    expect(rowTitle(row({ role_code: 'store_keeper' }), TZ)).toBe('08:00–20:00 · Store keeper');
  });

  it('the next shift is the first one still to come', () => {
    const rows = [
      row({ local_date: '2026-10-04', status: 'on_time' }),
      row({ local_date: '2026-10-05', status: 'upcoming', shift_id: 'a' }),
      row({ local_date: '2026-10-06', status: 'upcoming', shift_id: 'b' }),
    ];
    expect(nextShift(rows, '2026-10-05')!.shift_id).toBe('a');
    expect(nextShift(rows.slice(0, 1), '2026-10-05')).toBeNull();
  });

  it('a week strip: seven days from today, the start time or off', () => {
    const strip = weekStrip(
      [row({ local_date: '2026-10-06', shift_start: at('17:00'), shift_end: at('23:00') })],
      '2026-10-05',
      TZ,
    );
    expect(strip).toHaveLength(7);
    expect(strip[0]).toMatchObject({ day: 'Mon', start: null, today: true });
    expect(strip[1]).toMatchObject({ day: 'Tue', start: '17:00' });
  });
});
