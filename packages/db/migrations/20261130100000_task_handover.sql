-- migrate:up
-- Handing a task on (ADR 074). Every time a task reaches someone it is recorded: who had
-- it, who has it now, who gave it and when (ops.task_handover, written by a trigger on
-- ops.task, so every way of assigning a task records it). A task is seen, and can be given
-- to someone else, by the managers of its place, the head of the department where whoever
-- has it works (wherever the task sits), and whoever handed it on; a compliance job also by
-- the role that answers for it. Every list says who has a task, since when and when it is
-- due. Those who handed a task on are told when it is done.

alter table ops.task add column assigned_at timestamptz;

create table ops.task_handover (
  id uuid primary key default core.uuid_v7(),
  task_id uuid not null references ops.task(id) on delete cascade,   -- its history goes with it
  org_node_id uuid not null references core.hierarchy_node(id),
  from_user uuid references core.app_user(id),   -- who had it (null: nobody, or its job role)
  to_user uuid not null references core.app_user(id),
  by_user uuid references core.app_user(id),     -- who gave it (null: the system; = to_user: took it)
  at timestamptz not null default now()
);
select core.add_standard_columns('ops.task_handover');
create index task_handover_task on ops.task_handover (task_id, at);
create index task_handover_by on ops.task_handover (by_user, task_id) where by_user is not null;

insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only, owner_column)
values ('ops.task_handover', 'TASKS', 'org', true, null);
select core.apply_domain_rls('ops.task_handover');
select audit.enable('ops.task_handover');

-- What happened before: each change of who has a task, from the audit log (who did it and
-- when); a task with someone on it and no such row, from what the task itself says.
insert into ops.task_handover (tenant_id, task_id, org_node_id, from_user, to_user, by_user, at,
                               created_at, created_by, updated_at, updated_by)
select t.tenant_id, t.id, t.org_node_id,
       (select u.id from core.app_user u where u.id = (a.before ->> 'assignee_user_id')::uuid),
       (a.after ->> 'assignee_user_id')::uuid,
       (select u.id from core.app_user u where u.id = a.actor_id),
       a.occurred_at, a.occurred_at, null, a.occurred_at, null
  from audit.log a
  join ops.task t on t.id = a.row_id
 where a.table_name = 'ops.task'
   and a.after ->> 'assignee_user_id' is not null
   and exists (select 1 from core.app_user u where u.id = (a.after ->> 'assignee_user_id')::uuid)
   and (a.op = 'INSERT'
        or (a.op = 'UPDATE'
            and (a.before ->> 'assignee_user_id') is distinct from (a.after ->> 'assignee_user_id')));

insert into ops.task_handover (tenant_id, task_id, org_node_id, from_user, to_user, by_user, at,
                               created_at, created_by, updated_at, updated_by)
select t.tenant_id, t.id, t.org_node_id, null, t.assignee_user_id, t.assigned_by,
       coalesce(t.auto_assigned_at, case when t.assigned_by is not null then t.updated_at end,
                t.created_at),
       now(), null, now(), null
  from ops.task t
 where t.assignee_user_id is not null
   and not exists (select 1 from ops.task_handover h where h.task_id = t.id);

-- When each task reached whoever has it (or its job role): the last handover to them, else
-- when it was made. Not a change anyone made, so neither touched nor audited.
alter table ops.task disable trigger touch;
alter table ops.task disable trigger audit;
update ops.task t
   set assigned_at = coalesce((select max(h.at) from ops.task_handover h
                                where h.task_id = t.id and h.to_user = t.assignee_user_id),
                              t.auto_assigned_at, t.created_at)
 where t.assign_mode is not null;
alter table ops.task enable trigger touch;
alter table ops.task enable trigger audit;

-- assigned_at moves whenever the task goes to someone else (or another job role)
create function ops.task_assigned_at() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if new.assign_mode is not null then
      new.assigned_at := coalesce(new.assigned_at, now());
    end if;
  elsif new.assignee_user_id is distinct from old.assignee_user_id
        or new.assign_mode is distinct from old.assign_mode
        or new.job_role_code is distinct from old.job_role_code then
    new.assigned_at := now();
  end if;
  return new;
end $$;
create trigger assigned_at before insert or update on ops.task
  for each row execute function ops.task_assigned_at();

-- one row per handover; when a task is done, whoever handed it on is told (the role that
-- answers for a compliance job hears through compliance_done instead)
create function ops.task_handover_log() returns trigger
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_u uuid;
  v_skip uuid[] := '{}';
begin
  if new.assignee_user_id is not null
     and (tg_op = 'INSERT' or new.assignee_user_id is distinct from old.assignee_user_id) then
    insert into ops.task_handover (tenant_id, task_id, org_node_id, from_user, to_user, by_user, at)
    values (new.tenant_id, new.id, new.org_node_id,
            case when tg_op = 'UPDATE' then old.assignee_user_id end,
            new.assignee_user_id, core.current_user_id(), coalesce(new.assigned_at, now()));
  end if;
  if tg_op = 'UPDATE' and new.status = 'done' and old.status is distinct from 'done' then
    if new.kind = 'compliance' then
      select ops.accountable_people(i) into v_skip
        from ops.compliance_item i where i.id = new.compliance_item_id;
    end if;
    for v_u in
      select distinct h.by_user from ops.task_handover h
       where h.task_id = new.id and h.by_user is not null and h.by_user <> h.to_user
         and h.by_user is distinct from new.completed_by
         and h.by_user is distinct from new.assignee_user_id
         and not (h.by_user = any(coalesce(v_skip, '{}')))
    loop
      perform ops.notify(new.tenant_id, v_u, 'task_done', 'Done: ' || new.title,
                         'By ' || coalesce((select display_name from core.app_user
                                             where id = coalesce(new.completed_by,
                                                                 new.assignee_user_id)),
                                           'someone'),
                         '/tasks/' || new.id);
    end loop;
  end if;
  return null;
end $$;
create trigger handover after insert or update on ops.task
  for each row execute function ops.task_handover_log();

-- ---------------------------------------------------------------------------
-- Who sees a task and who may give it to someone else
-- ---------------------------------------------------------------------------

-- Whether someone may work on a task: it is to do and theirs, or their job role's (or
-- shift's) before anyone has taken it. Never null (it was for someone outside an
-- unassigned task's pool, and "not null" lets a check through).
create or replace function ops.can_work(p_task ops.task, p_user uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce(p_task.status in ('open', 'in_progress')
         and exists (select 1 from core.app_user u where u.id = p_user and u.status = 'active')
         and (p_task.assignee_user_id = p_user
              or (p_task.assignee_user_id is null and ops.in_pool(p_task, p_user))), false);
$$;

-- Where a task's people work: whoever has it, or before anyone has, its job role's (or
-- shift's) people at its place.
create function ops.task_homes(p_task ops.task) returns setof uuid
language sql stable security definer
set search_path = pg_catalog, core, ops, hr
as $$
  select distinct w.org_node_id from hr.worker w
   where w.tenant_id = p_task.tenant_id and w.status = 'active'
     and w.owner_user_id in (select ops.task_people(p_task));
$$;

-- Whether the caller looks after a task (without its status): a manager of its place, the
-- head of the department where its people work, whoever handed it on, and for a licence or
-- a compliance job whoever keeps Compliance there or answers for it.
create function ops.looks_after(p_task ops.task, p_access text) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_me uuid := core.current_user_id();
begin
  if v_me is null then
    return false;
  end if;
  if core.can('TASKS', p_access, p_task.org_node_id, null)
     or exists (select 1 from ops.task_homes(p_task) h where core.can('TASKS', p_access, h, null))
     or exists (select 1 from ops.task_handover x
                 where x.task_id = p_task.id and x.by_user = v_me and x.to_user <> v_me) then
    return true;
  end if;
  if p_task.kind in ('licence', 'compliance') then
    if core.can('COMPLIANCE', p_access, p_task.org_node_id, null) then
      return true;
    end if;
    if p_task.kind = 'compliance' and exists (
         select 1 from ops.compliance_item i
          where i.id = p_task.compliance_item_id and v_me = any(ops.accountable_people(i))) then
      return true;
    end if;
  end if;
  return false;
end $$;

create function ops.sees_task(p_task ops.task) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select coalesce(p_task.assignee_user_id = core.current_user_id(), false)
      or coalesce(ops.can_work(p_task, core.current_user_id()), false)
      or ops.looks_after(p_task, 'view');
$$;

-- Who may give a task to someone else: those who look after it, and the one who has a
-- licence renewal or a compliance job (ADR 073). Only while it is to do; never null.
create or replace function ops.may_hand_on(p_task ops.task) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select coalesce(p_task.status in ('open', 'in_progress')
                  and (ops.looks_after(p_task, 'modify')
                       or (p_task.kind in ('licence', 'compliance')
                           and ops.can_work(p_task, core.current_user_id()))), false);
$$;

-- Give a task that is to do to one person who works at its place. Any kind but a reported
-- expired batch (that goes through ops.assign_expiry).
create or replace function ops.reassign_task(p_task uuid, p_user uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_t ops.task;
  v_was uuid;
  v_me core.app_user := wf.me();
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  if v_t.kind in ('licence', 'compliance') then
    perform core.require_module('compliance');
  end if;
  -- ops.can_work is null for someone outside an unassigned task's pool: never let that pass
  if not coalesce(ops.looks_after(v_t, 'modify')
                  or (v_t.kind in ('licence', 'compliance') and ops.can_work(v_t, v_me.id)),
                  false) then
    perform ops.fail('NOT_AUTHORISED', 'not yours to hand on');
  end if;
  if v_t.status not in ('open', 'in_progress') then
    perform ops.fail('INVALID_STATE', 'the task is ' || replace(v_t.status, '_', ' '));
  end if;
  if p_user is null or not ops.works_under(p_user, v_t.org_node_id) then
    perform ops.fail('INVALID_ASSIGNEE', 'they do not work at this place');
  end if;
  if v_t.assignee_user_id = p_user then
    return;
  end if;
  v_was := v_t.assignee_user_id;
  update ops.task
     set assignee_user_id = p_user, assigned_by = v_me.id, assign_mode = 'person'
   where id = v_t.id returning * into v_t;
  perform ops.notify_task(v_t, array[p_user], 'task_assigned', 'New task: ' || v_t.title,
                          'From ' || v_me.display_name);
  if v_was is not null and v_was <> v_me.id then
    perform ops.notify_task(v_t, array[v_was], 'task_reassigned', 'Given to someone else: ' || v_t.title,
                            v_me.display_name || ' gave it to '
                              || (select display_name from core.app_user where id = p_user));
  end if;
end $$;

-- Who a task can go to: everyone who works at its place.
create or replace function ops.hand_on_people(p_task uuid)
returns table (user_id uuid, name text, job_role text, place_name text)
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

-- ---------------------------------------------------------------------------
-- One task, with who has it, since when and how it got there
-- ---------------------------------------------------------------------------

create or replace function ops.task_detail(p_task uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task;
  v_me uuid := core.current_user_id();
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant();
  if not found then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  if not ops.sees_task(v_t) then
    perform ops.fail('NOT_AUTHORISED', 'not your task');
  end if;
  return to_jsonb(v_t) || jsonb_build_object(
    'place_name', (select name from core.hierarchy_node where id = v_t.org_node_id),
    'store_name', (select name from core.hierarchy_node where id = v_t.delivery_node_id),
    'item', (select jsonb_build_object('sku', i.sku, 'name', i.name, 'unit', i.base_uom)
               from inv.item i where i.id = v_t.item_id),
    'assignee_name', (select display_name from core.app_user where id = v_t.assignee_user_id),
    'assigned_by_name', (select display_name from core.app_user where id = v_t.assigned_by),
    'reported_by_name', (select display_name from core.app_user where id = v_t.reported_by),
    'job_role_name', (select r.name from hr.job_role r
                       where r.tenant_id = v_t.tenant_id and r.code = v_t.job_role_code),
    'made_qty', (select coalesce(sum(p.qty_made), 0) from inv.production p where p.task_id = v_t.id),
    'can_work', coalesce(ops.can_work(v_t, v_me), false),
    -- a manager of its place: cancels it, gives a reported discard out (ops.cancel_task and
    -- ops.assign_expiry check the same); giving it to someone else is can_hand_on
    'can_manage', core.can('TASKS', 'modify', v_t.org_node_id, null),
    'can_hand_on', v_t.status <> 'reported' and ops.may_hand_on(v_t),
    'handovers', coalesce((select jsonb_agg(jsonb_build_object(
               'at', h.at,
               'from_name', (select display_name from core.app_user where id = h.from_user),
               'to_name', (select display_name from core.app_user where id = h.to_user),
               'by_name', (select display_name from core.app_user where id = h.by_user),
               'took', h.by_user = h.to_user) order by h.at, h.id)
               from ops.task_handover h where h.task_id = v_t.id), '[]'),
    'steps', coalesce((select jsonb_agg(jsonb_build_object(
               'id', s.id, 'position', s.position, 'label', s.label, 'kind', s.kind,
               'min', s.min_value, 'max', s.max_value, 'unit', s.unit,
               'photo_required', s.photo_required, 'value_num', s.value_num,
               'value_text', s.value_text, 'photo_key', s.photo_key, 'flagged', s.flagged,
               'done_at', s.done_at,
               'done_by_name', (select display_name from core.app_user where id = s.done_by))
               order by s.position)
               from ops.task_step s where s.task_id = v_t.id), '[]'));
end $$;

create or replace function ops.compliance_task(p_task uuid)
returns table (licence_id uuid, item_id uuid, name text, place_name text, number text,
               authority text, expires_on date, next_due date, every_months int,
               needs_proof boolean, can_act boolean, can_hand_on boolean, owner_role_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task;
  v_act boolean;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind in ('licence', 'compliance');
  if not found or not ops.sees_task(v_t) then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  v_act := coalesce(v_t.status in ('open', 'in_progress')
                    and (ops.can_work(v_t, core.current_user_id())
                         or core.can('COMPLIANCE', 'modify', v_t.org_node_id, null)), false);
  return query
    select l.id, i.id, coalesce(l.name, i.name), n.name, l.number, l.authority, l.expires_on,
           i.next_due, i.every_months, coalesce(i.needs_proof, true), v_act,
           ops.may_hand_on(v_t),
           case when i.id is not null then ops.role_name(i.tenant_id, i.owner_role) end
      from (select 1) one
      left join ops.licence l on l.id = v_t.licence_id
      left join ops.compliance_item i on i.id = v_t.compliance_item_id
      join core.hierarchy_node n on n.id = v_t.org_node_id;
end $$;

-- ---------------------------------------------------------------------------
-- Lists: who has it, since when, when it is due
-- ---------------------------------------------------------------------------

drop function ops.my_tasks();
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

-- What the caller gave to someone else that is still to do (they keep following it).
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

-- A place's tasks due in [p_from, p_to] (local days), for task viewers there: those at the
-- place and below, and those whose people work there (a department head follows the work
-- of their team wherever it sits).
drop function ops.team_tasks(uuid, date, date);
create function ops.team_tasks(p_node uuid, p_from date, p_to date)
returns table (id uuid, kind text, title text, org_node_id uuid, place_name text, due_at timestamptz,
               priority text, status text, assignee_name text, pool text, steps_total int,
               steps_done int, flagged int, overdue boolean, assignee_user_id uuid,
               assigned_at timestamptz, assigned_by_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, hr, extensions
as $$
declare
  v_tz text := ops.tz_of(p_node);
begin
  perform hr.require('TASKS', 'view', p_node);
  return query
    select t.id, t.kind, t.title, t.org_node_id, n.name, t.due_at, t.priority, t.status,
           u.display_name,
           case t.assign_mode when 'job_role' then (select r.name from hr.job_role r
                                                     where r.tenant_id = t.tenant_id
                                                       and r.code = t.job_role_code)
                              when 'on_shift' then 'On shift' end,
           (select count(*)::int from ops.task_step s where s.task_id = t.id),
           (select count(*)::int from ops.task_step s where s.task_id = t.id and s.done_at is not null),
           (select count(*)::int from ops.task_step s where s.task_id = t.id and s.flagged),
           t.status in ('open', 'in_progress') and t.due_at < now(),
           t.assignee_user_id, t.assigned_at,
           (select b.display_name from core.app_user b where b.id = t.assigned_by)
      from ops.task t
      join core.hierarchy_node n on n.id = t.org_node_id
      join core.hierarchy_node p on p.id = p_node
      left join core.app_user u on u.id = t.assignee_user_id
     where t.tenant_id = p.tenant_id
       and (t.due_at at time zone v_tz)::date between p_from and p_to
       and (n.path operator(extensions.<@) p.path
            or exists (select 1 from ops.task_homes(t) h
                         join core.hierarchy_node hn on hn.id = h
                        where hn.path operator(extensions.<@) p.path))
     order by t.due_at, n.name;
end $$;

drop function ops.maintenance_requests(uuid);
create function ops.maintenance_requests(p_id uuid default null)
returns table (id uuid, title text, description text, status text, org_node_id uuid,
               handled_by text, place_name text, reported_by_name text, assigned_to uuid,
               assigned_to_name text, photo_key text, done_photo_key text, done_note text,
               created_at timestamptz, done_at timestamptz, place_node_id uuid,
               assigned_at timestamptz, assigned_by_name text)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select r.id, r.title, r.description, r.status, r.org_node_id, h.name, p.name,
         rb.display_name, r.assigned_to, at.display_name, r.photo_key, r.done_photo_key,
         r.done_note, r.created_at, r.done_at, r.place_node_id, r.assigned_at, ab.display_name
    from ops.maintenance_request r
    join core.hierarchy_node h on h.id = r.org_node_id
    join core.hierarchy_node p on p.id = r.place_node_id
    left join core.app_user rb on rb.id = r.reported_by
    left join core.app_user at on at.id = r.assigned_to
    left join core.app_user ab on ab.id = r.assigned_by
   where r.tenant_id = core.my_tenant()
     and (p_id is null or r.id = p_id)
     and (r.reported_by = core.current_user_id() or r.assigned_to = core.current_user_id()
          or core.can('MAINTENANCE', 'view', r.org_node_id, null))
   order by r.status = 'done', r.created_at desc
   limit 100;
$$;

drop function ops.compliance_items(uuid);
create function ops.compliance_items(p_node uuid)
returns table (id uuid, org_node_id uuid, place_name text, name text, every_months int,
               next_due date, days_left int, owner_role text, owner_role_name text,
               needs_proof boolean, last_done date, last_files text[], open_task uuid,
               doer_role text, doer_role_name text, with_name text, outlet_id uuid,
               with_since timestamptz)
language sql stable security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  select i.id, i.org_node_id, n.name, i.name, i.every_months, i.next_due,
         (i.next_due - ops.today_at(i.org_node_id))::int, i.owner_role,
         coalesce(r.name, i.owner_role), i.needs_proof, d.done_on, d.files, t.id,
         i.doer_role, case when i.doer_role is not null then coalesce(dr.name, i.doer_role) end,
         u.display_name, coalesce(core.nearest(i.org_node_id, array['outlet', 'site']), i.org_node_id),
         case when t.assignee_user_id is not null then t.assigned_at end
    from ops.compliance_item i
    join core.hierarchy_node n on n.id = i.org_node_id
    left join hr.job_role r on r.tenant_id = i.tenant_id and r.code = i.owner_role
    left join hr.job_role dr on dr.tenant_id = i.tenant_id and dr.code = i.doer_role
    left join lateral (select x.done_on, x.files from ops.compliance_done x
                        where x.item_id = i.id order by x.done_on desc, x.created_at desc
                        limit 1) d on true
    left join lateral (select x.id, x.assignee_user_id, x.assigned_at from ops.task x
                        where x.compliance_item_id = i.id and x.status in ('open', 'in_progress')
                        order by x.due_at limit 1) t on true
    left join core.app_user u on u.id = t.assignee_user_id
   where i.tenant_id = core.my_tenant() and i.archived_at is null
     and core.module_on(i.tenant_id, 'compliance')
     and core.can('COMPLIANCE', 'view', i.org_node_id, null)
     and (p_node is null or n.path operator(extensions.<@)
                            (select p.path from core.hierarchy_node p where p.id = p_node))
   order by i.next_due, n.name, i.name;
$$;

revoke execute on function ops.task_assigned_at(), ops.task_handover_log(),
  ops.task_homes(ops.task), ops.looks_after(ops.task, text), ops.sees_task(ops.task),
  ops.my_tasks(), ops.my_handed_on(), ops.team_tasks(uuid, date, date),
  ops.maintenance_requests(uuid), ops.compliance_items(uuid) from public;
grant execute on function ops.my_tasks(), ops.my_handed_on(), ops.team_tasks(uuid, date, date),
  ops.maintenance_requests(uuid), ops.compliance_items(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop trigger handover on ops.task;
drop trigger assigned_at on ops.task;
drop function ops.task_handover_log();
drop function ops.task_assigned_at();
drop function ops.my_handed_on();

drop function ops.compliance_items(uuid);
create function ops.compliance_items(p_node uuid)
returns table (id uuid, org_node_id uuid, place_name text, name text, every_months int,
               next_due date, days_left int, owner_role text, owner_role_name text,
               needs_proof boolean, last_done date, last_files text[], open_task uuid,
               doer_role text, doer_role_name text, with_name text, outlet_id uuid)
language sql stable security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  select i.id, i.org_node_id, n.name, i.name, i.every_months, i.next_due,
         (i.next_due - ops.today_at(i.org_node_id))::int, i.owner_role,
         coalesce(r.name, i.owner_role), i.needs_proof, d.done_on, d.files, t.id,
         i.doer_role, case when i.doer_role is not null then coalesce(dr.name, i.doer_role) end,
         u.display_name, coalesce(core.nearest(i.org_node_id, array['outlet', 'site']), i.org_node_id)
    from ops.compliance_item i
    join core.hierarchy_node n on n.id = i.org_node_id
    left join hr.job_role r on r.tenant_id = i.tenant_id and r.code = i.owner_role
    left join hr.job_role dr on dr.tenant_id = i.tenant_id and dr.code = i.doer_role
    left join lateral (select x.done_on, x.files from ops.compliance_done x
                        where x.item_id = i.id order by x.done_on desc, x.created_at desc
                        limit 1) d on true
    left join lateral (select x.id, x.assignee_user_id from ops.task x
                        where x.compliance_item_id = i.id and x.status in ('open', 'in_progress')
                        order by x.due_at limit 1) t on true
    left join core.app_user u on u.id = t.assignee_user_id
   where i.tenant_id = core.my_tenant() and i.archived_at is null
     and core.module_on(i.tenant_id, 'compliance')
     and core.can('COMPLIANCE', 'view', i.org_node_id, null)
     and (p_node is null or n.path operator(extensions.<@)
                            (select p.path from core.hierarchy_node p where p.id = p_node))
   order by i.next_due, n.name, i.name;
$$;

drop function ops.maintenance_requests(uuid);
create function ops.maintenance_requests(p_id uuid default null)
returns table (id uuid, title text, description text, status text, org_node_id uuid,
               handled_by text, place_name text, reported_by_name text, assigned_to uuid,
               assigned_to_name text, photo_key text, done_photo_key text, done_note text,
               created_at timestamptz, done_at timestamptz, place_node_id uuid)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select r.id, r.title, r.description, r.status, r.org_node_id, h.name, p.name,
         rb.display_name, r.assigned_to, at.display_name, r.photo_key, r.done_photo_key,
         r.done_note, r.created_at, r.done_at, r.place_node_id
    from ops.maintenance_request r
    join core.hierarchy_node h on h.id = r.org_node_id
    join core.hierarchy_node p on p.id = r.place_node_id
    left join core.app_user rb on rb.id = r.reported_by
    left join core.app_user at on at.id = r.assigned_to
   where r.tenant_id = core.my_tenant()
     and (p_id is null or r.id = p_id)
     and (r.reported_by = core.current_user_id() or r.assigned_to = core.current_user_id()
          or core.can('MAINTENANCE', 'view', r.org_node_id, null))
   order by r.status = 'done', r.created_at desc
   limit 100;
$$;

drop function ops.team_tasks(uuid, date, date);
create function ops.team_tasks(p_node uuid, p_from date, p_to date)
returns table (id uuid, kind text, title text, org_node_id uuid, place_name text, due_at timestamptz,
               priority text, status text, assignee_name text, pool text, steps_total int,
               steps_done int, flagged int, overdue boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, hr, extensions
as $$
declare
  v_tz text := ops.tz_of(p_node);
begin
  perform hr.require('TASKS', 'view', p_node);
  return query
    select t.id, t.kind, t.title, t.org_node_id, n.name, t.due_at, t.priority, t.status,
           u.display_name,
           case t.assign_mode when 'job_role' then (select r.name from hr.job_role r
                                                     where r.tenant_id = t.tenant_id
                                                       and r.code = t.job_role_code)
                              when 'on_shift' then 'On shift' end,
           (select count(*)::int from ops.task_step s where s.task_id = t.id),
           (select count(*)::int from ops.task_step s where s.task_id = t.id and s.done_at is not null),
           (select count(*)::int from ops.task_step s where s.task_id = t.id and s.flagged),
           t.status in ('open', 'in_progress') and t.due_at < now()
      from ops.task t
      join core.hierarchy_node n on n.id = t.org_node_id
      join core.hierarchy_node p on p.id = p_node
      left join core.app_user u on u.id = t.assignee_user_id
     where t.tenant_id = p.tenant_id
       and n.path operator(extensions.<@) p.path
       and (t.due_at at time zone v_tz)::date between p_from and p_to
     order by t.due_at, n.name;
end $$;

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

grant execute on function ops.my_tasks(), ops.team_tasks(uuid, date, date),
  ops.maintenance_requests(uuid), ops.compliance_items(uuid) to app_rw;

create or replace function ops.compliance_task(p_task uuid)
returns table (licence_id uuid, item_id uuid, name text, place_name text, number text,
               authority text, expires_on date, next_due date, every_months int,
               needs_proof boolean, can_act boolean, can_hand_on boolean, owner_role_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task;
  v_may boolean;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind in ('licence', 'compliance');
  if not found or not (core.can('TASKS', 'view', v_t.org_node_id, null)
                       or ops.can_work(v_t, core.current_user_id())
                       or core.can('COMPLIANCE', 'view', v_t.org_node_id, null)) then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  v_may := coalesce(v_t.status in ('open', 'in_progress')
                    and (ops.can_work(v_t, core.current_user_id())
                         or core.can('COMPLIANCE', 'modify', v_t.org_node_id, null)), false);
  return query
    select l.id, i.id, coalesce(l.name, i.name), n.name, l.number, l.authority, l.expires_on,
           i.next_due, i.every_months, coalesce(i.needs_proof, true), v_may, v_may,
           case when i.id is not null then ops.role_name(i.tenant_id, i.owner_role) end
      from (select 1) one
      left join ops.licence l on l.id = v_t.licence_id
      left join ops.compliance_item i on i.id = v_t.compliance_item_id
      join core.hierarchy_node n on n.id = v_t.org_node_id;
end $$;

create or replace function ops.task_detail(p_task uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task;
  v_me uuid := core.current_user_id();
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant();
  if not found then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  if not (v_t.assignee_user_id = v_me or ops.can_work(v_t, v_me)
          or core.can('TASKS', 'view', v_t.org_node_id, null)) then
    perform ops.fail('NOT_AUTHORISED', 'not your task');
  end if;
  return to_jsonb(v_t) || jsonb_build_object(
    'place_name', (select name from core.hierarchy_node where id = v_t.org_node_id),
    'store_name', (select name from core.hierarchy_node where id = v_t.delivery_node_id),
    'item', (select jsonb_build_object('sku', i.sku, 'name', i.name, 'unit', i.base_uom)
               from inv.item i where i.id = v_t.item_id),
    'assignee_name', (select display_name from core.app_user where id = v_t.assignee_user_id),
    'assigned_by_name', (select display_name from core.app_user where id = v_t.assigned_by),
    'reported_by_name', (select display_name from core.app_user where id = v_t.reported_by),
    'made_qty', (select coalesce(sum(p.qty_made), 0) from inv.production p where p.task_id = v_t.id),
    'can_work', ops.can_work(v_t, v_me),
    'can_manage', core.can('TASKS', 'modify', v_t.org_node_id, null),
    'steps', coalesce((select jsonb_agg(jsonb_build_object(
               'id', s.id, 'position', s.position, 'label', s.label, 'kind', s.kind,
               'min', s.min_value, 'max', s.max_value, 'unit', s.unit,
               'photo_required', s.photo_required, 'value_num', s.value_num,
               'value_text', s.value_text, 'photo_key', s.photo_key, 'flagged', s.flagged,
               'done_at', s.done_at,
               'done_by_name', (select display_name from core.app_user where id = s.done_by))
               order by s.position)
               from ops.task_step s where s.task_id = v_t.id), '[]'));
end $$;

create or replace function ops.hand_on_people(p_task uuid)
returns table (user_id uuid, name text, job_role text, place_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind in ('licence', 'compliance');
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

create or replace function ops.reassign_task(p_task uuid, p_user uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant()
     and kind in ('receive', 'licence', 'compliance') for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  if v_t.kind = 'receive' then
    perform hr.require('TASKS', 'modify', v_t.org_node_id);
  else
    perform core.require_module('compliance');
    if not ops.may_hand_on(v_t) then
      perform ops.fail('NOT_AUTHORISED', 'not yours to hand on');
    end if;
  end if;
  if v_t.status not in ('open', 'in_progress') then
    perform ops.fail('INVALID_STATE', 'the task is done');
  end if;
  if p_user is null or not ops.works_under(p_user, v_t.org_node_id) then
    perform ops.fail('INVALID_ASSIGNEE', 'they do not work at this place');
  end if;
  update ops.task
     set assignee_user_id = p_user, assigned_by = core.current_user_id(), assign_mode = 'person'
   where id = v_t.id returning * into v_t;
  perform ops.notify_task(v_t, array[p_user], 'task_assigned', 'New task: ' || v_t.title);
end $$;

create or replace function ops.may_hand_on(p_task ops.task) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select coalesce(case p_task.kind
           when 'receive' then core.can('TASKS', 'modify', p_task.org_node_id, null)
           when 'licence' then ops.can_work(p_task, core.current_user_id())
                               or core.can('COMPLIANCE', 'modify', p_task.org_node_id, null)
           when 'compliance' then ops.can_work(p_task, core.current_user_id())
                                  or core.can('COMPLIANCE', 'modify', p_task.org_node_id, null)
           else false end, false);
$$;

create or replace function ops.can_work(p_task ops.task, p_user uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select p_task.status in ('open', 'in_progress')
         and exists (select 1 from core.app_user u where u.id = p_user and u.status = 'active')
         and (p_task.assignee_user_id = p_user
              or (p_task.assignee_user_id is null and ops.in_pool(p_task, p_user)));
$$;

drop function ops.sees_task(ops.task);
drop function ops.looks_after(ops.task, text);
drop function ops.task_homes(ops.task);

delete from core.domain_table where table_name = 'ops.task_handover'::regclass;
drop table ops.task_handover;
alter table ops.task drop column assigned_at;
