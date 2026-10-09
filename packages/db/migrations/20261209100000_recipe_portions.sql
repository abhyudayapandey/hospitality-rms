-- migrate:up

-- ADR 084: a recipe says how many portions a batch makes (file 19 batch_portions, ADR 076),
-- on its page and on a prep task, scaled to the quantity asked; and a prep task's ingredients
-- carry their category, so each shows its picture.

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

do $$
declare
  v_def text := pg_get_functiondef('ops.prep_task_recipe(uuid)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def,
    $o$    'batch_yield', v_recipe.batch_yield,$o$,
    $n$    'batch_yield', v_recipe.batch_yield,
    -- how many portions this task's quantity makes (ADR 084), when the item says per batch
    'portions', (select round(i.batch_portions * v_scale, 1) from inv.item i
                  where i.id = v_t.item_id and i.batch_portions is not null),$n$);
  v_new := replace(v_new,
    $o$               'name', i.name,$o$,
    $n$               'name', i.name,
               'category', i.category,$n$);
  if v_new = v_def or v_new not like '%''portions''%' or v_new not like '%''category''%' then
    raise exception 'ops.prep_task_recipe changed; update this migration';
  end if;
  execute v_new;
end $$;

-- migrate:down

do $$
declare
  v_def text := pg_get_functiondef('ops.prep_task_recipe(uuid)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def,
    $o$    'batch_yield', v_recipe.batch_yield,
    -- how many portions this task's quantity makes (ADR 084), when the item says per batch
    'portions', (select round(i.batch_portions * v_scale, 1) from inv.item i
                  where i.id = v_t.item_id and i.batch_portions is not null),$o$,
    $n$    'batch_yield', v_recipe.batch_yield,$n$);
  v_new := replace(v_new,
    $o$               'name', i.name,
               'category', i.category,$o$,
    $n$               'name', i.name,$n$);
  execute v_new;
end $$;

drop function inv.my_recipes();
create function inv.my_recipes()
returns table (recipe_id uuid, kind text, subject_id uuid, code text, name text, grp text,
               unit text, batch_yield numeric, shelf_life_hours integer, version integer,
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
revoke execute on function inv.my_recipes() from public;
grant execute on function inv.my_recipes() to app_rw, platform_loader;
