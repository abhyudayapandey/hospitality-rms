-- migrate:up
-- Opened packs by whole packs (ADR 102). An item may say how big one of its packs is
-- (`pack_size`, in its stock unit: 0.4 for a 400 ml tin stocked in litres) and what a pack is
-- called (`pack_name`: tin, carton, bottle, packet). File 10 gives both. Opening one asks how
-- many packs, and inv.open_pack refuses a quantity that is not a whole number of them
-- (NOT_WHOLE_PACKS): 4.38 l of coconut milk on the shelf does not mean 2.39 l can be opened.
-- An item with no pack size keeps today's free quantity.

alter table inv.item
  add column pack_size numeric(18,6) check (pack_size > 0),
  add column pack_name text check (pack_name is null or length(pack_name) between 1 and 30),
  add constraint item_pack_name_needs_size check (pack_name is null or pack_size is not null);

select core.patch_function('inv.open_pack(uuid, uuid, numeric, text)',
$x$  if p_qty > inv.on_hand(p_item, p_store) then$x$,
$x$  if v_item.pack_size is not null
     and abs(p_qty / v_item.pack_size - round(p_qty / v_item.pack_size)) > 0.000001 then
    perform inv.fail('NOT_WHOLE_PACKS', 'a whole number of packs');
  end if;
  if p_qty > inv.on_hand(p_item, p_store) then$x$);

-- what may be opened, now with its pack
drop function inv.pack_items(uuid);
create function inv.pack_items(p_store uuid)
returns table (item_id uuid, name text, base_uom text, hours int, on_hand numeric,
               pack_size numeric, pack_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
#variable_conflict use_column
begin
  if not core.can('SHELF_LIFE', 'view', null, p_store) then
    perform inv.fail('NOT_AUTHORISED', 'SHELF_LIFE view');
  end if;
  return query
    select i.id, i.name, i.base_uom, i.open_shelf_life_hours, coalesce(s.on_hand, 0),
           i.pack_size, i.pack_name
      from inv.item_node x
      join inv.item i on i.id = x.item_id
      left join inv.stock_level s
        on s.item_id = x.item_id and s.delivery_node_id = x.delivery_node_id
     where x.delivery_node_id = p_store and x.archived_at is null
       and i.archived_at is null and i.open_shelf_life_hours is not null
       and i.tenant_id = core.my_tenant()
     order by i.name;
end $$;
revoke execute on function inv.pack_items(uuid) from public, platform_loader;
grant execute on function inv.pack_items(uuid) to app_rw;

-- the label says "1 tin · 400 ml"
drop function inv.pack_label(uuid);
create function inv.pack_label(p_pack uuid)
returns table (id uuid, name text, qty numeric, unit text, food_type text, allergens text[],
               storage text, opened_at timestamptz, use_by timestamptz, opened_by text,
               store text, tz text, status text, pack_size numeric, pack_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
#variable_conflict use_column
declare
  v_p inv.opened_pack;
begin
  select * into v_p from inv.opened_pack where id = p_pack and tenant_id = core.my_tenant();
  if v_p.id is null or not core.can('SHELF_LIFE', 'view', null, v_p.delivery_node_id) then
    perform inv.fail('NOT_AUTHORISED', 'that pack');
  end if;
  return query
    select v_p.id, i.name, v_p.qty, i.base_uom, i.food_type, i.allergens, i.storage,
           v_p.opened_at, v_p.use_by,
           (select u.display_name from core.app_user u where u.id = v_p.created_by),
           (select s.name from core.hierarchy_node s where s.id = v_p.delivery_node_id),
           coalesce(ops.tz_of(v_p.delivery_node_id), 'UTC'), v_p.status,
           i.pack_size, i.pack_name
      from inv.item i where i.id = v_p.item_id;
end $$;
revoke execute on function inv.pack_label(uuid) from public, platform_loader;
grant execute on function inv.pack_label(uuid) to app_rw;

-- migrate:down
drop function inv.pack_label(uuid);
create function inv.pack_label(p_pack uuid)
returns table (id uuid, name text, qty numeric, unit text, food_type text, allergens text[],
               storage text, opened_at timestamptz, use_by timestamptz, opened_by text,
               store text, tz text, status text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
#variable_conflict use_column
declare
  v_p inv.opened_pack;
begin
  select * into v_p from inv.opened_pack where id = p_pack and tenant_id = core.my_tenant();
  if v_p.id is null or not core.can('SHELF_LIFE', 'view', null, v_p.delivery_node_id) then
    perform inv.fail('NOT_AUTHORISED', 'that pack');
  end if;
  return query
    select v_p.id, i.name, v_p.qty, i.base_uom, i.food_type, i.allergens, i.storage,
           v_p.opened_at, v_p.use_by,
           (select u.display_name from core.app_user u where u.id = v_p.created_by),
           (select s.name from core.hierarchy_node s where s.id = v_p.delivery_node_id),
           coalesce(ops.tz_of(v_p.delivery_node_id), 'UTC'), v_p.status
      from inv.item i where i.id = v_p.item_id;
end $$;
revoke execute on function inv.pack_label(uuid) from public, platform_loader;
grant execute on function inv.pack_label(uuid) to app_rw;

drop function inv.pack_items(uuid);
create function inv.pack_items(p_store uuid)
returns table (item_id uuid, name text, base_uom text, hours int, on_hand numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
#variable_conflict use_column
begin
  if not core.can('SHELF_LIFE', 'view', null, p_store) then
    perform inv.fail('NOT_AUTHORISED', 'SHELF_LIFE view');
  end if;
  return query
    select i.id, i.name, i.base_uom, i.open_shelf_life_hours, coalesce(s.on_hand, 0)
      from inv.item_node x
      join inv.item i on i.id = x.item_id
      left join inv.stock_level s
        on s.item_id = x.item_id and s.delivery_node_id = x.delivery_node_id
     where x.delivery_node_id = p_store and x.archived_at is null
       and i.archived_at is null and i.open_shelf_life_hours is not null
       and i.tenant_id = core.my_tenant()
     order by i.name;
end $$;
revoke execute on function inv.pack_items(uuid) from public, platform_loader;
grant execute on function inv.pack_items(uuid) to app_rw;

select core.patch_function('inv.open_pack(uuid, uuid, numeric, text)',
$x$  if v_item.pack_size is not null
     and abs(p_qty / v_item.pack_size - round(p_qty / v_item.pack_size)) > 0.000001 then
    perform inv.fail('NOT_WHOLE_PACKS', 'a whole number of packs');
  end if;
  if p_qty > inv.on_hand(p_item, p_store) then$x$,
$x$  if p_qty > inv.on_hand(p_item, p_store) then$x$);

alter table inv.item
  drop constraint item_pack_name_needs_size,
  drop column pack_name,
  drop column pack_size;
