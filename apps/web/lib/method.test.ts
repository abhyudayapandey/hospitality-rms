import { describe, expect, it } from 'vitest';
import { ingredientsInStep, stepMinutes } from './method';

const ing = (...names: string[]) => names.map((name) => ({ name }));

describe('ingredientsInStep (ADR 100)', () => {
  it('finds whole names, any case, singular or plural', () => {
    const list = ing('Onion', 'Tomatoes', 'Garlic', 'Ginger garlic paste', 'Salt');
    expect(
      ingredientsInStep('Fry the ONIONS, then add the tomato', list).map((i) => i.name),
    ).toEqual(['Onion', 'Tomatoes']);
  });
  it('never part of a word', () => {
    expect(ingredientsInStep('Add the onionskin and saltpetre', ing('Onion', 'Salt'))).toEqual([]);
  });
  it('a longer name wins over the name inside it', () => {
    const list = ing('Milk', 'Coconut milk');
    expect(ingredientsInStep('Pour in the coconut milk', list).map((i) => i.name)).toEqual([
      'Coconut milk',
    ]);
    expect(
      ingredientsInStep('Add the milk, then the coconut milk', list).map((i) => i.name),
    ).toEqual(['Milk', 'Coconut milk']);
  });
  it('else by its last word, when no other ingredient ends in it', () => {
    const list = ing('Basmati rice', 'Test Tomatoes', 'Coconut milk', 'Milk');
    expect(
      ingredientsInStep('Wash the rice; cook the tomatoes in milk', list).map((i) => i.name),
    ).toEqual(['Basmati rice', 'Test Tomatoes', 'Milk']);
  });
  it('in the order the step names them, each once', () => {
    const list = ing('Salt', 'Garlic');
    expect(ingredientsInStep('Garlic, salt, more garlic', list).map((i) => i.name)).toEqual([
      'Garlic',
      'Salt',
    ]);
  });
});

describe('stepMinutes (ADR 100)', () => {
  it('its own minutes first, else from the words', () => {
    expect(stepMinutes('Simmer', 12)).toBe(12);
    expect(stepMinutes('Simmer for 10 min', null)).toBe(10);
    expect(stepMinutes('Cook 5-7 minutes', null)).toBe(7);
    expect(stepMinutes('Rest overnight', null)).toBeNull();
    expect(stepMinutes('Use 2 mint leaves', null)).toBeNull();
  });
});
