-- migrate:up
-- Menu, recipes and prep items (Prompt 9a, ADR 014; spec docs/onboarding/test-data/MENU_README.md).
--
--   raw item (inv.item kind 'raw') --inv.item_unit--> recipe unit (g, ml, each)
--   prep item (inv.item kind 'prep', stocked in its recipe unit) made in batches at the
--     stores where inv.item_node.made_here is set
--   inv.recipe: one version of a prep item's or a menu item's recipe, with effective
--     dates; inv.recipe_line: ingredient (raw or prep), quantity, trim loss
--   menu.menu_item: what is sold; menu.menu_outlet: an outlet sells it from one of its
--     stores at a price before tax, with effective dates
--
-- Who reads what (enforced by RLS):
--   * a recipe, its lines and a prep item's procedure: whoever can read recipes at a store
--     that makes it (prep) or sells it (menu item): RECIPES at the store, or RECIPES_TEAM
--     at a department linked to the store (kitchen staff -> kitchen store, bar staff -> bar
--     store). Also anyone with MENU view at a store that holds or sells it (managers and
--     cost controllers: everything used at their stores, received prep included).
--   * prices (menu.menu_outlet) and costs (functions in the next migration): MENU view at
--     the store; edits MENU modify.
-- Tables are written only by RPCs and the onboarding loader. Recipe and price changes add
-- versions; every row change is in audit.log.

create schema menu;
grant usage on schema menu to app_rw, wf_executor, platform_loader;
alter default privileges for role migrator in schema menu
  grant select, insert, update, delete on tables to platform_loader;
alter default privileges for role migrator in schema menu
  grant execute on functions to platform_loader;

-- Rule 1 covers the new business schema.
create or replace function core.rls_violations()
returns table (table_name text, problem text)
language sql stable
as $$
  with t as (
    select c.oid, c.oid::regclass::text as name, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('hr', 'inv', 'ops', 'wf', 'ai', 'menu')
       and c.relkind in ('r', 'p')
       and not c.relispartition
  )
  select name, 'rls_disabled' from t where not relrowsecurity
  union all
  select name, 'not_registered' from t
   where not exists (select 1 from core.domain_table dt where dt.table_name = t.oid)
  union all
  select name, 'no_generated_policies' from t
   where not exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polname like 'dom\_%')
  union all
  select name, 'hand_written_policy' from t
   where exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polname not like 'dom\_%')
  union all
  select name, 'no_audit_trigger' from t
   where not exists (select 1 from pg_trigger tg
                      where tg.tgrelid = t.oid and tg.tgfoid = 'audit.capture'::regproc)
$$;

-- ---------------------------------------------------------------------------
-- A registration mode for rows whose visibility is a rule over other rows (recipes):
-- visible_fn() returns the ids the current user may read, once per query (ADR 007);
-- visible_row_fn(id) is the same rule row by row, through core.can(), and the RLS
-- equivalence test holds the two equal. Reads only; writes are RPCs.
-- ---------------------------------------------------------------------------

alter table core.domain_table
  add column visible_fn regprocedure,
  add column visible_row_fn regprocedure,
  add column visible_column text,
  add constraint domain_table_visible check (
    (visible_fn is null and visible_row_fn is null and visible_column is null)
    or (visible_fn is not null and visible_row_fn is not null and visible_column is not null
        and rpc_only and not catalog and not tenant_scoped and domain_code is not null));

do $$
declare
  v_src text := pg_get_functiondef('core.apply_domain_rls(regclass)'::regprocedure);
  v_old text := '  -- Catalogue rows (items, suppliers): no node;';
  v_new text := '  -- Rule-visible rows (recipes): the ids visible_fn() returns, once per query.
  if v_dt.visible_fn is not null then
    if not core.has_column(p_table, v_dt.visible_column) then
      raise exception ''NODE_COLUMN_MISSING''
        using detail = format(''%s.%s'', p_table, v_dt.visible_column);
    end if;
    for v_pol in select polname from pg_policy
                  where polrelid = p_table and polname like ''dom\_%'' loop
      execute format(''drop policy %I on %s'', v_pol.polname, p_table);
    end loop;
    execute format(''alter table %s enable row level security'', p_table);
    execute format(''revoke all on %s from app_rw, wf_executor'', p_table);
    execute format(
      ''create policy dom_select on %s for select to app_rw using ''
      ''(tenant_id = (select core.my_tenant()) and %I = any ((select %s)::uuid[]))'',
      p_table, v_dt.visible_column,
      regexp_replace(v_dt.visible_fn::text, ''\(\)$'', '''') || ''()'');
    execute format(''grant select on %s to app_rw'', p_table);
    return;
  end if;

  -- Catalogue rows (items, suppliers): no node;';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'core.apply_domain_rls changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- ---------------------------------------------------------------------------
-- Items: raw or prep; recipe units; where prep is made
-- ---------------------------------------------------------------------------

alter table inv.item
  add column kind text not null default 'raw' check (kind in ('raw', 'prep')),
  add column prep_type text check (prep_type in ('kitchen_prep', 'house_mixer', 'batched_cocktail')),
  add column shelf_life_hours int check (shelf_life_hours > 0),
  add constraint item_prep_fields check (
    (kind = 'raw' and prep_type is null and shelf_life_hours is null)
    or (kind = 'prep' and prep_type is not null and shelf_life_hours is not null
        and base_uom in ('g', 'ml', 'each')));

-- How a raw item's stock unit converts to the unit recipes use (1 kg = 1000 g; one 750 ml
-- bottle = 750 ml). A prep item is stocked in its recipe unit and has no row here.
create table inv.item_unit (
  id uuid primary key default core.uuid_v7(),
  item_id uuid not null references inv.item(id),
  recipe_unit text not null check (recipe_unit in ('g', 'ml', 'each')),
  recipe_units_per_stock_unit numeric(14,4) not null check (recipe_units_per_stock_unit > 0)
);
select core.add_standard_columns('inv.item_unit');
alter table inv.item_unit add constraint item_unit_key unique (tenant_id, item_id);

alter table inv.item_node add column made_here boolean not null default false;

-- ---------------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------------

create table menu.menu_item (
  id uuid primary key default core.uuid_v7(),
  code text not null,
  name text not null,
  menu text not null check (menu in ('Food', 'Bar')),
  category text not null,
  serving text not null,
  archived_at timestamptz
);
select core.add_standard_columns('menu.menu_item');
alter table menu.menu_item add constraint menu_item_code_key unique (tenant_id, code);

-- An outlet sells a menu item from one of its stores, at a price before tax. A change of
-- price or store closes the open row (effective_to) and opens a new one.
create table menu.menu_outlet (
  id uuid primary key default core.uuid_v7(),
  menu_item_id uuid not null references menu.menu_item(id),
  org_node_id uuid not null references core.hierarchy_node(id),      -- the outlet
  delivery_node_id uuid not null references core.hierarchy_node(id), -- the store it is sold from
  price numeric(14,2) not null check (price >= 0),
  currency text not null default 'INR',
  effective_from date not null,
  effective_to date,
  check (effective_to is null or effective_to >= effective_from - 1)
);
select core.add_standard_columns('menu.menu_outlet');
alter table menu.menu_outlet add constraint menu_outlet_key
  unique (tenant_id, menu_item_id, org_node_id, effective_from);
create unique index menu_outlet_open on menu.menu_outlet (menu_item_id, org_node_id)
  where effective_to is null;
create index menu_outlet_store on menu.menu_outlet (delivery_node_id);

-- ---------------------------------------------------------------------------
-- Recipes (versioned) and procedures
-- ---------------------------------------------------------------------------

create table inv.recipe (
  id uuid primary key default core.uuid_v7(),
  prep_item_id uuid references inv.item(id),
  menu_item_id uuid references menu.menu_item(id),
  version int not null check (version > 0),
  effective_from date not null,
  effective_to date,
  batch_yield numeric(14,3),                     -- prep: what one batch makes, in its unit
  check ((prep_item_id is null) <> (menu_item_id is null)),
  check ((prep_item_id is not null and batch_yield > 0) or (menu_item_id is not null and batch_yield is null)),
  check (effective_to is null or effective_to >= effective_from - 1)
);
select core.add_standard_columns('inv.recipe');
alter table inv.recipe add constraint recipe_prep_version unique (tenant_id, prep_item_id, version);
alter table inv.recipe add constraint recipe_menu_version unique (tenant_id, menu_item_id, version);
create unique index recipe_prep_open on inv.recipe (prep_item_id) where effective_to is null and prep_item_id is not null;
create unique index recipe_menu_open on inv.recipe (menu_item_id) where effective_to is null and menu_item_id is not null;

create table inv.recipe_line (
  id uuid primary key default core.uuid_v7(),
  recipe_id uuid not null references inv.recipe(id),
  line_no int not null check (line_no > 0),
  ingredient_item_id uuid not null references inv.item(id),
  qty numeric(14,3) not null check (qty > 0),          -- in the ingredient's recipe unit
  unit text not null,
  trim_loss_pct numeric(5,2) not null default 0 check (trim_loss_pct >= 0 and trim_loss_pct < 100)
);
select core.add_standard_columns('inv.recipe_line');
alter table inv.recipe_line add constraint recipe_line_key unique (recipe_id, line_no);
alter table inv.recipe_line add constraint recipe_line_ingredient unique (recipe_id, ingredient_item_id);

create table inv.prep_procedure (
  id uuid primary key default core.uuid_v7(),
  prep_item_id uuid not null references inv.item(id),
  step int not null check (step > 0),
  instruction text not null,
  minutes int check (minutes >= 0)
);
select core.add_standard_columns('inv.prep_procedure');
alter table inv.prep_procedure add constraint prep_procedure_key unique (tenant_id, prep_item_id, step);

-- ---------------------------------------------------------------------------
-- Integrity: one tenant, the right units, prep items only where prep is meant, no cycles
-- ---------------------------------------------------------------------------

create function inv.check_menu_refs() returns trigger
language plpgsql
set search_path = pg_catalog, core, inv, menu, extensions
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_bad text;
begin
  select string_agg(c.col, ', ') into v_bad
    from (values ('item_id', 'item'), ('prep_item_id', 'item'), ('ingredient_item_id', 'item'),
                 ('menu_item_id', 'menu_item'), ('recipe_id', 'recipe'),
                 ('org_node_id', 'node'), ('delivery_node_id', 'node')) c(col, kind)
   where v_row ? c.col and v_row ->> c.col is not null
     and not exists (
       select 1 where
         (c.kind = 'item' and exists (select 1 from inv.item
                                       where id = (v_row ->> c.col)::uuid and tenant_id = new.tenant_id))
      or (c.kind = 'menu_item' and exists (select 1 from menu.menu_item
                                            where id = (v_row ->> c.col)::uuid and tenant_id = new.tenant_id))
      or (c.kind = 'recipe' and exists (select 1 from inv.recipe
                                         where id = (v_row ->> c.col)::uuid and tenant_id = new.tenant_id))
      or (c.kind = 'node' and exists (select 1 from core.hierarchy_node
                                       where id = (v_row ->> c.col)::uuid and tenant_id = new.tenant_id)));
  if v_bad is not null then
    raise exception 'TENANT_MISMATCH'
      using detail = format('%s.%s: %s not in tenant %s', tg_table_schema, tg_table_name, v_bad,
                            new.tenant_id);
  end if;
  -- (fields through v_row: plpgsql may evaluate new.<column> on tables that lack it)
  if tg_table_name = 'recipe' and v_row ->> 'prep_item_id' is not null
     and not exists (select 1 from inv.item where id = (v_row ->> 'prep_item_id')::uuid
                        and kind = 'prep') then
    raise exception 'INVALID_RECIPE' using detail = 'a prep recipe is for a prep item';
  end if;
  if tg_table_name = 'prep_procedure'
     and not exists (select 1 from inv.item where id = (v_row ->> 'prep_item_id')::uuid
                        and kind = 'prep') then
    raise exception 'INVALID_RECIPE' using detail = 'a procedure is for a prep item';
  end if;
  if tg_table_name = 'menu_outlet' then
    -- the store sells for this outlet: its link anchor is linked to the outlet or below it
    if not exists (
      select 1 from core.hierarchy_node s
        join core.node_link nl on nl.delivery_node_id = core.link_anchor(s.id)
        join core.hierarchy_node o on o.id = nl.org_node_id
        join core.hierarchy_node outlet on outlet.id = (v_row ->> 'org_node_id')::uuid
       where s.id = (v_row ->> 'delivery_node_id')::uuid and s.type = 'delivery'
         and s.holds_stock and outlet.path @> o.path) then
      raise exception 'INVALID_STORE'
        using detail = 'the store a menu item is sold from belongs to the outlet and holds stock';
    end if;
  end if;
  return new;
end $$;
revoke execute on function inv.check_menu_refs() from public;

-- A line's unit is the ingredient's recipe unit, and no prep item may end up in its own
-- recipe, directly or through sub-recipes (any version in force today or later).
create function inv.check_recipe_line() returns trigger
language plpgsql
set search_path = pg_catalog, core, inv
as $$
declare
  v_ing inv.item;
  v_unit text;
  v_for uuid;
begin
  select * into v_ing from inv.item where id = new.ingredient_item_id;
  v_unit := case v_ing.kind
              when 'prep' then v_ing.base_uom
              else (select recipe_unit from inv.item_unit where item_id = v_ing.id) end;
  if v_unit is null then
    raise exception 'UNIT_MISSING'
      using detail = format('%s has no recipe unit (file 18)', v_ing.sku);
  end if;
  if new.unit is distinct from v_unit then
    raise exception 'UNIT_MISMATCH'
      using detail = format('%s is used in %s, not %s', v_ing.sku, v_unit, new.unit);
  end if;
  select prep_item_id into v_for from inv.recipe where id = new.recipe_id;
  if v_for is not null and v_ing.kind = 'prep' then
    if v_ing.id = v_for or exists (
      with recursive reach(item_id) as (
        select new.ingredient_item_id
        union
        select l.ingredient_item_id
          from reach
          join inv.recipe r on r.prep_item_id = reach.item_id
                           and (r.effective_to is null or r.effective_to >= current_date)
          join inv.recipe_line l on l.recipe_id = r.id
      )
      select 1 from reach where item_id = v_for) then
      raise exception 'RECIPE_CYCLE'
        using detail = format('%s would be made from itself', v_ing.sku);
    end if;
  end if;
  return new;
end $$;
revoke execute on function inv.check_recipe_line() from public;

create trigger a_same_tenant before insert or update on inv.item_unit
  for each row execute function inv.check_menu_refs();
create trigger a_same_tenant before insert or update on menu.menu_outlet
  for each row execute function inv.check_menu_refs();
create trigger a_same_tenant before insert or update on inv.recipe
  for each row execute function inv.check_menu_refs();
create trigger a_same_tenant before insert or update on inv.recipe_line
  for each row execute function inv.check_menu_refs();
create trigger a_same_tenant before insert or update on inv.prep_procedure
  for each row execute function inv.check_menu_refs();
create trigger b_unit_and_cycle before insert or update on inv.recipe_line
  for each row execute function inv.check_recipe_line();

-- ---------------------------------------------------------------------------
-- Who reads recipes. Per row through core.can() (the rule) and per query as id sets
-- (what the policies use); the RLS equivalence test holds them equal.
-- ---------------------------------------------------------------------------

-- Can the current user read the recipes made or sold at store p_store? RECIPES there, or
-- RECIPES_TEAM at a department linked to it (not an outlet's own link: a guest house's
-- front desk holds STAFF on the outlet, which is linked to its only store).
create function inv.can_read_recipes_at(p_store uuid) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  return core.can('RECIPES', 'view', null, p_store)
      or exists (select 1 from core.node_link nl
                   join core.hierarchy_node o on o.id = nl.org_node_id and o.kind = 'department'
                  where nl.delivery_node_id = p_store
                    and core.can('RECIPES_TEAM', 'view', o.id, null));
end $$;
-- A menu or prep row is current when it is in force today or later.
create function inv.recipe_readable_by_rule(p_prep uuid, p_menu uuid,
                                            p_recipe_stores uuid[], p_menu_stores uuid[])
returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
  select case
    when p_prep is not null then
      exists (select 1 from inv.item_node x
               where x.item_id = p_prep and x.archived_at is null
                 and ((x.made_here and x.delivery_node_id = any (p_recipe_stores))
                      or x.delivery_node_id = any (p_menu_stores)))
      or (not exists (select 1 from inv.item_node x where x.item_id = p_prep and x.archived_at is null)
          and core.can_any('MENU', 'modify'))
    else
      exists (select 1 from menu.menu_outlet mo
               where mo.menu_item_id = p_menu
                 and (mo.effective_to is null or mo.effective_to >= current_date)
                 and (mo.delivery_node_id = any (p_recipe_stores)
                      or mo.delivery_node_id = any (p_menu_stores)))
      or (not exists (select 1 from menu.menu_outlet mo where mo.menu_item_id = p_menu
                         and (mo.effective_to is null or mo.effective_to >= current_date))
          and core.can_any('MENU', 'modify'))
  end;
$$;

-- The stores where the current user reads recipes (made or sold there) and holds MENU view.
create function inv.my_recipe_stores(out recipe_stores uuid[], out menu_stores uuid[])
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select coalesce(array_agg(n.id) filter (where inv.can_read_recipes_at(n.id)), '{}'),
         coalesce(array_agg(n.id) filter (where core.can('MENU', 'view', null, n.id)), '{}')
    from core.hierarchy_node n
   where n.tenant_id = core.my_tenant() and n.type = 'delivery' and n.holds_stock
     and n.archived_at is null;
$$;

-- Per row (the rule, through core.can() at each store the row is used at).
create function inv.can_read_recipe_of(p_tenant uuid, p_prep uuid, p_menu uuid) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
declare
  v_store uuid;
  v_made boolean;
  v_used boolean := false;
begin
  if p_tenant is distinct from core.my_tenant() then
    return false;
  end if;
  -- nobody without a recipe or menu grant passes any core.can() below: answer at once
  if not exists (select 1 from core.effective_access ea
                  where ea.user_id = core.current_user_id()
                    and ea.domain in ('RECIPES', 'RECIPES_TEAM', 'MENU', 'DERIVED_MENU',
                                      'DERIVED_RECIPES')) then
    return false;
  end if;
  for v_store, v_made in
    select x.delivery_node_id, x.made_here from inv.item_node x
     where p_prep is not null and x.item_id = p_prep and x.archived_at is null
    union all
    select mo.delivery_node_id, true from menu.menu_outlet mo
     where p_menu is not null and mo.menu_item_id = p_menu
       and (mo.effective_to is null or mo.effective_to >= current_date)
  loop
    v_used := true;
    if core.can('MENU', 'view', null, v_store)
       or (v_made and inv.can_read_recipes_at(v_store)) then
      return true;
    end if;
  end loop;
  return not v_used and core.can_any('MENU', 'modify');
end $$;
create function inv.can_read_recipe(p_recipe uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select coalesce((select inv.can_read_recipe_of(r.tenant_id, r.prep_item_id, r.menu_item_id)
                     from inv.recipe r where r.id = p_recipe), false);
$$;

create function inv.can_read_prep(p_prep uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select exists (select 1 from inv.recipe r where r.prep_item_id = p_prep
                    and inv.can_read_recipe(r.id));
$$;

create function menu.can_read_menu_item(p_menu_item uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
  select coalesce((select inv.can_read_recipe_of(m.tenant_id, null, m.id)
                     from menu.menu_item m where m.id = p_menu_item), false);
$$;
-- Per query (what the policies use).
create function inv.visible_recipe_ids() returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select coalesce(array_agg(r.id), '{}')
    from inv.my_recipe_stores() s, inv.recipe r
   where r.tenant_id = core.my_tenant()
     and inv.recipe_readable_by_rule(r.prep_item_id, r.menu_item_id, s.recipe_stores, s.menu_stores);
$$;

create function inv.visible_prep_item_ids() returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select coalesce(array_agg(distinct r.prep_item_id), '{}')
    from inv.recipe r
   where r.id = any (inv.visible_recipe_ids()) and r.prep_item_id is not null;
$$;

create function menu.visible_menu_item_ids() returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
  select coalesce(array_agg(m.id), '{}')
    from inv.my_recipe_stores() s, menu.menu_item m
   where m.tenant_id = core.my_tenant()
     and inv.recipe_readable_by_rule(null, m.id, s.recipe_stores, s.menu_stores);
$$;

revoke execute on function inv.can_read_recipes_at(uuid), inv.my_recipe_stores(),
  inv.can_read_recipe_of(uuid, uuid, uuid),
  inv.recipe_readable_by_rule(uuid, uuid, uuid[], uuid[]), inv.can_read_recipe(uuid),
  inv.can_read_prep(uuid), menu.can_read_menu_item(uuid), inv.visible_recipe_ids(),
  inv.visible_prep_item_ids(), menu.visible_menu_item_ids() from public;
grant execute on function inv.visible_recipe_ids(), inv.visible_prep_item_ids(),
  menu.visible_menu_item_ids() to app_rw;

-- ---------------------------------------------------------------------------
-- RLS registration (rule 1) and audit (rule 5)
-- ---------------------------------------------------------------------------

insert into core.domain_table (table_name, domain_code, hierarchy_type, catalog, rpc_only) values
  ('inv.item_unit', 'STOCK_LEVELS', 'delivery', true, true);
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('menu.menu_outlet', 'MENU', 'delivery', true);
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only,
                               visible_fn, visible_row_fn, visible_column) values
  ('inv.recipe', 'RECIPES', 'delivery', true,
   'inv.visible_recipe_ids()', 'inv.can_read_recipe(uuid)', 'id'),
  ('inv.recipe_line', 'RECIPES', 'delivery', true,
   'inv.visible_recipe_ids()', 'inv.can_read_recipe(uuid)', 'recipe_id'),
  ('inv.prep_procedure', 'RECIPES', 'delivery', true,
   'inv.visible_prep_item_ids()', 'inv.can_read_prep(uuid)', 'prep_item_id'),
  ('menu.menu_item', 'RECIPES', 'delivery', true,
   'menu.visible_menu_item_ids()', 'menu.can_read_menu_item(uuid)', 'id');

do $$
declare t regclass;
begin
  foreach t in array array['inv.item_unit', 'menu.menu_outlet', 'inv.recipe', 'inv.recipe_line',
                           'inv.prep_procedure', 'menu.menu_item']::regclass[] loop
    perform core.apply_domain_rls(t);
    perform audit.enable(t);
  end loop;
end $$;

grant select, insert, update, delete on all tables in schema menu to platform_loader;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop table inv.prep_procedure, inv.recipe_line, inv.recipe, menu.menu_outlet, menu.menu_item,
  inv.item_unit;
delete from core.domain_table where table_name::text in
  ('inv.item_unit', 'menu.menu_outlet', 'inv.recipe', 'inv.recipe_line', 'inv.prep_procedure',
   'menu.menu_item');
drop function if exists menu.visible_menu_item_ids(), inv.visible_prep_item_ids(), inv.visible_recipe_ids(),
  menu.can_read_menu_item(uuid), inv.can_read_prep(uuid), inv.can_read_recipe(uuid),
  inv.can_read_recipe_of(uuid, uuid, uuid), inv.my_recipe_stores(), inv.recipe_readable_by_rule(uuid, uuid, uuid[], uuid[]),
  inv.can_read_recipes_at(uuid), inv.check_recipe_line(), inv.check_menu_refs();
alter table inv.item_node drop column made_here;
alter table inv.item drop constraint item_prep_fields, drop column shelf_life_hours,
  drop column prep_type, drop column kind;
do $$
declare
  v_src text := pg_get_functiondef('core.apply_domain_rls(regclass)'::regprocedure);
begin
  execute regexp_replace(v_src,
    '  -- Rule-visible rows \(recipes\).*?\n  end if;\n\n(  -- Catalogue rows)', '\1', 's');
end $$;
alter table core.domain_table drop constraint domain_table_visible, drop column visible_column,
  drop column visible_row_fn, drop column visible_fn;
create or replace function core.rls_violations()
returns table (table_name text, problem text)
language sql stable
as $$
  with t as (
    select c.oid, c.oid::regclass::text as name, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('hr', 'inv', 'ops', 'wf', 'ai')
       and c.relkind in ('r', 'p')
       and not c.relispartition
  )
  select name, 'rls_disabled' from t where not relrowsecurity
  union all
  select name, 'not_registered' from t
   where not exists (select 1 from core.domain_table dt where dt.table_name = t.oid)
  union all
  select name, 'no_generated_policies' from t
   where not exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polname like 'dom\_%')
  union all
  select name, 'hand_written_policy' from t
   where exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polname not like 'dom\_%')
  union all
  select name, 'no_audit_trigger' from t
   where not exists (select 1 from pg_trigger tg
                      where tg.tgrelid = t.oid and tg.tgfoid = 'audit.capture'::regproc)
$$;
drop schema menu;
