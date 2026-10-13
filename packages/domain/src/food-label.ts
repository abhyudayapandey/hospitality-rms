// What a batch's label says under FSSAI (ADR 076): veg or non-veg (the green or red mark;
// egg is non-veg by the mark, said in words) and its allergens (ADR 138).

export const FOOD_TYPES = ['veg', 'non_veg', 'egg'] as const;
export type FoodType = (typeof FOOD_TYPES)[number];

export const FOOD_TYPE_WORDS: Readonly<Record<FoodType, string>> = {
  veg: 'Veg',
  non_veg: 'Non-veg',
  egg: 'Contains egg',
};

/**
 * The allergens a label declares (ADR 138), one list for every customer: FSSAI's nine
 * (Labelling & Display Regulations 2020) and then the five more the EU's list of 14 adds, which
 * guests from abroad ask about. In files 10, 19 and 22's words; the database checks the same.
 */
export const ALLERGENS = [
  'gluten',
  'crustaceans',
  'milk',
  'egg',
  'fish',
  'peanuts',
  'tree nuts',
  'soy',
  'sulphites',
  'celery',
  'mustard',
  'sesame',
  'lupin',
  'molluscs',
] as const;
export type Allergen = (typeof ALLERGENS)[number];

/** The nine FSSAI requires on a label; the rest of ALLERGENS are the EU's. */
export const FSSAI_ALLERGENS: readonly Allergen[] = ALLERGENS.slice(0, 9);

export const ALLERGEN_WORDS: Readonly<Record<Allergen, string>> = {
  gluten: 'Cereals with gluten',
  crustaceans: 'Crustaceans',
  milk: 'Milk',
  egg: 'Egg',
  fish: 'Fish',
  peanuts: 'Peanuts',
  'tree nuts': 'Tree nuts',
  soy: 'Soy',
  sulphites: 'Sulphites',
  celery: 'Celery',
  mustard: 'Mustard',
  sesame: 'Sesame',
  lupin: 'Lupin',
  molluscs: 'Molluscs',
};

/** A set of allergens in the list's order, each once (as a label shows them). */
export function sortAllergens(list: readonly string[]): Allergen[] {
  return ALLERGENS.filter((a) => list.includes(a));
}

/**
 * The words in an item's name that say it carries an allergen (English, Hindi and Konkani, as
 * the picture catalogue), and the phrases that say it does not: coconut milk is not milk, and
 * cashew feni is distilled from the fruit, not the nut. A word matches whole, or with -s/-es.
 */
const HINTS: Readonly<Record<Allergen, { words: readonly string[]; not?: readonly string[] }>> = {
  gluten: {
    words: [
      'wheat',
      'atta',
      'maida',
      'rava',
      'sooji',
      'suji',
      'semolina',
      'bread',
      'breadcrumb',
      'pao',
      'pav',
      'poi',
      'bun',
      'naan',
      'roti',
      'chapati',
      'kulcha',
      'paratha',
      'pasta',
      'spaghetti',
      'penne',
      'noodle',
      'vermicelli',
      'sevai',
      'barley',
      'rye',
      'oat',
      'beer',
      'lager',
      'ale',
      'stout',
      'biscuit',
      'cake',
      'croissant',
      'cracker',
      'crouton',
      'soy sauce',
      'seitan',
    ],
    not: ['ginger ale', 'ginger beer', 'root beer', 'rice noodle', 'rice flour', 'gluten free'],
  },
  crustaceans: {
    words: [
      'prawn',
      'shrimp',
      'crab',
      'lobster',
      'crayfish',
      'langoustine',
      'scampi',
      'jhinga',
      'kolambi',
      'sungta',
    ],
  },
  milk: {
    words: [
      'milk',
      'butter',
      'cheese',
      'cheddar',
      'mozzarella',
      'parmesan',
      'paneer',
      'cream',
      'curd',
      'yoghurt',
      'yogurt',
      'dahi',
      'ghee',
      'khoa',
      'khoya',
      'mawa',
      'buttermilk',
      'chaas',
      'lassi',
      'whey',
      'kulfi',
      'rabdi',
      'malai',
      'custard',
    ],
    not: [
      'coconut milk',
      'coconut cream',
      'almond milk',
      'oat milk',
      'soy milk',
      'soya milk',
      'cocoa butter',
      'peanut butter',
      'cream of tartar',
    ],
  },
  egg: {
    words: ['egg', 'mayonnaise', 'mayo', 'omelette', 'omelet', 'meringue', 'anda', 'custard'],
    not: ['eggplant', 'egg plant'],
  },
  fish: {
    words: [
      'fish',
      'surmai',
      'kingfish',
      'pomfret',
      'mackerel',
      'bangda',
      'salmon',
      'tuna',
      'sardine',
      'tarli',
      'anchovy',
      'anchovies',
      'rawas',
      'basa',
      'bombil',
      'snapper',
      'hilsa',
      'rohu',
      'cod',
      'haddock',
      'worcestershire',
    ],
  },
  peanuts: { words: ['peanut', 'groundnut', 'moongphali', 'mungfali', 'monkey nut'] },
  'tree nuts': {
    words: [
      'cashew',
      'kaju',
      'almond',
      'badam',
      'walnut',
      'akhrot',
      'pistachio',
      'pista',
      'hazelnut',
      'pecan',
      'macadamia',
      'brazil nut',
      'praline',
      'marzipan',
      'frangipane',
    ],
    not: ['cashew feni', 'feni', 'cashew apple'],
  },
  soy: { words: ['soy', 'soya', 'tofu', 'edamame', 'miso', 'tempeh'] },
  sulphites: {
    words: [
      'wine',
      'vermouth',
      'sherry',
      'champagne',
      'prosecco',
      'cava',
      'sangria',
      'raisin',
      'kishmish',
      'dried apricot',
      'sulphite',
    ],
  },
  celery: { words: ['celery', 'celeriac'] },
  mustard: { words: ['mustard', 'rai', 'sarson', 'kasundi'] },
  sesame: { words: ['sesame', 'til', 'tahini', 'gingelly'] },
  lupin: { words: ['lupin', 'lupine'] },
  molluscs: {
    words: [
      'squid',
      'calamari',
      'clam',
      'tisreo',
      'mussel',
      'oyster',
      'octopus',
      'scallop',
      'cuttlefish',
      'snail',
      'escargot',
    ],
    not: ['oyster mushroom'],
  },
};

/** " prawns medium " for "Prawns, medium": lower case, no accents, words between spaces. */
function wordsOf(text: string): string {
  const plain = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ');
  return ` ${plain.trim()} `;
}

function has(text: string, phrase: string): boolean {
  return [phrase, `${phrase}s`, `${phrase}es`].some((p) => text.includes(` ${p} `));
}

/**
 * The allergens an item's name says it most likely carries ("Prawns, medium": crustaceans).
 * Only a hint for whoever onboards to confirm (the dry run lists what its tags leave out);
 * nothing is ever tagged from it.
 */
export function allergenHints(name: string): Allergen[] {
  const text = wordsOf(name);
  return ALLERGENS.filter((a) => {
    let t = text;
    for (const n of HINTS[a].not ?? []) {
      for (const p of [n, `${n}s`, `${n}es`]) t = t.replaceAll(` ${p} `, ' ');
    }
    return HINTS[a].words.some((w) => has(t, w));
  });
}

/** "milk; tree nuts" (file 19) as a list, or the first word that is not an allergen. */
export function parseAllergens(text: string): { ok: Allergen[] } | { bad: string } {
  const words = text
    .split(';')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  for (const w of words) {
    if (!(ALLERGENS as readonly string[]).includes(w)) return { bad: w };
  }
  return { ok: [...new Set(words)] as Allergen[] };
}
