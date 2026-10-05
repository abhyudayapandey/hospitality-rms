import { describe, expect, it } from 'vitest';
import { matchRows, pageRows } from './filter-rows';

const rows = Array.from({ length: 30 }, (_, i) => ({
  key: String(i),
  text: i % 10 === 0 ? `Basmati rice ${i}` : `Item ${i} Kitchen Store`,
}));

describe('search and show more on a long list (UX-10)', () => {
  it('finds rows with every word, in any case', () => {
    expect(matchRows(rows, 'RICE basmati').map((r) => r.key)).toEqual(['0', '10', '20']);
    expect(matchRows(rows, 'rice 10').map((r) => r.key)).toEqual(['10']);
  });

  it('nothing asked: all rows', () => {
    expect(matchRows(rows, '  ')).toHaveLength(30);
  });

  it('shows the first page and says how many more', () => {
    const p = pageRows(rows, '', 10, false);
    expect(p.shown).toHaveLength(10);
    expect(p.more).toBe(20);
    expect(p.total).toBe(30);
  });

  it('show more reveals all; a short list shows no "more"', () => {
    expect(pageRows(rows, '', 10, true).shown).toHaveLength(30);
    const few = pageRows(rows.slice(0, 8), '', 10, false);
    expect(few.shown).toHaveLength(8);
    expect(few.more).toBe(0);
  });

  it('while searching every match shows, not just a page', () => {
    const p = pageRows(rows, 'kitchen', 5, false);
    expect(p.shown).toHaveLength(27);
    expect(p.more).toBe(0);
  });
});
