# 017 — Test activity data: shifts, batches, sales and a closing count (Prompt 10b)

Status: accepted · 2026-10-01

The two test customers had people, places, stock and menus, but no activity. Every
Roster, Production, Sales and Variance screen started empty, so a demo or a UAT run began
with ten minutes of data entry.

- **Migration** (forward-only): `20261012100000_test_activity`.
- **Deploy:** no stack change. Run the Deploy workflow, then re-import both test customers
  (`docs/deploy.md`).

## Four test-only files

Test Company gains four files, each named `…_TEST_DATA_ONLY.csv`, like the events in file 17:

| File            | What it loads                                                                    |
| --------------- | -------------------------------------------------------------------------------- |
| `25_shifts`     | Hotel 1.0 Kitchen and Bar, and Bar 3.0: two weeks of shifts, assigned, published |
| `26_production` | six batches over the past week, made by the production team                      |
| `27_sales`      | the past six days' sales at Hotel 1.0 and Bar 3.0                                |
| `28_counts`     | a closing count of the Hotel 1.0 Bar Store on the load day                       |

- **Test customers only.** The loader refuses each file for a customer that isn't a test
  customer (`is_test`, fixed when the customer is created; ADR 012), before anything is
  written.
- **Dates are offsets from the load date.** Days are `0` (the load day) or `-1` to `-30`,
  and shifts are week `1` (from next Monday) or `2`. So the data is recent whenever it is
  loaded.
- **Through the app's own rules, as the person named.** Every row names who does it. The
  loader runs each row as that person (`app.user_id`) through the same database functions
  the app uses:

  | File | Calls                                              | So these rules hold                                |
  | ---- | -------------------------------------------------- | -------------------------------------------------- |
  | 25   | `hr.generate_week`, `hr.assign`, `hr.publish_week` | rest hours, the weekly cap, role and home place    |
  | 26   | `inv.record_test_production`                       | production rights, made-here, enough stock         |
  | 27   | `menu.post_sales`                                  | sales rights, sold there on that day               |
  | 28   | `inv.start_count`, `inv.submit_count`, `wf.act`    | count rights, approval chain, initiator ≠ approver |

  A row that breaks a rule fails the load with the rule's code (`REST_RULE`,
  `NOT_AUTHORISED`, …) at its file and row.

## The closing count goes through the real workflow

The gin is counted one bottle short, beyond its 2 % tolerance. So the count raises a
STOCK_ADJUSTMENT:

1. the Bar Manager 1.0, the Bar Store's store keeper, submits the count;
2. the General Manager 1.0 approves it in the loader;
3. the executor posts it after the load commits (the `wf-execute` timer in production;
   `pnpm db:seed` runs it once).

Until the executor runs, Variance shows the gin as "awaiting approval". Nothing posts the
loss directly.

## Batches at a past time: `inv.record_test_production`

`inv.record_production` stamps a batch with `now()`. The batch number, the expiry, the
ledger times and the recipe in force all follow from that time.

- **`inv.record_production_at`** is the same body with the time as a parameter.
  `inv.record_production` now calls it with `now()`, so the app's behaviour is unchanged.
- **`inv.record_test_production`** is the loader's entry point. It refuses:
  - a customer that isn't a test customer (`TEST_CUSTOMER_ONLY`);
  - a time in the future (`INVALID_DATE`).

  It then runs the same production checks as the app.

- **Who can run them.** The app can't run either function: app_rw has no execute on them.
  Only their owner and platform_loader can. A security test holds all of this.

## Prices and recipes from the start of the week

Prices and recipes take effect on the day they are loaded, so last week's sales would find
no price in force. For a test customer, the loader moves the start of each item's first
price and first recipe version back to the earliest day in files 26 and 27. Later
versions keep their dates. Real customers are untouched.

## The past week loads once; shifts follow the load date

- **Shifts (file 25)** are always the two weeks from the next Monday. A later re-import
  adds the weeks that are new by then and changes nothing else.
- **Batches, sales and the count (files 26 to 28)** load once per customer. A second week
  would need its own batches, and batches are made from the opening stock, which never
  goes below zero. The first re-import a week later would fail with
  `INSUFFICIENT_STOCK`. Later re-imports report them unchanged.

  After a week, open Variance with the dates of the first load to see them. A fresh
  database (`pnpm db:seed`, CI) always has them in the current week.

## The figures

`docs/onboarding/test-data/README.md` lists what the files give: the variance mix, the
cost %, the batches and the shifts. `packages/db/src/test-data-activity.db.test.ts`
reads them through the app's functions and fails if any figure differs.

## Second people

Eight people end in `-b`, a second person in the same job at the same place:

- Hotel 1.0: Commis, Bartender, Steward and Room Attendant;
- Bar 3.0: Server and Bartender;
- Test Solo Bar: Server and Bartender.

They follow the same password rule, and file 99 lists their access. They make the
rostering realistic, and they give the swap and approval flows a colleague to work with.
