# 023 — Reports (R-1) and the "Today" home (UX-2)

Status: accepted · 2026-10-02

`docs/reporting.md` set out the plan, and the decisions of 2 October settled the open
points. This ADR records how step R-1 and UX-2 were built.

- **Migration** (forward-only): `20261018110000_reports`.
- **Product access:** the new REPORTS domain is added by the product sync during Deploy.
  No re-import is needed, and no stack change.

## The business day

A day runs from **06:00 to 06:00 local time**, at every place. Late-night bar sales and
stock movements count towards the day that started the evening before.

- `rpt.business_date(at, tz)` and `rpt.day_start(day, tz)` define it.
- Sales use the date they were entered for (`menu.sales_day.business_date`).

## Tables: daily summaries in schema `rpt`

There are four tables, each with one row per place per business day:

| Table        | One row per                   | Holds                                                                                                | Access checked against |
| ------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------- |
| `store_day`  | stock-holding store           | opening and closing value; receipts, transfers, production, wastage, counts, sales use and other use | STOCK_LEVELS           |
| `sales_day`  | outlet and menu (Food or Bar) | sales, quantity, recipe cost, discount                                                               | SALES                  |
| `labour_day` | team place                    | shifts, slots, filled slots, rostered hours, worked hours, late, no-shows                            | ATTENDANCE             |
| `task_day`   | team place                    | due, done, done on time, flagged readings, overdue                                                   | TASKS                  |

- **Table rules.** Each follows rule 1: `core.apply_domain_rls` from the domain in the last
  column, the audit trigger, `tenant_id` and nodes. The tables are `rpc_only`, so the app
  can only read them.
- **Why ATTENDANCE for labour.** `labour_day` uses ATTENDANCE, not ROSTER, because every
  staff member holds ROSTER view at their place to read the roster. Totals of hours,
  late and no-shows are not for them.
- **Recipe cost** is shared between Food and Bar by their revenue from each store, as in
  `menu.cost_report`. A test checks that both give the same figures for the test week.
- **No labour cost yet.** Pay needs the LABOUR_COST domain, which comes in R-3.

## One definition per figure; stored days and live days

- **Calculations.** `rpt.calc_store_day`, `calc_sales_day`, `calc_labour_day` and
  `calc_task_day` work out every figure. Nothing else does.
- **Rebuild.** `rpt.rebuild(from, to)` stores their results. It writes only rows whose
  figures changed, so a rebuild with no changes writes nothing, including to the audit
  log.
- **Nightly.** `rpt.nightly()` rebuilds the last 35 days, so late edits (back-dated
  sales, counts or receipts) are picked up. It runs in the existing 02:15 attendance
  timer, as `wf_executor`, after the attendance exceptions. `pnpm db:seed` runs it once
  (`reports-rebuild`).
- **Stored versus live.** Reports read stored rows for days before yesterday. They work
  out **today and yesterday live**: at 02:15 the business day is still open until 06:00,
  so a stored "yesterday" could be stale.

## Who opens which report (rule 2)

| Report                                 | Opens at                       | Rule (`core.can`)                                        |
| -------------------------------------- | ------------------------------ | -------------------------------------------------------- |
| **Outlet today** (the daily flash)     | an outlet                      | SALES view at the outlet's supply point, or REPORTS      |
| **Department today**                   | a team place                   | ATTENDANCE view there, or REPORTS                        |
| Its store block (wastage, stock value) | the department's linked stores | STOCK_LEVELS view at the store, or REPORTS               |
| **My week**                            | the person themselves          | an active worker record; only their own shifts and tasks |

- **Where the rules live.** `rpt.can_open` holds them, and `rpt.report_places` lists the
  places (worked out once per domain with `core.visible_nodes`). `rpt.my_reports` lists
  the reports.
- **Refusals.** Every report function refuses any other place with `NOT_AUTHORISED`.

**REPORTS** is a new org-tree domain: every report in the company, read-only.

- **Who holds it.** Only the Account Owner (view), at the company root. It is marked as an
  admin domain because admin groups may hold only admin domains (ADR 009).
- **What it shows.** Totals, never a row of business data. The owner still cannot open
  stock, sales or people screens.

**Frontline staff see only My week.** Server, commis, bartender and the rest never see an
outlet's sales, costs or totals.

- `reports-access.db.test.ts` signs in as **every user of both test customers** and
  checks four things:
  1. each report's places match the rule;
  2. frontline people (groups SELF, STAFF, STOCK_USER, PRODUCTION_TEAM only) are offered
     only My week;
  3. every report refuses every place it does not list;
  4. frontline people read no rows from `sales_day`, `labour_day` or `task_day`.
- Stock users read their own store's `store_day`, as they already read its stock levels.

## The "Today" home (UX-2)

Home is a short list of cards, shown by what the person has:

- **Your shift.** The shift on now, or the next within 24 hours, with Clock in or Clock out.
- **Your tasks.** Overdue first, then due today; the first three.
- **Waiting for you.** As before.
- **Needs attention** (people who are not frontline). Items below par, open attendance
  flags, and open repairs, each counted under RLS at the places the person sees.
- **Today so far** (anyone with a business report).
  - With an outlet: sales, food cost %, drinks cost % and wastage.
  - Otherwise, for their department: shifts, people not in yet, open slots and tasks on
    time.
  - Each figure is shown against the same day last week, with a link to the report.
- **Shortcuts.** At most four. Every other screen is under **All screens**, so nothing
  that was on Home is lost.

Figures are coloured only by whether they went up or down from last week. Colouring
against targets waits for targets in company settings (R-4).

**Navigation.**

- **Cost controller.** Reports takes Menu's place in the bottom nav. Menu opens from
  Reports and from Home.
- **Office profile** (owner, HR, auditor). Gets Reports when they have a business report.
- **Everyone else.** Opens Reports from Home: "My week" for frontline staff, the Today card
  for leads. The bottom nav stays at five items or fewer.

## Consequences

- Each new report adds a `calc_*` measure or a report function, plus its rule in
  `rpt.can_open`, and widens the every-user test.
- `menu.cost_report` and the variance screen keep their own reads until R-2 replaces the
  variance screen. A test pins `rpt` and `menu.cost_report` to the same figures until then.
- Deploy: the report tables fill at the first 02:15 run after the release. Until then,
  today and yesterday still show, because they are worked out live, but last week's
  comparison is empty.
