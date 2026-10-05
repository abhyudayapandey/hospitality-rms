-- migrate:up

-- UX audit 3, P2 (ADR 053).
--  1. Asking for supplies says who orders them: the outlet's Main Store, or the store itself
--     where there is none (inv.order_desk_name).
--  2. Send stock shows what the department has and keeps of each item, its short items first,
--     so the keeper can fill it to its keep level (inv.send_items, two more columns).
--  3. The GM's notice of a new order says "about ₹": the price is the last one paid.

-- The Main Store that orders for p_node's supply requests, by name; null when p_node orders
-- for itself (it is the Main Store, or its outlet has none). Any store of the caller's company.
create function inv.order_desk_name(p_node uuid) returns text
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select case when d.id = n.id then null else d.name end
    from core.hierarchy_node n
    join core.hierarchy_node d on d.id = inv.order_desk(n.id)
   where n.id = p_node and n.tenant_id = core.my_tenant();
$$;
revoke execute on function inv.order_desk_name(uuid) from public;
grant execute on function inv.order_desk_name(uuid) to app_rw;

drop function inv.send_items(uuid, uuid);
create function inv.send_items(p_from uuid, p_to uuid)
returns table (item_id uuid, name text, base_uom text, on_hand numeric, item_group text,
               to_on_hand numeric, to_keep numeric)
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
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
$$;
revoke execute on function inv.send_items(uuid, uuid) from public;
grant execute on function inv.send_items(uuid, uuid) to app_rw;

-- 3. The GM's notice of a new order gives its money as an estimate: "about ₹" (ADR 053).
do $$
declare
  v_def text := pg_get_functiondef('inv.notify_order(uuid, uuid)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def, $a$format('To %s, ₹%s,'$a$, $a$format('To %s, about ₹%s,'$a$);
  if v_new = v_def then raise exception 'inv.notify_order changed'; end if;
  execute v_new;
end $$;

-- migrate:down
do $$
declare
  v_def text := pg_get_functiondef('inv.notify_order(uuid, uuid)'::regprocedure);
begin
  execute replace(v_def, $a$format('To %s, about ₹%s,'$a$, $a$format('To %s, ₹%s,'$a$);
end $$;
drop function inv.send_items(uuid, uuid);
create function inv.send_items(p_from uuid, p_to uuid)
returns table (item_id uuid, name text, base_uom text, on_hand numeric, item_group text)
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select x.item_id, x.name, x.base_uom, x.on_hand, x.item_group
    from inv.sendable_items(p_from, p_to) x
   where exists (select 1 from inv.send_destinations(p_from) d where d.id = p_to);
$$;
revoke execute on function inv.send_items(uuid, uuid) from public;
grant execute on function inv.send_items(uuid, uuid) to app_rw;
drop function inv.order_desk_name(uuid);
