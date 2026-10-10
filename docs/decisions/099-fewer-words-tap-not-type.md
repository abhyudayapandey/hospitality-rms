# 099. Fewer words, one-line To do lists, tap instead of type

Date: 2026-10-10. Status: accepted. Plan: `docs/plans/ux-audit.md` (PRs 2, 4 and 6, shipped as
one at the owner's request).

## Context

The UX audit found that the people who use the app most read the least: a welcome card before
the job, three lines of who-gave-whom under every task title, To do rows three lines tall with
forty done tasks below them, paragraphs explaining rules, and numbers typed into empty boxes.

## Decision

1. **No welcome card.** Home opens on the job (the shift, then Next).
2. **One line under a task's title:** when it is due, red with "Late" when it is. Where it is,
   who has it, from whom, since when, "overdue when given" and the hand-over history are under
   **History**, folded for the person doing it and open for those who follow it (its managers,
   whoever handed it on). A repair is the same: where and from whom, then History.
3. **"Overdue when given" is for those who follow the task**, not the person doing it: it
   explains a late finish in reports and to managers, and reads as blame to the doer. This
   narrows ADR 074 for one's own list and task page; lists of other people's tasks keep it.
4. **One's own To do list is one line a task:** its picture, its title, when it is due (or its
   progress once started), and a red dot when late or urgent; done tasks fold into one row
   ("40 done") that opens on a tap and still says who did each (ADR 075). New task and Report a
   problem sit under today's work, on the first screen. Lists of other people's tasks are as
   before.
5. **Home's Next card** shows the next job with Start, then the three after it (each with its
   picture and time), then "See all N".
6. **A rule behind a "?"** (`components/info-tip.tsx`): the stock check's rule and the clock's
   location note are one tap away instead of a paragraph above the list.
7. **Tap, don't type** (`components/stepper.tsx`): − and + either side of every number a
   frontline person enters (counts, room counts, minibar checks, laundry, breakage, wastage,
   received quantities, readings), the box still typeable. A reading shows its safe range first
   and the whole numbers around it as buttons, green inside, amber one out, red beyond
   (`quickPicks`). The steps still to come show as their pictures. Leave has Today and Tomorrow,
   then 1, 2 or 3 days. Nothing is pre-filled (ADR 054): a − or + on an empty box starts from
   the par or the expected count where there is one.
