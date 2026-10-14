import { describe, expect, it } from 'vitest';
import { daysLeft, isLow, lastsText } from './low-stock';

describe('low stock', () => {
  it('is low when below its par, used or not (ADR 141)', () => {
    expect(isLow({ on_hand: 14, par_level: 20, used: 196 })).toBe(true);
    expect(isLow({ on_hand: 1, par_level: 10, used: 0 })).toBe(true);
    expect(isLow({ on_hand: 1, par_level: 10, used: null })).toBe(true);
  });
  it('at or above its par, or with no par, never is', () => {
    expect(isLow({ on_hand: 10, par_level: 10, used: 1000 })).toBe(false);
    expect(isLow({ on_hand: 0, par_level: 0, used: 5 })).toBe(false);
    expect(isLow({ on_hand: -2, par_level: 10, used: 0 })).toBe(true);
  });
  it('says how long it lasts at the last two weeks’ rate', () => {
    // 14 kg used in 14 days: 1 kg a day
    expect(daysLeft({ on_hand: 2, par_level: 10, used: 14 })).toBe(2);
    expect(lastsText({ on_hand: 2, par_level: 10, used: 14 })).toBe('~2 days left');
    expect(lastsText({ on_hand: 1.5, par_level: 10, used: 14 })).toBe('~1 day left');
    expect(lastsText({ on_hand: 0.5, par_level: 10, used: 14 })).toBe('under a day left');
    expect(lastsText({ on_hand: 0, par_level: 10, used: 14 })).toBe('none left');
    expect(lastsText({ on_hand: 5, par_level: 10, used: 0 })).toBe('');
  });
});
