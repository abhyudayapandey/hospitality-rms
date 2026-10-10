import { describe, expect, it } from 'vitest';
import { shelfGroups } from './shelves';

describe('shelfGroups (ADR 101)', () => {
  it('one unheaded group when the store has no shelves', () => {
    const g = shelfGroups([{ shelf: null }, { shelf: null }]);
    expect(g).toHaveLength(1);
    expect(g[0]!.shelf).toBeUndefined();
  });
  it('groups by shelf in order, no shelf last', () => {
    const g = shelfGroups([
      { shelf: 'Back bar', n: 1 },
      { shelf: null, n: 2 },
      { shelf: 'Back bar', n: 3 },
      { shelf: 'Fridge', n: 4 },
    ]);
    expect(g.map((x) => x.shelf)).toEqual(['Back bar', 'Fridge', null]);
    expect(g[0]!.rows.map((r) => r.n)).toEqual([1, 3]);
  });
  it('nothing for no rows', () => {
    expect(shelfGroups([])).toEqual([]);
  });
});
