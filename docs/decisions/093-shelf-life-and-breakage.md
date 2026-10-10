# 093 — Shelf life & labels, and Breakage

Status: accepted · 2026-10-09 · migration 20261211170000

Passport's kitchens date what they open with day-dot stickers, and every department keeps a
breakage book that the GM reads at month end. Part of `docs/plans/building-blocks.md`, PR 3; two
blocks of Stock (ADR 085), each needing Stock.

## Decision

### Shelf life & labels (`shelf_life`, domain `SHELF_LIFE`, delivery tree)

1. **File 10** gives an item its shelf life once opened (`open_shelf_life_hours`), how it is kept
   (`storage`: dry, chilled, frozen) and, for its label, veg or non-veg (`food_type`) and its
   allergens, the same words as file 19's prep items (ADR 076). The plan's "vegetarian" and
   "contains nuts" are these two columns: nuts are an allergen FSSAI lists.
2. **Opening a pack** (`inv.open_pack`, Stock → Opened) records the item, how much (no more than
   the store has), when, and its use-by (opened + the hours). The stock stays in the store. The
   label opens at once to print: a dot in the use-by day's colour (Monday blue to Sunday black,
   as the stickers are), what it is, veg or non-veg, allergens, how to keep it, opened, use-by
   and who opened it.
3. **An opened pack ends** used up (`inv.finish_pack`: nothing leaves the store, what was used
   went out with sales or use) or thrown away (`inv.throw_pack`: what is left, no more than the
   store has, as `expired` wastage through `inv.record_wastage`, so the store's limit, photo and
   the GM's items, ADR 092, all apply).
4. **Open packs are in Expiring and Expired** with the dated batches (`inv.expiry_list` gains
   `pack_id`), for whoever holds SHELF_LIFE at the store while the block is on, so Home's counts
   and the Stock tabs follow without anything new. An expired pack is thrown away from the list.

### Breakage (`breakage`, domain `BREAKAGE`, org tree)

5. **An entry** (`inv.record_breakage`) is at a department: from a store of its outlet (its own
   first), the item, how many, how (dropped, in washing, by a guest, worn out or torn, other),
   who broke it (someone on the staff, and who if known; a guest; not known), a note and its
   worth at the store's average cost. Anyone holding BREAKAGE at the department records it.
6. **It leaves the store through the ledger** as `consumption` with reason `breakage` (rule 3),
   not as a new movement type, so stock and every cost report that counts other use already
   include it without change.
7. **Who reads it**: the department's people read their department's; every department head of
   the outlet (a job role of level 2 or more there, ADR 087) and the outlet's managers read the
   whole outlet's (`inv.reads_breakage`). A month's log and its total, then the last 12 months'
   totals (`inv.breakage_log`, `inv.breakage_months`); the month's total is its log's.

## Tests

`shelf-life-breakage.db.test.ts` (a pack's use-by and label; who may open; expired and thrown
away as expired wastage once; used up; nothing while the block is off; breakage through the
ledger at average cost; own department and outlet only; who reads the outlet's log; a month's
total equals its log), and the e2e `shelf-life-breakage.spec.ts`.
