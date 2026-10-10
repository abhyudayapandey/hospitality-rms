# 098. The UX audit's first fixes

Date: 2026-10-10. Status: accepted.

## Context

The UX audit (Passport Hotel, all 38 job roles at 380 px; plan in `docs/plans/ux-audit.md`)
found a few things that are wrong rather than only wordy, and the owner set one rule for every
screen that takes a photo.

## Decision

1. **Photos above the button.** A control that takes a photo or a file sits above the button
   that saves, finishes or sends it (Next, Save, Done, Mark fixed, Record...), never below.
   `apps/web/lib/photo-first.test.ts` checks every form under `app/` that takes one.
2. **An event's supplies by name for everyone who works it.** The event page joined `inv.item`
   under the viewer's access, so a banquet server (no stock access) read "Item · 4".
   `ops.event_item_names(event)` gives the names and units of an event's items to whoever may
   see the event (`ops.can_read_event_node`, the events' own rule, ADR 016), and nothing else
   about the items.
3. **Home's Next card** shows the task's own picture (`taskIcon`, as on the To do list).
4. **The header** puts the name on its own line and the job under it, never cut short; the
   place follows the job only when it says something the job does not ("Cashier · Cashier"),
   and a long place gives way first.
5. **Today so far before any sale** says "No sales in yet today" with the wastage, instead of
   ₹0 and "–" for cost that read as broken. Every figure shown is still its report's (ADR 057).
6. **Photos not working** says "Photos can't be taken here right now. Tell your manager."
   instead of "Photo upload isn't set up here". A step or repair that needs a photo still needs
   one.
