# 016 — The place switcher, production team and event planners (Prompt 10a)

Status: accepted · 2026-10-01

This follows a UX audit: 12 test users signed in to 30 screens each.

- **Migration** (forward-only): `20261011100000_place_switcher_access`.
- **Deploy:** no stack change. Run the Deploy workflow, then re-import both test customers
  (`docs/deploy.md`).

## One switcher per screen, not one for the whole app

The header used to carry one picker over every place a person could reach, People and
Supply mixed. Some screens added a second picker of their own. A store keeper saw
departments on Stock; a general manager saw stores on Roster.

- **`core.screen_places(screen)`** lists the places one screen can show, each passing that
  screen's `core.can()` check:

  | Screen                   | Places                                                               |
  | ------------------------ | -------------------------------------------------------------------- |
  | stock, orders, transfers | stock locations with STOCK_LEVELS, PURCHASE_ORDERS or TRANSFERS view |
  | count, wastage           | stock locations with STOCK_ADJUSTMENTS modify                        |
  | variance                 | stock locations with MENU view                                       |
  | production               | stock locations where they record production and something is made   |
  | sales                    | outlets with SALES modify at a store they sell from                  |
  | menu                     | outlets with MENU view at a store they sell from                     |
  | roster                   | departments (or an outlet without departments) with ROSTER view      |
  | exceptions               | the same, with ATTENDANCE modify                                     |
  | events                   | outlets whose events they read                                       |

  Unknown screens are refused (`INVALID_SCREEN`).

- **The most useful place comes first:**
  1. their home place, or its outlet;
  2. the store linked to their home department;
  3. their outlet's main stock location.

  So a general manager opens Stock at the Main Store, a department head opens Roster at
  their department, and a bartender opens Production at the Bar Store.

- **The bar.** A "Viewing:" bar sits at the top of each of those screens. It shows:
  - a picker with two or more places;
  - a plain label with one;
  - nothing when there are none.

  Menu, sales and variance stay quiet with one place, because their heading names it
  already. Inbox, Requests, Home, Notifications and Admin have no bar.

- **Remembered per screen.** One cookie holds a small map of screen to place, written only
  after `core.screen_places` confirms the place. A page shows `?node=` if the screen offers
  it, else the remembered place, else the first. Tab links carry `?node=`; a screen that
  doesn't offer that place falls back the same way.

## PRODUCTION_TEAM

Commis and bartenders make the prep (pastes, chutneys, syrups, batched cocktails), but
they held no stock access, so they couldn't record a batch.

- **What it is.** An org domain and access group, like RECIPES_TEAM. Held at a department,
  it lets its holder record production at the store linked to that department, for items
  made there. `inv.can_produce_at(store)` combines it with PRODUCTION modify; recording,
  the plan, the list of what is made and the batch list all use it.
- **What it doesn't give.** No stock, count, wastage, order or transfer access. A commis
  sees an expired batch but not **Record wastage**; the banner asks them to tell their chef
  or store keeper.
- **Who gets it.** File 06 gives it to Commis, Cook, Bartender and Central Kitchen Commis,
  at their home department. Kitchen Stewards and Bar Backs don't get it.
- **Navigation.** Without stock access, the bottom nav shows **Production** in place of
  Stock.

## Events belong to the outlet; EVENT_PLANNER plans them

Department heads could create an event for their department only. A wedding is the
hotel's, not the kitchen's.

- **New events go on an outlet** (or a central kitchen site). Anything else is
  `OUTLET_REQUIRED`, and the loader refuses file 17 rows at a department. The migration
  moves existing events to their outlet.
- **Who reads them.** Everyone with EVENTS view at the outlet, or at any department under
  it. The event tables are rule-visible, like recipes:
  - `ops.visible_event_nodes()` is the per-query set;
  - `ops.can_read_event_node(node)` is the same rule, row by row, through `core.can()`.

  The RLS equivalence test holds the two equal.

- **Who plans them.** EVENT_PLANNER (EVENTS modify) creates and edits them; OUTLET_MANAGER
  keeps modify; DEPARTMENT_HEAD drops to view. File 06 gives EVENT_PLANNER at the whole
  outlet to Banquet, F&B and Restaurant Managers. So the Executive Chef can't create an
  event, and the Banquet Manager can.

## Other audit fixes

- **Shortcuts and tabs.** Home shortcuts need the same access as their tab: Count and
  Wastage need modify.
- **Production tab** only with a production place.
- **Request stock** shows at stores; it wanted an outlet before.
- **Menu tab** only when there is a recipe to read or a menu cost to see, and its tab bar
  is hidden when there is one tab.
- **Exceptions tab** only for people who resolve exceptions somewhere. Staff see their own
  exceptions on My shifts.
  The exceptions queue is one department at a time: a general manager picks the
  department on the switcher, where the hotel-wide queue used to group them all.
- **People above outlet level.** My shifts, Clock and Swaps are hidden for anyone whose home
  is above outlet level (`core.my_home()`). **Roster** takes them to the week view.
- **Admin → Add a person** offers only job roles the admin can assign at one of their
  places. `core.admin_job_roles(home)` derives each role there (the body of
  `core.derive_job_role_access`, now shared) and applies the scope and rank checks a save
  makes. A test holds "offered" equal to "a save is accepted".
- **Shelf life.** "Use within N days", or hours under a day, rounded down. Batches show
  the time left, or "Expired".
- **Photos.** Shrunk on the phone to 1280 px on the long side, JPEG 0.7. A 12 MP camera-like
  frame of about 4 MB uploads at about 130 KB (measured in the e2e test).
