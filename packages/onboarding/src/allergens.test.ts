import { join } from 'node:path';
import { allergenHints, TEMPLATES } from '@outlet-ops/domain';
import { describe, expect, it } from 'vitest';
import { readCustomerDir } from './dir';
import { readBundle } from './files';
import { allergenWarnings } from './validate';

// Allergens follow the recipe (ADR 138): a raw item is tagged once in file 10; a prep item or a
// dish carries what its recipe's items carry. An item whose name says it carries an allergen
// that nothing tags is a warning in the dry run, never a blocker, and never tagged for them.

const DOCS = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding');
const CUSTOMERS = [
  join(DOCS, 'test-data', 'test-company'),
  join(DOCS, 'test-data', 'test-solo-bar-co'),
  join(DOCS, 'demo', 'passport-hotel'),
];

describe('allergen hints in the dry run', () => {
  it.each(CUSTOMERS)('%s tags every item its name says carries one', (dir) => {
    const { bundle, issues } = readBundle(readCustomerDir(dir));
    expect(issues).toEqual([]);
    expect(allergenWarnings(bundle)).toEqual([]);
  });

  it("every template's starter item carries what its name says", () => {
    const missing = TEMPLATES.flatMap((t) => t.items).filter((i) =>
      allergenHints(i.name).some((a) => !(i.allergens ?? []).includes(a)),
    );
    expect(missing).toEqual([]);
  });

  it('an untagged item is a warning; its dish then says its recipe carries none', () => {
    const { bundle } = readBundle(readCustomerDir(CUSTOMERS[0]!));
    const items = bundle.items.map((i) => (i.item_code === 'PRAWNS' ? { ...i, allergens: [] } : i));
    const prawns = items.find((i) => i.item_code === 'PRAWNS')!;
    const dish = bundle.menuItems.find((m) => m.menu_item_code === 'PRAWNS-MASALA')!;
    expect(allergenWarnings({ ...bundle, items })).toEqual([
      {
        file: '10_items.csv',
        row: prawns.line,
        column: 'allergens',
        message: 'Test Prawns may contain crustaceans. Add it to its allergens if it does',
      },
      {
        file: '22_menu_items.csv',
        row: dish.line,
        column: 'allergens',
        message:
          "Prawns Masala may contain crustaceans, but neither its allergens nor its recipe's items say so. Tag the item in 10_items.csv, or add it to its allergens",
      },
    ]);
  });

  it("a dish's own allergens column counts, and an unknown word is refused", () => {
    const { bundle } = readBundle(readCustomerDir(CUSTOMERS[0]!));
    const items = bundle.items.map((i) => (i.item_code === 'PRAWNS' ? { ...i, allergens: [] } : i));
    const menuItems = bundle.menuItems.map((m) =>
      m.menu_item_code === 'PRAWNS-MASALA' ? { ...m, allergens: ['crustaceans' as const] } : m,
    );
    expect(allergenWarnings({ ...bundle, items, menuItems }).map((w) => w.file)).toEqual([
      '10_items.csv',
    ]);
    const files = readCustomerDir(CUSTOMERS[0]!);
    const menu = files['22_menu_items.csv']!.trim()
      .split(/\r?\n/)
      .map((l, i) => `${l},${i === 0 ? 'allergens' : i === 1 ? 'shellfish' : ''}`);
    const { issues } = readBundle({ ...files, '22_menu_items.csv': menu.join('\n') });
    expect(issues.map((i) => i.message)).toContainEqual(
      expect.stringContaining('"shellfish" is not an allergen we list'),
    );
  });
});
