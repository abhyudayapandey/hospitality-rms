import type { IconName } from '@/components/icon';

// A picture for a store or department named in a list (ADR 100): the Send stock "to" list.
// From its name's words; a box when nothing fits.
const RULES: [RegExp, IconName][] = [
  [/\b(bar|pub|beverage|minibar|cellar)\b/i, 'glass'],
  [/\b(kitchen|pastry|bakery|commissary|prep|tandoor)\b/i, 'pot'],
  [/\b(housekeeping|rooms?|linen|laundry)\b/i, 'bed'],
  [/\b(restaurants?|banquets?|dining|service|cafe|café|breakfast)\b/i, 'plate'],
  [/\b(spa|pool|gym)\b/i, 'towel'],
];

export function storeIcon(name: string): IconName {
  for (const [re, icon] of RULES) if (re.test(name)) return icon;
  return 'box';
}
