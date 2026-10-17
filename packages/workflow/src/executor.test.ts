import { describe, expect, it } from 'vitest';
import { isTransient } from './executor';

// Errors that pass by themselves are retried for longer (ADR 167, M33).
describe('isTransient', () => {
  it.each(['40001', '40P01', '55P03', '57P01', '57P02', '57P03', '08006', '08003', '08P01'])(
    '%s is transient',
    (code) => {
      expect(isTransient(Object.assign(new Error('x'), { code }))).toBe(true);
    },
  );
  it.each(['23505', '22012', 'P0001', '42501', undefined])('%s is not', (code) => {
    expect(isTransient(Object.assign(new Error('x'), { code }))).toBe(false);
  });
  it('a plain error or a string is not', () => {
    expect(isTransient(new Error('REST_RULE'))).toBe(false);
    expect(isTransient('40P01')).toBe(false);
    expect(isTransient(null)).toBe(false);
  });
});
