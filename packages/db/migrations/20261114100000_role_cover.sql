-- migrate:up
-- Who covers it (ADR 058, 061): at one outlet, a job role the outlet doesn't have is either
-- covered by a role it does have, or not done there. Only the exceptions are stored: no row
-- means the outlet has the role, so every outlet without a row is exactly as it was.
--
-- Covered by: the covering role's people at that outlet get the covered role's grants there,
-- worked out by the same core.derive_job_role_access_at as their own (a "runs the
-- department" grant lands on the covered role's usual department at that outlet), and its
-- job-role tasks: each one is given to one of them on duty when it comes due (fewest open
-- tasks, then round robin). Not done: that role's checklist rounds there are not created;
-- its approvals and alerts already fall up to the department head, then the GM.

create table hr.role_cover (
  id uuid primary key default core.uuid_v7(),
  tenant_id uuid not null references core.tenant (id),
  org_node_id uuid not null references core.hierarchy_node (id),   -- the outlet or site
  job_role_code text not null,
  mode text not null check (mode in ('covered_by', 'not_done')),
  covered_by_role text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default core.current_user_id(),
  updated_at timestamptz not null default now(),
  updated_by uuid default core.current_user_id(),
  foreign key (tenant_id, job_role_code) references hr.job_role (tenant_id, code),
  foreign key (tenant_id, covered_by_role) references hr.job_role (tenant_id, code),
  check ((mode = 'covered_by') = (covered_by_role is not null)),
  check (covered_by_role is distinct from job_role_code)
);
create unique index role_cover_live on hr.role_cover (org_node_id, job_role_code)
  where archived_at is null;
create index role_cover_by on hr.role_cover (tenant_id, covered_by_role)
  where archived_at is null;

insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only)
values ('hr.role_cover', 'USER_ACCESS', 'org', true);
select core.apply_domain_rls('hr.role_cover');
select audit.enable('hr.role_cover');
create trigger touch before update on hr.role_cover
  for each row execute function core.touch();

-- When a covered task was last given out by cover (round robin), and that it was.
alter table ops.task add column auto_assigned_at timestamptz;

-- Where a covered role's grants are worked out at an outlet: its usual department there
-- (the first, if the file names two), or the outlet itself for a role that works at the
-- outlet. Null when the outlet doesn't have that department: the covering person's own home
-- is used instead, so cover never reaches further than where they already work.
create function core.cover_home(p_outlet uuid, p_role text) returns uuid
language sql stable
set search_path = pg_catalog, core, hr
as $$
  select case
    when coalesce(j.usual_department, '(outlet)') like '(%' then o.id
    else (select d.id from core.hierarchy_node d
           where d.parent_id = o.id and d.kind = 'department' and d.archived_at is null
             and d.code = o.code || '-' || trim(split_part(j.usual_department, '/', 1)))
  end
    from core.hierarchy_node o
    join hr.job_role j on j.tenant_id = o.tenant_id and j.code = p_role
   where o.id = p_outlet;
$$;

-- Why a cover can't be saved, as stable codes with a detail (none: it can). Checked by the
-- onboarding loader for every row of file 37 (and, later, by Admin's "Who does what").
create function core.role_cover_errors(p_tenant uuid, p_outlet uuid, p_role text,
                                       p_mode text, p_by text)
returns table (code text, detail text)
language plpgsql stable
set search_path = pg_catalog, core, hr
as $$
#variable_conflict use_column
declare
  v_home uuid;
  v_name text;
begin
  if not exists (select 1 from core.hierarchy_node
                  where id = p_outlet and tenant_id = p_tenant and type = 'org'
                    and kind in ('outlet', 'site') and archived_at is null) then
    return query select 'COVER_NOT_OUTLET', 'cover is set per outlet or central kitchen';
    return;
  end if;
  if p_mode is null or p_mode not in ('covered_by', 'not_done') then
    return query select 'INVALID_MODE', coalesce(p_mode, '(blank)');
    return;
  end if;
  select name into v_name from hr.job_role
   where tenant_id = p_tenant and code = p_role and archived_at is null;
  if not found then
    return query select 'INVALID_JOB_ROLE', coalesce(p_role, '(blank)');
    return;
  end if;
  if p_mode = 'not_done' then
    if p_by is not null then
      return query select 'INVALID_MODE', 'a role that is not done is covered by nobody';
    end if;
    return;
  end if;
  if p_by is null or not exists (select 1 from hr.job_role
                                  where tenant_id = p_tenant and code = p_by
                                    and archived_at is null) then
    return query select 'INVALID_JOB_ROLE', coalesce(p_by, '(blank covered_by_role)');
    return;
  end if;
  if p_by = p_role then
    return query select 'COVER_SELF', p_role || ' cannot cover itself';
    return;
  end if;
  -- no chains: the covering role is one the outlet has, and a covered role covers nothing
  if exists (select 1 from hr.role_cover c
              where c.org_node_id = p_outlet and c.archived_at is null
                and (c.job_role_code = p_by or c.covered_by_role = p_role)) then
    return query select 'COVER_CHAIN', p_by || ' covers ' || p_role
                        || ', but one of them is itself covered or covering';
  end if;
  -- what the covered role would hand over there, at each place it is worked out (its
  -- department at the outlet, else each covering person's own home): it must resolve, stay
  -- at this outlet and never be account administration
  v_home := core.cover_home(p_outlet, p_role);
  return query
    with homes as (
      select v_home as id where v_home is not null
      union
      select w.org_node_id from hr.worker w
       where v_home is null and w.tenant_id = p_tenant and w.status = 'active'
         and w.role_code = p_by
         and core.nearest(w.org_node_id, array['outlet', 'site']) = p_outlet
      union
      select p_outlet where v_home is null
         and not exists (select 1 from hr.worker w
                          where w.tenant_id = p_tenant and w.status = 'active'
                            and w.role_code = p_by
                            and core.nearest(w.org_node_id, array['outlet', 'site']) = p_outlet))
    select distinct x.code, x.detail from homes h,
      lateral (select 'JOB_ROLE_SCOPE'::text as code, d.error as detail
                 from core.derive_job_role_access_at(p_tenant, p_role, h.id) d
                where d.error is not null
               union all
               select 'COVER_ADMIN', v_name || ' holds ' || d.access_group
                 from core.derive_job_role_access_at(p_tenant, p_role, h.id) d
                where core.group_rank(d.access_group) > 1) x;
  return query
    select distinct 'COVER_ABOVE_OUTLET',
           v_name || ' holds ' || a.access_group || ' over the ' || replace(a.scope, '_', ' ')
      from hr.job_role_access a
     where a.tenant_id = p_tenant and a.job_role_code = p_role
       and a.scope in ('whole_area', 'whole_company');
end $$;

-- A person's job-role access: their own role's grants at their home place, and the grants of
-- every role their role covers at their outlet (worked out at the covered role's department
-- there, else their own home).
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
  return query
    select d.access_group, d.node_id, d.include_descendants, 'covers ' || j.name, d.error
      from hr.worker wk
      join hr.role_cover c on c.tenant_id = wk.tenant_id and c.covered_by_role = wk.role_code
                          and c.mode = 'covered_by' and c.archived_at is null
                          and c.org_node_id = core.nearest(wk.org_node_id, array['outlet', 'site'])
      join hr.job_role j on j.tenant_id = c.tenant_id and j.code = c.job_role_code
      cross join lateral core.derive_job_role_access_at(
                   c.tenant_id, c.job_role_code,
                   coalesce(core.cover_home(c.org_node_id, c.job_role_code), wk.org_node_id)) d
     where wk.owner_user_id = p_user and wk.status = 'active';
end $$;

-- After a cover at an outlet changes: re-apply job-role access for every active person
-- there (the onboarding loader; Admin's "Who does what" later goes through
-- core.sync_job_role_access per person instead).
create function core.apply_cover_access(p_outlet uuid) returns int
language plpgsql
set search_path = pg_catalog, core, hr
as $$
declare
  w record;
  v_n int := 0;
begin
  for w in select wk.owner_user_id from hr.worker wk
            where wk.status = 'active'
              and core.nearest(wk.org_node_id, array['outlet', 'site']) = p_outlet loop
    perform core.apply_job_role_access(w.owner_user_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Is the user in the covering role for p_role at the outlet of p_node?
create function ops.covers(p_user uuid, p_role text, p_node uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select exists (
    select 1 from hr.worker w
      join hr.role_cover c on c.tenant_id = w.tenant_id and c.job_role_code = p_role
                          and c.covered_by_role = w.role_code and c.mode = 'covered_by'
                          and c.archived_at is null
     where w.owner_user_id = p_user and w.status = 'active'
       and c.org_node_id = core.nearest(p_node, array['outlet', 'site'])
       and core.nearest(w.org_node_id, array['outlet', 'site']) = c.org_node_id);
$$;

create function ops.clocked_in(p_user uuid, p_at timestamptz) returns boolean
language sql stable security definer
set search_path = pg_catalog, hr
as $$
  select exists (select 1 from hr.attendance t
                  where t.owner_user_id = p_user and t.clock_in_at <= p_at
                    and t.clock_in_at > p_at - interval '16 hours'
                    and (t.clock_out_at is null or t.clock_out_at > p_at));
$$;

-- On duty at p_at: clocked in (an open punch from the last 16 hours) or on a published shift.
create function ops.on_duty(p_user uuid, p_at timestamptz) returns boolean
language sql stable security definer
set search_path = pg_catalog, hr
as $$
  select ops.clocked_in(p_user, p_at)
      or exists (select 1 from hr.shift_assignment a
                   join hr.shift s on s.id = a.shift_id and s.status = 'published'
                  where a.owner_user_id = p_user and a.status = 'assigned'
                    and a.start_at <= p_at and a.end_at > p_at);
$$;


-- The task pool for a job role takes the covering role's people at that outlet too.
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

-- A task or checklist may be given to a job role someone covers at that outlet.
create or replace function ops.check_assign(p_node uuid, p_assign jsonb) returns void
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
declare
  v_user uuid;
begin
  case coalesce(p_assign ->> 'mode', '')
    when 'person' then
      begin
        v_user := (p_assign ->> 'user_id')::uuid;
      exception when invalid_text_representation then
        perform ops.fail('INVALID_ASSIGNEE', 'not a person');
      end;
      if v_user is null or not ops.works_under(v_user, p_node) then
        perform ops.fail('INVALID_ASSIGNEE', 'they do not work at this place');
      end if;
    when 'job_role' then
      if not exists (
          select 1 from hr.worker w
            join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
            join core.hierarchy_node h on h.id = w.org_node_id
            join core.hierarchy_node n on n.id = p_node and n.tenant_id = w.tenant_id
           where w.status = 'active' and w.role_code = p_assign ->> 'role'
             and h.path operator(extensions.<@) n.path)
         and not exists (
          select 1 from hr.worker w
            join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
           where w.tenant_id = (select tenant_id from core.hierarchy_node where id = p_node)
             and ops.covers(w.owner_user_id, p_assign ->> 'role', p_node)) then
        perform ops.fail('INVALID_ASSIGNEE', 'nobody in that job role works at this place');
      end if;
    when 'on_shift' then
      null;
    else
      perform ops.fail('INVALID_ASSIGNEE', 'person, job_role or on_shift');
  end case;
end $$;

-- Gives a covered job-role task to one covering person on duty: clocked in first, then on a
-- published shift; fewest open tasks; then whoever was given a covered task longest ago.
-- Returns who, or null (nobody on duty: it stays in the pool).
create function ops.give_covered_task(p_task ops.task, p_now timestamptz) returns uuid
language plpgsql
set search_path = pg_catalog, core, hr, ops
as $$
declare
  v_user uuid;
  v_t ops.task;
begin
  select w.owner_user_id into v_user
    from hr.worker w
    join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
   where w.tenant_id = p_task.tenant_id and w.status = 'active'
     and w.owner_user_id is distinct from p_task.assignee_user_id
     and ops.in_pool(p_task, w.owner_user_id)
     and ops.on_duty(w.owner_user_id, p_now)
   order by ops.clocked_in(w.owner_user_id, p_now) desc,
            (select count(*) from ops.task x
              where x.assignee_user_id = w.owner_user_id
                and x.status in ('open', 'in_progress')),
            (select max(x.auto_assigned_at) from ops.task x
              where x.assignee_user_id = w.owner_user_id) nulls first,
            w.owner_user_id
   limit 1;
  if v_user is null then
    return null;
  end if;
  update ops.task set assignee_user_id = v_user, auto_assigned_at = p_now
   where id = p_task.id returning * into v_t;
  perform ops.notify_task(v_t, array[v_user], 'task_assigned', 'New task: ' || v_t.title,
                          (select j.name || '''s work (you''re covering)' from hr.job_role j
                            where j.tenant_id = v_t.tenant_id and j.code = v_t.job_role_code));
  return v_user;
end $$;

-- The 5-minute tick: rounds for a role not done at an outlet are not created; covered
-- job-role tasks are given out when they come due (30 minutes ahead, with the reminder), and
-- again if the person given one goes off duty before starting it.
create or replace function ops.tasks_tick(p_now timestamptz default now())
returns table (created int, reminded int, escalated int)
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_tpl record;
  v_at timestamptz;
  v_t ops.task;
  v_created int := 0;
  v_reminded int := 0;
  v_escalated int := 0;
  v_to uuid[];
begin
  for v_tpl in
    select c.* from ops.checklist_template c
      join core.tenant tn on tn.id = c.tenant_id
      join core.hierarchy_node n on n.id = c.org_node_id and n.archived_at is null
     where c.archived_at is null and core.tenant_active(c.tenant_id)
       and core.module_on(c.tenant_id, 'checklists')
       and not exists (select 1 from hr.role_cover rc
                        where c.assign ->> 'mode' = 'job_role'
                          and rc.tenant_id = c.tenant_id and rc.mode = 'not_done'
                          and rc.archived_at is null and rc.job_role_code = c.assign ->> 'role'
                          and rc.org_node_id = core.nearest(c.org_node_id, array['outlet', 'site']))
  loop
    for v_at in select * from ops.occurrences(v_tpl.schedule, ops.tz_of(v_tpl.org_node_id),
                                              p_now - interval '15 minutes', p_now + interval '24 hours')
    loop
      insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode,
                            job_role_code, assignee_user_id, assigned_by, template_id)
      values (v_tpl.tenant_id, v_tpl.org_node_id, 'checklist', v_tpl.name, v_at,
              v_tpl.assign ->> 'mode', v_tpl.assign ->> 'role',
              (v_tpl.assign ->> 'user_id')::uuid, coalesce(v_tpl.updated_by, v_tpl.created_by),
              v_tpl.id)
      on conflict (template_id, due_at) where template_id is not null do nothing
      returning * into v_t;
      if v_t.id is not null then
        perform ops.add_steps(v_t, v_tpl.steps);
        v_created := v_created + 1;
        v_t := null;
      end if;
    end loop;
  end loop;

  for v_t in select t.* from ops.task t
              where t.status = 'open' and t.assign_mode = 'job_role'
                and t.due_at <= p_now + interval '30 minutes'
                and (t.assignee_user_id is null
                     or (t.auto_assigned_at is not null
                         and not ops.on_duty(t.assignee_user_id, p_now)))
                and exists (select 1 from hr.role_cover rc
                             where rc.tenant_id = t.tenant_id and rc.mode = 'covered_by'
                               and rc.archived_at is null and rc.job_role_code = t.job_role_code
                               and rc.org_node_id = core.nearest(t.org_node_id,
                                                                 array['outlet', 'site']))
              order by t.due_at
              for update skip locked loop
    perform ops.give_covered_task(v_t, p_now);
  end loop;

  for v_t in select * from ops.task
              where status in ('open', 'in_progress') and reminded_at is null
                and due_at > p_now and due_at <= p_now + interval '30 minutes'
              for update skip locked loop
    perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'task_due_soon',
                            'Due soon: ' || v_t.title);
    update ops.task set reminded_at = p_now where id = v_t.id;
    v_reminded := v_reminded + 1;
  end loop;

  for v_t in select * from ops.task
              where status in ('open', 'in_progress') and escalated_at is null and due_at <= p_now
              for update skip locked loop
    v_to := array_remove(array[v_t.assigned_by], v_t.assignee_user_id);
    perform ops.notify_task(v_t, v_to, 'task_overdue', 'Overdue: ' || v_t.title,
                            coalesce((select display_name from core.app_user
                                       where id = v_t.assignee_user_id), 'Not started yet'));
    update ops.task set escalated_at = p_now, reminded_at = coalesce(reminded_at, p_now)
     where id = v_t.id;
    v_escalated := v_escalated + 1;
  end loop;

  for v_t in select * from ops.task
              where status in ('open', 'in_progress') and escalated_head_at is null
                and due_at <= p_now - interval '60 minutes'
              for update skip locked loop
    v_to := ops.leads(v_t.org_node_id,
                      p_exclude => array_remove(array[v_t.assignee_user_id, v_t.assigned_by], null));
    perform ops.notify_task(v_t, v_to, 'task_overdue', 'Overdue by an hour: ' || v_t.title,
                            coalesce((select display_name from core.app_user
                                       where id = v_t.assignee_user_id), 'Not started yet'));
    update ops.task set escalated_head_at = p_now where id = v_t.id;
    v_escalated := v_escalated + 1;
  end loop;

  return query select v_created, v_reminded, v_escalated;
end $$;

-- My tasks say whose work a covered one is: the covered role's name, for a job-role task of
-- a role I cover at that outlet (and don't hold myself).
drop function ops.my_tasks();
create function ops.my_tasks()
returns table (id uuid, kind text, title text, org_node_id uuid, place_name text,
               due_at timestamptz, priority text, status text, assign_mode text, taken boolean,
               steps_total int, steps_done int, overdue boolean, covering text)
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
                     where j.tenant_id = t.tenant_id and j.code = t.job_role_code) end
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
revoke execute on function ops.my_tasks() from public;
grant execute on function ops.my_tasks() to app_rw, platform_loader;

-- the loader (platform_loader) and the migrator only, never the app
revoke execute on function core.cover_home(uuid, text),
  core.role_cover_errors(uuid, uuid, text, text, text), core.apply_cover_access(uuid),
  ops.give_covered_task(ops.task, timestamptz) from public;
revoke execute on function ops.covers(uuid, text, uuid), ops.on_duty(uuid, timestamptz),
  ops.clocked_in(uuid, timestamptz) from public;
grant execute on function ops.covers(uuid, text, uuid), ops.on_duty(uuid, timestamptz),
  ops.clocked_in(uuid, timestamptz) to app_rw, wf_executor;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
create or replace function ops.tasks_tick(p_now timestamptz default now())
returns table (created int, reminded int, escalated int)
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_tpl record;
  v_at timestamptz;
  v_t ops.task;
  v_created int := 0;
  v_reminded int := 0;
  v_escalated int := 0;
  v_to uuid[];
begin
  for v_tpl in
    select c.* from ops.checklist_template c
      join core.tenant tn on tn.id = c.tenant_id
      join core.hierarchy_node n on n.id = c.org_node_id and n.archived_at is null
     where c.archived_at is null and core.tenant_active(c.tenant_id)
       and core.module_on(c.tenant_id, 'checklists')
  loop
    for v_at in select * from ops.occurrences(v_tpl.schedule, ops.tz_of(v_tpl.org_node_id),
                                              p_now - interval '15 minutes', p_now + interval '24 hours')
    loop
      insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode,
                            job_role_code, assignee_user_id, assigned_by, template_id)
      values (v_tpl.tenant_id, v_tpl.org_node_id, 'checklist', v_tpl.name, v_at,
              v_tpl.assign ->> 'mode', v_tpl.assign ->> 'role',
              (v_tpl.assign ->> 'user_id')::uuid, coalesce(v_tpl.updated_by, v_tpl.created_by),
              v_tpl.id)
      on conflict (template_id, due_at) where template_id is not null do nothing
      returning * into v_t;
      if v_t.id is not null then
        perform ops.add_steps(v_t, v_tpl.steps);
        v_created := v_created + 1;
        v_t := null;
      end if;
    end loop;
  end loop;

  for v_t in select * from ops.task
              where status in ('open', 'in_progress') and reminded_at is null
                and due_at > p_now and due_at <= p_now + interval '30 minutes'
              for update skip locked loop
    perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'task_due_soon',
                            'Due soon: ' || v_t.title);
    update ops.task set reminded_at = p_now where id = v_t.id;
    v_reminded := v_reminded + 1;
  end loop;

  for v_t in select * from ops.task
              where status in ('open', 'in_progress') and escalated_at is null and due_at <= p_now
              for update skip locked loop
    v_to := array_remove(array[v_t.assigned_by], v_t.assignee_user_id);
    perform ops.notify_task(v_t, v_to, 'task_overdue', 'Overdue: ' || v_t.title,
                            coalesce((select display_name from core.app_user
                                       where id = v_t.assignee_user_id), 'Not started yet'));
    update ops.task set escalated_at = p_now, reminded_at = coalesce(reminded_at, p_now)
     where id = v_t.id;
    v_escalated := v_escalated + 1;
  end loop;

  for v_t in select * from ops.task
              where status in ('open', 'in_progress') and escalated_head_at is null
                and due_at <= p_now - interval '60 minutes'
              for update skip locked loop
    v_to := ops.leads(v_t.org_node_id,
                      p_exclude => array_remove(array[v_t.assignee_user_id, v_t.assigned_by], null));
    perform ops.notify_task(v_t, v_to, 'task_overdue', 'Overdue by an hour: ' || v_t.title,
                            coalesce((select display_name from core.app_user
                                       where id = v_t.assignee_user_id), 'Not started yet'));
    update ops.task set escalated_head_at = p_now where id = v_t.id;
    v_escalated := v_escalated + 1;
  end loop;

  return query select v_created, v_reminded, v_escalated;
end $$;

create or replace function ops.check_assign(p_node uuid, p_assign jsonb) returns void
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
declare
  v_user uuid;
begin
  case coalesce(p_assign ->> 'mode', '')
    when 'person' then
      begin
        v_user := (p_assign ->> 'user_id')::uuid;
      exception when invalid_text_representation then
        perform ops.fail('INVALID_ASSIGNEE', 'not a person');
      end;
      if v_user is null or not ops.works_under(v_user, p_node) then
        perform ops.fail('INVALID_ASSIGNEE', 'they do not work at this place');
      end if;
    when 'job_role' then
      if not exists (
          select 1 from hr.worker w
            join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
            join core.hierarchy_node h on h.id = w.org_node_id
            join core.hierarchy_node n on n.id = p_node and n.tenant_id = w.tenant_id
           where w.status = 'active' and w.role_code = p_assign ->> 'role'
             and h.path operator(extensions.<@) n.path) then
        perform ops.fail('INVALID_ASSIGNEE', 'nobody in that job role works at this place');
      end if;
    when 'on_shift' then
      null;
    else
      perform ops.fail('INVALID_ASSIGNEE', 'person, job_role or on_shift');
  end case;
end $$;

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

drop function ops.my_tasks();
create function ops.my_tasks()
returns table (id uuid, kind text, title text, org_node_id uuid, place_name text,
               due_at timestamptz, priority text, status text, assign_mode text, taken boolean,
               steps_total int, steps_done int, overdue boolean)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select t.id, t.kind, t.title, t.org_node_id, n.name, t.due_at, t.priority, t.status,
         t.assign_mode, t.assignee_user_id is not null,
         (select count(*)::int from ops.task_step s where s.task_id = t.id),
         (select count(*)::int from ops.task_step s where s.task_id = t.id and s.done_at is not null),
         t.status in ('open', 'in_progress') and t.due_at < now()
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
revoke execute on function ops.my_tasks() from public;
grant execute on function ops.my_tasks() to app_rw, platform_loader;
drop function ops.give_covered_task(ops.task, timestamptz);
drop function ops.on_duty(uuid, timestamptz);
drop function ops.clocked_in(uuid, timestamptz);
drop function ops.covers(uuid, text, uuid);
drop function core.apply_cover_access(uuid);
drop function core.role_cover_errors(uuid, uuid, text, text, text);
drop function core.cover_home(uuid, text);
alter table ops.task drop column auto_assigned_at;
delete from core.domain_table where table_name = 'hr.role_cover'::regclass;
drop table hr.role_cover;
