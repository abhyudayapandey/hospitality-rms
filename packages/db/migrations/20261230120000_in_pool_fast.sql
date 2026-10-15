-- migrate:up

-- Asking "is this person in the round's pool?" quickly (ADR 148). ops.in_pool worked out the
-- whole pool (everyone of the role, and whether each works at the due time) for every open
-- round, for every person: the To do badge on every page took 0.8 s for everyone, the account
-- owner too. The answer is the same, asked from the person's side:
--   * someone of the role (or of a role that covers it at the outlet) is in it when they work
--     at the due time (ops.working_at);
--   * anyone else is in it only when they are among the department's heads (ops.leads) and
--     nobody of the role works then. Only people who hold a head's group are asked that.
-- ops.job_role_pool (who is told) gives the same people.

-- Is p_user of the task's role at its place, below it or above it, or of a role that covers
-- it at the task's outlet (ADR 061)?
create function ops.of_task_role(p_task ops.task, p_user uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select exists (
    select 1 from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node n on n.id = p_task.org_node_id
     where w.owner_user_id = p_user and w.tenant_id = p_task.tenant_id and w.status = 'active'
       and ((w.role_code = p_task.job_role_code
             and (h.path operator(extensions.<@) n.path or n.path operator(extensions.<@) h.path))
            or (core.nearest(w.org_node_id, array['outlet', 'site'])
                  = core.nearest(p_task.org_node_id, array['outlet', 'site'])
                and w.role_code in (
                  select c.covered_by_role from hr.role_cover c
                   where c.tenant_id = p_task.tenant_id
                     and c.org_node_id = core.nearest(p_task.org_node_id, array['outlet', 'site'])
                     and c.job_role_code = p_task.job_role_code and c.mode = 'covered_by'
                     and c.archived_at is null))));
$$;

-- The role's people who work at the task's due time (the pool before the heads' fallback), as
-- one set: the same people ops.of_task_role answers for one at a time.
create function ops.job_role_workers(p_task ops.task) returns uuid[]
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
declare
  v_node core.hierarchy_node;
  v_outlet uuid := core.nearest(p_task.org_node_id, array['outlet', 'site']);
  v_covering text[];
begin
  select * into v_node from core.hierarchy_node where id = p_task.org_node_id;
  v_covering := array(select c.covered_by_role from hr.role_cover c
                       where c.tenant_id = p_task.tenant_id and c.org_node_id = v_outlet
                         and c.job_role_code = p_task.job_role_code and c.mode = 'covered_by'
                         and c.archived_at is null);
  return array(
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
end $$;

create or replace function ops.job_role_pool(p_task ops.task) returns uuid[]
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
declare
  v_pool uuid[] := ops.job_role_workers(p_task);
begin
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
    when 'job_role' then
      case
        when ops.of_task_role(p_task, p_user) then ops.working_at(p_user, p_task.due_at)
        -- a head's fallback: asked only of someone who holds a head's group at all
        when exists (select 1 from core.role_assignment ra
                       join core.security_group g on g.id = ra.group_id
                      where ra.user_id = p_user and ra.tenant_id = p_task.tenant_id
                        and (g.code in ('DEPARTMENT_HEAD', 'OUTLET_MANAGER')
                             or g.acts_as && array['DEPARTMENT_HEAD', 'OUTLET_MANAGER'])
                        and ra.effective_from <= current_date
                        and (ra.effective_to is null or ra.effective_to >= current_date))
          then p_user = any (ops.leads(p_task.org_node_id))
               and cardinality(ops.job_role_workers(p_task)) = 0
        else false
      end
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

revoke execute on function ops.of_task_role(ops.task, uuid), ops.job_role_workers(ops.task)
  from public;
grant execute on function ops.of_task_role(ops.task, uuid), ops.job_role_workers(ops.task)
  to app_rw, wf_executor;

-- Team tasks (ADR 074) lists a task at a place when whoever has it, or could take it, works
-- there. A round's pool never leaves its outlet (the role's people there, a covering role, the
-- heads above it), so the pool is worked out only for rounds at the viewer's outlet; a task
-- given to someone is still followed wherever they work.
select core.patch_function('ops.team_tasks(uuid, date, date)',
  $x$            or exists (select 1 from ops.task_homes(t) h
                         join core.hierarchy_node hn on hn.id = h
                        where hn.path operator(extensions.<@) p.path))$x$,
  $x$            or ((t.assignee_user_id is not null
                 or core.nearest(t.org_node_id, array['outlet', 'site'])
                      = core.nearest(p_node, array['outlet', 'site']))
                and exists (select 1 from ops.task_homes(t) h
                             join core.hierarchy_node hn on hn.id = h
                            where hn.path operator(extensions.<@) p.path)))$x$);

-- A department tile's late count (ADR 148): the late rows of Team tasks there for the days
-- asked, without working out who has every other task first. Same rule as ops.team_tasks.
create function ops.late_count(p_node uuid, p_from date, p_to date) returns int
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, hr, extensions
as $$
declare
  v_tz text := ops.tz_of(p_node);
begin
  perform hr.require('TASKS', 'view', p_node);
  return (
    select count(*)::int
      from ops.task t
      join core.hierarchy_node n on n.id = t.org_node_id
      join core.hierarchy_node p on p.id = p_node
     where t.tenant_id = p.tenant_id
       and t.status in ('open', 'in_progress') and t.due_at < now()
       and (t.due_at at time zone v_tz)::date between p_from and p_to
       and (n.path operator(extensions.<@) p.path
            or ((t.assignee_user_id is not null
                 or core.nearest(t.org_node_id, array['outlet', 'site'])
                      = core.nearest(p_node, array['outlet', 'site']))
                and exists (select 1 from ops.task_homes(t) h
                             join core.hierarchy_node hn on hn.id = h
                            where hn.path operator(extensions.<@) p.path))));
end $$;
revoke execute on function ops.late_count(uuid, date, date) from public;
grant execute on function ops.late_count(uuid, date, date) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
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
create or replace function ops.job_role_pool(p_task ops.task) returns uuid[]
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
select core.patch_function('ops.team_tasks(uuid, date, date)',
  $x$            or ((t.assignee_user_id is not null
                 or core.nearest(t.org_node_id, array['outlet', 'site'])
                      = core.nearest(p_node, array['outlet', 'site']))
                and exists (select 1 from ops.task_homes(t) h
                             join core.hierarchy_node hn on hn.id = h
                            where hn.path operator(extensions.<@) p.path)))$x$,
  $x$            or exists (select 1 from ops.task_homes(t) h
                         join core.hierarchy_node hn on hn.id = h
                        where hn.path operator(extensions.<@) p.path))$x$);
drop function ops.late_count(uuid, date, date);
drop function ops.job_role_workers(ops.task);
drop function ops.of_task_role(ops.task, uuid);
