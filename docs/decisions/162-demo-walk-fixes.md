# 162. The demo walk's fixes

Date: 2026-10-16. Status: accepted.

## Context

Recording the three demo videos (a hotel, a restaurant, a restaurant with a bar) walked the app
end to end as each person, and found eight things that did not work as the rules say.

1. A department head asking from **Me → RFMs → Request** asked _their own_ head: the ask form
   offers the store one's team uses (ADR 115), and its head (`inv.ask_heads`) is whoever leads
   the asker's department, so for the head it went up to the GM as a task. The Executive
   Housekeeper's lager never reached the Bar.
2. **Buy what's short** ordered every line of a request: a line the store had in full fell back
   to the whole quantity asked. A new order also read "waiting for approval" and "Approved. It
   reaches the store in a minute." at once, in the minute before the executor released it.
3. The keeper's **stock check** was one list by category; only the verifier's sheet went shelf
   by shelf (file 11 `shelf`, ADR 043).
4. **Request from a store** had plain number boxes and no "Fill all N short items", unlike every
   other form that asks for stock (ADR 053, 054, 099).
5. The **prep task** form chose for the person (the first job role, the first name) and listed
   the head cook giving the task (ADR 113, 151).
6. Some quantities read "24 bottle" and "usual 10.5 bottle a week": written in SQL or with the
   unit tacked on, not through `formatQty`.
7. Things counted one by one read in parts: "72.5 of 80 each" beside "73 each", "33.6 cans".
8. The browser's time and date boxes follow the phone's language: "11:00 AM", mm/dd/yyyy, and a
   12-hour box refused "11:00". Between 00:00 and 04:00 a task due at 10:00 the same calendar
   day read "Due tomorrow" (the business day is still yesterday's, ADR 148).

## Decision

1. **A head never asks their own head.** `inv.my_ask_stores` leaves out a person who leads where
   they work (DEPARTMENT_HEAD or OUTLET_MANAGER there) and may request for a store; RFMs' Request
   then opens Request from a store (`inv.ask_for_stock`, routed by the outlet's shape). A head
   who may not request for any store (the Solo Bar's floor manager) still asks their own head.
2. **Buy what's short buys what's short.** `inv.order_for_request` orders, per line, what the
   asked store lacks; nothing short is `NOTHING_SHORT` ("The store has all of it. Send it
   instead of buying."). An order whose approval is done but not yet released reads
   "approved", never "waiting for approval" beside "Approved".
3. **The keeper's stock check goes shelf by shelf**, as the store is walked (file 11
   `shelf_order`, `shelf`), with the shelf as a heading; items on no shelf come last.
4. **Request from a store has − / + and "Fill all N short items"**, filled by the same rule as
   the order form (`inv.suggested_order`: up to par, or a week's use when it lasts 3 days or
   fewer, `inv.fill_qty`). Nothing is in the boxes until tapped.
5. **The prep form chooses nothing**: no job role or person until tapped, and Create waits for a
   choice. The task pickers never list whoever is giving the task.
6. **One way to say a quantity in SQL too**: `inv.qty_text(qty, uom)` and `inv.unit_word` mirror
   `formatQty` ("24 bottles", "1 bottle", "2.35 kg"); the approval reasons use them.
7. **Counted things are whole**: cans, tins, packs, packets, boxes, rolls and pieces show whole
   numbers like g, ml and each (a bar's part bottle stays, ADR 015). A request's levels say the
   asking store's figure as its unit does ("73 of 80 each"), through `formatNumber`.
8. **Our own date and time boxes** (`DateInput`, `TimeInput`): a day typed as dd/mm/yyyy on a
   number pad, or picked from the phone's calendar behind a button; a time on the 24-hour clock,
   "1430" reading "14:30". Forms send what they sent before (yyyy-mm-dd, HH:MM). Before 04:00 a
   time due on the calendar's today names the day ("Fri, 16 Oct 10:00") instead of "Tomorrow".

## Consequences

- No access rule changes: heads already could request from a store; the ask list only loses a
  path that went nowhere useful.
- Typed dates and times are checked by the box itself (a day that is not real, before `min` or
  after `max`; a time that is not 24-hour) before the form sends.
- The batch label already printed the real date and time ("Made 16 Oct 2026, 00:05").
- Tests of a job role's round no longer assume a weekday. The test data rosters the commis, the
  technician and Bar 3.0's server Monday to Friday, so on a Friday tomorrow's rounds are the
  head's (ADR 148), and master's CI failed on 16 Oct. The tests now ask the roster who has the
  round (`ops.in_pool`, `ops.job_role_pool`), or give it to their person with `giveIfOff`.
