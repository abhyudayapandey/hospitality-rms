# 051 — The Main Store keeper: receive at what was paid, send stock, lists first

Status: accepted · 2026-10-05 (migration 20261108100000)

Feedback from using the app as the Main Store's keeper:

- "To receive (0)" sat above two orders to receive.
- Buttons came before the information.
- Receiving pre-filled quantities and showed the order's estimate as if it were paid.
- The Main Store, which supplies the departments, led with asking for stock.

## Decision

1. **Receiving records what was paid.** `inv.receive_goods(po, [{item, qty, amount}])` wraps
   `inv.receive_at`, so receiving keeps its existing rules (5% over goes for approval, the
   department is told).
   - Every item received needs its amount (`AMOUNT_REQUIRED`). The ledger's unit cost is
     amount / quantity, so stock value, cost of sales and the purchase price trend use
     actuals. The order's own prices are estimates.
   - The form fills nothing in. "Everything arrived as ordered" fills the quantities still to
     come.
   - Only items still to come are listed. An earlier delivery is shown as "came earlier".
   - The status is in the header only when there is nothing to do on the order.
2. **The bill can come later, visibly.**
   - The receive form takes the bill's photos or PDFs (optional). The bill's amount is the
     total received.
   - Without a bill, the order shows **Bill missing**, on the order and on its row in Orders.
     The GM, the department head and the keeper see it (`inv.po_bill_missing`).
   - The Bill section takes it later, starting from the amount received.
3. **One Orders list.**
   - It holds the store's own orders and the departments' requests the person orders and
     receives as the order desk (`inv.desk_order_list`, ADR 049).
   - Tabs: All, To order (the desk, when there is any), To receive, Received.
   - Each tab's count is its list. Home's Receive count includes the desk's requests.
4. **Send stock.** The Main Store gives stock to a department's store
   (`inv.send_stock(from, to, lines)`), to a store of the same site that a team uses.
   - The stock leaves at once (transfer kind `send`, in transit).
   - A **receive task** goes to whoever is on shift in the department now; a clocked-in
     person comes first, then the earliest start. With nobody on shift it goes to the head,
     who can **Assign** it on (`ops.reassign_task`). The head is told who will receive it.
   - The stock reaches the department's store when that person confirms what arrived
     (`ops.receive_sent`). A shortfall is posted as transit loss, and the head and the sender
     are told.
   - There is no approval step: the Main Store is sending its own stock.
5. **The Main Store leads with what it does.** On a store marked `is_main_store`:
   - Transfers leads with **Send stock**. "Request stock" is a small link.
   - Orders' "Ask for supplies" is a small link, "for the Main Store".

   Department stores keep asking as their main button.

6. **Lists first, then actions.** On a list screen the information comes first and its
   buttons follow it: Orders, Transfers, Bills, Count, Events, Admin → People. (CLAUDE.md
   convention.)

## Addendum: the Main Store's materials go to every department that may need them

Migration 20261109100000. Send stock and Request stock (from the Main Store) listed only the
items already set up at both stores, so the bar could not get ketchup, foil or cling film. The
list is now what the Main Store holds, by who may use it:

- **Housekeeping-only** items go to housekeeping stores only. These are items set up only at
  housekeeping stores in the outlet, such as linen and guest amenities.
- **Food-and-drink-only** items go to kitchen and service (bar) stores only. These are items
  set up only at those stores.
- **Everything else** goes to every department: shared items, and items set up at no
  department yet.

The first time an item goes to a store it is set up there (par 0), so it shows in that store's
stock. Asking a central kitchen (a hub) still lists only the store's own items.
