# GM feedback, round 1: what is still to do

The Passport Hotel's GM walked the app as each role and sent 22 notes (2026-10-08). Items
1, 3, 7, 9 to 13 and 15 to 19 are done in ADR 076 (make by task, batch labels and fixes).
Item 22 (how is perishable cost worked out) needed no change: every receipt moves the item's
cost to the weighted moving average (`inv.ledger_apply`).

This file is the brief for the rest. Each item is meant to be one PR, planned first as
CLAUDE.md asks. Start from `master` **after ADR 076's PR is merged**: several items touch
the same screens (the task page, the prep list, the count sheet).

Read first: `CLAUDE.md` (rules and conventions), `docs/LLD.md`, the ADRs named below.

---

## 2. Photos of menu items

The GM wants a photo on each dish.

- Menu screens: `apps/web/app/(app)/menu`. Stock items already have photos (ADR 034,
  `components/item-thumb.tsx`, `components/photo-field.tsx`); reuse that path (S3 presigned
  upload, no file kept on the instance).
- Who may add or change a dish photo: whoever may edit the menu (MENU modify), checked in
  the database through `core.can`, never in TypeScript.
- Onboarding: consider an optional photo column or a zip folder in the import; say which in
  the plan.

## 4. Roster redesign

What the GM asked for:

- One row per person in the department manager's view, with a tile per shift and "Off".
- Shift types the SOPs use: **straight** (one block), **leg** (two blocks with a break
  between, e.g. 11–15 and 18–23) and **panzer** (the hotel's long shift). _Open question for
  the product owner: confirm what "panzer" means here before building it._
- "Repeat this week" from one date to another.
- Code: `apps/web/app/(app)/roster`, rostering RPCs in `hr.*` (ADR 008 rules re-run on every
  change), shift templates are file 16.
- A split shift changes attendance (two clock-in pairs a day) and the labour reports
  (ADR 030): the reports must still reconcile (`reports-reconcile.db.test.ts`, ADR 057).

## 5. Icons for tasks and their steps

- A task and each checklist step get an icon, so staff who read little can follow them.
- Icons are in `components/icon.tsx` (line icons, colours from the palette only).
- The library checklists (`packages/domain/src/checklists.ts`) should name an icon per step;
  file 29 may name one too. A step without one gets a default by its kind.
- The prep list already shows an icon per item (ADR 076).

## 6. Photos on tasks and steps, kept 30 days

- A person may add a photo to a task or a step (some steps already require one,
  `photo_required`).
- Keep them 30 days, then delete: an S3 lifecycle rule in `/infra` (CDK) on the task photos
  prefix. **Any `/infra` change needs a `cdk diff` reviewed before deploy; never deploy
  without approval.**
- Compliance documents are kept forever (`compliance/`, ADR 069) and bills 7 years
  (`bills/`, ADR 050); the 30-day rule must not touch those prefixes.

## 8. A dish's recipe: ingredients and steps, with sub-recipes you can open

- A menu item's page shows its ingredients and its method; an ingredient that is itself a
  prep item (a sub-recipe) links to that prep item's recipe.
- Recipes are in `inv.recipe` / `inv.recipe_line`, methods in `inv.prep_procedure`
  (ADR 014). Dishes may not have a method yet: say in the plan where it would come from
  (file 24 extended, or a new file).
- Who sees costs is unchanged: no ₹ for people without MENU cost access.

## 14. Receiving: straight to a department, or into the store; expiry optional

- When the Main Store receives an order, the keeper chooses per line whether it goes into the
  store or straight to the department that asked (a direct issue, posted as receipt plus
  transfer in the ledger, never an UPDATE).
- An optional expiry date column per line.
- Receiving code: ADR 049 to 052 (supply requests, bills, "Nothing is pre-filled where a
  person confirms what arrived"). Stock changes only through `inv.stock_ledger`.

## 20. In-room minibar: refill and billing as tasks

- When a minibar check finds items used, housekeeping gets a **refill task**, front office
  gets a **billing task**, and when front office marks it billed, housekeeping is told.
- Minibar today: ADR 072, files 40 to 42, the `CHECKS_MINIBARS` duty.
- Tasks go through `ops.task` and its handover rules (ADR 074, 075); no status column is
  set directly from app code.

## 21. Count rows show the pack size

- On the stock check sheet, a row shows an icon or label for the pack (a 750 ml bottle versus
  a 180 ml nip), so the counter does not mix them up.
- The sheet already carries `pack_unit` and `pack_size` (`inv.stock_check_sheet`,
  `apps/web/app/(app)/stock/check/[id]/check-sheet.tsx`).

---

## Open questions for the product owner

- **Shift types (item 4)**: what exactly "panzer" means, and which outlets use which types.
- **Leave and HR**: ADR 076 made leave department head, then GM, and dropped the HR step.
  If HR should still see or approve leave, that is a new decision.
