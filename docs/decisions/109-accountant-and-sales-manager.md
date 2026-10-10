# 109. The accountant reads bills and purchasing; the sales manager plans events

Date: 2026-10-10. Status: accepted. Plan: `docs/plans/ux-audit.md` (PR 12). An access change.

## Context

The audit found two Passport roles with nothing to do: the accountant opened a frontline Home
with nothing for them, and the sales manager, who sells the banquets, could not plan an event.

## Decision

1. **A new duty, `READS_BILLS`** ("Reads the bills and what was bought"):
   `ACCOUNTS@outlet_stores`. `ACCOUNTS` is a new product group with `BILLS` view and
   `PURCHASE_ORDERS` view: the vendor bills of the outlet's stores (ADR 050) and the orders
   they pay for, including "Waiting for a bill". No stock levels, counts, wastage or changes;
   no pay.
2. **The purchasing report opens for whoever reads a store's bills** (migration
   `20261216100000_bills_readers_purchasing`): `rpt.can_open` and `rpt.report_places` add
   `BILLS` view at the store to the purchasing rule only. Everyone else who held `BILLS` view
   (the GM, store keepers, cost controllers, hub managers) already opened purchasing there, so
   nobody else gains it. Stock position still needs `MENU` view, `PURCHASE_ORDERS` modify or
   `REPORTS`.
3. **The catalogue** (ADR 060): the Accountant holds `WORKS_SHIFTS; READS_BILLS`, and at a bar
   `VERIFIES_STOCK_CHECKS; READS_BILLS`; the Sales Manager holds `WORKS_SHIFTS; PLANS_EVENTS`
   (the existing duty: events at the whole outlet). Test Solo Bar Co.'s accountant gains
   `READS_BILLS` (file 06 and its 99 preview); Test Company has neither role. The Passport demo
   lists both by code, so its next import adds 2 job role access rows.

## Tests

`packages/db/src/little-to-do-roles.db.test.ts`: the accountant reads the bills of the
outlet's stores (as the GM does) and not another outlet's, cannot change a bill, an order or
stock, opens purchasing (the same price changes as the cost controller) and no stock, cost,
labour or people report, and sees no one else's pay; beyond what someone who only works shifts
holds, exactly `BILLS` and `PURCHASE_ORDERS` view. The sales manager creates an event at the
outlet, not at another, and gains exactly `EVENTS` modify. The RLS all-users workflow ran on
the branch before merging.
