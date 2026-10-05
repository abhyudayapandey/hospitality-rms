# 044 — Department heads are responsible for orders and requests for material

Status: accepted · 2026-10-04 (migration 20261102100000) · amended by ADR 049: the area manager step above ₹50,000 is gone, and the person asking for supplies gives no supplier or price

Prospect feedback (3 Oct): PO-5 (orders) and TR-3 (requests for material, RFM). The owner
answered the open questions on 4 Oct.

## Decision

1. **Usual or not.** An order line or RFM line is _unusual_ when the item is **in no
   recipe of the outlet** (`inv.on_menu_items`: dishes sold from the outlet's stores and
   their prep recipes, down through prep in prep, plus what its stores make), or when its
   quantity is more than `usual_qty_factor` (company setting, default 1.5, 1 to 10) times
   the **weekly use**: what left the store in the last 28 days (sales depletion, other
   use, prep use, wastage, transfers out) divided by four. **No use in those 28 days:** no
   usual quantity yet, so a menu item is usual and an off-menu one is not.
2. **Orders (PO-5).** `PURCHASE_ORDER` now has `department_approval` then `area_approval`.
   The first applies only when the request's payload says `unusual` (a new `when`
   condition, `payload_true`); an order with nothing unusual and under the value threshold
   skips every step and is **approved at once** (the engine's existing all-skipped path),
   then released by the executor. The area manager step above the threshold (₹50,000)
   stays. The department head is the head of the department that uses the store, found
   through `core.node_link`; **the GM can approve too** (a new step flag `alsoEscalateTo`:
   the escalation group may act at once, not only after the SLA). If the head made the
   order they cannot approve it (rule 7), so it goes to the GM; if the GM is also the
   head, to the area manager, then the Account Owner. **The GM is told of every order**
   (`inv.notify_order`) and not the person who made it.
3. **RFM (TR-3).** A request into a **department's store** (a store linked to a department
   in `core.node_link`) is a request for material (`inv.transfer.kind = 'rfm'`), whatever
   store it comes from. Same rule, applied to the requesting store's use. `TRANSFER` gains
   an `approval` step (department head or GM) before the store keeper's `dispatch`;
   other transfers skip it. The person who raises it is anyone with `TRANSFERS` modify at
   the department's store (no new "assigned person" responsibility).
4. **Why, in words.** The payload carries `why` ("Prawns: not on the menu. Oil: 16 kg,
   usual 10 kg a week"), shown in the approver's Inbox and before sending
   (`inv.unusual_lines`, the order and request forms).
5. **PRD numbering.** The table row near line 508 (suggested order quantity) becomes PO-6.

## Consequences

- The old `outlet_approval` step is gone: a customer's own approval chains for it (ADR 009) no longer apply, and an order waiting at `outlet_approval` at deploy would be stuck.
  Deploy with no order awaiting approval (the runbook says how to check).
- The engine changes are small and generic: `payload_true` and `alsoEscalateTo`, plus
  `from_node`/`to_node` scopes remain TRANSFER-only but a TRANSFER step may now use any
  scope. Existing flows are unchanged.
- Tests that submitted an order directly now flag it unusual to keep exercising the
  approval path; the usual path is in `po5-rfm.db.test.ts`.
