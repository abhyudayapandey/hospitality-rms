# 100. A picture on every item line, and a recipe's method with pictures

Date: 2026-10-10. Status: accepted. Plan: `docs/plans/ux-audit.md` (PR 5, the kitchen, bar and
stores part).

## Context

The UX audit found item lines that still named an item in words only (the stock check list,
the excise register, the orders and transfers lists, the Send stock "to" list) and a recipe
method that was a numbered list of sentences, read by cooks who read little, with a stove
clock beside them.

## Decision

1. **Every item line shows its picture** (`ItemThumb`, ADR 084): the stock check list and its
   sheet, the excise day and month registers, and the Send stock and request forms. A list of
   orders or transfers shows the pictures of its first three items, then "+N" (`ItemThumbs`).
   The Send stock "to" list shows a picture of each store from its name (`lib/store-icon.ts`:
   a glass for a bar, a pot for a kitchen, a bed for housekeeping, else a box).
2. **A recipe's method with pictures** (`components/method-steps.tsx`), on a recipe's Recipe
   tab and a prep task's Method:
   - each step's picture of what to do: `stepIcon(instruction, 'tick')`, which now reads the
     kitchen verb a step starts with first (slice, chop and peel a knife; fry and temper oil;
     roast, bake and grill a flame; boil, simmer, grind, whisk and marinate a pot; strain and
     drain water; chill a fridge). Only at the start, and never in a step about cleaning or
     checking, so every library checklist step keeps its picture;
   - the photos of the ingredients the step names (`lib/method.ts`): an ingredient's whole
     name, word for word, any case, singular or plural, never part of a word; else its last
     word when no other ingredient ends in it ("the rice" names Basmati rice);
   - where the step takes minutes (its own, else "N min" in its words), a big "Start N min
     timer" that counts down on the phone itself, works offline, and vibrates and beeps where
     the phone lets it. No new dependency.

## Consequences

- `apps/web/e2e/ux-kitchen-stock.spec.ts` checks the stock check and excise rows each show a
  picture, and the method's pictures and timer.
- The step pictures are the existing pictograms (`TASK_ICONS`): no new icon, so nothing changes
  in `ops.task_icon_names`.
