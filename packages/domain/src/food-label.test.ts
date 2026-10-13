import { describe, expect, it } from 'vitest';
import {
  ALLERGEN_WORDS,
  ALLERGENS,
  allergenHints,
  FSSAI_ALLERGENS,
  parseAllergens,
  sortAllergens,
} from './food-label';

// One allergen list for every customer (ADR 138): FSSAI's nine, then the EU's five more. An
// item's name hints at what it carries; the hint is for whoever onboards, never a tag.

describe('the allergen list', () => {
  it("is FSSAI's nine, then the five more on the EU's list of 14", () => {
    expect(ALLERGENS).toHaveLength(14);
    expect(FSSAI_ALLERGENS).toEqual([
      'gluten',
      'crustaceans',
      'milk',
      'egg',
      'fish',
      'peanuts',
      'tree nuts',
      'soy',
      'sulphites',
    ]);
    expect(ALLERGENS.filter((a) => !FSSAI_ALLERGENS.includes(a))).toEqual([
      'celery',
      'mustard',
      'sesame',
      'lupin',
      'molluscs',
    ]);
    for (const a of ALLERGENS) expect(ALLERGEN_WORDS[a]).toBeTruthy();
  });

  it('reads a file column and sorts a set in the list order', () => {
    expect(parseAllergens('Molluscs; milk; milk')).toEqual({ ok: ['molluscs', 'milk'] });
    expect(parseAllergens('nuts')).toEqual({ bad: 'nuts' });
    expect(sortAllergens(['sesame', 'milk', 'gluten'])).toEqual(['gluten', 'milk', 'sesame']);
  });
});

describe('hints from the name', () => {
  it.each([
    ['Prawns, medium', ['crustaceans']],
    ['Kingfish (surmai)', ['fish']],
    ['Clams (tisreo)', ['molluscs']],
    ['Squid', ['molluscs']],
    ['Eggs', ['egg']],
    ['Flour (maida)', ['gluten']],
    ['Semolina (rava)', ['gluten']],
    ['Poi (Goan bread)', ['gluten']],
    ['Sandwich bread, slice', ['gluten']],
    ['Goan craft beer 330ml', ['gluten']],
    ['Lager 330ml', ['gluten']],
    ['Test Ghee', ['milk']],
    ['Cheddar cheese', ['milk']],
    ['Red wine 750ml', ['sulphites']],
    ['Sweet vermouth 750ml', ['sulphites']],
    ['Cashew nuts', ['tree nuts']],
    ['Mustard seeds (rai)', ['mustard']],
    ['Sesame oil', ['sesame']],
    ['Soy sauce', ['gluten', 'soy']],
    ['Mayonnaise', ['egg']],
    ['Chouriço bread roll', ['gluten']],
  ])('%s: %j', (name, hints) => {
    expect(allergenHints(name)).toEqual(hints);
  });

  it.each([
    'Coconut milk',
    'Cashew feni 750ml',
    'Ginger ale 200ml',
    'Eggplant',
    'Oyster mushrooms',
    'Nutmeg',
    'Goat curry cut',
    'Tomatoes',
  ])('%s hints at nothing', (name) => {
    expect(allergenHints(name)).toEqual([]);
  });
});
