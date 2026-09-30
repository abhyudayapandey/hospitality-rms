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

| File                                               | What it defines                                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00_customer.csv`                                  | Company name, country, currency, time zone                                                                                                          |
| `01_org_nodes.csv`                                 | People structure. `outlet_format` on outlet rows: full_hotel, small_hotel, standalone_bar                                                           |
| `02_delivery_nodes.csv`                            | Stock structure. `holds_stock` = yes where stock is counted (a store, or a supply point with no stores)                                             |
| `03_node_links.csv`                                | Which department uses which store; which outlet is which supply point                                                                               |
| `04_location_settings.csv`                         | GPS location and clock-in radius per site                                                                                                           |
| `06_job_roles.csv`                                 | This customer's job titles and default access. `outlet_format` = any, or a format whose default overrides it (e.g. Bar Manager in a standalone bar) |
| `07_users.csv`                                     | One row per person, with home place (department, or the outlet itself if there are no departments)                                                  |
| `08_role_assignments_extra.csv`                    | Exceptions: admins, cover arrangements                                                                                                              |
| `09_suppliers.csv` – `12_opening_stock.csv`        | Suppliers, items, which store holds which item, opening stock                                                                                       |
| `13_leave_types.csv`, `14_leave_balances.csv`      | Leave types and balances                                                                                                                            |
| `15_roster_settings.csv`, `16_shift_templates.csv` | Rest/cap/late rules; standard shifts per department (or per outlet)                                                                                 |
| `17_events_TEST_DATA_ONLY.csv`                     | Sample events — test only                                                                                                                           |
| `99_access_preview_GENERATED.csv`                  | Every resulting access grant, with place name, what it covers, and where it came from                                                               |

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
