# ADR 135: Roster changes wait for Publish

Status: accepted

A manager marked someone Off on a published day. The person was taken off and told at once,
Publish (N) did not count it, and Start again (ADR 132) could not take it back. Putting someone
on a published shift was the same. The roster is a draft until Publish everywhere else, so this
was the odd one out.

- A change to a published shift now waits, like a draft:
  - taken off (Off, another tile, the ✕): the assignment stays `assigned` with `coming_off`, so
    the person still sees the shift, and every rule and report still counts it;
  - put on: the assignment is `pending`, which nothing outside the roster counts (staff screens,
    clock, reports and tasks read `assigned` only).
- The roster rules (`hr.assignment_checks`, `hr.assignment_violation`, candidates, headcount)
  see the roster as it will be once published: pending counts, coming off does not.
- `hr.week_changes(node, monday)` counts drafts and these changes: Publish (N) and Start again
  show on it. Publish applies them and tells each person once ("New shift added", "Shift
  removed"); a shift made for one person goes once nobody is left on it. One already under way
  keeps its person.
- Start again (`hr.discard_drafts`) also drops the pending and clears coming off: the roster is
  back to what staff last saw. Tapping the published type again does the same for one person.
- The roster by person marks a row with a change "Not published"; by shift, a person put on a
  published shift reads "new".
