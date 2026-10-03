import { describe, expect, it } from 'vitest';
import { countDue, countDueText, hubActions } from './stock-hub';

const NOW = new Date('2026-10-03T10:00:00Z');

describe('countDue', () => {
  it('is due when the store has never been counted', () => {
    expect(countDue(null, 7, NOW)).toEqual({ due: true, days: null });
    expect(countDueText(countDue(null, 7, NOW))).toBe('Never counted here');
  });
  it('is due on the day the interval runs out, not before', () => {
    expect(countDue('2026-09-27T09:00:00Z', 7, NOW)).toEqual({ due: false, days: 6 });
    expect(countDue('2026-09-26T09:00:00Z', 7, NOW)).toEqual({ due: true, days: 7 });
    expect(countDueText(countDue('2026-10-02T09:00:00Z', 7, NOW))).toBe('Last counted 1 day ago');
  });
});

describe('hubActions', () => {
  it('shows only what the person may do, in store order', () => {
    const all = hubActions({ adjust: true, order: true, request: true }, 'node=n1');
    expect(all.map((a) => a.label)).toEqual(['Count', 'Record wastage', 'Order', 'Request stock']);
    expect(all[0]!.href).toBe('/stock/count?node=n1');
    expect(hubActions({ adjust: false, order: false, request: true }, 'node=n1')).toHaveLength(1);
    expect(hubActions({ adjust: false, order: false, request: false }, 'node=n1')).toEqual([]);
  });
});
