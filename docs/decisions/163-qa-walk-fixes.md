# 163. The restaurant QA walk's fixes

Date: 2026-10-16. Status: accepted.

## Context

The owner walked [TEST] Restaurant step by step with the QA sheet and found these.

1. **RFMs → History** listed only what the person asked for. A head who gave an ask, a keeper
   who sent or received a request, a GM who approved an order: none of it was in their History.
   The owner had asked for every request the person took part in (ADR 143).
2. After **Buy what's short**, the order's page showed one screen while it waited for approval
   and another once approved, and the keeper could not change how much to order.
3. **Verify stock** said units as "24 bottle"; the store's shelves were small grey lines; a
   receive task read "Transfer to Bar done" though the stock went into the Bar Store; a task's
   History was folded away.
4. **Leave**: nobody was told a leave request was waiting for them; the page said "submitted"
   and "approved" instead of who; the roster let a manager give a shift on a day of approved
   leave; approved leave could not be cancelled; Team → Leave showed only some states.

## Decision

1. **History is everything the person took part in** (`inv.my_material_history`): an ask they
   made, were asked to give (`inv.ask_heads`), gave, turned down, closed, collected or held a
   task of; a request to a store they made, approved or turned down, sent, received or held a
   task of; an order they made, approved, placed, closed or received. Newest first, 50 rows.
   A row someone else made says "Asked by <name>". Each row opens its own page, as before.
2. **One order screen.** The keeper sees the order form at once with a − / + per line, starting
   at what was short. While it waits for approval the form is shown greyed out with "Waiting for
   <name> to approve. You can place it once it is approved." When nobody had to approve it,
   `inv.place_order` releases it there and then (no waiting a minute for the executor). Once a
   person approved it, the keeper may order less but never more than was approved
   (`MORE_THAN_APPROVED`); with no approval they may order more than was short.
3. **Small fixes.** Verify stock says units with `formatQty` ("24 bottles"). Shelf headings on
   the stock check and verify sheets are larger and bold. A receive task's button names the
   store the stock goes into (`ops.receive_into`: "Transfer to Bar Store done"). A task's
   History is always open under its own heading.
4. **Leave in words, alerts, roster and cancel.**
   - Whoever must approve is told: "Leave to approve", the person, type and days, opening the
     leave (`hr.notify_leave_asked`; never during an import of history, `ops.replaying`).
   - Every leave reads in words (`hr.leave_words`): "Waiting for <name> to approve", "Approved by
     <name>" (as soon as the last person says yes, before the executor applies it), "Rejected by
     <name>", "Cancelled".
   - The roster refuses a shift on a day of leave: approved leave is `LEAVE_CONFLICT`, a request
     still waiting is `LEAVE_PENDING` (`hr.leave_block`, in `hr.set_day_shift` and
     `hr.set_custom_shift`). The roster shows a red line naming the person and the day, with
     "Open their leave", and an "On leave" / "Asked for leave" pill (`hr.leave_for_day`).
     `hr.assign` (open shifts) is unchanged: approving the leave drops those shifts (ADR 008).
   - Approved leave not yet started is cancelled by the person, whoever manages their leave
     (LEAVE modify) or whoever builds their roster (ROSTER modify), the people the red line sends
     there (`hr.may_cancel_leave`, `hr.cancel_leave`). The days go back to the balance; the person
     is told when someone else cancels it. Started leave is `LEAVE_STARTED`.
   - Team → Leave lists every state (waiting, approved, rejected, cancelled) in words, by day or
     by person, each row opening the leave.
5. **The QA sheet keeps its results.** Its saved answers are keyed by step, so new checks are
   added as new steps and no step is renamed or removed.

## Consequences

- One access change: ROSTER modify at a person's place now also cancels their approved leave
  that has not started. Reading is unchanged: History rows come from a SECURITY DEFINER
  function that returns only requests the reader took part in, at their own company.
- `inv.place_order` releases an order whose approval needed nobody in the same transaction, so
  the executor's `inv.po.release` finds it already released and does nothing.
- Verify stock stays the cost controller's own blind count of a store, set against the system's
  figure; it does not check the keeper's stock check.
