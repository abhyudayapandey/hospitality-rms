# 123. Who reads recipes and menu prices

Date: 2026-10-11. Status: accepted. Migration `20261220100000_procedure_ids_once`.

## Context

Every person in a kitchen or bar could open the menu, its prices and every recipe. The
owners want recipes and costs kept to the people who run the kitchen and the bar.

## Decision

1. **Menu prices and recipes** are read by the GM, AGM and Restaurant GM, the account owner,
   the restaurant manager, the kitchen's managers from the sous chef up, the bar manager,
   the F&B manager and the cost controller. STAFF, SUPERVISOR and DEPARTMENT_HEAD lose
   `RECIPES_TEAM` and `DERIVED_MENU`; STOCK_USER and STORE_KEEPER lose `RECIPES`.
2. A new duty, **READS_RECIPES** (group `RECIPE_READER`: `RECIPES_TEAM` and `DERIVED_MENU`
   view, at the home department), is held by those roles in the catalogue. The F&B manager
   holds it also at the bar and banquets.
3. The **account owner** reads the derived menu (`DERIVED_MENU` is now an admin domain) and
   changes none of it. The central kitchen's manager (`HUB_MANAGER`) keeps `RECIPES` and
   `MENU` view for what the kitchen makes.
4. **A cook given a prep task** still sees that task's recipe on the task
   (`ops.prep_task_recipe`), scaled, with its method.
5. `inv.visible_procedure_ids()` reads the visible prep items and dishes once into variables
   (plpgsql). As SQL, its sub-selects were pulled up and run per row, so a recipe read took
   6 to 10 s and slowed the RLS run; now about 0.3 s.

## Tests

`menu-access.db.test.ts`: frontline staff, shift leads and store keepers read no recipe; the
bar manager the bar's, the sous chef and executive chef the kitchen's; the CK manager its
gravies, its commis none; the account owner every one and edits none.
