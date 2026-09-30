# 009 — Flexible structure, product access groups and customer onboarding

Status: accepted (part 1 of 2) · 2026-10-01

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
