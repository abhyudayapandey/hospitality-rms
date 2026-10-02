# Test onboarding data

Two test customers, each in its own folder, plus two product-level files.
For a real customer, a Platform Admin uploads the same set of files (with real names, no "Test") in the Platform Admin console.

```
test-onboarding/
├── PRODUCT_access_groups_REFERENCE.csv   what each access group allows (same for every customer)
├── TEST_LOGINS_do_not_commit.csv          test usernames + passwords — never commit
├── test-company/                          customer 1: four outlet shapes + central kitchen
└── test-solo-bar-co/                      customer 2: one standalone bar, no area/region/central kitchen
```

## Customer 1 — Test Company

| Outlet                       | Format           | Shape                                                                                                                     |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Test Hotel & Bar 1.0 and 1.1 | `full_hotel`     | 10 departments, 4 stores (Main, Kitchen, Bar, Housekeeping)                                                               |
| Test Guest House 2.0         | `small_hotel`    | No departments; everyone reports to the GM; stock held at the supply point itself; the GM handles stock (no Store Keeper) |
| Test Bar 3.0                 | `standalone_bar` | Bar, Floor Service and Kitchen teams; Bar Store and Kitchen Store; the Bar Manager is the outlet head                     |
| Test Central Kitchen         | site             | Supplies all four outlets                                                                                                 |

Admins: `test.account-owner` (Account Owner, whole company); the GM of Hotel 1.0 is also User Admin for Hotel 1.0 only; the Front Desk Executive of the Guest House is User Admin for the Guest House.

## Customer 2 — Test Solo Bar Co.

Company → Test Solo Bar → Bar, Floor Service, Kitchen. No region, area or central kitchen.
The owner `test.solo.bar-manager` is both Bar Manager (outlet head) and Account Owner.
Policy difference from Test Company: here the Head Bartender is a STORE_KEEPER (can order stock), not a STOCK_USER — job-role access is set per customer.

## How codes work

Readable and built from the place above: `TEST-HOTEL-1.0` (hotel) → `TEST-HOTEL-1.0-BAR` (Bar department, people) ; `TEST-HOTEL-1.0-SUPPLY` (supply point, stock) → `TEST-HOTEL-1.0-BAR-STORE`.

## The access rule

Each access row means: this person has this access group at this place. It covers that place and everything below it, unless it says "this place only".

## Files in each customer folder

| File                                               | What it defines                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00_customer.csv`                                  | Company name, country, currency, time zone; optional `leave_hr_approval` (yes/no, default yes), `is_test` (yes/no, only at creation) and one column per module (`events`, `swaps`, `leave`, `production`, `prep_lists`, `checklists`, `maintenance`, `menu_sales`: yes/no; blank keeps it as it is, ADR 026). Test Solo Bar Co. has Events and Swaps off |
| `01_org_nodes.csv`                                 | People structure. `outlet_format` on outlet rows: full_hotel, small_hotel, standalone_bar                                                                                                                                                                                                                                                                |
| `02_delivery_nodes.csv`                            | Stock structure. `holds_stock` = yes where stock is counted (a store, or a supply point with no stores); `is_main_store` = yes on the outlet's Main Store                                                                                                                                                                                                |
| `03_node_links.csv`                                | Which department uses which store; which outlet is which supply point                                                                                                                                                                                                                                                                                    |
| `04_location_settings.csv`                         | GPS location and clock-in radius per site                                                                                                                                                                                                                                                                                                                |
| `05_access_groups.csv`                             | Optional. The customer's own access groups (ADR 027): `group_code`, `name`, `rights` (`DOMAIN:view; DOMAIN:modify`, business rights only) and `acts_as` (product roles whose requests and approvals it carries, `;`-separated). Files 06 and 08 may use them. Test Company has KITCHEN_LEAD (held by Sous Chef 1.1, file 08)                             |
| `06_job_roles.csv`                                 | This customer's job titles and default access. `outlet_format` = any, or a format whose default overrides it (e.g. Bar Manager in a standalone bar)                                                                                                                                                                                                      |
| `07_users.csv`                                     | One row per person, with home place (department, or the outlet itself if there are no departments)                                                                                                                                                                                                                                                       |
| `08_role_assignments_extra.csv`                    | Exceptions: admins, cover arrangements                                                                                                                                                                                                                                                                                                                   |
| `09_suppliers.csv` – `12_opening_stock.csv`        | Suppliers, items, which store holds which item, opening stock                                                                                                                                                                                                                                                                                            |
| `13_leave_types.csv`, `14_leave_balances.csv`      | Leave types and balances                                                                                                                                                                                                                                                                                                                                 |
| `15_roster_settings.csv`, `16_shift_templates.csv` | Rest/cap/late rules; standard shifts per department (or per outlet)                                                                                                                                                                                                                                                                                      |
| `17_events_TEST_DATA_ONLY.csv`                     | Sample events — test only                                                                                                                                                                                                                                                                                                                                |
| `18_…` – `24_…`                                    | Menus, prep items and recipes (`MENU_README.md`)                                                                                                                                                                                                                                                                                                         |
| `25_shifts_TEST_DATA_ONLY.csv` – `28_counts_…`     | Test Company only: shifts, batches, sales and a closing count (below) — test only                                                                                                                                                                                                                                                                        |
| `29_checklist_templates.csv`                       | Recurring checklists per department: schedule, who does them, and their steps (below)                                                                                                                                                                                                                                                                    |
| `30_tasks_…` – `32_prep_tasks_…`                   | Test Company only: one-off tasks, a maintenance request and a prep list (below) — test only                                                                                                                                                                                                                                                              |
| `99_access_preview_GENERATED.csv`                  | Every resulting access grant, with place name, what it covers, and where it came from                                                                                                                                                                                                                                                                    |

## Default access words (file 06)

| Word                                        | Means                                          | If it doesn't exist                       |
| ------------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| `home_department`                           | The person's home place                        | —                                         |
| `whole_outlet`                              | Their outlet and everything in it              | —                                         |
| `outlet_stores`                             | Their outlet's supply point and all its stores | —                                         |
| `department_store`                          | The store linked to their department           | Falls back to the outlet's stock location |
| `main_store`                                | Their outlet's Main Store                      | Falls back to the outlet's stock location |
| `department:BAR`                            | A named department of their outlet             | —                                         |
| `central_kitchen` / `central_kitchen_store` | The central kitchen site / its store           | —                                         |
| `whole_area` / `whole_company`              | Everything in the area / company               | —                                         |
| `(this store only)`                         | Does not reach places below                    | —                                         |

Fallbacks are shown in the `source` column of file 99 (see the Guest House Cook).

## Test passwords

`Test` + job title without spaces + `!12`, e.g. Bar Manager → `TestBarManager!12`. Usernames tell outlets apart: `test.bar-manager.1.0`, `test.bar-manager.3.0`, `test.solo.bar-manager`.
Platform Admin accounts are not in these files: they are created separately, with a strong password and authenticator-app MFA.

## Second people

A second person in the same job at the same place, ending in `-b`. Same password rule.

- Hotel 1.0: `test.commis-b.1.0`, `test.bartender-b.1.0`, `test.steward-b.1.0`,
  `test.room-attendant-b.1.0`.
- Bar 3.0: `test.server-b.3.0`, `test.bartender-b.3.0`.
- Test Solo Bar: `test.solo.server-b`, `test.solo.bartender-b`.

## Activity: files 25 to 28 (test only, ADR 017)

The loader refuses these files for a customer that isn't a test customer. Days count from
the load date: `0` is the load day and `-1` the day before. Every row names who does it,
and the loader does it as that person through the app's own rules.

| File                               | What it loads                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `25_shifts_TEST_DATA_ONLY.csv`     | Weeks 1 and 2 from next Monday at Hotel 1.0 Kitchen and Bar and at Bar 3.0: 19 people, 88 shifts a week, published |
| `26_production_TEST_DATA_ONLY.csv` | Six batches on days -6 to -1, made by commis and bartenders (PRODUCTION_TEAM)                                      |
| `27_sales_TEST_DATA_ONLY.csv`      | Days -6 to -1: the same sales each day, at Hotel 1.0 (GM) and Bar 3.0 (Bar Manager)                                |
| `28_counts_TEST_DATA_ONLY.csv`     | A closing count of the Hotel 1.0 Bar Store on the load day: `difference` is counted minus expected                 |

- **Re-imports.** Shifts follow the load date: a later re-import adds the weeks that are new
  by then. Batches, sales and the count load once per customer. A second week would use up
  the stock its batches are made from.
- **The count.** The Bar Manager 1.0 (the Bar Store's store keeper) counts. The gin is
  beyond tolerance, so it goes to approval: the GM 1.0 approves, and the executor posts it
  (`pnpm db:seed` runs it; in production the `wf-execute` timer does, within a minute).

### Expected figures

For the 7 days ending on the load day. `packages/db/src/test-data-activity.db.test.ts`
pins them.

**Hotel 1.0 Bar Store** (Variance, as the GM):

| Item                                      | Used by sales | Count          | Variance     | Shown as                    |
| ----------------------------------------- | ------------- | -------------- | ------------ | --------------------------- |
| Gin 750 ml                                | 4.8 bottles   | 1 bottle short | −1 · −₹1,800 | **unexplained loss**        |
| Vodka 750 ml                              | 2.88 bottles  | 0.1 short      | −0.1 · −₹140 | within its 2 % tolerance    |
| Whisky, white rum, red wine, lager, tonic | as sold       | on target      | 0            | no variance                 |
| Sugar Syrup                               | 360 ml        | not counted    | —            | made 800, 400 into Sour Mix |
| Sour Mix                                  | 810 ml        | not counted    | —            | made 900                    |

**Bar 3.0 Bar Store** (Variance, as the Bar Manager 3.0):

- **Tonic Water** is sold below zero: 34 cans on hand, 42 used (Gin & Tonic and tonic),
  so −8 expected. It is not counted. The store keepers get a "Stock below zero after
  sales" notification.
- **Negroni batch:** made 2,000 ml, 1,620 ml sold.
- Nothing is unexplained.

**Cost %** (recipe cost of what sold over revenue before tax; actual adds the count
variance):

| Outlet    | Menu | Revenue   | Recipe % | Actual % |
| --------- | ---- | --------- | -------- | -------- |
| Hotel 1.0 | Bar  | ₹1,07,550 | 34.4     | 36.2     |
| Hotel 1.0 | Food | ₹37,620   | 21.5     | 21.5     |
| Bar 3.0   | Bar  | ₹58,860   | 38.1     | 38.1     |
| Bar 3.0   | Food | ₹12,000   | 10.1     | 10.1     |

**Batches:**

- **Hotel 1.0 Kitchen Store.** Mint Chutney (day -5, shelf life 48 h) is **expired**, with
  140 g left. Its Production screen shows the expired banner. Ginger Garlic Paste (day -4)
  is still in date.
- **Hotel 1.0 Bar Store.** Sugar Syrup (day -6) and Sour Mix (day -1).
- **Bar 3.0.** Negroni (day -4, Bar Store) and Ginger Garlic Paste (day -2, Kitchen Store).

Each batch's expiry runs from its batch time, so the other batches expire over the
following days.

**Shifts:** `test.commis-b.1.0` has 10 dinner shifts (Wed to Sun, both weeks) on My shifts.
Open slots in those weeks stay open and published.

## Checklists: file 29 (ADR 020)

A normal onboarding file: a real customer loads its own. One row per step; `template_code`,
`place_code`, `name`, `schedule` and `assign_to` repeat on each step row of a template.

- **`schedule`**, local to the place: `daily 07:00 15:00`, `weekly Mon,Thu 09:00`, or
  `every 2h 08:00-22:00` (1, 2, 3, 4, 6, 8 or 12 hours; a window like `22:00-02:00` runs past
  midnight).
- **`assign_to`**: `role:COMMIS` (everyone in that job role at the place; the first to start
  takes it), `on_shift` (whoever is rostered there at the due time) or `person:username`.
- **`step_kind`**: `tick`, `number` (with an optional `min`/`max`: outside it is flagged and
  the place's lead is told), `text` or `photo`. `photo_required` = yes needs a photo with the
  step.

The tasks job (`pnpm --filter @outlet-ops/workflow tasks-tick`, every 5 minutes on the
instance) makes each checklist's tasks for the next 24 hours.

| Customer      | Place                  | Checklists                                                           |
| ------------- | ---------------------- | -------------------------------------------------------------------- |
| Test Company  | Hotel 1.0 Kitchen      | Kitchen opening, Kitchen closing, Fridge temperature log (every 4 h) |
| Test Company  | Hotel 1.0 Bar          | Bar setup, Bar closing                                               |
| Test Company  | Hotel 1.0 Front Office | Front desk shift handover (07:00, 15:00, 23:00)                      |
| Test Company  | Hotel 1.0 Housekeeping | Lobby washroom check (every 2 h), Linen room count (Mondays)         |
| Test Company  | Bar 3.0 Kitchen, Bar   | Kitchen opening and closing; Bar setup                               |
| Test Solo Bar | Kitchen, Bar           | Kitchen opening and closing; Bar setup and closing                   |

## Tasks: files 30 to 32 (test only, ADR 020)

Refused for a customer that isn't a test customer. Days count from the load date, as in
files 25 to 28; file 30 also takes days after it (up to 14).

| File                                | What it loads                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `30_tasks_TEST_DATA_ONLY.csv`       | Five one-off tasks, created by the person in `created_by`, finished by `done_by` when filled in   |
| `31_maintenance_TEST_DATA_ONLY.csv` | One open request: the Hotel 1.0 kitchen dishwasher, raised by the commis, waiting for Engineering |
| `32_prep_tasks_TEST_DATA_ONLY.csv`  | A prep list matching the batches of file 26, and one for the load day                             |

**Expected figures** (`packages/db/src/test-data-activity.db.test.ts` pins them):

- **Tasks.** `test.commis.1.0` has **Deep clean the walk-in chiller** due yesterday, still
  open: **overdue**. `test.commis-b.1.0` finished **Descale the combi oven** (day -2). Label
  the dry store shelves (Hotel 1.0 commis), Polish the back-bar glassware (Hotel 1.0
  bartenders) and Wipe down the menu cards (Bar 3.0 servers) are upcoming, for everyone in
  that role.
- **Maintenance.** One open request, handled by Hotel 1.0 Engineering: the Chief Engineer
  sees it in their Inbox to assign to the technician.
- **Prep.** Mint Chutney (day -5, 500 g), Ginger Garlic Paste (day -4, 1 kg) and the Negroni
  (Bar 3.0, day -4, 2 l) are done, each linked to its batch from file 26. Mint Chutney
  1 kg for the load day is open for the Hotel 1.0 commis (the last batch has expired).
- **Checklists.** After `pnpm db:seed` (it runs the tasks job once) each checklist has its
  tasks for the next 24 hours.
