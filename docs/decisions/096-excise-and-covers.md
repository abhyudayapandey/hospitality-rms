# 096 — Excise register, FLR and permits; covers and spend per cover

Status: accepted · 2026-10-10 · migrations 20261211210000, 20261211220000

A bar in Goa keeps a daily excise register and a monthly FLR of its liquor, and the transport
permit for what arrived. A restaurant's manager tells the GM how many covers each meal served
and what a cover spent. Part of `docs/plans/building-blocks.md`, PR 4; the Excise block
(ADR 085, it needs Stock) and Menu and sales.

## Decision

1. **Excise items** are marked in file 10 (`excise`: liquor, wine, beer).
2. **The register is worked out from the stock ledger**, never typed (rule 3): for each excise
   item a store keeps, its opening at the start of the business day (04:00 where the store is,
   ADR 057), received (receipts and transfers in), sold, sent on, used, wasted, count
   corrections, and its closing (`inv.excise_register`). The FLR is the same by month
   (`inv.excise_month`). So the closing is always what the store holds and each day opens
   where the one before closed.
3. **Transport permits** (`inv.excise_permit`): the number, the day it came and a note, once per
   store. Free bottles (FOC) are written in the note; they arrive as a receipt at no cost like
   any other.
4. **Who**: whoever holds EXCISE at the store (the GM and Bar Manager change, the cost
   controller reads). The Excise screen has Day, Month (FLR) and Permits tabs.
5. **Covers** (`ops.covers`, domain DERIVED_SALES): a business day's covers per meal period
   (breakfast, lunch, dinner) at an outlet, given on the outlet's day report by whoever opens
   it (`rpt.can_open('outlet_flash')`, the GM and Restaurant Manager), today or in the month
   before, with Menu and sales on. The spend per cover is the day's sales on that report over
   the day's covers (`ops.covers_day`), so it equals what is behind it
   (`reports-reconcile.db.test.ts`).

## Tests

`excise.db.test.ts` (each line adds up to what the store holds; days and the month chain; a
sale shows; who may; one permit each; covers given only by those who open the outlet's day),
the reconcile test for the spend per cover, and the e2e `excise-covers.spec.ts`.
