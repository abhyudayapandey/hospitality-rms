# 081 — The minibar's refill and its bill are tasks

Status: accepted · 2026-10-08 · migration 20261206100000 · amends ADR 072

The Passport Hotel's GM (round 1, item 20): a check that finds items used should give
housekeeping a refill to do and front office a bill to add, and tell housekeeping when it is
billed.

## Decision

1. **A check that finds something used makes two To do items** (`ops.task`, ADR 074, 075):
   "Refill minibar, room 104" for whoever checked it (the attendant), at their department; and,
   when there is something to charge, "Bill room 104: 1 Lager Beer, 1 Cashews" for the front
   desk: the Front Desk Executive (or Front Office Manager) on shift now, else the Front Desk
   Executives' job role, else the department's head. Both may be handed on like any task.
2. **The stock leaves the store when the refill is done** (`ops.refill_minibar`, "Refilled"),
   as far as the store has it, no longer at the check: that is when someone takes it. ADR 072
   posted it at the check. A short store is said on the task and on the check.
3. **"Added to the bill"** (`ops.mark_minibar_charged`) closes the billing task and tells the
   attendant and the housekeeping heads. Neither task closes through the generic Done
   (`INVALID_STATE`).
4. The test customers' past checks (file 42) are refilled at once, as the person, at the time,
   so their figures are unchanged.
