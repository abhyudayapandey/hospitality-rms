# [TEST] Restaurant: a restaurant with a bar

A test customer for trying the product on a restaurant with a bar: Restaurant & Bar, Panjim.
It is the set-up wizard's "Restaurant + Bar" outlet (the restaurant template with the bar
ticked), written by `filesFromDraft`, with a menu, recipes and a week of work added. The
people, menu, prices, suppliers and licences are all invented.

`packages/onboarding/scripts/restaurant-demo.ts` writes these files;
`packages/onboarding/src/restaurant-demo.db.test.ts` loads them the way the console does and
checks them.

## What is in it

- **The outlet and its departments**, from the wizard: Kitchen, Restaurant (the floor), Bar,
  the Stores team, Engineering (one technician, run by the GM) and Admin & Finance (the cost
  controller and the accountant; ADR 140).
- **Stores**: a Main Store run by the store keeper, the Kitchen Store and the Bar Store
  (the stock check goes shelf by shelf: the Bar Store's back bar, fridges, wine rack and ice
  machine; the Main Store's dry store, spice rack, oils and tins, liquor cage, beer and soft
  drinks, and packaging). The kitchen and the bar ask the
  Main Store; the store keeper buys.
- **One person per job role**: 19 people, an owner (Leena Sequeira, `test.leena-sequeira`)
  and **Demo Presenter**, who may show the app as anyone (`demo_presenter` in file 07,
  ADR 071). Usernames are `restaurant.<role>`, for example `restaurant.manager`,
  `restaurant.bartender`.
- **Menus**: 14 Goan dishes (Food) and 14 drinks (Bar), each with its recipe, cost and POS
  code (7001 to 7028), and 6 house preps (recheado masala, cafreal marinade, xacuti masala,
  lime cordial, sugar syrup, a batched negroni). Items carry their allergens; spirits, wine
  and beer are in the excise register.
- **The last week** (counted from the day it is imported): sales, prep batches, three
  purchase orders (one arriving today), the bar's closing count, rosters (last week, this
  week and next), clock-ins (a few late, one no-show), a prep task, a repair, seven licences
  (the excise bar licence expires in 20 days) and the compliance calendar.
- **Daily checklists** from the template for everyone who works shifts (the sous chef's line
  check, the assistant manager's mid-shift reset and lock-up, the technician's maintenance
  round), **14 starter SOPs** in Me → SOPs (handwashing, allergies, labelling, receiving,
  taking an order, the bill, complaints, serving alcohol, pouring with a measure and more), and
  **floor sections**: Section 1 to 3 in the restaurant, the Bar counter and the Terrace.
- **Meters** for the technician's Utilities: the electricity main, the kitchen gas and the water
  inlet at Engineering, read at the end of the shift (file 43).
- **Push today** lists food and drinks: yesterday's lime cordial is used up in today's
  cocktails, and the cafreal marinade in the kitchen's dishes.

## Before importing: refresh the dates

Licences, the compliance calendar and opening stock carry dates. Write them from the day you
import, from the repository root:

```sh
pnpm --filter @outlet-ops/onboarding restaurant-demo --today 2026-10-20
```

(Without `--today` it uses today.) The past week needs no refresh: it counts from the import.

## Importing it on production

**1. Build the zip**, from the repository root (only the numbered files):

```sh
(cd docs/onboarding/demo/test-restaurant && zip -q -FS ~/test-restaurant.zip [0-9][0-9]_*.csv)
```

It holds 39 files.

**2. Create the customer**: on `/platform`, the link **New customer: the company and its owner
only** (`/platform/customers/new`), not **Set up a new customer** (the wizard always makes an
email owner). Enter:

| Field               | Value                                    |
| ------------------- | ---------------------------------------- |
| Company name        | `[TEST] Restaurant`                      |
| Customer code       | `RESTAURANT-TEST`                        |
| Country / Currency  | `India` / `INR`                          |
| Time zone           | `Asia/Kolkata`                           |
| Test customer       | ticked                                   |
| Owner name          | `Leena Sequeira`                         |
| Owner signs in with | Username and password (no email)         |
| Owner username      | `test.leena-sequeira` (type it yourself) |

**Create customer**, check the owner reads `test.leena-sequeira` and "no email is sent", then
**Confirm and create**.

**3. The plan**: the customer's page → **What they buy** → turn on **Stock & buying**,
**Kitchen & bar**, **People**, **Daily work** and **Events & compliance** (what the wizard
ticks for a restaurant with a bar), then **Events & compliance** → **Compliance** → **On**.

**4. Import**: **Import setup files** → `test-restaurant.zip` → **Upload and dry run**. It
should report no problems and no warnings, with (new): org places 7, delivery places 5,
links 4, job roles 19, users 20, workers 20 / 1 changed (the owner's), licences 7, compliance
jobs 8, suppliers 8, items 57, item locations 90, prep items 6, menu items 28, recipes 34,
checklists 21, SOPs 14, sections 5, shift templates 15, shifts 315, shift assignments 255,
production batches 42, sales days 7, stock counts 1, purchase orders 3, attendance
sessions 89. **Apply**, then a second dry run shows no changes.

**5. Logins (the printed sheet)**: the customer's page → **Logins** → **Create 21 sign-ins**
→ **Print the login sheet**. Each person gets a random one-time password and sets their own at
first sign-in (ADR 166); passwords are never written in this repository, which is public. To
replace passwords that were shared: **Logins** → **New passwords for all**.

| Who                                | Username                     |
| ---------------------------------- | ---------------------------- |
| Demo Presenter                     | `restaurant.presenter`       |
| Leena Sequeira, owner              | `test.leena-sequeira`        |
| Rhea Fernandes, Restaurant Manager | `restaurant.manager`         |
| Calvin Rodrigues, Bar Manager      | `restaurant.bar-manager`     |
| Sana Shaikh, Bartender             | `restaurant.bartender`       |
| Dinesh Shetye, Store Keeper        | `restaurant.store-keeper`    |
| Santosh Naik, Technician           | `restaurant.technician`      |
| Priya Kamat, Cost Controller       | `restaurant.cost-controller` |

**6. Check**: sign in as `restaurant.presenter`. Me shows **Show the app as someone**; pick
Rhea Fernandes: Home shows Compliance (the bar licence expiring), the sections card, Push
today and the departments.

## Starting again

On the customer's page, **Start again** empties it (ADR 130); import the same zip and make the
logins again. **Remove this test customer** takes it off the console for good (ADR 139).
