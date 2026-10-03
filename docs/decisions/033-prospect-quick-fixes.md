# 033 — Quick fixes from prospect feedback (DB-2, NT-2, INV-12 banners, RPT-13, RPT-14)

Status: accepted · 2026-10-03

The first changes from the prospect's feedback (PRD roadmap, "Pilot readiness"), in one
change. Migration `20261025100000_prospect_quick_fixes`.

## The decisions

1. **Needs attention by department (DB-2).** Home groups what needs attention by
   department in a fixed order: Kitchen first, then Service (restaurant, bar, floor
   service, banquets), then Housekeeping, then the rest (front office, stores,
   engineering, security, admin). What belongs to no department (the outlet itself) comes
   last, as "Whole outlet".
2. **A department's type is data, not a guess from its name.** File 01 gains an optional
   `department_type` column: `kitchen`, `service`, `housekeeping` or `other`, on
   department rows only. A blank is `other`. Guessing from the name would put a "Cuisine"
   or an "F&B" department in the wrong place.
3. **Any discard tells the GM (NT-2).** "GM" means the outlet managers of the store's outlet:
   whoever holds OUTLET_MANAGER there (the General Manager and the Assistant GM; a
   standalone bar's Bar Manager). They are told of every wastage, whether it posts at
   once or waits for approval. The person who recorded it is never told, and neither is a
   lead who asked for it through a discard task.
4. **Expiry is for batches (INV-12).** Only dated batches (prep made in house, with a shelf
   life) have a use-by. Raw materials do not need one. Two banners on the Stock screen:
   - **"Items expiring within 3 days"**: a use-by date (store time) from today to three
     days ahead. Its list is soonest first.
   - **"Expired items"**: the use-by has passed. Its list is most recently expired first,
     with "Throw away" (Wastage, reason expired) for those who record wastage.

   Notifications to the departments that use an item, and "dishes to push" for servers,
   come in a later change.

5. **Menu engineering is for long periods (RPT-13).** It shows the last 3, 6, 9 or 12
   months (tabs; 3 by default) instead of days. The database refuses periods over a year
   (`INVALID_DATES`). Each dish reads "Price ₹525.00 · cost ₹207.50 · margin ₹317.50 a
   serve" and "12 sold · 20.4% of drinks sold".
6. **Stock position for all stores (RPT-14).** An outlet's (or hub's) supply point stands
   for all its stores together, as "<outlet> – All stores", when the person opens the
   report at two or more of them. The figures add up only those stores. The GM opens on it.
   Stock position also shows the value expired and expiring within three days.

## How it works

- **`core.hierarchy_node.department_type`**, with a check: departments only, the four
  values. **`core.department_of(nodes)`** (security definer) returns, for places of the
  person's own company, each one's department, type, rank (1 kitchen, 2 service,
  3 housekeeping, 4 other, 5 none) and outlet:
  - for an org place, its nearest department at or above it;
  - for a store, the department it is linked to, else its supply point's outlet.

  It returns names and order only. Home reads each count per place under RLS, as before
  (items below par per store; attendance flags, repairs and open slots per org place),
  then groups them with `attentionGroups` (`apps/web/lib/today-view.ts`). Within one
  outlet the department shows without the outlet's name. Someone with one department sees
  no headings.

- **`inv.notify_wastage`**, called at the end of `inv.post_wastage`, sends one notification
  per wastage (kind `wastage`, link `/stock/wastage`). It goes to
  `core.site_group_holders(OUTLET_MANAGER, store)` and names each item, quantity, reason
  and value, the total when there are several, who recorded it, and "Waiting for
  approval" when it needs approval.
- **`inv.expiry_list(days)`** (0 to 14, else `INVALID_DAYS`) lists the dated batches with
  stock left at every store where the person holds STOCK_LEVELS view, using
  `inv.batch_rows` (first in, first out, as the Production screen). The Stock screen
  filters it to the store on screen.
- **Stock position.**
  - `rpt.store_items(store)` (internal) is the old per-store item list, plus
    `expired_value` and `expiring_value`: what is left of each batch × the item's average
    cost at the store.
  - `rpt.stock_items(place)` and `rpt.stock_summary(place)` take a store or a supply point.
    A supply point stands for `rpt.site_stores`: the stock-holding places whose site
    (`core.stock_site`) it is, where the person passes the store rule.
  - `rpt.stock_items` names the store on each item.
  - In `rpt.stock_summary`, days on hand for several stores is their value over the sum of
    each store's daily use (each over its own days in use). It adds
    `expired_stock_value` and `expiring_stock_value`.
  - `rpt.can_open` and `rpt.report_places` add the supply point where two or more stores
    open. Purchasing and the central kitchen report stay per store.
- **One limit.** A supply point that itself holds stock and has two or more stores under
  it would stand for all of them, and its own view would be lost. No test customer has
  one. Split it into a store if a customer does.

## Tests

- `department-order.db.test.ts`: the order, a blank type, the check, and nothing about
  another company.
- `wastage-notify.db.test.ts`: the GM and AGM are told; not the recorder, not another
  outlet. An approval discard is told too. A solo bar's Bar Manager is told. A refused
  discard tells nobody.
- `expiry.db.test.ts`: every user gets exactly the batches at the stores where they see
  stock levels. Also covered: the 0 to 14 day limit, the pinned values (Mint Chutney
  ₹25.13 expired, Ginger Garlic Paste ₹101.33 expiring), and All-stores totals equal to
  the stores' own. It also checks refusals.
- `reports-access` and `reports-refusals` cover the supply points. `cost-reports` covers
  a year of menu engineering, and the refusal of longer periods.
- The loader tests cover `department_type`.
- Unit and e2e: `today-view`, `reports`, `expiry`, and `quick-fixes.spec.ts`.
