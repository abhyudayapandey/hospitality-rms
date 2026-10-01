# 015 — Production, sales and cost control (Prompt 9b)

Status: accepted · 2026-10-01

This builds on ADR 014 (menus, recipes, costing).

- **Migrations** (forward-only): `20261010100000_production_sales`, `20261010110000_production_reads`.
- **Deploy:** no stack change; the Deploy workflow only.

## The ledger

- **Six decimals.** `inv.stock_ledger.qty`, `inv.stock_level.on_hand` and
  `inv.stock_count_line.system_qty` are now `numeric(18,6)`, so that a 100 ml pour from a 750
  ml bottle is 0.133333 of a bottle rather than 0.133.
  - Three decimals would leave a false variance after every count.
  - Every other quantity keeps `numeric(14,3)` (the CLAUDE.md convention).
  - Screens round for display: whole g and ml, 2 decimals for bottles, cans and packs.
- **New movements:**
  - `production_out`: an ingredient used for a batch;
  - `production_in`: the batch made;
  - `sales_depletion`: a menu item sold, by its recipe. It is signed, so a corrected day can
    put stock back.
- **Below zero, for sales only.** The `on_hand >= 0` check moved into the ledger trigger.
  - An outflow may leave stock below zero only if it is `sales_depletion`.
  - Production, wastage, other use, transfers and counts are still refused with
    `INSUFFICIENT_STOCK`.
  - A sale is never blocked: a missing receipt or a late count must not stop service.
- **The average after negative stock.** A receipt (or transfer in, or batch made) into empty
  or negative stock takes its own cost as the new average.
- **Outflows with no average yet** are valued at the item's standard cost per stock unit.
  Sales depletion posts at the same unit cost the menu costing uses, so a prep item without
  stock is valued through its recipe.

## Batches and expiry

- **Every batch made** gets a batch number (`YYYYMMDD-n` per store and day) and an expiry
  from the prep item's shelf life. Both are stored on its `production_in` row.
- **What is left of each batch is worked out, not stored.** The store's on-hand belongs to
  the newest batches first, first in, first out (`inv.batch_rows`).
- **Transfers carry the expiry.** A transfer out of a prep item takes the expiry and batch of
  the oldest batch left at the sending store; the receiving row copies them. This is done by
  a trigger, so the existing transfer functions are unchanged.
- **Expired batches** appear on the Production screen with **Record wastage**, which opens
  the wastage form filled in (item, quantity left, reason "expired"). There is no nightly
  job: the prompt shows where the cooks record their batches.

## Production

- **`inv.record_production(store, prep item, qty made, actual lines, key)`**:
  - needs PRODUCTION modify at the store, and the item made there (`NOT_MADE_HERE`);
  - ingredients leave by the recipe in force, scaled to the quantity made, with trim loss.
    The cook may change any line, in recipe units;
  - the batch arrives at the cost of what it used, divided by the quantity made;
  - it is one transaction: a short ingredient posts nothing;
  - the same idempotency key returns the first batch.
- **Who records:** stock users and store keepers at their store, hub managers and outlet
  managers. Cost controllers can only view production.
- **A hub's reach.** The central kitchen's chef holds STOCK_USER at the central kitchen store
  with its descendants. In the delivery tree the hotels' supply points sit under that store,
  so the chef's stock access already reaches the hotel stores. That comes from the job role's
  scope and isn't new here.

## Sales: the path the POS import will use

- **`menu.post_sales(outlet, date, lines, source, key)`**, where `source` is `manual` or
  `pos`; nothing else posts sales (`INVALID_SOURCE`).
  - `lines` are the day's totals per menu item. Posting again moves stock by the difference
    only, so a correction is safe and a repeat is a no-op.
  - Each item must be on the outlet's menu that day (`INVALID_ITEM`).
  - The poster needs SALES modify at the store the item is sold from: outlet managers and
    cost controllers. Department heads and area managers can only view sales.
  - Depletion uses the recipe in force on the business date. It is posted at the end of that
    day in the store's time zone, or now for today, so a period report counts it on the
    right day.
  - Prices and recipes are dated from the day they were loaded or changed. A day before that
    has nothing on the menu.
- **Telling the store keeper.** After posting, every item the posting took below zero is
  sent to the store's store keepers as a `negative_stock` notification linking to the
  store. The stock list marks those items "below zero: count it".
- **The POS import** (later) will map POS items to menu items and call `menu.post_sales`
  with `source = 'pos'`, alongside any manual entry.

## Cost control

- **`inv.variance(store, from, to)`** gives, per item, for whole days in the store's time
  zone:
  - opening;
  - receipts, transfers in and out, wastage, batches made and ingredients used for them,
    sales use and other use;
  - expected closing (everything but counts);
  - variance: the period's count adjustments, as quantity and value;
  - closing, whether the item was counted, and any count still awaiting approval.
- **Unexplained loss** is a negative variance beyond the item's count tolerance (absolute,
  or a percentage of what was available). It is highlighted.
- **`menu.cost_report(outlet, from, to)`** gives food and beverage cost % for the period:
  - revenue: sales × price before tax;
  - theoretical cost: what the sales took, at the cost it was posted;
  - actual cost: theoretical plus the wastage, other use and count variance at the stores
    the outlet sells from. A store's losses are split between Food and Bar by its share of
    their revenue.
- **Access:** both need MENU view at the store (cost controllers, outlet managers, department
  heads through their store, hub and area managers), like the menu costs.

## Access matrix additions

| Group                                 | PRODUCTION     | SALES          |
| ------------------------------------- | -------------- | -------------- |
| STOCK_USER, STORE_KEEPER, HUB_MANAGER | modify         |                |
| OUTLET_MANAGER                        | modify         | modify         |
| COST_CONTROLLER                       | view           | modify         |
| DEPARTMENT_HEAD, AREA_MANAGER         | view (DERIVED) | view (DERIVED) |
| AI_AGENT                              | view           | view           |

## Screens

- **Stock → Production:** pick a prep item made at the store, then enter what the batch
  made. The ingredient quantities follow the batch size, and any can be changed. Below is a
  list of batches with use-by dates, and expired ones are flagged.
- **Menu → Sales:** the outlet's menu for a day. Enter how many of each were sold and save
  the day; already-posted numbers are shown.
- **Menu → Variance:** a store and a period (the last 7 days by default). It shows the
  outlet's food and beverage cost % (actual, and recipe), and per item the movements, the
  expected closing and the variance, with unexplained loss highlighted.
