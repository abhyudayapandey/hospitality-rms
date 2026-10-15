import { describe, expect, it } from 'vitest';
import { levelsText, twoDecimals, type RequestLevel } from './request-levels';

const line = (over: Partial<RequestLevel> = {}): RequestLevel => ({
  item_id: 'i',
  name: 'Soda 750ml',
  base_uom: 'bottle',
  asked: '30',
  from_name: 'Main Store',
  from_on_hand: '34',
  to_name: 'Bar Store',
  to_on_hand: '19.571428',
  to_par: '24',
  ...over,
});

describe('request levels (ADR 141)', () => {
  it('says what the giving store has and what the asking store has of its par', () => {
    expect(levelsText(line())).toBe(
      'Main Store has 34 bottles · Bar Store has 19.57 of 24 bottles',
    );
  });
  it('leaves out a par the asking store has not set', () => {
    expect(levelsText(line({ to_par: null }))).toBe(
      'Main Store has 34 bottles · Bar Store has 19.57 bottles',
    );
    expect(levelsText(line({ to_par: '0' }))).toBe(
      'Main Store has 34 bottles · Bar Store has 19.57 bottles',
    );
  });
});

describe('two decimals in words', () => {
  it('rounds a long quantity and leaves the rest', () => {
    expect(twoDecimals('Soda 750ml: 30 bottle, usual 12.107 bottle a week')).toBe(
      'Soda 750ml: 30 bottle, usual 12.11 bottle a week',
    );
    expect(twoDecimals('usual 12.5 kg')).toBe('usual 12.5 kg');
  });
});
