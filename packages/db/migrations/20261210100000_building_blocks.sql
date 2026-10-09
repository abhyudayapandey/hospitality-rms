-- migrate:up
-- Building blocks (ADR 085). Every group of functionality is a block (a module switch, ADR
-- 026) sold in a bundle (ADR 067); only the base has no switch: places and people, access, To
-- do, approvals, notifications, Home, Me, Admin, onboarding and the reports shell. The same
-- codes as packages/domain/src/modules.ts and bundles.ts; a test keeps them equal.
--
-- * New blocks for what had no switch: stock, buying, recipes, roster, clock_in, pay
--   (salaries and labour cost, inside People), briefing and minibars. Bundles regrouped:
--   Stock & buying, Kitchen & bar, People, Daily work, Hotel, Events & compliance.
-- * A block needs others (core.module_needs): it is off whenever one of them is.
-- * Off means gone: core.can says no to its domains (core.domain_module), so RLS, which builds
--   on core.can (ADR 007), hides its rows and every function that checks access refuses. Its
--   data is kept; switched back on, it is all there.
-- * Only platform admins change a customer's blocks and bundles (platform.set_module,
--   platform.set_bundle, in the platform audit) and file 00 at onboarding. core.set_module,
--   the Account Owner's switch, is gone.
-- * Salaries & labour cost off: rpt.labour_cost_of gives nothing, so labour cost is 0 and the
--   total cost is materials only, the same in every report.
-- * The nightly attendance exceptions skip customers with Clock-in off.
--
-- Every customer keeps what it has today: the old bundles are translated into switches, and
-- the migration checks that no block that was on goes off (and fails if one would).

-- ---------------------------------------------------------------------------
-- What every customer has before (old functions), to check against afterwards
-- ---------------------------------------------------------------------------
create temporary table bb_before on commit drop as
select t.id as tenant_id, c as code, core.module_on(t.id, c) as is_on
  from core.tenant t cross join unnest(core.module_codes()) c;

-- ---------------------------------------------------------------------------
-- The registry
-- ---------------------------------------------------------------------------

-- In order: a block comes after every block it needs (core.tenant_modules relies on it).
create or replace function core.module_codes() returns text[]
language sql immutable
as $$
  select array['stock', 'buying', 'recipes', 'production', 'prep_lists', 'menu_sales',
               'roster', 'clock_in', 'pay', 'leave', 'swaps',
               'checklists', 'maintenance', 'briefing', 'minibars', 'events', 'compliance'];
$$;

create or replace function core.bundle_codes() returns text[]
language sql immutable
as $$
  select array['stock_buying', 'kitchen_bar', 'people', 'daily_work', 'hotel',
               'events_compliance'];
$$;

create or replace function core.module_bundle(p_code text) returns text
language sql immutable
as $$
  select case p_code
           when 'stock' then 'stock_buying'
           when 'buying' then 'stock_buying'
           when 'recipes' then 'kitchen_bar'
           when 'production' then 'kitchen_bar'
           when 'prep_lists' then 'kitchen_bar'
           when 'menu_sales' then 'kitchen_bar'
           when 'roster' then 'people'
           when 'clock_in' then 'people'
           when 'pay' then 'people'
           when 'leave' then 'people'
           when 'swaps' then 'people'
           when 'checklists' then 'daily_work'
           when 'maintenance' then 'daily_work'
           when 'briefing' then 'daily_work'
           when 'minibars' then 'hotel'
           when 'events' then 'events_compliance'
           when 'compliance' then 'events_compliance'
         end;
$$;

-- The blocks a block can't work without.
create function core.module_needs(p_code text) returns text[]
language sql immutable
as $$
  select case p_code
           when 'buying' then array['stock']
           when 'recipes' then array['stock']
           when 'production' then array['recipes']
           when 'prep_lists' then array['production']
           when 'menu_sales' then array['recipes']
           when 'clock_in' then array['roster']
           when 'pay' then array['roster']
           when 'swaps' then array['roster']
           when 'minibars' then array['stock']
           else '{}'::text[]
         end;
$$;

-- On for a customer that hasn't said: every block but Compliance.
create function core.module_default(p_code text) returns boolean
language sql immutable
as $$
  select p_code <> 'compliance';
$$;

-- In a plan that doesn't say: every bundle but Hotel.
create or replace function core.bundle_default(p_bundle text) returns boolean
language sql immutable
as $$
  select p_bundle <> 'hotel';
$$;

-- The block an access domain belongs to; null for the base.
create function core.domain_module(p_domain text) returns text
language sql immutable
as $$
  select case p_domain
           when 'STOCK_LEVELS' then 'stock'
           when 'STOCK_ADJUSTMENTS' then 'stock'
           when 'STOCK_CHECK' then 'stock'
           when 'TRANSFERS' then 'stock'
           when 'DERIVED_STOCK_LEVELS' then 'stock'
           when 'DERIVED_STOCK_ADJUSTMENTS' then 'stock'
           when 'DERIVED_TRANSFERS' then 'stock'
           when 'PURCHASE_ORDERS' then 'buying'
           when 'BILLS' then 'buying'
           when 'DERIVED_PURCHASE_ORDERS' then 'buying'
           when 'RECIPES' then 'recipes'
           when 'RECIPES_TEAM' then 'recipes'
           when 'PRODUCTION' then 'production'
           when 'PRODUCTION_TEAM' then 'production'
           when 'DERIVED_PRODUCTION' then 'production'
           when 'MENU' then 'menu_sales'
           when 'DERIVED_MENU' then 'menu_sales'
           when 'SALES' then 'menu_sales'
           when 'DERIVED_SALES' then 'menu_sales'
           when 'POS_IMPORT' then 'menu_sales'
           when 'ROSTER' then 'roster'
           when 'ATTENDANCE' then 'clock_in'
           when 'ATTENDANCE_SELFIES' then 'clock_in'
           when 'COMPENSATION' then 'pay'
           when 'LABOUR_COST' then 'pay'
           when 'LEAVE' then 'leave'
           when 'SHIFT_SWAPS' then 'swaps'
           when 'CHECKLIST_TEMPLATES' then 'checklists'
           when 'MAINTENANCE' then 'maintenance'
           when 'BRIEFING' then 'briefing'
           when 'MINIBAR' then 'minibars'
           when 'EVENTS' then 'events'
           when 'COMPLIANCE' then 'compliance'
         end;
$$;

-- ---------------------------------------------------------------------------
-- Every customer's settings in the new bundles, keeping what it has
-- ---------------------------------------------------------------------------
-- Old bundles out of a plan become their blocks switched off (the new bundles are all in);
-- Compliance in a plan becomes the Compliance block switched on (off by default); the Hotel
-- bundle is in for customers with rooms.
update core.tenant t
   set settings = jsonb_set(
         coalesce(t.settings, '{}') - 'bundles', '{modules}',
         coalesce(t.settings -> 'modules', '{}')
           || case when (t.settings -> 'bundles' ->> 'stock_cost')::boolean is false
                   then '{"production": false, "prep_lists": false, "menu_sales": false}'::jsonb
                   else '{}' end
           || case when (t.settings -> 'bundles' ->> 'people_roster')::boolean is false
                   then '{"leave": false, "swaps": false, "events": false}'::jsonb
                   else '{}' end
           || case when (t.settings -> 'bundles' ->> 'tasks_food_safety')::boolean is false
                   then '{"checklists": false, "maintenance": false}'::jsonb
                   else '{}' end
           || case when (t.settings -> 'bundles' ->> 'compliance')::boolean is true
                        and (t.settings -> 'modules' ->> 'compliance') is null
                   then '{"compliance": true}'::jsonb
                   else '{}' end)
       || case when exists (select 1 from ops.room r
                             where r.tenant_id = t.id and r.archived_at is null)
               then '{"bundles": {"hotel": true}}'::jsonb
               else '{}' end;

-- The blocks on for a customer: switched on (or on by default), in a bundle in the plan, and
-- every block it needs on. One read of the customer's settings; core.can calls it.
create function core.tenant_modules(p_tenant uuid) returns text[]
language plpgsql stable security definer
set search_path = pg_catalog, core
as $$
declare
  v_s jsonb;
  v_on text[] := '{}';
  v_c text;
begin
  select coalesce(t.settings, '{}') into v_s from core.tenant t where t.id = p_tenant;
  if not found then
    return v_on;
  end if;
  foreach v_c in array core.module_codes() loop
    if coalesce((v_s -> 'modules' ->> v_c)::boolean, core.module_default(v_c))
       and coalesce((v_s -> 'bundles' ->> core.module_bundle(v_c))::boolean,
                    core.bundle_default(core.module_bundle(v_c)))
       and core.module_needs(v_c) <@ v_on then
      v_on := v_on || v_c;
    end if;
  end loop;
  return v_on;
end $$;

create or replace function core.module_on(p_tenant uuid, p_code text) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select p_code = any (core.tenant_modules(p_tenant));
$$;

-- No block that was on goes off; every new block is on (Room minibars where there are rooms).
do $$
declare
  v_bad text;
begin
  select string_agg(format('%s %s', b.tenant_id, b.code), ', ') into v_bad
    from bb_before b
   where b.is_on and not core.module_on(b.tenant_id, b.code);
  if v_bad is not null then
    raise exception 'building blocks: these would go off: %', v_bad;
  end if;
  select string_agg(format('%s %s', t.id, c), ', ') into v_bad
    from core.tenant t
    cross join unnest(array['stock', 'buying', 'recipes', 'roster', 'clock_in', 'pay',
                            'briefing']) c
   where not core.module_on(t.id, c);
  if v_bad is not null then
    raise exception 'building blocks: these new blocks would be off: %', v_bad;
  end if;
  select string_agg(t.id::text, ', ') into v_bad
    from core.tenant t
   where core.module_on(t.id, 'minibars')
         is distinct from exists (select 1 from ops.room r
                                   where r.tenant_id = t.id and r.archived_at is null);
  if v_bad is not null then
    raise exception 'building blocks: room minibars wrong for: %', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Off means gone: core.can says no to a block's domains while it is off
-- ---------------------------------------------------------------------------
-- The grants alone, as core.can was: who would see a domain whatever is switched on. Only
-- the reports use it (below), to decide who opens a report; the report says itself which block
-- it needs.
do $$
declare
  v_src text := pg_get_functiondef('core.can(text, text, uuid, uuid, uuid)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_src, 'FUNCTION core.can(', 'FUNCTION core.can_granted(');
  if v_new = v_src then raise exception 'core.can_granted: anchor not found'; end if;
  execute v_new;
end $$;

do $$
declare
  v_src text := pg_get_functiondef('core.can(text, text, uuid, uuid, uuid)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_src,
    '(select uid from me) is not null
    and p_access in (''view'', ''modify'')',
    '(select uid from me) is not null
    and p_access in (''view'', ''modify'')
    -- the domain''s block is on for the customer (ADR 085); the base has no block
    and (core.domain_module(p_domain) is null
         or core.domain_module(p_domain) = any (core.tenant_modules((select tenant_id from me))))');
  if v_new = v_src then raise exception 'core.can: anchor not found'; end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Reports: who opens one is decided by the grants; each report needs its block
-- ---------------------------------------------------------------------------
-- A report is part of the base. Who opens one at a place still comes from what they could see
-- there (sales, menus, orders, attendance: ADR 023), so a block switched off doesn't take the
-- outlet's day away from its cost controller; the report itself needs its block (stock
-- position: Stores & stock; purchasing: Supply requests & orders; cost of sales and menu
-- engineering: Menu and sales, which they check already), and its figures from a switched-off block are hidden as before.
-- Labour cost is the exception: it needs Salaries & labour cost on.
create function core.report_can(p_domain text, p_access text, p_org uuid, p_delivery uuid,
                                p_owner uuid default null) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select case when core.domain_module(p_domain) = 'pay'
              then core.can(p_domain, p_access, p_org, p_delivery, p_owner)
              else core.can_granted(p_domain, p_access, p_org, p_delivery, p_owner) end;
$$;

do $$
declare
  v_src text := pg_get_functiondef('core.visible_nodes(text, text)'::regprocedure);
  v_new text;
begin
  v_new := replace(replace(v_src, 'FUNCTION core.visible_nodes(', 'FUNCTION core.report_nodes('),
                   'core.can(', 'core.report_can(');
  if v_new = v_src then raise exception 'core.report_nodes: anchor not found'; end if;
  execute v_new;
end $$;

do $$
declare
  v_fn regprocedure;
  v_src text;
  v_new text;
begin
  foreach v_fn in array array[
    'rpt.can_open(text, uuid)', 'rpt.report_places(text)', 'rpt.department_day(uuid, date)',
    'rpt.store_cost_access(uuid)', 'rpt.cost_stores(uuid)',
    'rpt.menu_engineering(uuid, date, date)', 'rpt.people_summary(uuid, date, date)',
    'rpt.people_flags(uuid, date, date)', 'rpt.people_leave(uuid, date, date)',
    'rpt.dish_trend(uuid, uuid, text, date, date)',
    'rpt.measure_trend(text, uuid, text, text, date, date, uuid)',
    'rpt.bd_scope(text, uuid, text[])', 'rpt.bd_require_people(uuid)']::regprocedure[]
  loop
    v_src := pg_get_functiondef(v_fn);
    v_new := replace(replace(v_src, 'core.can(', 'core.report_can('),
                     'core.visible_nodes(', 'core.report_nodes(');
    if v_new = v_src then raise exception '%: no access check found', v_fn; end if;
    execute v_new;
  end loop;
end $$;

do $$
declare
  v_src text := pg_get_functiondef('rpt.can_open(text, uuid)'::regprocedure);
  v_new text := v_src;
begin
  v_new := replace(v_new, 'when ''stock_position'' then',
    'when ''stock_position'' then core.module_on(n.tenant_id, ''stock'') and');
  v_new := replace(v_new, 'when ''purchasing'' then',
    'when ''purchasing'' then core.module_on(n.tenant_id, ''buying'') and');
  if (length(v_new) - length(v_src)) < 2 * length(' core.module_on(n.tenant_id, ''stock'') and') then
    raise exception 'rpt.can_open: anchors not found';
  end if;
  execute v_new;
  v_src := pg_get_functiondef('rpt.my_reports()'::regprocedure);
  v_new := replace(v_src,
    'when ''cost_of_sales'' then core.module_on(core.my_tenant(), ''menu_sales'')',
    'when ''stock_position'' then core.module_on(core.my_tenant(), ''stock'')
                                     and exists (select 1 from rpt.report_places(v.r))
           when ''purchasing'' then core.module_on(core.my_tenant(), ''buying'')
                                    and exists (select 1 from rpt.report_places(v.r))
           when ''cost_of_sales'' then core.module_on(core.my_tenant(), ''menu_sales'')');
  if v_new = v_src then raise exception 'rpt.my_reports: anchor not found'; end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Only platform admins change blocks and bundles
-- ---------------------------------------------------------------------------
drop function core.set_module(text, boolean);

-- A platform admin switches one block of a customer on or off. On only inside a bundle in the
-- plan (NOT_IN_PLAN). In the platform audit; true when something changed.
create function platform.set_module(p_tenant uuid, p_code text, p_on boolean) returns boolean
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_settings jsonb;
  v_was boolean;
begin
  perform platform.current_admin();
  if p_code is null or not (p_code = any (core.module_codes())) or p_on is null then
    raise exception 'INVALID_MODULE' using detail = coalesce(p_code, '');
  end if;
  select coalesce(t.settings, '{}'),
         coalesce((t.settings -> 'modules' ->> p_code)::boolean, core.module_default(p_code))
    into v_settings, v_was
    from core.tenant t where t.id = p_tenant
     for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  if p_on and not core.bundle_on(p_tenant, core.module_bundle(p_code)) then
    raise exception 'NOT_IN_PLAN' using detail = core.module_bundle(p_code);
  end if;
  if v_was = p_on then
    return false;
  end if;
  update core.tenant
     set settings = jsonb_set(v_settings, '{modules}',
                              coalesce(v_settings -> 'modules', '{}') || jsonb_build_object(p_code, p_on))
   where id = p_tenant;
  perform platform.log(case when p_on then 'module_on' else 'module_off' end, p_tenant, null,
                       jsonb_build_object('module', p_code));
  return true;
end $$;

-- A platform admin puts a bundle in or out of a customer's plan. In: every block in it is
-- switched on, since that is what was sold. Out: its blocks are off until it is back; their
-- own switches are kept. In the platform audit; true when something changed.
create or replace function platform.set_bundle(p_tenant uuid, p_bundle text, p_on boolean)
returns boolean
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
  select coalesce(t.settings, '{}'),
         coalesce((t.settings -> 'bundles' ->> p_bundle)::boolean, core.bundle_default(p_bundle))
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
                              || (select jsonb_object_agg(c, true)
                                    from unnest(core.module_codes()) c
                                   where core.module_bundle(c) = p_bundle));
  end if;
  update core.tenant set settings = v_settings where id = p_tenant;
  perform platform.log(case when p_on then 'bundle_on' else 'bundle_off' end, p_tenant, null,
                       jsonb_build_object('bundle', p_bundle));
  return true;
end $$;

-- The console's card per bundle: every block of a customer, whether its bundle is in the plan,
-- whether it is switched on, and whether it is on (switched on, and what it needs is on).
drop function platform.customer_modules(uuid);
create function platform.customer_modules(p_tenant uuid)
returns table (bundle text, module text, in_plan boolean, switched_on boolean, is_on boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_s jsonb;
begin
  perform platform.current_admin();
  select coalesce(t.settings, '{}') into v_s from core.tenant t where t.id = p_tenant;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  return query
    select core.module_bundle(c), c, core.bundle_on(p_tenant, core.module_bundle(c)),
           coalesce((v_s -> 'modules' ->> c)::boolean, core.module_default(c)),
           core.module_on(p_tenant, c)
      from unnest(core.module_codes()) with ordinality as x (c, n)
     order by x.n;
end $$;

-- ---------------------------------------------------------------------------
-- Salaries & labour cost off: no labour cost anywhere, so total cost is materials only
-- ---------------------------------------------------------------------------
create function rpt.pay_on(p_place uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select core.module_on((select n.tenant_id from core.hierarchy_node n where n.id = p_place), 'pay');
$$;

do $$
declare
  v_src text := pg_get_functiondef('rpt.labour_cost_of(uuid, date, date)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_src,
    'where p_to >= rpt.today(p_outlet) - 1',
    'where p_to >= rpt.today(p_outlet) - 1 and rpt.pay_on(p_outlet)');
  v_new := replace(v_new,
    'where l.outlet_id = p_outlet and l.people > 0',
    'where l.outlet_id = p_outlet and l.people > 0 and rpt.pay_on(p_outlet)');
  if v_new = v_src or (length(v_new) - length(v_src)) <> 2 * length(' and rpt.pay_on(p_outlet)') then
    raise exception 'rpt.labour_cost_of: anchors not found';
  end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Jobs skip switched-off blocks: no attendance exceptions without Clock-in
-- ---------------------------------------------------------------------------
do $$
declare
  v_src text := pg_get_functiondef('hr.nightly_attendance(timestamptz, int)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_src,
    '  loop
    v_today := (p_as_of at time zone hr.node_tz(v_w.org_node_id))::date;',
    '  loop
    continue when not core.module_on(v_w.tenant_id, ''clock_in'');
    v_today := (p_as_of at time zone hr.node_tz(v_w.org_node_id))::date;');
  if v_new = v_src then raise exception 'hr.nightly_attendance: anchor not found'; end if;
  execute v_new;
end $$;

revoke execute on function core.can_granted(text, text, uuid, uuid, uuid),
  core.report_can(text, text, uuid, uuid, uuid), core.report_nodes(text, text)
  from public;
grant execute on function core.can_granted(text, text, uuid, uuid, uuid),
  core.report_can(text, text, uuid, uuid, uuid), core.report_nodes(text, text)
  to app_rw, wf_executor;
revoke execute on function core.module_needs(text), core.module_default(text),
  core.domain_module(text), core.tenant_modules(uuid), rpt.pay_on(uuid),
  platform.set_module(uuid, text, boolean), platform.customer_modules(uuid) from public;
grant execute on function core.module_needs(text), core.module_default(text),
  core.domain_module(text) to app_rw, wf_executor, platform_loader;
grant execute on function rpt.pay_on(uuid) to app_rw, wf_executor;
-- the loader skips pay rates while Salaries & labour cost is off
grant execute on function core.module_on(uuid, text), core.tenant_modules(uuid) to platform_loader;
grant execute on function platform.set_module(uuid, text, boolean),
  platform.customer_modules(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shapes for local work.
-- The settings are not translated back: run the seed again.
do $$
declare
  v_src text := pg_get_functiondef('hr.nightly_attendance(timestamptz, int)'::regprocedure);
begin
  execute replace(v_src, '
    continue when not core.module_on(v_w.tenant_id, ''clock_in'');', '');
end $$;
do $$
declare
  v_src text := pg_get_functiondef('rpt.labour_cost_of(uuid, date, date)'::regprocedure);
begin
  execute replace(v_src, ' and rpt.pay_on(p_outlet)', '');
end $$;
drop function rpt.pay_on(uuid);
do $$
declare
  v_fn regprocedure;
  v_src text;
begin
  foreach v_fn in array array[
    'rpt.can_open(text, uuid)', 'rpt.report_places(text)', 'rpt.department_day(uuid, date)',
    'rpt.store_cost_access(uuid)', 'rpt.cost_stores(uuid)',
    'rpt.menu_engineering(uuid, date, date)', 'rpt.people_summary(uuid, date, date)',
    'rpt.people_flags(uuid, date, date)', 'rpt.people_leave(uuid, date, date)',
    'rpt.dish_trend(uuid, uuid, text, date, date)',
    'rpt.measure_trend(text, uuid, text, text, date, date, uuid)',
    'rpt.bd_scope(text, uuid, text[])', 'rpt.bd_require_people(uuid)']::regprocedure[]
  loop
    v_src := pg_get_functiondef(v_fn);
    execute replace(replace(v_src, 'core.report_can(', 'core.can('),
                    'core.report_nodes(', 'core.visible_nodes(');
  end loop;
  v_src := pg_get_functiondef('rpt.can_open(text, uuid)'::regprocedure);
  v_src := replace(v_src, ' core.module_on(n.tenant_id, ''stock'') and', '');
  execute replace(v_src, ' core.module_on(n.tenant_id, ''buying'') and', '');
  v_src := pg_get_functiondef('rpt.my_reports()'::regprocedure);
  execute replace(v_src, 'when ''stock_position'' then core.module_on(core.my_tenant(), ''stock'')
                                     and exists (select 1 from rpt.report_places(v.r))
           when ''purchasing'' then core.module_on(core.my_tenant(), ''buying'')
                                    and exists (select 1 from rpt.report_places(v.r))
           ', '');
end $$;
drop function core.report_nodes(text, text), core.report_can(text, text, uuid, uuid, uuid),
  core.can_granted(text, text, uuid, uuid, uuid);
do $$
declare
  v_src text := pg_get_functiondef('core.can(text, text, uuid, uuid, uuid)'::regprocedure);
begin
  execute replace(v_src, '
    -- the domain''s block is on for the customer (ADR 085); the base has no block
    and (core.domain_module(p_domain) is null
         or core.domain_module(p_domain) = any (core.tenant_modules((select tenant_id from me))))', '');
end $$;
drop function platform.customer_modules(uuid);
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
grant execute on function platform.customer_modules(uuid) to app_rw;
drop function platform.set_module(uuid, text, boolean);
create or replace function platform.set_bundle(p_tenant uuid, p_bundle text, p_on boolean)
returns boolean
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
  select t.settings,
         coalesce((t.settings -> 'bundles' ->> p_bundle)::boolean, core.bundle_default(p_bundle))
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
create function core.set_module(p_code text, p_on boolean) returns void
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
revoke execute on function core.set_module(text, boolean) from public;
grant execute on function core.set_module(text, boolean) to app_rw;
create or replace function core.module_on(p_tenant uuid, p_code text) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce((select (t.settings -> 'modules' ->> p_code)::boolean
                     from core.tenant t where t.id = p_tenant), true)
         and core.bundle_on(p_tenant, core.module_bundle(p_code))
         and (p_code <> 'prep_lists' or core.module_on(p_tenant, 'production'));
$$;
drop function core.tenant_modules(uuid);
create or replace function core.bundle_default(p_bundle text) returns boolean
language sql immutable
as $$
  select p_bundle <> 'compliance';
$$;
drop function core.domain_module(text), core.module_default(text), core.module_needs(text);
create or replace function core.module_bundle(p_code text) returns text
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
           when 'compliance' then 'compliance'
         end;
$$;
create or replace function core.bundle_codes() returns text[]
language sql immutable
as $$
  select array['compliance', 'people_roster', 'stock_cost', 'tasks_food_safety'];
$$;
create or replace function core.module_codes() returns text[]
language sql immutable
as $$
  select array['checklists', 'compliance', 'events', 'leave', 'maintenance', 'menu_sales',
               'prep_lists', 'production', 'swaps'];
$$;
