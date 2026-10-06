# Reports audit (6 Oct 2026, ADR 057)

## Scope

- Every report, figure and list, as every kind of user with reports. The test customers
  give 14 different sets of reports across 123 people.
- Method:
  1. A sweep compared each figure with its list, its trend and the report it is drawn from:
     7,144 checks, for all 123 people.
  2. A reading of every `rpt` function and the cost functions they call.
  3. Every report screen was opened for one person of each set.

## Found and fixed

| #   | Where                                                         | What was wrong                                                                                                                                                                         | Fixed                                                                                      |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Department today, Outlet today, Home "On shift today", trends | "Shifts" counted every published shift, empty ones too, while the people list behind it counted people on shifts (the Executive Chef's 6 vs 3)                                         | Shifts = one per person on a shift; empty ones are open slots                              |
| 2   | People report                                                 | Shifts counted only shifts already started, by roster date; its list counted every shift, by business day, at the place rather than by the people who belong to it (Bar 3.0: 10 vs 20) | One count, by business day; the report and its list are the people who belong to the place |
| 3   | People report                                                 | "On time" shrank when the period held shifts still to come                                                                                                                             | A share of the shifts that have started                                                    |
| 4   | People report                                                 | Approved swaps counted by UTC date                                                                                                                                                     | By the place's business day                                                                |
| 5   | Department and Outlet today, Home                             | A task due later today counted as due and **overdue**, and lowered "Tasks on time", all day                                                                                            | Counted once its time comes, or when done                                                  |
| 6   | Cost of sales (wastage, expired, cost parts), count variance  | A store or outlet with no time zone of its own cut days at UTC midnight (05:30 in India); the test data hid it because every store has one                                             | The outlet's time zone (`ops.tz_of`)                                                       |
| 7   | Cost of sales → dishes                                        | A bar manager, executive housekeeper or F&B manager saw every **food** dish's sales and cost behind a report that shows them only the bar's                                            | The dishes of the stores the report covers for the person                                  |
| 8   | Home "Today so far"                                           | Figures could not be tapped                                                                                                                                                            | Each opens its trend; "Not in yet" opens the department report                             |

## Checked and found right

- **Departments and outlets:** hours rostered and worked, late, no-shows, tasks done and
  flagged, wastage, stock value and sales all equal their lists, for every person, today,
  yesterday and 3 days ago.
- **Trends:** every figure equals its trend's point for the day.
- **Outlets side by side:** each outlet's sales equal Outlet today's, day by day.
- **Stock position:** value, dead stock and expired value equal the item list and the trend.
- **Central kitchen:** transfers, requested, dispatched and transit loss equal the
  outlet-by-outlet list.
- **Cost of sales:** wastage and expired equal the wastage list; food and drinks sales equal
  the dishes.
- **Errors:** no report or list raises an error for anyone who has it.
- **Screens:** none shows NaN, undefined, null, Invalid Date or an error page, for one person
  of every set.
- **Access:** the existing refusal tests still hold (`reports-refusals-*`, `reports-access`).
  The Auditor has no reports, as intended: the audit log only.

## Known, not changed

- **Food and drinks cost when one store serves both menus.** The cost is split between the
  menus by their share of sales, not by recipe. Exact per-dish depletion would need the
  sales posting to record each dish's ingredients. Raise it if a pilot outlet serves food
  and drinks from one store.
- **Two lenses on people.** The People report counts people by where they belong; Department
  and Outlet today count by where they worked. Someone who covers a shift in another
  department appears in each, by design.
