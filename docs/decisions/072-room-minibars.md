# 072 — The rooms' minibars

Status: accepted · 2026-10-07 · migration 20261127110000

A hotel's in-room minibar: Housekeeping checks it at checkout or the daily service, what was
used is charged to the guest, and it is refilled. Asked for by the Passport Hotel pilot, where
Housekeeping runs the in-room bar and snacks.

## Decision

1. **Rooms and sets (files 40 and 41, any customer).** A hotel's rooms, each with an optional
   minibar set: the items it holds, their par and the price charged to the guest, refilled from
   one store of the outlet. Keyed by outlet and room number or set name; a later load corrects
   them and never removes one. A set's items are as file 41 lists them.

2. **A check.** For each item of the set the person counts what is left (nothing filled in,
   ADR 053; "All there: nothing used" fills par). What is missing was used: it is charged at
   the set's price and refilled from the store, posted as a `consumption` out of the store at
   its average cost (rule 3), as far as the store has it; the check says when the store was
   short. A check counts every item once (`INVALID_LINES`); a room with no set has no minibar
   (`NO_MINIBAR`). Idempotent by key. A check that used nothing has nothing to charge.

3. **Charging.** Front Office adds the charge to the guest's bill (the app has no folio) and
   marks it "Added to the bill" (`ops.mark_minibar_charged`). The To charge tab lists what is
   still to add.

4. **Who.** A new domain `MINIBAR` (org tree, at the outlet) and group `MINIBAR_KEEPER`, given by
   the duty `CHECKS_MINIBARS` ("Checks the rooms' minibars") at `whole_outlet`. The catalogue
   gives it to the Executive Housekeeper, Housekeeping Supervisor, Room Attendant, Front Office
   Manager and Front Desk Executive; Test Company's file 06 lists it for them. The outlet's
   managers modify (`OUTLET_MANAGER`), area managers view. Read and written only through
   `ops.*` functions.

5. **What it sold.** The Sold tab: each item's quantity used over 7 or 30 business days, its
   revenue at the set's price and its cost at the store's average cost (`ops.minibar_usage`).

6. **Test data.** Test Company's Hotel 1.0 has rooms 101 to 202 and a Standard set (beer, cola,
   tonic from the Bar Store); 202 has none. File 42 (test customers only) loads past checks as
   the person named, at their time (`ops.record_test_minibar_check`).

## Not now

- No module switch: the screen shows only where there are rooms and the duty.
- Posting the charge to a property management system or POS: Front Office does it by hand.
- Per-room-type pricing beyond a set per type, and expiry of minibar items.
