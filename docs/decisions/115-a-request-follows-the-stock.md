# 115. A request follows the stock, by each outlet's rules

Date: 2026-10-11. Status: accepted. Review: the first wave of fixes after "Real use".
Migrations `20261218100000_requisition_chain`, `20261218110000_staff_asks`.

## Context

At Passport, housekeeping asked for beer for the minibars. It went to the Main Store as a
purchase although the Bar had beer; the Main Store bought it, sent it to the Bar, and nobody
was told: the Bar had no notice, housekeeping still saw "order the beer". An over-par order said
"waiting for the department head", who had no way to approve it on the order, and once the GM
approved it the order looked stuck. The receipt step of a stock request went to the GM, because
the person who asked may not act on their own request (rule 7). Hotels also run this
differently: one with a Main Store asks it for everything, and its store keeper sends or buys;
Passport has no Main Store and no store keeper, so departments ask each other and the GM
approves. Who approves is the hotel's own process, chosen when it is set up.

## Decision

1. **One ask, routed by the outlet's shape** (`inv.ask_for_stock`, `inv.stock_source`,
   `inv.ask_items`): with a Main Store, everything goes to the Main Store; without one, to the
   other store of the outlet that keeps the item (the Bar for lager). What no other store keeps
   is bought instead (`NO_STORE_KEEPS_IT`; the form links to a supply request). Nobody picks a
   store.
2. **Each outlet's rules** (`core.hierarchy_node.stock_rules` on its supply point, read through
   `inv.stock_rule`, nearest place up the supply tree), chosen at onboarding on file 02's outlet
   row and on the set-up wizard's outlet screen:
   - `request_approval`: `unusual` (the default, ADR 044: the department head approves a request
     off the menu or more than usual), `gm` (the GM approves every request between the outlet's
     stores, TRANSFER step `gm_approval`), or `none`;
   - `purchase_approval`: which purchases are approved, the company's rule (file 00, ADR 092)
     unless the outlet has its own;
   - `purchase_approver`: `department_head` (the default) or `gm` (PURCHASE_ORDER step
     `gm_approval`). `inv.po_payload` builds the order's workflow for every way an order is made.
     Passport: `gm`, `every`, `gm`. Test Company: none set, so everything works as before.
3. **Whoever runs the store** sends it, gives it to someone of its team (`inv.give_send`: a
   "send" task, done with `ops.send_by_task`, "I took all of it"), or buys what is short for this
   request (`inv.order_for_request`, linked by `for_transfer_id`, approved by the rules above).
   When the order arrives, the store is told to send it on.
4. **Receiving is a task for whoever asked** (`inv.after_dispatch`), done on the task or on the
   request (`inv.receive_request`, also through `inv.receive_transfer`): the TRANSFER receipt
   step runs only for requests raised before this (their payload says `receipt_step`). Once sent,
   a request's workflow is complete; it can no longer be rejected (`INVALID_STATE`).
5. **Everyone in the chain is told** what reaches them (`inv.after_step`, `inv.after_receive`,
   `inv.after_goods_receipt`, kind `stock_request`), and **whoever asked sees where it is now**
   (`inv.request_now`: "Waiting for Sainath to approve", "Dylan is bringing it from the Bar", "The
   Bar is buying it: waiting for …", "Could not go through: …") and its story
   (`inv.request_story`), the orders it waited on included. Only the people of either store,
   whoever asked and whoever has a task for it may follow it (`inv.may_follow`).
6. **A frontline person asks their department head** (`inv.staff_ask`, `inv.raise_staff_ask`;
   Me → Ask for something): an "ask" task for the head, who gives it from the store, asks for it
   (the chain above, linked by `for_ask_id`), or says why not. Whatever arrives comes back to the
   head to give, and whoever asked follows it under What I asked for. Read through functions only
   (`rpc_only`).
7. **An order's approval on its page** (`inv.po_approval`): whom it waits for and why, Approve /
   Reject for that person there, who approved it, and an order whose workflow failed says so.
8. **Passport has no Main Store and no store keeper**: its re-import retires the Main Store
   (ADR 083); the Bar and housekeeping buy their own; the pitch shows housekeeping's beer going to
   the Bar after the GM approves.

## Tests

`requisition-chain.db.test.ts` (both shapes, every step, who is told, what whoever asked sees,
who may act, the staff asks, the order's approval), `loader-checks.db.test.ts` (file 02 rules),
`setup-draft.test.ts` and `form.test.ts` (the wizard), and the TRANSFER and PURCHASE_ORDER tests
updated for the new steps (`workflow`, `po5-rfm`, `store-transfers`, `top-of-chain`,
`inventory`).
