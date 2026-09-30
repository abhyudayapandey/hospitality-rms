-- migrate:up
-- Job roles carry default access (ADR 009, onboarding file 06). Each job role lists
-- access-group@scope pairs; a customer can override them per outlet format (a Bar Manager
-- in a standalone bar runs the outlet). Scope words are resolved against the person's
-- home place by walking the tree, never by assuming a level exists:
--
--   home_department        the home place itself
--   whole_outlet           the nearest outlet (or site) at or above home
--   outlet_stores          that outlet's supply point and everything in it
--   department_store       the store linked to the home department; if none, the
--                          outlet's stock location (fallback, noted in the source)
--   main_store             the supply point's main store; if the supply point holds
--                          stock itself, it (fallback); otherwise an error
--   department:<CODE>      the department <outlet code>-<CODE> of the outlet
--   central_kitchen        the nearest site at or above home; _store: its linked store
--   whole_area / whole_company   the nearest area / the company
--
-- Derived assignments are tagged source = 'job_role' so they can be re-derived without
-- touching extra (file 08) or manual ones.

alter table hr.job_role add column usual_department text;

create table hr.job_role_access (
  id uuid primary key default core.uuid_v7(),
  tenant_id uuid not null references core.tenant (id),
  job_role_code text not null,
  outlet_format text not null default 'any'
    check (outlet_format in ('any', 'full_hotel', 'small_hotel', 'standalone_bar')),
  access_group text not null,
  scope text not null check (scope ~ ('^(home_department|whole_outlet|outlet_stores|'
    || 'department_store|main_store|central_kitchen|central_kitchen_store|whole_area|'
    || 'whole_company|department:[A-Z0-9][A-Z0-9-]*)$')),
  include_descendants boolean not null default true,
  position int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default core.current_user_id(),
  updated_at timestamptz not null default now(),
  updated_by uuid default core.current_user_id(),
  foreign key (tenant_id, job_role_code) references hr.job_role (tenant_id, code),
  unique (tenant_id, job_role_code, outlet_format, access_group, scope)
);

insert into core.domain_table (table_name, domain_code, hierarchy_type, catalog, rpc_only)
values ('hr.job_role_access', 'USER_ACCESS', 'org', true, true);
select core.apply_domain_rls('hr.job_role_access');
select audit.enable('hr.job_role_access', false);
create trigger touch before update on hr.job_role_access
  for each row execute function core.touch();

alter table core.role_assignment
  add column source text check (source in ('job_role', 'extra')),
  add column source_note text;

-- The nearest node at or above p_node whose kind is one of p_kinds.
create function core.nearest(p_node uuid, p_kinds text[]) returns uuid
language sql stable
set search_path = pg_catalog, core
as $$
  select n.id from core.self_and_ancestors(p_node) a
    join core.hierarchy_node n on n.id = a.id
   where n.kind = any (p_kinds)
   order by a.depth desc limit 1;
$$;
revoke execute on function core.nearest(uuid, text[]) from public;

-- Default access for a user from their worker row's job role and home place. Problems come
-- back as rows with error set (and no node), so a dry run can report every one of them.
create function core.derive_job_role_access(p_user uuid)
returns table (access_group text, node_id uuid, include_descendants boolean, source text,
               error text)
language plpgsql stable
set search_path = pg_catalog, core, hr
as $$
#variable_conflict use_column
declare
  w record;
  g record;
  v_outlet core.hierarchy_node;
  v_supply core.hierarchy_node;
  v_format text;
  v_source text;
  v_node uuid;
  v_note text;
  v_err text;
begin
  select wk.tenant_id, wk.role_code, wk.org_node_id into w
    from hr.worker wk where wk.owner_user_id = p_user;
  if not found then
    return;
  end if;
  select * into v_outlet from core.hierarchy_node
   where id = core.nearest(w.org_node_id, array['outlet', 'site']);
  select * into v_supply from core.hierarchy_node d
   where d.id = (select nl.delivery_node_id from core.node_link nl
                   join core.hierarchy_node x on x.id = nl.delivery_node_id
                  where nl.org_node_id = v_outlet.id and x.kind in ('outlet', 'hub')
                  limit 1);
  v_format := case when exists (select 1 from hr.job_role_access a
                                 where a.tenant_id = w.tenant_id
                                   and a.job_role_code = w.role_code
                                   and a.outlet_format = v_outlet.outlet_format)
                   then v_outlet.outlet_format else 'any' end;
  v_source := 'job role default (' || v_format || ')';

  for g in select * from hr.job_role_access a
            where a.tenant_id = w.tenant_id and a.job_role_code = w.role_code
              and a.outlet_format = v_format
            order by a.position loop
    v_node := null;
    v_note := null;
    v_err := null;
    case
      when g.scope = 'home_department' then
        v_node := w.org_node_id;
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
         where nl.org_node_id = w.org_node_id limit 1;
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
        v_node := core.nearest(w.org_node_id, array['site']);
        v_err := case when v_node is null then 'NO_CENTRAL_KITCHEN' end;
      when g.scope = 'central_kitchen_store' then
        select nl.delivery_node_id into v_node from core.node_link nl
         where nl.org_node_id = core.nearest(w.org_node_id, array['site']) limit 1;
        v_err := case when v_node is null then 'NO_CENTRAL_KITCHEN' end;
      when g.scope = 'whole_area' then
        v_node := core.nearest(w.org_node_id, array['area']);
        v_err := case when v_node is null then 'NO_AREA' end;
      when g.scope = 'whole_company' then
        v_node := core.nearest(w.org_node_id, array['company']);
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

-- Where an outlet's stock is held: the supply point itself if it holds stock, else its
-- main store.
create function core.stock_location_of(p_supply uuid) returns uuid
language sql stable
set search_path = pg_catalog, core
as $$
  select coalesce(
    (select id from core.hierarchy_node where id = p_supply and holds_stock),
    (select id from core.hierarchy_node
      where parent_id = p_supply and is_main_store and archived_at is null));
$$;

-- Bring a user's job-role assignments in line with what their job role derives. Extra and
-- manual assignments are left alone; a grant already given as extra is not duplicated.
create function core.apply_job_role_access(p_user uuid) returns void
language plpgsql
set search_path = pg_catalog, core, hr
as $$
declare
  v_tenant uuid;
  v_err text;
begin
  select string_agg(d.error, '; ') into v_err
    from core.derive_job_role_access(p_user) d where d.error is not null;
  if v_err is not null then
    raise exception 'JOB_ROLE_SCOPE' using detail = v_err;
  end if;
  select tenant_id into v_tenant from core.app_user where id = p_user;

  delete from core.role_assignment ra
   where ra.user_id = p_user and ra.source = 'job_role'
     and not exists (select 1 from core.derive_job_role_access(p_user) d
                       join core.security_group g
                         on g.tenant_id = v_tenant and g.code = d.access_group
                      where g.id = ra.group_id and d.node_id = ra.node_id
                        and d.include_descendants = ra.include_descendants);
  insert into core.role_assignment (tenant_id, user_id, group_id, node_id,
                                    include_descendants, source, source_note)
  select v_tenant, p_user, g.id, d.node_id, bool_or(d.include_descendants), 'job_role',
         min(d.source)
    from core.derive_job_role_access(p_user) d
    join core.security_group g on g.tenant_id = v_tenant and g.code = d.access_group
   where not exists (select 1 from core.role_assignment ra
                      where ra.user_id = p_user and ra.group_id = g.id
                        and ra.node_id = d.node_id)
   group by g.id, d.node_id;
end $$;

-- Onboarding and user administration only (run as migrator / executor), never the app.
revoke execute on function core.derive_job_role_access(uuid) from public;
revoke execute on function core.apply_job_role_access(uuid) from public;
revoke execute on function core.stock_location_of(uuid) from public;

-- migrate:down
drop function core.apply_job_role_access(uuid);
drop function core.derive_job_role_access(uuid);
drop function core.stock_location_of(uuid);
drop function core.nearest(uuid, text[]);
alter table core.role_assignment drop column source, drop column source_note;
delete from core.domain_table where table_name = 'hr.job_role_access'::regclass;
drop table hr.job_role_access;
alter table hr.job_role drop column usual_department;
