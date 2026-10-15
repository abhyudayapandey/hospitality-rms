# 160. The re-audit's hotel, stock, reports and speed fixes

Date: 2026-10-15. Status: accepted. Migrations `20270110000000_reaudit_hotel_stock`,
`20270110010000_reaudit_reports`, `20270110020000_reaudit_speed`.

## Context

The Outlet Ops re-audit's sections 8 to 11 found screens that said too much or the wrong thing
(a minibar tile "Room | 101", "should have 2 each", parking at a bar), rules that disagreed
(Push today and Expired), dead ends (Deactivate on every row, "Everything arrived as ordered"
after part of an order came), reports that misled early in the day or counted logins as people,
and five screens that took 2.6 to 6.6 seconds to open.

## Decision

1. **Hotel.** A minibar tile reads the room number alone; the header counts what is due today
   ("3 of 19 due today checked"). A room's count reads "Should be 2", in the item's own unit
   ("2 bottles"; count units are plural, `unitWord`, `formatCount`). Report a problem offers only
   the places the outlet has: pool and parking at a hotel, a terrace or garden at a hotel or where
   a department's sections name one (`ops.maintenance_wheres`).
2. **One use-by rule.** A batch is past its use-by once its business day (04:00, `ops.tz_of`) has
   ended: `inv.past_use_by` is the one rule behind Expired, Push today and the expiry alerts.
3. **Compliance.** Fire extinguishers, pest control and the water tank are Engineering's (the
   Technician; a department's head, else any role there). A job is "urgent" only within 7 days
   (`URGENT_DAYS`). How often is one list of chips: every week, every 2 weeks, every 1, 2, 3, 4,
   6 or 12 months, or a day of the month.
4. **Roster, people and orders.** A shift that has started has no open slots and no Assign.
   Deactivate is on the person's page (Team → People → the person), not on the list. A date in
   another year shows its year. A part-received order offers no "Everything arrived as ordered".
   Test orders carry no "Test data PO-n" note.
5. **Reports.** Today, before any sales, the outlet's day shows "Today so far" without last week
   or cost shares, never "People cost 100%" from a part day. Counts are plural ("1 person").
   Headcount and every People figure leave out the account owner and a demo presenter
   (`rpt.place_workers`). A day with no transfers says so. Covers ask for Breakfast only where it
   is served (rooms, or breakfast covers already given). Leave liability says what its ₹ is.
   People cost with every department under 3 paid people shows the total alone. A menu with
   nothing sold says so instead of "Not placed yet" on every line. Someone whose only report is
   My week opens it from Reports, with "← Back", not a list of one.
6. **Speed.** The app's connections turn JIT off (`APP_PG_OPTIONS`): compiling a query took
   seconds and saved milliseconds. `inv.ask_items` reads the stores it may ask once instead of
   once per item; an item's page asks `inv.ask_source` for its one item and reads only its own
   stock line. Home asks `ops.late_counts` for all its departments at once and loads its
   independent parts side by side, each in its own transaction. Item pictures load as they come
   into view.

## Consequences

- Access is unchanged (no new grant or policy), so no RLS all-users run is needed.
- `ops.late_count` stays for Team tasks; `ops.late_counts` must give the same count
  (`reaudit-speed.db.test.ts`), as must `inv.ask_source` and `inv.ask_items`.
- [TEST] Restaurant's file 39 changed: re-import it.
