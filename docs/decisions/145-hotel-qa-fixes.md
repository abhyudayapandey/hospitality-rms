# 145. The hotel QA walk's fixes: whose yes, running low, money for billers, quiet imports

Date: 2026-10-14, rebuilt 2026-10-15 on top of ADR 147 to 160. Status: accepted. Migrations `20270112000000_approval_preview`,
`20270112010000_transfer_awaits_gm`, `20270112020000_send_people_on_shift`,
`20270112030000_reading_words`, `20270112040000_people_on_shift_first`,
`20270112050000_renewed_licence_task`, `20270112060000_running_low`,
`20270112070000_register_defaults`, `20270112080000_who_hears_and_who_bills`,
`20270112090000_money_for_billers_and_cost`, `20270112100000_order_money_for_cost_readers`,
`20270112110000_register_keepers`, `20270112120000_fill_running_low`,
`20270112130000_heads_see_money`.

## Context

The by-person QA walk of [TEST] Passport Hotel found 17 issues (KI-01 to KI-17). KI-01 was fixed
by ADR 141 and KI-11 (empty Me headings) waits. The owner asked for the rest to be fixed across
the platform, not only at the hotel.

## Decision

1. **Whose yes, said before sending** (KI-02). `inv.approval_preview(store, lines, kind)` works out
   what `inv.request_transfer` and `inv.po_payload` will decide: the GM, the department head or
   nobody, and why. The ask and order forms say "The GM approves every request here" or
   "Your department head will be asked to approve this:" (`lib/approval-words.ts`). A request
   waiting for the GM reads "waiting for approval", not "waiting to be sent"
   (`inv.transfer_awaits_approval` counts `gm_approval`).
2. **Approve where it is decided** (KI-03). A GM's approval of a request has Approve and Reject on
   its card and "View request", never "Open to receive".
3. **One To do list** (KI-04): already done by ADR 147 (`/tasks`, `/inbox` redirects); nothing
   more here.
4. **Running low is under par or 3 days or fewer left** (KI-05; replaces ADR 141's rule, the
   owner's call): one rule
   in SQL (`inv.running_low`, `inv.recent_use`, the last 14 days' use), each item counted once,
   no-par items by days only, durable items by par only. The line says why: "14 of 20 kg (~1 day
   left)" or "4 kg (~1 day left)"; an item with no par shows no "par 0".
5. **No register is invisible** (KI-06). `ops.register_places` lists every register code
   (`ops.register_codes()`, equal to `REGISTER_CODES`), and a register whose file 45 row names no
   roles is kept by its default roles (`keptBy` in `registers.ts`): Booking leads by the front
   office (front office manager, front desk, bell captain). A register with keepers shows to them,
   the heads of the departments they work in and the outlet's managers (OUTLET_MANAGER,
   AREA_MANAGER, account owner at the outlet), no other head (the owner's call); one with
   neither named nor default keepers stays with anyone holding REGISTERS where they work.
6. **Readings** (KI-07). Quick picks follow the safe range: a round step (1, 2 or 5 times a power
   of ten) crossing it in at most 5 steps, one step either side, at most 8 picks (pH 7.2 to 7.8:
   7.0 to 8.0 by 0.2); − / + moves by 0.1 when the picks step under 1. An alert names the unit once
   ("pH is 8", never "pH is 8 pH").
7. **Only who answers for a task hears it is overdue** (KI-08): the assigner is told only if
   `ops.answers_for` (they look after tasks there, or handed it on). A minibar bill is routed, not
   handed on, so the attendant who checked hears nothing of it.
8. **Money only for billers and cost readers** (KI-09). Guest prices and charges are for whoever
   bills the minibar (ADR 104) or reads the store's cost; our cost (unit cost, breakage value) for
   `rpt.store_cost_access` only. The SQL returns null money to everyone else; a zero is not money
   ("free"). Frontline see what to charge as items and counts ("Cola 300ml ×1"). Order values,
   line prices, received value and wastage worth (`inv.sees_store_money`, `inv.po_sees_money`) are
   for cost readers, whoever reads the store's bills (the accountant, the purchase manager) and
   the order desk; whoever only receives still types what was paid, and the wastage form says
   "Over 2 kg: needs a photo …" instead of a rupee limit (the owner's call).
9. **"With <name>"** (KI-10) on a repair, never "assigned with".
10. **Person pickers** (KI-12): on shift today first, under "On shift today", then the rest;
    handing on leaves out the giver and whoever has it now (`ops.hand_on_people`,
    `ops.assignable_people`, `inv.send_people`). Who may get it is ADR 151's, unchanged.
11. **An import of history tells nobody** (KI-13). `ops.notify` sends nothing while
    `ops.replaying(tenant)` (`app.replay` on, a test customer); the loader turns it on around the
    history files only (26 to 28, 33, 35, 36, 42, done file 30 tasks). A minibar check's billing
    takes the file's time (check + 30 min, `app.occurred_at`).
12. **Who gets a minibar bill stays as ADR 104 and 148 have it** (the owner's call): the front desk
    at work when it is due, else their head. The bill is routed, not handed on, so whoever checked
    the minibar is not its giver and is not told about it (7).
13. **Menu for the restaurant and F&B managers** (KI-15): duty `READS_OUTLET_RECIPES`
    (RECIPE_READER at the whole outlet), since a restaurant has no store of its own.
14. **A renewed licence's task shows the licence in force** (KI-16), by `replaced_by`.
15. A step whose button waits for a photo says "Take the photo first." Its button still reads
    "Done" (ADR 153).
16. **Fill all short items fills every low item** (the owner's call). Under par: up to par. At or
    over par but 3 days or fewer left: a week's use (`inv.fill_qty`). The order form
    (`inv.suggested_order`) and Send stock (`inv.send_items`) both use it. The button reads
    "Fill all N short items".
17. **Department heads see their department's money** (the owner's call, refining 8): order
    values, line prices, received value, wastage worth and breakage value at the stores their
    department uses (`inv.heads_store`, DEPARTMENT_HEAD there or above). Nobody below them,
    except those who read stores' cost (the cost controller, `rpt.store_cost_access`).

## Consequences

- Rebuilt after ADR 147 to 160 merged: its migrations run after them (`20270112…`) and change
  nothing those made, except running low (ADR 141, as the owner chose). `ops.hand_on_people`
  keeps ADR 151's pickers and adds who is on shift.

The Passport demo should be started again (console → Start again) to drop the old alerts and
re-route open bills. The README's counts follow the files (KI-17).
