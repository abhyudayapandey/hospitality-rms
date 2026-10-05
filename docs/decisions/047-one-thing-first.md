# 047: Home and reports show one thing first

Status: accepted · 4 Oct 2026 · follows `docs/ux-audit-2.md` (V-1 to V-24); builds on ADR 034, 041, 042

## Context

The second UX audit found that people could not tell, in five seconds, what a screen said or
what to do. Reports were lists of equal figures, the manager Home was a wall of department
counts with a summed badge that meant nothing, long lists had no search, and the same
screen went by five names.

## Decision

- **Headline, then what to do, then details on tap.** Every report opens with three or four
  headline figures, large, against target; everything else is under "More figures".
  The set per report is `HEADLINE` in `lib/reports.ts`.
- **Terms stay; they are explained.** Items beyond tolerance, prime cost, days on hand,
  Stars, Plowhorses and the rest keep their names (a platform that knows the trade should
  sound like it). A one-line `hint` under the label says what each means.
- **Where the money went is drawn:** a bar of food, drinks, wastage and losses, and people,
  each a share of the total cost, with the numbers behind a tap and zero rows left out.
- **One base per column.** Home's outlet table shows Food, Drinks, Losses and People, each a
  share of the outlet's total cost, so the four add up to 100 (`rpt.league` gains
  `food_share`, `drink_share`, `losses_share`; `materials_pct` stays as their sum). Food cost
  as a share of food sales stays on Outlet today and Outlets side by side, with its base
  written under the column.
- **Manager Home:** one ranked "Do these first" list of at most five lines (`doFirst` in
  `lib/today-view.ts`): low stock, late tasks, open shifts, attendance issues, repairs, jobs
  to give to someone. What waits for the person's yes is its own card, "Waiting for you",
  with Approve and No; expired stock stays the banner. The department list is behind
  "All departments", one line each, with a dot for the worst and no summed number.
- **Clock in only near a shift** (on now, or starts within two hours). Otherwise Home says
  when the next shift is.
- **Long lists:** search and "Show more" (`FilterList`, `ListSearch`). Rows not shown are
  hidden, not removed, so a form still sends what was typed in a row out of sight.
- **One name:** the to-do list is **To do list** (it was Approvals, Inbox, Requests, Needs
  your yes). Many of the people who use it are not well educated, so a thing is named for what
  it is, not for the software word. My requests is
  "Things I asked for". Access group codes read as words.
- **Tabs wrap** instead of scrolling sideways, so none is hidden. We did not hide tabs
  behind "More": that adds a tap to jobs whose tap budgets are pinned (ADR 026).
- **No change** to hiding comparisons against an empty prior week (a test-data effect, not a
  real customer's), or to the menu engineering names.

## Consequences

- One migration (`rpt.league`, new columns, nothing stored changes); the Deploy workflow
  runs it. No re-import.
- E2E tests that listed the old labels (Approvals, Menu costs and prices) are updated.
- A welcome card shows once per role per phone (localStorage), words only.
