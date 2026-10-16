import { describe, expect, it } from 'vitest';
import { formatCount, formatNumber, formatQty, inputQty } from './qty';

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
  it('says a unit as many of it are said (ADR 160)', () => {
    expect(formatQty('1', 'bottle')).toBe('1 bottle');
    expect(formatQty('129', 'bottle')).toBe('129 bottles');
    expect(formatQty('0', 'bottle')).toBe('0 bottles');
    expect(formatQty('7', 'pack')).toBe('7 packs');
    expect(formatQty('2', 'box')).toBe('2 boxes');
    expect(formatQty('1.004', 'can')).toBe('1 can');
    expect(formatQty('2', 'kg')).toBe('2 kg');
    expect(formatQty('3', 'l')).toBe('3 l');
    expect(formatCount('2', 'each')).toBe('2');
    expect(formatCount('2', 'bottle')).toBe('2 bottles');
  });
  it('counts cans, packs and boxes whole; a part bottle stays (ADR 162)', () => {
    expect(formatQty('33.6', 'can')).toBe('34 cans');
    expect(formatQty('2.4', 'box')).toBe('2 boxes');
    expect(formatQty('1', 'pack')).toBe('1 pack');
    expect(formatQty('20.01', 'bottle')).toBe('20.01 bottles');
    expect(formatNumber('72.5', 'each')).toBe('73');
    expect(formatNumber('19.471', 'bottle')).toBe('19.47');
  });

  it('fills a box with a plain number', () => {
    expect(inputQty('4.800000')).toBe('4.8');
    expect(inputQty(0.036000000001)).toBe('0.04');
    expect(inputQty(1234.567)).toBe('1234.57');
    expect(inputQty('x')).toBe('');
  });
});
