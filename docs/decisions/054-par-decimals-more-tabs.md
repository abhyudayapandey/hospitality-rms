# 054 — Par, two decimals, and More / Less tabs

Status: accepted · 2026-10-05 (no migration)

Using ADR 053 on the deployed app, the owner found three things that still read badly:

- "have 3 · keep 10 kg" was not understood.
- "Fill to keep level" looked like a footnote.
- Boxes showed the database's six decimals (4.8000000).

The **More** pill was also a fourth kind of control. It sat on its own line and opened a third row.

## Decision

1. **One word: par.** Every screen that shows the level a store is stocked up to says
   **par**:
   - "In stock 15.2 kg · par 20 kg" on Ask for supplies;
   - "Kitchen Store 15.2 kg · par 20 kg" on Send stock;
   - "par 20 kg" on Stock and on an item.

   The Prep list already said it. Kitchen and store staff use the word.

2. **Fill to par is a button that says what it does.**
   - It is full width and outlined, above the list: "Fill all 12 short items up to par".
   - One line under it says it puts in what each item needs, and that any amount can be
     changed.
   - Once used, it reads "Clear the amounts" and takes out only what it put in
     (`components/fill-to-par.tsx`).
3. **Quantities show at most 2 decimals, whole g and ml** (`lib/qty.ts`: `formatQty`,
   `inputQty`).
   - Fill to par and links that pre-fill a quantity (throw away an expired batch) put in at
     most 2 decimals.
   - A typed amount is rounded to 2 decimals when the box is left.
   - Every quantity on screen, reports included, uses `formatQty`.
   - The database still keeps 6 (ADR 015): a 100 ml pour from a 750 ml bottle needs them.
     Only the screen rounds.
4. **Below zero says so.** A department below zero shows "(below zero: count it)", the words
   the Stock screen uses, in red.
5. **More / Less.**
   - The Stock screen's tabs show the first 4 in their usual order.
   - **More (n) ▾** is a text button, not a pill. It shows the rest in the same row and
     becomes **Less ▴**.
   - On a tab from the rest, the row opens already showing them.
   - The order never changes: the tab you are on is no longer moved into the first 4.

   The tab row is named "Stock tabs" (it was "Supply", a name used only in the code).

## Consequences

- Screens round to 2 decimals, so a sum of the shown figures can differ from the shown total
  by a paisa's worth of quantity. The stored figures and reports are unchanged.
