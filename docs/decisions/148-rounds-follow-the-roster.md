# 148. Rounds follow the roster; one person told to receive; one "today"

Date: 2026-10-15. Status: accepted. Migrations `20261230100000_rounds_follow_roster`,
`20261230110000_receive_on_keepers_todo`, `20261230120000_in_pool_fast`.

## Context

The re-audit walked every person of the four test customers at phone width, around midnight.
It found the daily-use problems in tasks and dates:

1. **Rounds went to people who were not working.** A job-role round reached everyone in the
   role all day. Host Ria, off today, had six washroom rounds. A commis on the 14:00–22:00 shift
   had "Kitchen opening by 07:00". The public area attendant had lobby rounds every two hours
   until 22:00, four of them after she went home. Both security guards had all 15 rounds.
2. **Outlet-level roles never got theirs.** The Assistant Manager sits at the outlet; his
   Mid-shift reset and Lock-up sit in the Restaurant. The pool needed the person's place under
   the task's, so he never saw them.
3. **Four people were told to receive one delivery**: the store keeper, the GM, the Purchase
   Manager and an executive chef each had "To receive" on their To do list.
4. **"All done" with rounds late.** The Security tile on the supervisor's Home was green while
   both guards had a night patrol overdue.
5. **"Today" meant three days after midnight.** Home's heading used the calendar date; the
   cards under it used the 04:00 business day. A bartender on 17:00–01:00 read "Wed 14 Oct" on
   Home, "Today" on Clock and Thursday's shift as "Today" on Shifts & leave.
6. **Late rows had no day, and two clocks.** Home said "by 16:00 · Late" for yesterday's round;
   Home used 24-hour time, the To do list "6:15 pm".

## Decision

1. **A job-role round goes to the role's people who work at its due time** (`ops.job_role_pool`,
   used by `ops.in_pool` and `ops.task_people`): on a published shift that covers it (both ends
   count, a night shift past midnight too) or clocked in. Someone with no shift at all in the
   seven days either side is not on the roster (a manager, a salaried head, a customer without
   rosters) and keeps their role's rounds as before. Covering roles (ADR 061) follow the same
   rule.
2. **Nobody of the role at work: the department head** (`ops.leads`: the department's head, else
   the outlet's managers). The decision was the user's: the department head, not whoever happens
   to be on shift.
3. **An outlet-level role gets the rounds of its outlet's departments**: the role's people match
   a task at their place, below it or above it.
4. **To receive is the keepers'.** An order to receive is on the To do list of its order desk's
   keepers (`inv.desk_keepers`, the STORE_KEEPER holders, as `inv.notify_desk` tells them). The
   GM and others who may receive see it in Orders. A desk with no keeper keeps it as before.
5. **A department tile counts late rounds**: "2 late", amber, opening Team tasks there, the same
   list (its last seven days) the count comes from. It is never "All done" while one is late.
6. **One "today": the 04:00 business day** (`businessToday`). Home's heading, the shift card, Clock
   and Shifts & leave use it; a shift that is running reads "Now". The To do list groups by it.
7. **24-hour time everywhere** (the user's decision): `formatWhen` reads "today, 14:54",
   "yesterday, 09:10", "tomorrow, 07:00". A task's due time says its day when it isn't today
   (`dueText`: "Yesterday 16:00", "Tomorrow 07:00").
8. **Test data**: Test Company's front desk handover goes to the Front Desk Executive (it was
   "whoever is on shift", which put it on the Bellboy). Passport's security guards are on the
   roster from this week, 12-hour shifts, four a week each; the other nights the supervisor has
   the rounds.

## Consequences

- A rostered person sees only the rounds of their own shift. A round nobody is on shift for
  lands with the department head, which is where a manager would look for it anyway.
- A customer that does not roster at all sees no change.
- Working out a round's pool once per task keeps the lists quick: who is told of every open
  round at Test Company takes under a second. "Is this person in the pool?" is asked from the
  person's side (`ops.of_task_role`, then `ops.working_at`; the whole pool only for those who
  hold a head's group), so the To do badge on every page stays under 0.2 s. Team tasks works a
  round's pool out only at the viewer's outlet, and a department tile's late count is
  `ops.late_count` (the late rows of that list, pinned equal to it by a test).
- The rest of the re-audit (dead tiles, codes on screen, who sees what, forms, words) follows in
  later PRs.
