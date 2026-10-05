# 049 — Supply requests: the requester asks, the main store orders

Status: accepted · 2026-10-05 (migration 20261106100000)

Feedback from the General Manager walk-through: the person who needs supplies should only say
what and how much. Choosing a supplier is the main store keeper's job.

## Decision

1. **Raising.** `inv.request_supplies(node, lines, notes)` takes items and quantities only: no
   supplier, no price. The screen is "Ask for supplies". The stored line cost is the store's
   average cost, only to size the request; nobody sees it on the request.
2. **Approval.** Only _unusual_ requests (ADR 044: off the menu, or more than the usual
   quantity) go to the department head or the GM. **There is no value limit and no area
   manager step:** `PURCHASE_ORDER` has the one `department_approval` step. (The raiser gives
   no prices, so a value rule has nothing to measure.)
3. **The order desk.** A released request with no `ordered_at` is _to order_ (progress
   `to_order`). Its order desk is the keeper of the outlet's Main Store (`is_main_store`), or of
   the store itself when the outlet has none (`inv.order_desk`). The desk's keepers are told
   and see it in the To do list under "To order" (derived from the request, like "To assign",
   so it closes itself).
4. **Placing.** `inv.place_order(request, groups)`. A group is `{supplier?, expected_on,
lines: [{item, unit_cost?}]}`: the supplier is optional (it is stored when named, so the
   business knows who supplies what; suppliers are told outside the app for now), the date is
   required. Every line is in exactly one group; one group is the request itself, more groups
   split it into one order per supplier (`request_po_id` points to the first). The form opens
   on "one supplier for everything" and offers "different suppliers for different items", which
   it opens by itself when the items' usual suppliers differ.
5. **Notices.** Ordering tells the department (the raiser, the store's keepers and the
   department head): "accepted and ordered, due on". It also closes the "To order" entry and
   opens "To receive", due on the date. Receiving tells the department "received" or "part
   received".
6. **Receiving** can be done by the order desk for the other stores' orders (stock posts at the
   request's own store); only ordered requests can be received.
7. Orders that already name a supplier (`inv.create_po`, and every order before this) are
   ordered when released, as before.

## Consequences

- `purchase_order.supplier_id` is nullable. Supplier reports (supplier fill, price history)
  skip orders with no supplier, since there is nothing to report on them.
- The "To order" and "To receive" entries are derived from the orders, not `ops.task` rows,
  and read through `inv.desk_orders()` because RLS shows a keeper only their own store's orders.
- The 50,000 area-manager rule of ADR 044 is gone; the definitions reach every tenant with the
  Deploy workflow's product sync. An order waiting at `area_approval` at deploy would be stuck
  (the same caution as ADR 044): check none is before deploying.
