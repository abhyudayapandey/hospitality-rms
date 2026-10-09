import { describe, expect, it } from 'vitest';
import { formatWhen, portionsText } from './format';

describe('formatWhen', () => {
  const now = new Date('2026-10-02T12:00:00Z'); // 17:30 in Kolkata
  it('says today and yesterday in the outlet’s day, then the date', () => {
    expect(formatWhen('2026-10-02T09:24:00Z', now)).toBe('today, 2:54 pm');
    expect(formatWhen('2026-10-01T03:40:00Z', now)).toBe('yesterday, 9:10 am');
    expect(formatWhen('2026-09-28T03:40:00Z', now)).toBe('28 Sept, 9:10 am');
    // 23:30 UTC on 1 Oct is already 2 Oct in Kolkata
    expect(formatWhen('2026-10-01T23:30:00Z', now)).toBe('today, 5:00 am');
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
