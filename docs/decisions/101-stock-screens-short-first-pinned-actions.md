# 101. Stock screens: short items first, shelves, "Count needed", actions in reach

Date: 2026-10-10. Status: accepted. Plan: `docs/plans/ux-audit.md` (PR 9).

## Context

The audit walked the stores as kitchen, bar, store, purchase and cost people. Asking for
supplies was one list of 42 items; the stock check said "Not verified" on every row; staff read
"-1,840 ml" and took it for a fault; and on a long Stock list the store's jobs were a long
scroll away.

## Decision

1. **Ask for supplies** lists the items below par first, under "Running short", with "Fill all
   N short items up to par" kept as the main button; the rest follow under their category, A to
   Z, with the search box (`lib/short-first.ts`). Each quantity has − and + (`Stepper`); nothing
   is filled in (ADR 053, 054), and a + on an empty box starts from what would bring the item to
   par. The "Only items that are running short" tick is gone: they are first.
2. **The stock check list** groups items by shelf where file 11 gives one (ADR 043), "Other"
   last; each row has its picture and an icon: a tick when verified (who and when under the
   name), a clock when not yet. No words on every row.
3. **"Count needed"** instead of a figure below zero on the Stock list, for whoever may not
   correct it. Who may is the database's: `core.can('STOCK_ADJUSTMENTS', 'modify')` or
   `core.can('STOCK_CHECK', 'modify')` at that store, asked per store on the page, never a role
   name in TypeScript. Managers, store keepers and cost controllers still see the figure (and
   "below zero: count it"), and every item page keeps its figure.
4. **Actions in reach** (`components/pinned-actions.tsx`): on Stock, Orders and Transfers the
   main actions still come after the list in the page (ADR 051: information first, actions
   after) and are sticky, so while a long list runs past the screen they stay pinned just above
   the bottom nav, and at the list's end they settle below its last row. A short list never
   moves them. Why not at the top: the list is what people came to read; the action is what
   they do once they have read it, and pinning keeps both true without a second copy of the
   buttons. On Stock the jobs are one row of pictures and words; on Running low the pinned bar
   is "Ask for these".

The Stock tabs themselves are unchanged (four, then More; CLAUDE.md).

## Consequences

- `e2e/ux-audit-p1.spec.ts` "the list first" now scrolls to the end before comparing where the
  jobs sit, since they are pinned on screen until then.
- `e2e/ux-kitchen-stock.spec.ts` covers the four.
