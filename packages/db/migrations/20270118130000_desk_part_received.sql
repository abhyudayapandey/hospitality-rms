-- migrate:up
-- The order desk's "To receive" says when part of an order came already (SK-06, ADR 164):
-- inv.desk_orders gains part_received, and the list shows a "Part received" tag, as Orders
-- does for a partly received order.
drop function inv.desk_orders();
create function inv.desk_orders()
 RETURNS TABLE(po_id uuid, store_id uuid, store text, requested_by text, requested_at timestamp with time zone, supplier text, expected_on date, stage text, items text, unusual boolean, part_received boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'wf'
AS $function$
begin
  perform wf.me();
  return query
    select po.id, po.delivery_node_id, core.node_name(po.delivery_node_id),
           (select u.display_name from core.app_user u where u.id = po.created_by),
           po.created_at, s.name, po.expected_on,
           case when po.ordered_at is null then 'to_order' else 'to_receive' end,
           (select string_agg(i.name, ', ' order by i.name)
              from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
             where pl.po_id = po.id),
           coalesce((select (q.payload ->> 'unusual')::boolean from wf.request q
                      where q.id = po.wf_request_id), false),
           -- some of it came already: "Part received" (SK-06, ADR 164)
           exists (select 1 from inv.goods_receipt_line gl
                     join inv.purchase_order_line pl on pl.id = gl.po_line_id
                    where pl.po_id = po.id and gl.qty > 0)
      from inv.purchase_order po
      left join inv.supplier s on s.id = po.supplier_id
      cross join lateral (select inv.desk_keepers(inv.order_desk(po.delivery_node_id)) k) d
     where po.tenant_id = core.my_tenant() and po.status = 'released'
       and po.closed_at is null
       and core.can('PURCHASE_ORDERS', 'modify', null, inv.order_desk(po.delivery_node_id))
       and (po.ordered_at is null
            or (exists (select 1 from inv.purchase_order_line pl
                         where pl.po_id = po.id
                           and coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                          where gl.po_line_id = pl.id), 0) < pl.qty)
                and (cardinality(d.k) = 0 or core.current_user_id() = any (d.k))))
     order by (po.ordered_at is null) desc, po.expected_on nulls first, po.created_at;
end $function$;
revoke execute on function inv.desk_orders() from public;
grant execute on function inv.desk_orders() to app_rw;

-- migrate:down
drop function inv.desk_orders();
create function inv.desk_orders()
 RETURNS TABLE(po_id uuid, store_id uuid, store text, requested_by text, requested_at timestamp with time zone, supplier text, expected_on date, stage text, items text, unusual boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'wf'
AS $function$
begin
  perform wf.me();
  return query
    select po.id, po.delivery_node_id, core.node_name(po.delivery_node_id),
           (select u.display_name from core.app_user u where u.id = po.created_by),
           po.created_at, s.name, po.expected_on,
           case when po.ordered_at is null then 'to_order' else 'to_receive' end,
           (select string_agg(i.name, ', ' order by i.name)
              from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
             where pl.po_id = po.id),
           coalesce((select (q.payload ->> 'unusual')::boolean from wf.request q
                      where q.id = po.wf_request_id), false)
      from inv.purchase_order po
      left join inv.supplier s on s.id = po.supplier_id
      cross join lateral (select inv.desk_keepers(inv.order_desk(po.delivery_node_id)) k) d
     where po.tenant_id = core.my_tenant() and po.status = 'released'
       and po.closed_at is null
       and core.can('PURCHASE_ORDERS', 'modify', null, inv.order_desk(po.delivery_node_id))
       and (po.ordered_at is null
            or (exists (select 1 from inv.purchase_order_line pl
                         where pl.po_id = po.id
                           and coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                          where gl.po_line_id = pl.id), 0) < pl.qty)
                and (cardinality(d.k) = 0 or core.current_user_id() = any (d.k))))
     order by (po.ordered_at is null) desc, po.expected_on nulls first, po.created_at;
end $function$;
revoke execute on function inv.desk_orders() from public;
grant execute on function inv.desk_orders() to app_rw;
