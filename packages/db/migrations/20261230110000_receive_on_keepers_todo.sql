-- migrate:up

-- One person told to receive (ADR 148). An order to receive was on the To do list of everyone
-- who may receive at its order desk: the keeper, the GM, the Purchase Manager, the Executive
-- Chef. Now it is the desk's keepers' (core.site_group_holders, as inv.notify_desk tells
-- them); the others still see it in Orders. A desk with no keeper keeps it as before.

create function inv.desk_keepers(p_desk uuid) returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce(array_agg(h), '{}')
    from core.security_group g, core.site_group_holders(g.id, p_desk) h
   where g.code = 'STORE_KEEPER'
     and g.tenant_id = (select tenant_id from core.hierarchy_node where id = p_desk);
$$;
revoke execute on function inv.desk_keepers(uuid) from public;

create or replace function inv.desk_orders()
returns table (po_id uuid, store_id uuid, store text, requested_by text, requested_at timestamptz,
               supplier text, expected_on date, stage text, items text, unusual boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
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
end $$;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
create or replace function inv.desk_orders()
returns table (po_id uuid, store_id uuid, store text, requested_by text, requested_at timestamptz,
               supplier text, expected_on date, stage text, items text, unusual boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
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
     where po.tenant_id = core.my_tenant() and po.status = 'released'
       and po.closed_at is null
       and core.can('PURCHASE_ORDERS', 'modify', null, inv.order_desk(po.delivery_node_id))
       and (po.ordered_at is null
            or exists (select 1 from inv.purchase_order_line pl
                        where pl.po_id = po.id
                          and coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                         where gl.po_line_id = pl.id), 0) < pl.qty))
     order by (po.ordered_at is null) desc, po.expected_on nulls first, po.created_at;
end $$;
drop function inv.desk_keepers(uuid);
