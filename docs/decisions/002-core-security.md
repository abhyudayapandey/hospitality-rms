# 002 — Core hierarchy, `core.can()`, generated RLS and audit

Status: accepted · 2026-09-29

This ADR records how LLD sections 2 (`core` and `audit` only) and 3 were
implemented on AWS, and every decision the LLD leaves open.

Migrations:

- `20260929100000_core_schema.sql`
- `20260929100100_audit.sql`
- `20260929100200_core_security.sql`

Seed: `packages/db/seed/001_core.sql`.

## Changes from the LLD

These are flagged because the LLD and CLAUDE.md differ.

- **No `auth.uid()`.** `core.can()` and the audit trigger use `core.current_user_id()`
  (CLAUDE.md, AWS overrides).
- **No `auth.users`.** `core.app_user` owns its own `id` and has a nullable, unique
  `cognito_sub` to map the Cognito identity once auth lands.
- **No `service_role`.** Migrations run as `migrator`. The executor path is the
  `wf_executor` role.
- **CLAUDE.md rule 6 is updated.** The AI agent has view-only domain access, except modify
  on `AI_RECOMMENDATIONS`. Its only writes are inserting `ai.recommendation` rows and
  `wf.submit`. Generated policies would also let it UPDATE `ai.recommendation`. When that
  table lands, recommendation state changes must go through `ai.respond` / the workflow,
  for example by giving the table a `wf_request_id` column, which removes the app_rw
  UPDATE policy.

## Hierarchies

- **Org tree:** Company → Region → Area → Outlet A, Outlet B; plus Region → Hub
  (`kind = site`), the org-side home of the hub's people.
- **Delivery tree:** Company Supply Network (`kind = network`, the delivery root) → Hub →
  Outlet A, Outlet B.
- **`node_link`** joins each org outlet to its delivery outlet, and the org Hub site to the
  delivery Hub. A trigger enforces one org
  node and one delivery node per link.
- **`path`** is maintained by a trigger. Each node's label is `n` plus its id without
  dashes, so paths are unique and stable across renames.
- **Re-parenting** a node rewrites the paths of its whole subtree.
- **Invalid parents** raise `INVALID_PARENT`: a parent in the other tree, or one inside the
  node's own subtree (a cycle).
- **IDs** are uuid v7 from `core.uuid_v7()`. PG16 has no built-in; PG18's `uuidv7()` can
  replace it.
- **Codes are unique per tenant:** `security_group` and `domain` have
  `unique (tenant_id, code)`. `core.can()` resolves domain and group codes in the current
  user's tenant, and the seed scopes every code lookup by `tenant_id`.
- **Standard columns** (`tenant_id`, `created_*`, `updated_*`) and the `touch` trigger are
  added to every core table by `core.add_standard_columns()`.

## Access model

### `core.role_assignment.include_descendants`

A boolean, default `true`.

- `true`: the assignment applies at its node and everything below it (LLD behaviour).
- `false`: it applies at its node only.

`core.effective_access` carries the flag. `core.can()` respects it for hierarchy grants
(rule 1) and derived grants (rule 3).

`core.effective_access` is a plain view, as the LLD allows for week 1. It includes only:

- active users,
- non-archived nodes,
- assignments valid today (`effective_from <= today <= effective_to`).

Inactive users are also denied self-service.

### `core.can()` rules

1. **Hierarchy grant:** an assignment at the row's node, or above it when the assignment
   includes descendants.
2. **Self-service:** the `SELF` group's policy applies to rows the active user owns.
3. **Derived view:** `DERIVED_<domain>` on an org node linked through `node_link` to the
   row's delivery node. View only.

Other properties:

- **Defaults to deny:** no user set, unknown domain or no node all return false.
- **Security definer:** it runs as `security definer` with
  `search_path = pg_catalog, core, extensions`. `public` is excluded, and every relation it
  reads is schema-qualified, so neither a lookalike operator in `public` nor a temp table
  can change its answer. A coverage test requires a pinned `search_path` without `public`
  on every security definer function in the core and business schemas.

### Extensions schema

ltree lives in schema `extensions`, not `public`, and `app_rw` and `wf_executor` have
USAGE on it.

- **Where it's created:** `docker/init` and the baseline migration both create ltree
  there, so a fresh database, including RDS, never has it in `public`.
- **Older databases:** `20260929050000_extensions_schema` moves ltree when it can. If it
  can't, it fails with `LTREE_WRONG_SCHEMA` and the superuser command to run. The member
  objects of a trusted extension are owned by the bootstrap superuser, so `migrator`
  usually can't move them itself.
- **Column type:** the `core.hierarchy_node.path` column is typed `extensions.ltree`.
- **Functions:** functions that use ltree pin
  `search_path = pg_catalog, core, extensions`.
- **Ad-hoc SQL:** ltree operators are not on the default `search_path`. Qualify them or
  set `search_path` for the session.

### Derived views and approval routing

The derived domains are `DERIVED_STOCK_LEVELS`, `DERIVED_PURCHASE_ORDERS` and
`DERIVED_TRANSFERS`. All are `hierarchy_type = org`, view only, granted to `AREA_MANAGER`,
and evaluated through `node_link` like `DERIVED_STOCK_LEVELS`.

**Note for the workflow engine (Prompt 2):** routing must resolve `AREA_MANAGER` approvers
across trees via `node_link`. Example: the PO area-approval step (`nearest_ancestor` in
the delivery tree) must map the PO's delivery outlet to its org outlet, then walk the org
tree to find the area manager. Walking the delivery tree alone never reaches an org-tree
assignment.

### Groups and assignments (seed)

Every outlet worker holds `STAFF` at their org outlet. Other roles are additional
assignments.

| User                  | Assignments                                                               |
| --------------------- | ------------------------------------------------------------------------- |
| Sam Staff             | STAFF @ org Outlet A                                                      |
| Casey Chef            | STAFF @ org Outlet A; CHEF @ delivery Outlet A                            |
| Kim Storekeeper       | STAFF @ org Outlet A; STORE_KEEPER @ delivery Outlet A                    |
| Olivia Outlet Manager | STAFF + OUTLET_MANAGER @ org Outlet A; OUTLET_MANAGER @ delivery Outlet A |
| Aria Area Manager     | AREA_MANAGER @ org Area                                                   |
| Hugo Hub Manager      | HUB_MANAGER @ Hub (no descendants); SUPPLY_VIEWER @ Hub (descendants)     |
| Harper HR Admin       | HR_ADMIN @ org Company                                                    |
| Sasha Security Admin  | SECURITY_ADMIN @ org Company                                              |
| Avery Auditor         | AUDITOR @ org Company                                                     |
| Outlet Ops AI Agent   | AI_AGENT @ org Company and @ Company Supply Network (service user)        |

`SELF` is `user_based`. Its policy applies to every user's own rows without an assignment.

**The seed's policy matrix is authoritative.** `domain_policy` rows are upserted with
`on conflict do update set access = excluded.access`. Afterwards the tenant's rows that
are not in the matrix are deleted. Re-seeding therefore restores changed access and
removes stray grants (tested in `seed.db.test.ts`). Once `ROLE_CHANGE` lands, matrix
edits go through that workflow and the seed is only for fresh environments.

### Policy matrix

V = view, M = modify. `–` means no access.

| Group          | STOCK_LEVELS | STOCK_ADJ | PO  | TRANSFERS | WORKERS | COMP | ROSTER | ATTEND | LEAVE | EVENTS | AI_RECS | DERIVED_* (3) | AUDIT |
| -------------- | ------------ | --------- | --- | --------- | ------- | ---- | ------ | ------ | ----- | ------ | ------- | ------------- | ----- |
| STAFF          | –            | –         | –   | –         | –       | –    | V      | –      | –     | V      | –       | –             | –     |
| STORE_KEEPER   | V            | M         | M   | V         | –       | –    | –      | –      | –     | –      | –       | –             | –     |
| CHEF           | V            | M         | –   | –         | –       | –    | –      | –      | –     | –      | –       | –             | –     |
| OUTLET_MANAGER | V            | M         | M   | M         | V       | –    | M      | M      | V     | M      | M       | –             | –     |
| AREA_MANAGER   | –            | –         | –   | –         | V       | –    | V      | V      | V     | V      | V       | V             | –     |
| HUB_MANAGER    | V            | M         | V   | M         | –       | –    | –      | –      | –     | –      | –       | –             | –     |
| SUPPLY_VIEWER  | V            | –         | –   | –         | –       | –    | –      | –      | –     | –      | –       | –             | –     |
| HR_ADMIN       | –            | –         | –   | –         | M       | M    | V      | V      | M     | –      | –       | –             | –     |
| SECURITY_ADMIN | –            | –         | –   | –         | –       | –    | –      | –      | –     | –      | –       | –             | V     |
| AUDITOR        | –            | –         | –   | –         | –       | –    | –      | –      | –     | –      | –       | –             | V     |
| AI_AGENT       | V            | –         | V   | V         | V       | –    | V      | V      | V     | V      | M       | –             | –     |
| SELF (own)     | –            | –         | –   | –         | V       | V    | V      | M      | M     | –      | –       | –             | –     |

Stock, PO and transfer domains use the delivery tree. All others use the org tree.

## Generated RLS: `core.apply_domain_rls(table)`

`core.domain_table` configures each table:

- `domain_id`: the view domain.
- `modify_domain_id` (optional): writes are checked against this domain. This handles the
  LLD's ledger example (read STOCK_LEVELS, write STOCK_ADJUSTMENTS).
- `insert_only`: no UPDATE policy and no UPDATE grant.
- `node_columns` (optional): defaults to `org_node_id` or `delivery_node_id` by the
  domain's tree.

### Policies and grants

All policies are named `dom_*`.

- **For `app_rw`:**
  - `dom_select`: view if `can(view)` passes on any node column.
  - `dom_insert_<col>`: `can(modify)` on that leg.
  - `dom_update_<col>`: the same per leg, unless the table is `insert_only` or has a
    `wf_request_id` column.
  - An `owner_user_id` column, if present, is passed as the owner for self-service.
- **For `wf_executor`:** `dom_exec_select` and `dom_exec_update` on tables with
  `wf_request_id`, so status changes happen only through the executor.
- **Grants** follow the policies. Nobody gets DELETE.

### Two-node tables

Transfers have `from_node_id` and `to_node_id`. Set `node_columns` to both.

- **View:** allowed if `can()` passes on either node.
- **Modify:** checked per leg, one permissive policy per node column. A user may write a
  row if they can modify at least one of its legs. For example, the dispatching hub
  manager writes via `from_node_id` and the receiving outlet manager via `to_node_id`.
  Leg-specific rules, such as only the hub posting `transfer_out`, belong in the module
  RPCs.

### Other safeguards

- The function is idempotent.
- It is executable by the migrator only.
- It rejects an unregistered table, a missing node or owner column, and a view/modify
  domain pair from different trees.

## Coverage check

`core.rls_violations()` lists every table in `hr, inv, ops, wf, ai` with any of these
problems:

- `rls_disabled`
- `not_registered`
- `no_generated_policies`
- `hand_written_policy`
- `no_audit_trigger`

`rls-coverage.db.test.ts` fails the build if it returns rows. A negative test proves the
check detects a bare table.

## Audit

- **Table:** `audit.log`, range-partitioned by month on `occurred_at`, with a default
  partition. `audit.ensure_partitions(n)` creates the current month plus `n` months ahead;
  it should be scheduled monthly once deployed.
- **Trigger:** `audit.capture()` (security definer) records the actor from
  `core.current_user_id()`, the actor kind, the changed field names, and
  `app.granting_node` / `app.wf_request`.
- **Sensitive tables:** `audit.enable(t, names_only => true)` stores field names only.
- **Coverage:** every core table is audited.
- **Access:**
  - No role has UPDATE, DELETE or INSERT. Rows arrive only through the trigger.
  - `app_rw` may SELECT the parent table only through the `audit_read` policy, which
    requires `can('AUDIT', 'view', core.org_root(tenant_id))`.
  - Partitions have no grants, so they cannot be read directly.
- **Why the policy is hand-written:** `audit` is not a rule 1 schema and the log has no
  node column.
- **Exception to the standard columns:** `audit.log` does not carry `created_by` /
  `updated_*`, because the log is itself the audit record.

## Roles and tests

- **Roles:** `migrator`, `app_rw` and `wf_executor` come from
  `packages/db/docker/init/001-roles.sql`. None has BYPASSRLS or superuser, and a test
  checks that `app_rw` and `wf_executor` own no relations.
- **Membership:** the init script now also runs `grant app_rw, wf_executor to migrator`.
  This lets DB tests create fixture tables as migrator and then `SET LOCAL ROLE app_rw` /
  `wf_executor` inside a transaction that is always rolled back. It gives no extra
  privileges to `app_rw`. On RDS, run the same grant at provisioning.
- **Core table grants:** `app_rw` has no direct access to `core` tables yet. It can only
  execute `core.can`, `core.current_user_id`, `core.org_root` and `core.uuid_v7`. Reads
  for `core.me()` / `core.nodes()` come with the auth task.
- **Test suites:**
  - `core-can.db.test.ts`: the table-driven access matrix plus rolled-back lifecycle cases
    (expired and future assignments, inactive user, re-parenting, invalid parents).
  - `rls-policies.db.test.ts`: fixture tables covering a single-node insert-only table, a
    two-node table with `wf_request_id`, a self-service table, and audit.
  - `rls-coverage.db.test.ts`: coverage and roles.
