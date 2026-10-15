-- migrate:up
-- The recipes' photos (ADR 078) asked inv.visible_recipe_ids() again for every recipe row; the
-- menu screens took ten seconds where each call costs a tenth. The visible recipes are now worked
-- out once, in an uncorrelated subquery. Same rows, same access.
create or replace function inv.recipe_photos()
returns table (subject_id uuid, photo_key text)
language sql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
  select coalesce(r.prep_item_id, r.menu_item_id), coalesce(i.photo_key, m.photo_key)
    from inv.recipe r
    left join inv.item i on i.id = r.prep_item_id
    left join menu.menu_item m on m.id = r.menu_item_id
   where r.id in (select unnest(inv.visible_recipe_ids()))
     and r.effective_to is null
     and coalesce(i.photo_key, m.photo_key) is not null;
$$;

-- migrate:down
create or replace function inv.recipe_photos()
returns table (subject_id uuid, photo_key text)
language sql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
  select coalesce(r.prep_item_id, r.menu_item_id), coalesce(i.photo_key, m.photo_key)
    from inv.recipe r
    left join inv.item i on i.id = r.prep_item_id
    left join menu.menu_item m on m.id = r.menu_item_id
   where r.id = any (inv.visible_recipe_ids())
     and r.effective_to is null
     and coalesce(i.photo_key, m.photo_key) is not null;
$$;
