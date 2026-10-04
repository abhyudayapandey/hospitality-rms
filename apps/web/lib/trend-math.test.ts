import { describe, expect, it } from 'vitest';
import { chartRange, linePath, slotX, valueY } from './trend-math';

describe('trend chart arithmetic', () => {
  it('always shows 0; stacked bars add their parts; lines go below 0 when a value does', () => {
    expect(chartRange([[10, 20, null]], false)).toEqual({ min: 0, max: 20 });
    expect(
      chartRange(
        [
          [10, 5],
          [3, 30],
        ],
        true,
      ),
    ).toEqual({ min: 0, max: 35 });
    expect(chartRange([[-5, 10]], false)).toEqual({ min: -5, max: 10 });
    // nothing at all still draws
    expect(chartRange([[null, null]], false)).toEqual({ min: 0, max: 1 });
  });

  it('puts each period in the middle of its slot, the top at max', () => {
    expect(slotX(0, 4, 100)).toBe(12.5);
    expect(slotX(3, 4, 100)).toBe(87.5);
    expect(valueY(20, 0, 20, 100)).toBe(0);
    expect(valueY(0, 0, 20, 100)).toBe(100);
    expect(valueY(0, -10, 10, 100)).toBe(50);
  });

  it('draws the line through the periods with a value, breaking where one has none', () => {
    expect(linePath([0, 10, null, 10], 100, 10, 0, 10)).toBe(
      'M12.50 10.00 L37.50 0.00 M87.50 0.00',
    );
    expect(linePath([null, null], 100, 10, 0, 10)).toBe('');
  });
});
