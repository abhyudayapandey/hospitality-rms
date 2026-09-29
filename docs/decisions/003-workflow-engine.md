# 003 — Workflow engine

Status: accepted · 2026-09-29

This ADR records how LLD section 4 was implemented in `packages/db` (schema `wf`) and
`packages/workflow`, with the CLAUDE.md AWS overrides.

Migrations:

- `20260929110000_domain_table_by_code.sql`
- `20260929120000_workflow.sql`

Seed: `002_workflow.sql`. Code: `packages/workflow`.

## Changes from the LLD and earlier ADRs

These are flagged because they differ from the LLD, CLAUDE.md or ADR 002.

- **TRANSFER initiator.** STORE_KEEPER initiates TRANSFER and now has TRANSFERS modify.
  OUTLET_MANAGER is not an initiator. The LLD had the receiving outlet manager both
  initiate and approve receipt, which rule 7 forbids. There are no exemptions to rule 7.
- **Initiation check.** Humans need `core.can(domain, 'modify')` on the subject. Service
  users (`app_user.kind = 'service'`, such as the AI agent) need `core.can(domain, 'view')`
  plus a `bp_policy` initiate row for the process. `SELF` initiate rights apply to human
  users only, so the agent cannot file leave for itself.
- **New domains** (a seed test checks these exactly):
  - `SHIFT_SWAPS` (SELF M, OUTLET_MANAGER V, AREA_MANAGER V, AI_AGENT V)
  - `SECURITY_ROLES` (HR_ADMIN M, SECURITY_ADMIN V, AUDITOR V)
  - `WF_CONFIG` (SECURITY_ADMIN V, HR_ADMIN V)
    SHIFT_SWAP and ROLE_CHANGE needed a subject domain the initiator can modify.
- **`core.domain_table` is tenant-independent** (supersedes that part of ADR 002). Domain
  codes are unique per tenant, but tables are registered in migrations, before any tenant
  exists. Registrations therefore store `domain_code`, `modify_domain_code` and
  `hierarchy_type`, and `core.can()` resolves the code in the caller's tenant. The table
  has no `tenant_id`: it is schema metadata.
- **Draft and Submitted live in subject tables.** A `wf.request` starts at `in_approval`
  (the LLD's "Submitted" is the moment `wf.submit` runs). Drafts are rows in the subject
  table (e.g. `inv.purchase_order.status = 'draft'`) before `wf.submit` is called.

## Known hole: caller-supplied nodes

The subject tables don't exist yet, so `wf.submit` takes `p_org_node_id` and
`p_delivery_node_id` from the caller. It checks them with `core.can()` and `bp_policy`,
but it cannot verify that they match the subject row. The inventory prompt closes this:
`wf.submit` will derive the nodes (and TRANSFER's from/to nodes) from the subject row,
and the node parameters will be removed.

## Registration modes for `core.apply_domain_rls`

All generate `dom_*` policies only (rule 1).

- **`domain_column`:** the row carries its domain code, as with `wf.request.domain_code`.
  `can()` receives both `org_node_id` and `delivery_node_id` and picks the node by that
  domain's tree. A PO request is visible to whoever can view POs at that node,
  including the area manager via DERIVED_PURCHASE_ORDERS. A LEAVE request is visible to
  its initiator via SELF.
- **`owner_column`:** the owner passed to `can()` for self-service. It defaults to
  `owner_user_id`; the `wf` tables use `initiator_id`.
- **`rpc_only`:** only a select policy and select grant. All writes go through
  SECURITY DEFINER RPCs, and tests prove `app_rw` cannot insert, update or delete `wf`
  tables.
- **`tenant_scoped`:** for rows without a node, such as `wf.process_def`. Checked at
  `core.org_root(tenant_id)`.

## Tables

- **`wf.process_def`**
  - One row per tenant and process.
  - Synced from the code definitions by `pnpm db:seed` (`wf.upsert_process_def`).
  - `domain_code` has an FK to `core.domain(tenant_id, code)`.
- **`wf.request`**
  - States: `in_approval → approved → executing → completed`, with exits `rejected`,
    `cancelled` and `failed`.
  - `domain_code` is always copied from `process_def`, never taken from input, and has an
    FK to `core.domain`.
  - Idempotency key is unique per `(tenant_id, initiator_id, idempotency_key)`. A repeat
    returns the existing request.
- **`wf.step_instance`**
  - All steps are created at submit, in states `waiting / pending / approved / rejected /
skipped / cancelled`.
  - A step whose `when` is false is recorded as `skipped`, not omitted.
  - Domain, nodes and initiator are copied from the request for RLS.
- **`wf.outbox`**
  - One row per `(request_id, handler)`.
  - Polled by the executor (CLAUDE.md: DB webhooks → outbox).

## Routing

- **`subject_node`:** the subject's node in the process's tree.
- **`from_node` / `to_node`:** TRANSFER only. Taken from `payload.from_node_id` and
  `payload.to_node_id`. Dispatch is scoped to the hub and receipt to the receiving
  outlet, and each side can act only on its own step.
- **`nearest_ancestor`:** walk up the process's tree to the first node with an active
  assignment of the step's group, from someone other than the initiator, that covers
  the start node. If none is found and the start is a delivery node, map it via
  `core.node_link` to its org node and walk up the org tree. A PO above 50,000 at
  Outlet A therefore routes to the Area manager.
- **Segregation-of-duties fallback.** If nobody other than the initiator can act on a
  step at its normal scope, `wf.route_step` reroutes it at submit:
  1. to the step's `escalateTo` group, searching from the scope node up and across trees
  2. otherwise to the step's own group, strictly above the scope node

  For example, a sole outlet manager raising a PO, LEAVE or STOCK_ADJUSTMENT at Outlet A
  gets step 1 routed to the Area manager. To support this, PURCHASE_ORDER and
  STOCK_ADJUSTMENT `outlet_approval` now have `escalateTo: AREA_MANAGER`, the same as
  LEAVE, with matching `bp_policy` approve rows. An `escalateTo` group used this way is
  consumed, so later SLA escalation stays with that group.

- **`NO_APPROVER`:** raised at submit only when that search finds nobody, anywhere up
  the tree, other than the initiator.
- **Who can act:** a user can act on a pending step if all of these hold:
  - they are not the initiator (rule 7; otherwise `SEGREGATION_OF_DUTIES`)
  - they hold the step's group at or above its scope node, respecting
    `include_descendants` (`core.group_holders`)
  - a `bp_policy` approve row exists for (process, step, group)

  Group checks live in SQL next to `core.can()` (`core.group_holders`,
  `core.nearest_group_node`), never in TypeScript.

- **Cancel:** allowed for the initiator, or a `bp_policy` cancel holder, while the
  request is in approval.
- **Inbox:** `wf.my_inbox()` lists the pending steps the caller can act on, excluding
  requests they initiated.

**Error codes:** `NOT_AUTHORISED`, `SEGREGATION_OF_DUTIES`, `NO_APPROVER`,
`UNKNOWN_PROCESS`, `INVALID_SUBJECT`, `INVALID_STATE`, `INVALID_ACTION`,
`REQUEST_NOT_FOUND`, `INVALID_PROCESS_DEF`.

## Escalation

- **`wf.overdue_steps(at)`:** lists pending steps past the process SLA and their
  escalation target:
  - **Group:** the step's `escalateTo` group on the first escalation (LEAVE:
    OUTLET_MANAGER → AREA_MANAGER), otherwise the same group.
  - **Node:** for the `escalateTo` group, from the current scope node up; for the same
    group, strictly above the current scope node. Both find the first holder other than
    the initiator, crossing trees via `node_link` (`core.nearest_group_node(…, p_strict)`).
    This is the same search as the SoD fallback. Walking up from a delivery node's parent
    would be wrong: the hub's org link sits under Region, which skips the Area.
- **`wf.escalate_overdue(at)`:** moves each routable step and restarts its SLA clock.
- **`wf.unroutable_steps(at)`:** lists overdue steps with no target. They stay pending
  with their current approvers. This list is for the health dashboard.
- **Scheduling:** both run hourly as `wf_executor` once scheduling is deployed
  (EventBridge or pg_cron).
- **Approve rights:** escalation targets need their own `bp_policy` approve row. The seed
  has `LEAVE/outlet_approval/AREA_MANAGER`, and a test checks every step's `escalateTo`
  group has one.

## Executor

`packages/workflow` `runOnce(pool, handlers)` connects as `wf_executor`. Each outbox row
is handled in one transaction:

1. `wf.claim_next()`: the next due row, `FOR UPDATE SKIP LOCKED`; request → `executing`.
2. Set `app.actor_kind = 'executor'` and `app.wf_request`, which the audit trail records.
3. Run the handler inside a savepoint.
4. `wf.complete_outbox()`: the row is done and the request `completed`.

**On failure:**

- Roll back to the savepoint.
- `wf.record_failure()` records the attempt. Backoff is 30 s, then 2 min. The third
  failure marks the row and the request `failed`.
- Unknown handlers count as failures.

**Idempotency:**

- A committed row is `done` and never claimed again.
- Concurrent executors skip locked rows.
- Handlers must still be idempotent on `request_id`, because a failed attempt can be
  retried after partial external effects.

**Running it:**

- Locally: `pnpm --filter @outlet-ops/workflow execute [--once]`.
- The `wf-execute` Lambda will wrap `runOnce` later.
- All six processes have stub handlers.

## Tenant isolation

`tenant-isolation.db.test.ts` builds a tenant B with identical group and domain codes, the
same matrices and the same process definitions, plus an outlet manager, Bob. It checks
that Bob:

- can use his own tenant's data (the positive control)
- gets `can() = false` on every tenant A node
- sees no tenant A business, `wf` or audit rows
- has an empty inbox
- gets `REQUEST_NOT_FOUND` when acting on a tenant A request
- cannot submit against a tenant A node

Isolation rests on three things:

- node paths being disjoint between tenants
- codes resolving in the caller's tenant
- the RPCs filtering by the caller's tenant

Nothing yet stops an admin from assigning a user to another tenant's node or group. A
tenant-consistency check on `core.role_assignment` is a candidate for the `ROLE_CHANGE`
work.

## Migrations

Production migrations are forward-only; down migrations are dev tooling (ADR 001). For
example, rolling back `domain_table_by_code` restores the tenant and domain columns as
nullable.

## Seeds

- **`002_workflow.sql`:** the `bp_policy` matrix. It is authoritative per tenant, like
  the domain policy matrix.
- **Process definitions** are synced from code after the SQL seeds.
- **Consistency tests** check that:
  - `wf.process_def` equals the code definitions
  - every step group and `escalateTo` group has an approve row
  - every process has an initiator
