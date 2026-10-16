import { describe, expect, it } from 'vitest';
import { dayToIso, isTime, isoToDay, typedDay, typedTime } from './date-time-inputs';

// Days as dd/mm/yyyy and times on the 24-hour clock, whatever the phone's language (ADR 162).

describe('a day typed as dd/mm/yyyy', () => {
  it('reads and writes the day the form sends', () => {
    expect(isoToDay('2026-10-16')).toBe('16/10/2026');
    expect(dayToIso('16/10/2026')).toBe('2026-10-16');
    expect(dayToIso('2026-10-16')).toBe('2026-10-16');
    expect(dayToIso('6/1/2027')).toBe('2027-01-06');
  });
  it('refuses a day that is not real', () => {
    expect(dayToIso('31/02/2026')).toBeNull();
    expect(dayToIso('16/13/2026')).toBeNull();
    expect(dayToIso('16/10')).toBeNull();
  });
  it('puts in the slashes on a number pad', () => {
    expect(typedDay('16')).toBe('16');
    expect(typedDay('161')).toBe('16/1');
    expect(typedDay('16102026')).toBe('16/10/2026');
    expect(typedDay('2026-10-16')).toBe('16/10/2026');
  });
});

describe('a time on the 24-hour clock', () => {
  it('puts in the colon and keeps 11:00 as it is', () => {
    expect(typedTime('1430')).toBe('14:30');
    expect(typedTime('11:00')).toBe('11:00');
    expect(typedTime('9')).toBe('9');
  });
  it('knows a real time', () => {
    expect(isTime('23:59')).toBe(true);
    expect(isTime('00:00')).toBe(true);
    expect(isTime('24:00')).toBe(false);
    expect(isTime('9:30')).toBe(false);
  });
});
