# 048: One screen per function, opened with the scope the count had

Status: accepted · 5 Oct 2026 · extends ADR 038 (All stores in the Place picker)

## Context

Using Home as the General Manager, the same function opened different screens depending on
the way in. "9 items running low" opened Stock on one store; the expiry banners opened a
separate list with other tabs and an "All stores" picker; "27 open shifts" opened one
department; "1 open repair" and "1 job to give to someone" counted the same thing twice; the
repair list had no picker. A person who tapped a count of nine saw two items and could not
tell why.

## Decision

- **One screen per function.** A function never has two views. Its tabs are its views.
- **A count opens its screen on the matching tab with "All ..." chosen** (All stores, All
  departments) in the Place picker, and the list is as long as the count. The person then
  narrows to one place from the same picker. "All" is not remembered (ADR 038): the menu
  still opens the remembered place.
- **Stock** has four tabs: All, Running low, Expiring in 3 days, Expired. `/stock/expiry`
  stays as a redirect so push links and notifications already sent keep working.
  `lib/stock-view.ts` builds every Stock URL; `listHref` builds the others.
- **Open shifts, attendance issues and repairs** open Roster, Exceptions and Maintenance for
  All departments, each department a collapsible section (`lib/department-groups.ts`, on
  `core.department_of`). The department with open shifts is open; "fill an open slot" stays
  two taps (ADR 026). Maintenance groups by where the problem is (`ops.maintenance_requests`
  returns `place_node_id`).
- **Orders and Transfers** have All stores and a To receive / To send tab, which is what
  Home's Receive and Send tiles count.
- **Home's repairs line** is "N open repairs [Assign]": repairs nobody has taken yet, the
  ones that need someone now. Repairs already assigned are not on Home; the person doing
  them, or the one who assigned them, is told when they are done or late. Expired items
  waiting to be assigned are their own line.
- **The test-data loader's "today" is the 04:00 business day** (ADR 046), so expiry in the
  seeded data is right between 00:00 and 04:00 too.

## Consequences

- One migration (`ops.maintenance_requests` gains `place_node_id`).
- A unit test pins every Home count's link; a new e2e spec taps each count and checks the
  screen, the tab, "All ..." and the length of the list.
- The stock screen no longer has its own expiry banners; Home has them.

## Addendum (5 Oct)

The rule has a second half: **a row or line that names one place opens that place.** The
GM's "All departments" list on Home linked each department's low stock, attendance issues and
repairs to the all-departments view; each now opens its own department (its store for low
stock), and what sits at the outlet itself opens the outlet. The People report's outlet row
counted the people in no department (the GM, the AGM) but opened all 43; it now reads "Not in a
department" and opens those people only (`/team/people?node=...&here=1`), with a link to everyone.
In every case the list is as long as the row's count.
