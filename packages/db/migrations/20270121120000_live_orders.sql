-- migrate:up
-- Closed and dead orders are not coming (ADR 168, H14, H15, M22).
--
-- inv.order_for_request handed back any order for the request with no receipt yet, including
-- one the keeper closed (inv.close_order sets closed_at and leaves it released) and one whose
-- approval failed, was rejected or was cancelled: "Order it again" gave back the same dead
-- order. Two taps at once could also make two orders, nothing locking the request.
-- inv.suggested_order counted a closed order's missing rest as still coming, and a line received
-- over its order went below zero and cancelled what other orders were bringing.
--
-- A live order: not rejected or cancelled, not closed, and its approval neither failed, rejected
-- nor cancelled (inv.po_live). Only a live order is handed back or counted as coming; the
-- request is locked while its order is looked for. A unique index cannot say "live" (a failed
-- approval leaves the order submitted), so the lock is what keeps it to one.

create function inv.po_live(p_po inv.purchase_order) returns boolean
language sql stable
set search_path = pg_catalog, inv, wf
as $$
  select p_po.status in ('draft', 'submitted', 'released') and p_po.closed_at is null
         and not exists (select 1 from wf.request r
                          where r.id = p_po.wf_request_id
                            and r.state in ('failed', 'rejected', 'cancelled'));
$$;
revoke execute on function inv.po_live(inv.purchase_order) from public;

-- the request's live order, never a closed or dead one; the request locked first
select core.patch_function('inv.order_for_request(uuid,jsonb)',
$x$  select * into v_po from inv.purchase_order
   where for_transfer_id = p_transfer and status in ('draft', 'submitted', 'released')
     and not exists (select 1 from inv.goods_receipt g where g.po_id = inv.purchase_order.id);
  if found then$x$,
$x$  -- one at a time: a second tap waits, then finds the order the first made (ADR 168)
  perform 1 from inv.transfer where id = p_transfer for update;
  -- the request's order, or the one it was placed as (another supplier's part), if still live
  select po.* into v_po from inv.purchase_order po
   where (po.for_transfer_id = p_transfer
          or po.request_po_id in (select p.id from inv.purchase_order p
                                   where p.for_transfer_id = p_transfer))
     and inv.po_live(po)
     and not exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
   order by po.created_at desc, po.id desc limit 1;
  if found then$x$);

-- where the request is: a closed order is not being ordered; the newest order speaks (on top of
-- ADR 167's failed-order rule)
select core.patch_function('inv.now_of(uuid,integer)',
$x$   where po.for_transfer_id = p_transfer
     and (po.status in ('submitted', 'released')
          or (po.status = 'cancelled' and po.closed_at is null
              and exists (select 1 from wf.request q
                           where q.id = po.wf_request_id and q.state = 'failed')))
     and not exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
   order by po.created_at desc, po.id desc limit 1;$x$,
$x$   where po.for_transfer_id = p_transfer
     and (po.status in ('submitted', 'released')
          or (po.status = 'cancelled' and po.closed_at is null
              and exists (select 1 from wf.request q
                           where q.id = po.wf_request_id and q.state = 'failed')))
     and po.closed_at is null
     and not exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
   order by po.created_at desc, po.id desc limit 1;$x$);

-- what is still coming: live orders only, each line's rest never below nothing
select core.patch_function('inv.suggested_order(uuid)',
$x$    select pl.item_id, sum(pl.qty - coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                                where gl.po_line_id = pl.id), 0)) as qty
      from inv.purchase_order_line pl
      join inv.purchase_order po on po.id = pl.po_id
     where po.delivery_node_id = p_node and po.status in ('submitted', 'released')$x$,
$x$    select pl.item_id,
           sum(greatest(pl.qty - coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                            where gl.po_line_id = pl.id), 0), 0)) as qty
      from inv.purchase_order_line pl
      join inv.purchase_order po on po.id = pl.po_id
     where po.delivery_node_id = p_node and po.status in ('submitted', 'released')
       and inv.po_live(po)$x$);

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
select core.patch_function('inv.suggested_order(uuid)',
$x$    select pl.item_id,
           sum(greatest(pl.qty - coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                            where gl.po_line_id = pl.id), 0), 0)) as qty
      from inv.purchase_order_line pl
      join inv.purchase_order po on po.id = pl.po_id
     where po.delivery_node_id = p_node and po.status in ('submitted', 'released')
       and inv.po_live(po)$x$,
$x$    select pl.item_id, sum(pl.qty - coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                                where gl.po_line_id = pl.id), 0)) as qty
      from inv.purchase_order_line pl
      join inv.purchase_order po on po.id = pl.po_id
     where po.delivery_node_id = p_node and po.status in ('submitted', 'released')$x$);
select core.patch_function('inv.now_of(uuid,integer)',
$x$   where po.for_transfer_id = p_transfer
     and (po.status in ('submitted', 'released')
          or (po.status = 'cancelled' and po.closed_at is null
              and exists (select 1 from wf.request q
                           where q.id = po.wf_request_id and q.state = 'failed')))
     and po.closed_at is null
     and not exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
   order by po.created_at desc, po.id desc limit 1;$x$,
$x$   where po.for_transfer_id = p_transfer
     and (po.status in ('submitted', 'released')
          or (po.status = 'cancelled' and po.closed_at is null
              and exists (select 1 from wf.request q
                           where q.id = po.wf_request_id and q.state = 'failed')))
     and not exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
   order by po.created_at desc, po.id desc limit 1;$x$);
select core.patch_function('inv.order_for_request(uuid,jsonb)',
$x$  -- one at a time: a second tap waits, then finds the order the first made (ADR 168)
  perform 1 from inv.transfer where id = p_transfer for update;
  -- the request's order, or the one it was placed as (another supplier's part), if still live
  select po.* into v_po from inv.purchase_order po
   where (po.for_transfer_id = p_transfer
          or po.request_po_id in (select p.id from inv.purchase_order p
                                   where p.for_transfer_id = p_transfer))
     and inv.po_live(po)
     and not exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
   order by po.created_at desc, po.id desc limit 1;$x$,
$x$  select * into v_po from inv.purchase_order
   where for_transfer_id = p_transfer and status in ('draft', 'submitted', 'released')
     and not exists (select 1 from inv.goods_receipt g where g.po_id = inv.purchase_order.id);$x$);
drop function inv.po_live(inv.purchase_order);
