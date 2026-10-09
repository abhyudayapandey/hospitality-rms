# Building blocks, and what every hotel needs (the Passport pilot, round 2)

The plan for four pull requests. Paste this whole document to whoever builds one of them and
say which PR is theirs. PR 1 comes first; PRs 2, 3 and 4 build on it and may then go in any
order.

## Why

Passport Hotel shared 38 of its own and its reference documents (SOPs, checklists, trackers,
registers). Most of what they do daily the app already does. What it lacks are things nearly
every hotel and restaurant does, so they belong in the product, not in one customer's set-up.
And not every customer wants everything: the product is sold as **building blocks**, each
group of functionality added to or taken out of a customer's plan. That is also how it is sold.

## Decisions already taken (do not reopen)

1. **Only platform admins change configuration**: which blocks a customer has, its bundles and
   its onboarding choices (policies). The Account Owner and everyone else see them, read-only.
2. **The base is small**: places and people, access, To do, approvals, notifications, Home, Me,
   Admin and onboarding. Everything else is a block that can be off.
3. **People includes salaries**, and so labour cost in the reports. "Salaries & labour cost" is
   a block inside People, **on by default**; off, no pay rates are kept or shown and total cost
   is materials only. Some customers will not share pay; this is their switch.
4. **Room contents are counted, not stocked.** What sits in a room stays stock of its store; a
   room check counts it against the room's list. Amenities used in a room leave the
   Housekeeping store as `consumption`, as minibar refills do.
5. **Sign-off default**: the role one level up in the same department, else the department
   head; onboarding may change it per checklist.
6. **Not now** (kept in `docs/future.md`): GST on purchase orders, cash and bank deposits, a
   production plan by weekday, and the PMS (Hotelogix) integration.

## Read first

`CLAUDE.md` (it overrides everything, `docs/LLD.md` included: the non-negotiable rules, the
conventions, "How to work in this repo"), then ADR 026 (modules), 067 (bundles), 069
(compliance), 072 and 081 (minibars), 074 and 075 (tasks), 076 (make by task) and 083, and this
plan. The SOP manuals are in `docs/sop/`; the Passport demo is
`docs/onboarding/demo/passport-hotel` (written by `pnpm --filter @outlet-ops/onboarding
passport-demo`; never edit its CSVs by hand).

---

## The block model (PR 1 builds it; every later PR follows it)

**A block** is a switch with a manifest in `packages/domain/src/modules.ts` (the code name stays
`module`; to people it is a block or a module). The manifest says:

| Field                  | Meaning                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `code`, `name`, `what` | the switch, its name and one plain line                    |
| `bundle`               | the group it is sold in                                    |
| `needs`                | blocks it can't work without (Prep lists needs Production) |
| `fits`                 | `any`, `hotel` (rooms) or `alcohol` (serves alcohol)       |
| `domains`              | the access domains it owns (`DERIVED_*` with their base)   |
| `defaultOn`            | on for a customer that hasn't said (Compliance is off)     |

**Bundles** are what is sold, each a group of blocks:

| Bundle              | Blocks (later PRs add the ones in brackets)                                          |
| ------------------- | ------------------------------------------------------------------------------------ |
| Stock & buying      | Stores & stock, Supply requests & orders (Breakage, Shelf life & labels)             |
| Kitchen & bar       | Recipes & costing, Production, Prep lists, Menu & sales (Excise)                     |
| People              | Roster, Clock-in, Salaries & labour cost, Leave, Shift swaps (Training & SOPs)       |
| Daily work          | Checklists, Maintenance, Briefing (Logbook & handover, Registers, Utilities, Audits) |
| Hotel               | Minibars (Rooms, Linen & uniforms)                                                   |
| Events & compliance | Events, Compliance                                                                   |

**On or off.** A block is on when its bundle is in the customer's plan, the platform admin
hasn't switched it off, and every block it needs is on. Kept in `core.tenant.settings` (`bundles`
and `modules`, as today).

**Off means gone and refused, data kept.**

- `core.can` returns false for a domain whose block is off (`core.domain_module`), so RLS hides
  its rows and every function that checks access refuses. One place, no per-function calls.
- Screens: the shell leaves the block's domains out (`lib/modules.ts`), so its nav, tabs and
  Home cards disappear; its pages say it isn't switched on; its server actions call
  `requireModule` first (a clear `MODULE_OFF` message).
- Jobs skip the block (checklist rounds, compliance reminders, expiry alerts, attendance
  exceptions).
- Report figures that come from a block are hidden with it.
- Nothing is deleted; switching it back on brings it all back.

**Who changes it.** Platform admins only: the customer's page in the team console (a card per
bundle, a switch per block, in the platform audit), and file 00 at onboarding. Admin → Modules
in the app shows the plan, read-only.

**Onboarding choices (policies).** A company-wide choice is a file 00 column, kept in
`core.tenant.settings.policies`, shown on the customer's console page and changed only there by
a platform admin. A choice about one thing (a checklist's sign-off, an item's discard approval)
is a column in that thing's own file. Every choice has a default and the set-up wizard asks it
in plain words.

**Adding a block (later PRs):** add it to the manifest and its bundle, add its code in the
migration that creates its tables (`core.module_codes`, `core.module_bundle`,
`core.domain_module`), add its file 00 column, and the guard tests below fail until all of
that agrees.

**Guard tests:** the code registry equals the database's; every domain belongs to exactly one
block or to the base; turning each block off makes `core.can` false for all its domains for
every user; no customer's blocks change in the migration.

---

## PR 1 — Building blocks

1. **Registry** (`packages/domain`): the manifest above for every existing feature; bundles
   regrouped as in the table; the domain map moved from `apps/web/lib/modules.ts` into the
   manifest; `BASE_DOMAINS`. New block codes: `stock`, `buying`, `recipes`, `roster`,
   `clock_in`, `pay`, `briefing`, `minibars`; existing ones keep their codes.
2. **Migration** (forward-only, `20261209100000_building_blocks`):
   - codes, bundles, `core.module_default`, `core.domain_module`; `core.module_on` with needs;
   - translates every customer's settings to the new bundles so nothing they have today
     changes (it checks this and fails if anything would); the Hotel bundle is in for
     customers with rooms;
   - `core.can` checks the block;
   - `core.set_module` no longer allowed for anyone in a customer; `platform.set_module` for
     platform admins, audited; `platform.customer_modules` lists every block;
   - Salaries & labour cost off: `rpt.labour_cost_rows` gives nothing for the customer, so
     labour cost is 0 and total cost is materials only;
   - jobs skip switched-off blocks.
3. **Onboarding**: file 00 has a column per block (blank keeps it); file 34 (pay rates) is
   skipped with a warning when Salaries & labour cost is off; the wizard's "What they buy" uses
   the new bundles; outlet templates name the blocks they use.
4. **Web**: the shell hides every block's screens; Admin → Modules read-only ("Your plan");
   console customer page: a card per bundle with a switch per block; labour figures hidden with
   Salaries & labour cost; Clock, Roster, Stock, Orders, Recipes, Briefing and Minibars pages
   say when their block is off.
5. **Tests**: `blocks.db.test.ts` (guard tests above; owner refused; platform admin switches;
   off hides and refuses; pay off gives materials-only totals, `reports-reconcile` still
   passes); unit tests for the registry; e2e: a platform admin switches a block off and its
   nav item disappears.
6. **Docs**: ADR 084, CLAUDE.md bullet, `docs/future.md`, system map, deploy notes.

---

## PR 2 — Checklists, logbook & handover, registers, utilities

**Checklists** (block Checklists):

- **Sign-off.** File 29 `sign_off` per checklist: `none`, `up` (the role one level up in the
  department, else the department head; the default), `department_head` or `role:CODE`. When
  the doer finishes, the signer gets a To do item; they **approve** or **send back** with a
  note, and the doer redoes the steps. Each step keeps who did it and who checked it.
- **Schedules** (file 29 `schedule`, beside `daily`, `weekly`, `every Nh`): `monthly 1,16
09:00` (dates of the month), `nth Mon 1,3 10:00` (1st and 3rd Monday). A step may run only on
  some weekdays (`days` column, e.g. `Mon,Thu`), so one weekly chart has different tasks each
  day. The schedule is set at onboarding; the right department and role get each round when due.
- **Readings.** A number step out of its range requires "what did you do" before it is done.
  A temperature step may also take the food probed and "out-of-date food thrown away"; the
  receiving check takes chilled and frozen delivery temperatures.
- **For each room or area.** A checklist may repeat its steps `per_room` (an outlet's rooms,
  file 40) or per named area (file 29 `areas`). Its task shows a **grid**: rooms or areas down,
  steps across, each cell ticked or counted. Rooms show their **status** (VC, OCC, VD, OOO,
  ARR, DEP, HM: `ops.room_status`, set on the grid or by front office). The HK room checklist
  and the common-area checklist are this.

**Utilities** (new block in Daily work): meters per outlet (file 43: electricity, gas, water,
diesel, with unit). A daily reading task for the role chosen at onboarding; readings stored;
consumption = this reading − the last; a monthly report and trend.

**Logbook & handover** (new block in Daily work): an entry is a **handover** (to the next shift
of a department or role, or to a named person) or a **log** (with "valid till"). Every
handover must be **acknowledged** by whoever receives it: until then it is a To do item; the
writer and the department head see who hasn't. Front office, security and restaurant logbooks
are this one block.

**Registers** (new block in Daily work): one engine, a register type per kind, each type on or
off at onboarding with who sees and writes it: lost & found (found → kept → returned with ID,
or disposed), incidents (who, where, what happened, action, witnesses), visitors, vehicles,
staff in and out (with gate pass), keys, fire equipment inspections. Entries are never
deleted; closing one is a status through the workflow.

Tests, migrations, ADRs, file 29/43 changes, test data and the Passport demo, e2e as the doer,
the signer and the security guard; RLS all-users workflow before merging.

---

## PR 3 — Stock policies, rooms, linen & uniforms

**Stock & buying:**

- **Par by day of week.** File 11 `par_by_day` (e.g. `Mon-Thu 10; Fri-Sun 20`, or one per day).
  Every "fill to par", running-low list and stock request uses today's par.
- **Discard policy.** File 10 `discard_approval` = `gm` for items that need the GM's approval
  before they are thrown away; every other discard is told to or approved by the department
  head (shown at onboarding as the rule). The approver's one tap approves it and creates the
  discard task for a person in that department (the usual task rules); the stock leaves as
  `wastage` when the task is done.
- **Purchase approval policy** (file 00 `purchase_approval`): `every` (every order goes to the
  GM), `unusual` (today's rule, the default) or `above:<amount>`. Through the existing approval
  chains.
- **Shelf life & labels** (new block): file 10 `open_shelf_life_hours`, `storage` (dry, chilled,
  frozen), `vegetarian`, `contains_nuts`, `allergens`. Opening a pack records it and prints a
  day-dot label with its use-by; opened items appear in Expiring and Expired like batches.
- **Breakage** (new block): crockery, cutlery, glassware and linen as durable items; an entry
  has item, quantity, reason, where, broken by (staff, guest, unknown) and its ₹ value; every
  department head sees it; a monthly report; stock leaves through the ledger.

**Hotel:**

- **Rooms** (new block): each room's contents (durable items and amenities with an expected
  count, file 44 or by room type); a room check counts them; a grid shows what is where across
  rooms and stores. Room status (from PR 2) on the list.
- **Guests by breakfast mode**: front office enters each day's totals by mode (in-room,
  buffet), then the room-wise list. The Hotel Manager, GM and kitchen see it; housekeeping sees
  it and may add or change a room (a guest calling at night).
- **Linen & uniforms** (new block): par per room, outlet and store; soiled and fresh counts
  exchanged with the laundry, the difference carried; uniforms issued per person; both in the
  month-end stock check.

---

## PR 4 — Audits, training & SOPs, excise, covers

- **Audits & taste panels** (new block in Daily work): scored checklists (yes, no, not
  applicable per question, a % score; or 1 to 5 per criterion), on a schedule, with history and
  trend. Service audits and the management taste panel are these.
- **Training & SOPs** (new block in People): the training calendar, sessions with attendance,
  tests with scores, induction checklists for new joiners; the **SOP library** of documents and
  photos by department and role; **Me → SOPs** lists the ones for your role and opens them; a
  handbook may need "I've read this".
- **Excise** (new block in Kitchen & bar, fits `alcohol`): the daily bar register, the monthly
  FLR, transport permit scans when liquor arrives, FOC stock. Seen by the GM and the Bar Manager,
  or the Restaurant Manager where alcohol is served without a bar.
- **Covers and average spend per cover** (Menu & sales): the Restaurant Manager or the GM
  enters covers per meal period; once the day's POS import is in, the average spend per cover is
  worked out and shown to the roles that see sales; it joins `reports-reconcile.db.test.ts`.

---

## For every PR

- Plan first and wait for approval; DB tests (who may, who may not, across customers) before or
  with the feature; real Postgres.
- New migrations only; never edit a merged one. One ADR per decision (next free number).
- Each new block: manifest, migration codes, file 00 column, guard tests pass.
- Onboarding files, the test data, the Passport demo and the wizard updated where they change;
  generated files regenerated with their scripts.
- `pnpm lint && pnpm typecheck && pnpm test` and the full e2e green; every new screen has its
  `loading.tsx` and an e2e as the person who uses it.
- Run the "RLS equivalence (all users)" workflow before merging; open the PR, subscribe, drive CI
  green; give the deploy steps in CLAUDE.md's order.
- Never run `cdk deploy`, the Deploy workflow or anything that changes AWS without approval;
  never commit secrets or `TEST_LOGINS_do_not_commit.csv`; no model names in commits or PRs.
