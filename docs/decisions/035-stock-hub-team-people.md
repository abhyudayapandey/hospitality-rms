# 035 — Stock hub, sales copy, grouped notifications, Team People and Leave, swaps for management (UX-4, UX-5, SW-4)

Status: accepted · 2026-10-03

The next items of the UX review (docs/ux-review.md, U-12, U-13, U-18, U-19, U-21) and SW-4
from prospect feedback. The plan was approved before the work started. Migration
`20261027100000_stock_hub_hr`.

## The decisions

1. **Stock is a store's hub (U-12).** The Stock screen opens with what needs doing first,
   then the jobs, then the list:
   - attention cards: **Running low** (UX-6's three-day rule), the expiry banners (INV-12),
     **On its way here** (transfers sent to this place, not yet received) and **Count due**;
   - four buttons: **Count**, **Record wastage**, **Order**, **Request stock**, each shown
     only to people who may do it there (`lib/stock-hub.ts`; the RPCs still decide).

   A count is due `count_due_days` after the last submitted count at the store, or when
   there has never been one. `count_due_days` is a company setting (default 7, 1 to 60) in
   Admin → Settings, next to the other settings in `core.tenant.settings` (ADR 031).

2. **Sales entry (U-13)** has a search box, **Copy yesterday** and **Copy last
   <weekday>** (the quantities posted on those days, read under the same access), and the
   total sold as you type. Copying never saves: the person checks and saves as before.

3. **Notifications are grouped (U-21)** by kind and local day: "5 new tasks",
   "Roster published for 2 weeks"; a single notification stays as it is
   (`lib/notifications-view.ts`). Opening a line marks it, or every notification in its
   group, read, then goes to its link.

4. **Team → People and Leave (U-19).** Two Team tabs for people who manage worker records
   (WORKERS modify: HR, the outlet manager):
   - **People**: who works at the place, their job, since when, and whether they are
     inactive or a deactivation is waiting (`hr.team_people`, WORKERS view at the place);
   - **Leave**: who is off when, this month or next (`hr.team_leave`, LEAVE view, at most 92
     days).

   Everyone holds WORKERS view on their own record, so view alone does not show the tabs.

5. **Deactivation goes through approval.** "Deactivate" on People asks for a reason and
   starts a new process, **DEACTIVATION** (domain WORKERS; initiated by OUTLET_HR,
   HR_ADMIN, OUTLET_MANAGER; approved by the SECURITY_ADMIN of the nearest ancestor), via
   `hr.request_deactivation` → `wf.submit`. On approval the executor sets the login and
   the worker record inactive and tells the requester. We did not reuse ROLE_CHANGE: it
   needs USER_ACCESS and an access group, and deactivation is about the worker. One open
   request per person; nobody can ask for themselves.

6. **The outlet manager changes worker records** (OUTLET_MANAGER WORKERS view → modify),
   so a GM can ask for a leaver to be deactivated. The People report follows WORKERS modify
   (ADR 030), so the GM now reads it for their outlet, names included. The 99 access previews change with it;
   the RLS equivalence (all users) workflow ran on this change.

7. **Swaps for management only (SW-4).** A company setting, `swaps_managers_only`, on by
   default: `hr.request_swap` refuses `SWAPS_MANAGERS_ONLY` unless the person can change
   the roster (ROSTER modify) at the shift's place, and My shifts shows frontline staff no
   swap button. Admin → Settings and file 00 (`swaps_managers_only`, yes or no) turn it
   off. Test Company turns it off, so its swap flows and tests keep working.

8. **Small fixes from review.** Menu costs and prices is a card on Reports like the
   reports above it; the Menu screens have a **Back** link, and their tabs replace one
   another so Back leaves Menu.

## Consequences

- New companies get swaps for management only until they turn it off.
- A deactivated person can no longer sign in; reactivating them is Admin → Users, as
  before.
- The DEACTIVATION process and its bp-policy are synced into every tenant by
  `pnpm db:seed` locally and the deploy's sync step in the cloud.
