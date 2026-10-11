-- migrate:up
-- Stock movements (ADR 122): for a store, or all of an outlet's stores together, what was
-- ordered from suppliers, what was received and what went between stores, in any period of
-- business days. One line per order, receipt or transfer with its items. Opened by those who
-- open the purchasing report there (the GM, the stores' cost readers, whoever reads their
-- bills: the accountant, the purchase manager); with Stock in the plan, Buying or not.

-- The stores a movements report at a place covers: the store itself, or each store of an
-- outlet (or hub) the person may open it at.
create function rpt.movement_stores(p_place uuid) returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core, rpt, extensions
as $$
  select coalesce(array_agg(s.id order by s.name), '{}')
    from core.hierarchy_node p
    join core.hierarchy_node s on s.type = 'delivery' and s.path operator(extensions.<@) p.path
   where p.id = p_place and p.type = 'delivery' and p.tenant_id = core.my_tenant()
     and s.holds_stock and s.archived_at is null
     and (s.id = p.id or core.stock_site(s.id) = p.id)
     and (rpt.store_cost_access(s.id) or core.report_can('BILLS', 'view', null, s.id));
$$;

select core.patch_function('rpt.can_open(text, uuid)',
  $x$             -- R-3 (ADR 030)
             when 'labour_cost' then$x$,
  $x$             -- what was ordered, received and moved (ADR 122)
             when 'movements' then core.module_on(n.tenant_id, 'stock') and
               n.type = 'delivery'
               and ((n.holds_stock and cardinality(rpt.movement_stores(n.id)) = 1)
                    or (n.kind in ('outlet', 'hub')
                        and cardinality(rpt.movement_stores(n.id)) >= 2))
             -- R-3 (ADR 030)
             when 'labour_cost' then$x$);

select core.patch_function('rpt.report_places(text)',
  $x$elsif p_report in ('stock_position', 'purchasing') then$x$,
  $x$elsif p_report in ('stock_position', 'purchasing', 'movements') then$x$);
select core.patch_function('rpt.report_places(text)',
  $x$if p_report = 'purchasing' then$x$,
  $x$if p_report in ('purchasing', 'movements') then$x$);
select core.patch_function('rpt.report_places(text)',
  $x$if p_report = 'stock_position' then$x$,
  $x$if p_report in ('stock_position', 'movements') then$x$);

create or replace function rpt.my_reports()
returns table (report text)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select v.r from (values (0, 'league'), (1, 'outlet_flash'), (2, 'department'), (3, 'cost_of_sales'),
                          (4, 'menu_engineering'), (5, 'stock_position'), (6, 'purchasing'),
                          (7, 'movements'), (8, 'central_kitchen'), (9, 'people'),
                          (10, 'my_week')) v(o, r)
   where case v.r
           when 'my_week' then exists (select 1 from hr.worker w
                                        where w.owner_user_id = core.current_user_id()
                                          and w.status = 'active')
           when 'stock_position' then core.module_on(core.my_tenant(), 'stock')
                                     and exists (select 1 from rpt.report_places(v.r))
           when 'movements' then core.module_on(core.my_tenant(), 'stock')
                                 and exists (select 1 from rpt.report_places(v.r))
           when 'purchasing' then core.module_on(core.my_tenant(), 'buying')
                                    and exists (select 1 from rpt.report_places(v.r))
           when 'cost_of_sales' then core.module_on(core.my_tenant(), 'menu_sales')
                                     and exists (select 1 from rpt.report_places(v.r))
           when 'league' then core.module_on(core.my_tenant(), 'menu_sales')
                              and exists (select 1 from rpt.report_places(v.r))
           when 'menu_engineering' then core.module_on(core.my_tenant(), 'menu_sales')
                                        and exists (select 1 from rpt.report_places(v.r))
           else exists (select 1 from rpt.report_places(v.r)) end
   order by v.o
$$;

-- The movements: one line per order placed, receipt and transfer sent, on the business day
-- it happened at its store. `direction` is in (to these stores), out (from them) or within
-- (between two of them); `value` is at the order's, receipt's or transfer's own prices.
create function rpt.stock_movements(p_place uuid, p_from date, p_to date)
returns table (kind text, id uuid, at timestamptz, day date, store text, other text,
               direction text, status text, value numeric, by_name text, lines jsonb)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
#variable_conflict use_column
declare
  v_stores uuid[];
begin
  if not rpt.can_open('movements', p_place) then
    raise exception 'NOT_AUTHORISED' using detail = format('movements at %s', p_place);
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    perform ops.fail('INVALID_VALUE', 'a period of a year at most');
  end if;
  v_stores := rpt.movement_stores(p_place);
  return query
  with po as (
    select o.*, coalesce(o.ordered_at, o.released_at) as placed_at
      from inv.purchase_order o
     where o.delivery_node_id = any (v_stores) and o.status = 'released'
       and coalesce(o.ordered_at, o.released_at) is not null
  ), tr as (
    select t.* from inv.transfer t
     where (t.from_node_id = any (v_stores) or t.to_node_id = any (v_stores))
       and t.dispatched_at is not null and t.status <> 'cancelled'
  )
  select 'ordered'::text, o.id, o.placed_at, rpt.business_date(o.placed_at, ops.tz_of(s.id)),
         s.name, sup.name, 'in'::text,
         case when o.closed_at is not null then 'closed'
              when not exists (select 1 from inv.goods_receipt g where g.po_id = o.id)
                then 'ordered'
              when exists (select 1 from inv.purchase_order_line pl
                            where pl.po_id = o.id
                              and pl.qty > coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                                      where gl.po_line_id = pl.id), 0))
                then 'part received'
              else 'received' end,
         o.total, u.display_name,
         coalesce((select jsonb_agg(jsonb_build_object(
                             'item', i.name, 'unit', i.base_uom, 'qty', pl.qty,
                             'value', round(pl.qty * pl.unit_cost, 2)) order by i.name)
                     from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
                    where pl.po_id = o.id), '[]')
    from po o
    join core.hierarchy_node s on s.id = o.delivery_node_id
    left join inv.supplier sup on sup.id = o.supplier_id
    left join core.app_user u on u.id = coalesce(o.ordered_by, o.created_by)
   where rpt.business_date(o.placed_at, ops.tz_of(s.id)) between p_from and p_to
  union all
  select 'received', g.id, g.received_at, rpt.business_date(g.received_at, ops.tz_of(s.id)),
         s.name, sup.name, 'in', null,
         coalesce((select round(sum((gl.qty + gl.excess_qty) * gl.unit_cost), 2)
                     from inv.goods_receipt_line gl where gl.receipt_id = g.id), 0),
         u.display_name,
         coalesce((select jsonb_agg(jsonb_build_object(
                             'item', i.name, 'unit', i.base_uom, 'qty', gl.qty + gl.excess_qty,
                             'value', round((gl.qty + gl.excess_qty) * gl.unit_cost, 2))
                           order by i.name)
                     from inv.goods_receipt_line gl join inv.item i on i.id = gl.item_id
                    where gl.receipt_id = g.id), '[]')
    from inv.goods_receipt g
    join core.hierarchy_node s on s.id = g.delivery_node_id
    join inv.purchase_order o on o.id = g.po_id
    left join inv.supplier sup on sup.id = o.supplier_id
    left join core.app_user u on u.id = g.created_by
   where g.delivery_node_id = any (v_stores)
     and rpt.business_date(g.received_at, ops.tz_of(s.id)) between p_from and p_to
  union all
  select 'transfer', t.id, t.dispatched_at, rpt.business_date(t.dispatched_at, ops.tz_of(f.id)),
         case when t.from_node_id = any (v_stores) then f.name else d.name end,
         case when t.from_node_id = any (v_stores) and t.to_node_id = any (v_stores) then d.name
              when t.from_node_id = any (v_stores) then d.name
              else f.name end,
         case when t.from_node_id = any (v_stores) and t.to_node_id = any (v_stores) then 'within'
              when t.from_node_id = any (v_stores) then 'out'
              else 'in' end,
         case when t.received_at is not null then 'received' else 'on the way' end,
         coalesce((select round(sum(coalesce(tl.dispatched_qty, 0) * coalesce(tl.unit_cost, 0)), 2)
                     from inv.transfer_line tl where tl.transfer_id = t.id), 0),
         u.display_name,
         coalesce((select jsonb_agg(jsonb_build_object(
                             'item', i.name, 'unit', i.base_uom, 'qty', tl.dispatched_qty,
                             'received', tl.received_qty,
                             'value', round(coalesce(tl.dispatched_qty, 0)
                                            * coalesce(tl.unit_cost, 0), 2)) order by i.name)
                     from inv.transfer_line tl join inv.item i on i.id = tl.item_id
                    where tl.transfer_id = t.id and coalesce(tl.dispatched_qty, 0) > 0), '[]')
    from tr t
    join core.hierarchy_node f on f.id = t.from_node_id
    join core.hierarchy_node d on d.id = t.to_node_id
    left join core.app_user u on u.id = coalesce(t.dispatched_by, t.created_by)
   where rpt.business_date(t.dispatched_at, ops.tz_of(f.id)) between p_from and p_to
   order by 3 desc;
end $$;

revoke execute on function rpt.movement_stores(uuid), rpt.stock_movements(uuid, date, date)
  from public;
grant execute on function rpt.stock_movements(uuid, date, date) to app_rw;

-- migrate:down
drop function rpt.stock_movements(uuid, date, date);
create or replace function rpt.my_reports()
returns table (report text)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select v.r from (values (0, 'league'), (1, 'outlet_flash'), (2, 'department'), (3, 'cost_of_sales'),
                          (4, 'menu_engineering'), (5, 'stock_position'), (6, 'purchasing'),
                          (7, 'central_kitchen'), (8, 'people'), (9, 'my_week')) v(o, r)
   where case v.r
           when 'my_week' then exists (select 1 from hr.worker w
                                        where w.owner_user_id = core.current_user_id()
                                          and w.status = 'active')
           when 'stock_position' then core.module_on(core.my_tenant(), 'stock')
                                     and exists (select 1 from rpt.report_places(v.r))
           when 'purchasing' then core.module_on(core.my_tenant(), 'buying')
                                    and exists (select 1 from rpt.report_places(v.r))
           when 'cost_of_sales' then core.module_on(core.my_tenant(), 'menu_sales')
                                     and exists (select 1 from rpt.report_places(v.r))
           when 'league' then core.module_on(core.my_tenant(), 'menu_sales')
                              and exists (select 1 from rpt.report_places(v.r))
           when 'menu_engineering' then core.module_on(core.my_tenant(), 'menu_sales')
                                        and exists (select 1 from rpt.report_places(v.r))
           else exists (select 1 from rpt.report_places(v.r)) end
   order by v.o
$$;
select core.patch_function('rpt.report_places(text)',
  $x$if p_report in ('stock_position', 'movements') then$x$,
  $x$if p_report = 'stock_position' then$x$);
select core.patch_function('rpt.report_places(text)',
  $x$if p_report in ('purchasing', 'movements') then$x$,
  $x$if p_report = 'purchasing' then$x$);
select core.patch_function('rpt.report_places(text)',
  $x$elsif p_report in ('stock_position', 'purchasing', 'movements') then$x$,
  $x$elsif p_report in ('stock_position', 'purchasing') then$x$);
select core.patch_function('rpt.can_open(text, uuid)',
  $x$             -- what was ordered, received and moved (ADR 122)
             when 'movements' then core.module_on(n.tenant_id, 'stock') and
               n.type = 'delivery'
               and ((n.holds_stock and cardinality(rpt.movement_stores(n.id)) = 1)
                    or (n.kind in ('outlet', 'hub')
                        and cardinality(rpt.movement_stores(n.id)) >= 2))
$x$, '');
drop function rpt.movement_stores(uuid);
