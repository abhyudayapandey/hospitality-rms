# 030 — Labour cost, People and the central kitchen reports (R-3)

Status: accepted · 2026-10-03

`docs/reporting.md` step R-3. The six decisions of 3 October are below. Built as one change,
at the user's request.

- **Migration** (forward-only): `20261023100000_labour_reports`.
- **Test data:**
  - a new file for any customer, `34_pay_rates.csv`;
  - two new test-only files, `35_attendance_TEST_DATA_ONLY.csv` and
    `36_transfers_TEST_DATA_ONLY.csv`;
  - central kitchen rows added to files 26 (batches) and 32 (prep lists).
- **Deploy:** no stack change. Both test customers are re-imported for files 34 to 36.

## The six decisions (3 Oct)

1. **What a person costs.**
   - Salaried staff: the monthly rate × 12 ÷ 365 for each day they are employed, worked or
     not.
   - Hourly staff: hours worked × the rate.
   - **Wherever a total cost shows, its parts show too** ("Where the money went"): raw
     materials by recipe (food, drinks), expired, lost in transit, other wastage, other use,
     lost at the count; people (hourly, salaried); and the total, prime cost. Each line is
     in ₹ and as a % of sales. The people lines show only to those who see labour cost.
2. **Overtime** is costed at the normal rate (1×) and shown in hours. The multiplier
   becomes a company setting in R-4.
3. **Small groups.** No one's pay can be worked out from a figure:
   - A department with fewer than 3 paid people that day goes into "Other departments".
   - If Other departments still has 1 or 2 people, the smallest department shown joins it.
   - An outlet with fewer than 3 paid people shows no labour cost at all.
4. **Leave liability** (unused leave this year): in days for the HR Executive, in ₹ only
   with LABOUR_COST or REPORTS. A day's pay is rule 1's; hourly staff count 8 hours. A leave
   type's value shows only when 3 or more paid people hold it, and the total is the sum of
   the types shown.
5. **The central kitchen report** opens on the R-2 store rule (ADR 028): MENU view or
   PURCHASE_ORDERS modify at the kitchen store, or REPORTS above it.
6. **One change** for labour, People and the central kitchen.

## Who opens what (rule 2: `core.can` only)

| Report / figure                                                   | Rule                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Labour cost, labour %, prime cost, SPLH on Outlet today           | LABOUR_COST view or REPORTS at the outlet or site                        |
| Labour cost on Department today                                   | LABOUR_COST view or REPORTS at the department                            |
| People cost by department, people lines in "Where the money went" | as Outlet today                                                          |
| **People**                                                        | REPORTS or WORKERS **modify** at a company, region, area, outlet or site |
| People: names of who was late or did not come in                  | WORKERS modify only (REPORTS shows totals, never a person, ADR 023)      |
| People: leave in ₹                                                | LABOUR_COST or REPORTS                                                   |
| **Central kitchen**                                               | at a kitchen store (one that supplies others): the R-2 store rule        |
| Purchasing: "From the central kitchen"                            | Purchasing's own rule at the receiving store                             |

- **A new domain, LABOUR_COST** (org tree), view only. The product matrix grants it to the
  outlet manager, area manager and HR admin groups. The Account Owner sees labour through
  REPORTS, as for every other report.
- **LABOUR_COST is not a sensitive domain.** It holds totals over 3 or more people, never a
  person's pay. COMPENSATION (each person's rate) is unchanged and stays sensitive.
- **Stored rows.** `rpt.labour_cost_day` has RLS on LABOUR_COST over `org_node_id`. Like
  every `rpt` table, it is read only through functions; REPORTS reads it through them.
- **Labour belongs to the worker's home place** (department or outlet), not to where a
  shift was worked.

## How it is built

- **`rpt.labour_cost_day`**, one row per day per department, "Other departments" and outlet,
  rebuilt with the other report tables (35 days nightly, ADR 023). Today and yesterday are
  worked out live, as for the other measures.
- **Hours and overtime** come from attendance, with overtime as hours over the weekly limit
  in the roster rules (`hr.roster_rules().weekly_hours_cap`).
- **Cost parts.** `menu.cost_parts` splits `menu.cost_calc`'s actual cost into its parts;
  `menu.cost_calc` is now their sum, so Cost of sales and the R-2 figures are unchanged.
  `rpt.cost_breakdown` adds the people lines.
- **Pay history is not kept.** Every recalculation uses each person's current rate, so a pay
  rise changes the last 35 days' labour cost at the next rebuild. Keeping rate history is a
  follow-up if customers need it.
- **The central kitchen report**: batches made against the prep lists, value made,
  ingredients used over the recipes, expired batches; per outlet what was asked for, sent
  and received (fill rate, transit loss, short lines); and what is on the road now.
- **Transfers with a time.** `inv.dispatch_transfer_at` and `inv.receive_transfer_at` hold
  the app's dispatch and receipt code, and `inv.dispatch_transfer` and
  `inv.receive_transfer` call them with `now()`, so the app works as before. This is the
  same pattern as `inv.receive_at` in ADR 028.

## Test data

- **File 34, pay rates** (any customer): one rate per person, hourly or monthly. Test
  Company has 112 rows and Test Solo Bar Co 9; the Account Owner has none. Monthly rates
  divide into round daily figures (₹36,500 a month is ₹1,200 a day). Bar 3.0's rates moved
  here from the dev seed.
- **File 35, attendance** (test customers only, ADR 017): 95 clock-in/out pairs over the
  last week, loaded as the person who worked (`hr.record_test_attendance`, refused for real
  customers and future times, `platform_loader` only).
- **File 36, transfers** (test customers only): two central kitchen transfers of Onion
  Tomato Masala, requested, dispatched and received by the people named. One reaches Hotel
  1.1 short; one is still on the way to Bar 3.0. The requester can't be the dispatcher or
  receiver.
- **Files 26 and 32** gain the central kitchen's batches and prep lists. Production loaded
  files 26 to 32 weeks ago, and they load once per customer, so the loader now works out
  the load day **per store**: a store whose test batches are already there keeps their day;
  a store new to the files (the central kitchen) counts from the day of the import, and
  keeps that day at later imports. `loader.db.test.ts` covers this case.

The figures are in the test data README, pinned by `labour-reports.db.test.ts`.

## Follow-up found on the way

`ops.team_of_store` picks a store's team alphabetically. At the central kitchen store that
is the Dispatch Team, so a prep list assigned to `role:CENTRAL_KITCHEN_CHEF` is refused
(INVALID_ASSIGNEE). File 32 assigns the kitchen's prep lists to the kitchen manager by name
for now. Fix: let a store name the team its prep lists go to.

## Tests

- **`labour-cost.db.test.ts`:**
  - the small-group rule on fixtures;
  - every user's labour access against the rule;
  - stored rows readable with LABOUR_COST only;
  - which Outlet today and Department today measures each person gets;
  - COMPENSATION unchanged; the test-only functions refused to `app_rw`.
- **`labour-reports.db.test.ts`:** the README figures for labour by department, the cost
  breakdown, the central kitchen, Purchasing's transfers in, and People in days and ₹.
- **`reports-access.db.test.ts` and `reports-refusals.db.test.ts`** (every user): People and
  Central kitchen places match their rules; every other place is refused.
- **`reports.test.ts`** (unit): the cost parts, their share of sales, the 93-day limit.
- **`labour-reports.spec.ts`** (e2e): the GM sees people cost and prime cost; the cost
  controller and executive chef don't; the HR executive sees People in days, the HR admin
  in ₹; the kitchen manager and store keeper open Central kitchen, the chef can't; Hotel
  1.1's chef sees what came from the kitchen; a bartender opens neither.
