# 014 — Menu, recipes and costing (Prompt 9a)

Status: accepted · 2026-10-01

Menus, prep items and versioned recipes, costed per outlet. Spec and test data:
`docs/onboarding/test-data/MENU_README.md`, files 18 to 24 and the generated 98 files of each
test customer. Production, sales and variance follow in Prompt 9b (ADR 015).

- **Migrations** (forward-only): `20261009100000_menu_recipes`, `20261009110000_menu_costing`,
  `20261009120000_menu_reads`.
- **Deploy:** no stack change. Run the Deploy workflow, then re-import each test customer; see
  `docs/deploy.md`.

## Where things live

- **A new business schema `menu`** for what is sold: `menu.menu_item` and `menu.menu_outlet`.
  The future POS import and the sales tables (9b) go there too. Rule 1 now covers `hr, inv, ops,
wf, ai, menu`, through `core.rls_violations()` and the coverage tests.
- **Prep items are stock items.** They are `inv.item` rows with `kind = 'prep'`, a prep type
  and a shelf life, stocked in their recipe unit (g, ml, each). They can be counted, wasted and
  transferred like anything else.
- **Units.** `inv.item_unit` converts a raw item's stock unit to its recipe unit (one 750 ml
  bottle = 750 ml).
- **Where prep is made.** `inv.item_node.made_here` says which stores make a prep item; its
  par level is the item's normal par level.
- **Recipes.**
  - `inv.recipe` is one version of a prep item's or a menu item's recipe, with effective dates
    and a batch yield for prep. `inv.recipe_line` holds the ingredient, its quantity in the
    ingredient's recipe unit, and the trim loss.
  - A change is a new version from today or a later date; old versions are never edited. A
    second change for the same date replaces that date's version, and the audit log keeps the
    old lines.
- **Prices.** `menu.menu_outlet` is versioned the same way: an outlet sells an item from one of
  its own stores, at a price before tax.
- **Triggers enforce the rules for every writer**, the loader included:
  - one customer per row;
  - the ingredient's recipe unit (`UNIT_MISMATCH`);
  - no prep item made from itself, through any version in force today or later
    (`RECIPE_CYCLE`);
  - a menu item sold only from a store of its own outlet (`INVALID_STORE`).

## Costing

- **Line cost** = quantity ÷ (1 − trim loss %) × cost per recipe unit.
- **Cost per recipe unit:**
  - a raw item: the store's weighted-average cost while it has stock there, otherwise its
    standard cost, divided by the conversion;
  - a prep item: its weighted average while it has stock, otherwise its recipe in force,
    costed through its sub-recipes at a store that makes it, divided by the batch yield.
- **Rounding.** Nothing is rounded until the figure is shown. The 98 files only reproduce this
  way: rounding a prep's cost per unit first gives 11 mismatches.
- **Worked out on read** (`inv.unit_cost`, `inv.recipe_cost`, `menu.outlet_costing`,
  `inv.prep_costing`). Costs follow every receipt and recipe change at once, with no cache to
  go stale. A cache can come later if a screen needs it.
- **The test.** At standard cost, every batch cost, cost per unit, cost per serve and cost %
  equals both customers' 98 files to the paisa, read through `menu.outlet_costing` as an area
  manager would see it.

## Who reads recipes: a rule over stores, enforced by RLS

- **A recipe and its procedure** are readable by:
  - someone with `RECIPES` (view) at a store that makes it (prep, `made_here`) or sells it
    (menu item);
  - someone with `RECIPES_TEAM` (view) at a **department** linked to such a store: kitchen
    staff read kitchen recipes, bar staff bar recipes;
  - anyone with `MENU` (view) at a store that holds or sells it: managers and cost
    controllers read everything used at their stores, received prep included.
- **Why a department link, not any link.** A guest house's front desk, security and
  housekeeping hold STAFF on the outlet itself, and the outlet is linked to its only store.
  Counting only department links keeps them out; the guest house cook reads its recipes
  through stock access at that store.
- **Gaps in the test data.** Hotel kitchen staff don't read the central kitchen's gravy
  recipes: they receive the gravies but don't make them. The central kitchen's production
  team has no linked store, so its commis reads none until a link is added.
- **A new registration mode for RLS.** `core.domain_table` gained `visible_fn`,
  `visible_row_fn` and `visible_column`, and `core.apply_domain_rls` generates the policy
  from them: `tenant_id = my_tenant() and <column> = any(<visible_fn>())`.
  - The id set is worked out once per query, as in ADR 007.
  - The same rule row by row through `core.can()` (`inv.can_read_recipe`,
    `inv.can_read_prep`, `menu.can_read_menu_item`) is the reference. The RLS equivalence test
    holds the two equal for one user per shape of recipe and menu grant, and for every user
    under `RLS_ALL_USERS=1`.
- **Names and costs.** Staff who read a recipe cannot read `inv.item`, the stock catalogue,
  which carries standard costs. Ingredient names come through `inv.recipe_card` and
  `inv.my_recipes`, which check the same rule and never return a cost.

## Access matrix (product access groups)

| Group                        | RECIPES | RECIPES_TEAM | MENU   | DERIVED_MENU              |
| ---------------------------- | ------- | ------------ | ------ | ------------------------- |
| STAFF, SUPERVISOR            |         | view         |        |                           |
| DEPARTMENT_HEAD              |         | view         |        | view (their linked store) |
| STOCK_USER, STORE_KEEPER     | view    |              |        |                           |
| COST_CONTROLLER, HUB_MANAGER | view    |              | view   |                           |
| OUTLET_MANAGER               | view    |              | modify | view                      |
| AREA_MANAGER                 |         |              |        | view                      |
| AI_AGENT                     | view    |              | view   |                           |

- **Editing** (`inv.save_recipe`, `menu.set_price`) needs MENU modify at **every** store the
  recipe or price is used at. A hotel manager cannot change Butter Chicken, which Hotel 1.1
  also sells; the standalone bar's manager can change its own recipes.
- **Area managers view only for now.** Derived grants don't carry modify.
- **Store keepers** still see stock values, as before, but never prices or cost %.

## The loader (files 18 to 24)

- **Checks across the files:**
  - every code exists;
  - an item's stock unit matches file 10;
  - a line's unit is the ingredient's recipe unit;
  - every prep item and menu item has a recipe;
  - no recipe cycles;
  - a prep item's ingredients are stocked at every store that makes it (11 or 20);
  - a menu item is sold from one of its outlet's stores (03).
- **A warning, not a problem:** a menu item sold from a store that doesn't stock one of its
  ingredients. A sale may take stock below zero (9b); the warning says so.
- **Versions.** A changed recipe or price starts a new version today. A change someone planned
  in the app for a later date stays planned: today's version ends the day before it.

## Screens

- **Menu** (one tab) shows menu costs to those with MENU view, by outlet: cost per serve, and
  cost %, highlighted above 35 % for food and 30 % for the bar.
- **Recipes** shows everyone else the recipes and procedures they may read. Everyone with
  MENU view also has a Recipes tab.
- **The recipe page** shows ingredients for a batch or a serve and the method. It adds line
  costs only with MENU view at the chosen store, and edit and price forms only with MENU modify
  there.
- **No empty tab.** The Menu tab appears for RECIPES_TEAM holders only when one of their
  departments has a linked store that makes or sells something.
- **Quantities are shown per unit:** whole g and ml, 2 decimals for bottles, cans and packs,
  3 for kg and l.
