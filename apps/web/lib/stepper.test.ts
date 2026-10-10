import { describe, expect, it } from 'vitest';
import { quickPicks } from '../components/stepper';

describe('quickPicks', () => {
  it('a chiller 0 to 5 °C: green inside, amber one out, red beyond', () => {
    const p = quickPicks(0, 5);
    expect(p.map((x) => x.value)).toEqual([-1, 0, 1, 2, 3, 4, 5, 6, 7]);
    expect(p.find((x) => x.value === 3)!.tone).toBe('good');
    expect(p.find((x) => x.value === 6)!.tone).toBe('near');
    expect(p.find((x) => x.value === 7)!.tone).toBe('bad');
    expect(p.find((x) => x.value === -1)!.tone).toBe('near');
  });
  it('a freezer works below zero', () => {
    expect(quickPicks(-22, -18).map((x) => x.value)).toEqual([
      -23, -22, -21, -20, -19, -18, -17, -16,
    ]);
  });
  it('none when the range is unknown or wide', () => {
    expect(quickPicks(null, 5)).toEqual([]);
    expect(quickPicks(60, 100)).toEqual([]);
  });
});
