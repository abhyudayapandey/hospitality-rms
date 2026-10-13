import {
  ALLERGEN_WORDS,
  FOOD_TYPE_WORDS,
  sortAllergens,
  type Allergen,
  type FoodType,
} from '@outlet-ops/domain';
import { Icon } from './icon';

// The FSSAI mark on a batch (ADR 076): a green square with a dot for veg, a brown one with
// a triangle for non-veg (egg too, which is said in words beside it).
export function FoodMark({ type, size = 16 }: { type: FoodType | null; size?: number }) {
  if (!type) return null;
  const veg = type === 'veg';
  return (
    <span
      role="img"
      aria-label={FOOD_TYPE_WORDS[type]}
      data-testid="food-mark"
      data-food={type}
      className={`inline-flex shrink-0 items-center justify-center rounded-[2px] border-2 align-middle ${
        veg ? 'border-emerald-600 text-emerald-600' : 'border-rose-700 text-rose-700'
      }`}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 10 10" width={size * 0.55} height={size * 0.55} aria-hidden>
        {veg ? (
          <circle cx="5" cy="5" r="4.5" fill="currentColor" />
        ) : (
          <path d="M5 0.5 L9.5 9.5 L0.5 9.5 Z" fill="currentColor" />
        )}
      </svg>
    </span>
  );
}

/** "Contains milk, tree nuts" in the list's order (ADR 138), or nothing when there are none. */
export function allergenText(allergens: readonly Allergen[]): string | null {
  if (allergens.length === 0) return null;
  return `Contains ${sortAllergens(allergens)
    .map((a) => ALLERGEN_WORDS[a].toLowerCase())
    .join(', ')}`;
}

/** What a dish, a prep item or a batch carries, from everything in it (ADR 138). */
export function AllergenLine({ allergens }: { allergens: readonly Allergen[] }) {
  const text = allergenText(allergens);
  return (
    <p
      data-testid="allergens"
      className={`flex items-center gap-2 text-sm ${text ? 'font-semibold text-amber-800' : 'text-slate-600'}`}
    >
      {text && <Icon name="alert" className="size-4 shrink-0" />}
      {text ?? 'No allergens declared'}
    </p>
  );
}
