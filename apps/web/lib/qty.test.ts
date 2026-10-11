import { describe, expect, it } from 'vitest';
import { formatQty, inputQty } from './qty';

describe('quantities show at most 2 decimals (ADR 054)', () => {
  it('formats the database values the screens showed raw', () => {
    expect(formatQty('4.800000', 'kg')).toBe('4.8 kg');
    expect(formatQty('0.964000', 'kg')).toBe('0.96 kg');
    expect(formatQty('0.036000', 'kg')).toBe('0.04 kg');
    expect(formatQty('-5.300000', 'kg')).toBe('-5.3 kg');
    expect(formatQty('1234.5', 'l')).toBe('1,234.5 l');
    expect(formatQty('250.4', 'g')).toBe('250 g');
    expect(formatQty('2', 'each')).toBe('2 each');
    // counted one by one: whole (ADR 114)
    expect(formatQty('51.9', 'each')).toBe('52 each');
  });
  it('fills a box with a plain number', () => {
    expect(inputQty('4.800000')).toBe('4.8');
    expect(inputQty(0.036000000001)).toBe('0.04');
    expect(inputQty(1234.567)).toBe('1234.57');
    expect(inputQty('x')).toBe('');
  });
});
