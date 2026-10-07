-- migrate:up
-- Selling by bundle (ADR 067). A bundle groups module switches (ADR 026) and is what a
-- customer buys: Stock & cost (production, prep lists, menu and sales), People & roster
-- (leave, swaps, events) and Tasks & food safety (checklists, maintenance). Everything without
-- a switch (stock, orders, bills, recipes, the roster, clock-in, tasks, reports) comes with
-- every plan. The same codes as packages/domain/src/bundles.ts; a test keeps them equal.
--
-- The plan is kept in core.tenant.settings under "bundles" ({"tasks_food_safety": false}),
-- beside the modules. A bundle that isn't listed is in the plan, so every existing customer
-- keeps every module it has on today: this migration writes nothing. A module is on when its
-- bundle is in the plan and the company hasn't turned it off. Only a platform admin changes
-- the plan (platform.set_bundle, in the platform audit); the Account Owner still turns single
-- modules off and on inside a bundle that is in the plan, and core.set_module refuses turning
-- one on outside it (NOT_IN_PLAN).

create function core.bundle_codes() returns text[]
language sql immutable
as $$
  select array['people_roster', 'stock_cost', 'tasks_food_safety'];
$$;

create function core.module_bundle(p_code text) returns text
language sql immutable
as $$
  select case p_code
           when 'production' then 'stock_cost'
           when 'prep_lists' then 'stock_cost'
           when 'menu_sales' then 'stock_cost'
           when 'leave' then 'people_roster'
           when 'swaps' then 'people_roster'
           when 'events' then 'people_roster'
           when 'checklists' then 'tasks_food_safety'
           when 'maintenance' then 'tasks_food_safety'
         end;
$$;

-- Internal: whether a bundle is in a company's plan.
create function core.bundle_on(p_tenant uuid, p_bundle text) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce((select (t.settings -> 'bundles' ->> p_bundle)::boolean
                     from core.tenant t where t.id = p_tenant), true);
$$;

-- A module is on when its bundle is in the plan and the company hasn't turned it off.
create or replace function core.module_on(p_tenant uuid, p_code text) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce((select (t.settings -> 'modules' ->> p_code)::boolean
                     from core.tenant t where t.id = p_tenant), true)
         and core.bundle_on(p_tenant, core.module_bundle(p_code))
         and (p_code <> 'prep_lists' or core.module_on(p_tenant, 'production'));
$$;

-- The signed-in person's company's plan (anyone signed in may read it, as the modules).
create function core.my_bundles() returns table (code text, in_plan boolean)
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select c, core.bundle_on(core.my_tenant(), c)
    from unnest(core.bundle_codes()) c
   where core.my_tenant() is not null
   order by c;
$$;

-- As before (ADR 026), and a module can't be turned on outside the plan.
create or replace function core.set_module(p_code text, p_on boolean) returns void
language plpgsql security definer
set search_path = pg_catalog, core
as $$
declare
  v_tenant uuid := core.my_tenant();
begin
  if not (p_code = any (core.module_codes())) or p_on is null then
    raise exception 'INVALID_MODULE' using detail = coalesce(p_code, '');
  end if;
  if v_tenant is null
     or not core.can('COMPANY_SETTINGS', 'modify', core.org_root(v_tenant), null, null) then
    raise exception 'NOT_AUTHORISED' using detail = 'COMPANY_SETTINGS modify at the company';
  end if;
  if p_on and not core.bundle_on(v_tenant, core.module_bundle(p_code)) then
    raise exception 'NOT_IN_PLAN' using detail = core.module_bundle(p_code);
  end if;
  update core.tenant
     set settings = jsonb_set(settings, '{modules}',
                              coalesce(settings -> 'modules', '{}') || jsonb_build_object(p_code, p_on))
   where id = v_tenant
     and (settings -> 'modules' -> p_code) is distinct from to_jsonb(p_on);
end $$;

-- The console's Bundles card: every module of a customer, its bundle, whether the bundle is
-- in the plan and whether the module is on. Platform admins only; switches, nothing else.
create function platform.customer_modules(p_tenant uuid)
returns table (bundle text, module text, in_plan boolean, is_on boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  if not exists (select 1 from core.tenant t where t.id = p_tenant) then
    raise exception 'NOT_FOUND';
  end if;
  return query
    select core.module_bundle(c), c, core.bundle_on(p_tenant, core.module_bundle(c)),
           core.module_on(p_tenant, c)
      from unnest(core.module_codes()) c
     order by 1, 2;
end $$;

-- A platform admin puts a bundle in or out of a customer's plan. In: its modules are turned
-- on, since that is what was sold. Out: its modules are off for the company until it is back;
-- their own switches are kept. In the platform audit; true when something changed.
create function platform.set_bundle(p_tenant uuid, p_bundle text, p_on boolean) returns boolean
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_was boolean;
  v_settings jsonb;
begin
  perform platform.current_admin();
  if p_bundle is null or not (p_bundle = any (core.bundle_codes())) or p_on is null then
    raise exception 'INVALID_BUNDLE' using detail = coalesce(p_bundle, '');
  end if;
  select t.settings, coalesce((t.settings -> 'bundles' ->> p_bundle)::boolean, true)
    into v_settings, v_was
    from core.tenant t where t.id = p_tenant
     for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  if v_was = p_on then
    return false;
  end if;
  v_settings := jsonb_set(v_settings, '{bundles}',
                          coalesce(v_settings -> 'bundles', '{}') || jsonb_build_object(p_bundle, p_on));
  if p_on then
    v_settings := jsonb_set(v_settings, '{modules}',
                            coalesce(v_settings -> 'modules', '{}')
                              - array(select c from unnest(core.module_codes()) c
                                       where core.module_bundle(c) = p_bundle));
  end if;
  update core.tenant set settings = v_settings where id = p_tenant;
  perform platform.log(case when p_on then 'bundle_on' else 'bundle_off' end, p_tenant, null,
                       jsonb_build_object('bundle', p_bundle));
  return true;
end $$;

revoke execute on function core.bundle_on(uuid, text), core.my_bundles(),
  platform.customer_modules(uuid), platform.set_bundle(uuid, text, boolean) from public;
grant execute on function core.my_bundles(), platform.customer_modules(uuid),
  platform.set_bundle(uuid, text, boolean) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function platform.set_bundle(uuid, text, boolean);
drop function platform.customer_modules(uuid);
create or replace function core.set_module(p_code text, p_on boolean) returns void
language plpgsql security definer
set search_path = pg_catalog, core
as $$
declare
  v_tenant uuid := core.my_tenant();
begin
  if not (p_code = any (core.module_codes())) or p_on is null then
    raise exception 'INVALID_MODULE' using detail = coalesce(p_code, '');
  end if;
  if v_tenant is null
     or not core.can('COMPANY_SETTINGS', 'modify', core.org_root(v_tenant), null, null) then
    raise exception 'NOT_AUTHORISED' using detail = 'COMPANY_SETTINGS modify at the company';
  end if;
  update core.tenant
     set settings = jsonb_set(settings, '{modules}',
                              coalesce(settings -> 'modules', '{}') || jsonb_build_object(p_code, p_on))
   where id = v_tenant
     and (settings -> 'modules' -> p_code) is distinct from to_jsonb(p_on);
end $$;
drop function core.my_bundles();
create or replace function core.module_on(p_tenant uuid, p_code text) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce((select (t.settings -> 'modules' ->> p_code)::boolean
                     from core.tenant t where t.id = p_tenant), true)
         and (p_code <> 'prep_lists' or core.module_on(p_tenant, 'production'));
$$;
drop function core.bundle_on(uuid, text);
drop function core.module_bundle(text);
drop function core.bundle_codes();
