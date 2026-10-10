import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCustomerDir } from './dir';
import { readBundle } from './files';
import { packWarnings, validateBundle } from './validate';

// Opened packs by whole packs (ADR 102): file 10's optional pack_size and pack_name. An item
// with a shelf life once opened and no pack size is a warning in the dry run, never a blocker.

const DOCS = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding');
const COMPANY = join(DOCS, 'test-data', 'test-company');
const PASSPORT = join(DOCS, 'demo', 'passport-hotel');

const withItems = (dir: string, edit: (csv: string) => string) => {
  const files = readCustomerDir(dir);
  return { ...files, '10_items.csv': edit(files['10_items.csv']!) };
};

describe('pack sizes (file 10)', () => {
  it.each([COMPANY, PASSPORT])('every item of %s opened by the pack has a pack size', (dir) => {
    const { bundle, issues } = readBundle(readCustomerDir(dir));
    expect(issues).toEqual([]);
    expect(packWarnings(bundle)).toEqual([]);
    expect(bundle.items.some((i) => i.pack_size !== undefined)).toBe(true);
  });

  it('Test Company: milk is a 1 l carton, cream a 200 ml carton', () => {
    const { bundle } = readBundle(readCustomerDir(COMPANY));
    const by = new Map(bundle.items.map((i) => [i.item_code, i]));
    expect([by.get('MILK')!.pack_size, by.get('MILK')!.pack_name]).toEqual([1, 'carton']);
    expect([by.get('FRESH-CREAM')!.pack_size, by.get('FRESH-CREAM')!.pack_name]).toEqual([
      0.2,
      'carton',
    ]);
    expect(by.get('ONIONS')!.pack_size).toBeUndefined();
  });

  it('a shelf-life item with no pack size is a warning that says so', () => {
    const { bundle } = readBundle(readCustomerDir(COMPANY));
    const milk = { ...bundle.items.find((i) => i.item_code === 'MILK')!, pack_size: undefined };
    expect(packWarnings({ ...bundle, items: [milk] })).toEqual([
      {
        file: '10_items.csv',
        row: milk.line,
        column: 'pack_size',
        message:
          'Test Milk has a shelf life once opened but no pack size: it can be opened by any amount, not by whole packs',
      },
    ]);
  });

  it('refuses a pack size of 0, a pack name that is not a word, and a name with no size', () => {
    const lines = (csv: string) => csv.split(/\r?\n/);
    const set = (csv: string, code: string, size: string, name: string) =>
      lines(csv)
        .map((l) => (l.startsWith(`${code},`) ? l.replace(/,[^,]*,[^,]*$/, `,${size},${name}`) : l))
        .join('\n');
    const zero = readBundle(withItems(COMPANY, (c) => set(c, 'MILK', '0', 'carton')));
    expect(zero.issues.map((i) => [i.column, i.message])).toEqual([
      ['pack_size', 'must be more than 0'],
    ]);
    const odd = readBundle(withItems(COMPANY, (c) => set(c, 'MILK', '1', '1l')));
    expect(odd.issues.map((i) => i.column)).toEqual(['pack_name']);
    const nameOnly = readBundle(withItems(COMPANY, (c) => set(c, 'MILK', '', 'carton')));
    expect(nameOnly.issues).toEqual([]);
    expect(validateBundle(nameOnly.bundle).map((i) => [i.column, i.message])).toEqual([
      ['pack_size', 'give the pack size with its pack name'],
    ]);
  });
});
