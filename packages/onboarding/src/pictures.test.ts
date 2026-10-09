import { join } from 'node:path';
import { matchPicture, TEMPLATES } from '@outlet-ops/domain';
import { describe, expect, it } from 'vitest';
import { readCustomerDir } from './dir';
import { readBundle } from './files';
import { pictureWarnings } from './validate';

// Every item has a picture of the thing itself (ADR 084): every item and prep item of both test
// customers and the Passport Hotel demo, and every template's starter item. A customer's item
// that matches none is a warning in the dry run, never a blocker.

const DOCS = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding');
const CUSTOMERS = [
  join(DOCS, 'test-data', 'test-company'),
  join(DOCS, 'test-data', 'test-solo-bar-co'),
  join(DOCS, 'demo', 'passport-hotel'),
];

describe('item pictures', () => {
  it.each(CUSTOMERS)('every item and prep item of %s has its own picture', (dir) => {
    const { bundle, issues } = readBundle(readCustomerDir(dir));
    expect(issues).toEqual([]);
    expect(bundle.items.length).toBeGreaterThan(0);
    expect(pictureWarnings(bundle)).toEqual([]);
  });

  it("every template's starter item has its own picture", () => {
    const none = TEMPLATES.flatMap((t) => t.items).filter(
      (i) => !matchPicture(i.name, i.category).specific,
    );
    expect(none).toEqual([]);
  });

  it('an item with no picture of its own is a warning that says what it shows', () => {
    const { bundle } = readBundle(readCustomerDir(CUSTOMERS[0]!));
    const odd = { ...bundle.items[0]!, name: 'House mystery mix', category: 'Spices', line: 99 };
    expect(pictureWarnings({ ...bundle, items: [odd], prepItems: [] })).toEqual([
      {
        file: '10_items.csv',
        row: 99,
        column: 'name',
        message:
          'House mystery mix has no picture of its own yet: it shows spices. Ask the product team to add a picture for it',
      },
    ]);
  });
});
