# Reporting: what each role sees, and how it is built

Status: **approved** (decisions in section 8) · **R-1 done** (ADR 023) · 2026-10-02

Outlet Ops already records the facts a hospitality business needs to run on numbers: every
stock movement, what was bought and at what price, what was made and thrown away, what was
sold, who was rostered and who turned up, and which tasks were done on time. Today they are
spread across screens, and only the Variance report adds them up. This plan turns them into
reports that each person can act on, at the level they are responsible for.

## 1. What competitors offer

| Product                           | Reports worth learning from                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Restaurant365**                 | A **daily flash report**: one day's sales, labour, discounts and comps, per location or across locations. **Prime cost** (COGS + labour) tracked daily, not monthly.                    |
| **MarketMan**                     | **Actual vs theoretical** usage per item. It needs two counts, deliveries, recipes, the waste log and POS sales. The gap points to theft, waste and over-portioning.                    |
| **Apicbase**                      | Theoretical vs actual by location; **inventory valuation and cost trends per site** with the same recipe, unit and category definitions everywhere.                                     |
| **Supy**                          | **Purchase price variance**, supplier performance and savings dashboards, cost per category and location, discrepancy alerts.                                                           |
| **7shifts**                       | **Labour %**, **sales per labour hour** (SPLH), scheduled vs actual, overtime risk.                                                                                                     |
| **Petpooja** (India)              | A **consumption report at close of day**: expected vs actual use per raw material, outlet by outlet, with outlet-wise reporting rights for the owner.                                   |
| **Restroworks** (India)           | Closing stock, variance and stock ledger reports for outlets, the warehouse and the **central kitchen**, including indent (transfer) fulfilment.                                        |
| **BinWise**                       | **Pour cost** and beverage variance per bottle, across every bar, from POS sales and deliveries.                                                                                        |
| **Jolt / Zenput**                 | **Checklist completion and compliance** by location and by person, location against location. Jolt reports Culver's going from about 20% to over 90% list completion.                   |
| Menu engineering (Kasavana–Smith) | The **menu engineering matrix**: each dish's contribution margin against its popularity, sorted into Stars, Plowhorses, Puzzles and Dogs. Several tools (Toast, Loaded, meez) offer it. |

### What we take from them

- **One daily flash per outlet.** It is the report managers open every morning.
- **Prime cost.** It is the number owners care about.
- **Actual vs theoretical by item.** It is where the money leaks.
- **Never blend outlets into one number.** An average hides the outlet with the problem
  (Apicbase's point), so area and company views are league tables first.

### What none of them do, and we can

- Put **people and operations next to cost**: task compliance, attendance and approvals
  beside food cost, for the same outlet and day.
- Respect the same **place-based access** as the rest of the app, so a department head
  sees their department and nothing else.

## 2. The facts we already have

| Fact (one row per)               | Table                                      | Gives                                           |
| -------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| Stock movement                   | `inv.stock_ledger`                         | value in/out by type and store, at average cost |
| Goods received line              | `inv.goods_receipt_line` (+ PO line)       | price paid, quantity against order, supplier    |
| Count line                       | `inv.stock_count_line`                     | counted vs system, shrinkage                    |
| Wastage line                     | `inv.wastage_line`                         | value, reason, who, expired batch link          |
| Production batch                 | `inv.production` (+ lines)                 | made, used, expiry, outcome                     |
| Transfer line                    | `inv.transfer_line`                        | requested, dispatched, received, transit loss   |
| Sales line (item × day × outlet) | `menu.sales_line`                          | quantity and price before tax                   |
| Recipe at a date                 | `inv.recipe` versions                      | theoretical usage and cost per serve            |
| Shift and assignment             | `hr.shift`, `hr.shift_assignment`          | scheduled hours, open slots                     |
| Attendance session and exception | `hr.attendance`, `hr.attendance_exception` | actual hours, late, no-show, outside location   |
| Pay rate                         | `hr.worker_sensitive` (COMPENSATION)       | labour cost                                     |
| Leave                            | `hr.leave_request`, `hr.leave_balance`     | days taken, balances, liability                 |
| Task and step                    | `ops.task`, `ops.task_step`                | due, done, on time, flagged readings            |
| Maintenance request              | `ops.maintenance_request`                  | open, time to assign, time to fix               |
| Workflow request and step        | `wf.request`, `wf.step_instance`           | approval turnaround, what is pending            |
| Event                            | `ops.event`                                | covers coming up                                |

### Gaps that limit the numbers

1. **Sales are typed in by hand**, one total per item per day. The POS / CSV import
   (SAL-1) is the biggest win for report quality.
2. **No covers or guest counts**, except on events. Decided: no typed-in covers. Average
   spend per cover waits for a POS export that includes covers.
3. **Discounts.** The POS import (decided, next) brings them. Every POS export we expect
   (IDSNEXT first) has item, description, quantity, rate, value and discount per line, so
   sales become gross, discount and net, and the reports show discount % per outlet and
   item.
4. **Labour cost** needs pay rates loaded for everyone (file 07, COMPENSATION). Salaried
   staff need a monthly basis turned into a rate per hour; we already store `pay_basis`.

### The POS export we will import (IDSNEXT sample, July)

The sample is a month's "Sale by item" from IDSNEXT, one sheet:

- **Layout.** A title rule, then the header row `Item | Description | Quantity | Rate |
Value | Discount`. Lines are grouped as **outlet** (e.g. `LE CAFE`, `LE CAFE TAKE AWAY &
DELIVERY`), then **menu type** (`Food`, `Liquor`, `Soft Drink`, `Others`).
- **Total rows.** Each group closes with `Group Total`, `Menu Type Total` and
  `Restaurant Total`, and the file ends with `Grand Total`. An `Item Total` row follows an
  item sold at more than one rate. The importer skips every total row and checks that its
  sums match `Grand Total`.
- **Line fields.**
  - **Item** is the POS item code (a number).
  - **Description** is upper case and padded with dots (`FRENCH FRIES ..........`).
  - **Quantity** has three decimals.
  - **Value** is the net amount after the discount. Rate × quantity = value + discount;
    a fully comped line has value 0.
- **Period.** The sample covers a whole month, not a day. The importer must take a date
  range and either refuse multi-day files or spread them only when the POS gives a date
  per line. To be decided with SAL-1: ask for a daily export where the POS allows it.
- **Matching to the menu.** POS codes map to menu items once per outlet (a mapping table,
  kept by the cost controller). Unmapped codes are listed, never guessed. POS outlet names
  map to our outlets the same way.

5. **Room occupancy** (hotels) isn't in the system. Housekeeping productivity per room
   needs a PMS link or a daily "rooms occupied" figure. Later.

## 3. The data model

### Dimensions

- **Date.** The business day in the outlet's time zone. A bar's day ends at its closing
  time, not at midnight. Decided: the business day starts at **06:00 local time** and is
  used
  everywhere.
- **Place.** Two trees, as now:
  - org: company → region → area → outlet or site → department;
  - supply: network → hub → supply point → store.

  Every report row carries its node, and the trees give the roll-ups.

- **Item.** Category, kind (raw, prep, batched) and food or beverage.
- **Menu item.** Category and food or beverage. Stars or Dogs is computed per period.
- **Supplier, person, job role, reason** (wastage, exceptions, count), **process type**.

### Daily summaries

There is no separate warehouse. We add a `rpt` schema of daily summary tables, one row per
place per business day, rebuilt by a nightly job.

| Table            | Grain                   | Columns (all money in ₹ at average cost)                                                                                     |
| ---------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `rpt.store_day`  | store × day             | opening value, receipts, transfers in / out, production in / out, wastage, count adjustments, sales depletion, closing value |
| `rpt.sales_day`  | outlet × day × food/bev | sales, theoretical cost, quantity, discount (from the POS import)                                                            |
| `rpt.labour_day` | department × day        | scheduled hours, worked hours, overtime hours, open slots, late, no-shows, labour cost                                       |
| `rpt.task_day`   | department × day        | due, done, done on time, flagged readings, overdue at end of day                                                             |

- **Detail stays on demand.** Item-level reports (variance by item, price variance by
  item) are read from the source tables for the chosen place and period. ADR 007 showed
  these reads are fast enough at our sizes.
- **Late edits.** The nightly job recomputes the last 35 days, so back-dated sales, counts
  and receipts are picked up.
- **Today is always live.** Today's figures are computed on the spot.
- **Who runs the job.** It runs as `wf_executor` inside `attendance-nightly`.
- **Rules.** Every `rpt` table follows rule 1: RLS from `core.apply_domain_rls()`, audit
  trigger, `tenant_id`, nodes. The tables are written only by the job.

### Access: no new security model

A report row is visible where its **source domain** is visible:

| Report family                  | Domain checked at the row's place       |
| ------------------------------ | --------------------------------------- |
| Stock value, movements, counts | STOCK_LEVELS (and DERIVED_STOCK_LEVELS) |
| Sales, cost %, variance, menu  | MENU                                    |
| Purchasing                     | PURCHASE_ORDERS                         |
| Hours, attendance, coverage    | ROSTER / ATTENDANCE                     |
| **Labour cost**                | **LABOUR_COST** (new, see below)        |
| Tasks and checklists           | TASKS                                   |
| Maintenance                    | MAINTENANCE                             |

- **The new LABOUR_COST domain.** It shows totals only, never one person's pay. Outlet
  managers today can't see pay (COMPENSATION is HR's), but a GM needs labour % to run the
  outlet. Totals per department per day reveal no one's salary, except in a department of
  one person: show labour cost only for groups of three or more, otherwise fold it into
  the outlet.
- **Grants (decided):** OUTLET_MANAGER, AREA_MANAGER, HR_ADMIN and ACCOUNT_OWNER.

Every report function checks `core.can()` at the requested place, as the screens do now
(rule 2). The RLS equivalence tests extend to the `rpt` tables.

## 4. The measures

Each measure has one definition, kept in one SQL function, so every screen agrees.

| Measure                   | Definition                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| Sales                     | Σ quantity × price before tax                                                                            |
| Actual cost of sales      | opening value + receipts + transfers in − transfers out − closing value (food / beverage stores)         |
| Food %, beverage %        | actual cost of sales ÷ sales, per food / beverage                                                        |
| Theoretical (recipe) cost | Σ sold × cost per serve at the time                                                                      |
| Variance                  | actual − theoretical, in ₹ and points of sales; per item: actual usage − recipe usage − recorded wastage |
| Wastage %                 | wastage value ÷ sales                                                                                    |
| Expired %                 | expired wastage ÷ value produced                                                                         |
| Stock value, days on hand | closing value; closing value ÷ average daily usage over 28 days                                          |
| Dead stock                | items with stock and no movement for 30 days                                                             |
| Count accuracy            | lines within tolerance ÷ lines counted; shrinkage ₹                                                      |
| Purchase price variance   | (price paid − previous price) × quantity, per item and supplier                                          |
| Supplier fill rate        | received ÷ ordered, per supplier                                                                         |
| Transfer fill rate        | dispatched ÷ requested; transit loss ₹                                                                   |
| Scheduled / worked hours  | Σ assigned shift hours; Σ attendance sessions (ADR 018 matching)                                         |
| Overtime hours            | worked beyond the weekly cap (ROS-2 setting)                                                             |
| Labour cost, labour %     | Σ worked hours × hourly rate; ÷ sales                                                                    |
| Sales per labour hour     | sales ÷ worked hours (front and back of house)                                                           |
| Prime cost %              | (actual cost of sales + labour cost) ÷ sales                                                             |
| Attendance                | on time ÷ rostered shifts; no-shows; late                                                                |
| Roster coverage           | filled ÷ required slots                                                                                  |
| Task compliance           | done on time ÷ due; flagged readings                                                                     |
| Maintenance               | open, older than 48 h, median hours to assign and to fix, repeat issues per place                        |
| Approval turnaround       | median hours from submit to decision, per process                                                        |
| Menu engineering          | contribution margin (price − cost per serve) against popularity (share of items sold) per category       |

## 5. Who sees what

Reports follow the rule in the request: **your own, your department, or the whole outlet
(or more), depending on your role.** The table lists what each person sees first; the
place switcher (ADR 016) narrows or widens it within their access.

| Who (job roles)                                                                                                                    | Level             | Reports                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontline**: commis, cook, bartender, server, steward, room attendant, technician, guard, driver                                 | me                | **My week**: hours rostered and worked, on-time record, leave balance, tasks done on time. No business numbers.                                                                                                                                                                     |
| **Supervisor**: sous chef, head bartender, captain, housekeeping supervisor                                                        | department (view) | **Department today**: tasks due / done / flagged, who is on shift and who hasn't clocked in, open slots.                                                                                                                                                                            |
| **Department head**: executive chef, bar manager (hotel), executive housekeeper, FOM, F&B manager, chief engineer, banquet manager | department        | **Department flash** (tasks, attendance, coverage, overtime risk). With a store: stock value, below par, wastage by reason and person, expired batches and prep done, count accuracy, **food or beverage %** of their store. Engineering: **maintenance** open, aging, time to fix. |
| **Store keeper / store manager**                                                                                                   | store(s)          | **Stock valuation** and trend, below par, dead stock, days on hand, **receipts vs orders** (fill rate), **price changes**, transfers in transit, count accuracy.                                                                                                                    |
| **Cost controller**                                                                                                                | outlet's stores   | **Daily flash** (sales, food %, beverage %), **actual vs theoretical by item** (top losses first), wastage %, **purchase price variance**, **menu engineering**, recipe cost changes, stock valuation.                                                                              |
| **Outlet manager**: GM, AGM, standalone bar manager                                                                                | outlet            | **Daily flash**: sales, food % and beverage % (vs recipe), labour hours and **labour %**, **prime cost**, wastage, open approvals, attendance flags, task compliance by department, open repairs, events in the next 7 days. Weekly and monthly views of the same.                  |
| **Central kitchen manager / supervisor**                                                                                           | central kitchen   | **Production** made vs planned, yield, expired %, **dispatch fill rate** per outlet, in transit, stock valuation of the hub.                                                                                                                                                        |
| **Area manager**                                                                                                                   | area              | **Outlet league table** of every flash measure, never blended; drill into any outlet. Approval turnaround.                                                                                                                                                                          |
| **HR executive / HR admin**                                                                                                        | outlet / company  | Headcount, attendance and lateness, no-shows, overtime, leave taken and **leave liability**, swap volume. Labour cost for HR admin.                                                                                                                                                 |
| **Account Owner**                                                                                                                  | company           | **Company flash** and the area league tables; prime cost by outlet; trends.                                                                                                                                                                                                         |
| **Auditor / security admin**                                                                                                       | company           | The access audit, as now.                                                                                                                                                                                                                                                           |

## 6. How the reports look

- **Home's "Today's numbers" card** shows three to four headline figures, each compared
  with the same day last week, coloured only when outside the outlet's target (targets are
  company settings: food %, beverage %, labour %, task compliance). Tapping a figure opens
  that report.
- **Reports** is a list of the reports the person can open, in the order of the table
  above. On the phone, each report is:
  1. the headline number and its trend (sparkline, 4 or 13 weeks);
  2. the top five contributors ("where the money went");
  3. a drill-down: outlet → department → store → item → the transactions.
- **Period picker:** today, yesterday, this week, last week, this month, custom. Business
  days, outlet time zone.
- **Compare:** previous period, and the same period last year once a year of data exists.
- **Export:** CSV of any table. A scheduled e-mail digest is for later; it needs SES
  outside the Free plan.
- **Navigation.** The bottom nav stays at five. Reports opens from Home for outlet and
  department profiles. For the cost controller, **Reports** replaces Menu in the nav, and
  Menu moves under it.

## 7. The plan

| Step  | What                                                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R-1   | `rpt` schema, the four daily tables and the nightly rebuild (security tests first). Home "Today's numbers" and Department today. Reports list. Daily flash for outlet and department (without labour cost). My week for staff. |
| R-2   | Cost controller suite: actual vs theoretical by item, purchase price variance, supplier fill rate, stock valuation and days on hand, dead stock, menu engineering. Replaces today's Variance screen (UX U-14).                 |
| R-3   | LABOUR_COST domain and labour %, SPLH, prime cost; HR reports; central kitchen reports.                                                                                                                                        |
| R-4   | Area and company league tables; Account Owner view; CSV export; targets in company settings.                                                                                                                                   |
| later | E-mail digest; occupancy for housekeeping; AI signals reading the same measures (ADR 020's trace is already one).                                                                                                              |

Each step gets an ADR, the PRD section 6.11 below, and its e2e tests.

## Progress

- **R-1 done** (ADR 023):
  - the `rpt` schema, with four daily tables on a 06:00 business day, rebuilt nightly over
    35 days (today and yesterday are worked out live);
  - **Outlet today** (the daily flash, without labour cost), **Department today** and **My
    week**;
  - the Reports list, and Home's "Today so far" card;
  - REPORTS lets the Account Owner read every report.

  A security test signs in as every test user: frontline staff get only My week.

- **Not yet:**
  - targets (R-4), so figures are compared only with the same day last week;
  - labour cost and labour % (R-3);
  - area and company league tables (R-4).

## 8. Decisions (2 Oct 2026)

1. **LABOUR_COST**: yes. Totals only, groups of three or more, for outlet managers, area
   managers, HR admin and the Account Owner.
2. **The Account Owner sees every report**, read-only, across the company.
3. **Only the right people see each report.** Frontline staff see only their own figures
   ("My week"): a server never sees the outlet's sales, costs or P&L. This is enforced by
   the source domains above, not by hiding menu items, and R-1 starts with a security test
   that signs in as every test user and checks which reports each one can open.
4. **No typed-in covers.** The **POS import** comes soon (SAL-1): one Excel export per
   outlet per day (IDSNEXT first, others alike), with item, description, quantity, rate,
   value and discount per line.
5. **Business day: 06:00 local time**, for every outlet.
6. **Targets** (food %, beverage %, labour %, task compliance): still open; proposed as
   company settings with an outlet override, in R-4.
7. **Order:** R-2 comes after UX-3, UX-3b and AC-1 (customer-specific access groups,
   `docs/ux-review.md`), so the cost controller suite can be granted per customer.

## Sources

- [Restaurant365: 5 must-have restaurant reports](https://www.restaurant365.com/blog/5-must-have-restaurant-reports-to-keep-you-on-track/) and [daily flash reports](https://www.restaurant365.com/blog/control-restaurant-labor-costs-with-daily-flash-reports/)
- [Restaurant365 food variance report](https://docs.restaurant365.com/docs/food-variance-report)
- [MarketMan actual vs theoretical cost report](https://marketman.com/actual-vs-theoretical-food-cost-report)
- [Apicbase (FitGap profile)](https://us.fitgap.com/products/023640/apicbase)
- [Supy reports](https://supy.io/product-features/reports) and [theoretical vs actual variance](https://supy.io/blog/learn-theoretical-vs-actual-food-cost-variance)
- [7shifts: controlling labour costs](https://kb.7shifts.com/hc/en-us/articles/50012716541075-Controlling-Labor-Costs-Your-Guide-to-Smart-Staffing) and [labour cost %](https://www.7shifts.com/blog/how-to-manage-your-restaurant-labor-cost-percentage/)
- [Petpooja reports and analytics](https://www.petpooja.com/reports-and-analytics) and [material consumption](https://blog.petpooja.com/glossary/material-consumption/)
- [Restroworks inventory management (GetApp)](https://www.getapp.ca/software/2052670/restroworks-inventory-management)
- [BinWise liquor cost percentage](https://home.binwise.com/blog/liquor-cost-percentage)
- [Jolt, Culver's case study](https://www.jolt.com/customer-success-stories/culvers/) and [Zenput vs Jolt](https://xenia.team/articles/zenput-vs-jolt)
- [Menu engineering matrix (Loaded)](https://www.loadedhub.com/resources/menu-engineering-matrix-restaurant) and [Toast](https://pos.toasttab.com/es-us/blog/on-the-line/menu-engineering-matrix)
