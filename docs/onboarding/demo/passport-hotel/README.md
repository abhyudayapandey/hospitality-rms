# [TEST] Passport Hotel: the pilot demo

A test customer for the Passport Hotel pitch: Passport Hotel, Assagao, Goa (27 keys). The
pitch, screen by screen, is `PITCH.md`.

**What is real and what is invented.** The hotel, its departments and its five Mini Bar
signatures (Passport De Picante, Madame Rosita, Hot Girl Club with the hotel's own spec,
Café Noir, Meloni) are theirs. Everything else is invented for the demo and named so: the
people, the rest of the menu and every recipe, prices and costs, suppliers ("(demo)"), the
past week, the licences and their numbers.

## What is in it

- **The hotel and its departments**, as the hotel runs them: Front Office; Housekeeping
  (with the in-room minibars and the pool); Kitchen (one kitchen for everything); Restaurant;
  Bar (Layover on the roof and the Mini Bar in the lobby); In-Room Dining; Sales, Events &
  Banquets (with Jet Lag); Cashier; Engineering & Maintenance; Admin & Finance.
- **Stores**: the Kitchen Store, the **Bar** and the Housekeeping Store, which also refills the
  in-room minibars. There is **no Main Store and no store keeper** (ADR 115): a department asks
  the department that keeps it (housekeeping asks the Bar for beer), the GM approving every
  request, and buys what no other store keeps itself, the GM approving every purchase. These
  are the hotel's rules on its supply point's row in file 02. The bar is one department with
  one store for Layover on the roof and the Mini Bar in the lobby, so everyone asks "Bar"
  (ADR 083).
- **One person per job role**: 34 people, plus **Demo Presenter**, who may show the app as
  anyone (`demo_presenter` in file 07, ADR 071). The owner is Ashesh Sajnani (`test.ashesh-sajnani`), the GM Sainath. Usernames are `passport.<role>`, e.g. `passport.gm`, `passport.bar-manager`.
- **Menus**: Mini Bar signatures and classics, Layover cocktails, beer and wine, breakfast
  (Ros omelette with poi), Layover's kitchen, in-room dining, pool snacks: 34 dishes, each
  with its recipe and cost, and 9 house preps (tepache liqueur, thecha salt, muskmelon shrub,
  cold brew, recheado and xacuti masalas…).
- **The last week** (counted from the day it is imported): sales, prep batches, five
  purchase orders (one arriving today), the Layover's closing count, rosters for next week,
  clock-ins (a few late, one no-show), tasks, two repairs, 53 minibar checks
  (some still to charge), two events at Jet Lag, six licences (the bar licence expires in 25
  days) and the regular jobs, which the GM answers for and each department head does (pest
  control, the Executive Housekeeper's, overdue).
- **Daily checklists** for everyone who works shifts (28, most of them from the SOP
  library): the server's section set-up, the room attendant's rooms and turndown, the
  steward's kitchen closing, the technician's plant round… each on that person's To do list
  every day, with no roster needed.
- **New blocks** (ADR 087 to 096): the room ready check per room, signed off by the
  housekeeping supervisor; a weekly service audit (yes or no) and the taste panel (1 to 5) on
  the 1st and 16th; five meters the technician reads at 08:00; what each room type holds;
  four SOPs (handwashing, allergies, turndown, serving alcohol); spirits, wine and beer in the
  excise register; milk, butter, cheese, coconut milk and wine with an opened-pack shelf life;
  the craft gin thrown away only once the GM approves.
- **Rooms**: 101–109, 201–209, 301–306 and the pool terraces P-10 to P-12; Passport Deluxe
  rooms have the Standard minibar, suites and terraces the Suite one.
- `pos-sale-by-item.csv`: the cashier's end-of-day POS file, imported live in the pitch.

## Before importing: refresh the dates

Events, licences, the compliance calendar and opening stock carry dates. Write them from the
day you import, from the repository root:

```sh
pnpm --filter @outlet-ops/onboarding passport-demo --today 2026-10-20
```

(Without `--today` it uses today.) The past week needs no refresh: it counts from the import.

## Importing it on production

The Deploy that carries ADRs 071 and 072 must be out first (the minibar files and
`demo_presenter` are new), and the one with migration `20261128100000_minibar_loader_grant`
(the import marks file 42's checks added to the bill as `platform_loader`).

**1. Build the zip**, from the repository root (only the numbered files):

```sh
(cd docs/onboarding/demo/passport-hotel && zip -q -FS ~/passport-hotel.zip [0-9][0-9]_*.csv)
```

It holds 40 files.

**2. Create the customer**: on `/platform`, the link **New customer: the company and its owner
only** (`/platform/customers/new`), not the **Set up a new customer** button: the set-up wizard
(ADR 064) writes its own files and always makes an email owner, so it cannot load these.
Enter:

| Field               | Value                                    |
| ------------------- | ---------------------------------------- |
| Company name        | `[TEST] Passport Hotel`                  |
| Customer code       | `PASSPORT-TEST`                          |
| Country / Currency  | `India` / `INR`                          |
| Time zone           | `Asia/Kolkata`                           |
| Test customer       | ticked                                   |
| Owner name          | `Ashesh Sajnani`                         |
| Owner signs in with | Username and password (no email)         |
| Owner username      | `test.ashesh-sajnani` (type it yourself) |

**Create customer**, check the owner reads `test.ashesh-sajnani` and "no email is sent", then
**Confirm and create**.

**3. The plan**: the customer's page → **What they buy** → **Hotel** → **On** (the rooms and
their minibars), then **Events & compliance** → **Compliance** → **On** (the licences and the
calendar only show with it). Without Hotel the dry run says the minibar checks are not loaded.

**4. Import**: **Import setup files** → `passport-hotel.zip` → **Upload and dry run**. It
should report no problems and no warnings, with (new): org places 12 / 1 changed (the
company root), delivery places 5, links 4, job roles 36, users 36, workers 36 / 1 changed (the owner's), items 80, item
locations 92, menu items 34, rooms 27, minibar sets 2, minibar checks 54, sales days 7,
purchase orders 5, attendance sessions 132, checklists 31, meters 5, room contents 17, SOPs 4.
**Apply**, then a second dry run shows no
changes.

A Passport loaded before ADR 122: its re-import renames Purchase & Stores to **Purchase**,
gives the Purchase Manager's job role its duties (she runs Purchase, sees the stock of every
store and reads the bills; no store of her own) and puts Shreya Kenkre there (the same
username, so she is updated, not added). One loaded from the ADR 115 files, which had no
Purchase Manager, adds her: org places 1, job roles 1, users 1, workers 1, leave balances 3,
pay rates 1. Either way the front office handover gains its steps and becomes the shift's
handover (checklists 1 changed). Apply, then a second dry run shows no changes.

A Passport loaded before ADR 115 has a Main Store, run by Purchase & Stores. Its re-import
retires the Main Store (its stock counted out: a test customer) and gives the hotel its rules
(the GM approves every request and every purchase). The Purchase & Stores department and its
three people (Shreya Kenkre, Mahesh Talaulikar, Sandeep Volvoikar) stay, as an import never
removes people: deactivate them in Admin → People if they should go. A stock request or order
still open at the Main Store stops the import until it is finished or withdrawn.

A Passport loaded before ADR 083 has two bar stores. Its re-import retires the Mini Bar (lobby)
store, renames the other "Bar" and moves the Mini Bar's 7 dishes to it: a warning says the
Mini Bar store is retired and its stock counted out (a test customer only). A stock request
or order still open at the Mini Bar stops the import until it is finished or withdrawn.

**5. Logins (the printed sheet)**: the customer's page → **Logins** → tick **Set passwords
by the Test<Role>!12 rule** → **Create 37 username logins** (the 36
imported people and the owner) → **Print the login sheet** (and
download the CSV once, if you want a copy; nothing keeps the passwords). Each person's
password is `Test` + their job title without spaces + `!12`:

| Who                                | Username                    | Password                 |
| ---------------------------------- | --------------------------- | ------------------------ |
| Demo Presenter (you, in the pitch) | `passport.presenter`        | `TestAccountOwner!12`    |
| Sainath, General Manager           | `passport.gm`               | `TestGeneralManager!12`  |
| Dylan Coutinho, Bar Manager        | `passport.bar-manager`      | `TestBarManager!12`      |
| Savio Dias, Room Attendant         | `passport.room-attendant`   | `TestRoomAttendant!12`   |
| Kunal Sawant, Cashier              | `passport.cashier`          | `TestCashier!12`         |
| Shreya Kenkre, Purchase Manager    | `passport.purchase-manager` | `TestPurchaseManager!12` |

The owner, Ashesh Sajnani, signs in as `test.ashesh-sajnani` with `TestAccountOwner!12`. The
import refuses files whose account owners don't include the customer's (`ownersInFiles`), so
the owner username in file 07 must be the one typed when the customer was created.

**6. Check**: sign in at the app as `passport.presenter`. Me shows **Show the app as
someone**; pick Sainath: Home shows Compliance (pest control overdue, the bar
licence expiring), the departments and the banner "Showing as Sainath". **Back to
Demo**.

## Starting again

A customer code can be created once. To show it fresh another day, re-import the same
files: nothing changes (the past week loads once). Anything done in a rehearsal stays, so
rehearse the live steps (receive, check a minibar, import the POS file) with other rooms and
items than the pitch, or create a second customer with another code by editing file 00 and
the usernames' prefix in the generator.
