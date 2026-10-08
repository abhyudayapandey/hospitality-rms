# 075 — Every role has its day's checklists, and done stays in view

Status: accepted · 2026-10-08 · migration 20261201100000

Viewed as the Passport Hotel's server, the To do list said "Nothing due today". The demo's
files gave daily checklists to 8 of its 38 job roles; the SOP library had the restaurant's
opening, briefing and closing, but an outlet only got them through the set-up wizard, and
there they went to "whoever is on shift", so with no roster for the day nobody had them.
And a done task left the To do list after 24 hours, vanished from everyone else in its job
role at once (the other room attendant could not even open it), and left "Given to others"
the moment it was done.

## Decision

1. **A library checklist names the job roles that do it in the SOP**, first choice first
   (`LibraryChecklist.roles`, `packages/domain/src/checklists.ts`): Restaurant opening is the
   steward's or server's, the pre-shift briefing the captain's, the chiller log the chef de
   partie's. An outlet's copy goes to the first of them that works in its department there
   (`role:STEWARD` in file 29), so it is on their To do list every day without a roster; with
   none of them there it goes to whoever is on shift, as before. Adding the roles is not a
   new library version: no outlet's copy is offered a change for it.
2. **Every role that works shifts has a daily checklist of its own** in every outlet
   template, whatever is ticked: 14 new library checklists from the SOPs (section set-up,
   cash and card close, crew stations, delivery apps, bell desk, rooms cleaned, turndown,
   laundry, tray collection, plant round, night patrol, bar back restock, banquet mise en
   place, spa desk). `outlet-template.test.ts` checks it for every tile, with and without its
   extras and offered departments. The managers and the office are not on rounds.
3. **The Passport Hotel demo** gives every shift role its day (28 checklists, most copies of
   the library's), pinned by `passport-demo.db.test.ts`.
4. **Done stays in view**: a done task stays on the To do list, under Done, for the
   business day it was done and the next (`ops.done_lately`, the 04:00 day in the place's
   time zone), for whoever did it, whoever had it and everyone its job role or shift was
   given to, saying who did it and when ("Done by you", "Done by Rohan"). Anyone it was for
   may open it (`ops.sees_task`). What someone gave to someone else stays under "Given to
   others", on To do and Home, marked Done, for the same two days; a done repair stays on
   the technician's list for them too. Home's "Do these first" and its counts are what is
   still to do. Team tasks already listed done tasks by date.

## Consequences

- Seeing a done task its job role was given is new access: the RLS equivalence (all users)
  workflow runs on it.
- A checklist still goes only to a job role someone holds (or covers) at its place, with one
  exception: a copy of a library checklist (file 29's `from_library`) may go to one of that
  checklist's own SOP roles before anyone holds it there, since a new outlet from a template
  has its checklists before its people. Its rounds show on Team tasks and escalate as any
  task nobody does until someone joins in that role; who covers it (ADR 061) gets them.
- Pinned by `packages/db/src/done-stays.db.test.ts`, `outlet-template.test.ts` and
  `apps/web/e2e/done-stays.spec.ts`.
