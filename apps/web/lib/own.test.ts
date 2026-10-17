import { describe, expect, it } from 'vitest';
import { own } from './own';

describe('own', () => {
  const words: Record<string, string> = { expired: 'Signed out' };
  it('finds a key the record has', () => {
    expect(own(words, 'expired')).toBe('Signed out');
  });
  it('never finds what every object inherits', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nope']) {
      expect(own(words, k)).toBeUndefined();
    }
  });
});
