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
  const every = { adjust: true, order: true, request: true };
  it('a department store counts, records wastage and asks', () => {
    const { main, more } = hubActions({ ...every, mainStore: false }, 'node=n1');
    expect(main.map((a) => a.label)).toEqual([
      'Count',
      'Record wastage',
      'Ask for supplies',
      'Request stock',
    ]);
    expect(main[0]!.href).toBe('/stock/count?node=n1');
    expect(more).toEqual([]);
  });
  it('the Main Store sends; asking is a small link there (ADR 051, 052)', () => {
    const { main, more } = hubActions({ ...every, mainStore: true }, 'node=m');
    expect(main.map((a) => a.label)).toEqual(['Send stock', 'Count', 'Record wastage']);
    expect(main[0]!.href).toBe('/stock/transfers/send?node=m');
    expect(more.map((a) => a.label)).toEqual(['Ask for supplies', 'Request stock']);
  });
  it('shows only what the person may do', () => {
    const none = { adjust: false, order: false, request: false };
    expect(hubActions({ ...none, request: true, mainStore: false }, 'q').main).toHaveLength(1);
    expect(hubActions({ ...none, mainStore: true }, 'q')).toEqual({ main: [], more: [] });
  });
});
