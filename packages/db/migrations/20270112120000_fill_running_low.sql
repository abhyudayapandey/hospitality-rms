-- migrate:up
-- "Fill all short items" fills every item that is running low (ADR 145, KI-05): one under its
-- par up to par; one at or over par that lasts 3 days or fewer at the last 14 days' use, by a
-- week's use. The order form (inv.suggested_order) and Send stock (inv.send_items, whose
-- to_keep is what the department should end with) both read it.

create function inv.fill_qty(p_on_hand numeric, p_par numeric, p_used numeric,
                             p_durable boolean default false) returns numeric
language sql immutable set search_path = '' as $$
  select case
           when coalesce(p_par, 0) > 0 and coalesce(p_on_hand, 0) < p_par
             then p_par - coalesce(p_on_hand, 0)
           when inv.running_low(p_on_hand, 0, p_used, p_durable)
             then greatest(ceil(p_used * 7 / 14) - greatest(coalesce(p_on_hand, 0), 0), 0)
           else 0
         end
$$;
grant execute on function inv.fill_qty(numeric, numeric, numeric, boolean) to app_rw, wf_executor;

create or replace function inv.suggested_order(p_node uuid)
 returns table(item_id uuid, on_hand numeric, par_level numeric, open_po_qty numeric,
               suggested_qty numeric, preferred_supplier_id uuid, last_unit_cost numeric)
 language plpgsql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv', 'wf'
as $function$
begin
  perform wf.me();
  perform inv.require('PURCHASE_ORDERS', 'view', p_node);
  return query
  with open_po as (
    select pl.item_id, sum(pl.qty - coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                                where gl.po_line_id = pl.id), 0)) as qty
      from inv.purchase_order_line pl
      join inv.purchase_order po on po.id = pl.po_id
     where po.delivery_node_id = p_node and po.status in ('submitted', 'released')
     group by pl.item_id
  )
  select n.item_id, coalesce(s.on_hand, 0), n.par_level, greatest(coalesce(o.qty, 0), 0),
         greatest(inv.fill_qty(coalesce(s.on_hand, 0), n.par_level,
                               inv.recent_use(n.item_id, p_node), i.durable)
                  - greatest(coalesce(o.qty, 0), 0), 0),
         n.preferred_supplier_id,
         (select pl.unit_cost from inv.purchase_order_line pl
           where pl.item_id = n.item_id and pl.delivery_node_id = p_node
           order by pl.created_at desc limit 1)
    from inv.item_node n
    join inv.item i on i.id = n.item_id and i.archived_at is null
    left join inv.stock_level s on s.item_id = n.item_id and s.delivery_node_id = p_node
    left join open_po o on o.item_id = n.item_id
   where n.delivery_node_id = p_node and n.archived_at is null;
end $function$;

create or replace function inv.send_items(p_from uuid, p_to uuid)
 returns table(item_id uuid, name text, base_uom text, on_hand numeric, item_group text,
               to_on_hand numeric, to_keep numeric)
 language sql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv'
as $function$
  select x.item_id, x.name, x.base_uom, x.on_hand, x.item_group,
         coalesce(s.on_hand, 0),
         -- what the department should end with: its par, or a week's use when it runs low
         greatest(coalesce(s.on_hand, 0), 0)
           + inv.fill_qty(coalesce(s.on_hand, 0), n.par_level, inv.recent_use(x.item_id, p_to),
                          i.durable)
    from inv.sendable_items(p_from, p_to) x
    join inv.item i on i.id = x.item_id
    left join inv.item_node n on n.item_id = x.item_id and n.delivery_node_id = p_to
                             and n.archived_at is null
    left join inv.stock_level s on s.item_id = x.item_id and s.delivery_node_id = p_to
   where exists (select 1 from inv.send_destinations(p_from) d where d.id = p_to)
   order by inv.own_group(x.item_group, p_to) desc,
            inv.running_low(coalesce(s.on_hand, 0), n.par_level, inv.recent_use(x.item_id, p_to),
                            i.durable) desc,
            x.name;
$function$;

-- migrate:down
create or replace function inv.send_items(p_from uuid, p_to uuid)
 returns table(item_id uuid, name text, base_uom text, on_hand numeric, item_group text,
               to_on_hand numeric, to_keep numeric)
 language sql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv'
as $function$
  select x.item_id, x.name, x.base_uom, x.on_hand, x.item_group,
         coalesce(s.on_hand, 0), coalesce(n.par_level, 0)
    from inv.sendable_items(p_from, p_to) x
    left join inv.item_node n on n.item_id = x.item_id and n.delivery_node_id = p_to
                             and n.archived_at is null
    left join inv.stock_level s on s.item_id = x.item_id and s.delivery_node_id = p_to
   where exists (select 1 from inv.send_destinations(p_from) d where d.id = p_to)
   order by inv.own_group(x.item_group, p_to) desc,
            (coalesce(n.par_level, 0) > 0 and coalesce(s.on_hand, 0) < n.par_level) desc,
            x.name;
$function$;

create or replace function inv.suggested_order(p_node uuid)
 returns table(item_id uuid, on_hand numeric, par_level numeric, open_po_qty numeric,
               suggested_qty numeric, preferred_supplier_id uuid, last_unit_cost numeric)
 language plpgsql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv', 'wf'
as $function$
begin
  perform wf.me();
  perform inv.require('PURCHASE_ORDERS', 'view', p_node);
  return query
  with open_po as (
    select pl.item_id, sum(pl.qty - coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                                where gl.po_line_id = pl.id), 0)) as qty
      from inv.purchase_order_line pl
      join inv.purchase_order po on po.id = pl.po_id
     where po.delivery_node_id = p_node and po.status in ('submitted', 'released')
     group by pl.item_id
  )
  select n.item_id, coalesce(s.on_hand, 0), n.par_level, greatest(coalesce(o.qty, 0), 0),
         greatest(n.par_level - coalesce(s.on_hand, 0) - greatest(coalesce(o.qty, 0), 0), 0),
         n.preferred_supplier_id,
         (select pl.unit_cost from inv.purchase_order_line pl
           where pl.item_id = n.item_id and pl.delivery_node_id = p_node
           order by pl.created_at desc limit 1)
    from inv.item_node n
    join inv.item i on i.id = n.item_id and i.archived_at is null
    left join inv.stock_level s on s.item_id = n.item_id and s.delivery_node_id = p_node
    left join open_po o on o.item_id = n.item_id
   where n.delivery_node_id = p_node and n.archived_at is null;
end $function$;

drop function inv.fill_qty(numeric, numeric, numeric, boolean);
