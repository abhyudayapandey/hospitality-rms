-- migrate:up
-- A dish's photo and its method (GM feedback items 2 and 8, ADR 078).
--
-- 1. A dish (menu.menu_item) has an optional photo, like a stock item (ADR 034): in the
--    private photo bucket under items/<tenant>/<dish>/<uuid>.<ext> (the item photos' prefix,
--    which the app and the platform worker may already write; ids are unique across tables,
--    so a key still names one company and one thing). Set, changed or cleared only through
--    menu.set_dish_photo, by whoever may change the dish's recipe: MENU modify at every store
--    it is sold from (inv.save_recipe's rule), or anywhere when it is sold nowhere yet.
-- 2. A dish has a method, as a prep item does: inv.prep_procedure rows now belong to a prep
--    item or to a dish, never both. Who reads them follows who reads the recipe, through
--    inv.recipe_method; the table's policies now look at either.
-- 3. inv.recipe_photos: the photos of the recipes the caller may read (dishes and prep
--    items), without opening inv.item or menu.menu_item to anyone new.

-- ---------------------------------------------------------------------------
-- 1. The dish's photo
-- ---------------------------------------------------------------------------

alter table menu.menu_item add column photo_key text,
  add constraint menu_item_photo_key check (
    photo_key is null
    or photo_key ~ ('^items/' || tenant_id::text || '/' || id::text
                    || '/[0-9a-f-]{36}\.(jpg|png|webp)$'));

-- Whether the current user may change this dish (its photo; its recipe has the same rule).
create function menu.can_edit_dish(p_menu_item uuid) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
declare
  v_stores uuid[];
  v_store uuid;
begin
  if not exists (select 1 from menu.menu_item where id = p_menu_item
                    and tenant_id = core.my_tenant() and archived_at is null) then
    return false;
  end if;
  v_stores := inv.recipe_use_stores(null, p_menu_item);
  if cardinality(v_stores) = 0 then
    return core.can_any('MENU', 'modify');
  end if;
  foreach v_store in array v_stores loop
    if not core.can('MENU', 'modify', null, v_store) then
      return false;
    end if;
  end loop;
  return true;
end $$;

-- Sets (or, with null, clears) the dish's photo. Someone who may not, and anyone asking about
-- another company's dish, is NOT_AUTHORISED; a key that is not this company's and this
-- dish's is INVALID_PHOTO.
create function menu.set_dish_photo(p_menu_item uuid, p_photo_key text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, menu
as $$
declare
  v_tenant uuid := core.my_tenant();
begin
  if not menu.can_edit_dish(p_menu_item) then
    raise exception 'NOT_AUTHORISED' using detail = 'change this dish';
  end if;
  if p_photo_key is not null and p_photo_key !~ ('^items/' || v_tenant::text || '/'
       || p_menu_item::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
    raise exception 'INVALID_PHOTO' using detail = 'photo was not uploaded for this dish';
  end if;
  update menu.menu_item set photo_key = p_photo_key
   where id = p_menu_item and tenant_id = v_tenant;
end $$;

revoke execute on function menu.can_edit_dish(uuid), menu.set_dish_photo(uuid, text) from public;
grant execute on function menu.can_edit_dish(uuid), menu.set_dish_photo(uuid, text) to app_rw;

-- The photos of the recipes the caller may read: (subject, photo key), dishes and prep items.
create function inv.recipe_photos()
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
revoke execute on function inv.recipe_photos() from public;
grant execute on function inv.recipe_photos() to app_rw;

-- ---------------------------------------------------------------------------
-- 2. A dish's method
-- ---------------------------------------------------------------------------

alter table inv.prep_procedure
  alter column prep_item_id drop not null,
  add column menu_item_id uuid references menu.menu_item(id),
  add constraint prep_procedure_subject check ((prep_item_id is null) <> (menu_item_id is null));
create unique index prep_procedure_menu_step on inv.prep_procedure (tenant_id, menu_item_id, step)
  where menu_item_id is not null;

-- The same-company check: a prep item's steps still need a prep item; a dish's need a dish of
-- the company (the menu_item_id column is checked like everywhere else).
do $$
declare
  v_src text := pg_get_functiondef('inv.check_menu_refs()'::regprocedure);
  v_old text := 'if tg_table_name = ''prep_procedure''
     and not exists';
  v_new text := 'if tg_table_name = ''prep_procedure'' and v_row ->> ''prep_item_id'' is not null
     and not exists';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'inv.check_menu_refs changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- Who reads a method: whoever reads its recipe (per row and per query, held equal by the
-- RLS equivalence test).
create function inv.can_read_procedure(p_procedure uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
  select coalesce((select case when p.prep_item_id is not null then inv.can_read_prep(p.prep_item_id)
                               else menu.can_read_menu_item(p.menu_item_id) end
                     from inv.prep_procedure p
                    where p.id = p_procedure and p.tenant_id = core.my_tenant()), false);
$$;

create function inv.visible_procedure_ids() returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
  select coalesce(array_agg(p.id), '{}')
    from inv.prep_procedure p
   where p.tenant_id = core.my_tenant()
     and (p.prep_item_id = any (inv.visible_prep_item_ids())
          or p.menu_item_id = any (menu.visible_menu_item_ids()));
$$;
revoke execute on function inv.can_read_procedure(uuid), inv.visible_procedure_ids() from public;
grant execute on function inv.visible_procedure_ids() to app_rw;

update core.domain_table
   set visible_fn = 'inv.visible_procedure_ids()',
       visible_row_fn = 'inv.can_read_procedure(uuid)',
       visible_column = 'id'
 where table_name = 'inv.prep_procedure'::regclass;
select core.apply_domain_rls('inv.prep_procedure');

-- A readable recipe's method: a prep item's or a dish's steps, in order (no costs).
create function inv.recipe_method(p_recipe uuid)
returns table (step int, instruction text, minutes int)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_r inv.recipe;
begin
  if not (p_recipe = any (inv.visible_recipe_ids())) then
    raise exception 'NOT_AUTHORISED' using detail = 'read this recipe';
  end if;
  select * into v_r from inv.recipe where id = p_recipe;
  return query
    select p.step, p.instruction, p.minutes from inv.prep_procedure p
     where p.tenant_id = v_r.tenant_id
       and (p.prep_item_id = v_r.prep_item_id or p.menu_item_id = v_r.menu_item_id)
     order by p.step;
end $$;
revoke execute on function inv.recipe_method(uuid) from public;
grant execute on function inv.recipe_method(uuid) to app_rw;

-- ---------------------------------------------------------------------------
-- 3. A sub-recipe on a card: which readable recipe an ingredient that is itself a prep item
--    opens (null when the caller may not read it).
-- ---------------------------------------------------------------------------

create function inv.sub_recipes(p_recipe uuid)
returns table (line_no int, recipe_id uuid)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_visible uuid[] := inv.visible_recipe_ids();
begin
  if not (p_recipe = any (v_visible)) then
    raise exception 'NOT_AUTHORISED' using detail = 'read this recipe';
  end if;
  return query
    select l.line_no, r.id
      from inv.recipe_line l
      join inv.item i on i.id = l.ingredient_item_id and i.kind = 'prep'
      join inv.recipe r on r.prep_item_id = i.id and r.effective_to is null
     where l.recipe_id = p_recipe and r.id = any (v_visible)
     order by l.line_no;
end $$;
revoke execute on function inv.sub_recipes(uuid) from public;
grant execute on function inv.sub_recipes(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function inv.sub_recipes(uuid), inv.recipe_method(uuid);
update core.domain_table
   set visible_fn = 'inv.visible_prep_item_ids()',
       visible_row_fn = 'inv.can_read_prep(uuid)',
       visible_column = 'prep_item_id'
 where table_name = 'inv.prep_procedure'::regclass;
delete from inv.prep_procedure where menu_item_id is not null;
do $$
begin
  execute replace(pg_get_functiondef('inv.check_menu_refs()'::regprocedure),
    'if tg_table_name = ''prep_procedure'' and v_row ->> ''prep_item_id'' is not null',
    'if tg_table_name = ''prep_procedure''');
end $$;
drop index inv.prep_procedure_menu_step;
alter table inv.prep_procedure drop constraint prep_procedure_subject, drop column menu_item_id,
  alter column prep_item_id set not null;
select core.apply_domain_rls('inv.prep_procedure');
drop function inv.visible_procedure_ids(), inv.can_read_procedure(uuid);
drop function inv.recipe_photos(), menu.set_dish_photo(uuid, text), menu.can_edit_dish(uuid);
alter table menu.menu_item drop constraint menu_item_photo_key, drop column photo_key;
