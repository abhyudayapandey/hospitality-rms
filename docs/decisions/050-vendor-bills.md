# 050 — Vendor bills: kept at the store, with the order or for a service

Status: accepted · 2026-10-05 (migration 20261107100000)

BIL-1 to BIL-3, the last pilot-readiness item: the bill a supplier sends is kept in the app,
with the order it pays for, or on its own for a service with no stock. Money data is kept 7
years (decided 5 Oct, replacing 5).

## Decision

1. **Where a bill sits.** Every bill sits at a store (a delivery node), like the orders it pays
   for. A bill for goods sits at its order's store. A bill for a service sits at a store the
   person keeps: the Main Store for the outlet's own services (pest control, repairs), the
   Housekeeping Store for linen washing. This keeps bills in the store tree, where the people
   who handle money already have access, and needs no new kind of place.
2. **Access: a new `BILLS` domain (delivery tree).**
   - The GM (`OUTLET_MANAGER`) and store keepers (`STORE_KEEPER`) add and read bills: modify.
   - The cost controller and the hub manager read them: view.

   A department head with no store (the chief engineer) has none. Their repair bills go to
   the GM or the Main Store's keeper. The account owner is an admin group, which holds no
   business data (ADR 009), so the owner sees bill totals in reports later, not the bills.
   The area manager is left out for now (BIL-3 does not ask for it).

3. **Goods.** `inv.add_bill(null, po, ...)`. The order must have been placed (released with
   `ordered_at`). Whoever may receive it adds the bill: the store's keepers, or the order
   desk for a supply request (ADR 049), with no BILLS access needed at that store. The
   supplier is the order's; an order placed with no supplier named asks for one. The order
   page has a **Bill** section, open after receiving, and lists the bills already added.
4. **Services.** `inv.add_bill(store, null, supplier | name, ...)`. The supplier comes from the
   list or is typed in (many service vendors are not suppliers of stock), and the bill says
   what it was for.
5. **A bill** is:
   - one to five photos or PDFs;
   - the bill date, from the last 400 days up to today;
   - an amount above zero;
   - an optional bill number.

   A replay with the same idempotency key returns the same bill.

6. **Files.**
   - Photos are shrunk on the phone like every other photo. PDFs go up as they are.
   - The limit is 10 MB per file, only under `bills/<tenant>/<store>/`. `inv.add_bill`
     accepts only keys under the bill's store.
   - They are read through 5-minute links, only by those `inv.can_see_bill` allows: BILLS
     view at the store, or, for a goods bill, whoever sees or places its order.
7. **Never deleted.** A wrong bill is archived with a reason (`inv.archive_bill`), by whoever
   added it or by BILLS modify at its store. It stays in the database and the files stay in
   storage.
8. **Bills screen** (Stock → Bills, and Work on Me).
   - Tabs: All, Goods, Services, and **Waiting for a bill**: orders received in the last 60
     days with no bill.
   - "All stores" is first in the Place picker (ADR 038), and every row opens its bill (or
     its order).
   - A service bill is added from the screen. A goods bill is added on its order.
9. **Retention: 7 years.** The bucket's lifecycle keeps `bills/` and `stockcheck/` for 2,557
   days. Personnel data keeps its own shorter rule (ADR 045).

## Not now

- Reading bills automatically (BILL-1 in the AI layer).
- Matching a bill's amount to what was received.
- Bills in reports.
- Area manager access.
