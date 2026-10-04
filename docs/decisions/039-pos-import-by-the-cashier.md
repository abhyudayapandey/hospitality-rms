# 039 — The POS import by the cashier

Status: accepted · 2026-10-04

Sales were typed in by hand, one total per dish per day (SAL-1, ADR 015). The prospect's
POS (IDSNEXT first, others alike) exports a "Sale by item" report: a title with the
period, the header `Item | Description | Quantity | Rate | Value | Discount`, lines
grouped by POS outlet and menu type, total rows after each group and a Grand Total
(`docs/reporting.md`, "The POS export we will import"). The cashier closes the till with
it every night, so the import is their end-of-day job (SAL-2).

## Decision

1. **The file is read in the browser** with `@outlet-ops/onboarding/pos` (Excel `.xlsx` or
   CSV). Excel is read with fflate, which the onboarding upload already uses, so there is
   no new dependency. Only the lines go to the server, a few KB on a slow network. Total
   rows are skipped, an item sold at two rates is one line, and the lines must add up to
   the Grand Total. The database checks it all again (`menu.import_pos`): quantities and
   amounts of zero or more, the lines against the total, and **one day per file**. A
   title naming several days is refused (`POS_FILE_SPANS_DAYS`); a title naming another
   day than the one picked is refused (`POS_FILE_OTHER_DAY`).
2. **POS codes map to menu items per outlet, never by guessing.** `menu.pos_item` holds
   each outlet's codes. File 23 has an optional `pos_code` column; anything else is
   matched on the import screen by someone who posts the outlet's sales (SALES modify:
   cost controller, outlet manager), with "Match and post the day again". A code not in
   the list is listed with its description, quantity and value, and left out of the sales.
   Two codes for one dish (dine-in and take-away) add up.
3. **One file is the whole day at one outlet.** Every POS outlet group in the file (for
   example `LE CAFE` and `LE CAFE TAKE AWAY & DELIVERY`) is imported into the outlet
   picked in the Place picker; the names are kept on the import. Importing the day again
   replaces it: dishes the earlier import posted and this one does not go to 0.
4. **The POS replaces typed-in sales.** Importing a day reverses that day's typed-in lines
   (stock goes back by recipe), and typing in a day the POS import posted is refused
   (`SALES_FROM_POS`). The Sales screen says so and links to the import.
5. **What the POS took is the revenue.** `menu.sales_line` gains `net` (the line's value
   after discount) and `discount`. Menu engineering, the cost of sales and the report
   tables read `coalesce(net, qty × price)`, so typed-in sales still count at the menu
   price. Discount shows on the import and on a dish's trend (ADR 041); a discount column
   in the outlet flash is for later (`rpt.sales_day.discount` is still 0).
6. **A new `POS_IMPORT` domain and `CASHIER` group** (`POS_IMPORT` modify at the outlet's
   stores). The cashier imports and sees the import's own totals, but reads none of the
   outlet's sales lines, costs or reports, and cannot type sales in or match codes
   (decision 3 of `docs/reporting.md` section 8). The job role default is
   `STAFF@home_department; CASHIER@outlet_stores`. People who post SALES import too.
7. **The cashier's Home** has an "End of day" card (imported or not, and when) and
   "Import sales" as the first tile. The cashier counts as frontline (bottom nav Home,
   Tasks, Me). The screen is `/menu/sales/import`, with its own Place picker list
   (`core.screen_places('pos_import')`, `menu.pos_places()`).

Every write goes through `menu.sales_apply`, the old body of `menu.post_sales`, which is
not granted to the app. `menu.post_sales` keeps its signature for typed-in sales and
refuses `pos` (POS sales come only through the import).

## Consequences

The sample is a month; the cashier must export one day at a time (the POS allows it).
Covers and spend per cover still wait for a POS export with covers. A Petpooja connector
(SAL-1, read-only) can post through the same `menu.sales_apply` later.
