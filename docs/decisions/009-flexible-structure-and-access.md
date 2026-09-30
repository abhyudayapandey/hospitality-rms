# 009 — Flexible structure, product access groups and customer onboarding

Status: accepted · part 1 2026-10-01 · part 2 2026-10-02

This ADR records how the structure and access model was made to fit any customer shape,
using the two test customers in `docs/onboarding/test-data` as the spec. Part 1 (this PR)
covers structure, access groups, job-role access, the onboarding loader, derived stock
and the test-data seed. Part 2 adds approval chains, guardrails, store-level transfers
and department-level people.

- **Migrations** (forward-only, on top of the deployed schema):
  - `20261001100000_flexible_structure`: codes, departments, stores, `outlet_format`,
    `holds_stock`, `is_main_store`
  - `20261001110000_walk_up_lookups`: geofence, wastage threshold, transfer sources
  - `20261001120000_access_groups`: admin domains and groups, CHEF retired, directory
  - `20261001130000_job_role_access`: job-role defaults and their derivation
  - `20261001140000_onboarding_columns`: supplier codes, item cost, tolerance %
  - `20261001150000_derived_descendants`: link anchors for derived and admin scope
  - `20261001160000_user_for_username`: dev login by customer and username
  - `20261001170000_audit_tenant_scope`: audit rows are per customer
- **Code:** `packages/domain/src/access.ts`, `packages/workflow/src/bp-policy.ts`,
  `packages/onboarding` (new).
- **Deploy:** app deploy only (the Deploy workflow). No CDK change, no new AWS resource.

## Structure: no level is assumed

- **Optional levels.**
  - Departments may sit under an outlet or a site; stores under a supply point or a hub.
    A trigger rejects any other parent (`INVALID_PARENT`).
  - Nothing else requires a level. Region and area are optional (the solo bar has
    neither), and so are departments (the Guest House has none).
- **Codes.** Every place from the files has a code, unique per customer. Loads,
  tests and e2e address places by code.
- **Stock locations.** `holds_stock` says where stock is counted: a store, or a supply
  point that has no stores.
  - Every stock table rejects any other node (`NOT_A_STOCK_LOCATION`).
  - `is_main_store` marks at most one store per supply point.
- **Walking up.** Settings are found from the nearest place that has them:
  - the geofence of a department worker is the outlet's;
  - a store without its own wastage threshold uses its supply point's.
- **Transfer sources** are the stock places that stock the item:
  - the location's other stores come first, then hubs;
  - a sibling outlet is never preferred.

## Access groups are product code

- **Where they live.** Groups, domains, the domain matrix and bp_policy are defined once
  in code (`access.ts`, `bp-policy.ts`).
- **How they reach tenants.** `syncProductAccess` writes them into every tenant and is
  authoritative: rows not in the code are removed.
  - It runs from `sync-defs`, on every `db:seed` and every deploy.
  - A test proves every tenant holds exactly the code's matrix, and that the code matches
    `PRODUCT_access_groups_REFERENCE.csv`.
- **Admin is not data.** Admin groups (`USER_ADMIN`, `ACCOUNT_OWNER`) may only hold
  admin domains: `USER_ACCESS`, `COMPANY_SETTINGS`, `SECURITY_ROLES`, `WF_CONFIG`.
  A trigger enforces it (`ADMIN_NOT_DATA`).
- **USER_ACCESS** gives a minimal directory and the structure tree within its scope:
  - the directory holds name, username, job role, home place and status;
  - it shows no worker detail, pay, roster or stock.
- **CHEF is retired.** Its assignments moved to `STOCK_USER`.
- **Receiving.** A stock user may receive goods against a released PO (PO view plus
  adjustments modify). Creating a PO still needs `PURCHASE_ORDERS` modify.
- **ROLE_CHANGE** is user administration: its subject sits under `USER_ACCESS`, and only
  User Admins and Account Owners start one.
- **The Admin screen** follows `SECURITY_ROLES`. That domain now belongs to the Account
  Owner, the Security Admin and the Auditor; HR Admin no longer has it.

## Job roles derive access

- **What a job role holds.** Each job role lists `GROUP@scope` defaults
  (`hr.job_role_access`). A customer may override them per `outlet_format`: a Bar
  Manager in a standalone bar runs the outlet.
- **Resolution.** `core.derive_job_role_access` resolves the scope words from the
  person's home place by walking the tree (`docs/onboarding/test-data/README.md`).
  - `department_store` falls back to the outlet's stock location, recorded in the
    source note.
  - `main_store` falls back only when the supply point holds stock; otherwise it reports
    `MAIN_STORE_REQUIRED`.
  - There is no code-suffix convention for main stores: it is the `is_main_store` flag.
- **Errors.** Unresolvable scopes come back as rows, so a dry run lists them all.
- **Applying.** `core.apply_job_role_access` keeps a person's `source = 'job_role'`
  assignments equal to the derivation.
  - Extra (file 08) and manual assignments are left alone.
  - Access starts at the person's `joined_on`.
- **Proof.** Both customers' loaded access equals their `99_access_preview_GENERATED.csv`
  row for row.

## The onboarding loader

- **Input.** `@outlet-ops/onboarding` takes a customer's files as a name→content map, so
  the Platform Admin console can pass uploads straight in.
- **Parsing.** It uses its own small RFC 4180 reader (no new dependency) and one zod
  schema per file. Every problem is reported by file, row and column, both bad cells and
  broken references across files.
- **Apply.** It writes everything in one transaction, as upserts on codes and usernames.
  - An unchanged row is not touched, so a second load reports no changes.
  - A dry run does the same work and rolls back.
  - The report carries per-entity counts and the resulting access in the file 99 layout.
- **What it also sets up.** Each customer gets the product access and process
  definitions, and an AI agent service user (view access at both roots).
- **Removals.** Extra access removed from file 08 is deleted, and job-role defaults are
  replaced per role. The audit log keeps the history.
- **CLI.** `pnpm --filter @outlet-ops/onboarding load <folder> [--apply]` runs it until
  the console exists.

## Derived stock and admin scope follow the link down

- **Link anchors.** A delivery node belongs to its _link anchor_: the nearest node at or
  above it with a `node_link`. `DERIVED_*` grants and `USER_ACCESS` on the delivery tree
  reach every node whose anchor is linked to an org node in scope.
  - A hotel's link covers its stores.
  - A store linked to a department stays with that department: the Bar Manager 1.0 does
    not see the Kitchen Store.
  - A hub's link never pulls in the outlets it supplies (the central kitchen).
- **Cost.** `core.can` now walks to the anchor. The ADR 007 benchmark on the test data
  stays under 200 ms; its worst case is the area manager, at about 150 ms.

## Test data replaces the demo seed

- **Seed.** `pnpm db:seed` loads both test customers with the loader, then
  `seed/dev/001_workforce_dev.sql` adds the activity the files do not carry: this week's
  and next week's shifts from the templates, punches and pay rates.
- **Tests.** DB tests and e2e use test usernames and place codes.
  - The RLS equivalence test checks one holder of every distinct grant shape rather
    than all hundred-odd people.
  - The dev login lists test users by customer and username
    (`core.user_for_username`).
- **Audit is per customer.** A second real tenant exposed a leak: audit rows without a
  `tenant_id` (tenant records, platform configuration) were visible to every tenant's
  auditors.
  - Tenant rows now carry their own id.
  - Rows without a tenant are shown to no tenant.

# Part 2: approval chains, admin guardrails, store transfers, department people

- **Migrations** (forward-only, on top of part 1):
  - `20261002100000_approval_chains`: chains, customer settings, coverage, pending-inbox
    visibility, decision summaries
  - `20261002110000_admin_guardrails`: user administration functions and guardrails
  - `20261002120000_store_transfers`: store-level transfers run by each location
  - `20261002130000_department_people`: roster owner, exceptions per department
- **Code:** `packages/workflow/src/processes.ts` (chains), `packages/onboarding`
  (coverage check, `leave_hr_approval`), the transfer and exceptions screens.
- **Deploy:** app deploy only (the Deploy workflow runs the migrations and syncs the
  definitions). No CDK change.

## Approval chains end with the account owner

- **Chain.** A step is routed, in order, to: its group at the subject (or nearest
  holder); its `escalateTo` group; the same group strictly above; each `fallback` group,
  nearest holder first; then `ACCOUNT_OWNER`, the final approver of every step of every
  process. The first three are the existing rules, so nothing already routed moves.
- **SLA escalation** moves an overdue step to the next group of the same chain.
- **Leave and swaps** go to the person's `DEPARTMENT_HEAD`, falling back to the outlet
  manager and the area manager. The leave HR step (`OUTLET_HR`, falling back to
  `HR_ADMIN`) is a customer setting, `leave_hr_approval` in file 00, on unless turned
  off; when the same person already approved the first step it is skipped
  (`same_approver`).
- **ROLE_CHANGE** is requested only by `USER_ADMIN` and `ACCOUNT_OWNER`, and approved
  by `SECURITY_ADMIN`, falling back to the owner.
- **Coverage.** `wf.approval_coverage(tenant)` lists every process, step and place
  nobody could approve. The loader runs it after access and rejects the customer, one
  issue per case (`NO_APPROVER`), so a structure with a gap never loads.
- **Pending-inbox visibility.** Whoever may act on a request's pending step reads its
  subject row, however they were routed (an account owner holds no leave rights), and
  never once the step has moved on. When they act, a decision summary (label, person,
  amount, items or dates) is kept on the step and stays readable to them
  (`wf.request_summary`, `wf.my_decisions`); the row itself is hidden again.

## User administration guardrails

`core.grant_access`, `revoke_access`, `create_user` and `set_user_status` are the only
way the app changes access; each checks, in SQL:

- **(a) Admin rights are not data access.** Admin groups can never carry data policies
  (trigger), so a User Admin grants stock access they cannot use.
- **(b) Scope and rank.** The place must be inside the admin's `USER_ACCESS` scope
  (including linked delivery places) and the person's home too (`NOT_AUTHORISED`);
  nobody grants to or changes themselves (`SELF_GRANT`); a User Admin never grants
  `ACCOUNT_OWNER` nor modifies or deactivates an owner or anyone of higher admin rank
  (`ABOVE_OWN_RANK`). "Beyond what the granter holds" applies to admin rank, not data
  groups: an admin grants any everyday group within scope.
- **(c) Sensitive grants need approval.** `OUTLET_MANAGER`, `USER_ADMIN`,
  `ACCOUNT_OWNER`, `HR_ADMIN`, `OUTLET_HR` and any group with `COMPENSATION` access (not
  `SELF`, which is one's own pay) become a ROLE_CHANGE request; everyday grants apply at
  once. A new person's everyday job-role defaults apply at once, sensitive ones as
  requests. Granting a User Admin within one's own scope is such a request.
  - **Sole owner.** When the granter is the customer's only account owner and nobody
    else could approve, the grant applies directly with the note "sole account owner: no
    one else can approve" (rule 7 would otherwise leave it pending forever).
- **(d) The last account owner stays.** A trigger on assignments and user status raises
  `LAST_ACCOUNT_OWNER` for any change that would leave a customer without an active
  owner, whoever makes it.
- **(e) Audit.** Every admin action is an audited row. `core.access_audit` shows grants,
  removals, users created and deactivated, role changes and their approvals, to account
  owners (company) and User Admins (their scope), and never business-data audit rows.

## Store-level transfers

- **Where from.** A store requests from another store of its own outlet (Main Store →
  Kitchen Store) or from a hub (central kitchen); never from another outlet
  (`INVALID_SUBJECT`). Counts, wastage, purchase orders and par levels were already per
  store (part 1).
- **Who sends and receives.** The dispatch step goes to whoever runs the sending
  location, the receipt step to whoever runs the receiving one: its `STORE_KEEPER`,
  else `HUB_MANAGER`, else `OUTLET_MANAGER`, else the account owner.
- **Within the site.** A hub sits above the outlets it supplies in the delivery tree, and
  its store keeper's grant covers them, so an unbounded walk up would hand an outlet's
  receipt to the central kitchen. For transfer steps the walk stops at the location's
  own outlet or hub (`core.stock_site`), then crosses to the org tree as before; the
  same bound decides who may act.
- **By step, not by rights.** Dispatch and receipt authorise by the step
  (`inv.require_step`), so a fallback approver without `TRANSFERS` rights can act; the
  screen offers the step the user may act on and its lines. Rule 7 still holds: a store
  keeper who asked for a transfer does not receive it; the next in the chain does.

## People at department level

- **Rosters.** Templates, shifts and publishing already worked at any org node; a
  department head builds their department (ROSTER modify there), and a department
  without a head is built by the outlet manager, whose grant covers it. A shift may
  take a worker whose home is the shift's place or below it.
- **Roster owner.** `hr.roster_owner` names who runs a place's roster: the department
  head, then the outlet manager, area manager and account owner, leaving out the person
  it is about. The roster-gap notice after approved leave goes to them.
- **Exceptions.** `hr.exception_queue` lists a place and every department below it,
  grouped by department, each with whom it waits for (the roster owner, never the
  worker). The assignee may resolve it even without `ATTENDANCE` rights there.

## Known edges

- A sole account owner's own leave has no approver: rule 7 excludes them and nobody is
  above. Coverage does not flag it (it checks places, not people); such a customer should
  add a second owner or an HR admin before relying on leave for the owner.
- The RLS equivalence test samples one holder per grant shape in CI. The manual
  workflow "RLS equivalence (all users)" checks every user of both test customers (about
  14 minutes locally); run it before the pilot and whenever access rules change.
