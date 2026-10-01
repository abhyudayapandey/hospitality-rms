-- migrate:up
-- Reads for the menu, recipe and procedure screens (Prompt 9a, ADR 014). Staff who may read
-- a recipe cannot read inv.item (stock catalogue, with standard costs), so the names of a
-- recipe's ingredients come through these functions, which check the same rule as the
-- recipe policies and never return a cost. Costs come only from functions that check MENU
-- view at the store.

-- The recipes the caller may read, in force today: prep items and menu items.
create function inv.my_recipes()
returns table (recipe_id uuid, kind text, subject_id uuid, code text, name text, grp text,
               unit text, batch_yield numeric, shelf_life_hours int, version int,
               effective_from date)
language sql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
  select r.id, case when r.prep_item_id is not null then 'prep' else 'menu' end,
         coalesce(r.prep_item_id, r.menu_item_id), coalesce(i.sku, m.code), coalesce(i.name, m.name),
         coalesce(case i.prep_type when 'kitchen_prep' then 'Kitchen prep'
                                   when 'house_mixer' then 'House mixers'
                                   when 'batched_cocktail' then 'Batched cocktails' end,
                  m.menu || ' · ' || m.category),
         i.base_uom, r.batch_yield, i.shelf_life_hours, r.version, r.effective_from
    from inv.recipe r
    left join inv.item i on i.id = r.prep_item_id
    left join menu.menu_item m on m.id = r.menu_item_id
   where r.id = any (inv.visible_recipe_ids())
     and r.effective_from <= current_date and (r.effective_to is null or r.effective_to >= current_date)
   order by 6, 5;
$$;

-- One readable recipe version and its ingredients (no costs).
create function inv.recipe_card(p_recipe uuid)
returns table (line_no int, ingredient_id uuid, code text, name text, kind text, qty numeric,
               unit text, trim_loss_pct numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not (p_recipe = any (inv.visible_recipe_ids())) then
    raise exception 'NOT_AUTHORISED' using detail = 'read this recipe';
  end if;
  return query
    select l.line_no, i.id, i.sku, i.name, i.kind, l.qty, l.unit, l.trim_loss_pct
      from inv.recipe_line l join inv.item i on i.id = l.ingredient_item_id
     where l.recipe_id = p_recipe order by l.line_no;
end $$;

-- Each line's cost at a store, for those with MENU view there.
create function inv.recipe_line_costs(p_recipe uuid, p_store uuid, p_basis text default 'current')
returns table (line_no int, unit_cost numeric, line_cost numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not core.can('MENU', 'view', null, p_store)
     or not exists (select 1 from inv.recipe where id = p_recipe and tenant_id = core.my_tenant()) then
    raise exception 'NOT_AUTHORISED' using detail = format('view MENU at %s', p_store);
  end if;
  return query
    select l.line_no, u.c, l.qty / (1 - l.trim_loss_pct / 100) * u.c
      from inv.recipe_line l
      cross join lateral (select inv.unit_cost(l.ingredient_item_id, p_store, p_basis, current_date) as c) u
     where l.recipe_id = p_recipe order by l.line_no;
end $$;

-- What an editor can put in a recipe: raw items with a recipe unit, and prep items.
create function inv.recipe_ingredients()
returns table (item_id uuid, code text, name text, kind text, unit text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not core.can_any('MENU', 'modify') then
    raise exception 'NOT_AUTHORISED' using detail = 'modify MENU';
  end if;
  return query
    select i.id, i.sku, i.name, i.kind, coalesce(u.recipe_unit, i.base_uom)
      from inv.item i left join inv.item_unit u on u.item_id = i.id
     where i.tenant_id = core.my_tenant() and i.archived_at is null
       and (i.kind = 'prep' or u.id is not null)
     order by i.kind desc, i.name;
end $$;

-- Outlets and stores where the caller sees menu costs.
create function menu.my_menu_places()
returns table (outlet_id uuid, outlet_name text, store_id uuid, store_name text, can_edit boolean)
language sql stable security definer
set search_path = pg_catalog, core, menu
as $$
  select distinct o.id, o.name, s.id, s.name, core.can('MENU', 'modify', null, s.id)
    from menu.menu_outlet mo
    join core.hierarchy_node o on o.id = mo.org_node_id
    join core.hierarchy_node s on s.id = mo.delivery_node_id
   where mo.tenant_id = core.my_tenant()
     and (mo.effective_to is null or mo.effective_to >= current_date)
     and core.can('MENU', 'view', null, mo.delivery_node_id)
   order by 2, 4;
$$;

-- For the menu tab only (presentation, not access): does one of the caller's departments
-- (RECIPES_TEAM) have a linked store that makes or sells something? Without it, staff of
-- housekeeping, front office or security would see a tab that is always empty.
create function inv.team_has_recipes() returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv, menu, extensions
as $$
  select exists (
    select 1 from core.effective_access ea
      join core.hierarchy_node o
        on o.tenant_id = core.my_tenant() and o.type = 'org' and o.kind = 'department'
       and (o.path = ea.path or (ea.include_descendants and ea.path @> o.path))
      join core.node_link nl on nl.org_node_id = o.id
     where ea.user_id = core.current_user_id() and ea.domain = 'RECIPES_TEAM'
       and (exists (select 1 from inv.item_node x
                     where x.delivery_node_id = nl.delivery_node_id and x.made_here
                       and x.archived_at is null)
            or exists (select 1 from menu.menu_outlet mo
                        where mo.delivery_node_id = nl.delivery_node_id
                          and (mo.effective_to is null or mo.effective_to >= current_date))));
$$;

revoke execute on function inv.team_has_recipes() from public;
grant execute on function inv.team_has_recipes() to app_rw;

revoke execute on function inv.my_recipes(), inv.recipe_card(uuid),
  inv.recipe_line_costs(uuid, uuid, text), inv.recipe_ingredients(), menu.my_menu_places()
  from public;
grant execute on function inv.my_recipes(), inv.recipe_card(uuid),
  inv.recipe_line_costs(uuid, uuid, text), inv.recipe_ingredients(), menu.my_menu_places()
  to app_rw;

-- migrate:down
drop function if exists inv.team_has_recipes();
drop function menu.my_menu_places(), inv.recipe_ingredients(),
  inv.recipe_line_costs(uuid, uuid, text), inv.recipe_card(uuid), inv.my_recipes();
