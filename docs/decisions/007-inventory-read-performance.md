# 007 — Inventory read performance and per-row `can()`

Status: accepted, fix implemented (`20260930130000_rls_visible_nodes`) · 2026-09-30

## Question

Do the stock-list and ledger reads stay under 200 ms with RLS calling `core.can()` for
every row? The target is about 10,000 ledger rows across both outlets and the hub.

## Method

The script is `pnpm --filter @outlet-ops/db perf:inventory [--plans]`
(`packages/db/scripts/perf-inventory.ts`). It works like this:

1. It opens one transaction that is always rolled back, so nothing is committed.
2. It adds 10,000 `inv.stock_ledger` rows on top of the dev seed's 126 opening rows, over
   90 days, across all 42 items at the Hub, Outlet A and Outlet B. The ledger trigger
   maintains `inv.stock_level`.
3. It runs `ANALYZE`, then runs each query once to warm the cache.
4. It runs `EXPLAIN (ANALYZE, BUFFERS)` as `app_rw`, with `app.user_id` set to:
   - Kim (store keeper at Outlet A)
   - Olivia (outlet manager at Outlet A)
   - Aria (area manager, who sees Outlet A and Outlet B only through the derived
     `DERIVED_STOCK_LEVELS` grant)

The timings are planning plus execution, measured on local Docker Postgres 16 (the dev
container).

## Results before the fix (`core.can()` per row)

| Query                                                           | Kim          | Olivia       | Aria         |
| --------------------------------------------------------------- | ------------ | ------------ | ------------ |
| Stock list for a node (the Stock screen)                        | 12 ms        | 11 ms        | 19 ms        |
| Ledger for a node, latest 50 (the Ledger screen)                | 6 ms         | 7 ms         | 9 ms         |
| One item's ledger at a node, latest 50                          | 7 ms         | 6 ms         | 10 ms        |
| Stock across all visible nodes (no node filter)                 | 21 ms        | 33 ms        | 18 ms        |
| **Ledger across all visible nodes, latest 50 (no node filter)** | **1,361 ms** | **1,543 ms** | **1,209 ms** |

- **Every query the screens run meets the 200 ms target.** The screens always filter by
  one node. The `(delivery_node_id, occurred_at desc)` index then returns rows in order,
  and the scan stops after 50, so `can()` runs about 50 times.
- **The ledger across all visible nodes misses the target by 6–8x.** With no node
  filter, Postgres has to sort the whole ledger. RLS calls `can()` on every one of the
  about 10,000 rows first, at roughly 0.13 ms per call.
- **Pre-filtering in the query is not enough.** I tried adding
  `delivery_node_id = any(<nodes where can() is true>)` to the query. It brings the
  times down to 204–734 ms, but RLS still calls `can()` for every remaining row before
  the sort.

## Fix (implemented)

Generated policies test membership in the caller's visible node set, computed **once per
query** (a Postgres InitPlan), instead of calling `core.can()` on every row:

```sql
-- node legs (e.g. inv.stock_ledger)
delivery_node_id = any ((select core.visible_nodes('STOCK_LEVELS', 'view'))::uuid[])
-- rows that carry their own domain (wf.request, wf.step_instance, wf.outbox)
(domain_code || ':' || delivery_node_id) = any ((select core.visible_domain_nodes('view'))::text[])
```

- **`core.visible_nodes(domain, access)`** returns the nodes of the caller's tenant, in
  that domain's tree, for which `core.can(domain, access, …)` is true. It calls `can()`
  once per node; a tenant has tens of nodes, not thousands. Only domains the caller holds
  directly or through `DERIVED_` can be true on a node, so the others return empty at
  once.
- **`core.visible_domain_nodes(access)`** returns the same set as `'DOMAIN:node'` pairs,
  for the `wf` tables whose rows carry their own domain.
- **These stay per row:** SELF owner legs, tenant-scoped rows and owner-only tables
  still call `core.can()` per row. They are `OR`'d in, and none of them is on a hot
  path.
- **Rule 2 is kept:** `core.can()` still makes every access decision.

**Equivalence is proved, not assumed.** `rls-equivalence.db.test.ts` checks every seeded
user against every business table.

- The rows RLS returns must be exactly the rows the per-row `core.can()` expression
  selects (the policy as it was generated before this change).
- Fixtures make sure each rule is exercised:
  - SELF: Sam's own LEAVE request
  - derived: the area manager sees Outlet A and B stock, not the hub's
  - `include_descendants`: SUPPLY_VIEWER with descendants versus HUB_MANAGER without
  - both legs of a transfer
- Insert checks on a writable fixture table must match `core.can(…, 'modify')`,
  including SELF owners.
- A deliberately broken `visible_nodes` (with the derived path dropped) is caught:
  Aria sees 0 rows instead of 84.

## Results after the fix

Same method and data, as the same users:

| Query                                            | Kim                  | Olivia               | Aria                 |
| ------------------------------------------------ | -------------------- | -------------------- | -------------------- |
| Stock list for a node (the Stock screen)         | 14 ms                | 12 ms                | 17 ms                |
| Ledger for a node, latest 50 (the Ledger screen) | 6 ms                 | 7 ms                 | 7 ms                 |
| One item's ledger at a node, latest 50           | 6 ms                 | 7 ms                 | 6 ms                 |
| Stock across all visible nodes (no node filter)  | 5 ms                 | 7 ms                 | 6 ms                 |
| **Ledger across all visible nodes, latest 50**   | **8 ms** (was 1,361) | **7 ms** (was 1,543) | **8 ms** (was 1,209) |

The worst query is now 17.6 ms, against 1,543 ms before.

`inventory-perf.db.test.ts` keeps the cross-node ledger query under 500 ms at 10,000 rows,
and checks that its plan computes the node set once (InitPlan). That bound is generous
for a slow CI runner, while a per-row regression would take about 1.2 s.
