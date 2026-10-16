# 165. Everyone in a kitchen, bar or restaurant knows the menu

Date: 2026-10-16. Status: accepted. No migration: product access and the catalogue only.

## Context

The QA walk of [TEST] Restaurant (CK-02, CM-02) found that a commis, a bartender or a steward
could not look up what goes into a dish or how it is made, and a commis or a bartender could
not see what their own store has. Since ADR 123 recipes were only for the kitchen's and the
bar's managers; a cook saw a recipe only on their prep task.

The owner decided: everyone in a kitchen, bar or restaurant (file 01 `department_type`
kitchen or service) reads the menu with each dish's recipe, ingredients and method, with no
money (no prices, no costs, no margins), and the stock of their own department's store(s),
read only.

## Decision

1. **A new group, MENU_READER**: `RECIPES_TEAM` view only. `RECIPES_TEAM` was always the
   recipes without costs (ADR 014); prices and costs stay behind `MENU` (RECIPE_READER's
   `DERIVED_MENU`, the outlet's managers, the cost controller). So money stays where ADR 123
   and 145 put it, in SQL: `menu.menu_outlet` (the prices) shows them no row,
   `menu.outlet_costing`, `inv.prep_costing` and `inv.recipe_line_costs` refuse them, and
   `inv.sees_store_money` is false for them.
2. **A new duty, READS_MENU** ("Reads the menu"): MENU_READER at the whole outlet. A store
   whose recipes it reads is one linked to a department of the outlet (`inv.can_read_recipes_at`),
   so it reads every dish sold and every prep item made at the kitchen's and the bar's stores;
   a prep item made at the central kitchen is a name on the recipe, as before.
3. **A new duty, SEES_DEPARTMENT_STOCK** ("Sees the department's stock"): SUPPLY_VIEWER
   (`STOCK_LEVELS` view) at the department's store(s). No count, wastage, transfer, order,
   bill or stock check: a figure below zero still reads "Count needed" (ADR 101).
4. **The catalogue gives them** (`ROLES` in `catalogue.ts`, like HANDLES_LINEN): every role
   that works, leads or runs a kitchen or service department gets READS_MENU, unless it holds
   READS_OUTLET_RECIPES (the whole menu with money already); and where the department keeps a
   store (Kitchen, Bar, Brewhouse), SEES_DEPARTMENT_STOCK, unless it uses or keeps the store
   already. A restaurant keeps no store, so its people get the menu only. A department head
   with READS_RECIPES keeps their own store's money and reads the rest of the menu without it.
   Housekeeping, the front office, security, engineering, the offices and the stores team
   gain nothing. Both test customers' file 06 rows carry the two duties; Passport and
   [TEST] Restaurant list catalogue roles by code and get them on their next import.
5. **Screens**: the Menu tile reads "Recipes" for them (no `MENU`), opens the recipe list and
   a dish's Ingredients and Recipe tabs, with no "Costs at" line and no ₹. The Stock tile opens
   their department's store; Opened packs is then its tab, not a tile of its own. Menu is part
   of their own work on Me (`isOwn`, `RECIPES_TEAM`). MENU_READER and SUPPLY_VIEWER are
   frontline groups (`nav.ts`): their nav stays Home, To do list, Me.

## Consequences

- `inv.stock_level` and `inv.stock_ledger` carry average and unit cost in their rows, and
  `rpt.store_day` the store's value per day, readable by anyone with `STOCK_LEVELS` view there,
  as for a cook (STOCK_USER) before this change. No screen shows it to them; masking those
  columns for every stock reader is a change of its own.
- Tests: `menu-for-food-teams.db.test.ts` (who reads, no money in SQL, read-only stock, who
  gains nothing); `menu-access.db.test.ts`, `me-tiles.test.ts`, `files.test.ts`, the e2e
  `menu.spec.ts`, `ux-people.spec.ts`, `demo-fixes.spec.ts`, `place-switcher.spec.ts` and
  `who-does-what.spec.ts` follow the new rule.
- Deploy: the product sync adds the group and duties; Passport and the test customers are
  imported again (or started again) to give their people the new access.
