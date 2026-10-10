# 104. Rooms and minibars at a glance

Date: 2026-10-10. Status: accepted. Plan: `docs/plans/ux-audit.md` (PR 8).

## Context

The UX audit found housekeeping and front office reading codes ("VC · Vacant clean") in 27
dropdowns, a minibar list that repeated "Checked … by <name>" on every row with rupees for
everyone, minibar tasks as plain text, and a one-off demo task ("Restock minibars on the second
floor") with nothing to act on, beside the real refill tasks.

## Decision

1. **Rooms are tiles.** The Rooms screen shows every room as a tile, floor by floor, its colour
   and picture the status: Clean, Dirty, Guest in, Arriving, Leaving, Out of order, House use
   (`lib/rooms-view.ts`). A legend first counts each. Whoever may change a room's status taps
   the tile and taps the new status from big buttons; the room check's grid has the same buttons
   behind the room's status. Same server action (`ops.set_room_status`); a code is never shown.
2. **Minibars due today first.** `ops.minibar_rooms` says whether a room's minibar is due a
   check today: it has one, it was not checked today, and a guest is in, arriving or leaving.
   The Minibars screen shows those rooms first as tiles, then the rest by floor: green with a
   tick when checked today, amber when due. When and by whom a room was last checked is on the
   room's own page only.
3. **Rupees for whoever bills them.** `ops.minibar_places` says whether the caller bills the
   outlet's minibars (`bills`): they work in the department the bills go to
   (`ops.minibar_biller`, the front desk) or manage its tasks there (the outlet's managers), or,
   where no department takes the bills, whoever checks minibars. Only they see what is still to
   charge, on the tiles, in the summary and on the To charge tab with its "Added to the bill"
   button. Who may mark a charge added is unchanged (MINIBAR modify). The usage tab is
   "Charged to guests".
4. **Minibar tasks in pictures.** The refill and the bill list each item with its photo and a
   big ×N (`minibar/used-lines.tsx`); the bill alone has prices and the total.
5. **No one-off restock in the demo.** Each check that finds something used makes its own
   refill task with what goes back (ADR 081), so the Passport demo's one-off is gone from
   file 30.
6. **Breakfast by room** is tiles too: each room's number and its guests; front office picks a
   room by tapping its tile, gives the guests with − / + and In-room or Buffet as two buttons.
