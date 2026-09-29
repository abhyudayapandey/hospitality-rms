# 006 — Inventory, orders and transfers

Status: accepted · 2026-09-30

This ADR records how LLD section 5 (Inventory, Orders and transfers) and its rows in
section 7 were built.

- **Migrations:**
  - `20260930100000_wf_subject_from_row` (workflow engine changes)
  - `20260930110000_inventory_schema` (tables and the ledger trigger)
  - `20260930120000_inventory_rpcs` (functions, executor SQL, views)
- **Dev seed:** `003_inventory_dev.sql`.
- **Screens:** under `/stock` in `apps/web`.
- **Performance:** ADR 007 (RLS computes the visible node set once per query).

## Production data

The dev seed (42 items, two suppliers, par levels, opening stock) is **for development
only**. In production, items, suppliers, par levels, count tolerances and the wastage
approval value come from the **pilot onboarding script** (ADR 004, days 20–21). It runs
as `migrator`, and opening stock is posted as ledger receipts (`ref_type = 'opening'`).

## Workflow engine changes (closes the ADR 003 hole)

- **`wf.submit` reads the subject row.**
  - The signature is now `wf.submit(process, subject_type, subject_id, payload,
idempotency_key)`. The old signature with caller-supplied nodes and amount is gone.
  - Each subject type registers a resolver in `core.subject_resolver`. The resolver
    returns the tenant, the org and delivery nodes, TRANSFER's from and to nodes, the
    amount and currency, and whether the subject can be submitted.
  - From and to are written into the payload by the server; caller values are dropped.
- **Amount comes from the subject too.** A caller could otherwise understate a PO and
  skip the Area step.
- **Submit refuses these subjects:**
  - missing
  - in another tenant
  - not in a submittable state (only `draft` rows without a request)
  - already attached to an active request (serialised with an advisory lock)
- **Two new step options:**
  - `approveVia: 'module'`: the step can only be approved through `wf.act_as_module`.
    Module functions call it so that approval and the step's stock movement happen in
    one transaction. A plain inbox Approve raises `APPROVE_VIA_MODULE`.
  - `irreversible: true`: once the step is approved, reject and cancel raise
    `IRREVERSIBLE_STEP`.
- **Cancel now runs `onRejected`**, so a cancelled subject closes as `cancelled`.
- **Subject types without a module yet** (LEAVE, SHIFT_SWAP, ROLE_CHANGE) have no
  resolver, so submitting them fails with `INVALID_SUBJECT` until their modules land.
  Engine tests use stand-in subjects.

## Data model and rules

- **Tables are read-only for the app role.** Every `inv` table is registered `rpc_only`:
  `app_rw` can only select, through generated RLS. Writes go through `SECURITY DEFINER`
  functions that check `core.can()` on the node they write to (rules 1 and 2).
- **Catalogue mode.** `inv.item` and `inv.supplier` have no node, so they use a new
  registration mode. A row is visible to users of the same tenant who hold view on the
  domain (or its `DERIVED_` domain) at any node, via `core.can_any`. The check runs once
  per query, not per row.
- **Stock changes only by ledger insert (rule 3).**
  - `inv.stock_ledger` is append-only for every role, including its owner:
    `UPDATE`, `DELETE` and `TRUNCATE` all raise `LEDGER_APPEND_ONLY`.
  - Each movement type has a fixed sign, checked by a constraint.
- **On-hand cache.** _Differs from the LLD_, which specifies a materialised view.
  - `inv.stock_level` is a table maintained by a `BEFORE INSERT` trigger on the ledger,
    in the same transaction.
  - The trigger locks per item and node, so concurrent movements can't both pass the
    stock check.
  - Refreshing a materialised view on every write is slow, and between refreshes the
    shown stock is stale.
- **No negative stock, for every item.** _Differs from the LLD_, which exempted
  perishables. The error tells the user to record the receipt or do a count first.
- **Costing.** Receipts and transfers in recompute the weighted average cost. Outflows
  and count adjustments are valued at the current average.
- **PO status** only moves through the workflow: `draft → submitted → released`, or
  `rejected` / `cancelled`. Receipt progress (released, partially received, received)
  is computed from the receipts in `inv.purchase_order_summary`, so no status changes
  outside the workflow (rule 4).

## Processes

- **STOCK_ADJUSTMENT has no amount tier.**
  - Count variance within an item's `count_tolerance_qty` posts `count_adjust`
    directly.
  - Anything beyond it goes to Outlet Manager approval, whatever its value (escalating
    to the Area Manager as before).
  - The count is blind: the count sheet doesn't show system quantities.
- **Wastage.**
  - A line worth at most the node's `wastage_approval_value` (default 2,000 INR, in
    `inv.node_setting`) posts directly.
  - A line worth more needs a photo and becomes a `STOCK_ADJUSTMENT` with reason
    `wastage`.
  - Reasons are expired, spoiled, prep_error, damaged and other.
- **Over-receipt.**
  - Each receipt line is capped at ordered + 5%, minus what was already received.
  - The capped quantity posts as `receipt`. Any excess becomes a `STOCK_ADJUSTMENT`
    with reason `supplier_excess` and goes through normal approval.
  - There is no separate over-receipt right.
- **Transfers.** _Differs from the LLD_, where the executor posted both legs at the end.
  - The receiving side (STORE_KEEPER, ADR 003) requests.
  - The hub confirms dispatch with `inv.dispatch_transfer`, which posts `transfer_out`
    and approves the dispatch step in one transaction.
  - After dispatch, the request cannot be rejected or cancelled. The screen shows it as
    **in transit**.
  - The receiving Outlet Manager confirms with `inv.receive_transfer`. This posts
    `transfer_in` of the dispatched quantity, and any shortfall as `wastage` with
    reason `transit_loss` at the receiving node.
  - The executor only marks the transfer completed.
  - This keeps the hub's on-hand correct while goods are on the road, so a hub count
    during transit doesn't show false variances.
- **Suggested order quantity** = `max(0, par_level − on_hand − open_po_qty)`. The LLD's
  forecast term is 0 for the MVP (no POS yet).
- **Executor handlers.** All six inventory handlers are one SQL function,
  `inv.execute(handler, request_id)`, callable only by `wf_executor`. It is idempotent
  per request, and the TypeScript handlers just call it.

## Wastage photos

- **Storage.** A private S3 bucket (`PhotoBucket`): public access blocked, SSE-S3,
  TLS only, CORS POST only from the app origin, photos kept 400 days, and
  `RetainExceptOnCreate`.
- **Upload.**
  - The web app issues a **presigned POST** for the key
    `wastage/<tenant>/<node>/<uuid>.<ext>`.
  - The type must be exactly jpeg/png/webp, the size 1 B to 5 MB, and the URL expires
    after 5 minutes.
  - It is issued only after `core.can('STOCK_ADJUSTMENTS', 'modify', node)` in SQL.
  - Phones shrink photos to about 200 KB before uploading.
  - `inv.record_wastage` accepts only keys under the caller's tenant and node.
- **Viewing.** The adjustment review screen, which is the approval screen, shows
  photos through 5-minute **presigned GET** URLs, issued only after
  `core.can('STOCK_ADJUSTMENTS', 'view', node)` and a key-prefix check.
- **Credentials.**
  - URLs are signed with the instance role, which has only `s3:PutObject` and
    `s3:GetObject` on `wastage/*` in that bucket. No AWS keys exist anywhere.
  - With `PHOTO_BUCKET` unset (local dev), photo capture is off. Wastage that needs a
    photo can't be recorded there.
- **Cost:** under $0.01 per month of credits (docs/deploy.md).

## Deploy configuration

- **All deploy context is in `infra/cdk.json`**, so a deploy is just `pnpm cdk deploy`,
  and CI synth uses the same values. A test validates `cdk.json` as a complete config.
- **`amiId` pins the instance image.** Before this, a deploy after AWS published a new
  Amazon Linux 2023 image would have replaced the instance. A test fails if the
  instance's `ImageId` isn't the context value, or if an SSM AMI lookup reappears.

## Known gaps

- **The AI agent can't create a PO subject.** Rule 6 allows it only `wf.submit` and
  `ai.recommendation`. The AI prompt must decide how a recommendation becomes a draft:
  a human accepts it, or the agent is allowed a narrow draft insert.
- **Consumption is not recorded yet.** There is no POS. It is derived from closing
  counts, as the LLD says.
- **Items, suppliers, par levels, tolerances and thresholds are read-only in the app.**
  Onboarding sets them; admin screens come later.
