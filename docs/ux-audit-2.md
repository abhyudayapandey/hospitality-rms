# UX audit 2: what each role sees, and a plan to simplify it

Status: **approved 4 Oct 2026, built as UX-7 to UX-12 in one PR (ADR 047)**; changes to the plan: V-2 dropped (empty comparisons stay), menu names kept, tabs wrap instead of "More" · follows `docs/ux-review.md` (U-1 to U-28, UX-1 to UX-6)

The first audit fixed words, places, Home and navigation. This one asks a different question:
**can each person tell, within five seconds of opening a screen, what it says and what to do?**
Reports, manager Homes and long lists still fail that test.

## How it was done

- The deployed `master` (904e974) on a freshly seeded database, at **380 px** (the width
  `CLAUDE.md` designs for), as ten people: Commis, Server, Store Keeper, Executive Chef, Cost
  Controller, General Manager, Area Manager, Account Owner, HR Executive and Bar Manager.
- About 50 screens each, screenshots and full text. All text was scanned for codes and jargon.
  Around 15 screens were read closely as pictures: the Homes, Reports, Stock, My shifts, Inbox,
  Roster, Admin.
- **Not covered:** Front Desk and Room Attendant (the first run was interrupted), the forms (new
  order, stock check, wastage, leave request), Events, the platform console, a real phone or
  slow network, and real staff. The numbers come from test data, so a few oddities (51
  attendance issues, "last week" being zero) are data, not design; every layout finding below
  stands without them.

## What already works

- **Frontline Home.** One big shift card, one big button, four tiles (Commis).
- **Store hub.** Four big buttons and a "Count due" banner (Store Keeper).
- **Roster day strip** with "full / open" per day (Bar Manager).
- Item names, tap targets and colours are clear. Reports now open every row (ADR 041).

## Findings

Severity: **H** a person can't do or understand the job; **M** slows them or misleads;
**L** polish. Each has a number (V-1 …) for the plan.

### A. Reports: facts without a story

- **V-1 · H · Every report is a list of equal numbers.** Outlet today is 2,632 px tall: about 25
  figures in six boxes, all the same weight. A GM can't see which three matter. Cost of sales is
  2,669 px, Menu report 3,819 px.
- **V-2 · H · Comparisons against nothing.** "Sales ₹2,10,000 ▲ ₹2,10,000 vs last week" and
  "People cost % ▲ 61.9 pts" compare with a week that had no data, and show a green or red arrow
  anyway. People read a signal that isn't there.
- **V-3 · H · Two bases side by side.** The area manager and owner table shows `Food 11.1% |
People % 75.8%`. Food is a share of food sales; People is a share of total cost (ADR 042).
  Next to each other they read as two shares of the same thing.
- **V-4 · H · Stock position is 7,314 px.** It lists all 56 items that haven't moved, each with
  the store's full name ("Test Hotel & Bar 1.0 – Kitchen Store") repeated, and the value
  by category, expiring and aging all in one scroll.
- **V-5 · M · "Where the money went" is a 14-row table** with eight rows at 0 / 0.0%. The three
  numbers that matter (materials, people, losses) are not drawn as a picture.
- **V-6 · M · Jargon.** "Items beyond tolerance" (10 screens), "prime cost" (8), "Stars,
  Plowhorses, Puzzles, Dogs" (12), "days on hand" (14), "dead stock" (7), "overtime" (16),
  "Whole place". A cost controller knows them; a GM or owner has to guess.
- **V-7 · M · Reports list is 11 cards of one sentence each,** in the order they were built, with a
  duplicate "Menu costs and prices" at the end. Nothing says "start here" or groups them by
  question.
- **V-8 · M · Empty values show as "–" or "0.0%"** (Food cost `–`, Sales per hour `–`) with no
  line saying why ("no sales entered yet").
- **V-9 · L · Period chips run off the right edge** ("Yesterday · Last 7 days · Last 4 weeks ·
  T…"); nothing hints at the swipe.

### B. Manager and owner Homes: an alarm wall

- **V-10 · H · General Manager's "Needs attention" is 9 departments × 3 to 4 lines,** each with
  a red or amber badge (51, 37, 43 …). The badge adds attendance issues, open shifts and low
  stock into one number with no meaning. Nothing is first. "Today so far", the thing a GM opens
  Home for, is at the bottom.
- **V-11 · M · "Needs your yes: 1 to give to someone"** is unclear. It's a maintenance job to
  assign, not a yes; it sits under an "Approvals" tab that has no approvals in it.
- **V-12 · M · Area manager Home repeats "N items running low" for 8 stores** in identical red
  rows, then the outlet table. Four of the outlets show ₹0 and `—` rows.
- **V-13 · M · Account Owner Home** is a single table; to go anywhere else the owner must know
  to tap All figures, Reports or Admin.

### C. Frontline screens

- **V-14 · H · Commis Home shows "Tomorrow 06:00–14:00 · Not clocked in" with a Clock in button**
  on a day with no shift. It reads as "clock in now". The button should appear only when a shift
  is near or running.
- **V-15 · M · My shifts is eight identical cards** ("17:00–01:00 +1 · server", each with Swap),
  then five past cards. The next shift, the thing a server needs, isn't singled out. `+1` is
  unexplained and `server` is a lower-case code.
- **V-16 · M · Three ways to the same screens:** Home tiles, the Me list (14 links) and the My
  shifts tabs (My shifts · Clock · Leave · Swaps).
- **V-17 · M · Tasks has its own tab strip** (Mine · Maintenance · Report a problem) and a
  task title can be cut ("Deep clean the walk-in c…") on the Home card.

### D. Stock and orders

- **V-18 · M · Store hub has no search.** Fine at 16 items; Test Company's stores hold 300. The
  tab row is cut off ("Or…"), and "keep 100 kg" doesn't say it is the level to keep.
- **V-19 · M · Order forms are 3,905 to 4,468 px:** one row per item, no search, no "only items I
  usually order".

### E. Navigation and words

- **V-20 · M · Inbox, Approvals, Requests, My requests, Needs your yes** are five names for
  nearly the same thing.
- **V-21 · M · Tab pills overflow on almost every module** (Stock, Roster, Tasks, Reports); the
  last tab is hidden at 380 px.
- **V-22 · L · Raw codes survive** on Admin and Roster: `DEPARTMENT_HEAD`, `STOCK_USER`,
  `store_keeper`, `server`.
- **V-23 · L · Each screen spends about 170 px** on Place picker, back link, title and sub-tabs
  before the first number.

### F. Long lists

- **V-24 · H · Admin is 23,921 px** (Recent access events lists every user created: 602 lines).
  Admin → People is 12,049 px, Exceptions 5,993, Team People 5,891.
  None has search, filters, or "show more".

## The plan

One rule for every report and Home: **headline → what to do → details on tap.** Each step is its
own branch and PR, with e2e coverage and tap counts pinned where they apply.

| Step      | What                                                                                                                                                                                                                                                                                                                                                                                                               | Fixes              | Size |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ---- |
| **UX-7**  | **Reports redesign.** Each report opens with 3 to 4 headline numbers and traffic lights against targets; "Where the money went" as a drawn bar, table behind a tap; every figure after that behind "More figures". Hide empty comparisons. Stock position: top 5 expiring, top 5 not moving, rest behind "See all" with search. Group the reports list by question. Glossary of plain labels. One base per column. | V-1 to V-9         | M-L  |
| **UX-8**  | **Manager Home.** One ranked "Do these first" list (max 5, one action each) replaces the department wall; departments collapse to one line each; numbers first for the GM, outlet traffic lights for the area manager and owner. Rename "Needs your yes" and fix what sits under Approvals.                                                                                                                        | V-10 to V-13, V-20 | M    |
| **UX-9**  | **Frontline.** Clock in only near or during a shift; My shifts leads with the next shift and a week strip, repeated rows collapse; "ends 01:00 next day" for `+1`; title-case job names; one path to each screen.                                                                                                                                                                                                  | V-14 to V-17       | S-M  |
| **UX-10** | **Lists that scale.** Search plus "show more" on Admin audit, Users, People, Exceptions, order forms, store hub; a standard pattern.                                                                                                                                                                                                                                                                               | V-18, V-19, V-24   | M    |
| **UX-11** | **Navigation and words.** Tabs fit at 380 px (at most 4, rest under "More"); one name for the to-do list; remove raw codes; slimmer screen header.                                                                                                                                                                                                                                                                 | V-20 to V-23       | S    |
| **UX-12** | **Prove it.** Five people at the pilot outlet do their main job without help, timed; tap counts pinned; first-run tour.                                                                                                                                                                                                                                                                                            | all                | S    |

Order: **UX-7 and UX-8 first** (the screens decision-makers judge the product by), then UX-9,
UX-10, UX-11, with UX-12 at the pilot.

### Plain labels proposed for UX-7

| Now                                 | Proposed                                                      | Why                     |
| ----------------------------------- | ------------------------------------------------------------- | ----------------------- |
| Items beyond tolerance              | Counts that don't match                                       | says what happened      |
| Items not counted (87)              | Not counted in this period: 87 · **Start a count**            | adds the action         |
| Prime cost                          | Total cost                                                    | what it is              |
| Stars · Plowhorses · Puzzles · Dogs | Keep · Fix the cost · Promote · Drop (old name in small type) | says what to do         |
| Days on hand                        | Lasts about 25 days                                           | a sentence, not a ratio |
| Dead stock                          | Not used in 30 days                                           |                         |
| Whole place                         | Total                                                         |                         |

## Decisions needed

1. **Reports:** hide any figure whose comparison period is empty, rather than showing an arrow
   against zero. Recommended: yes.
2. **Manager Home:** replace the per-department wall with one ranked list of five. Recommended:
   yes, with "All departments" one tap away.
3. **Menu-engineering names:** change to Keep / Fix the cost / Promote / Drop. Recommended: yes,
   keeping the old names in small type for cost controllers.
4. **Order:** UX-7 and UX-8 first. Recommended: yes.
