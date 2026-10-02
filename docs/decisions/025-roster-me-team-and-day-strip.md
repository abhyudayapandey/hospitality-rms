# 025 — Roster as Me and Team; the week as a day strip

Status: accepted · 2026-10-02

UX review findings U-10 and U-11, step UX-3. Screens only: no access change, no
infrastructure change. Every page keeps its address. One migration in the same PR fixes a
slow read found while testing (below).

## Me and Team (U-10)

Roster had seven tabs in one row, mixing a person's own things with their team's. They are
now on two sides:

| Side     | Tabs                           | Who has it                                                                          |
| -------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| **Me**   | My shifts, Clock, Leave, Swaps | My shifts, Clock and Swaps: people who work at an outlet. Leave: anyone with LEAVE. |
| **Team** | Roster, Exceptions, Events     | See below                                                                           |

- **Roster:** roster builders (ROSTER modify), and people with ROSTER view who have no
  shifts of their own (area manager, HR at head office). Before, the area manager reached
  the week roster only from the nav.
- **Exceptions:** people who resolve them somewhere, as before (audit #10).
- **Events:** event planners (EVENTS modify), and anyone else who has a Team side.

**The switch.** A **Me | Team** switch sits above the tabs only for people who have both
sides. Frontline staff (and supervisors who view but don't build the roster) have only Me,
with no switch. **Roster** in the nav opens on Team for roster builders and for people with
no shifts of their own, otherwise on My shifts.

**Events for frontline staff.** Staff hold EVENTS view, so a server could read the banquet
list. Events is now a Team tab; instead, **My shifts** lists the events in the next seven
days at every place the person may see, each linking to the event (read-only), as decided on
2 Oct.

**Where it lives.** `lib/roster-view.ts` (`peopleTabs`, `rosterLanding`) chooses the tabs
from the person's domains, the same `shell.domains` as before; it decides only what to
show. Every page still refuses what the database refuses (rule 2).

## The day strip (U-11)

The week roster was one card per shift: 42 cards for one kitchen week.

- **Day strip.** Seven chips, Mon to Sun, under the week arrows. Each shows the date and
  that day's open slots ("3 open", "full", or "–" for no shifts), with a dot when it has
  drafts. It opens on today when today is in the week shown, otherwise on Monday.
- **One day.** The chosen day's shifts, grouped by start and end time. Each row reads
  "Dinner · Commis · 0/1", with the people as name chips (✕ removes, as before) and
  **Assign** for open slots. A group heading shows its open slots.
- **List view** keeps the old one-card-per-shift week. Week arrows keep the view.
- **In the address only.** The day and the view are `?day=` and `?view=list`, like the place
  (ADR 016); nothing is stored per person (decided 2 Oct). Assigning someone returns to the
  shift's day.
- Template shifts (ADR 024) and Publish are unchanged.

## Tests

- `lib/roster-view.test.ts`: the tabs on each side for the shapes of server, sous chef,
  manager, HR at head office, area manager and event planner; where Roster opens; the strip's
  counts; the day picked; the time groups.
- `people.spec.ts`:
  - the server has only Me (no switch); the bar manager switches; HR at head office has
    Team and their own Leave;
  - the day strip's open slots equal the list view's for the same day; List view survives
    the week arrows;
  - a server reads a new event on My shifts and opens it;
  - the roster flows (assign, leave, swaps) run on the day view.

## Also fixed: the Menu page took 9 seconds

`inv.my_recipes()` and `inv.visible_prep_item_ids()` compared each recipe with
`inv.visible_recipe_ids()` written inline, so Postgres worked the list out again for every
recipe row (about 150 ms each). The cost controller's Menu page took about 9 s, and the
e2e tests for Menu timed out. Migration `20261019100000_recipe_reads_once` wraps the call in
a scalar subquery, as the RLS policies already do, so it runs once per call. Same rows, same
rule.

- `menu-access.db.test.ts` checks, for a cost controller, a general manager and a commis,
  that both functions return exactly the recipes RLS shows them, in under 2 s (it took
  10.8 s before the fix).
- `inv.visible_prep_item_ids()` is used by the prep procedure policy, so the all-users RLS
  run is done for this PR.

## Consequences

- Customers who don't use a module still see its tab; turning modules off per customer is
  step UX-3b.
