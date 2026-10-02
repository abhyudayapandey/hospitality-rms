# Outlet Ops Platform — Low-Level Design

Sep 27, 2026 · @AP

> **Reading this today.** This is the original design. Since then:
>
> - `CLAUDE.md`'s AWS overrides replace the Supabase parts.
> - The ADRs in `docs/decisions/` record every later decision: structure and access (009),
>   approvals (010), admin and platform (011–013), menu and cost control (014–015), tasks
>   (020).
> - `docs/system-map.md` describes the system as it is now.

## 1. Scope and conventions

The MVP is one modular monolith: a Next.js PWA on Supabase (Postgres 15, Auth, RLS, Realtime, Storage, pg\_cron, Edge Functions), with the Claude API for the AI layer. Security is enforced in Postgres, not in app code.

**Repo structure**

```
/apps/web            Next.js PWA (app router, server actions)
/packages/db         migrations, seed, RLS, SQL functions
/packages/domain     TS types + zod schemas per module
/packages/workflow   process definitions + execution handlers
/packages/ai         signal jobs, prompt templates, parsers
/supabase/functions  edge functions (ai-recommend, wf-execute)
```

**Conventions**

- IDs: `uuid` v7 (time-ordered) on every table.
- Every table carries `tenant_id`, `created_at`, `created_by`, `updated_at`, `updated_by`.
- Domain rows carry `org_node_id` and/or `delivery_node_id`, per their domain's `hierarchy_type`.
- No hard deletes on business data: `status` or `archived_at`. The stock ledger is insert-only.
- Timestamps are `timestamptz` in UTC; each outlet node stores its IANA timezone for display and shift maths.
- Money is `numeric(14,2)` plus a currency code; quantities are `numeric(14,3)` in the item's base UOM.
- Schemas: `core` (security, hierarchy), `wf`, `ai`, `audit`, `inv`, `hr`, `ops`.

## 2. Database schema

The schema has 7 Postgres schemas and about 30 tables. Common columns from section 1 are omitted below.

**core: hierarchy and security**

```sql
create extension if not exists ltree;

create table core.hierarchy_node (
  id uuid primary key,
  type text not null check (type in ('org','delivery')),
  kind text not null,            -- company, region, area, outlet, dept | cwh, ck, hub, outlet, store
  name text not null,
  parent_id uuid references core.hierarchy_node(id),
  path ltree not null,           -- maintained by trigger from parent
  timezone text,
  unique (type, path)
);
create index on core.hierarchy_node using gist (path);

-- links an org outlet to its delivery outlet (used by derived access rules)
create table core.node_link (
  org_node_id uuid references core.hierarchy_node(id),
  delivery_node_id uuid references core.hierarchy_node(id),
  primary key (org_node_id, delivery_node_id)
);

create table core.app_user (
  id uuid primary key references auth.users(id),
  kind text not null check (kind in ('human','service')),
  display_name text, phone text, status text default 'active'
);

create table core.security_group (
  id uuid primary key, code text unique not null, name text not null,
  kind text not null check (kind in ('role','user_based'))
);

create table core.role_assignment (
  id uuid primary key,
  user_id uuid references core.app_user(id),
  group_id uuid references core.security_group(id),
  node_id uuid references core.hierarchy_node(id),
  effective_from date not null, effective_to date,
  unique (user_id, group_id, node_id, effective_from)
);

create table core.domain (
  id uuid primary key, code text unique not null,      -- STOCK_LEVELS, LEAVE ...
  hierarchy_type text not null check (hierarchy_type in ('org','delivery','self'))
);

create table core.domain_table (                        -- which table belongs to which domain
  table_name regclass primary key, domain_id uuid references core.domain(id)
);

create table core.domain_policy (
  domain_id uuid references core.domain(id),
  group_id uuid references core.security_group(id),
  access text not null check (access in ('view','modify')),
  primary key (domain_id, group_id)
);

create table core.bp_policy (
  process_type text, step text,
  group_id uuid references core.security_group(id),
  action text check (action in ('initiate','approve','cancel','view')),
  condition jsonb,                                      -- e.g. {"amount_gt": 50000}
  primary key (process_type, step, group_id, action)
);

-- flattened cache for fast checks, refreshed on assignment/policy change
create materialized view core.effective_access as
select ra.user_id, d.code as domain, dp.access, n.type, n.path
from core.role_assignment ra
join core.hierarchy_node n on n.id = ra.node_id
join core.domain_policy dp on dp.group_id = ra.group_id
join core.domain d on d.id = dp.domain_id and d.hierarchy_type = n.type
where current_date between ra.effective_from and coalesce(ra.effective_to, 'infinity');
```

**hr: people (org hierarchy)**

| Table | Key columns |
| --- | --- |
| `hr.worker` | id, user\_id, org\_node\_id, position, employment\_type, joined\_on |
| `hr.worker_sensitive` | worker\_id, pay\_rate, bank\_ref, id\_doc\_ref (domain COMPENSATION) |
| `hr.shift_template` | id, org\_node\_id, name, start\_time, end\_time, role\_code |
| `hr.shift` | id, org\_node\_id, date, start\_at, end\_at, role\_code, status (draft, published) |
| `hr.shift_assignment` | id, shift\_id, worker\_id, status (assigned, swapped, dropped) |
| `hr.attendance` | id, worker\_id, org\_node\_id, shift\_id, clock\_in\_at, clock\_out\_at, source, geo |
| `hr.leave_request` | id, worker\_id, org\_node\_id, type, from\_date, to\_date, status, wf\_request\_id |
| `hr.leave_balance` | worker\_id, type, year, entitled, used |

**inv: stock and orders (delivery hierarchy)**

| Table | Key columns |
| --- | --- |
| `inv.item` | id, sku, name, category, base\_uom, is\_perishable |
| `inv.item_node` | item\_id, delivery\_node\_id, par\_level, reorder\_qty, preferred\_supplier\_id |
| `inv.supplier` | id, name, lead\_time\_days, contact |
| `inv.stock_ledger` | id, item\_id, delivery\_node\_id, movement\_type, qty (signed), unit\_cost, ref\_type, ref\_id, occurred\_at |
| `inv.stock_level` | materialized: item\_id, delivery\_node\_id, on\_hand, value |
| `inv.stock_count` | id, delivery\_node\_id, status, counted\_at; lines: item\_id, counted\_qty, system\_qty |
| `inv.purchase_order` | id, delivery\_node\_id, supplier\_id, status, total, wf\_request\_id; lines |
| `inv.goods_receipt` | id, po\_id, delivery\_node\_id, received\_at; lines: item\_id, qty, unit\_cost |
| `inv.transfer` | id, from\_node\_id, to\_node\_id, status, wf\_request\_id; lines |

`movement_type` values: `receipt`, `consumption`, `wastage`, `transfer_out`, `transfer_in`, `count_adjust`.

**ops: events (org hierarchy)**

| Table | Key columns |
| --- | --- |
| `ops.event` | id, org\_node\_id, name, starts\_at, ends\_at, covers, status |
| `ops.event_requirement` | event\_id, kind (item, role), ref\_id, qty |

**wf, ai, audit**

| Table | Key columns |
| --- | --- |
| `wf.request` | id, process\_type, subject\_type, subject\_id, org\_node\_id, delivery\_node\_id, initiator\_id, state, current\_step, payload jsonb, amount |
| `wf.step_instance` | id, request\_id, step, assignee\_group\_id, scope\_node\_id, state, actor\_id, acted\_at, comment |
| `ai.signal` | id, kind, node\_id, subject\_ref, value jsonb, computed\_at |
| `ai.recommendation` | id, signal\_id, node\_id, title, rationale, proposed\_action jsonb, confidence, status, wf\_request\_id, expires\_at |
| `audit.log` | id, occurred\_at, actor\_id, actor\_kind, table\_name, row\_id, op, before jsonb, after jsonb, granting\_node\_id, request\_id |

## 3. Security enforcement

One SQL function, `core.can()`, decides every read and write; RLS policies on each table call it with the row's domain and hierarchy nodes.

**Decision function**

```sql
create function core.can(
  p_domain text, p_access text,          -- access: 'view' | 'modify'
  p_org uuid, p_delivery uuid,           -- the row's nodes
  p_owner uuid default null              -- row owner's user id, for self-service
) returns boolean
language sql stable security definer set search_path = core as $$
  with d as (select hierarchy_type from core.domain where code = p_domain),
  t as (
    select path, type from core.hierarchy_node
    where id = case (select hierarchy_type from d) when 'org' then p_org else p_delivery end
  )
  select
    -- 1. hierarchy grant: an assignment at or above the row's node
    exists (
      select 1 from core.effective_access ea, t
      where ea.user_id = auth.uid() and ea.domain = p_domain
        and ea.type = t.type and ea.path @> t.path
        and (ea.access = 'modify' or p_access = 'view'))
    -- 2. self-service: SELF group policy on rows the user owns
    or (p_owner = auth.uid() and exists (
      select 1 from core.domain_policy dp
      join core.security_group g on g.id = dp.group_id and g.code = 'SELF'
      join core.domain dd on dd.id = dp.domain_id and dd.code = p_domain
      where dp.access = 'modify' or p_access = 'view'))
    -- 3. derived cross-hierarchy view (area manager sees linked stock)
    or (p_access = 'view' and (select hierarchy_type from d) = 'delivery' and exists (
      select 1 from core.node_link nl
      join core.hierarchy_node o on o.id = nl.org_node_id
      join core.effective_access ea on ea.type = 'org' and ea.path @> o.path
      where nl.delivery_node_id = p_delivery and ea.user_id = auth.uid()
        and ea.domain = 'DERIVED_' || p_domain));
$$;
```

**RLS templates**

```sql
-- delivery-scoped, ledger is insert-only (no update/delete policy exists)
alter table inv.stock_ledger enable row level security;
create policy r on inv.stock_ledger for select
  using (core.can('STOCK_LEVELS','view', null, delivery_node_id));
create policy w on inv.stock_ledger for insert
  with check (core.can('STOCK_ADJUSTMENTS','modify', null, delivery_node_id));

-- org-scoped with self-service
alter table hr.leave_request enable row level security;
create policy r on hr.leave_request for select
  using (core.can('LEAVE','view', org_node_id, null, owner_user_id));
create policy w on hr.leave_request for insert
  with check (core.can('LEAVE','modify', org_node_id, null, owner_user_id));
```

**Rules**

- Policies are generated, not hand-written: `core.apply_domain_rls(table)` reads `core.domain_table` and creates the select/insert/update policies. A CI check fails if any table in a business schema lacks RLS.
- Self-service tables denormalise `owner_user_id` so the check needs no join.
- `effective_access` refreshes concurrently via trigger on `role_assignment` and `domain_policy`. In week 1 it can be a plain view; switch to materialised once data grows.
- Sensitive data lives in its own tables (`hr.worker_sensitive`) under its own domain, never as columns on shared tables.
- Status transitions and approvals never go through direct `update`. Tables with a `wf_request_id` allow `update` only to the `wf_executor` role (section 4).
- Role assignments and policy rows change only through the `ROLE_CHANGE` workflow, approved by a Security Admin.

**Service identities**

- The AI agent is a `core.app_user` of kind `service`, assigned the `AI_AGENT` group at the company root in both trees.
- Its domain policies are `view` only. Its sole write path is the `wf.submit()` RPC, gated by `bp_policy` action `initiate`.
- Edge functions act as the agent with a JWT minted for that user. The Supabase `service_role` key bypasses RLS and is used only by migrations and the workflow executor.

## 4. Workflow engine

Every state-changing business action is a `wf.request` moving through one state machine; only the executor writes the final business change.

&#91;embedded content: request states · 5 on the happy path, 3 terminal exits\]

A request loops in In approval once per step, then an execution handler applies the change in one transaction.

**Process definitions** live in code (`/packages/workflow`) and are seeded into `wf.process_def` so outlets can later override thresholds without a deploy.

```ts
export const PURCHASE_ORDER: ProcessDef = {
  type: 'PURCHASE_ORDER',
  subject: 'inv.purchase_order',
  hierarchy: 'delivery',
  steps: [
    { step: 'outlet_approval', group: 'OUTLET_MANAGER', scope: 'subject_node' },
    { step: 'area_approval', group: 'AREA_MANAGER', scope: 'nearest_ancestor',
      when: { amount_gt: 50000 } },
  ],
  onApproved: 'inv.po.release',
  onRejected: 'inv.po.reject',
  slaHours: 24,
};
```

**MVP processes**

| Process | Initiator | Approval steps | On approved |
| --- | --- | --- | --- |
| `STOCK_ADJUSTMENT` | Store Keeper, Chef | Outlet Mgr (if variance above threshold) | Post `count_adjust` / `wastage` ledger rows |
| `PURCHASE_ORDER` | Store Keeper, AI agent | Outlet Mgr; Area Mgr above amount | Status `released`, notify supplier |
| `TRANSFER` | Outlet Mgr (receiving) | Hub Mgr (dispatch), receiving Outlet Mgr (receipt) | Post `transfer_out` then `transfer_in` |
| `LEAVE` | Worker (self) | Outlet Mgr, then HR Admin | Update balance, block roster slots |
| `SHIFT_SWAP` | Worker (self) | Outlet Mgr | Reassign `shift_assignment` |
| `ROLE_CHANGE` | HR Admin | Security Admin | Write `role_assignment`, refresh access |

**Routing algorithm** (per step)

1. Resolve the start node: the subject's node in the process's hierarchy.
2. For `subject_node`, the scope is that node. For `nearest_ancestor`, walk up `path` until a node has an active assignment for the step's group.
3. Store `assignee_group_id` and `scope_node_id` on `wf.step_instance`. Any user holding that group at or above the scope node can act.
4. Evaluate `when` against `wf.request.amount` / `payload`; skipped steps are recorded as `skipped`, not omitted.
5. The initiator can never approve their own request (segregation of duties).

**RPCs**

- `wf.submit(process_type, subject_type, subject_id, payload)` checks `bp_policy` action `initiate` plus `core.can(..., 'modify')` on the subject, then creates the request and first step.
- `wf.act(request_id, action, comment)` with action `approve`, `reject` or `cancel`, checked against `bp_policy` and step scope; advances the state.
- On `approved`, a database webhook calls the `wf-execute` edge function. It runs the handler as the `wf_executor` role, keyed on `request_id` for idempotency, with 3 retries and backoff before `failed`.
- A `pg_cron` job hourly escalates steps past `slaHours` to the same group one level up the tree.

## 5. Module designs

Each module is a thin layer of tables, RPCs and screens over the platform core; stock quantities only ever change through ledger rows.

### Inventory

- **On-hand** = `sum(qty)` from `inv.stock_ledger` per item and node, cached in `inv.stock_level` (materialised view, refreshed after each ledger insert batch). Screens read the cache; reports reconcile against the ledger.
- **Valuation**: weighted average cost, recomputed on each `receipt` row.
- **Consumption** is recorded as daily closing counts in the MVP (no POS yet): `consumption = opening + receipts + transfers_in - transfers_out - wastage - closing`.
- **Stock count**: draft count with `system_qty` snapshotted at start; on submit, variance lines above the item's threshold route to `STOCK_ADJUSTMENT`, the rest post directly.
- **Wastage**: logged with reason code (expired, spoiled, prep error) and optional photo in Storage.
- **Invariant**: on-hand cannot go negative for non-perishables; a check in the insert RPC rejects it.

### Orders and transfers

- **PO lifecycle**: `draft` → workflow → `released` → `partially_received` → `received` / `closed`.
- **Goods receipt** against a PO writes `receipt` ledger rows in one transaction; over-receipt above 5% needs Outlet Mgr approval.
- **Transfer** has two legs on two delivery nodes. The dispatching hub posts `transfer_out` and the receiving outlet posts `transfer_in`; quantity differences post as `wastage` with reason `transit_loss`.
- **Suggested order qty** (manual or AI) = `max(0, par_level + forecast_to_next_delivery - on_hand - open_po_qty)`.

### Rostering

- **Build**: generate a week of `hr.shift` rows from `shift_template`s, then assign workers. Validation runs on every assignment: no overlap, approved leave, minimum 10 hours rest between shifts, weekly hours cap.
- **Publish** flips all draft shifts for the node-week to `published` and sends push notifications; edits after publish notify affected workers.
- **Swap**: worker picks a published shift and a colleague with the same `role_code`; routes to `SHIFT_SWAP`.

### Attendance

- **Clock-in/out** from the PWA with geolocation checked against the outlet's radius. Offline punches queue on the device and sync with the original timestamp and a `source = offline` flag.
- **Exceptions** computed nightly: late (more than 10 minutes), no-show, missing clock-out, unscheduled shift. Managers resolve them in a queue.

### Leave

- Balance check at submit; approved leave writes a block that rostering validation reads.
- Leave types and entitlements are config per company (`hr.leave_type`).

### Events

- An event has covers, time window and requirements (items, roles). Requirements can be entered or derived from a menu template in Phase 2.
- Events feed the AI signals: they raise forecast demand for items and required headcount for the shift window.

## 6. AI layer

SQL computes the signals and the numbers; Claude only explains them and shapes the proposed action, which a validator checks before anything reaches a human.

**Pipeline**

1. `pg_cron` runs signal jobs (SQL functions) that write `ai.signal` rows.
2. The `ai-recommend` edge function picks up new signals, builds a context bundle, and calls the Claude API.
3. The response is parsed and validated against the action schema, then written to `ai.recommendation` with status `proposed`.
4. A manager accepts, edits or dismisses it in the PWA. Accept calls `wf.submit()` with the AI agent as initiator and the manager's acceptance recorded as the first step.
5. Outcomes (accepted, edited, dismissed, executed) are kept for tuning thresholds.

**MVP signals**

| Signal | Schedule | Logic | Proposed action |
| --- | --- | --- | --- |
| `LOW_STOCK` | Every 2 h | Days of cover = on\_hand / 7-day avg consumption, below supplier lead time + 1 | Draft `PURCHASE_ORDER` with suggested qty (section 5) |
| `EVENT_UPLIFT` | Daily 06:00 | Event in next 5 days whose requirements exceed on-hand or rostered headcount | Draft PO lines and/or open shifts |
| `ROSTER_GAP` | Daily + on publish | Shift window below minimum headcount per role, or approved leave leaves a hole | Suggest available workers ranked by hours and rest rules |
| `OVERTIME_RISK` | Daily | Worker projected over weekly cap from published shifts | Suggest reassignment |
| `WASTAGE_SPIKE` | Daily | Item wastage above 2x its 28-day median | Insight only, no action |

**Recommendation states**: `proposed` → `accepted` / `edited` / `dismissed` / `expired`. An accepted one links to its `wf_request_id`. Duplicates are suppressed by `(kind, node_id, subject_ref)` while one is open.

**Prompt contract**

The system prompt fixes the role (outlet operations analyst), forbids inventing numbers, and requires JSON only. The user message carries the signal plus a compact bundle: item or worker facts, last 14 days of the relevant series, open POs, upcoming events.

```json
{
  "title": "Reorder chicken breast before Saturday event",
  "rationale": "2.1 days of cover vs 2-day lead time; event adds 12 kg.",
  "confidence": 0.82,
  "proposed_action": {
    "process_type": "PURCHASE_ORDER",
    "payload": { "supplier_id": "…", "lines": [{ "item_id": "…", "qty": 18 }] }
  }
}
```

**Guardrails**

- The validator rejects any `proposed_action` whose process type the signal does not allow, whose IDs are not in the context bundle, or whose quantities differ from the SQL-computed figure by more than 20%.
- Numbers in `rationale` must match bundle values; a mismatch drops the rationale and shows the raw signal instead.
- The agent has view-only data access (section 3), so a bad output can at worst create a request a human rejects.
- Model and prompt version are stored on each recommendation. Use a Sonnet-class model for recommendations and a Haiku-class model for bulk explanation.

## 7. API surface

Reads go straight to tables through the Supabase client under RLS; every write that touches stock, status or people goes through a Postgres RPC, so business rules live in one place.

| Module | RPC / read | Domain · access | Notes |
| --- | --- | --- | --- |
| Core | `core.me()` | self | Profile, assignments, visible nodes for the node switcher |
| Core | `core.nodes(type)` | any assignment | Tree the user can see |
| Inventory | read `inv.stock_level`, `inv.item_node` | STOCK\_LEVELS · view | Filter by node, category, below par |
| Inventory | `inv.record_wastage(node, lines)` | STOCK\_ADJUSTMENTS · modify | Writes ledger rows |
| Inventory | `inv.start_count(node)`, `inv.submit_count(id, lines)` | STOCK\_ADJUSTMENTS · modify | Variance routes to workflow |
| Orders | `inv.create_po(node, supplier, lines)` | PURCHASE\_ORDERS · modify | Creates draft, then `wf.submit` |
| Orders | `inv.receive(po, lines)` | PURCHASE\_ORDERS · modify | Receipt ledger rows |
| Orders | `inv.request_transfer(from, to, lines)` | TRANSFERS · modify | Two-leg workflow |
| Rostering | `hr.generate_week(node, week)` | ROSTER · modify | From templates |
| Rostering | `hr.assign(shift, worker)`, `hr.publish_week(node, week)` | ROSTER · modify | Validation errors returned as codes |
| Rostering | read `hr.shift` (own) | ROSTER · view (self) | My shifts |
| Attendance | `hr.clock(action, geo, client_ts)` | ATTENDANCE · modify (self) | Idempotent on `client_ts` |
| Leave | `hr.request_leave(type, from, to)` | LEAVE · modify (self) | Balance check, then `wf.submit` |
| Events | `ops.upsert_event(...)` | EVENTS · modify | Requirements as lines |
| Workflow | `wf.submit(...)`, `wf.act(...)`, read `wf.my_inbox` | bp\_policy | Inbox view = steps the user can act on |
| AI | read `ai.recommendation`, `ai.respond(id, action, edits)` | AI\_RECOMMENDATIONS · view / modify | Accept calls `wf.submit` |

**Conventions**

- RPCs are `security invoker` so RLS applies, except `wf.*` executor paths.
- Errors raise with a stable code (`INSUFFICIENT_STOCK`, `REST_RULE`, `NOT_AUTHORISED`) that the PWA maps to messages.
- Every mutating RPC accepts an optional `idempotency_key`, stored for 24 hours.
- Realtime subscriptions: `wf.my_inbox`, `ai.recommendation` and `inv.stock_level` for the current node.

## 8. Audit, observability, error handling

One generic trigger audits every business table, and the audit log itself is append-only and readable only by the Auditor and Security Admin groups.

**Audit trigger**

```sql
create function audit.capture() returns trigger
language plpgsql security definer as $$
begin
  insert into audit.log(occurred_at, actor_id, actor_kind, table_name, row_id, op,
                        before, after, granting_node_id, request_id)
  values (now(), auth.uid(),
          coalesce(current_setting('app.actor_kind', true), 'human'),
          tg_table_schema || '.' || tg_table_name,
          coalesce(new.id, old.id), tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end,
          nullif(current_setting('app.granting_node', true), '')::uuid,
          nullif(current_setting('app.wf_request', true), '')::uuid);
  return coalesce(new, old);
end $$;
```

- RPCs set `app.granting_node` and `app.wf_request` with `set_config(..., true)` so each log row shows which assignment and which request authorised it.
- `audit.log` is partitioned monthly; no update or delete privilege exists for any role.
- Sensitive tables log field names changed, not values.

**Observability**

- Structured logs from edge functions (request id, user id, node id, duration) to Supabase logs; Sentry for the PWA and edge functions.
- Health dashboard: failed workflow executions, signal job runtimes, recommendation accept rate, RLS-denied error count.

**Error handling**

- Validation errors return codes (section 7); the PWA never shows raw SQL errors.
- Workflow handler failures move the request to `failed`, alert the Outlet Mgr and admin, and can be retried from the admin screen.
- Claude API failures leave the signal unprocessed; the next run retries. Parse failures are logged with the raw response.
- Offline PWA actions queue in IndexedDB and replay in order with their idempotency keys.

## 9. 3-week build sequence

The platform core ships first because every module depends on it; the AI week depends on a week of seeded ledger and roster data.

&#91;embedded content: 3-week build · 4 phases, 4 gates\]

No phase starts until the previous gate passes; gates are automated tests plus one scripted walkthrough.

**If the plan slips, cut in this order**

1. Events requirements (keep the event calendar only).
2. `OVERTIME_RISK` and `WASTAGE_SPIKE` signals.
3. Shift swap (managers reassign manually).
4. Offline clock-in queue (online only for the pilot).

Never cut: `core.can()` + RLS, the stock ledger, the workflow engine, the audit trigger. Retrofitting them costs more than the whole MVP.
