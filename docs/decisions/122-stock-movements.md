# 122. Stock movements, and the purchase manager

Date: 2026-10-11. Status: accepted. Migration `20261219140000_stock_movements`.

## Context

The GM and the purchase manager want every purchase, delivery and transfer of the outlet's
stores for a day, a week, a month or any period. Passport had lost its Purchase Manager when
its Main Store went (ADR 115).

## Decision

1. **Reports → Stock movements** (`/reports/movements`, `rpt.stock_movements(place, from, to)`):
   one line per order placed (`ordered`, with how much has arrived), receipt (`received`) and
   transfer sent (`transfer`, in / out / within), on its store's business day, with its items
   and their values. At a store or all of an outlet's stores ("All stores" first, ADR 038).
   Today, yesterday, 7 days, 4 weeks, this month or any dates; tabs All / Ordered / Received /
   Transfers, each tile its tab's list added up; CSV one row per item.
2. **Who opens it** is who opens purchasing at that store (its cost readers, the GM, whoever
   reads its bills: `rpt.movement_stores`), with Stock in the plan, Buying or not.
3. **The Purchase Manager** reads the bills and what was bought (`READS_BILLS` in the
   catalogue and Test Company's file 06). Passport has her again, in **Purchase** (the old
   Purchase & Stores' code) with no store: she runs the department, sees the stock of every
   store and reads the bills.

## Tests

`stock-movements.db.test.ts`: orders and receipts add up to their lines and the ledger,
transfers out of the central kitchen at the ledger's value, who opens it and who not, a year
at most. `reports-access.db.test.ts` has its rule for every user.
