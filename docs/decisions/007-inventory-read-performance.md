# 007 — Inventory read performance and per-row `can()`

Status: **measured; fix proposed, not implemented** · 2026-09-30

## Question

Do the stock-list and ledger reads stay under 200 ms with RLS calling `core.can()` for
every row? The target is about 10,000 ledger rows across both outlets and the hub.

## Method

The script is `pnpm --filter @outlet-ops/db perf:inventory [--simulate-fix] [--plans]`
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

## Results with today's policies (`core.can()` per row)

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

## Proposed fix (awaiting approval)

Change the generated select policy for delivery-tree tables so the set of visible nodes
is computed **once per query** instead of calling `can()` per row:

```sql
using (delivery_node_id = any ((select core.visible_nodes('STOCK_LEVELS', 'view'))::uuid[]))
```

`core.visible_nodes(domain, access)` returns the caller's nodes in that domain's tree for
which `core.can(domain, access, …)` is true. It calls `can()` once per node, and a tenant
has tens of nodes, not thousands.

- **Rule 2 is kept.** `can()` still makes every decision; the policy only caches its
  answer for the duration of one query.
- **Measured with `--simulate-fix`:** every query in the table above, for all three
  users, takes **4–22 ms**. That includes the all-nodes ledger (6–11 ms).

**Scope, if approved:**

- `apply_domain_rls` emits this form for rows whose only check is a node:
  - `domain_column` tables and self-service owner legs keep calling `can()` per row
    (`OR`'d in).
  - Multi-leg tables such as `inv.transfer` get one array test per leg.
- **Equivalence test:** for every seeded user, domain and node, `can()` must equal
  "node is in `visible_nodes`". The test also covers derived grants and
  `include_descendants`.
- `perf:inventory` becomes a DB test with a generous bound (500 ms), so a regression
  fails CI.

**Until this is approved,** the screens run only node-filtered queries. There is no
cross-node ledger screen yet; Aria's overview uses the stock query, which is 18 ms.
