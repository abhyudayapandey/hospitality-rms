-- migrate:up
-- The staff ask (ADR 115) lists what the store keeps in the order of Ask for supplies (ADR 101,
-- 153): what runs short first, then by category. The list now says each item's category and par;
-- who may read it is unchanged.
drop function inv.ask_store_items(uuid);
create function inv.ask_store_items(p_store uuid)
returns table (item_id uuid, name text, base_uom text, on_hand numeric, category text,
               par numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not exists (select 1 from inv.my_ask_stores() s where s.id = p_store) then
    perform inv.fail('NOT_AUTHORISED', 'ask the store your team uses');
  end if;
  return query
    select i.id, i.name, i.base_uom, coalesce(sl.on_hand, 0), i.category, n.par_level
      from inv.item_node n
      join inv.item i on i.id = n.item_id and i.archived_at is null
      left join inv.stock_level sl on sl.item_id = i.id and sl.delivery_node_id = p_store
     where n.delivery_node_id = p_store and n.archived_at is null
     order by i.name;
end $$;
revoke execute on function inv.ask_store_items(uuid) from public;
grant execute on function inv.ask_store_items(uuid) to app_rw;

-- The kind of outlet the person works at (its outlet_format: hotel, restaurant, bar_pub, ...),
-- for words that fit it: a hotel's note gives a room as its example, elsewhere a table.
create function core.my_outlet_format() returns text
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select o.outlet_format from core.hierarchy_node o
   where o.id = core.nearest((select h.id from core.my_home() h limit 1), array['outlet'])
     and o.tenant_id = core.my_tenant();
$$;
revoke execute on function core.my_outlet_format() from public, platform_loader;
grant execute on function core.my_outlet_format() to app_rw;

-- migrate:down
drop function core.my_outlet_format();
drop function inv.ask_store_items(uuid);
create function inv.ask_store_items(p_store uuid)
returns table (item_id uuid, name text, base_uom text, on_hand numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not exists (select 1 from inv.my_ask_stores() s where s.id = p_store) then
    perform inv.fail('NOT_AUTHORISED', 'ask the store your team uses');
  end if;
  return query
    select i.id, i.name, i.base_uom, coalesce(sl.on_hand, 0)
      from inv.item_node n
      join inv.item i on i.id = n.item_id and i.archived_at is null
      left join inv.stock_level sl on sl.item_id = i.id and sl.delivery_node_id = p_store
     where n.delivery_node_id = p_store and n.archived_at is null
     order by i.name;
end $$;
revoke execute on function inv.ask_store_items(uuid) from public;
grant execute on function inv.ask_store_items(uuid) to app_rw;
