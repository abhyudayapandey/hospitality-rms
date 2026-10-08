-- migrate:up
-- Done stays in view (ADR 075). A task that is done no longer vanishes: it stays on the To
-- do list, under Done, for the business day it was done and the next, of whoever did it,
-- whoever had it and everyone its job role (or shift) was given to, saying who did it and
-- when; anyone it was for may still open it. What someone gave to someone else stays under
-- "Given to others", marked done, for the same two days.

-- Done this business day or the one before, in the task's place's time zone.
create function ops.done_lately(p_task ops.task) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select p_task.status = 'done' and p_task.completed_at is not null
     and rpt.business_date(p_task.completed_at, ops.tz_of(p_task.org_node_id))
         >= rpt.business_date(now(), ops.tz_of(p_task.org_node_id)) - 1;
$$;

-- As ADR 074, and a done task its job role's (or shift's) people were given, whoever did it.
create or replace function ops.sees_task(p_task ops.task) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select coalesce(p_task.assignee_user_id = core.current_user_id(), false)
      or coalesce(p_task.completed_by = core.current_user_id(), false)
      or coalesce(ops.can_work(p_task, core.current_user_id()), false)
      or coalesce(p_task.status = 'done' and p_task.assign_mode in ('job_role', 'on_shift')
                  and ops.in_pool(p_task, core.current_user_id()), false)
      or ops.looks_after(p_task, 'view');
$$;

drop function ops.my_tasks();
create function ops.my_tasks()
returns table (id uuid, kind text, title text, org_node_id uuid, place_name text,
               due_at timestamptz, priority text, status text, assign_mode text, taken boolean,
               steps_total int, steps_done int, overdue boolean, covering text,
               assigned_at timestamptz, assigned_by_name text,
               completed_at timestamptz, done_by_name text)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select t.id, t.kind, t.title, t.org_node_id, n.name, t.due_at, t.priority, t.status,
         t.assign_mode, t.assignee_user_id is not null,
         (select count(*)::int from ops.task_step s where s.task_id = t.id),
         (select count(*)::int from ops.task_step s where s.task_id = t.id and s.done_at is not null),
         t.status in ('open', 'in_progress') and t.due_at < now(),
         case when t.assign_mode = 'job_role'
                   and ops.covers(core.current_user_id(), t.job_role_code, t.org_node_id)
              then (select j.name from hr.job_role j
                     where j.tenant_id = t.tenant_id and j.code = t.job_role_code) end,
         t.assigned_at,
         (select u.display_name from core.app_user u
           where u.id = t.assigned_by and u.id <> core.current_user_id()),
         case when t.status = 'done' then t.completed_at end,
         -- who did it, when it was someone else (null: you)
         case when t.status = 'done' then
           (select u.display_name from core.app_user u
             where u.id = coalesce(t.completed_by, t.assignee_user_id)
               and u.id <> core.current_user_id()) end
    from ops.task t
    join core.hierarchy_node n on n.id = t.org_node_id
   where t.tenant_id = core.my_tenant()
     and ((t.status in ('open', 'in_progress')
           and (t.assignee_user_id = core.current_user_id()
                or (t.assignee_user_id is null and ops.in_pool(t, core.current_user_id()))))
          or (ops.done_lately(t)
              and (t.assignee_user_id = core.current_user_id()
                   or t.completed_by = core.current_user_id()
                   or (t.assign_mode in ('job_role', 'on_shift')
                       and ops.in_pool(t, core.current_user_id())))))
   order by t.status in ('done'), t.due_at, t.priority = 'high' desc;
$$;

-- What the caller gave to someone else: still to do, or done this business day or the last.
drop function ops.my_handed_on();
create function ops.my_handed_on()
returns table (id uuid, kind text, title text, place_name text, due_at timestamptz,
               status text, assignee_name text, assigned_at timestamptz, overdue boolean,
               completed_at timestamptz, done_by_name text)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select t.id, t.kind, t.title, n.name, t.due_at, t.status, u.display_name, t.assigned_at,
         t.status in ('open', 'in_progress') and t.due_at < now(),
         case when t.status = 'done' then t.completed_at end,
         case when t.status = 'done' then
           (select d.display_name from core.app_user d
             where d.id = coalesce(t.completed_by, t.assignee_user_id)) end
    from ops.task t
    join core.hierarchy_node n on n.id = t.org_node_id
    left join core.app_user u on u.id = t.assignee_user_id
   where t.tenant_id = core.my_tenant()
     and (t.status in ('open', 'in_progress') or ops.done_lately(t))
     and t.assignee_user_id is distinct from core.current_user_id()
     and exists (select 1 from ops.task_handover h
                  where h.task_id = t.id and h.by_user = core.current_user_id()
                    and h.to_user <> h.by_user)
   order by t.status = 'done', t.due_at, t.title;
$$;

revoke execute on function ops.done_lately(ops.task), ops.my_tasks(), ops.my_handed_on()
  from public;
grant execute on function ops.my_tasks(), ops.my_handed_on() to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.my_tasks();
drop function ops.my_handed_on();
create or replace function ops.sees_task(p_task ops.task) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select coalesce(p_task.assignee_user_id = core.current_user_id(), false)
      or coalesce(ops.can_work(p_task, core.current_user_id()), false)
      or ops.looks_after(p_task, 'view');
$$;

create function ops.my_tasks()
returns table (id uuid, kind text, title text, org_node_id uuid, place_name text,
               due_at timestamptz, priority text, status text, assign_mode text, taken boolean,
               steps_total int, steps_done int, overdue boolean, covering text,
               assigned_at timestamptz, assigned_by_name text)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select t.id, t.kind, t.title, t.org_node_id, n.name, t.due_at, t.priority, t.status,
         t.assign_mode, t.assignee_user_id is not null,
         (select count(*)::int from ops.task_step s where s.task_id = t.id),
         (select count(*)::int from ops.task_step s where s.task_id = t.id and s.done_at is not null),
         t.status in ('open', 'in_progress') and t.due_at < now(),
         case when t.assign_mode = 'job_role'
                   and ops.covers(core.current_user_id(), t.job_role_code, t.org_node_id)
              then (select j.name from hr.job_role j
                     where j.tenant_id = t.tenant_id and j.code = t.job_role_code) end,
         t.assigned_at,
         (select u.display_name from core.app_user u
           where u.id = t.assigned_by and u.id <> core.current_user_id())
    from ops.task t
    join core.hierarchy_node n on n.id = t.org_node_id
   where t.tenant_id = core.my_tenant()
     and (t.status in ('open', 'in_progress')
          or (t.status = 'done' and t.completed_at > now() - interval '1 day'))
     and (t.assignee_user_id = core.current_user_id()
          or (t.assignee_user_id is null and t.status in ('open', 'in_progress')
              and ops.in_pool(t, core.current_user_id())))
   order by t.status in ('done'), t.due_at, t.priority = 'high' desc;
$$;

create function ops.my_handed_on()
returns table (id uuid, kind text, title text, place_name text, due_at timestamptz,
               status text, assignee_name text, assigned_at timestamptz, overdue boolean)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select t.id, t.kind, t.title, n.name, t.due_at, t.status, u.display_name, t.assigned_at,
         t.due_at < now()
    from ops.task t
    join core.hierarchy_node n on n.id = t.org_node_id
    left join core.app_user u on u.id = t.assignee_user_id
   where t.tenant_id = core.my_tenant()
     and t.status in ('open', 'in_progress')
     and t.assignee_user_id is distinct from core.current_user_id()
     and exists (select 1 from ops.task_handover h
                  where h.task_id = t.id and h.by_user = core.current_user_id()
                    and h.to_user <> h.by_user)
   order by t.due_at, t.title;
$$;
drop function ops.done_lately(ops.task);
revoke execute on function ops.my_tasks(), ops.my_handed_on() from public;
grant execute on function ops.my_tasks(), ops.my_handed_on() to app_rw;
