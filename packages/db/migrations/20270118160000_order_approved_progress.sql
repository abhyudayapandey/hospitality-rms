-- migrate:up
-- An order says "approved" once its last approver said yes (GM-02b, ADR 164). The yes moved the
-- workflow on at once, but the order stayed 'submitted' until the executor released it a
-- minute later, so Orders, RFMs History and the desk read "waiting for approval" after the GM
-- had approved it (the leave pill had the same gap). The summary's progress is now 'approved'
-- in that minute, from the workflow's own state.

-- whether the order's approval is done (the executor has not released it yet); only for an
-- order of the caller's company
create function inv.po_approved(p_po uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
  select exists (select 1 from inv.purchase_order p join wf.request r on r.id = p.wf_request_id
                  where p.id = p_po and p.tenant_id = core.my_tenant()
                    and r.state in ('approved', 'executing', 'completed'));
$$;
revoke execute on function inv.po_approved(uuid) from public;
grant execute on function inv.po_approved(uuid) to app_rw;

create or replace view inv.purchase_order_summary with (security_invoker = true) as
SELECT po.id,
    po.tenant_id,
    po.delivery_node_id,
    po.supplier_id,
    po.status,
    po.total,
    po.currency,
    po.notes,
    po.created_at,
    po.created_by,
    po.released_at,
    po.wf_request_id,
    r.ordered_qty,
    r.received_qty,
        CASE
            WHEN (po.closed_at IS NOT NULL) THEN
            CASE
                WHEN (po.ordered_at IS NULL) THEN 'withdrawn'::text
                ELSE 'closed'::text
            END
            WHEN (po.status = 'submitted'::text AND inv.po_approved(po.id)) THEN 'approved'::text
            WHEN (po.status = 'submitted'::text) THEN 'awaiting_approval'::text
            WHEN (po.status <> 'released'::text) THEN po.status
            WHEN (po.ordered_at IS NULL) THEN 'to_order'::text
            WHEN (r.received_qty = (0)::numeric) THEN 'released'::text
            WHEN (r.lines_open > 0) THEN 'partially_received'::text
            ELSE 'received'::text
        END AS progress,
    po.expected_on,
    po.ordered_at,
    po.request_po_id,
    po.closed_at,
    po.close_reason
   FROM (inv.purchase_order po
     CROSS JOIN LATERAL ( SELECT sum(pl.qty) AS ordered_qty,
            COALESCE(sum(rec.qty), (0)::numeric) AS received_qty,
            count(*) FILTER (WHERE (COALESCE(rec.qty, (0)::numeric) < pl.qty)) AS lines_open
           FROM (inv.purchase_order_line pl
             LEFT JOIN LATERAL ( SELECT sum(gl.qty) AS qty
                   FROM inv.goods_receipt_line gl
                  WHERE (gl.po_line_id = pl.id)) rec ON (true))
          WHERE (pl.po_id = po.id)) r);

-- migrate:down
create or replace view inv.purchase_order_summary with (security_invoker = true) as
SELECT po.id,
    po.tenant_id,
    po.delivery_node_id,
    po.supplier_id,
    po.status,
    po.total,
    po.currency,
    po.notes,
    po.created_at,
    po.created_by,
    po.released_at,
    po.wf_request_id,
    r.ordered_qty,
    r.received_qty,
        CASE
            WHEN (po.closed_at IS NOT NULL) THEN
            CASE
                WHEN (po.ordered_at IS NULL) THEN 'withdrawn'::text
                ELSE 'closed'::text
            END
            WHEN (po.status = 'submitted'::text) THEN 'awaiting_approval'::text
            WHEN (po.status <> 'released'::text) THEN po.status
            WHEN (po.ordered_at IS NULL) THEN 'to_order'::text
            WHEN (r.received_qty = (0)::numeric) THEN 'released'::text
            WHEN (r.lines_open > 0) THEN 'partially_received'::text
            ELSE 'received'::text
        END AS progress,
    po.expected_on,
    po.ordered_at,
    po.request_po_id,
    po.closed_at,
    po.close_reason
   FROM (inv.purchase_order po
     CROSS JOIN LATERAL ( SELECT sum(pl.qty) AS ordered_qty,
            COALESCE(sum(rec.qty), (0)::numeric) AS received_qty,
            count(*) FILTER (WHERE (COALESCE(rec.qty, (0)::numeric) < pl.qty)) AS lines_open
           FROM (inv.purchase_order_line pl
             LEFT JOIN LATERAL ( SELECT sum(gl.qty) AS qty
                   FROM inv.goods_receipt_line gl
                  WHERE (gl.po_line_id = pl.id)) rec ON (true))
          WHERE (pl.po_id = po.id)) r);
drop function inv.po_approved(uuid);
