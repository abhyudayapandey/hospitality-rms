-- migrate:up

-- Rounds follow the roster (ADR 148). A job-role task went to everyone in the role all day:
-- a host off today had six washroom rounds, a commis on the late shift had the 07:00
-- opening. Now it goes to the role's people who work at its due time. Someone with no shift
-- at all in the week around it isn't on the roster (a manager, a salaried head, a customer
-- without rosters) and keeps their role's rounds, as before. When nobody of the role works
-- then, the round goes to the department head (then the outlet's managers, ops.leads). A
-- role whose people sit at the outlet now gets its rounds in the outlet's departments: the
-- Assistant Manager's Mid-shift reset and Lock-up sit in the Restaurant.

-- Working at p_at: clocked in, on a published shift that covers it (both ends count), or not on
-- the roster at all in the seven days either side.
create function ops.working_at(p_user uuid, p_at timestamptz) returns boolean
language sql stable security definer
set search_path = pg_catalog, hr
as $$
  select ops.clocked_in(p_user, p_at)
      or exists (select 1 from hr.shift_assignment a
                   join hr.shift s on s.id = a.shift_id and s.status = 'published'
                  where a.owner_user_id = p_user and a.status = 'assigned'
                    and a.start_at <= p_at and a.end_at >= p_at)
      or not exists (select 1 from hr.shift_assignment a
                       join hr.shift s on s.id = a.shift_id and s.status = 'published'
                      where a.owner_user_id = p_user and a.status = 'assigned'
                        and a.start_at < p_at + interval '7 days'
                        and a.end_at > p_at - interval '7 days');
$$;

-- The task's pool for a job role (ADR 148): the role's people at its place, below it or (an
-- outlet-level role) above it, and the people of a role that covers it at that outlet (ADR
-- 061), who work at its due time; else the department head (ops.leads). Worked out once per
-- task, so a list of tasks and the people told of one stay quick.
create function ops.job_role_pool(p_task ops.task) returns uuid[]
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
declare
  v_node core.hierarchy_node;
  v_outlet uuid := core.nearest(p_task.org_node_id, array['outlet', 'site']);
  v_covering text[];
  v_pool uuid[];
begin
  select * into v_node from core.hierarchy_node where id = p_task.org_node_id;
  v_covering := array(select c.covered_by_role from hr.role_cover c
                       where c.tenant_id = p_task.tenant_id and c.org_node_id = v_outlet
                         and c.job_role_code = p_task.job_role_code and c.mode = 'covered_by'
                         and c.archived_at is null);
  v_pool := array(
    select distinct w.owner_user_id from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
      join core.hierarchy_node h on h.id = w.org_node_id
     where w.tenant_id = p_task.tenant_id and w.status = 'active'
       and ((w.role_code = p_task.job_role_code
             and (h.path operator(extensions.<@) v_node.path
                  or v_node.path operator(extensions.<@) h.path))
            or (w.role_code = any (v_covering)
                and core.nearest(w.org_node_id, array['outlet', 'site']) = v_outlet))
       and ops.working_at(w.owner_user_id, p_task.due_at));
  if cardinality(v_pool) > 0 then
    return v_pool;
  end if;
  return ops.leads(p_task.org_node_id);
end $$;

create or replace function ops.in_pool(p_task ops.task, p_user uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select case p_task.assign_mode
    when 'job_role' then p_user = any (ops.job_role_pool(p_task))
    when 'on_shift' then exists (
      select 1 from hr.shift_assignment a
        join hr.shift s on s.id = a.shift_id and s.status = 'published'
        join core.hierarchy_node h on h.id = a.org_node_id
        join core.hierarchy_node n on n.id = p_task.org_node_id
       where a.owner_user_id = p_user and a.status = 'assigned' and a.tenant_id = p_task.tenant_id
         and a.start_at <= p_task.due_at and a.end_at >= p_task.due_at
         and h.path operator(extensions.<@) n.path)
    else false end
    and exists (select 1 from core.app_user u where u.id = p_user and u.status = 'active');
$$;

-- Who is told of a task: its assignee, else its pool (a job role's worked out once).
create or replace function ops.task_people(p_task ops.task) returns setof uuid
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select p_task.assignee_user_id where p_task.assignee_user_id is not null
  union
  select x from unnest(ops.job_role_pool(p_task)) x
   where p_task.assignee_user_id is null and p_task.assign_mode = 'job_role'
  union
  select w.owner_user_id from hr.worker w
   where p_task.assignee_user_id is null and p_task.assign_mode = 'on_shift'
     and w.tenant_id = p_task.tenant_id and w.status = 'active'
     and ops.in_pool(p_task, w.owner_user_id);
$$;

revoke execute on function ops.working_at(uuid, timestamptz), ops.job_role_pool(ops.task) from public;
grant execute on function ops.working_at(uuid, timestamptz), ops.job_role_pool(ops.task)
  to app_rw, wf_executor;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
create or replace function ops.in_pool(p_task ops.task, p_user uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select case p_task.assign_mode
    when 'job_role' then exists (
      select 1 from hr.worker w
        join core.hierarchy_node h on h.id = w.org_node_id
        join core.hierarchy_node n on n.id = p_task.org_node_id
       where w.owner_user_id = p_user and w.status = 'active' and w.tenant_id = p_task.tenant_id
         and w.role_code = p_task.job_role_code
         and h.path operator(extensions.<@) n.path)
      or ops.covers(p_user, p_task.job_role_code, p_task.org_node_id)
    when 'on_shift' then exists (
      select 1 from hr.shift_assignment a
        join hr.shift s on s.id = a.shift_id and s.status = 'published'
        join core.hierarchy_node h on h.id = a.org_node_id
        join core.hierarchy_node n on n.id = p_task.org_node_id
       where a.owner_user_id = p_user and a.status = 'assigned' and a.tenant_id = p_task.tenant_id
         and a.start_at <= p_task.due_at and a.end_at >= p_task.due_at
         and h.path operator(extensions.<@) n.path)
    else false end
    and exists (select 1 from core.app_user u where u.id = p_user and u.status = 'active');
$$;
create or replace function ops.task_people(p_task ops.task) returns setof uuid
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select p_task.assignee_user_id where p_task.assignee_user_id is not null
  union
  select w.owner_user_id from hr.worker w
   where p_task.assignee_user_id is null and p_task.assign_mode in ('job_role', 'on_shift')
     and w.tenant_id = p_task.tenant_id and w.status = 'active'
     and ops.in_pool(p_task, w.owner_user_id);
$$;
drop function ops.job_role_pool(ops.task);
drop function ops.working_at(uuid, timestamptz);
