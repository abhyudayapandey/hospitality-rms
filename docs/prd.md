# Outlet Ops — Product Requirements Document

Sep 30, 2026 · @AP

## 1. Overview

Outlet Ops is a mobile-first operations platform for hotels, restaurants and bars. It brings stock, orders, rosters, attendance, leave and events into one application, with role-based access per place, approvals that route themselves, and an AI layer that recommends actions for managers to approve.

**Product statement:** one intelligent platform to manage stock, orders, people and operations across every outlet.

**Design principles**

- **Simple for frontline staff:** every daily task works on a phone, in a few taps, on a weak network.
- **Configurable per customer:** the product adapts to each customer's structure, job titles and approval policies without code changes.
- **Contextual security:** access is always granted to a role at a place, and covers that place and everything below it.
- **Auditable:** every stock movement and every state change is recorded; nothing is silently edited.
- **AI that proposes, people that approve:** recommendations become normal approval requests; the AI never acts on its own.

**Status of this document:** living PRD. Modules marked _Built_ exist in the running product; _In progress_ and _Planned_ items describe committed or intended scope. Figures in brackets like \[\_\_\] are not yet decided.

## 2. Problem, customers and personas

**Problem.** Outlets run on disconnected tools. Point-of-sale systems track sales, HR and payroll tools pay people, and everything in between (stock counts, wastage, orders, rosters, attendance, approvals) lives in registers, spreadsheets and WhatsApp. Owners learn about stock leakage, overtime and missed approvals at month-end instead of the day they happen, and multi-outlet operators have no consistent view across properties.

**Target customers**

| Segment                         | Shape                                                                                                | Primary need                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Hotel groups                    | Several properties, 10+ departments each, separate stores, often a central kitchen and area managers | Control across departments and properties                    |
| Small hotels and guest houses   | One property, GM runs everything, one stock location                                                 | Simple daily control without admin overhead                  |
| Standalone bars and restaurants | Bar, floor service and kitchen teams; owner or bar manager in charge                                 | Stock control on liquor and food, rosters for evening shifts |
| Restaurant chains               | Many similar outlets, sometimes a central kitchen                                                    | Consistency and visibility across outlets                    |

Initial market: India, starting in Mumbai.

**Personas**

| Persona              | Examples                                            | Uses Outlet Ops to                                            |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Frontline staff      | Bartender, steward, room attendant, commis          | See shifts, clock in, request leave and swaps                 |
| Stock users          | Chef, head bartender, store keeper, receiving clerk | Count stock, record wastage, request transfers, receive goods |
| Department heads     | Executive chef, bar manager, front office manager   | Build rosters, approve the team's requests, run their store   |
| Outlet heads         | General manager, standalone bar manager             | Run the whole outlet from one dashboard and inbox             |
| Multi-outlet leaders | Area manager, owner                                 | See every outlet, approve escalations                         |
| Customer admins      | Account owner, user admin                           | Manage users and access for their company                     |
| Platform admin       | The Outlet Ops team                                 | Onboard and support customers                                 |

## 3. Goals, non-goals and success metrics

**Goals**

1. Give every outlet one mobile app for daily stock, people and approval work.
2. Give managers and owners same-day visibility across departments and outlets.
3. Make every stock movement and approval traceable to a person and a reason.
4. Fit any customer structure, from a single bar to a multi-property group, through configuration.
5. Add AI recommendations that managers act on through the normal approval flow.

**Non-goals (for now)**

- Point of sale, billing or table management. Outlet Ops works alongside a POS; Full POS integration comes later; importing daily item sales from the POS is in scope (SAL-1, section 13).
- Payroll calculation and statutory compliance filings. A payroll export is planned; payroll itself is not.
- Guest-facing features such as reservations or room booking.
- Accounting. Stock valuation is provided for control, not as a ledger of record for finance.

**Success metrics** (targets to be set after the pilot)

| Area     | Metric                                                     | Target           |
| -------- | ---------------------------------------------------------- | ---------------- |
| Adoption | Share of rostered staff who clock in through the app       | \[\_\_%\]        |
| Adoption | Weekly active managers per outlet                          | \[\_\_\]         |
| Control  | Stock counts completed on schedule                         | \[\_\_%\]        |
| Control  | Median time from request to approval                       | \[\_\_ hours\]   |
| Value    | Recorded wastage and count variance trend after 60 days    | \[\_\_% change\] |
| AI       | Share of recommendations accepted or edited, not dismissed | \[\_\_%\]        |
| Business | Paying outlets; monthly revenue per outlet                 | \[**\]; \[₹**\]  |

## 4. Customer structure model

Each customer (tenant) is described by two trees, joined by links. Data from different customers is fully isolated.

**People tree (org).** Company → region → area → outlet → department. Workers belong to a node in this tree (their home place). Every level below the company is optional.

**Stock tree (supply).** Supply network → central kitchen store → outlet supply point → stores (Main, Kitchen, Bar, Housekeeping). Any node marked _holds stock_ can hold stock; a small outlet can hold stock at its supply point with no separate stores.

**Links.** Each outlet is linked to its supply point, and each department to the store it uses (Kitchen ↔ Kitchen Store). Links let managers see the stock that belongs to the people they manage.

**Outlet formats.** Each outlet has a format that tunes job-role defaults:

| Format          | Typical shape                                       | Outlet head                                                  |
| --------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| full\_hotel     | 10 departments, 4 stores                            | General Manager                                              |
| small\_hotel    | No departments, one stock location                  | General Manager (also handles stock if the customer chooses) |
| standalone\_bar | Bar, Floor Service, Kitchen; Bar and Kitchen stores | Bar Manager                                                  |

**Requirements**

- **STR-1** No feature may assume a level exists. Responsibility is always found by walking up the tree to the nearest node with the needed role or setting.
- **STR-2** Stock may only be recorded at nodes marked _holds stock_.
- **STR-3** Structure is loaded at onboarding from files (section 8) and later editable by the account owner in the app \[Planned\].
- **STR-4** Codes are readable and unique per customer (e.g. TEST-HOTEL-1.0-BAR-STORE).
- **STR-5** Two reference test customers cover every shape: Test Company (two full hotels, a guest house, a standalone bar, a central kitchen) and Test Solo Bar Co. (one bar, no region, area or central kitchen).

## 5. Access and security model

**Core rule.** A person holds an _access group_ at a _place_. The access covers that place and everything below it, unless it is marked "this place only". All decisions are made in the database by one function; the app never re-implements permission checks.

**Two layers of configuration**

- **Access groups** define what can be done. They are part of the product and the same for every customer.
- **Job roles** define which access groups each job title gets, per customer and per outlet format. Per-person exceptions are added as extra assignments.

&#91;embedded content: user hierarchy · operational chain and admin roles\]

Requests escalate up the operational chain, skipping any level an outlet doesn't have. Admin roles sit beside it: the platform admin creates the customer and its account owner, who creates user admins; none of them see business data unless they also hold a data role.

**Access groups**

| Group                               | Allows                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| SELF                                | Own shifts, attendance, leave, swaps, notifications, own pay rate (view)                                                            |
| STAFF / SUPERVISOR                  | View roster and events; supervisors also view attendance                                                                            |
| DEPARTMENT\_HEAD                    | Build and publish the department roster, resolve attendance exceptions, first approval of leave and swaps, manage department events |
| STOCK\_USER                         | View stock, counts, wastage, transfer requests, receive goods against a PO, for one store                                           |
| STORE\_KEEPER                       | Everything STOCK\_USER does, plus create purchase orders and dispatch transfers                                                     |
| COST\_CONTROLLER                    | View stock, counts, wastage and POs across an outlet's stores                                                                       |
| OUTLET\_HR                          | Worker records and leave for an outlet (no pay data)                                                                                |
| OUTLET\_MANAGER                     | Everything in the outlet; approves orders and escalations                                                                           |
| AREA\_MANAGER                       | Views everything in the area, stock read-only through links; approves escalations                                                   |
| HUB\_MANAGER / SUPPLY\_VIEWER       | Run the central kitchen store / view stock below for supply planning                                                                |
| HR\_ADMIN, SECURITY\_ADMIN, AUDITOR | Company HR incl. pay; sensitive access approvals; audit log                                                                         |
| ACCOUNT\_OWNER, USER\_ADMIN         | Administer users and access (section 8); no business data                                                                           |

**Requirements**

- **SEC-1** Row-level security on every business table; a build check fails if any table lacks it.
- **SEC-2** Stock history is append-only; status changes happen only through the workflow engine.
- **SEC-3** Admin rights are not data access: user admins and account owners see no stock, rosters or pay unless they also hold a data role.
- **SEC-4** No one can grant more admin rank than they hold, grant outside their scope, or grant to themselves.
- **SEC-5** Sensitive grants (outlet manager, user admin, account owner, HR, pay access) require a second person's approval; everyday grants apply immediately.
- **SEC-6** The last account owner can never be removed or deactivated.
- **SEC-7** Every admin action, every stock movement and every approval is audited with actor, place and approver. Owners and admins see an access-audit view limited to access events.
- **SEC-8** Approvers without data access can read a request only while it is pending in their inbox, plus a stored summary of what they decided.
- **SEC-9** The AI agent is a service identity with view-only data access; its only write paths are creating recommendations and submitting workflow requests.

## 6. Functional requirements by module

### 6.1 Inventory _(Built at outlet level; store level in progress)_

- **INV-1** Item catalogue per customer: code, name, category, base unit, perishable flag, standard cost, preferred supplier.
- **INV-2** Per stock location: par level, reorder quantity, count tolerance.
- **INV-3** Stock changes only through ledger entries (receipt, consumption, wastage, transfer out/in, count adjustment); ledger rows can never be edited or deleted. Weighted average cost.
- **INV-4** No item may go below zero; the error tells the user to record the receipt or do a count.
- **INV-5** Stock counts snapshot system quantities; variance within tolerance posts directly, beyond tolerance goes to approval.
- **INV-6** Wastage with reason code and optional photo; above a per-location value threshold (default ₹2,000) a photo and approval are required.

**Data flow: recording wastage**

&#91;embedded content: data flow · a wastage entry from phone to ledger\]

Every stock change follows this path: the database checks the user's access at that store, then either writes the ledger entry directly or, above the threshold, raises a workflow request whose approval makes the executor write it. Stock levels and the audit trail update in the same transaction as the ledger entry.

### 6.2 Purchase orders _(Built)_

- **PO-1** Store keepers and outlet heads create POs with suggested quantities: par level minus on-hand minus open orders.
- **PO-2** Approval by the outlet head; above a threshold (default ₹50,000) also by the area manager or owner.
- **PO-3** Receiving against a PO by stock users; receipts capped at ordered quantity plus 5%; any excess recorded as a supplier-excess adjustment for approval.

### 6.3 Transfers _(Built for central kitchen → outlet; store-to-store in progress)_

- **TR-1** Requested by stock users; dispatched by whoever runs the sending location; received by whoever runs the receiving location.
- **TR-2** Stock leaves at dispatch and arrives at receipt; shortfalls post as transit loss; dispatched transfers show as in transit and cannot be rejected.

### 6.4 Rostering _(Built at outlet level; department level in progress)_

- **ROS-1** Shift templates per department (or outlet), weekly roster generation, assignment, publish.
- **ROS-2** Every assignment checked for overlap, minimum rest, weekly hours cap, approved leave, role match and home place; rules are per-customer settings (defaults 10 h rest, 48 h/week, 10 min late threshold).
- **ROS-3** Shift times in the outlet's time zone; overnight shifts supported.

### 6.5 Attendance _(Built)_

- **ATT-1** Clock in/out with location compared to the outlet's geofence; outside or missing location is flagged, not blocked.
- **ATT-2** Works offline; punches sync later with the original time (up to 24 h old).
- **ATT-3** Nightly exceptions: late, no-show, missing clock-out, unrostered; resolved by department heads or outlet heads.

### 6.6 Leave and shift swaps _(Built)_

- **LV-1** Leave types and yearly entitlements per customer; balance checked at request including pending requests.
- **LV-2** Approval screen shows the balance and the shifts approval will drop.
- **SW-1** A swap needs the colleague's acceptance before a manager sees it; rules re-checked at approval; neither party can approve their own swap.

### 6.7 Events _(Built)_

- **EV-1** Events with covers, time window and requirements (items with quantities, roles with headcount).
- **EV-2** Created by department heads for their department or by outlet heads; requirements feed AI recommendations.

### 6.8 Notifications and dashboard

- **NT-1** In-app notifications with unread badge for roster publish, swap and leave decisions _(Built)_. Web push _(Planned)_.
- **DB-1** Manager dashboard: stock below par, today's roster coverage, open approvals, open exceptions, transfers in transit _(Planned)_.

### 6.9 Menu, recipes, production and cost control _(Built; POS import later)_

Spec and test data: `docs/onboarding/test-data/MENU_README.md` and files 18 to 24 of each test customer (ADR 014). The point-of-sale import comes later and will feed the same sales path.

- **MNU-1** Each raw item has a unit conversion from its stock unit to the unit recipes use (1 kg = 1000 g; one 750 ml bottle = 750 ml; 1 lemon = 1 each).
- **MNU-2** Prep items (kitchen prep, house mixers, batched cocktails) are stock items made in-house, with a standard batch yield and a shelf life. A prep location says whether the store makes it or receives it by transfer, and its par level.
- **MNU-3** Recipes for prep items and menu items are versioned with effective dates. A change is a new version from today or a later date and never edits an old one. Sub-recipes are allowed; a recipe that would make a prep item from itself is refused. Each line uses the ingredient's recipe unit. Recipe and price changes are in the audit log.
- **MNU-4** Menu items (Food or Bar, category, serving) are sold by an outlet from one of its own stores at a price before tax, also versioned by date.
- **MNU-5** Cost per serve and cost % per outlet use the store's current weighted-average cost, or the standard cost where there is no stock yet. Prep costs roll up through their sub-recipes at a store that makes them. Costs are worked out when they are read, so they follow every cost or recipe change. Line cost = quantity ÷ (1 − trim loss %) × cost per recipe unit.
- **MNU-6** Loading files 18 to 24 checks them against each other: units agree, a prep item's ingredients are stocked where it is made, no recipe cycles, and a menu item is sold from one of the outlet's own stores. A menu item sold from a store that does not stock one of its ingredients is a warning. Costs from the loaded test data equal the generated 98 files to the paisa.
- **MNU-7** Recipes and procedures (steps, batch size, shelf life, never costs) are readable only by people who hold stock access at a store that makes or sells them, or who work in a department linked to such a store: kitchen staff read kitchen recipes, bar staff bar recipes. Housekeeping, front office and security staff read none. Managers with cost access read every recipe used at their stores.
- **MNU-8** Prices and costs: department heads (their own department's store), outlet managers, cost controllers, hub managers and area managers. Editing menus, prices and recipes: outlet managers, for recipes used only within their outlet; area managers view only for now.
- **PRD-1** Recording a batch where it is made: ingredients consumed per the recipe scaled to the batch (actual quantities editable), the prep item added with a batch number and expiry from its shelf life, in one transaction. Expired batches prompt a wastage entry. Prep items transfer like other items.
- **SAL-1** Daily sales entry per outlet (menu item × quantity) until the POS import. Sales reduce stock at once by recipe; only sales may take stock below zero, which never blocks a sale and is flagged to the store keeper.
- **VAR-1** Variance per store and period: opening + receipts + transfers in − transfers out − wastage − theoretical use (sales and production) against the closing count, with unexplained loss highlighted, and food and beverage cost % per outlet.

| Group                              | Recipes and procedures                  | Prices and costs             | Editing                                          |
| ---------------------------------- | --------------------------------------- | ---------------------------- | ------------------------------------------------ |
| Staff, supervisor, department head | Through their department's linked store | Department head: their store | –                                                |
| Stock user, store keeper           | At their store                          | –                            | –                                                |
| Cost controller, hub manager       | At their stores                         | Yes                          | –                                                |
| Outlet manager                     | Everything used in the outlet           | Yes                          | Menus, prices, recipes used only in their outlet |
| Area manager                       | Everything used in the area             | Yes (view)                   | –                                                |

## 7. Workflows and approvals

Every state-changing business action is a workflow request: submitted, routed through approval steps, then executed by the system. Drafts live in the module; approved changes are applied in one transaction by the executor.

**Processes**

| Process          | Initiated by                          | Approval chain (nearest available first)                                                                                     |
| ---------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Stock adjustment | Stock users, store keepers            | Store's outlet head → area manager → owner                                                                                   |
| Purchase order   | Store keepers, outlet heads, AI agent | Outlet head; above threshold also area manager → owner                                                                       |
| Transfer         | Stock users                           | Dispatch: sending location's store keeper / hub manager → outlet head → owner. Receipt: receiving location's equivalent      |
| Leave            | The worker                            | Department head → outlet head → area manager → owner; then HR step (outlet HR → HR admin → owner) if the customer enables it |
| Shift swap       | The receiving colleague               | Department head → outlet head → area manager → owner                                                                         |
| Role change      | User admin, account owner             | Security admin → account owner                                                                                               |

**Example user flow: a leave request**

&#91;embedded content: user flow · leave request from request to notification\]

If the worker's department has no head, the request goes to the GM, then the area manager, then the owner. A rejection at any step notifies the worker and changes nothing; the same pattern applies to swaps, orders and adjustments.

**Requirements**

- **WF-1** Routing walks up the tree from the subject's place and picks the nearest person who holds an approver group; the account owner closes every chain.
- **WF-2** Nobody approves their own request; for swaps, neither party approves. If the only possible approver is excluded, the step moves up the chain.
- **WF-3** When the same person would approve consecutive steps, later steps are skipped and recorded as covered.
- **WF-4** At onboarding, a coverage check proves every process at every place has an approver; loading is refused otherwise.
- **WF-5** Business rules are re-checked at approval so the approver sees a rule failure before deciding; rule failures in execution are final, not retried.
- **WF-6** Overdue steps escalate up the same chain after a service level (default 24 h); unroutable steps are listed for admins, never dropped.
- **WF-7** Idempotent submission; one active request per subject; complete history per request.

## 8. Administration and onboarding

**Three admin levels**

| Role           | Scope                 | Can do                                                                                                                                           |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform admin | All customers         | Create customers and their first account owner; import setup files; view customer status; suspend or reactivate. No customer business data.      |
| Account owner  | Whole company         | Everything a user admin does, plus company settings, creating user admins and owners, approving sensitive grants. Final approver of last resort. |
| User admin     | Company or one outlet | Add, edit and deactivate users; assign job roles and extra access; reset passwords; within scope only.                                           |

**Platform admin console** _(Next)_

- **ADM-1** Separate login system (authenticator app). Platform admin accounts: no shared or pattern passwords, MFA required. Customers created as test customers (is_test, set at creation and immutable) may use the Test<Role>!12 rule for their users.
- **ADM-2** Create customer: company name, country, currency, time zone, first account owner (email invite; the owner sets their own password).
- **ADM-3** Import setup files: upload the CSV bundle, see a dry-run report (what will be created or updated, every error with file, row and column, the approval coverage check), then apply in one transaction. Re-importing unchanged files changes nothing.
- **ADM-4** Customer list with status, user count and last activity; suspend or reactivate.
- **ADM-5** Support access to customer data _(Later)_: time-limited, reason required, visible in the customer's audit log.

**In-app user administration** _(Next)_

- **USR-1** User list within scope; add a user with name, login type (email OTP or username and password), job role and home place; derived access shown before saving.
- **USR-2** Extra access and cover assignments with start and end dates.
- **USR-3** Password reset for username users (temporary password, change at next sign-in); deactivate leavers (login disabled immediately).
- **USR-4** Access-audit view: who granted or removed what, when, and who approved it.

**Setup files.** One file per data type: customer, people tree, stock tree, links, locations, job roles, users, extra access, suppliers, items, item locations, opening stock, leave types, leave balances, roster settings, shift templates. A generated access preview lets the customer check who can do what before loading.

**Login.** Email one-time code, or username and password for staff without email. Sessions last up to 12 hours idle and 30 days in total. SMS login needs Indian DLT registration and is deferred.

## 9. AI layer _(Planned — last in the build sequence)_

**Principle.** Numbers come from the database; the model explains them and shapes a proposed action; a validator checks it; a manager approves it through the normal workflow. The AI never changes data directly.

**Signals**

| Signal        | Trigger                                                 | Proposed action                                          |
| ------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Low stock     | Days of cover below supplier lead time + 1              | Draft purchase order with suggested quantity             |
| Event uplift  | Upcoming event needs more stock or staff than available | Draft PO lines and/or open shifts                        |
| Roster gap    | Shift below minimum headcount, or leave leaves a hole   | Suggest available workers ranked by hours and rest rules |
| Overtime risk | Worker projected over weekly cap                        | Suggest reassignment                                     |
| Wastage spike | Item wastage above twice its 28-day median              | Insight only                                             |

**Requirements**

- **AI-1** Each recommendation carries its domain and place, so people only see recommendations about what they may see (a store keeper sees stock recommendations, not roster ones).
- **AI-2** Accepting a recommendation submits a workflow request with the AI agent as initiator and the manager's acceptance recorded; edit and dismiss are also recorded.
- **AI-3** The validator rejects unknown IDs, disallowed process types and quantities more than 20% away from the computed figure; numbers in explanations must match the data.
- **AI-4** Duplicate open recommendations for the same subject are suppressed; recommendations expire.
- **AI-5** Provider decided at build time: the Anthropic API or Claude via Amazon Bedrock (Bedrock needs a paid AWS plan). Model and prompt version stored per recommendation.
- **AI-6** Auto-approval within per-customer thresholds _(Later)_.

## 10. Non-functional requirements

| Area             | Requirement                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile           | Installable web app; designed for 380 px screens first; large tap targets; usable on slow networks                                                 |
| Offline          | Clock-in works offline and syncs later; other actions need a connection                                                                            |
| Performance      | Every screen query under 200 ms at pilot scale; access checks computed once per query, not per row                                                 |
| Security         | Row-level security everywhere; per-service database roles; no public database; TLS only; secrets in parameter store; audit on every business table |
| Tenant isolation | Tested: a user in one customer can never read or act on another customer's data                                                                    |
| Privacy          | Data minimisation (no bank or ID documents in the MVP); clock-in coordinates deleted after 90 days; designed with India's DPDP Act in mind         |
| Data residency   | Hosted on AWS in Mumbai (ap-south-1)                                                                                                               |
| Backups          | Database backup every 6 hours to encrypted storage plus disk snapshots; restore drill documented and run before pilot                              |
| Availability     | Single server for the pilot; health checks and alarms on instance status and disk; managed database and higher availability after pilot            |
| Cost             | Runs within AWS free-plan credits during build and pilot (about $15–16/month); decision on paid plan by 15 Feb 2027                                |
| Change safety    | Forward-only database migrations; every change through CI (lint, types, tests, end-to-end); production deploys need manual approval                |

**System architecture**

&#91;embedded content: system architecture · one server, managed AWS services\]

One EC2 server in Mumbai runs the web app, the background jobs and the database; logins, files and secrets sit in managed AWS services, and releases arrive from GitHub only after a manual approval. Dashed parts are planned.

## 11. Release plan and roadmap

| Stage                       | Scope                                                                                                                                                                                                                                                                                                                                                                                              | Status                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Foundation                  | Security core, workflow engine, mobile app shell, AWS deployment                                                                                                                                                                                                                                                                                                                                   | Done                    |
| Operations modules          | Inventory, orders, transfers; rosters, attendance, leave, swaps, events                                                                                                                                                                                                                                                                                                                            | Done (outlet level)     |
| Structure and access (PR A) | Departments and stores, outlet formats, new access groups, job-role defaults, onboarding loader                                                                                                                                                                                                                                                                                                    | In progress             |
| Approvals and stores (PR B) | Approval chains to the owner, admin guardrails, store-level inventory, department rosters                                                                                                                                                                                                                                                                                                          | Next                    |
| Admin                       | In-app user administration; platform admin console with customer creation and file import                                                                                                                                                                                                                                                                                                          | Next                    |
| Pilot readiness             | Manager dashboard, restore drill, alarms, pilot walkthrough on production; recipes (RCP-1), sales CSV import (SAL-1), bar count mode (INV-7), offline counts (INV-8), PO to supplier (PO-4), variance and valuation reports (RPT-1)                                                                                                                                                                | Next                    |
| Pilot                       | One real outlet, \[2–4\] weeks                                                                                                                                                                                                                                                                                                                                                                     | \[Date\]                |
| AI layer                    | Bill scanning to draft receipts (BILL-1) first; then signals, recommendations, accept-to-approve                                                                                                                                                                                                                                                                                                   | After pilot data exists |
| Later                       | POS integration, web push, payroll export, supplier integrations, structure editing in the app, cross-outlet benchmarking, AI auto-approval within limits; theoretical vs actual variance (VAR-1), Petpooja sales connector, expiry tracking (INV-9), usage-based order quantities (PO-5), excise register (EXC-1), event costing (EV-3), production planning, Tally/Zoho export, menu engineering | Planned                 |

## 12. Competitor analysis: Barometer Technologies

Barometer is the closest Indian competitor on stock control, and it does not touch people operations. It is stronger than Outlet Ops on recipe costing, POS-driven variance, bill scanning and bar-specific counting; Outlet Ops is stronger on rosters, attendance, leave, approvals and access control. Barometer sells software plus human auditors; Outlet Ops sells software with AI and approvals.

**Company snapshot**

| Attribute                 | Barometer                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Legal name, HQ            | Barometer Technologies, Mumbai ([LinkedIn](https://in.linkedin.com/company/barometer-technologies))               |
| Founded, funding          | 2015, bootstrapped ([Inc42](https://inc42.com/company/barometer-technologies/))                                   |
| Team                      | 11–50 employees; founders Ankit Kasera (CEO) and Jay Dalal ([About](https://www.barometertech.com/about))         |
| Scale claimed             | 300+ outlets measured on its own site; Inc42 lists 1,000+ brands (figures conflict)                               |
| Positioning               | Service-first: software plus on-ground physical stock audits by F&B controllers                                   |
| Segments                  | Restaurants, bars, bakeries, cloud kitchens; no hotel-specific features advertised                                |
| Named customers           | Le15 (Pooja Dhingra), The Table (Gauri Devidayal), Masa Bakery, Maska Bakery, Mizu, La Folie, Hundo, Vanilla Miel |
| Headline outcomes claimed | \~6 points off food and pour cost, 90% less stock variance, 100+ hours saved a month                              |

**Products**

| Product                                                                 | What it covers                                       | Notable features                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Baro MATS](https://www.barometertech.com/mats)                         | Kitchen, store and outlet inventory across locations | Par-based auto POs and GRNs, purchase-rate tracking, photo/PDF bill reading into purchase entries, requisitions and indents with sent-vs-received reconciliation, stock-take with expected vs actual, voice-driven stock-take and POs, recipe and sub-recipe costing, central-kitchen production planning, wastage with photos and expiry alerts, AI insights |
| [Barometer Bar](https://www.barometertech.com/bar)                      | Liquor inventory (Android app + web portal)          | Tap-and-slide bottle-level counts, split counts across devices, offline counts synced with original time, pour costing per serve, suggested purchase ranked by consumption and emailed to vendor, 13 reports incl. Excise Book, Dead Stock, Menu Engineering, Party/Event costing, scheduled email reports                                                    |
| [Order management](https://www.barometertech.com/mats/order-management) | B2B/D2C orders for bakeries and kitchens             | Orders from Shopify, WooCommerce, Petpooja, Urban Piper; phone and WhatsApp orders, repeat-order cloning, Razorpay links, scan-to-dispatch rack management                                                                                                                                                                                                    |
| Service layer                                                           | Human F&B controllers                                | Setup, training, data audits and corrections, weekly to 6×/week follow-ups, physical inventory audits, purchase and sales input, monthly consultation                                                                                                                                                                                                         |
| [Integrations](https://www.barometertech.com/mats/integrations)         | Connected tools                                      | Petpooja (nightly sales), Urban Piper, Shopify, custom API, Excel uploads; Zoho Books, Tally; WhatsApp/email PO push; eShipz                                                                                                                                                                                                                                  |

**Pricing** (as published on [barometertech.com/pricing](https://www.barometertech.com/pricing); all prices exclude 18% GST)

| Plan                         | Unit        | Starting price | Includes                                                              |
| ---------------------------- | ----------- | -------------- | --------------------------------------------------------------------- |
| MATS Essential               | Cost centre | ₹2,500/month   | Software only, 3 users, WhatsApp support, setup and training          |
| MATS Advanced                | Cost centre | Quote          | 4 users, account manager, phone support, data audits                  |
| MATS Ultimate (most popular) | Cost centre | Quote          | 5 users, monthly consultation, custom monthly reports                 |
| Bar Lite                     | Licence     | ₹5,000/month   | Software only, assisted setup, online training                        |
| Bar Plus (most popular)      | Licence     | Quote          | Dedicated F&B controller, weekly audits and reporting                 |
| Bar Managed                  | Licence     | Quote          | Physical inventory audit, purchase and sales input, 6×/week reporting |

A one-time setup fee is quoted by organisation size. There is no lock-in and billing usually starts quarterly. Integrations, extra users, recipe input and auditor visits are paid add-ons. A multi-outlet restaurant with a bar therefore pays roughly ₹7,500/month per outlet before service and add-ons.

**Capability comparison**

| Capability                                                 | Barometer                                                    | Outlet Ops today                                 | Gap for Outlet Ops      |
| ---------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ | ----------------------- |
| Append-only stock ledger, counts with tolerance approval   | Stock-take with variance; approval flow not advertised       | Built                                            | Ahead                   |
| Theoretical vs actual consumption (recipes × sales)        | Yes, from POS sales                                          | No; POS is a non-goal                            | Critical                |
| Recipe and sub-recipe costing, cost per portion, pour cost | Yes                                                          | No                                               | Critical                |
| Bottle-level bar counting, split across devices            | Yes                                                          | Generic unit counts                              | High                    |
| Offline stock counts                                       | Yes                                                          | Clock-in only                                    | High                    |
| Photo/PDF purchase bill reading                            | Yes                                                          | No                                               | High                    |
| POs from par levels                                        | Yes, ranked by consumption, sent to vendor by email/WhatsApp | Built (par − on hand − open orders), in-app only | Medium                  |
| Receiving against PO, transfer reconciliation              | Yes                                                          | Built, with over-receipt cap and transit loss    | Parity                  |
| Central-kitchen production planning                        | Yes                                                          | No                                               | Medium (chains only)    |
| Wastage with photo and approval                            | Photo, expiry alerts, cost alerts                            | Photo, value threshold, approval                 | Missing expiry tracking |
| Excise register for liquor                                 | Yes (Excise Book)                                            | No                                               | High for bars           |
| Reports and scheduled emails                               | 13 bar reports, 6 MATS dashboards                            | Dashboard planned                                | High                    |
| Accounting export (Tally, Zoho)                            | Yes                                                          | No                                               | Medium                  |
| Voice stock-take                                           | Yes                                                          | No                                               | Low                     |
| Multi-channel order management, rack dispatch              | Yes                                                          | Out of scope                                     | Not pursued             |
| Rosters, attendance with geofence, leave, swaps            | No                                                           | Built                                            | Ahead                   |
| Events with staffing and stock needs                       | Event costing report only                                    | Built                                            | Ahead                   |
| Role-at-place access, approval chains, full audit          | Not advertised                                               | Core design                                      | Ahead                   |
| Hotel departments and stores (housekeeping, banquets)      | Not advertised                                               | Built into structure model                       | Ahead                   |
| AI                                                         | AI insights checked by a human analyst                       | Planned: AI proposes, manager approves           | Different model         |
| Human audit service                                        | Core of the offer                                            | None                                             | Business choice         |

**What this means for Outlet Ops**

- Win where Barometer is absent: hotels with many departments, and any customer that wants stock and staff in one app with approvals.
- Close the cost-control gap before selling to bars and restaurants: without recipes and sales-based variance, a bar owner comparing the two sees Outlet Ops as a stock register.
- Price against the anchor: Barometer's software-only floor is ₹2,500 per kitchen cost centre and ₹5,000 per bar licence a month, so a bundled outlet price that also replaces a rostering tool can sit at or above ₹7,500.
- Offer an optional assisted-onboarding and monthly audit add-on rather than building a large service team; Barometer shows Indian operators pay for hand-holding.

Sources opened 30 Sep 2026: [pricing](https://www.barometertech.com/pricing), [MATS](https://www.barometertech.com/mats), [Bar](https://www.barometertech.com/bar), [AI analytics](https://www.barometertech.com/mats/ai-analytics), [order management](https://www.barometertech.com/mats/order-management), [integrations](https://www.barometertech.com/mats/integrations), [about](https://www.barometertech.com/about), [Inc42 profile](https://inc42.com/company/barometer-technologies/), [LinkedIn](https://in.linkedin.com/company/barometer-technologies).

## 13. Feature updates from the competitor analysis

Twelve changes follow from section 12: seven additions, four changes to existing requirements and one replacement. Together they turn inventory from a stock register into a cost-control module, which is what bar and restaurant buyers compare against Barometer. Rosters, attendance, approvals and the AI principle stay as they are; they are where Outlet Ops already leads.

**Changes to the feature list**

| ID     | Feature                                                                                                                                                                | Type    | Replaces or changes                                                                            | Why (from section 12)                                                             | Stage                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| RCP-1  | Recipes and sub-recipes: ingredients with quantity, yield and unit; cost per portion or per serve from weighted average cost; bar pour-cost %                          | Add     | New module 6.9                                                                                 | Barometer's core margin feature; buyers ask "what does this dish cost" first      | Next, before pilot                                      |
| SAL-1  | Sales import: daily item sales by outlet from CSV/Excel upload, then a Petpooja connector (read-only)                                                                  | Change  | Non-goal "POS integration comes later" becomes: no POS operation, but sales import is in scope | Needed for any sales-based variance; Barometer ingests Petpooja nightly           | CSV Next; Petpooja after pilot                          |
| VAR-1  | Theoretical vs actual consumption: recipes × sales against counted usage, per item and store, gap shown in ₹                                                           | Add     | Extends INV-5 variance, which today compares only to system quantity                           | The number bar owners buy Barometer for                                           | After RCP-1 and SAL-1                                   |
| INV-7  | Bar count mode: shelf-ordered count sheets, partial bottles as fill level or ml, one count split across several devices                                                | Change  | INV-5 counts gain partial units and multi-device counts                                        | Barometer's 30-minute stock-take claim                                            | Next                                                    |
| INV-8  | Offline stock counts and wastage: saved on the device, synced with the original time                                                                                   | Change  | Offline NFR extended beyond clock-in                                                           | Cellars and cold rooms have no signal                                             | Next                                                    |
| INV-9  | Batches and expiry dates for perishable items; expiry alerts; first-expiry-first-out prompts                                                                           | Add     | Uses INV-1 perishable flag                                                                     | Barometer alerts before expiry; wastage is otherwise found too late               | After pilot                                             |
| PO-4   | Send approved POs to the supplier by email or WhatsApp; supplier contact on the item and supplier records                                                              | Add     | Extends PO-2                                                                                   | Barometer sends orders straight to vendors                                        | Next                                                    |
| PO-5   | Suggested order quantity from average daily usage × (lead time + review days) + safety stock − on hand − open orders; par is the fallback until 14 days of usage exist | Replace | Replaces PO-1 formula (par − on hand − open orders)                                            | Barometer ranks by real consumption, not a flat threshold                         | After pilot                                             |
| BILL-1 | Photograph or upload a supplier bill; AI extracts supplier, items, quantities, rates and taxes into a draft receipt matched to the PO, which a person confirms         | Add     | First AI use case; follows the AI principle (proposes, person confirms)                        | Barometer cuts bill entry from minutes to under a minute                          | With AI layer, moved first                              |
| EXC-1  | Excise register for liquor: daily opening, receipts by transport permit, sales, closing per brand and bottle size, exported in the state's format                      | Add     | New requirement under 6.1                                                                      | Only Barometer offers it; a buying reason for Indian bars                         | After pilot, Maharashtra first                          |
| RPT-1  | Reports pack: variance, valuation, consumption, dead stock, purchase-rate change, wastage; scheduled email or WhatsApp delivery                                        | Change  | DB-1 dashboard gains a report set                                                              | Barometer ships 13 bar reports                                                    | Pilot readiness (variance, valuation); rest after pilot |
| EV-3   | Event costing: event requirements priced from recipes and item costs; actual vs planned after the event                                                                | Add     | Extends EV-1                                                                                   | Barometer's party/event costing; our events module already holds the requirements | After RCP-1                                             |

**Later, not now**

- Central-kitchen production planning (production orders from transfer requests, raw items to sub-recipes): only chains with a central kitchen need it.
- Tally and Zoho Books purchase export: fits the planned payroll export work.
- Menu engineering (margin × popularity per dish): needs 60+ days of sales.
- Voice stock-take: low demand; revisit after bar count mode is measured.

**Deliberately not built**

- Multi-channel order management and rack dispatch: this serves bakeries selling online, outside our customers.
- A human audit team: instead, an optional paid onboarding and monthly review add-on delivered by the Outlet Ops team (section 12).

**Roadmap effect:** RCP-1, SAL-1 (CSV), INV-7, INV-8, PO-4 and the variance and valuation reports join Pilot readiness. BILL-1 becomes the first AI-layer feature. The rest joins the Later stage in section 11.

## 14. Infrastructure cost to serve a customer

Infrastructure costs between about ₹220 and ₹4,700 a month per customer once the platform is shared by enough customers, or roughly ₹7–15 per user a month. That is 2–10% of Barometer's software-only price for the same outlets, so infrastructure sets a floor, not the price; pricing should follow value and the competitor anchor in section 12. Figures assume AWS Mumbai (ap-south-1) on-demand rates, ₹88 to the US dollar, and the feature set after section 13, including AI bill scanning and WhatsApp messages.

**Unit costs used** (USD unless stated; approximate where marked)

| Item                                          | Rate                                                                                              | Source                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| EC2 t4g.small / t4g.medium (2 vCPU, 2 / 4 GB) | $0.0112 / $0.0224 per hour (≈ $8.18 / $16.35 a month)                                             | [cloudprice t4g.small](https://cloudprice.net/aws/ec2/instances/t4g.small), [aws-pricing t4g.medium](https://aws-pricing.com/t4g.medium.html)         |
| RDS PostgreSQL db.t4g.micro, Single-AZ        | $0.021 per hour (≈ $15.33 a month); Multi-AZ doubles it                                           | [bminfotrade, from AWS price list, Aug 2026](https://bminfotrade.com/blog/cloud-computing/aws-rds-pricing-2026-mysql-postgresql-and-sql-server-costs) |
| RDS db.t4g.small / medium, Single-AZ          | ≈ $0.042 / $0.084 per hour (approximate, scaled from micro)                                       | Estimate                                                                                                                                              |
| EBS gp3 storage                               | $0.0912 per GB-month                                                                              | [aws-pricing ap-south-1](https://aws-pricing.com/ap-south-1.html)                                                                                     |
| S3 Standard storage                           | $0.025 per GB-month                                                                               | [itforsme S3 India](https://www.itforsme.in/pricing/aws-s3-india)                                                                                     |
| Data out to internet                          | First 100 GB a month free, then $0.1093 per GB                                                    | [itforsme S3 India](https://www.itforsme.in/pricing/aws-s3-india)                                                                                     |
| Cognito user logins                           | 10,000 monthly active users free per account; then $0.0055 (Lite) or $0.015 (Essentials) per user | [AWS Cognito pricing](https://aws.amazon.com/cognito/pricing/)                                                                                        |
| Claude Haiku 4.5                              | $1 input / $5 output per million tokens; Batch API halves both                                    | [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)                                                                            |
| Claude Sonnet 5.5                             | $2 input / $10 output per million tokens                                                          | [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)                                                                            |
| WhatsApp utility message (India)              | ₹0.115 per message + 18% GST (Meta rate; resellers add ₹0.03–0.30)                                | [MyOperator](https://myoperator.com/blog/whatsapp-business-api-pricing-india-2026), [AiSensy](https://aisensy.com/pricing)                            |
| Email one-time codes (SES)                    | ≈ $0.10 per 1,000 emails (approximate)                                                            | Estimate                                                                                                                                              |

**Shared platform stacks**

| Stack                | When                                        | Components                                                                                                                | Monthly cost                              |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Pilot (today)        | Build and pilot                             | One EC2 server running app, jobs and database; free-plan credits                                                          | ≈ $15–16 (₹1,400), covered by credits     |
| Launch               | First paying customers, up to ≈ 2,000 users | EC2 t4g.medium app; RDS db.t4g.small Single-AZ, 50 GB; 30 GB EBS; S3 backups; public IP; CloudWatch alarms                | ≈ $68 (₹6,000)                            |
| Growth               | ≈ 2,000–10,000 users                        | 2× EC2 t4g.medium behind a load balancer; RDS db.t4g.medium Multi-AZ, 200 GB; 500 GB S3; ≈ 400 GB paid egress; monitoring | ≈ $310 (₹27,300)                          |
| Dedicated (optional) | A group that insists on its own stack       | EC2 t4g.small, RDS db.t4g.micro, backups, IP, alarms                                                                      | ≈ $35 (₹3,100) plus the usage costs below |

**Cost drivers per customer** (Growth stack, fully used)

| Driver                                                                                       | Scales with      | Cost a month                              |
| -------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------- |
| Compute and database share                                                                   | Users            | $0.031 (≈ ₹2.7) per user                  |
| Tenant overhead (backups, logs, setup files)                                                 | Customer         | $0.50 (≈ ₹44)                             |
| AI bill scanning (BILL-1): ≈ 60 bills per store, ≈ 3,000 tokens in and 500 out on Sonnet 5.5 | Stores           | ≈ $0.60 (≈ ₹53) per store                 |
| AI recommendations: ≈ 150 per outlet, nightly batch on Haiku 4.5                             | Outlets          | ≈ $0.45 (≈ ₹40) per outlet                |
| WhatsApp: 40 supplier orders per store, 15 staff alerts per user                             | Stores and users | ≈ ₹5.4 per store + ₹2 per user            |
| Photos (wastage, bills)                                                                      | Outlets          | ≈ $0.05 per outlet, growing ≈ 1 GB a year |
| Logins and email codes                                                                       | Users            | Nil below 10,000 active users in total    |

**Cost to serve by customer type**

| Customer type                                  | Users | Outlets | Stores | Platform (₹) | AI (₹) | Messaging (₹) | Total ₹ / month | ₹ per outlet | ₹ per user |
| ---------------------------------------------- | ----- | ------- | ------ | ------------ | ------ | ------------- | --------------- | ------------ | ---------- |
| Small hotel or guest house                     | 15    | 1       | 1      | 84           | 92     | 36            | ≈ 220           | 220          | 14.5       |
| Standalone bar (bar + kitchen)                 | 30    | 1       | 2      | 126          | 145    | 73            | ≈ 350           | 350          | 11.6       |
| Full hotel, one property                       | 150   | 1       | 4      | 453          | 251    | 333           | ≈ 1,040         | 1,040        | 6.9        |
| Restaurant chain: 5 outlets + central kitchen  | 180   | 6       | 11     | 535          | 818    | 432           | ≈ 1,810         | 300          | 10.1       |
| Hotel + 3 restaurants or bars                  | 250   | 4       | 8      | 726          | 581    | 561           | ≈ 1,890         | 470          | 7.5        |
| Hotel group: 3 hotels, central kitchen, 2 bars | 700   | 6       | 17     | 1,954        | 1,135  | 1,542         | ≈ 4,660         | 780          | 6.7        |

Photos add under ₹30 a month in every row and are included in the totals. Other combinations follow the same drivers: add ≈ ₹2.7 per user for platform, ≈ ₹53 per store and ≈ ₹40 per outlet for AI, and ≈ ₹5.4 per store plus ≈ ₹2 per user for WhatsApp.

**Early-stage effect.** Before the platform is shared widely, the fixed stack dominates: the Launch stack's ₹6,000 spread over 5 customers adds ≈ ₹1,200 per customer, and over 25 customers ≈ ₹240. Price on steady-state cost, and treat the gap as launch investment.

**What this means for pricing**

- Infrastructure floor at an 80% gross margin on infra alone is ≈ 5× the totals above: ≈ ₹1,100 for a small hotel, ≈ ₹1,750 for a bar, ≈ ₹5,200 for a full hotel.
- Price per outlet with a user band, and meter the two usage costs that grow without limit: AI bill scans (fair use of e.g. 150 per store a month) and WhatsApp alerts (in-app and web push stay free).
- A dedicated stack is an enterprise add-on at ≥ ₹3,100 a month of cost before usage.
- Onboarding, support and data audits will cost more per customer than infrastructure; they need their own estimate before the price is set (open question 1).

## 15. Open questions, risks and glossary

**Open questions**

1. Pricing: per outlet per month, onboarding fee, AI add-on — \[to decide\].
2. Pilot outlet and start date — \[to decide\].
3. Product name: "Outlet Ops" is the working name.
4. AI provider: Anthropic API vs Amazon Bedrock, decided when the AI layer is built.
5. When to move from the AWS free plan to paid (and to a managed database) — by 15 Feb 2027 at the latest.
6. Weekly-off-aware leave counting (currently calendar days) — Phase 2.

**Risks**

| Risk                                      | Mitigation                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| Frontline adoption is low                 | Pilot with in-person onboarding; mobile-first design; offline clock-in |
| Staff without email can't log in          | Username and password login, reset by user admins                      |
| Scope growth delays the pilot             | Two-PR split, cut order agreed per prompt, AI deliberately last        |
| Single server outage during pilot         | Backups every 6 h, restore drill, alarms; managed database after pilot |
| Free-plan account closes when credits end | Budget alerts; dated upgrade decision                                  |
| Misconfigured access at onboarding        | Dry-run report, access preview, approval coverage check before load    |

**Glossary**

| Term              | Meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| Tenant / customer | One company using Outlet Ops, fully isolated from others              |
| Org tree          | The people structure: company, region, area, outlet, department       |
| Supply tree       | The stock structure: network, central kitchen, supply point, stores   |
| Access group      | A product-defined set of permissions, granted at a place              |
| Job role          | A customer's job title and the access groups it gets by default       |
| Outlet format     | full\_hotel, small\_hotel or standalone\_bar; tunes job-role defaults |
| Workflow request  | A change that needs approval before the system applies it             |
| Ledger            | The append-only record of every stock movement                        |
