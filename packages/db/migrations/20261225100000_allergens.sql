-- migrate:up
-- Allergens follow the recipe (ADR 138).
--
--   * One list for every customer: FSSAI's nine (Labelling & Display Regulations 2020) and the
--     five more the EU's list of 14 adds (celery, mustard, sesame, lupin, molluscs). The same
--     words as packages/domain ALLERGENS; nothing else is stored.
--   * A raw item is tagged once (file 10). What is made from it carries its allergens: a prep
--     item (and a prep item inside it), a dish, a batch's label and a prep task. A prep item's
--     or a dish's own tags (file 19, file 22) add to what its recipe brings, never take away.
--     Worked out when read, from the recipe of the day: nothing is copied, so a recipe change
--     or a new tag shows at once.

create function inv.allergen_words() returns text[]
language sql immutable parallel safe
as $$
  select array['gluten', 'crustaceans', 'milk', 'egg', 'fish', 'peanuts', 'tree nuts', 'soy',
               'sulphites', 'celery', 'mustard', 'sesame', 'lupin', 'molluscs']::text[];
$$;

alter table inv.item
  add constraint item_allergens_known check (allergens <@ inv.allergen_words());

alter table menu.menu_item
  add column allergens text[] not null default '{}',
  add constraint menu_item_allergens_known check (allergens <@ inv.allergen_words());

-- An item's allergens on a day: its own tags, and those of everything in its recipe of that
-- day, all the way down (recipes have no cycles). A raw item's are its own tags. Called by the
-- functions below, which decide who may read; nobody calls it directly.
create function inv.allergens_of(p_item uuid, p_on date default current_date) returns text[]
language sql stable
set search_path = pg_catalog, inv
as $$
  with recursive parts (item_id) as (
    select p_item
    union
    select l.ingredient_item_id
      from parts p
      join inv.recipe r on r.prep_item_id = p.item_id
                       and r.effective_from <= p_on
                       and (r.effective_to is null or r.effective_to >= p_on)
      join inv.recipe_line l on l.recipe_id = r.id
  )
  select coalesce(array_agg(distinct a order by a), '{}')
    from parts
    join inv.item i on i.id = parts.item_id
   cross join lateral unnest(i.allergens) a;
$$;

-- One recipe's allergens: its prep item's or dish's own tags, and those of each of its lines
-- (a prep item among them with its own recipe of that day).
create function inv.recipe_allergens(p_recipe uuid, p_on date default current_date)
returns text[]
language sql stable
set search_path = pg_catalog, inv, menu
as $$
  select coalesce(array_agg(distinct a order by a), '{}')
    from (select unnest(coalesce(i.allergens, m.allergens)) a
            from inv.recipe r
            left join inv.item i on i.id = r.prep_item_id
            left join menu.menu_item m on m.id = r.menu_item_id
           where r.id = p_recipe
          union all
          select unnest(inv.allergens_of(l.ingredient_item_id, p_on))
            from inv.recipe_line l
           where l.recipe_id = p_recipe) x;
$$;

revoke execute on function inv.allergens_of(uuid, date) from public;
revoke execute on function inv.recipe_allergens(uuid, date) from public;

-- The recipe list (prep items and dishes): what each carries.
drop function inv.my_recipes();
create function inv.my_recipes()
returns table (recipe_id uuid, kind text, subject_id uuid, code text, name text, grp text,
               unit text, batch_yield numeric, shelf_life_hours integer, version integer,
               effective_from date, batch_portions numeric, allergens text[])
language sql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
  select r.id, case when r.prep_item_id is not null then 'prep' else 'menu' end,
         coalesce(r.prep_item_id, r.menu_item_id), coalesce(i.sku, m.code), coalesce(i.name, m.name),
         coalesce(case i.prep_type when 'kitchen_prep' then 'Kitchen prep'
                                   when 'house_mixer' then 'House mixers'
                                   when 'batched_cocktail' then 'Batched cocktails' end,
                  m.menu || ' · ' || m.category),
         i.base_uom, r.batch_yield, i.shelf_life_hours, r.version, r.effective_from,
         i.batch_portions, inv.recipe_allergens(r.id)
    from inv.recipe r
    left join inv.item i on i.id = r.prep_item_id
    left join menu.menu_item m on m.id = r.menu_item_id
   where r.id = any ((select inv.visible_recipe_ids())::uuid[])
     and r.effective_from <= current_date and (r.effective_to is null or r.effective_to >= current_date)
   order by 6, 5;
$$;
revoke execute on function inv.my_recipes() from public;
grant execute on function inv.my_recipes() to app_rw, platform_loader;

-- A batch's allergens: those of the recipe it was made with, on the day it was made.
create function inv.batch_allergens(p_production uuid) returns text[]
language sql stable
set search_path = pg_catalog, inv, ops
as $$
  select case when p.recipe_id is not null
              then inv.recipe_allergens(p.recipe_id,
                                        (p.made_at at time zone ops.tz_of(p.delivery_node_id))::date)
              else inv.allergens_of(p.prep_item_id) end
    from inv.production p where p.id = p_production;
$$;
revoke execute on function inv.batch_allergens(uuid) from public;

create or replace function inv.batches(p_store uuid)
returns table (item_id uuid, sku text, name text, unit text, batch_no text,
               made_at timestamptz, expires_at timestamptz, qty numeric, remaining numeric,
               expired boolean, production_id uuid, made_by text, food_type text,
               allergens text[], batch_portions numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not (core.can('STOCK_LEVELS', 'view', null, p_store) or inv.can_produce_at(p_store)) then
    raise exception 'NOT_AUTHORISED' using detail = format('view STOCK_LEVELS at %s', p_store);
  end if;
  return query
    select i.id, i.sku, i.name, i.base_uom, b.batch_no, b.made_at, b.expires_at, b.qty,
           b.remaining, b.expires_at <= now(), p.id,
           (select u.display_name from core.app_user u where u.id = p.created_by),
           i.food_type,
           case when p.id is not null then inv.batch_allergens(p.id)
                else inv.allergens_of(i.id) end,
           i.batch_portions
      from inv.item_node x
      join inv.item i on i.id = x.item_id and i.kind = 'prep'
      cross join lateral inv.batch_rows(x.item_id, p_store) b
      left join inv.production p on p.delivery_node_id = p_store and p.prep_item_id = i.id
                                and p.batch_no = b.batch_no
     where x.delivery_node_id = p_store and b.remaining > 0
     order by b.made_at desc nulls last, i.name;
end $$;

create or replace function inv.batch_label(p_production uuid)
returns table (production_id uuid, name text, batch_no text, made_at timestamptz,
               expires_at timestamptz, qty numeric, unit text, food_type text,
               allergens text[], batch_portions numeric, made_by text, store text, tz text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_p inv.production;
begin
  select * into v_p from inv.production where id = p_production and tenant_id = core.my_tenant();
  if v_p.id is null
     or not (core.can('STOCK_LEVELS', 'view', null, v_p.delivery_node_id)
             or inv.can_produce_at(v_p.delivery_node_id)
             or v_p.created_by = core.current_user_id()) then
    raise exception 'NOT_AUTHORISED' using detail = 'that batch';
  end if;
  return query
    select v_p.id, i.name, v_p.batch_no, v_p.made_at, v_p.expires_at, v_p.qty_made, i.base_uom,
           i.food_type, inv.batch_allergens(v_p.id),
           case when i.batch_portions is not null and r.batch_yield > 0
                then round(i.batch_portions * v_p.qty_made / r.batch_yield, 1) end,
           (select u.display_name from core.app_user u where u.id = v_p.created_by),
           (select s.name from core.hierarchy_node s where s.id = v_p.delivery_node_id),
           ops.tz_of(v_p.delivery_node_id)
      from inv.item i
      left join inv.recipe r on r.id = v_p.recipe_id
     where i.id = v_p.prep_item_id;
end $$;

-- A prep task's recipe says what the batch carries, for whoever makes it.
do $$
declare
  v_def text := pg_get_functiondef('ops.prep_task_recipe(uuid)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def,
    $o$    'batch_yield', v_recipe.batch_yield,$o$,
    $n$    'batch_yield', v_recipe.batch_yield,
    -- what the batch carries (ADR 138), from its recipe's ingredients
    'allergens', to_jsonb(inv.recipe_allergens(v_recipe.id)),$n$);
  if v_new = v_def then
    raise exception 'ops.prep_task_recipe changed; update this migration';
  end if;
  execute v_new;
end $$;

-- migrate:down
do $$
declare
  v_def text := pg_get_functiondef('ops.prep_task_recipe(uuid)'::regprocedure);
begin
  execute replace(v_def,
    $n$    'batch_yield', v_recipe.batch_yield,
    -- what the batch carries (ADR 138), from its recipe's ingredients
    'allergens', to_jsonb(inv.recipe_allergens(v_recipe.id)),$n$,
    $o$    'batch_yield', v_recipe.batch_yield,$o$);
end $$;

create or replace function inv.batch_label(p_production uuid)
returns table (production_id uuid, name text, batch_no text, made_at timestamptz,
               expires_at timestamptz, qty numeric, unit text, food_type text,
               allergens text[], batch_portions numeric, made_by text, store text, tz text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_p inv.production;
begin
  select * into v_p from inv.production where id = p_production and tenant_id = core.my_tenant();
  if v_p.id is null
     or not (core.can('STOCK_LEVELS', 'view', null, v_p.delivery_node_id)
             or inv.can_produce_at(v_p.delivery_node_id)
             or v_p.created_by = core.current_user_id()) then
    raise exception 'NOT_AUTHORISED' using detail = 'that batch';
  end if;
  return query
    select v_p.id, i.name, v_p.batch_no, v_p.made_at, v_p.expires_at, v_p.qty_made, i.base_uom,
           i.food_type, i.allergens,
           case when i.batch_portions is not null and r.batch_yield > 0
                then round(i.batch_portions * v_p.qty_made / r.batch_yield, 1) end,
           (select u.display_name from core.app_user u where u.id = v_p.created_by),
           (select s.name from core.hierarchy_node s where s.id = v_p.delivery_node_id),
           ops.tz_of(v_p.delivery_node_id)
      from inv.item i
      left join inv.recipe r on r.id = v_p.recipe_id
     where i.id = v_p.prep_item_id;
end $$;

create or replace function inv.batches(p_store uuid)
returns table (item_id uuid, sku text, name text, unit text, batch_no text,
               made_at timestamptz, expires_at timestamptz, qty numeric, remaining numeric,
               expired boolean, production_id uuid, made_by text, food_type text,
               allergens text[], batch_portions numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not (core.can('STOCK_LEVELS', 'view', null, p_store) or inv.can_produce_at(p_store)) then
    raise exception 'NOT_AUTHORISED' using detail = format('view STOCK_LEVELS at %s', p_store);
  end if;
  return query
    select i.id, i.sku, i.name, i.base_uom, b.batch_no, b.made_at, b.expires_at, b.qty,
           b.remaining, b.expires_at <= now(), p.id,
           (select u.display_name from core.app_user u where u.id = p.created_by),
           i.food_type, i.allergens, i.batch_portions
      from inv.item_node x
      join inv.item i on i.id = x.item_id and i.kind = 'prep'
      cross join lateral inv.batch_rows(x.item_id, p_store) b
      left join inv.production p on p.delivery_node_id = p_store and p.prep_item_id = i.id
                                and p.batch_no = b.batch_no
     where x.delivery_node_id = p_store and b.remaining > 0
     order by b.made_at desc nulls last, i.name;
end $$;
drop function inv.batch_allergens(uuid);

drop function inv.my_recipes();
create function inv.my_recipes()
returns table (recipe_id uuid, kind text, subject_id uuid, code text, name text, grp text,
               unit text, batch_yield numeric, shelf_life_hours integer, version integer,
               effective_from date, batch_portions numeric)
language sql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
  select r.id, case when r.prep_item_id is not null then 'prep' else 'menu' end,
         coalesce(r.prep_item_id, r.menu_item_id), coalesce(i.sku, m.code), coalesce(i.name, m.name),
         coalesce(case i.prep_type when 'kitchen_prep' then 'Kitchen prep'
                                   when 'house_mixer' then 'House mixers'
                                   when 'batched_cocktail' then 'Batched cocktails' end,
                  m.menu || ' · ' || m.category),
         i.base_uom, r.batch_yield, i.shelf_life_hours, r.version, r.effective_from,
         i.batch_portions
    from inv.recipe r
    left join inv.item i on i.id = r.prep_item_id
    left join menu.menu_item m on m.id = r.menu_item_id
   where r.id = any ((select inv.visible_recipe_ids())::uuid[])
     and r.effective_from <= current_date and (r.effective_to is null or r.effective_to >= current_date)
   order by 6, 5;
$$;
revoke execute on function inv.my_recipes() from public;
grant execute on function inv.my_recipes() to app_rw, platform_loader;

drop function inv.recipe_allergens(uuid, date);
drop function inv.allergens_of(uuid, date);
alter table menu.menu_item drop constraint menu_item_allergens_known, drop column allergens;
alter table inv.item drop constraint item_allergens_known;
drop function inv.allergen_words();
