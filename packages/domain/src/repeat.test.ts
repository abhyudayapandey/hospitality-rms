import { describe, expect, it } from 'vitest';
import { parseRepeat, repeatColumns, repeatOf, repeatWords } from './repeat';

// How a regular compliance job repeats (ADR 116): read from file 39's words, said back in words,
// and kept in the job's columns.

describe('how a regular job repeats', () => {
  it('reads the words file 39 takes', () => {
    expect(parseRepeat('every week on Monday')).toEqual({ kind: 'weeks', weeks: 1, weekday: 1 });
    expect(parseRepeat('Every 2 weeks on friday')).toEqual({ kind: 'weeks', weeks: 2, weekday: 5 });
    expect(parseRepeat('every fortnight on Sunday')).toEqual({
      kind: 'weeks',
      weeks: 2,
      weekday: 7,
    });
    expect(parseRepeat('2nd Tuesday')).toEqual({ kind: 'nth', nth: 2, weekday: 2 });
    expect(parseRepeat('last Friday of each month')).toEqual({ kind: 'nth', nth: -1, weekday: 5 });
    expect(parseRepeat('first monday')).toEqual({ kind: 'nth', nth: 1, weekday: 1 });
    for (const bad of [
      '',
      'weekly',
      'every week on Funday',
      '5th Monday',
      'every 3 weeks on Monday',
    ])
      expect(parseRepeat(bad), bad).toBeNull();
  });

  it('says it back in words', () => {
    expect(repeatWords({ kind: 'months', months: 6 })).toBe('Every 6 months');
    expect(repeatWords({ kind: 'months', months: 12 })).toBe('Every year');
    expect(repeatWords({ kind: 'weeks', weeks: 1, weekday: 1 })).toBe('Every week on Monday');
    expect(repeatWords({ kind: 'weeks', weeks: 2, weekday: 3 })).toBe('Every 2 weeks on Wednesday');
    expect(repeatWords({ kind: 'nth', nth: -1, weekday: 5 })).toBe('Last Friday of each month');
  });

  it('keeps it in the columns and reads it back', () => {
    for (const r of [
      { kind: 'months', months: 3 },
      { kind: 'weeks', weeks: 2, weekday: 4 },
      { kind: 'nth', nth: 3, weekday: 6 },
    ] as const) {
      expect(repeatOf(repeatColumns(r))).toEqual(r);
    }
    expect(repeatOf({})).toEqual({ kind: 'months', months: 1 });
  });
});
