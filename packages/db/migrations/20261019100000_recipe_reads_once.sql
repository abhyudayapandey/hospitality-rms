-- migrate:up
-- inv.my_recipes() and inv.visible_prep_item_ids() compared each recipe with
-- inv.visible_recipe_ids() written inline, so Postgres worked the list out again for every
-- recipe row: about 150 ms each, 9 s for the Menu page of a cost controller with 82 recipes.
-- Wrapped in a scalar subquery (cast back to an array, so `= any` reads it as one) it is
-- worked out once per call, as the RLS policies already do. Same rows, same rule (ADR 014).

create or replace function inv.visible_prep_item_ids() returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select coalesce(array_agg(distinct r.prep_item_id), '{}')
    from inv.recipe r
   where r.id = any ((select inv.visible_recipe_ids())::uuid[]) and r.prep_item_id is not null;
$$;

create or replace function inv.my_recipes()
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
   where r.id = any ((select inv.visible_recipe_ids())::uuid[])
     and r.effective_from <= current_date and (r.effective_to is null or r.effective_to >= current_date)
   order by 6, 5;
$$;

-- migrate:down
create or replace function inv.visible_prep_item_ids() returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select coalesce(array_agg(distinct r.prep_item_id), '{}')
    from inv.recipe r
   where r.id = any (inv.visible_recipe_ids()) and r.prep_item_id is not null;
$$;

create or replace function inv.my_recipes()
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
