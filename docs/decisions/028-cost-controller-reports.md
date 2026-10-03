# 028 — The cost controller's reports (R-2)

Status: accepted · 2026-10-02

`docs/reporting.md` step R-2. The decisions of 2 October are below. Built as one change, at
the user's request.

- **Migration** (forward-only): `20261022100000_cost_reports`.
- **Test data:** a new test-only file, `33_purchases_TEST_DATA_ONLY.csv` (Test Company).
- **Deploy:** no stack change. Test Company is re-imported for file 33.

## Four reports

| Report               | Opens at          | Shows                                                                                                                                                                  |
| -------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cost of sales**    | an outlet or site | Food and drink cost against the recipes, what was lost at the count, wastage and expired batches; the five items that lost the most, with each item's formula on a tap |
| **Menu engineering** | an outlet         | Each dish by margin and popularity: stars, plowhorses, puzzles and dogs, per menu, with what to do about each group                                                    |
| **Stock position**   | a store           | Value now and at the end of each of the last four weeks; value by category; days on hand; stock not moved in 30 days                                                   |
| **Purchasing**       | a store           | Price changes on what was received; each supplier's fill rate and timeliness; lines delivered short or not at all                                                      |

**Cost of sales replaces the Variance screen** (UX U-14). It leads with the rupees, not
formulas. `/menu/variance` redirects to it, and the Menu tab "Cost of sales" opens it.

## One definition per figure

- **Item variance** is `inv.variance`'s.
  - Its body moved, unchanged, to `inv.variance_of`.
  - `inv.variance` checks access and calls it, so the app sees no change.
  - Cost of sales adds it up store by store, and a test checks that the totals match.
- **Cost %** is `menu.cost_report`'s.
  - Its body is now `menu.cost_calc`, over a given list of stores.
- **Stock value by day** is R-1's `rpt.stores_of`.
- **No new `rpt` tables.** Item detail is read on demand from the source tables, as section
  3 of the reporting plan says.

## Who opens what (rule 2: `core.can` only)

| Report                     | Rule                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Cost of sales              | MENU view at one of the place's stores, or REPORTS at the place. It shows only the stores the person sees the menu costs of. |
| Menu engineering           | MENU view at a store the outlet sells from, or REPORTS                                                                       |
| Stock position, Purchasing | at a store: MENU view or PURCHASE_ORDERS **modify** there, or REPORTS at a place it serves                                   |

These rules decided how the reports were built:

- **A place's own stores.** An outlet's or site's stores are those linked to it or to one
  of its departments (`rpt.place_stores`). This is not the supply point's subtree, because
  the central kitchen's hub sits above the outlets it supplies, and their stores are not
  its own.
- **Not view alone.** Commis and bartenders hold STOCK_LEVELS and PURCHASE_ORDERS **view**
  to use the store (STOCK_USER). That doesn't make them its cost people, and frontline staff
  must see no business numbers (decision 3 of 2 October). So the store reports need MENU
  view (cost controllers, hub and outlet managers) or PURCHASE_ORDERS modify (store
  keepers).
- **Department heads.** They hold MENU view at their department's store. An executive chef
  opens Cost of sales for the kitchen store only, which is "food % of their store" in
  section 5 of the reporting plan.
- **Modules.** Cost of sales and menu engineering need the Menu and sales module (ADR 026).
  When it is off they are not listed, and their functions refuse with `MODULE_OFF`.
- **No new domain and no matrix change.** `reports-access.db.test.ts` checks every user of
  both test customers against each rule, and that frontline staff are offered only My week.

## The measures (decided 2 Oct)

- **Dead stock.** Stock on hand with no movement in 30 days. Opening stock does not count as
  a movement, so an item that only ever had its opening stock is dead stock (decision 2).
- **Days on hand.** Value over average daily use, where use is stock that left for sales,
  production, other use, wastage or transfers.
  - It is averaged over 28 business days, or over the days since the store's first use when
    that is fewer, with a minimum of 7 days. Below 7 days it shows "–" (decision 3).
- **Price change.** For each receipt line: (price paid − the store's previous price for the
  item, from any supplier) × quantity. With no earlier receipt, the comparison is the
  item's standard cost (decision 4).
- **Menu engineering** uses the Kasavana–Smith method (decision 5). The thresholds are fixed
  for now, and can become company settings with the targets in R-4.
  - Popular means a mix of at least 70% of an equal share.
  - High margin means at least the menu's average margin, weighted by what sold.
  - Margin per serve is the price before tax less the recipe cost: the recipe in force on
    the day of each sale, with ingredients at their average cost.
  - A dish that didn't sell is placed by its price and recipe cost on the last day.
- **Supplier fill rate.**
  - **What counts.** Orders released in the period that were received at least in part, or
    are past their due day. The due day is the release day plus the supplier's lead time.
  - **Fill rate.** Received over ordered, by value at the ordered price, never above 100%
    for a line.
  - **On time.** The first delivery came by the due day.
- **Periods.** Yesterday, last 7 days (the default, as the Variance screen had), last 4
  weeks (Purchasing's default, since orders are less frequent than sales), this month, or
  two dates. Cost of sales keeps Variance's whole days.

## Test data: file 33 (test customers only, ADR 017)

`33_purchases_TEST_DATA_ONLY.csv` has one row per order line. The loader handles it once
per customer, through the app's own code, as the people named:

1. The person who orders creates the order (`inv.create_po`, which submits
   PURCHASE_ORDER).
2. The approver approves it (`wf.act`).
3. The order is released on its order day (`inv.record_test_release`). This does what the
   executor's `inv.po.release` handler does, at that time. When the executor runs, it
   finds the order already released and only completes the request.
4. The receiver receives it on the receipt day (`inv.record_test_receipt`, which calls
   `inv.receive_at`, the app's receipt code).

Some details of the purchase functions:

- **The app's receipts.** `inv.receive` now calls `inv.receive_at` with `now()`, so the app
  receives exactly as before.
- **Refusals.** Both test functions refuse:
  - a customer that isn't a test customer (`TEST_CUSTOMER_ONLY`);
  - a time in the future;
  - an order that isn't approved yet.
- **Who can call them.** Only `platform_loader` runs the test functions. The app can't call
  the time-taking bodies or the report bodies.

**Test Company's orders.** The Hotel 1.0 Kitchen Store orders from two suppliers:

- **Fresh produce.** Tomatoes at ₹40, ₹44 and ₹48. One order of onions comes 4 kg short, and
  one order is late.
- **Dairy.** One order is never delivered.

The expected figures are in the test data README, pinned by `cost-reports.db.test.ts`.

## Tests

- **`reports-access.db.test.ts`** (every user):
  - each new report's places match its rule;
  - every unlisted place is refused;
  - frontline staff get only My week;
  - Menu and sales off hides cost of sales and menu engineering and refuses them.
- **`cost-reports.db.test.ts`:**
  - the README figures;
  - cost of sales equals `inv.variance` summed over the stores, and `menu.cost_report`;
  - who sees which stores, and the central kitchen's own store;
  - menu engineering classes and the weighted average;
  - stock value, days on hand and dead stock;
  - price changes, fill rate and short deliveries;
  - the orders' approval history;
  - the test-only functions' refusals and grants.
- **`reports.test.ts`** (unit): periods, top losses, dish classes, the report list.
- **`cost-reports.spec.ts`** (e2e):
  - the cost controller's four reports, with the formula on a tap and the period links;
  - the chef's store reports;
  - a bartender refused.
- **Existing e2e:** the old Variance checks now run against Cost of sales.
