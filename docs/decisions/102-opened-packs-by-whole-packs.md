# 102. Opened packs by whole packs

Date: 2026-10-10. Status: accepted. Plan: `docs/plans/ux-audit.md` (PR 7). The owner: "Each
pack has a defined size... even though there is 4.38 l coconut milk, that doesn't mean I can open
2.39 l. I can only open by the standard size of the carton/pack."

## Decision

1. **File 10 has optional `pack_size` and `pack_name`**: one pack in the item's base unit (a
   400 ml tin of coconut milk stocked in litres is 0.4) and what it is called (tin, carton,
   bottle, packet, block). They live on `inv.item` (`pack_size numeric(18,6)`, `pack_name`), not
   on `inv.item_unit`, which converts a stock unit to a recipe unit and has no row for prep
   items. A name needs a size. The dry run warns about an item with a shelf life once opened and
   no pack size (it is opened by any amount).
2. **Opening asks "How many?"** with − and + from 1, whole numbers, and says "1 tin = 400 ml";
   it records packs × the pack size. `inv.open_pack` refuses a quantity that is not a whole
   number of packs (`NOT_WHOLE_PACKS`, "Open whole packs only. Say how many you opened."). An
   item with no pack size keeps today's free quantity.
3. **The label** says "1 tin · 400 ml" (`inv.pack_label` gives the pack); `inv.pack_items` gives
   the pack for the form.
4. **Test data.** Test Company: milk a 1 l carton, cream a 200 ml carton, ketchup a 1 kg bottle,
   the wines a bottle, the juices a 1 l carton. Passport: milk a 1 l carton, butter a 500 g pack,
   cheddar a 1 kg block, coconut milk a 400 ml tin, the wines a bottle.

## Consequences

- Migration `20261214100000_whole_packs.sql`. Tests: `shelf-life-breakage.db.test.ts` (whole
  packs, a part pack refused, no pack size free), `packages/onboarding/src/packs.test.ts`, and
  the e2e (a commis opens two cartons of cream).
