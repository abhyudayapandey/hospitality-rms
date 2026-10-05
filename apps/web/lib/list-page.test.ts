import { describe, expect, it } from 'vitest';
import { LIST_PAGE, listLimit } from './list-page';

describe('listLimit', () => {
  it('is LIST_PAGE by default and for nonsense', () => {
    expect(listLimit(undefined)).toBe(LIST_PAGE);
    expect(listLimit(null)).toBe(LIST_PAGE);
    expect(listLimit('abc')).toBe(LIST_PAGE);
    expect(listLimit('-5')).toBe(LIST_PAGE);
    expect(listLimit('0')).toBe(LIST_PAGE);
  });
  it('takes a page count and caps it', () => {
    expect(listLimit('60')).toBe(60);
    expect(listLimit('99999')).toBe(500);
  });
});
