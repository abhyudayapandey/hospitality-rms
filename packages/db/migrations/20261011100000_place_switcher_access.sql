-- migrate:up
-- Prompt 10a (ADR 016): the access changes behind the place switcher and the UX audit.
--
--   * PRODUCTION_TEAM (an org domain and group, like RECIPES_TEAM): record production at
--     the store linked to the person's department, for items made there. Nothing else:
--     no stock, count, wastage, order or transfer access.
--   * Events are outlet-level. New events go on an outlet (or a central kitchen site);
--     existing ones move to their outlet. Everyone with EVENTS view at the outlet or at a
--     department under it reads them. EVENT_PLANNER (product sync) creates and edits them;
--     DEPARTMENT_HEAD drops to view.
--   * core.screen_places(screen): the places the "Viewing:" switcher offers on a screen.
--   * core.admin_job_roles(home): only job roles the admin can give someone at their
--     places, by the checks a save makes.
-- The groups and the product matrix are written by the product sync (packages/domain).

-- ---------------------------------------------------------------------------
-- PRODUCTION_TEAM
-- ---------------------------------------------------------------------------

-- Can the current user record production at store p_store? PRODUCTION modify there, or
-- PRODUCTION_TEAM at a department linked to it (kitchen staff -> kitchen store).
create function inv.can_produce_at(p_store uuid) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  return core.can('PRODUCTION', 'modify', null, p_store)
      or exists (select 1 from core.node_link nl
                   join core.hierarchy_node o on o.id = nl.org_node_id and o.kind = 'department'
                  where nl.delivery_node_id = p_store
                    and core.can('PRODUCTION_TEAM', 'modify', o.id, null));
end $$;

do $$
declare
  v_fn regprocedure;
  v_src text;
  v_old text;
  v_new text;
begin
  foreach v_fn in array array[
    'inv.record_production(uuid, uuid, numeric, jsonb, text)'::regprocedure,
    'inv.production_plan(uuid, uuid)'::regprocedure,
    'inv.made_here(uuid)'::regprocedure] loop
    v_src := pg_get_functiondef(v_fn);
    v_old := 'not core.can(''PRODUCTION'', ''modify'', null, p_store)';
    if position(v_old in v_src) = 0 then
      raise exception '% changed; update this migration', v_fn;
    end if;
    execute replace(v_src, v_old, 'not inv.can_produce_at(p_store)');
  end loop;

  -- the batch list on the production screen: stock viewers, and whoever records there
  v_src := pg_get_functiondef('inv.batches(uuid)'::regprocedure);
  v_old := 'if not core.can(''STOCK_LEVELS'', ''view'', null, p_store) then';
  v_new := 'if not (core.can(''STOCK_LEVELS'', ''view'', null, p_store)
          or inv.can_produce_at(p_store)) then';
  if position(v_old in v_src) = 0 then
    raise exception 'inv.batches changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- ---------------------------------------------------------------------------
-- Events at the outlet
-- ---------------------------------------------------------------------------

-- Row by row (the RLS equivalence test holds the policy to this): EVENTS view at the
-- event's place, or, for an outlet or site, at any place under it.
create function ops.can_read_event_node(p_node uuid) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, core, extensions
as $$
begin
  return core.can('EVENTS', 'view', p_node, null)
      or exists (select 1 from core.hierarchy_node o
                   join core.hierarchy_node d on d.tenant_id = o.tenant_id
                                             and d.path operator(extensions.<@) o.path
                                             and d.id <> o.id
                  where o.id = p_node and o.kind in ('outlet', 'site')
                    and core.can('EVENTS', 'view', d.id, null));
end $$;

-- Per query (what the policies use): the places the caller reads, plus the outlets and
-- sites above them.
create function ops.visible_event_nodes() returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  with v as (select unnest(core.visible_nodes('EVENTS', 'view')) as id)
  select coalesce(array_agg(distinct x.id), '{}') from (
    select id from v
    union
    select o.id from v
      join core.hierarchy_node d on d.id = v.id
      join core.hierarchy_node o on o.tenant_id = d.tenant_id and o.kind in ('outlet', 'site')
                                and d.path operator(extensions.<@) o.path and o.id <> d.id) x;
$$;

update core.domain_table
   set visible_fn = 'ops.visible_event_nodes()'::regprocedure,
       visible_row_fn = 'ops.can_read_event_node(uuid)'::regprocedure,
       visible_column = 'org_node_id'
 where table_name in ('ops.event'::regclass, 'ops.event_requirement'::regclass);
select core.apply_domain_rls('ops.event');
select core.apply_domain_rls('ops.event_requirement');

-- Existing events move to their outlet (or site).
update ops.event e set org_node_id = o.id
  from core.hierarchy_node n, core.hierarchy_node o
 where n.id = e.org_node_id and n.kind not in ('outlet', 'site')
   and o.id = core.nearest(e.org_node_id, array['outlet', 'site']);
update ops.event_requirement q set org_node_id = e.org_node_id
  from ops.event e where e.id = q.event_id and q.org_node_id <> e.org_node_id;

do $$
declare
  v_src text := pg_get_functiondef(
    'ops.upsert_event(uuid, uuid, text, timestamptz, timestamptz, int, text, jsonb, text, text)'::regprocedure);
  v_old text := '  else
    perform hr.require(''EVENTS'', ''modify'', p_node);
  end if;';
  v_new text := '  else
    perform hr.require(''EVENTS'', ''modify'', p_node);
    if not exists (select 1 from core.hierarchy_node
                    where id = p_node and kind in (''outlet'', ''site'')) then
      perform hr.fail(''OUTLET_REQUIRED'', ''events are planned for a whole outlet'');
    end if;
  end if;';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'ops.upsert_event changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- ---------------------------------------------------------------------------
-- The place switcher
-- ---------------------------------------------------------------------------

-- A place a team works in: a department, or an outlet or site without departments.
create function core.is_team_place(p_node uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce((
    select n.type = 'org'
           and (n.kind = 'department'
                or (n.kind in ('outlet', 'site')
                    and not exists (select 1 from core.hierarchy_node d
                                     where d.parent_id = n.id and d.kind = 'department'
                                       and d.archived_at is null)))
      from core.hierarchy_node n where n.id = p_node), false);
$$;

-- The places a screen can show for the current user, each passing that screen's check,
-- most useful first: preferred 1 = their home place (or its outlet), 2 = the store linked
-- to their home department, 3 = their outlet's main stock location, 9 = any other.
create function core.screen_places(p_screen text)
returns table (id uuid, code text, name text, kind text, type text, timezone text,
               preferred int)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, inv, menu, ops
as $$
declare
  v_home uuid := (select w.org_node_id from hr.worker w
                   where w.owner_user_id = core.current_user_id());
  v_outlet uuid := core.nearest(v_home, array['outlet', 'site']);
  v_stores uuid[];
  v_main uuid;
begin
  if p_screen is null or p_screen not in ('stock', 'count', 'wastage', 'orders', 'transfers',
      'variance', 'production', 'sales', 'menu', 'roster', 'exceptions', 'events') then
    raise exception 'INVALID_SCREEN' using detail = coalesce(p_screen, 'none');
  end if;
  v_stores := array(select nl.delivery_node_id from core.node_link nl
                     where nl.org_node_id = v_home);
  v_main := (select core.stock_location_of(nl.delivery_node_id) from core.node_link nl
               join core.hierarchy_node d on d.id = nl.delivery_node_id
              where nl.org_node_id = v_outlet and d.kind in ('outlet', 'hub')
              order by d.id limit 1);
  return query
    select n.id, n.code, n.name, n.kind, n.type,
           coalesce(n.timezone, (select t.default_timezone from core.tenant t
                                  where t.id = n.tenant_id)),
           case when n.id = v_home or n.id = v_outlet then 1
                when n.id = any (v_stores) then 2
                when n.id = v_main then 3
                else 9 end
      from core.hierarchy_node n
     where n.tenant_id = core.my_tenant() and n.archived_at is null
       and case
         when p_screen in ('stock', 'count', 'wastage', 'orders', 'transfers', 'variance',
                           'production') then
           n.type = 'delivery' and n.holds_stock and case p_screen
             when 'stock' then core.can('STOCK_LEVELS', 'view', null, n.id)
             when 'count' then core.can('STOCK_ADJUSTMENTS', 'modify', null, n.id)
             when 'wastage' then core.can('STOCK_ADJUSTMENTS', 'modify', null, n.id)
             when 'orders' then core.can('PURCHASE_ORDERS', 'view', null, n.id)
             when 'transfers' then core.can('TRANSFERS', 'view', null, n.id)
             when 'variance' then core.can('MENU', 'view', null, n.id)
             else exists (select 1 from inv.item_node x
                           where x.delivery_node_id = n.id and x.made_here
                             and x.archived_at is null)
                  and inv.can_produce_at(n.id) end
         when p_screen in ('sales', 'menu') then
           n.type = 'org'
           and exists (select 1 from menu.menu_outlet mo
                        where mo.org_node_id = n.id
                          and (mo.effective_to is null or mo.effective_to >= current_date)
                          and core.can(case p_screen when 'sales' then 'SALES' else 'MENU' end,
                                       case p_screen when 'sales' then 'modify' else 'view' end,
                                       null, mo.delivery_node_id))
         when p_screen = 'events' then
           n.type = 'org' and n.kind in ('outlet', 'site') and ops.can_read_event_node(n.id)
         else
           core.is_team_place(n.id)
           and case p_screen
             when 'roster' then core.can('ROSTER', 'view', n.id, null)
             else core.can('ATTENDANCE', 'modify', n.id, null) end
       end
     order by 7, n.name;
end $$;

-- The current user's home place, and whether it is at an outlet or below (people whose
-- home is a company, region or area have no shifts or clock: audit #13).
create function core.my_home()
returns table (id uuid, name text, kind text, at_workplace boolean)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select n.id, n.name, n.kind, core.nearest(n.id, array['outlet', 'site']) is not null
    from hr.worker w join core.hierarchy_node n on n.id = w.org_node_id
   where w.owner_user_id = core.current_user_id() and w.status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- Job roles an admin can assign
-- ---------------------------------------------------------------------------

-- What a job role gives someone whose home is p_home (the body of
-- core.derive_job_role_access, which now calls this for the person's worker row).
create function core.derive_job_role_access_at(p_tenant uuid, p_role text, p_home uuid)
returns table (access_group text, node_id uuid, include_descendants boolean, source text,
               error text)
language plpgsql stable
set search_path = pg_catalog, core, hr
as $$
#variable_conflict use_column
declare
  g record;
  v_outlet core.hierarchy_node;
  v_supply core.hierarchy_node;
  v_format text;
  v_source text;
  v_node uuid;
  v_note text;
  v_err text;
begin
  select * into v_outlet from core.hierarchy_node
   where id = core.nearest(p_home, array['outlet', 'site']);
  select * into v_supply from core.hierarchy_node d
   where d.id = (select nl.delivery_node_id from core.node_link nl
                   join core.hierarchy_node x on x.id = nl.delivery_node_id
                  where nl.org_node_id = v_outlet.id and x.kind in ('outlet', 'hub')
                  limit 1);
  v_format := case when exists (select 1 from hr.job_role_access a
                                 where a.tenant_id = p_tenant
                                   and a.job_role_code = p_role
                                   and a.outlet_format = v_outlet.outlet_format)
                   then v_outlet.outlet_format else 'any' end;
  v_source := 'job role default (' || v_format || ')';

  for g in select * from hr.job_role_access a
            where a.tenant_id = p_tenant and a.job_role_code = p_role
              and a.outlet_format = v_format
            order by a.position loop
    v_node := null;
    v_note := null;
    v_err := null;
    case
      when g.scope = 'home_department' then
        v_node := p_home;
      when g.scope = 'whole_outlet' then
        v_node := v_outlet.id;
        v_err := case when v_node is null then 'NO_OUTLET' end;
      when g.scope = 'outlet_stores' then
        v_node := v_supply.id;
        v_err := case when v_node is null then 'NO_SUPPLY_POINT' end;
      when g.scope = 'department_store' then
        select nl.delivery_node_id into v_node
          from core.node_link nl
          join core.hierarchy_node o on o.id = nl.org_node_id and o.kind = 'department'
          join core.hierarchy_node d on d.id = nl.delivery_node_id and d.kind = 'store'
         where nl.org_node_id = p_home limit 1;
        if v_node is null then
          v_node := core.stock_location_of(v_supply.id);
          v_note := 'no store linked to their department, so the outlet''s stock location';
          v_err := case when v_node is null then 'NO_STOCK_LOCATION' end;
        end if;
      when g.scope = 'main_store' then
        select s.id into v_node from core.hierarchy_node s
         where s.parent_id = v_supply.id and s.is_main_store and s.archived_at is null;
        if v_node is null then
          if v_supply.holds_stock then
            v_node := v_supply.id;
            v_note := 'no main store, so the outlet''s stock location';
          else
            v_err := 'MAIN_STORE_REQUIRED';
          end if;
        end if;
      when g.scope like 'department:%' then
        select d.id into v_node from core.hierarchy_node d
         where d.parent_id = v_outlet.id and d.kind = 'department'
           and d.code = v_outlet.code || '-' || substr(g.scope, 12);
        v_err := case when v_node is null then 'DEPARTMENT_NOT_FOUND' end;
      when g.scope = 'central_kitchen' then
        v_node := core.nearest(p_home, array['site']);
        v_err := case when v_node is null then 'NO_CENTRAL_KITCHEN' end;
      when g.scope = 'central_kitchen_store' then
        select nl.delivery_node_id into v_node from core.node_link nl
         where nl.org_node_id = core.nearest(p_home, array['site']) limit 1;
        v_err := case when v_node is null then 'NO_CENTRAL_KITCHEN' end;
      when g.scope = 'whole_area' then
        v_node := core.nearest(p_home, array['area']);
        v_err := case when v_node is null then 'NO_AREA' end;
      when g.scope = 'whole_company' then
        v_node := core.nearest(p_home, array['company']);
        v_err := case when v_node is null then 'NO_COMPANY' end;
    end case;
    access_group := g.access_group;
    node_id := case when v_err is null then v_node end;
    include_descendants := g.include_descendants;
    source := v_source || coalesce(' — fallback: ' || v_note, '');
    error := case when v_err is not null then v_err || ' (' || g.scope || ')' end;
    return next;
  end loop;
end $$;

create or replace function core.derive_job_role_access(p_user uuid)
returns table (access_group text, node_id uuid, include_descendants boolean, source text,
               error text)
language plpgsql stable
set search_path = pg_catalog, core, hr
as $$
begin
  return query
    select d.* from hr.worker wk,
           core.derive_job_role_access_at(wk.tenant_id, wk.role_code, wk.org_node_id) d
     where wk.owner_user_id = p_user;
end $$;

-- The job roles the admin form offers: those the caller could give someone at p_home (or
-- at any place in their administration): every grant the role derives there is inside
-- their administration and within their rank, as core.create_user checks on save.
drop function core.admin_job_roles();
create function core.admin_job_roles(p_home uuid default null)
returns table (code text, name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_rank int;
begin
  perform core.require_user_admin('modify');
  if p_home is not null
     and not (exists (select 1 from core.hierarchy_node
                       where id = p_home and tenant_id = core.my_tenant() and type = 'org')
              and core.in_user_access_scope(p_home, 'modify')) then
    perform wf.fail('NOT_AUTHORISED', 'the place is outside your user administration');
  end if;
  v_rank := core.admin_rank(core.current_user_id());
  return query
    with homes as materialized (
      select h.id from core.hierarchy_node h
       where h.tenant_id = core.my_tenant() and h.type = 'org' and h.archived_at is null
         and (p_home is null or h.id = p_home)
         and core.in_user_access_scope(h.id, 'modify'))
    select j.code, j.name from hr.job_role j
     where j.tenant_id = core.my_tenant() and j.archived_at is null
       and exists (select 1 from homes h
                    where not exists (
                      select 1 from core.derive_job_role_access_at(j.tenant_id, j.code, h.id) d
                       where d.error is not null
                          or not coalesce(core.in_user_access_scope(d.node_id, 'modify'), false)
                          or core.group_rank(d.access_group) > v_rank))
     order by j.name;
end $$;

revoke execute on function inv.can_produce_at(uuid), ops.can_read_event_node(uuid),
  ops.visible_event_nodes(), core.is_team_place(uuid), core.screen_places(text),
  core.my_home(), core.derive_job_role_access_at(uuid, text, uuid), core.admin_job_roles(uuid)
  from public;
grant execute on function inv.can_produce_at(uuid), ops.can_read_event_node(uuid),
  ops.visible_event_nodes(), core.screen_places(text), core.my_home(),
  core.admin_job_roles(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function core.admin_job_roles(uuid);
create function core.admin_job_roles()
returns table (code text, name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf
as $$
begin
  perform core.require_user_admin('modify');
  return query
    select j.code, j.name from hr.job_role j
     where j.tenant_id = core.my_tenant() and j.archived_at is null order by j.name;
end $$;
revoke execute on function core.admin_job_roles() from public;
grant execute on function core.admin_job_roles() to app_rw;
drop function core.my_home(), core.screen_places(text), core.is_team_place(uuid);
update core.domain_table set visible_fn = null, visible_row_fn = null, visible_column = null
 where table_name in ('ops.event'::regclass, 'ops.event_requirement'::regclass);
select core.apply_domain_rls('ops.event');
select core.apply_domain_rls('ops.event_requirement');
drop function ops.visible_event_nodes(), ops.can_read_event_node(uuid);
-- record_production, production_plan, made_here, batches, upsert_event and
-- derive_job_role_access keep their new bodies (forward-only); restore from the earlier
-- migrations by hand if needed.
