import { describe, expect, it } from 'vitest';
import { unsentCount, unsentWords } from './unsent';

// Before signing out of a shared phone (ADR 169): what is saved on it and not sent yet.

const store = <T>(rows: T[]) => ({ all: () => Promise.resolve(rows) });

describe('unsent', () => {
  it('counts the saved counts, wastage and clock-ins of everyone on the phone', async () => {
    expect(await unsentCount([store([{}, {}]), store([{}])])).toBe(3);
  });

  it('a store that cannot be read counts as nothing', async () => {
    const broken = { all: () => Promise.reject(new Error('private mode')) };
    expect(await unsentCount([broken, store([{}])])).toBe(1);
  });

  it('says it in plain words', () => {
    expect(unsentWords(1)).toBe('1 thing on this phone is not sent yet.');
    expect(unsentWords(4)).toBe('4 things on this phone are not sent yet.');
  });
});
