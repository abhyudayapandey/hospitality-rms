// What a batch's label says under FSSAI (ADR 076): veg or non-veg (the green or red mark;
// egg is non-veg by the mark, said in words) and the allergens FSSAI requires to be declared.

export const FOOD_TYPES = ['veg', 'non_veg', 'egg'] as const;
export type FoodType = (typeof FOOD_TYPES)[number];

export const FOOD_TYPE_WORDS: Readonly<Record<FoodType, string>> = {
  veg: 'Veg',
  non_veg: 'Non-veg',
  egg: 'Contains egg',
};

/** FSSAI's declared allergens (Labelling & Display Regulations 2020), in file 19's words. */
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
] as const;
export type Allergen = (typeof ALLERGENS)[number];

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
};

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
