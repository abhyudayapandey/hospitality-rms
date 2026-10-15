-- migrate:up

-- Pickers list only who can do the job (ADR 151).

-- Does this person run a department or the outlet (a head's or a manager's group, or a custom
-- group that stands in for one)?
create function ops.runs_something(p_user uuid, p_tenant uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select exists (
    select 1 from core.role_assignment ra
      join core.security_group g on g.id = ra.group_id
     where ra.user_id = p_user and ra.tenant_id = p_tenant
       and (g.code in ('DEPARTMENT_HEAD', 'OUTLET_MANAGER')
            or g.acts_as && array['DEPARTMENT_HEAD', 'OUTLET_MANAGER'])
       and ra.effective_from <= current_date
       and (ra.effective_to is null or ra.effective_to >= current_date));
$$;
revoke execute on function ops.runs_something(uuid, uuid) from public;
grant execute on function ops.runs_something(uuid, uuid) to app_rw, wf_executor;

-- Give rooms: the people of the roles that do the outlet's room rounds (a checklist "for each
-- room"), not every housekeeper; with no such round, housekeeping's people below its heads.
create or replace function ops.room_people(p_outlet uuid)
returns table(user_id uuid, name text, role_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops
as $$
declare
  v_roles text[];
begin
  if not core.can('ROOMS', 'view', p_outlet, null) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS view');
  end if;
  v_roles := array(
    select distinct c.assign ->> 'role' from ops.checklist_template c
     where c.org_node_id in (select ops.housekeeping_departments(p_outlet))
       and c.archived_at is null and (c.for_each ->> 'rooms')::boolean
       and c.assign ->> 'mode' = 'job_role');
  return query
    select distinct on (u.id) u.id, u.display_name, coalesce(jr.name, w.role_code)
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id
      left join hr.job_role jr on jr.tenant_id = w.tenant_id and jr.code = w.role_code
     where w.status = 'active' and w.org_node_id in (select ops.housekeeping_departments(p_outlet))
       and (case when cardinality(v_roles) > 0 then w.role_code = any (v_roles)
                 else not ops.runs_something(u.id, w.tenant_id) end)
     order by u.id, u.display_name;
end $$;

-- Give sections: the department's floor people, not its heads and managers.
create or replace function ops.section_people(p_department uuid)
returns table(user_id uuid, name text, role_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops
as $$
begin
  if not core.can('TASKS', 'view', p_department, null) then
    perform ops.fail('NOT_AUTHORISED', 'TASKS view');
  end if;
  return query
    select distinct on (u.id) u.id, u.display_name, coalesce(jr.name, w.role_code)
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id
      left join hr.job_role jr on jr.tenant_id = w.tenant_id and jr.code = w.role_code
     where w.status = 'active' and w.org_node_id = p_department
       and not ops.runs_something(u.id, w.tenant_id)
     order by u.id, u.display_name;
end $$;

-- Give a licence's renewal or a compliance job to someone: that role's people (or a role that
-- covers it), the people of its department, and the outlet's managers; not everyone at the
-- hotel. Every other task: everyone where it is, as before.
create or replace function ops.hand_on_people(p_task uuid)
returns table(user_id uuid, name text, job_role text, place_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
declare
  v_t ops.task;
  v_dept text;
  v_outlet core.hierarchy_node;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant();
  if not found or not ops.may_hand_on(v_t) then
    perform ops.fail('NOT_AUTHORISED', 'not yours to hand on');
  end if;
  if v_t.kind in ('licence', 'compliance') and v_t.job_role_code is not null then
    select * into v_outlet from core.hierarchy_node
     where id = core.nearest(v_t.org_node_id, array['outlet', 'site']);
    select usual_department into v_dept from hr.job_role
     where tenant_id = v_t.tenant_id and code = v_t.job_role_code;
    return query
      select u.id, u.display_name, r.name, h.name
        from hr.worker w
        join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
        join core.hierarchy_node h on h.id = w.org_node_id
        left join hr.job_role r on r.tenant_id = w.tenant_id and r.code = w.role_code
       where w.status = 'active' and w.tenant_id = v_t.tenant_id
         and h.path operator(extensions.<@) v_outlet.path
         and (ops.of_task_role(v_t, u.id)
              or (v_dept is not null and h.code = v_outlet.code || '-' || v_dept)
              or (h.id = v_outlet.id and ops.runs_something(u.id, w.tenant_id)))
       order by u.display_name;
    return;
  end if;
  return query
    select u.id, u.display_name, r.name, h.name
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node n on n.id = v_t.org_node_id and n.tenant_id = w.tenant_id
      left join hr.job_role r on r.tenant_id = w.tenant_id and r.code = w.role_code
     where w.status = 'active' and h.path operator(extensions.<@) n.path
     order by u.display_name;
end $$;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous pickers for local work.
create or replace function ops.hand_on_people(p_task uuid)
returns table(user_id uuid, name text, job_role text, place_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant();
  if not found or not ops.may_hand_on(v_t) then
    perform ops.fail('NOT_AUTHORISED', 'not yours to hand on');
  end if;
  return query
    select u.id, u.display_name, r.name, h.name
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node n on n.id = v_t.org_node_id and n.tenant_id = w.tenant_id
      left join hr.job_role r on r.tenant_id = w.tenant_id and r.code = w.role_code
     where w.status = 'active' and h.path operator(extensions.<@) n.path
     order by u.display_name;
end $$;
create or replace function ops.section_people(p_department uuid)
returns table(user_id uuid, name text, role_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops
as $$
begin
  if not core.can('TASKS', 'view', p_department, null) then
    perform ops.fail('NOT_AUTHORISED', 'TASKS view');
  end if;
  return query
    select distinct on (u.id) u.id, u.display_name, coalesce(jr.name, w.role_code)
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id
      left join hr.job_role jr on jr.tenant_id = w.tenant_id and jr.code = w.role_code
     where w.status = 'active' and w.org_node_id = p_department
     order by u.id, u.display_name;
end $$;
create or replace function ops.room_people(p_outlet uuid)
returns table(user_id uuid, name text, role_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops
as $$
begin
  if not core.can('ROOMS', 'view', p_outlet, null) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS view');
  end if;
  return query
    select distinct on (u.id) u.id, u.display_name, coalesce(jr.name, w.role_code)
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id
      left join hr.job_role jr on jr.tenant_id = w.tenant_id and jr.code = w.role_code
     where w.status = 'active' and w.org_node_id in (select ops.housekeeping_departments(p_outlet))
     order by u.id, u.display_name;
end $$;
drop function ops.runs_something(uuid, uuid);
