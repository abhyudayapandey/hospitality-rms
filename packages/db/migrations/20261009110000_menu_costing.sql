-- migrate:up
-- Costing and editing for menus and recipes (Prompt 9a, ADR 014).
--
-- Cost of a recipe line = quantity / (1 - trim loss %) x cost per recipe unit of the
-- ingredient. Cost per recipe unit:
--   raw item:  stock cost / recipe units per stock unit, where the stock cost is the
--              store's weighted average while it has stock there ('current'), else the
--              item's standard cost ('standard', or no stock yet)
--   prep item: the store's weighted average while it has stock ('current'), else its
--              recipe in force, costed through its sub-recipes at a store that makes it,
--              divided by the batch yield
-- Nothing is rounded until the figure is shown: cost per serve to the paisa, cost % to
-- one decimal, prep cost per unit to four decimals (the 98 files).
-- Costs are computed when read, so they follow every cost and recipe change at once.

-- The recipe of a prep or menu item in force on p_on.
create function inv.recipe_on(p_prep uuid, p_menu uuid, p_on date) returns inv.recipe
language sql stable
set search_path = pg_catalog, inv
as $$
  select r.* from inv.recipe r
   where (r.prep_item_id = p_prep or r.menu_item_id = p_menu)
     and r.effective_from <= p_on and (r.effective_to is null or r.effective_to >= p_on)
   order by r.version desc limit 1;
$$;

create function inv.unit_cost(p_item uuid, p_store uuid, p_basis text, p_on date,
                              p_depth int default 0) returns numeric
language plpgsql stable
set search_path = pg_catalog, core, inv
as $$
declare
  v_item inv.item;
  v_lvl inv.stock_level;
  v_factor numeric;
  v_at uuid := p_store;
  v_recipe inv.recipe;
begin
  if p_depth > 20 then
    raise exception 'RECIPE_CYCLE' using detail = 'sub-recipes nest more than 20 deep';
  end if;
  if p_basis not in ('current', 'standard') then
    raise exception 'INVALID_BASIS' using detail = p_basis;
  end if;
  select * into v_item from inv.item where id = p_item;
  if p_basis = 'current' and p_store is not null then
    select * into v_lvl from inv.stock_level where item_id = p_item and delivery_node_id = p_store;
  end if;

  if v_item.kind = 'raw' then
    select recipe_units_per_stock_unit into v_factor from inv.item_unit where item_id = p_item;
    v_factor := coalesce(v_factor, 1);
    if v_lvl.on_hand > 0 then
      return v_lvl.avg_cost / v_factor;
    end if;
    return coalesce(v_item.standard_unit_cost, 0) / v_factor;
  end if;

  if v_lvl.on_hand > 0 then
    return v_lvl.avg_cost;
  end if;
  -- costed where it is made: this store if it makes it, else a store that does
  if not exists (select 1 from inv.item_node where item_id = p_item and delivery_node_id = p_store
                    and made_here and archived_at is null) then
    select x.delivery_node_id into v_at
      from inv.item_node x join core.hierarchy_node n on n.id = x.delivery_node_id
     where x.item_id = p_item and x.made_here and x.archived_at is null
     order by n.code limit 1;
    v_at := coalesce(v_at, p_store);
  end if;
  v_recipe := inv.recipe_on(p_item, null, p_on);
  if v_recipe.id is null then
    return null;
  end if;
  return inv.recipe_cost(v_recipe.id, v_at, p_basis, p_on, p_depth + 1) / v_recipe.batch_yield;
end $$;

-- Total cost of one recipe version (one batch of a prep item; one serve of a menu item).
create function inv.recipe_cost(p_recipe uuid, p_store uuid, p_basis text, p_on date,
                                p_depth int default 0) returns numeric
language sql stable
set search_path = pg_catalog, inv
as $$
  select sum(l.qty / (1 - l.trim_loss_pct / 100)
             * inv.unit_cost(l.ingredient_item_id, p_store, p_basis, p_on, p_depth))
    from inv.recipe_line l where l.recipe_id = p_recipe;
$$;

revoke execute on function inv.recipe_on(uuid, uuid, date),
  inv.unit_cost(uuid, uuid, text, date, int), inv.recipe_cost(uuid, uuid, text, date, int)
  from public;

-- Cost per serve and cost % of every menu item an outlet sells, at the stores where the
-- caller holds MENU view (a department head: their own department's store).
create function menu.outlet_costing(p_outlet uuid, p_basis text default 'current',
                                    p_on date default current_date)
returns table (menu_item_id uuid, code text, name text, menu text, category text,
               store_id uuid, store_code text, store_name text, price numeric, currency text,
               cost_per_serve numeric, cost_pct numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
declare
  v_any boolean;
begin
  if not exists (select 1 from core.hierarchy_node where id = p_outlet and tenant_id = core.my_tenant()) then
    raise exception 'NOT_AUTHORISED' using detail = format('view MENU at %s', p_outlet);
  end if;
  select exists (select 1 from menu.menu_outlet mo
                  where mo.org_node_id = p_outlet
                    and mo.effective_from <= p_on and (mo.effective_to is null or mo.effective_to >= p_on)
                    and core.can('MENU', 'view', null, mo.delivery_node_id))
    into v_any;
  if not v_any and exists (select 1 from menu.menu_outlet mo where mo.org_node_id = p_outlet) then
    raise exception 'NOT_AUTHORISED' using detail = format('view MENU at %s', p_outlet);
  end if;
  return query
    with rows as (
      select mo.menu_item_id, mo.delivery_node_id, mo.price, mo.currency,
             round(inv.recipe_cost((inv.recipe_on(null, mo.menu_item_id, p_on)).id,
                                   mo.delivery_node_id, p_basis, p_on), 2) as cost
        from menu.menu_outlet mo
       where mo.org_node_id = p_outlet
         and mo.effective_from <= p_on and (mo.effective_to is null or mo.effective_to >= p_on)
         and core.can('MENU', 'view', null, mo.delivery_node_id))
    select r.menu_item_id, m.code, m.name, m.menu, m.category, r.delivery_node_id, n.code,
           n.name, r.price, r.currency, r.cost,
           case when r.price > 0 then round(r.cost / r.price * 100, 1) end
      from rows r
      join menu.menu_item m on m.id = r.menu_item_id
      join core.hierarchy_node n on n.id = r.delivery_node_id
     order by m.menu, m.category, m.name;
end $$;

-- Batch cost and cost per unit of the prep items held at a store.
create function inv.prep_costing(p_store uuid, p_basis text default 'current',
                                 p_on date default current_date)
returns table (prep_item_id uuid, made_here boolean, batch_yield numeric, batch_cost numeric,
               cost_per_unit numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not core.can('MENU', 'view', null, p_store) then
    raise exception 'NOT_AUTHORISED' using detail = format('view MENU at %s', p_store);
  end if;
  return query
    select x.item_id, x.made_here, r.batch_yield,
           round(inv.recipe_cost(r.id, p_store, p_basis, p_on), 2),
           round(inv.unit_cost(x.item_id, p_store, p_basis, p_on), 4)
      from inv.item_node x
      join inv.item i on i.id = x.item_id and i.kind = 'prep'
      cross join lateral (select * from inv.recipe_on(x.item_id, null, p_on)) r
     where x.delivery_node_id = p_store and x.archived_at is null and r.id is not null;
end $$;

-- The stores a recipe is used at: where a prep item is held, or where a menu item is sold.
create function inv.recipe_use_stores(p_prep uuid, p_menu uuid) returns uuid[]
language sql stable
set search_path = pg_catalog, inv, menu
as $$
  select coalesce(array_agg(distinct s), '{}') from (
    select x.delivery_node_id as s from inv.item_node x
     where p_prep is not null and x.item_id = p_prep and x.archived_at is null
    union all
    select mo.delivery_node_id from menu.menu_outlet mo
     where p_menu is not null and mo.menu_item_id = p_menu
       and (mo.effective_to is null or mo.effective_to >= current_date)) u;
$$;
revoke execute on function inv.recipe_use_stores(uuid, uuid) from public;

-- Saves a new version of a prep item's ('prep') or a menu item's ('menu') recipe, in force
-- from p_effective_from (today or later). p_lines: [{ingredient_item_id, qty, unit,
-- trim_loss_pct?}]. A recipe used at several stores needs MENU modify at all of them; a
-- second change for the same date replaces that date's version. Returns the version's id.
create function inv.save_recipe(p_kind text, p_subject uuid, p_lines jsonb,
                                p_effective_from date default current_date,
                                p_batch_yield numeric default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, menu
as $$
declare
  v_tenant uuid := core.my_tenant();
  v_prep uuid := case when p_kind = 'prep' then p_subject end;
  v_menu uuid := case when p_kind = 'menu' then p_subject end;
  v_open inv.recipe;
  v_store uuid;
  v_stores uuid[];
  v_id uuid;
  v_yield numeric;
begin
  if v_tenant is null or p_kind not in ('prep', 'menu') then
    raise exception 'NOT_AUTHORISED' using detail = 'modify MENU';
  end if;
  if (v_prep is not null and not exists (select 1 from inv.item where id = v_prep
                                            and tenant_id = v_tenant and kind = 'prep'))
     or (v_menu is not null and not exists (select 1 from menu.menu_item where id = v_menu
                                               and tenant_id = v_tenant)) then
    raise exception 'NOT_FOUND' using detail = 'no such prep or menu item';
  end if;
  v_stores := inv.recipe_use_stores(v_prep, v_menu);
  if cardinality(v_stores) = 0 then
    if not core.can_any('MENU', 'modify') then
      raise exception 'NOT_AUTHORISED' using detail = 'modify MENU';
    end if;
  else
    foreach v_store in array v_stores loop
      if not core.can('MENU', 'modify', null, v_store) then
        raise exception 'NOT_AUTHORISED'
          using detail = format('modify MENU at %s: the recipe is used there',
                                (select coalesce(code, name) from core.hierarchy_node where id = v_store));
      end if;
    end loop;
  end if;
  if p_effective_from is null or p_effective_from < current_date then
    raise exception 'INVALID_DATE' using detail = 'a recipe change takes effect today or later';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'INVALID_LINES' using detail = 'a recipe needs at least one line';
  end if;

  select * into v_open from inv.recipe
   where (prep_item_id = v_prep or menu_item_id = v_menu) and effective_to is null;
  v_yield := case when v_prep is not null then coalesce(p_batch_yield, v_open.batch_yield) end;
  if v_prep is not null and (v_yield is null or v_yield <= 0) then
    raise exception 'INVALID_LINES' using detail = 'a prep recipe needs its batch yield';
  end if;

  if v_open.id is not null and v_open.effective_from = p_effective_from then
    -- the same date again: replace that version's lines (audit.log keeps the old ones)
    delete from inv.recipe_line where recipe_id = v_open.id;
    update inv.recipe set batch_yield = v_yield where id = v_open.id;
    v_id := v_open.id;
  elsif v_open.id is not null and v_open.effective_from > p_effective_from then
    raise exception 'INVALID_DATE'
      using detail = format('a version already starts on %s', v_open.effective_from);
  else
    if v_open.id is not null then
      update inv.recipe set effective_to = p_effective_from - 1 where id = v_open.id;
    end if;
    insert into inv.recipe (tenant_id, prep_item_id, menu_item_id, version, effective_from,
                            batch_yield)
    values (v_tenant, v_prep, v_menu,
            coalesce((select max(version) from inv.recipe
                       where prep_item_id = v_prep or menu_item_id = v_menu), 0) + 1,
            p_effective_from, v_yield)
    returning id into v_id;
  end if;

  insert into inv.recipe_line (tenant_id, recipe_id, line_no, ingredient_item_id, qty, unit,
                               trim_loss_pct)
  select v_tenant, v_id, l.ord, (l.v ->> 'ingredient_item_id')::uuid, (l.v ->> 'qty')::numeric,
         l.v ->> 'unit', coalesce((l.v ->> 'trim_loss_pct')::numeric, 0)
    from jsonb_array_elements(p_lines) with ordinality as l(v, ord);
  return v_id;
end $$;

-- Sets the price (and optionally the store it is sold from) of a menu item at an outlet,
-- from p_effective_from (today or later). Needs MENU modify at the store, and at the old
-- store when it moves. Returns the menu_outlet row's id.
create function menu.set_price(p_menu_item uuid, p_outlet uuid, p_price numeric,
                               p_effective_from date default current_date,
                               p_store uuid default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, menu
as $$
declare
  v_tenant uuid := core.my_tenant();
  v_open menu.menu_outlet;
  v_store uuid;
  v_id uuid;
begin
  if v_tenant is null or not exists (select 1 from menu.menu_item
                                       where id = p_menu_item and tenant_id = v_tenant) then
    raise exception 'NOT_AUTHORISED' using detail = 'modify MENU';
  end if;
  select * into v_open from menu.menu_outlet
   where menu_item_id = p_menu_item and org_node_id = p_outlet and effective_to is null;
  v_store := coalesce(p_store, v_open.delivery_node_id);
  if v_store is null then
    raise exception 'INVALID_STORE' using detail = 'name the store it is sold from';
  end if;
  if not core.can('MENU', 'modify', null, v_store)
     or (v_open.id is not null and not core.can('MENU', 'modify', null, v_open.delivery_node_id)) then
    raise exception 'NOT_AUTHORISED' using detail = format('modify MENU at %s', v_store);
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'INVALID_PRICE';
  end if;
  if p_effective_from is null or p_effective_from < current_date then
    raise exception 'INVALID_DATE' using detail = 'a price change takes effect today or later';
  end if;
  if v_open.id is not null and v_open.effective_from = p_effective_from then
    update menu.menu_outlet set price = p_price, delivery_node_id = v_store where id = v_open.id;
    return v_open.id;
  elsif v_open.id is not null and v_open.effective_from > p_effective_from then
    raise exception 'INVALID_DATE'
      using detail = format('a price already starts on %s', v_open.effective_from);
  end if;
  if v_open.id is not null then
    update menu.menu_outlet set effective_to = p_effective_from - 1 where id = v_open.id;
  end if;
  insert into menu.menu_outlet (tenant_id, menu_item_id, org_node_id, delivery_node_id, price,
                                currency, effective_from)
  values (v_tenant, p_menu_item, p_outlet, v_store, p_price, coalesce(v_open.currency, 'INR'),
          p_effective_from)
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function menu.outlet_costing(uuid, text, date), inv.prep_costing(uuid, text, date),
  inv.save_recipe(text, uuid, jsonb, date, numeric),
  menu.set_price(uuid, uuid, numeric, date, uuid) from public;
grant execute on function menu.outlet_costing(uuid, text, date), inv.prep_costing(uuid, text, date),
  inv.save_recipe(text, uuid, jsonb, date, numeric),
  menu.set_price(uuid, uuid, numeric, date, uuid) to app_rw;

-- migrate:down
drop function menu.set_price(uuid, uuid, numeric, date, uuid),
  inv.save_recipe(text, uuid, jsonb, date, numeric), inv.recipe_use_stores(uuid, uuid),
  inv.prep_costing(uuid, text, date), menu.outlet_costing(uuid, text, date),
  inv.recipe_cost(uuid, uuid, text, date, int), inv.unit_cost(uuid, uuid, text, date, int),
  inv.recipe_on(uuid, uuid, date);
