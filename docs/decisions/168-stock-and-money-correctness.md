# 168. Stock and money correctness: counts, minibars, orders, send tasks, receipts

Date: 2026-10-17. Status: accepted. Migrations `20270121100000` to `20270121140000`.

## Context

The platform review found seven places where stock or money came out wrong:

- **C3.** A count (`inv.submit_count`) and a stock check (`inv.finish_stock_check`) posted
  "counted - what should be there at the start". Whatever moved while the count was open (a
  receipt, a sale, a transfer, wastage) was in the stock already and again in the difference.
  Open counts never expired, and starting one handed back the oldest.
- **C4.** A minibar check charged (par - left) x price. A room checked again before its refill,
  or refilled short because the store ran out, was charged again for what was missing already.
- **H14, M22.** `inv.order_for_request` handed back any order with no receipt, including one the
  keeper closed and one whose approval failed: "Order it again" gave back the dead order. Two
  taps could make two orders.
- **H15.** `inv.suggested_order` counted a closed order's missing rest as still coming, and a
  line received over its order went below zero.
- **M20.** A send task stayed open when its request was sent from the transfer page, rejected
  or withdrawn.
- **M15.** Free goods could not be received (`AMOUNT_REQUIRED`).
- **M14.** A receipt kept `round(amount / qty, 4)`, so Rs 1,000 for 3,000 g became Rs 999.90,
  while the bill made in the same tap said Rs 1,000.

## Decision

1. **A count posts the difference from what was there when each line was counted.** Each line
   keeps `counted_at` (a stock check line had it already, offline sync included; a count line
   gets it from the phone as "how long ago", `ago_ms`, so a wrong phone clock does no harm,
   never before the count started nor after now). At submit, review and finish, what should be
   there is `inv.on_hand_at(item, store, counted_at)`: the stock now less every ledger movement
   dated after it (`occurred_at`, so a till import or offline wastage dated before the count
   counts as before it), under the ledger's lock. That figure replaces the start's snapshot on
   the line (`system_qty`, `expected_qty`), so the review, the photo rule, the alert and the
   variance reports all show the difference that was posted. After posting, stock = what was
   counted + what moved after it was counted. "Counted - on hand at submit" was not taken:
   it is wrong for goods that move after a shelf was counted.
2. **An open count or check closes after a day** (`inv.count_too_old`, 24 hours). Starting one
   marks the old one `expired` and starts afresh; submitting, reviewing or finishing an old one
   is `COUNT_EXPIRED`. A day is long enough for a whole store shelf by shelf, and with (1) an
   old count is no longer wrong, only stale.
3. **A minibar charges what a guest used since the room was last full.** What should be in the
   room is what its last check left plus what that check's refill put back, at most par (a room
   never checked is full); the guest used what is missing of that. The refill puts back what
   the room lacks of its par (`fill_qty`), so a short refill is made up at the next one and
   charged to nobody; a refill task lists those quantities, a bill task what was used.
4. **A room whose refill is still open is not checked again** (`MINIBAR_NOT_REFILLED`), rather
   than merging the two checks. A second count before the refill mixes two guests' use; a
   merge would have to re-price the first bill after front office may have added it. The
   attendant who checked has the refill task (or whoever it was handed to), so the way out is
   always one tap away.
5. **Only a live order is handed back or counted as coming** (`inv.po_live`): not rejected,
   cancelled or closed, and its approval neither failed, rejected nor cancelled. The request is
   locked (`for update`) while its order is looked for, so a second tap waits and gets the
   order the first made. No partial unique index: a failed approval leaves the order
   `submitted`, so an index cannot tell a live order from a dead one. A request's order placed
   with several suppliers counts each part. `inv.suggested_order` clamps each line's rest at
   zero. No other "ordered - received" sum exists (the desk, running low, `fill_qty` and the
   supplier reports compare, or show short deliveries, which a closed order still is).
6. **A send task closes when its request leaves "to send"**: a trigger on the transfer
   (`inv.close_send_tasks`) cancels open send tasks when it is sent or stops being submitted
   (rejected, withdrawn, closed), saying why. The task whose own button sends it
   (`ops.send_by_task`) names itself in `ops.sending_task` and is done, not cancelled. Send
   tasks left open by the old way are closed by the migration.
7. **Free goods**: a received line may be marked free with a reason (Sample, Offer,
   Replacement on the form; `free_reason` on the line, `FREE_REASON_REQUIRED` without one). It
   posts at a cost of 0, which lowers the store's average cost as free stock should.
8. **A receipt keeps the amount typed** (`goods_receipt_line.amount`, the whole line's amount)
   and unit costs keep 6 decimals on receipt lines, the ledger and transfer lines (3,000 x
   0.333333 is Rs 1,000.00). The order's received value and Reports -> Stock movements take the
   amount; the bill made at receiving adds the typed amounts in whole paise. The stock level's
   average cost keeps 6 decimals too, and a store's value is its stock x that average as
   stored, so the items' values add up to the store's and to its trend.

## Consequences

- A count's "expected" figure is no longer the start's snapshot once a line is counted.
- Known limit: a free line sent straight to a department (ADR 080) leaves the Main Store at its
  average cost, because a movement out at cost 0 means "at average cost" in the ledger.
- Unchanged: an order that has had a receipt is not handed back by Buy what's short, which
  orders what the store is still short of.
- Figures worked out from an average cost move by a paisa or two where the 4-decimal average
  was rounded: the test data README's central kitchen and expiring values are updated.
