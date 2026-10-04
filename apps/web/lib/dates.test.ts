import { describe, expect, it } from 'vitest';
import {
  addDays,
  businessDate,
  daysInclusive,
  formatDay,
  formatSpan,
  isIsoDate,
  isoWeekday,
  localToday,
  localToInstant,
  weekStart,
} from './dates';

describe('people dates', () => {
  it('finds Monday weeks and weekdays', () => {
    expect(isoWeekday('2026-10-04')).toBe(7); // Sunday
    expect(weekStart('2026-10-04')).toBe('2026-09-28');
    expect(weekStart('2026-09-28')).toBe('2026-09-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('counts leave in calendar days, inclusive', () => {
    expect(daysInclusive('2026-10-01', '2026-10-01')).toBe(1);
    expect(daysInclusive('2026-10-30', '2026-11-02')).toBe(4);
  });

  it('uses the node timezone for today and times', () => {
    // 20:00 UTC on 30 Sep is 01:30 on 1 Oct in India
    expect(localToday('Asia/Kolkata', new Date('2026-09-30T20:00:00Z'))).toBe('2026-10-01');
    expect(formatSpan('2026-10-01T16:30:00Z', '2026-10-02T00:30:00Z', 'Asia/Kolkata')).toBe(
      '22:00–06:00 +1',
    );
    expect(localToInstant('2026-10-01', '09:00', 'Asia/Kolkata')).toBe('2026-10-01T03:30:00.000Z');
    expect(formatDay('2026-10-05')).toBe('Mon, 5 Oct');
  });

  it('validates ISO dates', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('28/02/2026')).toBe(false);
  });
});

describe('businessDate', () => {
  it('counts the day from 04:00: 02:00 is still the day before', () => {
    expect(businessDate('2026-10-04T10:00:00Z', 'Asia/Kolkata')).toBe('2026-10-04');
    // 02:00 IST on the 5th
    expect(businessDate('2026-10-04T20:30:00Z', 'Asia/Kolkata')).toBe('2026-10-04');
    // 04:00 IST on the 5th
    expect(businessDate('2026-10-04T22:30:00Z', 'Asia/Kolkata')).toBe('2026-10-05');
    // a stored use-by, the last instant before 04:00
    expect(businessDate('2026-10-04T22:29:59.999Z', 'Asia/Kolkata')).toBe('2026-10-04');
  });
});
