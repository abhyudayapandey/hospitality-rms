-- migrate:up
-- Reads for the production, sales and variance screens (Prompt 9b, ADR 015). Each checks
-- the same access as the write it prepares, and none returns a cost.

-- One batch of a prep item at a store that makes it: the recipe in force, in recipe units,
-- with ingredient names (stock users there may not read the stock catalogue's costs).
create function inv.production_plan(p_store uuid, p_prep uuid)
returns table (line_no int, ingredient_id uuid, name text, qty numeric, unit text,
               batch_yield numeric, batch_unit text, shelf_life_hours int)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_recipe inv.recipe;
begin
  if not core.can('PRODUCTION', 'modify', null, p_store) then
    raise exception 'NOT_AUTHORISED' using detail = format('modify PRODUCTION at %s', p_store);
  end if;
  if not exists (select 1 from inv.item_node x join inv.item i on i.id = x.item_id
                  where x.item_id = p_prep and x.delivery_node_id = p_store and x.made_here
                    and x.archived_at is null and i.tenant_id = core.my_tenant()) then
    raise exception 'NOT_MADE_HERE' using detail = 'that prep item is not made at this store';
  end if;
  v_recipe := inv.recipe_on(p_prep, null, current_date);
  return query
    select l.line_no, i.id, i.name, l.qty / (1 - l.trim_loss_pct / 100), l.unit,
           v_recipe.batch_yield, p.base_uom, p.shelf_life_hours
      from inv.recipe_line l
      join inv.item i on i.id = l.ingredient_item_id
      join inv.item p on p.id = p_prep
     where l.recipe_id = v_recipe.id
     order by l.line_no;
end $$;

-- The prep items made at a store, for the production picker.
create function inv.made_here(p_store uuid)
returns table (item_id uuid, sku text, name text, unit text, batch_yield numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not core.can('PRODUCTION', 'modify', null, p_store) then
    raise exception 'NOT_AUTHORISED' using detail = format('modify PRODUCTION at %s', p_store);
  end if;
  return query
    select i.id, i.sku, i.name, i.base_uom, (inv.recipe_on(i.id, null, current_date)).batch_yield
      from inv.item_node x join inv.item i on i.id = x.item_id and i.kind = 'prep'
     where x.delivery_node_id = p_store and x.made_here and x.archived_at is null
     order by i.name;
end $$;

-- What an outlet sells on a day, and what has been posted for it by manual entry.
create function menu.sales_sheet(p_outlet uuid, p_date date)
returns table (menu_item_id uuid, code text, name text, menu text, category text,
               store_id uuid, posted_qty numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, menu
as $$
begin
  if not exists (select 1 from menu.menu_outlet mo
                  where mo.org_node_id = p_outlet and mo.tenant_id = core.my_tenant()
                    and core.can('SALES', 'modify', null, mo.delivery_node_id)) then
    raise exception 'NOT_AUTHORISED' using detail = format('modify SALES at %s', p_outlet);
  end if;
  return query
    select m.id, m.code, m.name, m.menu, m.category, mo.delivery_node_id, sl.qty
      from menu.menu_outlet mo
      join menu.menu_item m on m.id = mo.menu_item_id
      left join menu.sales_day sd on sd.org_node_id = p_outlet and sd.business_date = p_date
                                 and sd.source = 'manual'
      left join menu.sales_line sl on sl.sales_day_id = sd.id and sl.menu_item_id = m.id
     where mo.org_node_id = p_outlet
       and mo.effective_from <= p_date and (mo.effective_to is null or mo.effective_to >= p_date)
       and core.can('SALES', 'modify', null, mo.delivery_node_id)
     order by m.menu, m.category, m.name;
end $$;

-- Outlets where the caller posts sales.
create function menu.my_sales_places()
returns table (outlet_id uuid, outlet_name text)
language sql stable security definer
set search_path = pg_catalog, core, menu
as $$
  select distinct o.id, o.name
    from menu.menu_outlet mo join core.hierarchy_node o on o.id = mo.org_node_id
   where mo.tenant_id = core.my_tenant()
     and (mo.effective_to is null or mo.effective_to >= current_date)
     and core.can('SALES', 'modify', null, mo.delivery_node_id)
   order by 2;
$$;

revoke execute on function inv.production_plan(uuid, uuid), inv.made_here(uuid),
  menu.sales_sheet(uuid, date), menu.my_sales_places() from public;
grant execute on function inv.production_plan(uuid, uuid), inv.made_here(uuid),
  menu.sales_sheet(uuid, date), menu.my_sales_places() to app_rw;

-- migrate:down
drop function if exists menu.my_sales_places(), menu.sales_sheet(uuid, date),
  inv.made_here(uuid), inv.production_plan(uuid, uuid);
