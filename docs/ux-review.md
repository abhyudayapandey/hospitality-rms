# UX review: making the app simpler for outlet staff

Status: **proposal, for approval** · 2026-10-02

We built the app one module at a time, and it shows. Each module has its own tabs, its own
words and its own idea of "where you are". This review walks every screen as eleven people
from both test customers and lists what to change, most useful first.

## How the review was done

- **The walk.** All 40 screens without an id in the URL, on a 412 px phone (Pixel 7), on a
  freshly seeded database, signed in as:
  - Test General Manager 1.0
  - Test Commis 1.0
  - Test Server 3.0
  - Test Room Attendant 1.0
  - Test Executive Chef 1.0
  - Test Store Keeper 1.0
  - Test Cost Controller 1.0
  - Test Area Manager
  - Test HR Executive 1.0
  - Test Account Owner
  - Test Bar Manager 3.0
- **What was read.** Each screen's text and a full-page screenshot.
- **What it measures against.** The goal is "simple for frontline users" (`docs/goal.md`).
  The test is whether a commis on their first day, on a cheap phone, in a busy kitchen, can
  do their job without asking anyone.

## What works

- **The bottom nav.** At most five items, chosen by the kind of work (ADR 020). A server sees
  Home, Tasks, Roster, Inbox and nothing they can't use.
- **Tasks.** "Overdue / Today / Coming up" with progress ("0 of 3") is clear. Out-of-range
  readings explain themselves.
- **Orders.** New orders start from the suggestion: par − on hand − on order.
- **Leave.** "1 calendar day · 12 available" tells you the result before you submit.
- **Errors.** Stable codes become plain messages; no SQL ever reaches the screen.

## Findings

Each finding has its own number (U-1 to U-25), which the plan below refers to. **Effort:**
S is under a day, M is a few days, L is a week or more.

### A. Home doesn't tell you what to do today

- **U-1 · M.** Home is a grid of buttons. "Waiting for you 0" is the only live number.
  - The commis has an overdue task and a shift today, but Home shows neither.
  - The GM's Home has 14 buttons, including Stock, Count, Wastage, Production, Orders and
    Transfers. Stock is also in the nav, and the other five are Stock tabs.

  **Proposal: Home becomes "Today".** A short list of cards, filtered by role, each with a
  single action:

  | Card            | Who sees it                  | Shows                                                        |
  | --------------- | ---------------------------- | ------------------------------------------------------------ |
  | Your shift      | anyone rostered              | "Today 06:00–14:00, Kitchen" and a big **Clock in** button   |
  | Your tasks      | anyone with tasks            | overdue and due today, first three, "See all"                |
  | Waiting for you | approvers, people who assign | approvals and To assign, with the oldest first               |
  | Needs attention | leads                        | below par, expired batches, open repairs, attendance flags   |
  | Today's numbers | outlet / area / cost roles   | sales, food %, beverage %, wastage (see `docs/reporting.md`) |
  | Shortcuts       | everyone                     | at most four, the person's most used screens                 |

- **U-2 · S.** "Hello, Test" uses the first word of the display name. That word is wrong
  for many names (initials, honorifics). Use the full display name, or drop the greeting
  and show the date and place instead.

### B. Words and codes

- **U-3 · S.** Raw codes are shown to people:
  - the roster and My shifts: `chef_de_partie`, `commis`, `kitchen_steward`, `room_attendant`;
  - Events: `12 banquet_server, 3 bartender`;
  - Admin → People: `ASSISTANT_GENERAL_MANAGER`.

  Show the job title instead ("Chef de Partie").

- **U-4 · S.** Same idea, different words:

  | Where                | Says                            | Should say               |
  | -------------------- | ------------------------------- | ------------------------ |
  | staff Home button    | Menu                            | Recipes (the page title) |
  | place switcher       | Viewing:                        | Place                    |
  | Roster tab for "me"  | My shifts / Roster              | My shifts / Team roster  |
  | Clock button on Home | Clock in (also when clocked in) | the action that applies  |
  | refusal pages        | You don't / You don’t           | one apostrophe style     |

- **U-5 · S.** Place names repeat the outlet on every line ("Test Hotel & Bar 1.0 –
  Kitchen", "Test Hotel & Bar 1.0 – Bar", …). Inside one outlet, show "Kitchen", "Bar",
  and group the switcher by outlet.
- **U-6 · decided: English only.** Everyone in hospitality reads enough basic English. The
  answer is short, plain words (B, above), not translation.

### C. "Where am I?": the place switcher

- **U-7 · S.** The default place is the first one alphabetically.
  - The GM opens Roster and sees **Admin & Finance: 0 shifts, Build week**. The kitchen with
    42 shifts is seventh in the list.
  - Default to the person's home department or store when it is in the list. Otherwise use
    the place with the most activity this week. Then remember the last choice per screen
    (ADR 016 keeps it in the URL; add a per-person default).
- **U-8 · S.** The switcher shows on screens with one place. A commis reporting a problem
  sees ten departments, because anyone may report anywhere in the outlet. Preselect where
  they work, and show the list only behind "Somewhere else?".
- **U-9 · M.** The area manager's Stock switcher lists 15 stores in a flat list, each ending
  "(view only)". Group them by outlet, and say "view only" once at the top.

### D. Too much on one screen, or too many screens

- **U-10 · M.** Roster is one module with seven tabs: My shifts, Clock, Leave, Swaps,
  Roster, Exceptions, Events.
  - It mixes "me" (shifts, clock, leave, swaps) with "my team" (roster, exceptions).
  - Events, a whole-outlet thing, sits in the middle.

  Split it into **Me** (My shifts, Clock, Leave, Swaps) and **Team** (Roster, Exceptions,
  Events). Frontline staff only ever see Me.

- **U-11 · M.** The week roster is one card per shift: 42 tall cards for one kitchen week,
  about 14,000 px of scrolling. Show it as a day strip (Mon–Sun) with one day's shifts,
  grouped by time, names inline, and the open slots marked. Keep the long list as "List
  view".
- **U-12 · M.** Stock has six tabs: Stock, Count, Wastage, Production, Orders, Transfers.
  Make the store page the hub:
  - "Needs attention" first: below par, expired, in transit, counts due.
  - Four action buttons: **Count**, **Record wastage**, **Order**, **Request stock**.
  - Production stays its own screen for the people who make things.
- **U-13 · M.** Daily sales is one long form of every menu item (40 rows at Hotel 1.0).
  - Add search and "copy yesterday's quantities".
  - Show the day's total as you type.
  - The real fix is the POS / CSV import (SAL-1, PRD 11), which this makes more urgent.
- **U-14 · M.** _(Done in R-2, ADR 028: the Cost of sales report.)_ The Variance report leads with formulas ("opening 0 bottle + in 2 bottle −
  out 0 …") for every item.
  - Lead with the rupee loss, the five biggest items, and "not counted" as one line.
  - Hide the formula behind a tap.
  - This becomes the cost controller's report in `docs/reporting.md`.

### E. Staff screens that worry people

- **U-15 · S.** My shifts shows five red "No show · Waiting for review" flags in a row to a
  commis. To staff, a flag reads like a warning letter.
  - Show the latest one with "Talk to your manager if this is wrong".
  - Collapse the rest.
  - Say what happens next ("Your manager will review it").
- **U-16 · S.** The Clock screen says "No shift rostered today" when today's shift has
  already ended, while My shifts lists it as today's. Say "Today's shift (06:00–14:00) has
  ended" instead.
- **U-17 · S.** Refusal pages ("You don't give out tasks anywhere.") are reachable from tabs
  and links people can't use.
  - Hide those tabs and links; the nav already does this.
  - Where a page must refuse, add a way back ("Go to your tasks").

### F. Roles with almost nothing to do

- **U-18 · M.** The **Account Owner** sees Home, Inbox, Admin, Requests. They have no view
  of stock, sales, costs, people or tasks anywhere: their access is admin only (ADR 010).
  For most customers the owner is the person who bought the product.
  - **Decision needed:** should the owner see the company's reports (read-only)?
    Recommended: yes, through the reports in `docs/reporting.md`.
- **U-19 · M.** The **HR Executive** can maintain worker records and leave for the outlet,
  but no screen lets them: their Leave tab is their own leave. Add **Team → People**
  (worker records) and **Team → Leave** (the outlet's leave calendar and balances).
- **U-20 · S.** The **Cost Controller**'s Home shows Tasks and Roster buttons, but not
  Variance or Sales, their daily work. The reports plan gives them a "Today's numbers"
  card and a Reports entry.

### G. Notifications

- **U-21 · S.** The commis's bell shows 7: five "New task" and two "Your roster is
  published".
  - Group by kind and day: "5 new tasks", "Roster published for 2 weeks".
  - Don't notify about a task the person can already see at the top of Home.
- **U-22 · M.** Web push (NT-1, planned) matters most for reminders and approvals. Without
  it, people only learn about things when they open the app.

### H. Small things that add up

- **U-23 · S.** Tap targets are good (≥ 48 px). Numbers need `inputmode="decimal"` on every
  quantity field, so the number pad opens. Check every form.
- **U-24 · S.** Units: "par 2000 · on hand 580 g" puts the unit on only one of the two
  figures. Write it as "par 2,000 g · on hand 580 g", with Indian digit grouping everywhere
  (Sales already does this).
- **U-25 · S.** Dates mix styles: "2 Oct, 02:54 pm", "Fri, 2 Oct", "Week of Mon, 28 Sept".
  Pick one short style, and use relative words for near dates ("today 2:54 pm",
  "yesterday").

## Proposed plan

Each step is its own branch and PR, with e2e coverage.

| Step  | What                                                                                                        | Findings                          | Size |
| ----- | ----------------------------------------------------------------------------------------------------------- | --------------------------------- | ---- |
| UX-1  | Words and codes; place names; switcher defaults; refusal pages; staff flags; Clock wording; units and dates | U-2–5, U-7, U-8, U-15–17, U-23–25 | M    |
| UX-2  | Home → Today (cards per role)                                                                               | U-1, U-20                         | M    |
| UX-3  | Roster split into Me / Team; day-strip roster                                                               | U-10, U-11                        | M    |
| UX-3b | Modules on or off per customer; taps counted for each role's five most common jobs                          | U-26, U-27                        | S    |
| AC-1  | Customer-specific access groups, built from the product's domains                                           | U-28                              | M    |
| UX-4  | Stock store hub; sales entry search and copy-yesterday; grouped notifications                               | U-12, U-13, U-21                  | M    |
| UX-5  | HR Team → People and Leave; owner read-only reports (with Reports R-1)                                      | U-18, U-19                        | M    |
| later | Web push                                                                                                    | U-22                              | M    |

The variance redesign (U-14) and the owner's view (U-18) are part of the reporting plan.

### Added 2 Oct 2026: fewer options, and access per customer

Asked after UX-2: are there too many options for people to use the app quickly, and can
one customer's roles or one person's rights differ from the rest?

- **U-26 · S. Modules every customer gets.** A customer that never uses Events or Prep lists
  still shows their tabs and links to everyone. Add a customer setting per module (events,
  prep lists, production, maintenance, swaps); an off module disappears from tabs, Home and
  the nav for that customer. The data and access rules stay; only the screens hide.
- **U-27 · S. Count the taps.** For each role, time the five most common jobs (clock in,
  record wastage, count a store, approve leave, assign a shift) in taps and screens, before
  and after UX-3 and UX-4. Anything over about three taps gets a fix.
- **U-28 · M. Access per customer.** What works today:
  - one person can get more: Admin → Users → add an access group at a place (sensitive
    grants need approval, every change is in the access audit), or file 08;
  - one customer's job roles can differ from another's (file 06, per outlet format);
  - one customer's approval chains can differ (file 00).

  What doesn't: a customer cannot change what a group allows ("our supervisors may approve
  wastage"), nor give one right alone. The groups are product code, and the deploy sync
  writes them into every customer and removes anything else (ADR 009).

  **AC-1:** customer-specific groups built from the product's domains, for example "Kitchen
  lead" = Stock User + wastage approval + Roster view. The domain matrix is already stored
  per customer and `core.can` already reads it per customer, so the work is: the sync leaves
  customer groups alone; an onboarding file and an Admin screen to build them; the existing
  guards (admin groups hold no business domains, sensitive grants need approval, labour cost
  only in groups of three or more, every change audited). Security tests first and the
  all-users RLS run, since it changes access rules.

## Progress

- **AC-1 done** (ADR 027): customer-specific access groups (U-28). The Account Owner builds
  groups in Admin → Access groups, or a platform admin in file 05, from the product's
  business rights; a group can carry the requests and approvals of product roles ("approves
  like a Department Head"). Test Company's Kitchen Lead shows it working.

- **UX-3b done** (ADR 026): modules on or off per company (U-26). The Account Owner turns
  Events, Shift swaps, Leave, Production, Prep lists, Checklists, Maintenance, and Menu and
  sales on or off in Admin → Modules (or file 00). Off means hidden from every screen and
  writes refused; the data is kept. Taps counted for nine common jobs (U-27,
  `e2e/journeys.spec.ts`): none needs more than two taps from Home to reach its screen.
  Filling an open slot took four; Home's "Needs attention" now links to the first day with
  an open slot.

- **UX-3 done** (ADR 025): Roster is two sides, **Me** (My shifts, Clock, Leave, Swaps) and
  **Team** (Roster, Exceptions, Events), with a Me | Team switch for people who have both.
  Frontline staff see only Me, and read the week's events on My shifts. The week roster is a
  day strip (open slots per day) with one day's shifts grouped by time; "List view" keeps
  the old cards.

- **UX-2 done** (ADR 023): Home is "Today". Cards:
  - your shift, with Clock in or out;
  - your tasks, overdue first;
  - waiting for you;
  - needs attention (leads);
  - today's numbers;
  - at most four shortcuts, with the rest under "All screens".

  Reports takes Menu's place in the cost controller's nav and joins the owner's and HR's.
  Roster "Add template shifts" now covers only tomorrow to day 7, asks first, and offers
  "Discard drafts" (ADR 024).

- **UX-1 done** (ADR 022): job titles; the place switcher (Place, short names, defaults,
  Change on Report a problem); Home date and labels; staff flags; Clock wording; units and
  dates. U-17 and U-23 needed no change (see ADR 022).

## Decisions (2 Oct 2026)

1. **Owner's view: yes.** The Account Owner reads every report in the company (U-18,
   `docs/reporting.md`).
2. **Language: English only** (U-6 dropped). Plain words matter more for that reason.
3. **Roster split into Me and Team: agreed** (U-10).
4. **Order of work:** UX-1 first (small, no new data), then UX-2 with R-1, because the
   "Today" home and the first reports share the same cards. Then UX-3, R-2, UX-4, UX-5
   with R-3 and R-4.
5. **Events for frontline staff** (UX-3): Events is a Team tab; staff see the next seven
   days' events on My shifts, read-only.
6. **Day and List view** live in the address only; nothing is saved per person.
7. **UX-3b and AC-1 added** (U-26 to U-28). **AC-1 comes before R-2.** Order now: UX-3,
   UX-3b, AC-1, R-2, UX-4, UX-5 with R-3 and R-4.
8. **AC-1:** groups are built by the Account Owner or a platform admin. Someone given extra
   access must be able to do those duties, approvals included: a custom group can carry a
   role's requests and approvals. Edits apply at once, after a preview of who is affected.
   AC-1 and R-2 are separate PRs.
