import { describe, expect, it } from 'vitest';
import { formatWhen, portionsText } from './format';

describe('formatWhen', () => {
  const now = new Date('2026-10-02T12:00:00Z'); // 17:30 in Kolkata
  it('says today and yesterday in the outlet’s business day, then the date, on a 24-hour clock', () => {
    expect(formatWhen('2026-10-02T09:24:00Z', now)).toBe('today, 14:54');
    expect(formatWhen('2026-10-01T03:40:00Z', now)).toBe('yesterday, 09:10');
    expect(formatWhen('2026-09-28T03:40:00Z', now)).toBe('28 Sept, 09:10');
    expect(formatWhen('2026-10-03T01:30:00Z', now)).toBe('tomorrow, 07:00');
    // 23:30 UTC on 1 Oct is 05:00 on 2 Oct in Kolkata: today
    expect(formatWhen('2026-10-01T23:30:00Z', now)).toBe('today, 05:00');
    // 02:00 on 2 Oct in Kolkata is still the business day of 1 Oct
    expect(formatWhen('2026-10-01T20:30:00Z', now)).toBe('yesterday, 02:00');
    // read at 01:00 on 3 Oct, 23:00 on 2 Oct is still today
    expect(formatWhen('2026-10-02T17:30:00Z', new Date('2026-10-02T19:30:00Z'))).toBe(
      'today, 23:00',
    );
  });
});

describe('portionsText', () => {
  it('says how many portions, at most one decimal', () => {
    expect(portionsText('50')).toBe('50 portions');
    expect(portionsText(1)).toBe('1 portion');
    expect(portionsText('12.54')).toBe('12.5 portions');
    expect(portionsText('1200')).toBe('1,200 portions');
  });
});
