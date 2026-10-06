# Plan: one catalogue, outlet templates, "who covers it"

Status: agreed direction, 6 Oct 2026. The decisions are in ADR 058
(`docs/decisions/058-catalogue-templates-and-cover.md`). The SOP manuals and the comparison
this plan comes from are in `docs/sop/`.

## 1. The goal

- **Set-up time.** Set up any hospitality business in under an hour for a small outlet and
  in a day for a hotel. The customer answers questions; they don't fill in CSV files.
- **Missing roles.** An outlet that lacks a role still works: the role's work goes to the
  person who really does it.
- **No packages to choose.** The customer never picks a "package" that later turns out
  wrong. A mixed business, such as a hotel with a bar and a delivery kitchen, uses the same
  pieces.

## 2. What exists today, and what stays

| Piece                                                           | Today                                                                                                | Stays?                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Places: company, region, area, outlet, site, department, stores | Any shape; levels are optional (ADR 009)                                                             | Yes, unchanged                                     |
| Access groups (STAFF, SUPERVISOR, DEPARTMENT_HEAD, …)           | Product code in `packages/domain/src/access.ts`, synced to every customer                            | Yes, unchanged                                     |
| Job roles                                                       | Customer data (file 06): each role lists `GROUP@scope` defaults, which can differ by `outlet_format` | Yes, but defaults come from the catalogue (§4)     |
| Outlet formats                                                  | `full_hotel`, `small_hotel`, `standalone_bar`                                                        | Extended (§5)                                      |
| Modules per company                                             | Events, Swaps, Leave, Production, Prep lists, Checklists, Maintenance, Menu and sales                | Yes; grouped for selling (§9)                      |
| Approvals                                                       | Walk up the place tree to whoever holds the group; end at the Account Owner                          | Yes. A missing role already falls upward           |
| Checklists and tasks                                            | Given to a person, a job role or whoever is on shift                                                 | Yes; "job role" learns about cover (§6)            |
| Onboarding                                                      | 36 CSV files, a dry run and an apply in the platform console                                         | Kept for big or unusual customers; a wizard on top |

**What is missing.** The idea of a **duty**: one piece of responsibility that can move
between roles. Today a duty is spread over three places: a group grant at a scope, a task
assignment rule, and who gets notified. Covering a missing role means moving all three
together, and today nobody can do that in one step.

## 3. The model in one picture

```
Catalogue (ours, product code)
  duties ──┐
  roles  ──┼─ each role has default duties, a level and a usual department
  depts  ──┤
  checklist library, starter items
           │
Templates (ours, product code) = a selection from the catalogue
  Restaurant / Café · Bar / Pub · QSR · Cloud kitchen · Hotel
  add-ons: Central kitchen · Delivery · Microbrewery · (Franchise later)
           │
Set-up answers (the customer's, data)
  per outlet: template + add-ons
  per role:   we have it / covered by <role> / we don't do this
           │
Derived (computed, as today)
  person → job role (+ covered roles) → duties → GROUP@scope grants, task targets, alerts
```

## 4. The work, step by step

Effort is in **build days**: my working days to build, test (lint, typecheck, unit, DB, e2e,
the RLS equivalence check) and document one step. Your review and deploy time is extra. The
ranges allow for findings from the full test runs.

### Step 1. Duty catalogue (the foundation). 6–8 days

- **What it is.** A list of about 40 duties in `packages/domain`, product code like the
  access groups. Each duty is three things:
  - the group grant(s) it needs and at which scope word (`whole_outlet`, `department`,
    `main_store`, …);
  - the task and checklist targets it owns;
  - the alerts it receives.

  Examples:
  - "Receives deliveries at the Main Store"
  - "Approves unusual supply requests (department)"
  - "Verifies stock checks"
  - "Assigns repairs"
  - "Does the chiller temperature log"
  - "Builds the department roster"
  - "Resolves attendance exceptions"
  - "Uploads the POS file"

- **Job roles move to duties.** A job role's defaults become a list of duties.
  `core.derive_job_role_access` resolves duties to grants instead of reading `GROUP@scope`
  directly.
- **Safety.** For both test customers, every person's derived access must be identical
  before and after. The RLS equivalence test (all users) proves it. No behaviour changes in
  this step.
- **Risk.** It is the highest-risk step, because it touches the access derivation everyone
  depends on. That is why it ships alone.

### Step 2. Role and department catalogue. 3–4 days

- **What it is.** About 90 roles, covering everyone in the six SOPs, each with a level (does
  the work / leads a shift / runs a department / runs the outlet / above the outlet), a
  usual department and default duties.
- **New roles.** The SOPs add QSR crew, Crew Trainer, Shift Manager, Assistant Store
  Manager; Kitchen Manager, Packer/Dispatcher and Online Platform Manager; Duty Manager,
  Reservations, Night Auditor, Purchase Manager, Food Safety Supervisor; Barista, Sommelier,
  Head Brewer, Events Manager.
  - Each new role only gets duties for work the app does today. A Night Auditor, for
    example, gets reports and no PMS.
- **Departments.** About 20 departments, each with a type (kitchen, service, housekeeping,
  other, as in ADR 033) and default stores.
- **Customer changes.** A customer may rename a title (e.g. "Head Chef" for Executive Chef)
  without changing its duties.

### Step 3. Templates and the starter library. 5–7 days

- **Outlet templates.** Restaurant / Café, Bar / Pub, QSR, Cloud kitchen and Hotel (full or
  small). Each lists:
  - its departments, roles and stores;
  - the modules on by default;
  - its starter checklists and settings.
- **Add-ons.** Central kitchen (a site and hub store), Delivery (packing checklist; the
  aggregator work itself is not built) and Microbrewery (a brewhouse department and store).
- **Starter checklist library.** Taken from the SOPs: opening and closing per department,
  chiller and freezer log, hot holding, washroom round, bar setup and closing, handover,
  fryer oil, cleaning schedule. Templates switch them on; the customer can edit them later.
- **Starter item lists (optional).** Common items per department with units, so a store
  isn't empty on day one. The customer adds par and prices.
- **`outlet_format`.** Extended to the template codes. The three existing values map
  across: `full_hotel` and `small_hotel` become Hotel, `standalone_bar` becomes Bar / Pub.
- **Effort.** Most of this step is content, not code.

### Step 4. "Who covers it" (cover). 5–7 days

- **Data.** `hr.role_cover(outlet, job_role, mode, covered_by_role)`, where mode is `have`,
  `covered_by` or `not_done`. It has RLS and is audited like every business table.
- **Derivation.** At that outlet, the covering role's people get the absent role's duties,
  through the same derivation as Step 1. Their roster job does not change: they do the
  absent role's work on their own shifts. That is the "one person, two jobs" rule, with no
  rostering change.
- **Tasks.** A checklist given to the absent role goes to the covering role. If a duty is
  `not_done`, its checklists are switched off.
- **Safety net.**
  - A duty nobody holds at a place falls to the next level up: department head, then GM.
    Approvals already behave this way.
  - Admin gets a "Duties with nobody" check, so a gap is visible, never silent.
- **Tests.**
  - DB tests: cover gives the covering role's people the absent role's access at that
    outlet only.
  - RLS tests: cover never gives access at another outlet.
  - Removing cover takes the access away.

### Step 5. Set-up wizard. 8–10 days

The wizard runs in the platform console (us) and, later, in Admin (the customer). It has
seven steps:

1. **Company:** name, country, time zone, currency.
2. **Outlets:** name, template, add-ons, address and geofence. Region and area are optional.
3. **Departments:** the template's list, each switched on or off.
4. **Roles:** for each role in the template, choose "We have it", "Covered by [role]" or
   "We don't do this". It shows the duties that move, in plain words ("Head Chef will also
   order perishables").
5. **People:** paste or upload name, phone and role. The place is picked per person or
   taken from the role.
6. **Stock:** starter items or a CSV, par per store. Recipes can wait.
7. **Review "Who does what":** every duty and who holds it. Then go live: the dry run, the
   apply and logins sent.

- **Validation.** The wizard writes through the existing loader: it produces the same files
  and runs the same dry run and apply. Every check we have today still applies.
- **Saving.** A half-finished set-up is saved and can be resumed.

### Step 6. Changing it after go-live. 3–4 days

- **Admin → Who does what.** The same role answers, editable by the Account Owner or a user
  admin. The common cases:
  - "Our Sous Chef left; the Head Chef covers."
  - "We hired a Store Keeper; stop the GM covering."
- **Rules.**
  - The change is audited.
  - Access is re-derived at once.
  - Open tasks of the moved duty go to the new holder.

### Step 7. Move the test customers and docs. 3–4 days

- **Test customers.**
  - Test Company: Hotel for 1.0 and 1.1, small Hotel for 2.0, Bar / Pub for 3.0, plus the
    Central kitchen add-on.
  - Test Solo Bar Co.: Bar / Pub.
  - Add one cover each (e.g. Guest House 2.0: no Store Keeper, the Front Desk covers), so
    the tests and e2e exercise it.
- **Expected access.** `99_access_preview_GENERATED.csv` stays the expected access and must
  not change, except for the new cover rows.
- **Docs.** `docs/system-map.md`, the "Who does what" page, the onboarding README and the
  CLAUDE.md lines.

### Step 8. Selling by module (packaging). 1–2 days

- **Four bundles** over the existing module switches:

  | Bundle              | Covers                                        |
  | ------------------- | --------------------------------------------- |
  | Stock & cost        | stock, orders, bills, recipes, menu and sales |
  | People & roster     | roster, clock-in, leave, swaps                |
  | Tasks & food safety | checklists, tasks, maintenance, prep lists    |
  | Reports             | reports                                       |

- **Template vs bundle.** A template never decides the price; a bundle never decides the
  structure.
- **Scope.** Admin and the platform console show bundles. Pricing itself is outside this
  plan.

### Final pass. 2–3 days

- An e2e walk at 380 px through the wizard for each template.
- A fresh set-up of a café, a bar and a hotel from nothing, timed.
- The "RLS equivalence (all users)" workflow.
- ADR and docs final.

## 5. Totals

| Step                             | Build days |
| -------------------------------- | ---------- |
| 1. Duty catalogue                | 6–8        |
| 2. Role and department catalogue | 3–4        |
| 3. Templates and starter library | 5–7        |
| 4. Who covers it                 | 5–7        |
| 5. Set-up wizard                 | 8–10       |
| 6. Changing it after go-live     | 3–4        |
| 7. Test customers and docs       | 3–4        |
| 8. Selling by module             | 1–2        |
| Final pass                       | 2–3        |
| **All**                          | **36–49**  |

At about 5 build days a week, that is **7–10 weeks** of calendar time, plus review and
deploys. Each step is its own PR and can be deployed on its own. Step 1 changes nothing a
user sees.

**A smaller first cut: 22–28 build days, about 5 weeks.**

- Steps 1, 2 and 4 in full.
- Step 3 with three templates (Restaurant / Café, Bar / Pub, Hotel) and the starter
  checklists only.
- Step 5 in the platform console only (us, not the customer).
- Skip steps 6 and 8 for now. Until step 6 ships, a change after go-live is made by us in
  the console.

## 6. Effect on what is already built

Nothing is removed. The plan changes how access is **decided**, not what a person can do
once they have it. Every screen, workflow and report stays as it is.

| Built today                                                                            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two trees of places, node links                                                        | None. Templates create the same places and stores.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `core.can`, RLS, access groups, the domain matrix                                      | None. Duties resolve to the same groups at the same scopes.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Customer access groups (ADR 027, e.g. Kitchen Lead)                                    | Stay. They can be granted as today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Modules per company                                                                    | Stay. The bundles (Step 8) switch the same modules.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Platform console, CSV onboarding, dry run, logins                                      | Stay. The wizard writes through them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Approvals, To do list (To assign, To order, To receive)                                | Unchanged. A person covering a role sees that role's approvals and to-dos, because they hold its grants.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Swaps, leave, roster, clock-in selfie and device, attendance exceptions, My week       | Unchanged. Cover doesn't change anyone's roster job.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Send stock (the person on shift confirms, else the head)                               | Becomes a duty, same rule. If the store's department has no head, it falls to the GM.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Expiry alert, Push today                                                               | The alert becomes a duty; today's rule "the department head, else the GM" is exactly the new fall-up rule. Push today is shown by **department type** (`service`) and to the outlet's own managers, not by role, so cover doesn't affect it. Each template must type its front-of-house departments as `service`: Restaurant, Bar, Floor Service, a QSR counter, a café counter. A cloud kitchen has no servers, so its Push today goes to the Online Platform Manager duty as "dishes to feature today". |
| Stock check verification (Cost Controller or Stock Verifier)                           | Becomes a duty. An outlet without either can say "covered by the GM". Today that needs a manual grant.                                                                                                                                                                                                                                                                                                                                                                                                    |
| POS import (Cashier)                                                                   | Becomes a duty. "No cashier, the GM uploads" is one answer.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Send orders to suppliers, bills, Bill missing                                          | Unchanged. They follow whoever holds the Main Store keeper duty.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Reports, figures that open their lists, the reconcile test, league table, business day | Unchanged. A covering person sees the covered role's reports at that outlet. Step 7 adds a covering user to `reports-reconcile.db.test.ts` and the e2e sweep, so cover is tested there too.                                                                                                                                                                                                                                                                                                               |
| Bottom nav, nav-flags cache                                                            | It follows access, so cover can add a tab (e.g. Stock for a GM covering the Store Keeper). The cache key already includes the person's groups, so it refreshes.                                                                                                                                                                                                                                                                                                                                           |
| Audit log                                                                              | Records every cover change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PWA, loading screens, sign-in and sign-out, dark theme                                 | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The three outlet formats                                                               | Renamed to template codes by a migration. Behaviour is the same.                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The guard is Step 1: every test user's derived access must be identical before and after
(the all-users RLS check and `99_access_preview_GENERATED.csv`). If anything changes, the
step doesn't ship.

## 7. Not in this plan

These are separate decisions, each sized separately if wanted.

- **Franchise overlay.** Franchisor over franchisees, royalty, audits. About 15–25 build
  days.
- **Head-office roles that see across outlets.** Ops head, QA, Supply Chain head, Training.
  About 3–4 build days once Step 2 exists, because they are duties at the company level.
- **The gaps in table 2 of the SOP comparison.** Licence register, longer compliance
  calendar, audits, incidents, POS, PMS.
- **Rostering one person in two jobs.** Open question 7. Cover doesn't need it.
- **Today's briefing note (agreed 6 Oct; separate item, 2–3 build days).**
  - **What.** A short note for the shift from the head chef or a manager: specials, 86'd
    dishes, VIPs and allergies, targets. This is the restaurant SOP's pre-shift briefing
    (R day plan 11:30 and 18:30; H FB-01; Q ST-01).
  - **Where it shows.** On Home, above Push today, for everyone working at that outlet that
    business day.
  - **Fields.** Text, plus an optional 86 list picked from the menu. It ends at the 04:00
    business-day cut, and can be set for lunch or dinner or for the whole day.
  - **Who writes it.** A new duty, "Writes the shift briefing", held by default by the
    department heads of kitchen and service departments and by the GM. It is covered like
    any other duty.
  - **Rules.**
    - It is audited.
    - Everyone who works at the outlet can read it (`ops.works_at`), like Push today.
    - It has RLS and DB tests, plus an e2e test at 380 px.
  - **Order.** It can ship before or after the plan. Built before Step 1, its author is the
    TASKS modify right at the department; Step 1 then turns that into the duty.

## 8. Questions for you

1. **Templates.** Are five templates plus add-ons right, or do you want Café separate from
   Restaurant? (They differ only in starter checklists.)
2. **Who answers the role questions at set-up?** Us in the console (recommended for the
   pilot), or the customer's owner in Admin from day one?
3. **"We don't do this".** Should it switch the duty off silently, or always keep a
   fallback to the GM? I recommend a fallback to the GM for approvals and alerts, and
   switching off for checklists.
4. **The first cut or the whole plan?** The first cut gets a pilot running sooner. The rest
   follows.
5. **Bundle names.** Are the four bundle names right for how you plan to sell?
