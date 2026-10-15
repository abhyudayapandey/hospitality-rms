import { describe, expect, it } from 'vitest';
import { daysLeft, isLow, isUnderPar, lastsText, parLine } from './low-stock';

describe('low stock', () => {
  it('is low when under its par, used or not (ADR 141)', () => {
    expect(isLow({ on_hand: 14, par_level: 20, used: 196 })).toBe(true);
    expect(isLow({ on_hand: 1, par_level: 10, used: 0 })).toBe(true);
    expect(isLow({ on_hand: 1, par_level: 10, used: null })).toBe(true);
    expect(isLow({ on_hand: -2, par_level: 10, used: 0 })).toBe(true);
  });
  it('is low when it lasts 3 days or fewer, par or no par (ADR 034, KI-05)', () => {
    // 140 used in 14 days: 10 a day; 30 lasts 3 days, 31 a little more
    expect(isLow({ on_hand: 30, par_level: 0, used: 140 })).toBe(true);
    expect(isLow({ on_hand: 31, par_level: 0, used: 140 })).toBe(false);
    expect(isLow({ on_hand: 20, par_level: 20, used: 140 })).toBe(true);
    expect(isUnderPar({ on_hand: 20, par_level: 20, used: 140 })).toBe(false);
    expect(isLow({ on_hand: 0, par_level: 0, used: 5 })).toBe(true);
  });
  it('durable things count by par only (ADR 076)', () => {
    expect(isLow({ on_hand: 5, par_level: 0, used: 140, durable: true })).toBe(false);
    expect(isLow({ on_hand: 5, par_level: 10, used: 0, durable: true })).toBe(true);
  });
  it('at or above its par and lasting, or unused with no par, never is', () => {
    expect(isLow({ on_hand: 10, par_level: 10, used: 14 })).toBe(false);
    expect(isLow({ on_hand: 0, par_level: 0, used: 0 })).toBe(false);
    expect(isLow({ on_hand: 3, par_level: 0, used: null })).toBe(false);
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
  it('the line says why it is low', () => {
    expect(parLine({ on_hand: 14, par_level: 20, used: 196 }, 'kg')).toBe(
      '14 of 20 kg (~1 day left)',
    );
    expect(parLine({ on_hand: 5, par_level: 10, used: 0 }, 'kg')).toBe('5 of 10 kg');
    expect(parLine({ on_hand: 4, par_level: 0, used: 56 }, 'kg')).toBe('4 kg (~1 day left)');
    expect(parLine({ on_hand: 20, par_level: 20, used: 140 }, 'kg')).toBe(
      '20 kg (~2 days left) · par 20 kg',
    );
    expect(parLine({ on_hand: 30, par_level: 20, used: 14 }, 'kg')).toBe('par 20 kg');
    // the database's answer wins when the row carries it
    expect(parLine({ on_hand: 4, par_level: 0, used: 56, low: false }, 'kg')).toBe('');
  });
});
