import { describe, expect, it } from 'vitest';
import { qtyStep, shortFirst } from './short-first';

describe('shortFirst (ADR 101)', () => {
  const rows = [
    { name: 'Rice', category: 'Dry goods', short: false },
    { name: 'Onions', category: 'Vegetables', short: true },
    { name: 'Atta', category: 'Dry goods', short: false },
    { name: 'Milk', category: 'Dairy', short: true },
    { name: 'Foil', category: null, short: false },
    { name: 'Tomatoes', category: 'Vegetables', short: false },
  ];
  it('short items first, then the rest by category, Other last', () => {
    const s = shortFirst(rows, (r) => r.short);
    expect(s.map((x) => x.label)).toEqual(['Running short', 'Dry goods', 'Vegetables', 'Other']);
    expect(s[0]!.rows.map((r) => r.name)).toEqual(['Milk', 'Onions']);
    expect(s[1]!.rows.map((r) => r.name)).toEqual(['Atta', 'Rice']);
    expect(s.flatMap((x) => x.rows)).toHaveLength(rows.length);
  });
  it('no short section when nothing is short', () => {
    expect(shortFirst(rows, () => false)[0]!.label).toBe('Dairy');
  });
  it('steps by 100 for g and ml', () => {
    expect(qtyStep('g')).toBe(100);
    expect(qtyStep('kg')).toBe(1);
  });
});
