import { describe, expect, it } from 'vitest';
import { matchPicture, PICTURE_KEYS, PICTURES, pictureFor } from './pictures';

describe('the picture catalogue (ADR 084)', () => {
  it('has one picture per key, each with words', () => {
    expect(new Set(PICTURE_KEYS).size).toBe(PICTURE_KEYS.length);
    for (const p of PICTURES) {
      expect(p.key).toMatch(/^[a-z0-9-]+$/);
      expect(p.words.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  it('gives each word to one picture only', () => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const p of PICTURES) {
      for (const w of p.words) {
        const k = w.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
        if (seen.has(k) && seen.get(k) !== p.key) twice.push(`${w}: ${seen.get(k)} and ${p.key}`);
        seen.set(k, p.key);
      }
    }
    expect(twice).toEqual([]);
  });

  it('reads the thing itself from a name, in English, Hindi or Konkani', () => {
    const cases: [string, string | null, string][] = [
      ['Garlic', 'Produce', 'garlic'],
      ['Lehsun', null, 'garlic'],
      ['Cloves', 'Spices', 'clove'],
      ['Jeera', null, 'cumin'],
      ['Kashmiri chilli, dried', 'Spices', 'dried-red-chilli'],
      ['Test Red Chilli Powder', 'Dry Grocery', 'chilli-powder'],
      ['Green chillies', 'Produce', 'green-chilli'],
      ['Test Refined Flour (Maida)', 'Dry Grocery', 'maida'],
      ['Test Wheat Flour (Atta)', 'Dry Grocery', 'wheat-flour'],
      ['Goan red rice (ukde)', 'Grocery', 'red-rice'],
      ['Chicken, curry cut', 'Meat', 'chicken'],
      ['Goan chouriço', 'Meat', 'sausage'],
      ['Coconut milk', 'Grocery', 'coconut-milk'],
      ['Coconut oil', 'Grocery', 'coconut-oil'],
      ['Coconut, fresh', 'Produce', 'coconut'],
      ['Goan coconut curry base', null, 'gravy'],
      ['Recheado masala', null, 'masala-paste'],
      ['Test Garam Masala', 'Dry Grocery', 'garam-masala'],
      ['Steamed Basmati Rice', null, 'cooked-rice'],
      ['Pineapple tepache liqueur', null, 'tepache'],
      ['Test Single Malt 750ml', 'Liquor', 'single-malt'],
      ['Test Blended Whisky 750ml', 'Liquor', 'whisky'],
      ['Dark rum 750ml', 'Spirits', 'dark-rum'],
      ['Test White Rum 750ml', 'Liquor', 'white-rum'],
      ['Coffee liqueur 750ml', 'Spirits', 'coffee-liqueur'],
      ['Cashew feni 750ml', 'Spirits', 'feni'],
      ['Feni nip 180ml', 'Minibar', 'feni-nip'],
      ['Goan cashews 100g', 'Minibar', 'cashew'],
      ['Test Tonic Water 300ml', 'Mixers', 'tonic'],
      ['Mineral water 1l', 'Minibar', 'water'],
      ['Test Cranberry Juice', 'Mixers', 'cranberry-juice'],
      ['Test Garbage Bags (Pack of 30)', 'Cleaning', 'garbage-bags'],
      ['Pool chlorine granules', 'Pool', 'pool-chlorine'],
      ['Bedsheet, king', 'Linen', 'bedsheet'],
      ['Test Hand Towel', 'Linen', 'hand-towel'],
      ['Poi (Goan bread)', 'Bakery', 'poi'],
    ];
    for (const [name, category, key] of cases) {
      expect([name, pictureFor(name, category)]).toEqual([name, key]);
    }
  });

  it('falls back to the category, and says so', () => {
    expect(matchPicture('House special', 'Spices')).toEqual({ key: 'spices', specific: false });
    expect(matchPicture('Something new', null)).toEqual({ key: 'box', specific: false });
    expect(matchPicture('Garlic', 'Spices').specific).toBe(true);
  });
});
