import { describe, expect, it } from 'vitest';
import { breakable } from './breakable';

const item = (name: string, unit: string, durable = false) => ({ name, unit, durable });

describe('breakable (ADR 153)', () => {
  it('offers durable things and what is counted, never what is weighed or poured', () => {
    const items = [
      item('Wine glass', 'pc', true),
      item('Beer 330ml', 'bottle'),
      item('Ice cubes', 'kg'),
      item('Salt', 'kg'),
      item('Milk', 'l'),
      item('Plate', 'pc'),
    ];
    expect(breakable(items).map((i) => i.name)).toEqual(['Wine glass', 'Beer 330ml', 'Plate']);
  });

  it('with nothing countable, everything', () => {
    const items = [item('Salt', 'kg'), item('Milk', 'l')];
    expect(breakable(items)).toHaveLength(2);
  });
});
