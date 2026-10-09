# 080 — Receiving: into the store, or straight to the department that asked; an expiry per line

Status: accepted · 2026-10-08 · migration 20261205100000

The Passport Hotel's GM (round 1, item 14). Until now a department's order, placed and
received by its Main Store (ADR 049), was posted straight into the department's store, so the
Main Store's ledger never showed it and nothing could stay in the Main Store.

## Decision

1. **The keeper says where each line goes**: into the store, or to the department that asked.
   The default comes from the item (`inv.item.receive_to`, file 10's optional `receive_to`, the
   store by default) and the keeper may change it per line. A line the Main Store does not keep
   can only go to the department. An order a store placed for itself has no department.
2. **To the department is a direct issue**: a receipt at the Main Store and, in the same
   transaction, an `inv.transfer` of kind `issue` out of the Main Store and into the
   department's store, completed at once. Ledger inserts only (rule 3). The department is told
   it arrived, as before.
3. **An optional expiry date per line.** The receipt is then a dated batch (ADR 040, 046) on the
   expiry lists, and an issued line takes its date with it. A date already passed is
   `EXPIRY_PASSED`. Nothing is filled in (ADR 052): the date and the quantities are the keeper's.
4. A line that says nothing (the loader's past test orders, an older app) is posted as before,
   at the order's own store, so the test data's figures are unchanged.
