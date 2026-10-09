# 092 — Stock policies: par by day, the purchase approval rule, GM-approved discards

Status: accepted · 2026-10-09 · migration 20261211160000

Passport's stores keep more on hand at the weekend, approve purchases above an amount, and throw
away premium liquor only on the GM's word. Part of `docs/plans/building-blocks.md`, PR 2. No new
block: these are settings of Stock and Buying.

## Decision

1. **Par by day** (file 11 `par_by_day`, e.g. `Mon-Thu 40; Fri-Sun 50`): kept on the item's
   place as `par_by_day` beside `par_base` (the file's `par`, used on days not listed). The
   store's `par` is always today's (`inv.par_on`), set at load and each business day by
   `inv.apply_par_by_day`, which runs first in the tasks tick. So every screen, form and report
   that reads `par` needs nothing new ("Fill all N short items up to par" fills to today's).
2. **Purchase approval** (file 00 `purchase_approval`, `core.tenant.settings`): `unusual` (the
   default, ADR 044 as before), `every`, or `above:<amount>`, the order's worth at standard cost.
   `inv.order_unusual` and `inv.order_why` decide it for both a purchase order and a supply
   request; the approval chain is unchanged.
3. **Discard approval** (file 10 `discard_approval` = `gm`): such an item is never recorded as
   wastage straight away, whatever its worth. Whoever may record wastage there asks
   (`ops.ask_discard`): a `discard` task, reported, at the store's department. Only the GM
   approves it (`NEEDS_GM`); any other discard asked this way is approved by whoever gives out
   the department's tasks. The asker never approves their own (`SELF_APPROVAL`). Approving gives
   it to someone, or whoever is on shift, who throws it away on the task like an expired batch
   (`ops.discard_expired`, at most what the store has); the GM's approval stands in for the
   wastage threshold's, so there is no second approval. An expired batch of such an item is
   given out by the GM too (`ops.assign_expiry`). The department heads are told of every other
   discard, the GM of these.

## Tests

`stock-policies.db.test.ts` (today's par from the days; each purchase rule on orders and
supply requests; the single malt refused straight away, asked, refused to the head bartender,
approved by the GM, thrown away by another bartender with no second approval; the asker refused;
who is told), and the e2e `stock-policies.spec.ts`.
