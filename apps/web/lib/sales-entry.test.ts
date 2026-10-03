import { describe, expect, it } from 'vitest';
import { copyQuantities, matchesSearch, totalSold, weekdayName } from './sales-entry';

describe('sales entry (UX-4)', () => {
  it('names the day', () => {
    expect(weekdayName('2026-10-03')).toBe('Saturday');
    expect(weekdayName('2026-09-28')).toBe('Monday');
  });

  it('searches name and code, every word', () => {
    const gin = { name: 'Gin & Tonic', code: 'GIN-AND-TONIC' };
    expect(matchesSearch(gin, 'gin')).toBe(true);
    expect(matchesSearch(gin, 'tonic gin')).toBe(true);
    expect(matchesSearch(gin, 'gin-and')).toBe(true);
    expect(matchesSearch(gin, 'gin rum')).toBe(false);
    expect(matchesSearch(gin, '  ')).toBe(true);
  });

  it('copies another day: its items take its numbers; the rest stay', () => {
    const r = copyQuantities({ a: '', b: '4', c: '9' }, { a: 3, b: 4, x: 7 });
    expect(r.qty).toEqual({ a: '3', b: '4', c: '9' });
    expect(r.changed).toBe(1);
  });

  it('adds up what is typed', () => {
    expect(totalSold({ a: '3', b: '', c: '2.5', d: '-1', e: 'x' })).toBe(5.5);
  });
});
