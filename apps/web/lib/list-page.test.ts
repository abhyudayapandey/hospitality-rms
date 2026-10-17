import { describe, expect, it } from 'vitest';
import { LIST_PAGE, listLimit, listPage } from './list-page';

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
  it('takes a smaller first page where one is set (the Main Store transfers, ADR 053)', () => {
    expect(listLimit(undefined, 10)).toBe(10);
    expect(listLimit('20', 10)).toBe(20);
  });
});

describe('listPage', () => {
  const rows = Array.from({ length: 70 }, (_, i) => i);
  it('shows the first page and links to the next, keeping the other filters (ADR 169)', () => {
    const p = listPage(rows, '/logbook', { place: 'p1', from: '2026-01-01', n: undefined });
    expect(p.shown).toHaveLength(30);
    expect(p.more).toBe('/logbook?place=p1&from=2026-01-01&n=60');
  });
  it('has no next page when all of it shows', () => {
    const p = listPage(rows, '/logbook', { n: '90' });
    expect(p.shown).toHaveLength(70);
    expect(p.more).toBeNull();
  });
});
