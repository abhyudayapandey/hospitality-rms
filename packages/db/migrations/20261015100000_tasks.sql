-- migrate:up
-- Tasks, checklists, prep lists, maintenance and expired batches (Prompt 11b, ADR 020).
--
--   * Three org domains, written into each tenant by the product sync (packages/domain):
--     TASKS, CHECKLIST_TEMPLATES and MAINTENANCE.
--   * ops.task is one table for every kind: one_off, checklist (made from a template by
--     ops.tasks_tick), prep (a batch to make) and expiry (an expired batch reported, then
--     assigned by the lead to discard and remake). Steps live in ops.task_step.
--   * A task is for one person, for a job role at a place, or for whoever is on shift
--     there at the due time. Pooled tasks reach people through ops.my_tasks(); the first
--     to start one takes it. Staff read only the tasks assigned to them (owner leg).
--   * Nothing here needs an approval, so status changes happen inside these functions
--     (like hr.resolve_exception), never by table writes: every table is rpc_only.
--   * Maintenance requests are stored at the place that handles them: the outlet's
--     Engineering department, or the outlet when it has none.
--   * Discarding an expired batch records wastage through the existing path (reason
--     expired, linked to the task); above the store's wastage limit it still needs a photo
--     and the outlet manager's approval, submitted in the name of the lead who assigned
--     the discard (they decided the batch goes).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table ops.checklist_template (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  code text,                       -- set by the onboarding file, for re-imports
  name text not null check (length(btrim(name)) between 1 and 120),
  schedule jsonb not null,         -- see ops.check_schedule
  assign jsonb not null,           -- see ops.check_assign
  steps jsonb not null,            -- see ops.check_steps
  archived_at timestamptz
);
select core.add_standard_columns('ops.checklist_template');
create unique index checklist_template_code on ops.checklist_template (tenant_id, code)
  where code is not null;

create table ops.task (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  delivery_node_id uuid references core.hierarchy_node(id),   -- the store, for prep and expiry
  kind text not null check (kind in ('one_off', 'checklist', 'prep', 'expiry')),
  title text not null check (length(btrim(title)) between 1 and 200),
  description text,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  due_at timestamptz not null,
  status text not null default 'open'
    check (status in ('reported', 'open', 'in_progress', 'done', 'cancelled')),
  assign_mode text check (assign_mode in ('person', 'job_role', 'on_shift')),
  job_role_code text,
  assignee_user_id uuid references core.app_user(id),
  assigned_by uuid references core.app_user(id),
  template_id uuid references ops.checklist_template(id),
  item_id uuid references inv.item(id),
  target_qty numeric(18,6),
  batch_no text,
  remake boolean,
  reported_by uuid references core.app_user(id),
  completed_by uuid references core.app_user(id),
  completed_at timestamptz,
  cancel_reason text,
  reminded_at timestamptz,
  escalated_at timestamptz,
  escalated_head_at timestamptz,
  idempotency_key text,
  check ((status = 'reported') = (assign_mode is null)),
  check (assign_mode is distinct from 'job_role' or job_role_code is not null),
  check (assign_mode is distinct from 'person' or assignee_user_id is not null),
  check (kind not in ('prep', 'expiry') or (delivery_node_id is not null and item_id is not null))
);
select core.add_standard_columns('ops.task');
create unique index task_idem on ops.task (tenant_id, created_by, idempotency_key)
  where idempotency_key is not null;
create unique index task_occurrence on ops.task (template_id, due_at) where template_id is not null;
-- one live report per batch
create unique index task_expiry_batch on ops.task (delivery_node_id, item_id, batch_no)
  where kind = 'expiry' and status <> 'cancelled';
create index task_node_due on ops.task (org_node_id, due_at);
create index task_assignee on ops.task (assignee_user_id) where status in ('open', 'in_progress');
create index task_open_due on ops.task (due_at) where status in ('open', 'in_progress');

create table ops.task_step (
  id uuid primary key default core.uuid_v7(),
  task_id uuid not null references ops.task(id),
  org_node_id uuid not null references core.hierarchy_node(id),
  position int not null,
  label text not null,
  -- discard and batch steps are completed by recording the wastage or the batch
  kind text not null check (kind in ('tick', 'number', 'text', 'photo', 'discard', 'batch')),
  min_value numeric,
  max_value numeric,
  unit text,
  photo_required boolean not null default false,
  value_num numeric,
  value_text text,
  photo_key text,
  flagged boolean not null default false,
  ref_id uuid,                     -- the wastage or production row
  done_by uuid references core.app_user(id),
  done_at timestamptz,
  unique (task_id, position)
);
select core.add_standard_columns('ops.task_step');

create table ops.maintenance_request (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),     -- who handles it
  place_node_id uuid not null references core.hierarchy_node(id),   -- where the problem is
  title text not null check (length(btrim(title)) between 1 and 200),
  description text,
  photo_key text,
  reported_by uuid not null references core.app_user(id),
  status text not null default 'open' check (status in ('open', 'assigned', 'in_progress', 'done')),
  assigned_to uuid references core.app_user(id),
  assigned_by uuid references core.app_user(id),
  assigned_at timestamptz,
  started_at timestamptz,
  done_at timestamptz,
  done_photo_key text,
  done_note text,
  idempotency_key text
);
select core.add_standard_columns('ops.maintenance_request');
create unique index maintenance_idem on ops.maintenance_request (tenant_id, created_by, idempotency_key)
  where idempotency_key is not null;
create index maintenance_node on ops.maintenance_request (org_node_id, status);

-- the trace from a batch to its wastage and its remake
alter table inv.production add column task_id uuid references ops.task(id);
alter table inv.wastage_line add column task_id uuid references ops.task(id);
create index production_task on inv.production (task_id) where task_id is not null;
create index wastage_line_task on inv.wastage_line (task_id) where task_id is not null;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function ops.fail(p_code text, p_detail text default null) returns void
language plpgsql as $$
begin
  raise exception '%', p_code using detail = coalesce(p_detail, '');
end $$;

-- An IANA time zone for a place: its own, the nearest above it, or the customer's.
create function ops.tz_of(p_node uuid) returns text
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce(
    (select n.timezone from core.self_and_ancestors(p_node) a
       join core.hierarchy_node n on n.id = a.id
      where n.timezone is not null order by a.depth desc limit 1),
    (select t.default_timezone from core.hierarchy_node n join core.tenant t on t.id = n.tenant_id
      where n.id = p_node),
    'UTC');
$$;

-- People holding the first of p_groups found at p_node or above it (the lead of a place:
-- its department head, else its outlet manager), without p_exclude.
create function ops.leads(p_node uuid, p_groups text[] default array['DEPARTMENT_HEAD', 'OUTLET_MANAGER'],
                          p_exclude uuid[] default '{}')
returns uuid[]
language plpgsql stable security definer
set search_path = pg_catalog, core
as $$
declare
  v_tenant uuid := (select tenant_id from core.hierarchy_node where id = p_node);
  v_code text;
  v_group uuid;
  v_at uuid;
  v_users uuid[];
begin
  foreach v_code in array p_groups loop
    select id into v_group from core.security_group where tenant_id = v_tenant and code = v_code;
    continue when v_group is null;
    v_at := core.nearest_group_node(v_group, p_node, p_exclude);
    continue when v_at is null;
    v_users := array(select h from core.group_holders(v_group, v_at) h
                      where h <> all (p_exclude) order by h);
    if cardinality(v_users) > 0 then
      return v_users;
    end if;
  end loop;
  return '{}';
end $$;

-- Is p_user an active worker whose home is p_node or below it?
create function ops.works_under(p_user uuid, p_node uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select exists (
    select 1 from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node n on n.id = p_node and n.tenant_id = w.tenant_id
     where w.owner_user_id = p_user and w.status = 'active'
       and h.path operator(extensions.<@) n.path);
$$;

-- Validates who a task goes to at p_node: {"mode":"person","user_id":…},
-- {"mode":"job_role","role":…} (someone there holds it) or {"mode":"on_shift"}.
create function ops.check_assign(p_node uuid, p_assign jsonb) returns void
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

-- Validates steps: 1 to 30 of {label, kind tick|number|text|photo, min?, max?, unit?,
-- photo_required?}.
create function ops.check_steps(p_steps jsonb) returns void
language plpgsql immutable as $$
declare
  v_s jsonb;
begin
  if jsonb_typeof(p_steps) is distinct from 'array' or jsonb_array_length(p_steps) > 30 then
    perform ops.fail('INVALID_STEPS', 'up to 30 steps');
  end if;
  for v_s in select * from jsonb_array_elements(p_steps) loop
    if length(btrim(coalesce(v_s ->> 'label', ''))) not between 1 and 200 then
      perform ops.fail('INVALID_STEPS', 'every step needs a label');
    end if;
    if coalesce(v_s ->> 'kind', '') not in ('tick', 'number', 'text', 'photo') then
      perform ops.fail('INVALID_STEPS', 'tick, number, text or photo');
    end if;
    if jsonb_typeof(v_s -> 'min') not in ('number', 'null') and v_s ? 'min'
       or jsonb_typeof(v_s -> 'max') not in ('number', 'null') and v_s ? 'max' then
      perform ops.fail('INVALID_STEPS', 'the range is numbers');
    end if;
    if (v_s ->> 'min')::numeric > (v_s ->> 'max')::numeric then
      perform ops.fail('INVALID_STEPS', 'the lowest acceptable value is above the highest');
    end if;
  end loop;
end $$;

-- Validates a schedule (times are local "HH:MM" at the template's place):
--   {"kind":"daily","times":["07:00"]}
--   {"kind":"weekly","weekdays":[1,4],"times":["09:00"]}          (ISO: 1 = Monday)
--   {"kind":"every_n_hours","every":2,"from":"08:00","to":"22:00"} (from, then every N
--                                                                  hours up to "to")
create function ops.check_schedule(p_schedule jsonb) returns void
language plpgsql immutable as $$
declare
  v_t jsonb;
begin
  case coalesce(p_schedule ->> 'kind', '')
    when 'daily', 'weekly' then
      if jsonb_typeof(p_schedule -> 'times') is distinct from 'array'
         or jsonb_array_length(p_schedule -> 'times') not between 1 and 24 then
        perform ops.fail('INVALID_SCHEDULE', 'one to 24 times a day');
      end if;
      for v_t in select * from jsonb_array_elements(p_schedule -> 'times') loop
        if coalesce(v_t #>> '{}', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
          perform ops.fail('INVALID_SCHEDULE', 'times are HH:MM');
        end if;
      end loop;
      if p_schedule ->> 'kind' = 'weekly' and (
           jsonb_typeof(p_schedule -> 'weekdays') is distinct from 'array'
           or jsonb_array_length(p_schedule -> 'weekdays') = 0
           or exists (select 1 from jsonb_array_elements(p_schedule -> 'weekdays') d
                       where jsonb_typeof(d) <> 'number' or (d #>> '{}')::numeric not in (1, 2, 3, 4, 5, 6, 7))) then
        perform ops.fail('INVALID_SCHEDULE', 'weekdays are 1 (Monday) to 7 (Sunday)');
      end if;
    when 'every_n_hours' then
      if jsonb_typeof(p_schedule -> 'every') is distinct from 'number'
         or (p_schedule ->> 'every')::numeric not in (1, 2, 3, 4, 6, 8, 12) then
        perform ops.fail('INVALID_SCHEDULE', 'every 1, 2, 3, 4, 6, 8 or 12 hours');
      end if;
      if coalesce(p_schedule ->> 'from', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or coalesce(p_schedule ->> 'to', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        perform ops.fail('INVALID_SCHEDULE', 'the window is HH:MM to HH:MM');
      end if;
    else
      perform ops.fail('INVALID_SCHEDULE', 'daily, weekly or every_n_hours');
  end case;
end $$;

-- When a schedule falls due in (p_from, p_to], at local times in p_tz. A window whose
-- "to" is before its "from" runs past midnight.
create function ops.occurrences(p_schedule jsonb, p_tz text, p_from timestamptz, p_to timestamptz)
returns setof timestamptz
language plpgsql stable as $$
declare
  v_day date;
  v_last date := (p_to at time zone p_tz)::date;
  v_t text;
  v_at timestamptz;
  v_from interval;
  v_to interval;
  v_step interval;
  v_off interval;
begin
  perform ops.check_schedule(p_schedule);
  -- start a day early: a window that runs past midnight belongs to the day it began
  v_day := (p_from at time zone p_tz)::date - 1;
  while v_day <= v_last loop
    if p_schedule ->> 'kind' in ('daily', 'weekly') then
      if p_schedule ->> 'kind' = 'daily'
         or (p_schedule -> 'weekdays') @> to_jsonb(extract(isodow from v_day)::int) then
        for v_t in select jsonb_array_elements_text(p_schedule -> 'times') loop
          v_at := (v_day + v_t::time) at time zone p_tz;
          if v_at > p_from and v_at <= p_to then
            return next v_at;
          end if;
        end loop;
      end if;
    else
      v_from := (p_schedule ->> 'from')::time - time '00:00';
      v_to := (p_schedule ->> 'to')::time - time '00:00';
      if v_to < v_from then
        v_to := v_to + interval '1 day';
      end if;
      v_step := make_interval(hours => (p_schedule ->> 'every')::int);
      v_off := v_from;
      while v_off <= v_to loop
        v_at := (v_day + v_off) at time zone p_tz;
        if v_at > p_from and v_at <= p_to then
          return next v_at;
        end if;
        v_off := v_off + v_step;
      end loop;
    end if;
    v_day := v_day + 1;
  end loop;
end $$;

-- Is p_user in the pool of a task for a job role or whoever is on shift (whether or not
-- someone has taken it)?
create function ops.in_pool(p_task ops.task, p_user uuid) returns boolean
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

-- May p_user work on the task now: it is theirs, or it is pooled, untaken, and they are
-- in the pool.
create function ops.can_work(p_task ops.task, p_user uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select p_task.status in ('open', 'in_progress')
         and exists (select 1 from core.app_user u where u.id = p_user and u.status = 'active')
         and (p_task.assignee_user_id = p_user
              or (p_task.assignee_user_id is null and ops.in_pool(p_task, p_user)));
$$;

-- Who a task currently reaches: its assignee, or everyone in its pool.
create function ops.task_people(p_task ops.task) returns setof uuid
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

-- Loads a task for the caller to work on: NOT_FOUND, INVALID_STATE, TASK_TAKEN (someone
-- else in the pool started it) or NOT_AUTHORISED. Takes a pooled task for the caller.
create function ops.task_to_work(p_task uuid) returns ops.task
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_me core.app_user := wf.me();
  v_t ops.task;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = v_me.tenant_id for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  if v_t.assignee_user_id is distinct from v_me.id and v_t.assignee_user_id is not null
     and ops.in_pool(v_t, v_me.id) then
    perform ops.fail('TASK_TAKEN', 'someone else started this task');
  end if;
  if v_t.assignee_user_id is distinct from v_me.id
     and not (v_t.assignee_user_id is null and ops.in_pool(v_t, v_me.id)) then
    perform ops.fail('NOT_AUTHORISED', 'not your task');
  end if;
  if v_t.status not in ('open', 'in_progress') then
    perform ops.fail('INVALID_STATE', format('the task is %s', v_t.status));
  end if;
  if v_t.assignee_user_id is null then
    update ops.task set assignee_user_id = v_me.id where id = v_t.id returning * into v_t;
  end if;
  return v_t;
end $$;

-- Marks a task in progress, or done when every step is done.
create function ops.settle(p_task uuid) returns text
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_status text;
begin
  update ops.task t
     set status = case when not exists (select 1 from ops.task_step s
                                         where s.task_id = t.id and s.done_at is null)
                            and exists (select 1 from ops.task_step s where s.task_id = t.id)
                       then 'done' else 'in_progress' end,
         completed_by = case when not exists (select 1 from ops.task_step s
                                               where s.task_id = t.id and s.done_at is null)
                             then core.current_user_id() end,
         completed_at = case when not exists (select 1 from ops.task_step s
                                               where s.task_id = t.id and s.done_at is null)
                             then now() end
   where t.id = p_task
  returning status into v_status;
  return v_status;
end $$;

create function ops.photo_ok(p_key text, p_tenant uuid, p_node uuid, p_prefixes text[]) returns boolean
language sql immutable as $$
  select p_key ~ format('^tasks/(%s)/%s/%s/[0-9a-f-]{36}\.(jpg|png|webp)$',
                        array_to_string(p_prefixes, '|'), p_tenant, p_node);
$$;

-- Copies steps into a task.
create function ops.add_steps(p_task ops.task, p_steps jsonb) returns void
language sql security definer
set search_path = pg_catalog, ops
as $$
  insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind, min_value,
                             max_value, unit, photo_required)
  select p_task.tenant_id, p_task.id, p_task.org_node_id, s.ord, btrim(s.v ->> 'label'),
         s.v ->> 'kind', (s.v ->> 'min')::numeric, (s.v ->> 'max')::numeric,
         nullif(btrim(s.v ->> 'unit'), ''), coalesce((s.v ->> 'photo_required')::boolean, false)
    from jsonb_array_elements(p_steps) with ordinality s(v, ord);
$$;

create function ops.notify_task(p_task ops.task, p_users uuid[], p_kind text, p_title text,
                                p_body text default null) returns void
language sql security definer
set search_path = pg_catalog, ops
as $$
  select ops.notify(p_task.tenant_id, u, p_kind, p_title, p_body, '/tasks/' || p_task.id)
    from unnest(p_users) u where u is not null;
$$;

-- ---------------------------------------------------------------------------
-- One-off tasks
-- ---------------------------------------------------------------------------

create function ops.create_task(p_node uuid, p_title text, p_description text, p_due_at timestamptz,
                                p_priority text, p_assign jsonb, p_steps jsonb default '[]',
                                p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_me core.app_user := wf.me();
  v_t ops.task;
begin
  if p_idempotency_key is not null then
    select * into v_t from ops.task
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_t.id; end if;
  end if;
  perform hr.require('TASKS', 'modify', p_node);
  perform ops.check_assign(p_node, p_assign);
  perform ops.check_steps(coalesce(p_steps, '[]'));
  if p_due_at is null then
    perform ops.fail('INVALID_DUE', 'when it is due');
  end if;
  if coalesce(p_priority, 'normal') not in ('low', 'normal', 'high') then
    perform ops.fail('INVALID_PRIORITY', 'low, normal or high');
  end if;
  if length(btrim(coalesce(p_title, ''))) = 0 then
    perform ops.fail('INVALID_TITLE', 'what needs doing');
  end if;

  insert into ops.task (tenant_id, org_node_id, kind, title, description, priority, due_at,
                        assign_mode, job_role_code, assignee_user_id, assigned_by, idempotency_key)
  values (v_me.tenant_id, p_node, 'one_off', btrim(p_title), nullif(btrim(p_description), ''),
          coalesce(p_priority, 'normal'), p_due_at, p_assign ->> 'mode', p_assign ->> 'role',
          (p_assign ->> 'user_id')::uuid, v_me.id, p_idempotency_key)
  returning * into v_t;
  perform ops.add_steps(v_t, coalesce(p_steps, '[]'));
  perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'task_assigned',
                          'New task: ' || v_t.title);
  return v_t.id;
end $$;

-- p_value: {"done":true} for a tick, {"number":4.5}, {"text":"…"} or {"photo_key":"…"};
-- any step may carry a photo_key, and a step marked photo_required needs one. A number
-- outside the step's range is flagged, and the place's lead is told.
create function ops.complete_step(p_task uuid, p_step uuid, p_value jsonb) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task := ops.task_to_work(p_task);
  v_s ops.task_step;
  v_num numeric;
  v_text text := nullif(btrim(p_value ->> 'text'), '');
  v_photo text := p_value ->> 'photo_key';
  v_flagged boolean := false;
begin
  select * into v_s from ops.task_step where id = p_step and task_id = v_t.id for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such step');
  end if;
  if v_s.kind in ('discard', 'batch') then
    perform ops.fail('INVALID_STEP', 'recorded by discarding or making the batch');
  end if;
  if v_photo is not null
     and not ops.photo_ok(v_photo, v_t.tenant_id, v_t.org_node_id, array['routine', 'keep']) then
    perform ops.fail('INVALID_PHOTO', 'photo was not uploaded for this place');
  end if;
  if (v_s.photo_required or v_s.kind = 'photo') and v_photo is null then
    perform ops.fail('PHOTO_REQUIRED', 'this step needs a photo');
  end if;
  case v_s.kind
    when 'tick' then
      if coalesce((p_value ->> 'done')::boolean, false) is not true then
        perform ops.fail('INVALID_VALUE', 'tick it');
      end if;
    when 'number' then
      begin
        v_num := (p_value ->> 'number')::numeric;
      exception when invalid_text_representation then
        perform ops.fail('INVALID_VALUE', 'a number');
      end;
      if v_num is null then
        perform ops.fail('INVALID_VALUE', 'a number');
      end if;
      v_flagged := v_num < v_s.min_value or v_num > v_s.max_value;
    when 'text' then
      if v_text is null then
        perform ops.fail('INVALID_VALUE', 'some text');
      end if;
    else
      null;
  end case;

  update ops.task_step
     set value_num = v_num, value_text = v_text, photo_key = v_photo,
         flagged = coalesce(v_flagged, false), done_by = core.current_user_id(), done_at = now()
   where id = v_s.id;
  if coalesce(v_flagged, false) and not v_s.flagged then
    perform ops.notify_task(v_t, ops.leads(v_t.org_node_id, p_exclude => array[core.current_user_id()]),
                            'task_flagged',
                            format('%s: %s is %s%s', v_t.title, v_s.label, v_num,
                                   coalesce(' ' || v_s.unit, '')),
                            format('Acceptable: %s to %s', coalesce(v_s.min_value::text, '…'),
                                   coalesce(v_s.max_value::text, '…')));
  end if;
  update ops.task set status = 'in_progress' where id = v_t.id and status = 'open';
  return jsonb_build_object('flagged', coalesce(v_flagged, false));
end $$;

-- After the server copied a flagged step's photo to tasks/keep/ (kept 400 days), point
-- the step at the copy.
create function ops.keep_step_photo(p_task uuid, p_step uuid, p_key text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task := ops.task_to_work(p_task);
  v_s ops.task_step;
begin
  select * into v_s from ops.task_step where id = p_step and task_id = v_t.id for update;
  if not found or not v_s.flagged or v_s.photo_key is null
     or p_key is distinct from replace(v_s.photo_key, 'tasks/routine/', 'tasks/keep/') then
    perform ops.fail('INVALID_PHOTO', 'only a flagged step''s own photo is kept');
  end if;
  update ops.task_step set photo_key = p_key where id = v_s.id;
end $$;

create function ops.complete_task(p_task uuid, p_note text default null) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task := ops.task_to_work(p_task);
begin
  if exists (select 1 from ops.task_step where task_id = v_t.id and done_at is null) then
    perform ops.fail('STEPS_INCOMPLETE', 'every step needs doing first');
  end if;
  update ops.task
     set status = 'done', completed_by = core.current_user_id(), completed_at = now(),
         description = case when nullif(btrim(p_note), '') is null then description
                            else concat_ws(E'\n\n', description, 'Note: ' || btrim(p_note)) end
   where id = v_t.id;
end $$;

create function ops.cancel_task(p_task uuid, p_reason text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant() for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  perform hr.require('TASKS', 'modify', v_t.org_node_id);
  if v_t.status in ('done', 'cancelled') then
    perform ops.fail('INVALID_STATE', format('the task is %s', v_t.status));
  end if;
  update ops.task set status = 'cancelled', cancel_reason = nullif(btrim(p_reason), '')
   where id = v_t.id;
end $$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

-- The caller's tasks: theirs, and pooled ones they could take; open ones whatever the
-- due date, and those finished in the last day.
create function ops.my_tasks()
returns table (id uuid, kind text, title text, org_node_id uuid, place_name text, due_at timestamptz,
               priority text, status text, assign_mode text, taken boolean, steps_total int,
               steps_done int, overdue boolean)
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

-- One task with its steps, for whoever may work on it or manage it there.
create function ops.task_detail(p_task uuid) returns jsonb
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

-- A place's tasks due in [p_from, p_to] (local days), for task viewers there.
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

-- Completion for the week starting p_week_start, per department (or team place) under
-- p_node: tasks due so far that week, done, and done on time.
create function ops.completion(p_node uuid, p_week_start date)
returns table (org_node_id uuid, place_name text, due int, done int, on_time int, pct int)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, hr, extensions
as $$
declare
  v_tz text := ops.tz_of(p_node);
begin
  perform hr.require('TASKS', 'view', p_node);
  return query
    with places as (
      select d.id, d.name, d.path from core.hierarchy_node d
        join core.hierarchy_node p on p.id = p_node
       where d.tenant_id = p.tenant_id and d.archived_at is null
         and d.path operator(extensions.<@) p.path and core.is_team_place(d.id)
    ), due as (
      select pl.id, t.status, t.completed_at, t.due_at
        from places pl
        join core.hierarchy_node n on n.path operator(extensions.<@) pl.path
        join ops.task t on t.org_node_id = n.id
       where t.status not in ('cancelled', 'reported')
         and t.due_at >= (p_week_start::timestamp at time zone v_tz)
         and t.due_at < ((p_week_start + 7)::timestamp at time zone v_tz)
         and t.due_at <= now()
    )
    select pl.id, pl.name, count(d.id)::int,
           count(d.id) filter (where d.status = 'done')::int,
           count(d.id) filter (where d.status = 'done' and d.completed_at <= d.due_at)::int,
           case when count(d.id) = 0 then null
                else round(100.0 * count(d.id) filter (where d.status = 'done') / count(d.id))::int end
      from places pl left join due d on d.id = pl.id
     group by pl.id, pl.name
     order by pl.name;
end $$;

-- ---------------------------------------------------------------------------
-- Checklist templates
-- ---------------------------------------------------------------------------

create function ops.save_template(p_id uuid, p_node uuid, p_name text, p_schedule jsonb,
                                  p_assign jsonb, p_steps jsonb) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_me core.app_user := wf.me();
  v_old ops.checklist_template;
  v_id uuid;
begin
  perform hr.require('CHECKLIST_TEMPLATES', 'modify', p_node);
  if p_id is not null then
    select * into v_old from ops.checklist_template
     where id = p_id and tenant_id = v_me.tenant_id for update;
    if not found then
      perform ops.fail('NOT_FOUND', 'no such checklist');
    end if;
    perform hr.require('CHECKLIST_TEMPLATES', 'modify', v_old.org_node_id);
  end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then
    perform ops.fail('INVALID_TITLE', 'the checklist needs a name');
  end if;
  perform ops.check_schedule(p_schedule);
  perform ops.check_assign(p_node, p_assign);
  perform ops.check_steps(p_steps);
  if jsonb_array_length(p_steps) = 0 then
    perform ops.fail('INVALID_STEPS', 'a checklist needs a step');
  end if;
  if p_id is null then
    insert into ops.checklist_template (tenant_id, org_node_id, name, schedule, assign, steps)
    values (v_me.tenant_id, p_node, btrim(p_name), p_schedule, p_assign, p_steps)
    returning id into v_id;
  else
    update ops.checklist_template
       set org_node_id = p_node, name = btrim(p_name), schedule = p_schedule, assign = p_assign,
           steps = p_steps, archived_at = null
     where id = p_id returning id into v_id;
  end if;
  return v_id;
end $$;

-- Stops a checklist; its future instances nobody has started are cancelled.
create function ops.archive_template(p_id uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_t ops.checklist_template;
begin
  select * into v_t from ops.checklist_template
   where id = p_id and tenant_id = core.my_tenant() for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such checklist');
  end if;
  perform hr.require('CHECKLIST_TEMPLATES', 'modify', v_t.org_node_id);
  update ops.checklist_template set archived_at = now() where id = p_id;
  update ops.task set status = 'cancelled', cancel_reason = 'checklist stopped'
   where template_id = p_id and status = 'open' and due_at > now();
end $$;

-- The tasks job (systemd timer, every 5 minutes, as wf_executor): checklist instances
-- for the next 24 hours, reminders 30 minutes before the due time, and escalation when
-- overdue (to whoever assigned it at the due time, then to the place's lead an hour later).
create function ops.tasks_tick(p_now timestamptz default now())
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

-- ---------------------------------------------------------------------------
-- Maintenance
-- ---------------------------------------------------------------------------

-- Does the caller work at p_node: at the same outlet (or site) as their home, or under a
-- place where they hold access?
create function ops.works_at(p_node uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select exists (
    select 1 from core.hierarchy_node n
     where n.id = p_node and n.type = 'org' and n.archived_at is null
       and n.tenant_id = core.my_tenant()
       and (core.nearest(n.id, array['outlet', 'site']) = core.nearest(
              (select w.org_node_id from hr.worker w
                where w.owner_user_id = core.current_user_id() and w.status = 'active'),
              array['outlet', 'site'])
            or exists (select 1 from core.effective_access ea
                        where ea.user_id = core.current_user_id() and ea.type = 'org'
                          and (ea.path = n.path
                               or (ea.include_descendants and ea.path operator(extensions.@>) n.path)))));
$$;

-- Where a request at p_place is handled: the outlet's Engineering department, else the
-- outlet (or site), else the place itself.
create function ops.maintenance_node(p_place uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, core
as $$
  with o as (select core.nearest(p_place, array['outlet', 'site']) as id)
  select coalesce(
    (select d.id from core.hierarchy_node d join core.hierarchy_node x on x.id = (select id from o)
      where d.parent_id = x.id and d.kind = 'department' and d.archived_at is null
        and d.code = x.code || '-ENGINEERING'),
    (select id from o), p_place);
$$;

create function ops.raise_maintenance(p_place uuid, p_title text, p_description text,
                                      p_photo_key text, p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_me core.app_user := wf.me();
  v_r ops.maintenance_request;
begin
  if p_idempotency_key is not null then
    select * into v_r from ops.maintenance_request
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_r.id; end if;
  end if;
  if not ops.works_at(p_place) then
    perform ops.fail('NOT_AUTHORISED', 'you do not work at this place');
  end if;
  if length(btrim(coalesce(p_title, ''))) = 0 then
    perform ops.fail('INVALID_TITLE', 'what is wrong');
  end if;
  if p_photo_key is not null and not ops.photo_ok(p_photo_key, v_me.tenant_id, p_place, array['keep']) then
    perform ops.fail('INVALID_PHOTO', 'photo was not uploaded for this place');
  end if;
  insert into ops.maintenance_request (tenant_id, org_node_id, place_node_id, title, description,
                                       photo_key, reported_by, idempotency_key)
  values (v_me.tenant_id, ops.maintenance_node(p_place), p_place, btrim(p_title),
          nullif(btrim(p_description), ''), p_photo_key, v_me.id, p_idempotency_key)
  returning * into v_r;
  perform ops.notify(v_r.tenant_id, u, 'maintenance_raised', 'Maintenance: ' || v_r.title,
                     (select name from core.hierarchy_node where id = p_place),
                     '/tasks/maintenance/' || v_r.id)
     from unnest(ops.leads(v_r.org_node_id, p_exclude => array[v_me.id])) u;
  return v_r.id;
end $$;

create function ops.assign_maintenance(p_id uuid, p_user uuid, p_note text default null)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_r ops.maintenance_request;
begin
  select * into v_r from ops.maintenance_request
   where id = p_id and tenant_id = core.my_tenant() for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such request');
  end if;
  perform hr.require('MAINTENANCE', 'modify', v_r.org_node_id);
  if v_r.status not in ('open', 'assigned') then
    perform ops.fail('INVALID_STATE', format('the request is %s', replace(v_r.status, '_', ' ')));
  end if;
  if p_user is null or not ops.works_under(p_user, v_r.org_node_id) then
    perform ops.fail('INVALID_ASSIGNEE', 'they do not work where this is handled');
  end if;
  update ops.maintenance_request
     set status = 'assigned', assigned_to = p_user, assigned_by = core.current_user_id(),
         assigned_at = now()
   where id = p_id;
  perform ops.notify(v_r.tenant_id, p_user, 'maintenance_assigned', 'Fix: ' || v_r.title,
                     nullif(btrim(p_note), ''), '/tasks/maintenance/' || v_r.id);
end $$;

create function ops.maintenance_to_work(p_id uuid) returns ops.maintenance_request
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_r ops.maintenance_request;
begin
  select * into v_r from ops.maintenance_request
   where id = p_id and tenant_id = core.my_tenant() for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such request');
  end if;
  if v_r.assigned_to is distinct from core.current_user_id() then
    perform ops.fail('NOT_AUTHORISED', 'only the person it is assigned to');
  end if;
  return v_r;
end $$;

create function ops.start_maintenance(p_id uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_r ops.maintenance_request := ops.maintenance_to_work(p_id);
begin
  if v_r.status <> 'assigned' then
    perform ops.fail('INVALID_STATE', format('the request is %s', replace(v_r.status, '_', ' ')));
  end if;
  update ops.maintenance_request set status = 'in_progress', started_at = now() where id = p_id;
end $$;

create function ops.close_maintenance(p_id uuid, p_photo_key text, p_note text default null)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_r ops.maintenance_request := ops.maintenance_to_work(p_id);
begin
  if v_r.status not in ('assigned', 'in_progress') then
    perform ops.fail('INVALID_STATE', format('the request is %s', replace(v_r.status, '_', ' ')));
  end if;
  if p_photo_key is null then
    perform ops.fail('PHOTO_REQUIRED', 'a photo of the fix');
  end if;
  if not ops.photo_ok(p_photo_key, v_r.tenant_id, v_r.org_node_id, array['keep']) then
    perform ops.fail('INVALID_PHOTO', 'photo was not uploaded for this request');
  end if;
  update ops.maintenance_request
     set status = 'done', done_at = now(), started_at = coalesce(started_at, now()),
         done_photo_key = p_photo_key, done_note = nullif(btrim(p_note), '')
   where id = p_id;
  perform ops.notify(v_r.tenant_id, v_r.reported_by, 'maintenance_done', 'Fixed: ' || v_r.title,
                     nullif(btrim(p_note), ''), '/tasks/maintenance/' || v_r.id);
end $$;

-- ---------------------------------------------------------------------------
-- Prep lists
-- ---------------------------------------------------------------------------

-- The team (org place) that makes things at a store: the department linked to it, else
-- the org place linked to the store's location.
create function ops.team_of_store(p_store uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce(
    (select nl.org_node_id from core.node_link nl
       join core.hierarchy_node o on o.id = nl.org_node_id and o.kind = 'department'
      where nl.delivery_node_id = p_store order by o.name limit 1),
    (select nl.org_node_id from core.hierarchy_node s
       join core.node_link nl on nl.delivery_node_id = s.parent_id
      where s.id = p_store order by nl.org_node_id limit 1),
    (select nl.org_node_id from core.node_link nl where nl.delivery_node_id = p_store
      order by nl.org_node_id limit 1));
$$;

-- What to make at a store: per item made there, its par, what is on hand and not
-- expired, what the outlet's events in the next 48 hours need, and the suggested batch.
create function inv.prep_suggestions(p_store uuid)
returns table (item_id uuid, sku text, name text, unit text, par numeric, on_hand numeric,
               event_need numeric, suggested numeric, open_tasks numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, extensions
as $$
declare
  v_outlet uuid := core.nearest(ops.team_of_store(p_store), array['outlet', 'site']);
begin
  if not (core.can('STOCK_LEVELS', 'view', null, p_store) or inv.can_produce_at(p_store)) then
    raise exception 'NOT_AUTHORISED' using detail = format('view STOCK_LEVELS at %s', p_store);
  end if;
  return query
    with made as (
      select x.item_id, x.par_level, i.sku, i.name, i.base_uom
        from inv.item_node x join inv.item i on i.id = x.item_id and i.archived_at is null
       where x.delivery_node_id = p_store and x.made_here and x.archived_at is null
    ), usable as (
      select m.item_id,
             inv.on_hand(m.item_id, p_store)
             - coalesce((select sum(b.remaining) from inv.batch_rows(m.item_id, p_store) b
                          where b.expires_at <= now()), 0) as q
        from made m
    ), needs as (
      select r.item_id, sum(r.qty) as q
        from ops.event e join ops.event_requirement r on r.event_id = e.id
       where e.org_node_id = v_outlet and e.status <> 'cancelled' and r.archived_at is null
         and r.kind = 'item' and e.starts_at >= now() and e.starts_at < now() + interval '48 hours'
       group by r.item_id
    ), pending as (
      select t.item_id, sum(greatest(t.target_qty - coalesce(
               (select sum(p.qty_made) from inv.production p where p.task_id = t.id), 0), 0)) as q
        from ops.task t
       where t.kind = 'prep' and t.delivery_node_id = p_store and t.status in ('open', 'in_progress')
       group by t.item_id
    )
    select m.item_id, m.sku, m.name, m.base_uom, m.par_level, greatest(u.q, 0),
           coalesce(n.q, 0),
           greatest(m.par_level + coalesce(n.q, 0) - greatest(u.q, 0) - coalesce(pe.q, 0), 0),
           coalesce(pe.q, 0)
      from made m
      join usable u on u.item_id = m.item_id
      left join needs n on n.item_id = m.item_id
      left join pending pe on pe.item_id = m.item_id
     order by m.name;
end $$;

-- p_lines: [{item_id, qty}], one prep task each at the team that makes things there.
create function ops.create_prep_tasks(p_store uuid, p_lines jsonb, p_due_at timestamptz,
                                      p_assign jsonb) returns uuid[]
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr, inv
as $$
declare
  v_me core.app_user := wf.me();
  v_team uuid := ops.team_of_store(p_store);
  v_line record;
  v_item inv.item;
  v_t ops.task;
  v_ids uuid[] := '{}';
begin
  if v_team is null or not exists (select 1 from core.hierarchy_node
                                    where id = p_store and tenant_id = v_me.tenant_id) then
    perform ops.fail('NOT_AUTHORISED', 'no team makes things at this store');
  end if;
  perform hr.require('TASKS', 'modify', v_team);
  perform ops.check_assign(v_team, p_assign);
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    perform ops.fail('INVALID_LINES', 'what to make');
  end if;
  if p_due_at is null then
    perform ops.fail('INVALID_DUE', 'when it is due');
  end if;
  for v_line in select * from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric) loop
    select i.* into v_item from inv.item i
      join inv.item_node x on x.item_id = i.id and x.delivery_node_id = p_store and x.made_here
                          and x.archived_at is null
     where i.id = v_line.item_id and i.tenant_id = v_me.tenant_id;
    if v_item.id is null or v_line.qty is null or v_line.qty <= 0 then
      perform ops.fail('INVALID_LINES', 'an item made here, and how much');
    end if;
    insert into ops.task (tenant_id, org_node_id, delivery_node_id, kind, title, due_at,
                          assign_mode, job_role_code, assignee_user_id, assigned_by, item_id,
                          target_qty)
    values (v_me.tenant_id, v_team, p_store, 'prep',
            format('Make %s %s %s', v_item.name, trim_scale(v_line.qty), v_item.base_uom),
            p_due_at, p_assign ->> 'mode', p_assign ->> 'role', (p_assign ->> 'user_id')::uuid,
            v_me.id, v_item.id, v_line.qty)
    returning * into v_t;
    insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind)
    values (v_t.tenant_id, v_t.id, v_t.org_node_id, 1, 'Record the batch', 'batch');
    perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'task_assigned',
                            'New task: ' || v_t.title);
    v_ids := v_ids || v_t.id;
    v_item := null;
  end loop;
  return v_ids;
end $$;

-- Records a batch for a prep task, or the remake of an expired one, through the normal
-- production rules (the caller must be able to record production at the store). A prep
-- task is done once its batches reach the target; a smaller batch leaves it in progress.
create function ops.record_task_batch(p_task uuid, p_qty numeric, p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, inv
as $$
declare
  v_t ops.task := ops.task_to_work(p_task);
  v_step ops.task_step;
  v_id uuid;
  v_made numeric;
begin
  select * into v_step from ops.task_step where task_id = v_t.id and kind = 'batch' for update;
  if v_step.id is null then
    perform ops.fail('INVALID_STEP', 'this task has no batch to make');
  end if;
  v_id := inv.record_production(v_t.delivery_node_id, v_t.item_id, p_qty, null, p_idempotency_key);
  update inv.production set task_id = v_t.id where id = v_id and task_id is null;
  v_made := (select coalesce(sum(qty_made), 0) from inv.production where task_id = v_t.id);
  if v_t.kind = 'expiry' or v_made >= v_t.target_qty then
    update ops.task_step
       set ref_id = v_id, value_num = v_made, done_by = core.current_user_id(), done_at = now()
     where id = v_step.id;
  else
    update ops.task_step set ref_id = v_id, value_num = v_made where id = v_step.id;
  end if;
  perform ops.settle(v_t.id);
  return v_id;
end $$;

-- Test customers only (ADR 017): links a batch the loader recorded in the past (file 26)
-- to the prep task it fulfils (file 32), as if it had been recorded from the task.
create function ops.link_test_batch(p_task uuid, p_production uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, inv
as $$
declare
  v_t ops.task;
  v_p inv.production;
  v_made numeric;
begin
  select * into v_t from ops.task where id = p_task for update;
  select * into v_p from inv.production where id = p_production;
  if v_t.id is null or v_p.id is null
     or not coalesce((select is_test from core.tenant where id = v_t.tenant_id), false)
     or v_t.kind <> 'prep' or v_p.delivery_node_id <> v_t.delivery_node_id
     or v_p.prep_item_id <> v_t.item_id then
    raise exception 'NOT_AUTHORISED' using detail = 'test customers'' prep tasks only';
  end if;
  update inv.production set task_id = v_t.id where id = v_p.id;
  v_made := (select sum(qty_made) from inv.production where task_id = v_t.id);
  update ops.task_step
     set ref_id = v_p.id, value_num = v_made,
         done_by = case when v_made >= v_t.target_qty then v_p.created_by end,
         done_at = case when v_made >= v_t.target_qty then v_p.made_at end
   where task_id = v_t.id and kind = 'batch';
  update ops.task
     set status = case when v_made >= v_t.target_qty then 'done' else 'in_progress' end,
         assignee_user_id = coalesce(assignee_user_id, v_p.created_by),
         completed_by = case when v_made >= v_t.target_qty then v_p.created_by end,
         completed_at = case when v_made >= v_t.target_qty then v_p.made_at end
   where id = v_t.id;
end $$;
revoke execute on function ops.link_test_batch(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- Expired batches
-- ---------------------------------------------------------------------------

-- Wastage lines posted now, or sent for approval above the store's limit. The body of
-- inv.record_wastage, which now checks access and calls this. p_task links the lines to
-- a task; p_submitter is who the approval request is from (default: the caller).
create function inv.post_wastage(p_node uuid, p_lines jsonb, p_idempotency_key text,
                                 p_task uuid, p_submitter uuid) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_w inv.wastage;
  v_threshold numeric;
  v_line record;
  v_cost numeric;
  v_value numeric;
  v_approval jsonb := '[]';
  v_photo_re text;
begin
  if p_idempotency_key is not null then
    select * into v_w from inv.wastage
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_w.id; end if;
  end if;
  perform inv.check_lines(p_lines, p_node);
  v_threshold := inv.wastage_threshold(p_node);
  v_photo_re := format('^wastage/%s/%s/[0-9a-f-]{36}\.(jpg|png|webp)$', v_me.tenant_id, p_node);

  insert into inv.wastage (tenant_id, delivery_node_id, idempotency_key)
  values (v_me.tenant_id, p_node, p_idempotency_key) returning * into v_w;

  for v_line in select * from jsonb_to_recordset(p_lines)
                  as l(item_id uuid, qty numeric, reason text, photo_key text) loop
    if v_line.qty is null or v_line.qty <= 0 then
      perform inv.fail('INVALID_QUANTITY', 'wastage quantity must be positive');
    end if;
    if v_line.reason is null
       or v_line.reason not in ('expired', 'spoiled', 'prep_error', 'damaged', 'other') then
      perform inv.fail('INVALID_LINES', 'unknown wastage reason');
    end if;
    if v_line.photo_key is not null and v_line.photo_key !~ v_photo_re then
      perform inv.fail('INVALID_PHOTO', 'photo was not uploaded for this location');
    end if;
    if inv.on_hand(v_line.item_id, p_node) < v_line.qty then
      perform inv.fail('INSUFFICIENT_STOCK', format('item %s', v_line.item_id));
    end if;
    v_cost := inv.avg_cost(v_line.item_id, p_node);
    v_value := round(v_line.qty * v_cost, 2);

    if v_value > v_threshold then
      if v_line.photo_key is null then
        perform inv.fail('PHOTO_REQUIRED', format('wastage worth %s needs a photo', v_value));
      end if;
      v_approval := v_approval || jsonb_build_object(
        'item_id', v_line.item_id, 'movement_type', 'wastage', 'qty', -v_line.qty,
        'unit_cost', v_cost, 'reason', v_line.reason, 'photo_key', v_line.photo_key);
    else
      perform inv.post(v_line.item_id, p_node, 'wastage', -v_line.qty, v_cost, 'wastage',
                       v_w.id, v_line.reason);
    end if;
    insert into inv.wastage_line (tenant_id, wastage_id, item_id, delivery_node_id, qty, reason,
                                  unit_cost, value, photo_key, outcome, task_id)
    values (v_me.tenant_id, v_w.id, v_line.item_id, p_node, v_line.qty, v_line.reason, v_cost,
            v_value, v_line.photo_key,
            case when v_value > v_threshold then 'approval' else 'posted' end, p_task);
  end loop;

  if jsonb_array_length(v_approval) > 0 then
    -- the request is from the submitter (the lead who decided the batch goes)
    if p_submitter is not null and p_submitter <> v_me.id then
      perform set_config('app.user_id', p_submitter::text, true);
    end if;
    update inv.wastage
       set adjustment_id = inv.submit_adjustment(p_node, 'wastage', 'wastage', v_w.id, v_approval)
     where id = v_w.id;
    perform set_config('app.user_id', v_me.id::text, true);
  end if;
  return v_w.id;
end $$;
revoke execute on function inv.post_wastage(uuid, jsonb, text, uuid, uuid) from public;

create or replace function inv.record_wastage(p_node uuid, p_lines jsonb,
                                              p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_id uuid;
begin
  if p_idempotency_key is not null then
    select id into v_id from inv.wastage
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_id; end if;
  end if;
  perform inv.require('STOCK_ADJUSTMENTS', 'modify', p_node);
  return inv.post_wastage(p_node, p_lines, p_idempotency_key, null, null);
end $$;

-- Reports an expired batch that still has stock: anyone who sees the store's batches
-- (stock viewers, and people who record production there). Reporting it again returns
-- the first report. The lead of the team that makes things at the store is told.
create function ops.report_expired(p_store uuid, p_item uuid, p_batch_no text) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, inv
as $$
declare
  v_me core.app_user := wf.me();
  v_b record;
  v_t ops.task;
  v_team uuid := ops.team_of_store(p_store);
  v_item inv.item;
begin
  if not exists (select 1 from core.hierarchy_node
                  where id = p_store and tenant_id = v_me.tenant_id and type = 'delivery')
     or not (core.can('STOCK_LEVELS', 'view', null, p_store) or inv.can_produce_at(p_store)) then
    perform ops.fail('NOT_AUTHORISED', format('view STOCK_LEVELS at %s', p_store));
  end if;
  select * into v_item from inv.item where id = p_item and tenant_id = v_me.tenant_id;
  select * into v_b from inv.batch_rows(p_item, p_store) b where b.batch_no = p_batch_no limit 1;
  if v_item.id is null or v_b.batch_no is null then
    perform ops.fail('NOT_FOUND', 'no such batch');
  end if;
  if v_b.expires_at > now() or v_b.remaining <= 0 then
    perform ops.fail('NOT_EXPIRED', 'only an expired batch with stock left');
  end if;
  if v_team is null then
    perform ops.fail('NOT_FOUND', 'no team makes things at this store');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ops.expiry:' || p_store || p_item || p_batch_no, 0));
  select * into v_t from ops.task
   where kind = 'expiry' and delivery_node_id = p_store and item_id = p_item
     and batch_no = p_batch_no and status <> 'cancelled';
  if found then
    return v_t.id;
  end if;
  insert into ops.task (tenant_id, org_node_id, delivery_node_id, kind, title, description,
                        priority, due_at, status, item_id, target_qty, batch_no, reported_by)
  values (v_me.tenant_id, v_team, p_store, 'expiry',
          format('Discard expired %s (batch %s)', v_item.name, p_batch_no),
          format('%s %s left, expired %s', trim_scale(v_b.remaining), v_item.base_uom,
                 to_char(v_b.expires_at at time zone ops.tz_of(v_team), 'DD Mon HH24:MI')),
          'high', now(), 'reported', p_item, v_b.remaining, p_batch_no, v_me.id)
  returning * into v_t;
  perform ops.notify_task(v_t, ops.leads(v_team, p_exclude => array[v_me.id]), 'expiry_reported',
                          'Expired: ' || v_item.name || ' batch ' || p_batch_no,
                          'Reported by ' || v_me.display_name || '. Assign someone to discard it.');
  return v_t.id;
end $$;

-- The lead assigns the discard (and, if they want, the remake) to someone in the team.
create function ops.assign_expiry(p_task uuid, p_user uuid, p_due_at timestamptz, p_remake boolean)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind = 'expiry' for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such report');
  end if;
  perform hr.require('TASKS', 'modify', v_t.org_node_id);
  if v_t.status <> 'reported' then
    perform ops.fail('INVALID_STATE', 'already assigned');
  end if;
  if p_user is null or not ops.works_under(p_user, v_t.org_node_id) then
    perform ops.fail('INVALID_ASSIGNEE', 'they do not work at this place');
  end if;
  update ops.task
     set status = 'open', assign_mode = 'person', assignee_user_id = p_user,
         assigned_by = core.current_user_id(), due_at = coalesce(p_due_at, now() + interval '1 hour'),
         remake = coalesce(p_remake, false),
         title = case when coalesce(p_remake, false) then replace(title, 'Discard expired', 'Discard and remake') else title end
   where id = v_t.id returning * into v_t;
  insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind, value_num, unit)
  select v_t.tenant_id, v_t.id, v_t.org_node_id, 1, 'Throw it away and record the wastage',
         'discard', v_t.target_qty, i.base_uom from inv.item i where i.id = v_t.item_id;
  if v_t.remake then
    insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind)
    values (v_t.tenant_id, v_t.id, v_t.org_node_id, 2, 'Make a new batch', 'batch');
  end if;
  perform ops.notify_task(v_t, array[p_user], 'task_assigned', 'New task: ' || v_t.title);
end $$;

-- The assignee throws the batch away: expired wastage through the normal path, linked to
-- the task. Above the store's limit it needs a photo and the outlet manager's approval.
create function ops.discard_expired(p_task uuid, p_qty numeric, p_photo_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, inv
as $$
declare
  v_t ops.task;
  v_step ops.task_step;
  v_left numeric;
  v_id uuid;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant();
  if found and v_t.kind <> 'expiry' then
    perform ops.fail('INVALID_STEP', 'not an expired batch');
  end if;
  v_t := ops.task_to_work(p_task);
  select * into v_step from ops.task_step where task_id = v_t.id and kind = 'discard' for update;
  if v_step.done_at is not null then
    perform ops.fail('INVALID_STATE', 'already thrown away');
  end if;
  v_left := (select b.remaining from inv.batch_rows(v_t.item_id, v_t.delivery_node_id) b
              where b.batch_no = v_t.batch_no limit 1);
  if p_qty is null or p_qty <= 0 or p_qty > coalesce(v_left, 0) then
    perform ops.fail('INVALID_QUANTITY', format('at most %s is left of the batch', trim_scale(coalesce(v_left, 0))));
  end if;
  v_id := inv.post_wastage(v_t.delivery_node_id,
                           jsonb_build_array(jsonb_build_object(
                             'item_id', v_t.item_id, 'qty', p_qty, 'reason', 'expired',
                             'photo_key', p_photo_key)),
                           null, v_t.id, v_t.assigned_by);
  update ops.task_step
     set ref_id = v_id, value_num = p_qty, photo_key = p_photo_key,
         done_by = core.current_user_id(), done_at = now()
   where id = v_step.id;
  perform ops.settle(v_t.id);
  return v_id;
end $$;

-- Expired wastage at a store over a period, line by line with its batch and report: what
-- the cost report shows, and later what batch sizing learns from (ADR 020).
create function inv.expired_wastage(p_store uuid, p_from date, p_to date)
returns table (item_id uuid, sku text, name text, unit text, batch_no text, made_at timestamptz,
               made_qty numeric, expired_at timestamptz, wasted_qty numeric, value numeric,
               outcome text, reported_at timestamptz, reported_by text, discarded_by text,
               remade_qty numeric, wasted_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_tz text := coalesce((select timezone from core.hierarchy_node where id = p_store), 'UTC');
begin
  if not core.can('MENU', 'view', null, p_store) then
    raise exception 'NOT_AUTHORISED' using detail = format('view MENU at %s', p_store);
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start';
  end if;
  return query
    select l.item_id, i.sku, i.name, i.base_uom, t.batch_no, p.made_at, p.qty_made, p.expires_at,
           l.qty, l.value, l.outcome, t.created_at,
           (select display_name from core.app_user where id = t.reported_by),
           (select display_name from core.app_user where id = l.created_by),
           (select sum(r.qty_made) from inv.production r where r.task_id = t.id),
           l.created_at
      from inv.wastage_line l
      join inv.item i on i.id = l.item_id
      left join ops.task t on t.id = l.task_id
      left join inv.production p on p.delivery_node_id = l.delivery_node_id
                                and p.prep_item_id = l.item_id and p.batch_no = t.batch_no
     where l.delivery_node_id = p_store and l.reason = 'expired'
       and l.created_at >= (p_from::timestamp at time zone v_tz)
       and l.created_at < ((p_to + 1)::timestamp at time zone v_tz)
     order by l.created_at;
end $$;

-- What the caller may assign: reported batches (TASKS modify there) and open maintenance
-- requests (MAINTENANCE modify there). Shown in the Inbox.
create function ops.my_to_assign()
returns table (id uuid, kind text, title text, place_name text, reported_at timestamptz,
               reported_by text, org_node_id uuid)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select t.id, 'expiry', t.title, n.name, t.created_at,
         (select display_name from core.app_user where id = t.reported_by), t.org_node_id
    from ops.task t join core.hierarchy_node n on n.id = t.org_node_id
   where t.tenant_id = core.my_tenant() and t.status = 'reported'
     and core.can('TASKS', 'modify', t.org_node_id, null)
  union all
  select r.id, 'maintenance', r.title, n.name, r.created_at,
         (select display_name from core.app_user where id = r.reported_by), r.org_node_id
    from ops.maintenance_request r join core.hierarchy_node n on n.id = r.place_node_id
   where r.tenant_id = core.my_tenant() and r.status = 'open'
     and core.can('MAINTENANCE', 'modify', r.org_node_id, null)
  order by 5;
$$;

-- People the caller may give a task at p_node to (for the assign pickers).
create function ops.assignable_people(p_node uuid)
returns table (user_id uuid, name text, job_role text, place_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
begin
  if not (core.can('TASKS', 'modify', p_node, null) or core.can('MAINTENANCE', 'modify', p_node, null)) then
    perform ops.fail('NOT_AUTHORISED', format('modify TASKS at %s', p_node));
  end if;
  return query
    select u.id, u.display_name, r.name, h.name
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node n on n.id = p_node and n.tenant_id = w.tenant_id
      left join hr.job_role r on r.tenant_id = w.tenant_id and r.code = w.role_code
     where w.status = 'active' and h.path operator(extensions.<@) n.path
     order by u.display_name;
end $$;

-- The maintenance screens: requests the caller reads (the same rows RLS shows: their own,
-- or MAINTENANCE view where it is handled) plus any assigned to them, with names. One
-- request when p_id is given.
create function ops.maintenance_requests(p_id uuid default null)
returns table (id uuid, title text, description text, status text, org_node_id uuid,
               handled_by text, place_name text, reported_by_name text, assigned_to uuid,
               assigned_to_name text, photo_key text, done_photo_key text, done_note text,
               created_at timestamptz, done_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select r.id, r.title, r.description, r.status, r.org_node_id, h.name, p.name,
         rb.display_name, r.assigned_to, at.display_name, r.photo_key, r.done_photo_key,
         r.done_note, r.created_at, r.done_at
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

-- The checklists screen: templates at p_node and below that the caller reads
-- (CHECKLIST_TEMPLATES view where each one is, as RLS), with the place's name.
create function ops.checklists(p_node uuid)
returns table (id uuid, org_node_id uuid, place_name text, name text, schedule jsonb,
               assign jsonb, steps jsonb, archived_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  select t.id, t.org_node_id, n.name, t.name, t.schedule, t.assign, t.steps, t.archived_at
    from ops.checklist_template t
    join core.hierarchy_node n on n.id = t.org_node_id
    join core.hierarchy_node p on p.id = p_node and p.tenant_id = t.tenant_id
   where t.tenant_id = core.my_tenant()
     and n.path operator(extensions.<@) p.path
     and core.can('CHECKLIST_TEMPLATES', 'view', t.org_node_id, null)
   order by t.archived_at is not null, n.name, t.name;
$$;

-- May the caller upload a photo for p_purpose at p_node? The server presigns an upload
-- only then (ADR 006): a step of a task they work on there ('task', under tasks/routine/),
-- a maintenance request where they work or one assigned to them ('maintenance', under
-- tasks/keep/), or the discard of an expired batch they were given ('discard', under
-- wastage/ at the store).
create function ops.can_upload_photo(p_purpose text, p_node uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select coalesce(case p_purpose
    when 'task' then exists (
      select 1 from ops.task t
       where t.org_node_id = p_node and t.tenant_id = core.my_tenant()
         and ops.can_work(t, core.current_user_id()))
    when 'maintenance' then ops.works_at(p_node) or exists (
      select 1 from ops.maintenance_request r
       where r.org_node_id = p_node and r.tenant_id = core.my_tenant()
         and r.assigned_to = core.current_user_id() and r.status in ('assigned', 'in_progress'))
    when 'discard' then exists (
      select 1 from ops.task t
       where t.kind = 'expiry' and t.delivery_node_id = p_node and t.tenant_id = core.my_tenant()
         and ops.can_work(t, core.current_user_id()))
  end, false);
$$;

-- The place switcher's task screens (ADR 016): team places and outlets where the caller
-- reads tasks, creates them, reads checklists, reads maintenance, or may report a problem.
do $$
declare
  v_src text := pg_get_functiondef('core.screen_places(text)'::regprocedure);
  v_old1 text := '''variance'', ''production'', ''sales'', ''menu'', ''roster'', ''exceptions'', ''events'')';
  v_new1 text := '''variance'', ''production'', ''sales'', ''menu'', ''roster'', ''exceptions'', ''events'',
      ''tasks'', ''tasks_new'', ''checklists'', ''maintenance'', ''report'')';
  v_old2 text := '         else
           core.is_team_place(n.id)';
  v_new2 text := '         when p_screen in (''tasks'', ''tasks_new'', ''checklists'', ''maintenance'', ''report'') then
           n.type = ''org'' and (core.is_team_place(n.id) or n.kind in (''outlet'', ''site''))
           and case p_screen
             when ''tasks'' then core.can(''TASKS'', ''view'', n.id, null)
             when ''tasks_new'' then core.can(''TASKS'', ''modify'', n.id, null)
             when ''checklists'' then core.can(''CHECKLIST_TEMPLATES'', ''view'', n.id, null)
             when ''maintenance'' then core.can(''MAINTENANCE'', ''view'', n.id, null)
             else ops.works_at(n.id) end
         else
           core.is_team_place(n.id)';
begin
  if position(v_old1 in v_src) = 0 or position(v_old2 in v_src) = 0 then
    raise exception 'core.screen_places changed; update this migration';
  end if;
  execute replace(replace(v_src, v_old1, v_new1), v_old2, v_new2);
end $$;

-- ---------------------------------------------------------------------------
-- RLS registration (rule 1), audit (rule 5), grants
-- ---------------------------------------------------------------------------

insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only, owner_column) values
  ('ops.checklist_template', 'CHECKLIST_TEMPLATES', 'org', true, null),
  ('ops.task', 'TASKS', 'org', true, 'assignee_user_id'),
  ('ops.task_step', 'TASKS', 'org', true, null),
  ('ops.maintenance_request', 'MAINTENANCE', 'org', true, 'reported_by');

do $$
declare t regclass;
begin
  foreach t in array array['ops.checklist_template', 'ops.task', 'ops.task_step',
                           'ops.maintenance_request']::regclass[] loop
    perform core.apply_domain_rls(t);
    perform audit.enable(t);
  end loop;
end $$;

do $$
declare
  f regprocedure;
begin
  foreach f in array array[
    'ops.fail(text, text)', 'ops.tz_of(uuid)', 'ops.leads(uuid, text[], uuid[])',
    'ops.works_under(uuid, uuid)', 'ops.check_assign(uuid, jsonb)', 'ops.check_steps(jsonb)',
    'ops.check_schedule(jsonb)', 'ops.occurrences(jsonb, text, timestamptz, timestamptz)',
    'ops.in_pool(ops.task, uuid)', 'ops.can_work(ops.task, uuid)', 'ops.task_people(ops.task)',
    'ops.task_to_work(uuid)', 'ops.settle(uuid)', 'ops.photo_ok(text, uuid, uuid, text[])',
    'ops.add_steps(ops.task, jsonb)', 'ops.notify_task(ops.task, uuid[], text, text, text)',
    'ops.create_task(uuid, text, text, timestamptz, text, jsonb, jsonb, text)',
    'ops.complete_step(uuid, uuid, jsonb)', 'ops.keep_step_photo(uuid, uuid, text)',
    'ops.complete_task(uuid, text)', 'ops.cancel_task(uuid, text)', 'ops.my_tasks()',
    'ops.task_detail(uuid)', 'ops.team_tasks(uuid, date, date)', 'ops.completion(uuid, date)',
    'ops.save_template(uuid, uuid, text, jsonb, jsonb, jsonb)', 'ops.archive_template(uuid)',
    'ops.tasks_tick(timestamptz)', 'ops.works_at(uuid)', 'ops.maintenance_node(uuid)',
    'ops.raise_maintenance(uuid, text, text, text, text)',
    'ops.assign_maintenance(uuid, uuid, text)', 'ops.maintenance_to_work(uuid)',
    'ops.start_maintenance(uuid)', 'ops.close_maintenance(uuid, text, text)',
    'ops.team_of_store(uuid)', 'inv.prep_suggestions(uuid)',
    'ops.create_prep_tasks(uuid, jsonb, timestamptz, jsonb)',
    'ops.record_task_batch(uuid, numeric, text)', 'ops.report_expired(uuid, uuid, text)',
    'ops.assign_expiry(uuid, uuid, timestamptz, boolean)',
    'ops.discard_expired(uuid, numeric, text)', 'inv.expired_wastage(uuid, date, date)',
    'ops.my_to_assign()', 'ops.assignable_people(uuid)',
    'ops.can_upload_photo(text, uuid)', 'ops.maintenance_requests(uuid)',
    'ops.checklists(uuid)']::regprocedure[] loop
    execute format('revoke execute on function %s from public', f);
  end loop;
  -- what the app calls; the rest are internal to these functions
  foreach f in array array[
    'ops.occurrences(jsonb, text, timestamptz, timestamptz)',
    'ops.create_task(uuid, text, text, timestamptz, text, jsonb, jsonb, text)',
    'ops.complete_step(uuid, uuid, jsonb)', 'ops.keep_step_photo(uuid, uuid, text)',
    'ops.complete_task(uuid, text)', 'ops.cancel_task(uuid, text)', 'ops.my_tasks()',
    'ops.task_detail(uuid)', 'ops.team_tasks(uuid, date, date)', 'ops.completion(uuid, date)',
    'ops.save_template(uuid, uuid, text, jsonb, jsonb, jsonb)', 'ops.archive_template(uuid)',
    'ops.raise_maintenance(uuid, text, text, text, text)',
    'ops.assign_maintenance(uuid, uuid, text)', 'ops.start_maintenance(uuid)',
    'ops.close_maintenance(uuid, text, text)', 'inv.prep_suggestions(uuid)',
    'ops.create_prep_tasks(uuid, jsonb, timestamptz, jsonb)',
    'ops.record_task_batch(uuid, numeric, text)', 'ops.report_expired(uuid, uuid, text)',
    'ops.assign_expiry(uuid, uuid, timestamptz, boolean)',
    'ops.discard_expired(uuid, numeric, text)', 'inv.expired_wastage(uuid, date, date)',
    'ops.my_to_assign()', 'ops.assignable_people(uuid)', 'ops.team_of_store(uuid)',
    'ops.can_upload_photo(text, uuid)', 'ops.maintenance_requests(uuid)',
    'ops.checklists(uuid)']::regprocedure[] loop
    execute format('grant execute on function %s to app_rw', f);
  end loop;
end $$;
grant execute on function ops.tasks_tick(timestamptz) to wf_executor;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
do $$
declare
  v_src text := pg_get_functiondef('core.screen_places(text)'::regprocedure);
begin
  v_src := replace(v_src, '''variance'', ''production'', ''sales'', ''menu'', ''roster'', ''exceptions'', ''events'',
      ''tasks'', ''tasks_new'', ''checklists'', ''maintenance'', ''report'')',
    '''variance'', ''production'', ''sales'', ''menu'', ''roster'', ''exceptions'', ''events'')');
  v_src := regexp_replace(v_src,
    '         when p_screen in \(''tasks''.*?else ops\.works_at\(n\.id\) end\n', '');
  execute v_src;
end $$;
drop function ops.checklists(uuid), ops.maintenance_requests(uuid), ops.can_upload_photo(text, uuid), ops.link_test_batch(uuid, uuid), ops.assignable_people(uuid), ops.my_to_assign(), inv.expired_wastage(uuid, date, date),
  ops.discard_expired(uuid, numeric, text), ops.assign_expiry(uuid, uuid, timestamptz, boolean),
  ops.report_expired(uuid, uuid, text), ops.record_task_batch(uuid, numeric, text),
  ops.create_prep_tasks(uuid, jsonb, timestamptz, jsonb), inv.prep_suggestions(uuid),
  ops.team_of_store(uuid), ops.close_maintenance(uuid, text, text), ops.start_maintenance(uuid),
  ops.maintenance_to_work(uuid), ops.assign_maintenance(uuid, uuid, text),
  ops.raise_maintenance(uuid, text, text, text, text), ops.maintenance_node(uuid),
  ops.works_at(uuid), ops.tasks_tick(timestamptz), ops.archive_template(uuid),
  ops.save_template(uuid, uuid, text, jsonb, jsonb, jsonb), ops.completion(uuid, date),
  ops.team_tasks(uuid, date, date), ops.task_detail(uuid), ops.my_tasks(),
  ops.cancel_task(uuid, text), ops.complete_task(uuid, text),
  ops.keep_step_photo(uuid, uuid, text), ops.complete_step(uuid, uuid, jsonb),
  ops.create_task(uuid, text, text, timestamptz, text, jsonb, jsonb, text),
  ops.notify_task(ops.task, uuid[], text, text, text), ops.add_steps(ops.task, jsonb),
  ops.photo_ok(text, uuid, uuid, text[]), ops.settle(uuid), ops.task_to_work(uuid),
  ops.task_people(ops.task), ops.can_work(ops.task, uuid), ops.in_pool(ops.task, uuid),
  ops.occurrences(jsonb, text, timestamptz, timestamptz), ops.check_schedule(jsonb),
  ops.check_steps(jsonb), ops.check_assign(uuid, jsonb), ops.works_under(uuid, uuid),
  ops.leads(uuid, text[], uuid[]), ops.tz_of(uuid), ops.fail(text, text);
create or replace function inv.record_wastage(p_node uuid, p_lines jsonb,
                                              p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_w inv.wastage;
  v_threshold numeric;
  v_line record;
  v_cost numeric;
  v_value numeric;
  v_approval jsonb := '[]';
  v_photo_re text;
begin
  if p_idempotency_key is not null then
    select * into v_w from inv.wastage
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_w.id; end if;
  end if;
  perform inv.require('STOCK_ADJUSTMENTS', 'modify', p_node);
  perform inv.check_lines(p_lines, p_node);
  v_threshold := inv.wastage_threshold(p_node);
  v_photo_re := format('^wastage/%s/%s/[0-9a-f-]{36}\.(jpg|png|webp)$', v_me.tenant_id, p_node);

  insert into inv.wastage (tenant_id, delivery_node_id, idempotency_key)
  values (v_me.tenant_id, p_node, p_idempotency_key) returning * into v_w;

  for v_line in select * from jsonb_to_recordset(p_lines)
                  as l(item_id uuid, qty numeric, reason text, photo_key text) loop
    if v_line.qty is null or v_line.qty <= 0 then
      perform inv.fail('INVALID_QUANTITY', 'wastage quantity must be positive');
    end if;
    if v_line.reason is null
       or v_line.reason not in ('expired', 'spoiled', 'prep_error', 'damaged', 'other') then
      perform inv.fail('INVALID_LINES', 'unknown wastage reason');
    end if;
    if v_line.photo_key is not null and v_line.photo_key !~ v_photo_re then
      perform inv.fail('INVALID_PHOTO', 'photo was not uploaded for this location');
    end if;
    if inv.on_hand(v_line.item_id, p_node) < v_line.qty then
      perform inv.fail('INSUFFICIENT_STOCK', format('item %s', v_line.item_id));
    end if;
    v_cost := inv.avg_cost(v_line.item_id, p_node);
    v_value := round(v_line.qty * v_cost, 2);

    if v_value > v_threshold then
      if v_line.photo_key is null then
        perform inv.fail('PHOTO_REQUIRED', format('wastage worth %s needs a photo', v_value));
      end if;
      v_approval := v_approval || jsonb_build_object(
        'item_id', v_line.item_id, 'movement_type', 'wastage', 'qty', -v_line.qty,
        'unit_cost', v_cost, 'reason', v_line.reason, 'photo_key', v_line.photo_key);
    else
      perform inv.post(v_line.item_id, p_node, 'wastage', -v_line.qty, v_cost, 'wastage',
                       v_w.id, v_line.reason);
    end if;
    insert into inv.wastage_line (tenant_id, wastage_id, item_id, delivery_node_id, qty, reason,
                                  unit_cost, value, photo_key, outcome)
    values (v_me.tenant_id, v_w.id, v_line.item_id, p_node, v_line.qty, v_line.reason, v_cost,
            v_value, v_line.photo_key,
            case when v_value > v_threshold then 'approval' else 'posted' end);
  end loop;

  if jsonb_array_length(v_approval) > 0 then
    update inv.wastage
       set adjustment_id = inv.submit_adjustment(p_node, 'wastage', 'wastage', v_w.id, v_approval)
     where id = v_w.id;
  end if;
  return v_w.id;
end $$;
drop function inv.post_wastage(uuid, jsonb, text, uuid, uuid);
delete from core.domain_table where table_name::text in
  ('ops.checklist_template', 'ops.task', 'ops.task_step', 'ops.maintenance_request');
alter table inv.wastage_line drop column task_id;
alter table inv.production drop column task_id;
drop table ops.maintenance_request, ops.task_step, ops.task, ops.checklist_template;
