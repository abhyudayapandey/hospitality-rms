import { describe, expect, it } from 'vitest';
import { askedRange, quickRanges, rangeQuery, readRange } from './date-range';

describe('a list’s days (ADR 120)', () => {
  const today = '2026-10-11';

  it('is the last days to today when nothing is asked', () => {
    expect(readRange({}, today)).toEqual({ from: '2026-10-05', to: today });
    expect(readRange({}, today, 30)).toEqual({ from: '2026-09-12', to: today });
  });

  it('keeps any two days asked, in order, never after today', () => {
    expect(readRange({ from: '2026-09-01', to: '2026-09-15' }, today)).toEqual({
      from: '2026-09-01',
      to: '2026-09-15',
    });
    expect(readRange({ from: '2026-09-15', to: '2026-09-01' }, today)).toEqual({
      from: '2026-09-01',
      to: '2026-09-15',
    });
    expect(readRange({ from: '2026-10-01', to: '2026-12-31' }, today)).toEqual({
      from: '2026-10-01',
      to: today,
    });
    expect(readRange({ from: 'x', to: 'y' }, today, 1)).toEqual({ from: today, to: today });
  });

  it('is at most the longest period', () => {
    expect(readRange({ from: '2020-01-01', to: today }, today, 7, 31)).toEqual({
      from: '2026-09-11',
      to: today,
    });
  });

  it('offers today, 7 and 30 days and this month', () => {
    expect(quickRanges(today).map((q) => [q.label, q.range.from])).toEqual([
      ['Today', today],
      ['7 days', '2026-10-05'],
      ['30 days', '2026-09-12'],
      ['This month', '2026-10-01'],
    ]);
  });

  it('keeps the other parameters of the page', () => {
    expect(rangeQuery({ tab: 'usage', from: 'x', outlet: undefined }, { from: 'a', to: 'b' })).toBe(
      'tab=usage&from=a&to=b',
    );
  });

  it('a list keeps all of itself until days are picked; one day picked is that day', () => {
    expect(askedRange({}, today)).toBeNull();
    expect(askedRange({ from: 'nonsense' }, today)).toBeNull();
    expect(askedRange({ from: '2026-10-01' }, today)).toEqual({
      from: '2026-10-01',
      to: '2026-10-01',
    });
    expect(askedRange({ to: '2026-10-03' }, today)).toEqual({
      from: '2026-10-03',
      to: '2026-10-03',
    });
    expect(askedRange({ from: '2026-10-09', to: '2026-10-20' }, today)).toEqual({
      from: '2026-10-09',
      to: today,
    });
  });
});
