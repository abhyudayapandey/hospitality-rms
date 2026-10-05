import { describe, expect, it } from 'vitest';
import { byGroup } from './item-groups';

describe('byGroup', () => {
  it('keeps the order rows came in, own group first, and labels each group', () => {
    const g = byGroup([
      { name: 'Linen', item_group: 'housekeeping' },
      { name: 'Soap', item_group: 'housekeeping' },
      { name: 'Ketchup', item_group: 'kitchen_bar' },
      { name: 'Foil', item_group: null },
    ]);
    expect(g.map((x) => [x.label, x.rows.map((r) => r.name)])).toEqual([
      ['Housekeeping items', ['Linen', 'Soap']],
      ['Kitchen & Bar items', ['Ketchup', 'Foil']],
    ]);
  });
});
