-- migrate:up

-- The Main Store's materials go to every department that may need them (ADR 051 addendum).
-- Sending stock (and asking the Main Store for stock) listed only the items already set up at
-- both stores, so the bar could not get ketchup, foil or cling film. Now the list is what the
-- Main Store holds, by who may use it:
--   housekeeping-only items (set up only at housekeeping stores: linen, guest amenities) go to
--     housekeeping stores only;
--   food-and-drink-only items (set up only at kitchen or service stores) go to those only;
--   everything else (shared, or set up at no department yet) goes to all.
-- The first time an item goes to a store it is set up there (par 0).

-- The kind of team that uses a store: kitchen, service, housekeeping, other (ADR 033).
create function inv.store_team_type(p_store uuid) returns text
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select coalesce(o.department_type, 'other')
    from core.hierarchy_node o where o.id = ops.team_of_store(p_store);
$$;
revoke execute on function inv.store_team_type(uuid) from public;

-- The items p_from may give p_to, by the rule above. No access check: callers check.
create function inv.sendable_items(p_from uuid, p_to uuid)
returns table (item_id uuid, name text, base_uom text, on_hand numeric, set_up boolean)
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  with dest as (
    select case inv.store_team_type(p_to) when 'housekeeping' then 'housekeeping'
                                          when 'kitchen' then 'fnb'
                                          when 'service' then 'fnb' else 'any' end as kind
  ),
  uses as (
    -- per item, which kinds of department store in this site have it set up
    select x.item_id,
           bool_or(t.kind = 'housekeeping') as hk,
           bool_or(t.kind = 'fnb') as fnb
      from inv.item_node x
      cross join lateral (
        select case inv.store_team_type(x.delivery_node_id) when 'housekeeping' then 'housekeeping'
                                                            when 'kitchen' then 'fnb'
                                                            when 'service' then 'fnb' else 'other' end as kind
      ) t
     where x.archived_at is null and x.delivery_node_id <> p_from
       and core.stock_site(x.delivery_node_id) = core.stock_site(p_from)
     group by x.item_id
  )
  select i.id, i.name, i.base_uom, coalesce(s.on_hand, 0),
         exists (select 1 from inv.item_node t where t.item_id = i.id
                  and t.delivery_node_id = p_to and t.archived_at is null)
    from inv.item_node f
    join inv.item i on i.id = f.item_id and i.archived_at is null
    left join inv.stock_level s on s.item_id = f.item_id and s.delivery_node_id = p_from
    left join uses u on u.item_id = f.item_id
    cross join dest d
   where f.delivery_node_id = p_from and f.archived_at is null
     and case d.kind
           when 'fnb' then not (coalesce(u.hk, false) and not coalesce(u.fnb, false))
           when 'housekeeping' then not (coalesce(u.fnb, false) and not coalesce(u.hk, false))
           else true end
   order by i.name;
$$;
revoke execute on function inv.sendable_items(uuid, uuid) from public;

-- Sets p_lines' items up at p_to where p_from may give them and they are not yet (par 0).
create function inv.set_up_sent_items(p_from uuid, p_to uuid, p_lines jsonb) returns void
language sql security definer
set search_path = pg_catalog, core, inv
as $$
  insert into inv.item_node (tenant_id, item_id, delivery_node_id)
  select core.my_tenant(), x.item_id, p_to
    from inv.sendable_items(p_from, p_to) x
   where not x.set_up
     and x.item_id in (select (e ->> 'item_id')::uuid from jsonb_array_elements(p_lines) e)
  on conflict (tenant_id, item_id, delivery_node_id) do update set archived_at = null;
$$;
revoke execute on function inv.set_up_sent_items(uuid, uuid, jsonb) from public;

-- Send stock lists what the Main Store holds, by the rule (was: set up at both stores).
create or replace function inv.send_items(p_from uuid, p_to uuid)
returns table (item_id uuid, name text, base_uom text, on_hand numeric)
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select x.item_id, x.name, x.base_uom, x.on_hand
    from inv.sendable_items(p_from, p_to) x
   where exists (select 1 from inv.send_destinations(p_from) d where d.id = p_to);
$$;

-- What p_to can ask p_from for: its own items, and from its outlet's Main Store whatever the
-- Main Store may give it. On hand is at p_to.
create function inv.request_items(p_to uuid, p_from uuid)
returns table (item_id uuid, name text, base_uom text, on_hand numeric, avg_cost numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
begin
  perform wf.me();
  perform inv.require('TRANSFERS', 'modify', p_to);
  return query
    select i.id, i.name, i.base_uom, coalesce(s.on_hand, 0), coalesce(s.avg_cost, 0)
      from inv.item i
      left join inv.stock_level s on s.item_id = i.id and s.delivery_node_id = p_to
     where i.tenant_id = core.my_tenant() and i.archived_at is null
       and (exists (select 1 from inv.item_node n where n.item_id = i.id
                     and n.delivery_node_id = p_to and n.archived_at is null)
            or (p_from is not null and inv.is_main_store(p_from)
                and exists (select 1 from inv.transfer_sources(p_to) src where src.id = p_from)
                and exists (select 1 from inv.sendable_items(p_from, p_to) x
                             where x.item_id = i.id)))
     order by i.name;
end $$;
revoke execute on function inv.request_items(uuid, uuid) from public;
grant execute on function inv.request_items(uuid, uuid) to app_rw;

-- inv.send_stock and inv.request_transfer set the items up at the receiving store first.
do $$
declare
  v_def text := pg_get_functiondef('inv.send_stock(uuid, uuid, jsonb, text)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def, $a$  v_team := ops.team_of_store(p_to);
$a$, $a$  v_team := ops.team_of_store(p_to);
  perform inv.set_up_sent_items(p_from, p_to, p_lines);
$a$);
  if v_new = v_def then
    raise exception 'inv.send_stock changed';
  end if;
  execute v_new;

  v_def := pg_get_functiondef('inv.request_transfer(uuid, uuid, jsonb, text)'::regprocedure);
  v_new := replace(v_def, $a$  perform inv.check_lines(p_lines, p_to);
$a$, $a$  if inv.is_main_store(p_from) and jsonb_typeof(p_lines) = 'array' then
    perform inv.set_up_sent_items(p_from, p_to, p_lines);
  end if;
  perform inv.check_lines(p_lines, p_to);
$a$);
  if v_new = v_def then
    raise exception 'inv.request_transfer changed';
  end if;
  execute v_new;
end $$;

-- migrate:down
do $$
declare
  v_def text := pg_get_functiondef('inv.send_stock(uuid, uuid, jsonb, text)'::regprocedure);
begin
  execute replace(v_def, $a$  perform inv.set_up_sent_items(p_from, p_to, p_lines);
$a$, '');
  v_def := pg_get_functiondef('inv.request_transfer(uuid, uuid, jsonb, text)'::regprocedure);
  execute replace(v_def, $a$  if inv.is_main_store(p_from) and jsonb_typeof(p_lines) = 'array' then
    perform inv.set_up_sent_items(p_from, p_to, p_lines);
  end if;
$a$, '');
end $$;
drop function inv.request_items(uuid, uuid);
create or replace function inv.send_items(p_from uuid, p_to uuid)
returns table (item_id uuid, name text, base_uom text, on_hand numeric)
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select i.id, i.name, i.base_uom, coalesce(s.on_hand, 0)
    from inv.item_node f
    join inv.item_node t on t.item_id = f.item_id and t.delivery_node_id = p_to
                        and t.archived_at is null
    join inv.item i on i.id = f.item_id and i.archived_at is null
    left join inv.stock_level s on s.item_id = f.item_id and s.delivery_node_id = p_from
   where f.delivery_node_id = p_from and f.archived_at is null
     and exists (select 1 from inv.send_destinations(p_from) d where d.id = p_to)
   order by i.name;
$$;
drop function inv.set_up_sent_items(uuid, uuid, jsonb);
drop function inv.sendable_items(uuid, uuid);
drop function inv.store_team_type(uuid);
