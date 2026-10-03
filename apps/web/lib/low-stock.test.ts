import { describe, expect, it } from 'vitest';
import { daysLeft, isLow, lastsText } from './low-stock';

describe('low stock', () => {
  it('is low when it runs out within three days at the last two weeks’ rate', () => {
    // 14 kg used in 14 days: 1 kg a day
    expect(daysLeft({ on_hand: 2, par_level: 10, used: 14 })).toBe(2);
    expect(isLow({ on_hand: 3, par_level: 10, used: 14 })).toBe(true);
    expect(isLow({ on_hand: 3.5, par_level: 10, used: 14 })).toBe(false);
  });
  it('below its level but not used is not low', () => {
    expect(isLow({ on_hand: 1, par_level: 10, used: 0 })).toBe(false);
    expect(isLow({ on_hand: 1, par_level: 10, used: null })).toBe(false);
  });
  it('none left is low; at or above its level never is', () => {
    expect(isLow({ on_hand: 0, par_level: 10, used: 0 })).toBe(true);
    expect(isLow({ on_hand: -2, par_level: 10, used: 0 })).toBe(true);
    expect(isLow({ on_hand: 10, par_level: 10, used: 1000 })).toBe(false);
    expect(isLow({ on_hand: 0, par_level: 0, used: 5 })).toBe(false);
  });
  it('says how long it lasts', () => {
    expect(lastsText({ on_hand: 2, par_level: 10, used: 14 })).toBe('Lasts 2 days');
    expect(lastsText({ on_hand: 1.5, par_level: 10, used: 14 })).toBe('Lasts 1 day');
    expect(lastsText({ on_hand: 0.5, par_level: 10, used: 14 })).toBe('Lasts under a day');
    expect(lastsText({ on_hand: 0, par_level: 10, used: 14 })).toBe('None left');
    expect(lastsText({ on_hand: 5, par_level: 10, used: 0 })).toBe('');
  });
});
