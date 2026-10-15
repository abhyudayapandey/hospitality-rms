import { describe, expect, it } from 'vitest';
import { quickPicks, readingSteps } from '../components/stepper';

const values = (min: number | null, max: number | null) => quickPicks(min, max).map((x) => x.label);

describe('quickPicks', () => {
  it('a chiller 0 to 5 °C: whole degrees, green inside, amber one out', () => {
    const p = quickPicks(0, 5);
    expect(p.map((x) => x.value)).toEqual([-1, 0, 1, 2, 3, 4, 5, 6]);
    expect(p.find((x) => x.value === 3)!.tone).toBe('good');
    expect(p.find((x) => x.value === 6)!.tone).toBe('near');
    expect(p.find((x) => x.value === -1)!.tone).toBe('near');
  });
  it('a freezer works below zero', () => {
    expect(quickPicks(-22, -18).map((x) => x.value)).toEqual([-23, -22, -21, -20, -19, -18, -17]);
  });
  it('pool pH 7.2 to 7.8 goes by 0.2 with one decimal, all near the range', () => {
    expect(values(7.2, 7.8)).toEqual(['7.0', '7.2', '7.4', '7.6', '7.8', '8.0']);
    const p = quickPicks(7.2, 7.8);
    expect(p.filter((x) => x.tone === 'good').map((x) => x.label)).toEqual([
      '7.2',
      '7.4',
      '7.6',
      '7.8',
    ]);
  });
  it('free chlorine 1 to 3 ppm goes by 0.5', () => {
    expect(values(1, 3)).toEqual(['0.5', '1.0', '1.5', '2.0', '2.5', '3.0', '3.5']);
  });
  it('hot water 50 to 70 °C goes by 5', () => {
    expect(values(50, 70)).toEqual(['45', '50', '55', '60', '65', '70', '75']);
  });
  it('a bound off the step still gets one tap either side', () => {
    expect(values(1.5, 6)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });
  it('never more than ten taps', () => {
    for (const [a, b] of [
      [0, 5],
      [7.2, 7.8],
      [1, 3],
      [50, 70],
      [0, 1000],
      [0.3, 0.35],
      [-22, -18],
      [63, 100],
    ] as const) {
      expect(quickPicks(a, b).length).toBeLessThanOrEqual(10);
      expect(quickPicks(a, b).length).toBeGreaterThanOrEqual(3);
    }
  });
  it('none when the range is unknown', () => {
    expect(quickPicks(null, 5)).toEqual([]);
    expect(quickPicks(5, null)).toEqual([]);
    expect(quickPicks(5, 5)).toEqual([]);
  });
});

describe('readingSteps', () => {
  it('the − / + step is 0.1 for pH, 1 for a chiller', () => {
    expect(readingSteps(7.2, 7.8)).toEqual({ pick: 0.2, fine: 0.1 });
    expect(readingSteps(0, 5)).toEqual({ pick: 1, fine: 1 });
    expect(readingSteps(null, 5)).toBeNull();
  });
});
