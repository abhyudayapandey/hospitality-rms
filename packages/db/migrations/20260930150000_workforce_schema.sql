-- migrate:up
-- Workforce: people, rostering, attendance, leave, shift swaps, role changes, events and
-- in-app notifications (docs/LLD.md sections 2 and 5, ADR 008). Business functions are
-- in the following migrations. Every table here:
--   * has the standard columns, the audit trigger and generated RLS (rules 1 and 5)
--   * is read-only for app_rw (rpc_only): writes go through SECURITY DEFINER functions
--     that check core.can() (rule 2) or through the executor (rule 4)
-- Self-service rows carry owner_user_id (the worker's app user) for the SELF leg.

-- ---------------------------------------------------------------------------
-- Config
-- ---------------------------------------------------------------------------

-- Role codes used by workers, shift templates and shifts (catalogue).
create table hr.job_role (
  id uuid primary key default core.uuid_v7(),
  code text not null check (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null,
  archived_at timestamptz
);
select core.add_standard_columns('hr.job_role');
alter table hr.job_role add constraint job_role_code_key unique (tenant_id, code);

-- Rostering rules per tenant. No row = the defaults.
create table hr.roster_setting (
  id uuid primary key default core.uuid_v7(),
  min_rest_hours numeric(4,1) not null default 10 check (min_rest_hours between 0 and 24),
  weekly_hours_cap numeric(5,1) not null default 48 check (weekly_hours_cap > 0 and weekly_hours_cap <= 168),
  late_threshold_min int not null default 10 check (late_threshold_min between 0 and 240)
);
select core.add_standard_columns('hr.roster_setting');
alter table hr.roster_setting add constraint roster_setting_tenant_key unique (tenant_id);

-- The tenant's rostering rules, with defaults when no row exists.
create function hr.roster_rules(p_tenant uuid,
                                out min_rest_hours numeric, out weekly_hours_cap numeric,
                                out late_threshold_min int)
language sql stable security definer
set search_path = pg_catalog, hr
as $$
  select coalesce(s.min_rest_hours, 10), coalesce(s.weekly_hours_cap, 48),
         coalesce(s.late_threshold_min, 10)
    from (select 1) one
    left join hr.roster_setting s on s.tenant_id = p_tenant;
$$;
revoke execute on function hr.roster_rules(uuid) from public;

-- Geofence per org node (outlets, sites). No row, or no coordinates = no geofence check.
create table hr.node_setting (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  latitude numeric(9,6) check (latitude between -90 and 90),
  longitude numeric(9,6) check (longitude between -180 and 180),
  geofence_radius_m int not null default 150 check (geofence_radius_m between 10 and 5000),
  check ((latitude is null) = (longitude is null))
);
select core.add_standard_columns('hr.node_setting');
alter table hr.node_setting add constraint node_setting_key unique (tenant_id, org_node_id);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

-- One worker per app user. The name is core.app_user.display_name.
create table hr.worker (
  id uuid primary key default core.uuid_v7(),
  owner_user_id uuid not null references core.app_user(id),
  org_node_id uuid not null references core.hierarchy_node(id),   -- home node
  role_code text not null,
  employment_type text not null default 'full_time'
    check (employment_type in ('full_time', 'part_time', 'casual')),
  joined_on date,
  status text not null default 'active' check (status in ('active', 'inactive'))
);
select core.add_standard_columns('hr.worker');
alter table hr.worker
  add constraint worker_user_key unique (tenant_id, owner_user_id),
  add constraint worker_role_fk foreign key (tenant_id, role_code)
    references hr.job_role (tenant_id, code);
create index worker_node on hr.worker (org_node_id);

-- Sensitive worker data (COMPENSATION), audited names_only. Data minimisation (DPDP,
-- ADR 008): only an optional pay rate for the MVP; bank and ID references come with
-- the payroll export in Phase 2.
create table hr.worker_sensitive (
  id uuid primary key default core.uuid_v7(),
  worker_id uuid not null references hr.worker(id),
  owner_user_id uuid not null references core.app_user(id),
  org_node_id uuid not null references core.hierarchy_node(id),
  pay_rate numeric(14,2) check (pay_rate >= 0),
  pay_basis text check (pay_basis in ('hourly', 'monthly')),
  currency text not null default 'INR',
  check ((pay_rate is null) = (pay_basis is null))
);
select core.add_standard_columns('hr.worker_sensitive');
alter table hr.worker_sensitive add constraint worker_sensitive_worker_key unique (worker_id);

-- ---------------------------------------------------------------------------
-- Rostering
-- ---------------------------------------------------------------------------

create table hr.shift_template (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  name text not null,
  role_code text not null,
  start_time time not null,          -- local time at the node
  end_time time not null,            -- earlier than start_time = ends the next day
  headcount int not null default 1 check (headcount between 1 and 50),
  weekdays int[] not null default '{1,2,3,4,5,6,7}'   -- ISO: 1 = Monday
    check (weekdays <@ '{1,2,3,4,5,6,7}' and cardinality(weekdays) > 0),
  archived_at timestamptz,
  check (start_time <> end_time)
);
select core.add_standard_columns('hr.shift_template');
alter table hr.shift_template add constraint shift_template_role_fk
  foreign key (tenant_id, role_code) references hr.job_role (tenant_id, code);
create index shift_template_node on hr.shift_template (org_node_id);

create table hr.shift (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  template_id uuid references hr.shift_template(id),
  local_date date not null,          -- the node-local date the shift starts on
  start_at timestamptz not null,
  end_at timestamptz not null,
  role_code text not null,
  headcount int not null default 1 check (headcount between 1 and 50),
  status text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  published_at timestamptz,
  check (end_at > start_at and end_at - start_at <= interval '16 hours')
);
select core.add_standard_columns('hr.shift');
alter table hr.shift add constraint shift_role_fk
  foreign key (tenant_id, role_code) references hr.job_role (tenant_id, code);
create unique index shift_template_day on hr.shift (template_id, local_date)
  where template_id is not null;
create index shift_node_date on hr.shift (org_node_id, local_date);

-- start_at/end_at are copied from the shift for the rest/overlap/cap checks.
create table hr.shift_assignment (
  id uuid primary key default core.uuid_v7(),
  shift_id uuid not null references hr.shift(id),
  worker_id uuid not null references hr.worker(id),
  owner_user_id uuid not null references core.app_user(id),
  org_node_id uuid not null references core.hierarchy_node(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'assigned' check (status in ('assigned', 'swapped', 'dropped')),
  drop_reason text check (drop_reason in ('unassigned', 'leave', 'swap', 'shift_cancelled')),
  leave_request_id uuid,             -- the approved leave that dropped it
  swap_id uuid,                      -- the approved swap that moved it
  check ((status = 'assigned') = (drop_reason is null))
);
select core.add_standard_columns('hr.shift_assignment');
create unique index shift_assignment_active on hr.shift_assignment (shift_id, worker_id)
  where status = 'assigned';
create index shift_assignment_worker on hr.shift_assignment (worker_id, start_at)
  where status = 'assigned';
create index shift_assignment_shift on hr.shift_assignment (shift_id);

-- ---------------------------------------------------------------------------
-- Leave
-- ---------------------------------------------------------------------------

create table hr.leave_type (
  id uuid primary key default core.uuid_v7(),
  code text not null check (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null,
  annual_days numeric(5,1) check (annual_days >= 0),   -- null = unpaid, no balance
  archived_at timestamptz
);
select core.add_standard_columns('hr.leave_type');
alter table hr.leave_type add constraint leave_type_code_key unique (tenant_id, code);

create table hr.leave_balance (
  id uuid primary key default core.uuid_v7(),
  worker_id uuid not null references hr.worker(id),
  owner_user_id uuid not null references core.app_user(id),
  org_node_id uuid not null references core.hierarchy_node(id),
  leave_type_id uuid not null references hr.leave_type(id),
  year int not null check (year between 2000 and 2100),
  entitled_days numeric(5,1) not null check (entitled_days >= 0),
  used_days numeric(5,1) not null default 0 check (used_days >= 0)
);
select core.add_standard_columns('hr.leave_balance');
alter table hr.leave_balance
  add constraint leave_balance_key unique (worker_id, leave_type_id, year);

-- Days are calendar days, inclusive, for the MVP (ADR 008).
create table hr.leave_request (
  id uuid primary key default core.uuid_v7(),
  worker_id uuid not null references hr.worker(id),
  owner_user_id uuid not null references core.app_user(id),
  org_node_id uuid not null references core.hierarchy_node(id),
  leave_type_id uuid not null references hr.leave_type(id),
  from_date date not null,
  to_date date not null,
  days numeric(5,1) not null check (days > 0),
  reason text check (length(reason) <= 500),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'cancelled')),
  wf_request_id uuid references wf.request(id),
  decided_at timestamptz,
  check (to_date >= from_date and extract(year from from_date) = extract(year from to_date))
);
select core.add_standard_columns('hr.leave_request');
create index leave_request_worker on hr.leave_request (worker_id, from_date);

-- ---------------------------------------------------------------------------
-- Shift swaps: A (owner) hands a published shift to B; B accepting submits SHIFT_SWAP
-- ---------------------------------------------------------------------------

create table hr.shift_swap (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  owner_user_id uuid not null references core.app_user(id),    -- A
  assignment_id uuid not null references hr.shift_assignment(id),
  shift_id uuid not null references hr.shift(id),
  from_worker_id uuid not null references hr.worker(id),
  to_worker_id uuid not null references hr.worker(id),
  to_user_id uuid not null references core.app_user(id),       -- B
  note text check (length(note) <= 500),
  status text not null default 'proposed' check (status in
    ('proposed', 'declined', 'withdrawn', 'submitted', 'approved', 'rejected', 'cancelled')),
  wf_request_id uuid references wf.request(id),
  responded_at timestamptz,
  decided_at timestamptz,
  new_assignment_id uuid references hr.shift_assignment(id),
  check (from_worker_id <> to_worker_id)
);
select core.add_standard_columns('hr.shift_swap');
create index shift_swap_to_user on hr.shift_swap (to_user_id, status);
create unique index shift_swap_open on hr.shift_swap (assignment_id)
  where status in ('proposed', 'submitted');

-- ---------------------------------------------------------------------------
-- Role changes (ROLE_CHANGE subject): grant a new assignment or end an existing one
-- ---------------------------------------------------------------------------

create table hr.role_change (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),  -- routing and RLS
  action text not null check (action in ('grant', 'end')),
  target_user_id uuid not null references core.app_user(id),
  group_id uuid not null references core.security_group(id),
  node_id uuid not null references core.hierarchy_node(id),      -- either tree
  include_descendants boolean not null default true,
  effective_from date not null,
  effective_to date,
  assignment_id uuid references core.role_assignment(id),        -- for 'end'
  reason text check (length(reason) <= 500),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'applied', 'rejected', 'cancelled')),
  wf_request_id uuid references wf.request(id),
  applied_assignment_id uuid references core.role_assignment(id),
  check (effective_to is null or effective_to >= effective_from),
  check ((action = 'end') = (assignment_id is not null)),
  check (action = 'grant' or effective_to is not null)
);
select core.add_standard_columns('hr.role_change');

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------

-- Raw coordinates are kept 90 days, then nulled by the nightly job; distance and the
-- inside/outside flag stay (ADR 008, DPDP).
create table hr.attendance (
  id uuid primary key default core.uuid_v7(),
  worker_id uuid not null references hr.worker(id),
  owner_user_id uuid not null references core.app_user(id),
  org_node_id uuid not null references core.hierarchy_node(id),
  shift_id uuid references hr.shift(id),
  clock_in_at timestamptz not null,
  clock_out_at timestamptz,
  in_source text not null check (in_source in ('online', 'offline')),
  out_source text check (out_source in ('online', 'offline')),
  in_received_at timestamptz not null default now(),
  out_received_at timestamptz,
  in_key text not null,
  out_key text,
  in_lat numeric(9,6), in_lng numeric(9,6), in_accuracy_m numeric(8,1),
  in_distance_m numeric(10,1), in_inside boolean,          -- null = no location or no fence
  out_lat numeric(9,6), out_lng numeric(9,6), out_accuracy_m numeric(8,1),
  out_distance_m numeric(10,1), out_inside boolean,
  geo_purged_at timestamptz,
  check (clock_out_at is null or clock_out_at >= clock_in_at),
  check ((clock_out_at is null) = (out_source is null))
);
select core.add_standard_columns('hr.attendance');
alter table hr.attendance
  add constraint attendance_in_key unique (worker_id, in_key),
  add constraint attendance_out_key unique (worker_id, out_key);
create index attendance_worker on hr.attendance (worker_id, clock_in_at);
create index attendance_node on hr.attendance (org_node_id, clock_in_at);
create unique index attendance_open on hr.attendance (worker_id) where clock_out_at is null;

create table hr.attendance_exception (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  worker_id uuid not null references hr.worker(id),
  owner_user_id uuid not null references core.app_user(id),
  shift_id uuid references hr.shift(id),
  attendance_id uuid references hr.attendance(id),
  local_date date not null,
  kind text not null check (kind in
    ('late', 'no_show', 'missing_clock_out', 'unscheduled', 'outside_geofence', 'no_location')),
  phase text check (phase in ('in', 'out')),
  detail jsonb not null default '{}',
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolution_note text check (length(resolution_note) <= 500),
  resolved_by uuid references core.app_user(id),
  resolved_at timestamptz,
  check (shift_id is not null or attendance_id is not null),
  check ((status = 'open') = (resolved_at is null))
);
select core.add_standard_columns('hr.attendance_exception');
alter table hr.attendance_exception add constraint attendance_exception_key
  unique nulls not distinct (kind, phase, shift_id, attendance_id);
create index attendance_exception_open on hr.attendance_exception (org_node_id, local_date)
  where status = 'open';

-- ---------------------------------------------------------------------------
-- Events (org tree)
-- ---------------------------------------------------------------------------

create table ops.event (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  name text not null check (length(name) between 1 and 200),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  covers int not null default 0 check (covers between 0 and 100000),
  status text not null default 'planned' check (status in ('planned', 'confirmed', 'cancelled')),
  notes text check (length(notes) <= 2000),
  idempotency_key text,
  check (ends_at > starts_at)
);
select core.add_standard_columns('ops.event');
alter table ops.event add constraint event_idempotency_key unique (tenant_id, created_by, idempotency_key);
create index event_node_start on ops.event (org_node_id, starts_at);

-- Stored for the EVENT_UPLIFT signal (LLD section 6): items with quantities, roles with
-- headcount and a time window.
create table ops.event_requirement (
  id uuid primary key default core.uuid_v7(),
  event_id uuid not null references ops.event(id),
  org_node_id uuid not null references core.hierarchy_node(id),
  kind text not null check (kind in ('item', 'role')),
  item_id uuid references inv.item(id),
  qty numeric(14,3) check (qty > 0),
  role_code text,
  headcount int check (headcount between 1 and 500),
  starts_at timestamptz,
  ends_at timestamptz,
  notes text check (length(notes) <= 500),
  archived_at timestamptz,
  check ((kind = 'item' and item_id is not null and qty is not null and role_code is null
          and headcount is null and starts_at is null and ends_at is null)
      or (kind = 'role' and role_code is not null and headcount is not null
          and starts_at is not null and ends_at > starts_at
          and item_id is null and qty is null))
);
select core.add_standard_columns('ops.event_requirement');
alter table ops.event_requirement add constraint event_requirement_role_fk
  foreign key (tenant_id, role_code) references hr.job_role (tenant_id, code);
create index event_requirement_event on ops.event_requirement (event_id);

-- ---------------------------------------------------------------------------
-- In-app notifications (owner only; web push is Phase 2)
-- ---------------------------------------------------------------------------

create table ops.notification (
  id uuid primary key default core.uuid_v7(),
  owner_user_id uuid not null references core.app_user(id),
  kind text not null,
  title text not null,
  body text,
  link text check (link is null or link ~ '^/[A-Za-z0-9/_?=&.-]*$'),
  read_at timestamptz
);
select core.add_standard_columns('ops.notification');
create index notification_owner on ops.notification (owner_user_id, created_at desc);
create index notification_unread on ops.notification (owner_user_id) where read_at is null;

-- Adds a notification (module functions and the executor call this).
create function ops.notify(p_tenant uuid, p_user uuid, p_kind text, p_title text,
                           p_body text default null, p_link text default null) returns void
language sql security definer
set search_path = pg_catalog, ops
as $$
  insert into ops.notification (tenant_id, owner_user_id, kind, title, body, link)
  values (p_tenant, p_user, p_kind, p_title, p_body, p_link);
$$;
revoke execute on function ops.notify(uuid, uuid, text, text, text, text) from public;

-- ---------------------------------------------------------------------------
-- Same-tenant checks for rows that join tenant-scoped records (ADR 003)
-- ---------------------------------------------------------------------------

-- Every referenced node, user, worker and group must be in the row's tenant.
create function hr.check_same_tenant() returns trigger
language plpgsql
set search_path = pg_catalog, core, hr
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_bad text;
begin
  select string_agg(c.col, ', ') into v_bad
    from (values ('org_node_id', 'node'), ('node_id', 'node'),
                 ('owner_user_id', 'user'), ('target_user_id', 'user'), ('to_user_id', 'user'),
                 ('worker_id', 'worker'), ('from_worker_id', 'worker'), ('to_worker_id', 'worker'),
                 ('group_id', 'group')) c(col, kind)
   where v_row ? c.col and v_row ->> c.col is not null
     and not exists (
       select 1 where
         (c.kind = 'node' and exists (select 1 from core.hierarchy_node
                                       where id = (v_row ->> c.col)::uuid and tenant_id = new.tenant_id))
      or (c.kind = 'user' and exists (select 1 from core.app_user
                                       where id = (v_row ->> c.col)::uuid and tenant_id = new.tenant_id))
      or (c.kind = 'worker' and exists (select 1 from hr.worker
                                         where id = (v_row ->> c.col)::uuid and tenant_id = new.tenant_id))
      or (c.kind = 'group' and exists (select 1 from core.security_group
                                        where id = (v_row ->> c.col)::uuid and tenant_id = new.tenant_id)));
  if v_bad is not null then
    raise exception 'TENANT_MISMATCH'
      using detail = format('%s.%s: %s not in tenant %s', tg_table_schema, tg_table_name, v_bad,
                            new.tenant_id);
  end if;
  return new;
end $$;
revoke execute on function hr.check_same_tenant() from public;

-- ---------------------------------------------------------------------------
-- RLS registration (rule 1), audit (rule 5), tenant checks
-- ---------------------------------------------------------------------------

insert into core.domain_table (table_name, domain_code, hierarchy_type, catalog, rpc_only) values
  ('hr.job_role', 'ROSTER', 'org', true, true),
  ('hr.leave_type', 'LEAVE', 'org', true, true);
insert into core.domain_table (table_name, domain_code, hierarchy_type, tenant_scoped, rpc_only) values
  ('hr.roster_setting', 'ROSTER', 'org', true, true);
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('hr.node_setting', 'ATTENDANCE', 'org', true),
  ('hr.worker', 'WORKERS', 'org', true),
  ('hr.worker_sensitive', 'COMPENSATION', 'org', true),
  ('hr.shift_template', 'ROSTER', 'org', true),
  ('hr.shift', 'ROSTER', 'org', true),
  ('hr.shift_assignment', 'ROSTER', 'org', true),
  ('hr.leave_balance', 'LEAVE', 'org', true),
  ('hr.leave_request', 'LEAVE', 'org', true),
  ('hr.shift_swap', 'SHIFT_SWAPS', 'org', true),
  ('hr.role_change', 'SECURITY_ROLES', 'org', true),
  ('hr.attendance', 'ATTENDANCE', 'org', true),
  ('hr.attendance_exception', 'ATTENDANCE', 'org', true),
  ('ops.event', 'EVENTS', 'org', true),
  ('ops.event_requirement', 'EVENTS', 'org', true),
  ('ops.notification', 'NOTIFICATIONS', 'self', true);

do $$
declare t regclass;
begin
  for t in select table_name from core.domain_table
            where table_name::text like 'hr.%' or table_name::text like 'ops.%' loop
    perform core.apply_domain_rls(t);
    perform audit.enable(t, t = 'hr.worker_sensitive'::regclass);
    if core.has_column(t, 'org_node_id') or core.has_column(t, 'owner_user_id') then
      execute format('create trigger same_tenant before insert or update on %s
                        for each row execute function hr.check_same_tenant()', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Worker directory: names for swap partners without WORKERS access
-- ---------------------------------------------------------------------------

-- Display name, role code and org node of active workers at nodes where the caller has
-- ROSTER view (the ADR 007 node set, from core.can()), plus the caller's own row.
-- Deliberately not security_invoker: it reads hr.worker and core.app_user as the
-- owner and exposes only these three fields (tested in workforce-schema.db.test.ts).
create view hr.worker_directory with (security_barrier = true) as
  select w.id as worker_id, u.display_name, w.role_code, w.org_node_id
    from hr.worker w
    join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
   where w.status = 'active'
     and w.tenant_id = (select core.my_tenant())
     and (w.org_node_id = any ((select core.visible_nodes('ROSTER', 'view'))::uuid[])
          or (w.owner_user_id = core.current_user_id()
              and core.can('ROSTER', 'view', null, null, w.owner_user_id)));
revoke all on hr.worker_directory from public;
grant select on hr.worker_directory to app_rw;

-- ---------------------------------------------------------------------------
-- Workflow subject resolvers. Self-service subjects are submittable only by their
-- owner (LEAVE) or the swap partner (SHIFT_SWAP): wf.submit passes the caller as the
-- owner to core.can(), so ownership is checked here (ADR 008).
-- ---------------------------------------------------------------------------

create function hr.leave_subject(p_id uuid) returns wf.subject_info
language sql stable
set search_path = pg_catalog, hr, core
as $$
  select tenant_id, org_node_id, null::uuid, null::uuid, null::uuid, null::numeric, null::text,
         status = 'draft' and wf_request_id is null and owner_user_id = core.current_user_id()
    from hr.leave_request where id = p_id;
$$;

create function hr.swap_subject(p_id uuid) returns wf.subject_info
language sql stable
set search_path = pg_catalog, hr, core
as $$
  select tenant_id, org_node_id, null::uuid, null::uuid, null::uuid, null::numeric, null::text,
         status = 'proposed' and wf_request_id is null and to_user_id = core.current_user_id()
    from hr.shift_swap where id = p_id;
$$;

-- Neither party of a swap approves it.
create function hr.swap_excluded(p_id uuid) returns uuid[]
language sql stable
set search_path = pg_catalog, hr
as $$
  select array[owner_user_id, to_user_id] from hr.shift_swap where id = p_id;
$$;

create function hr.role_change_subject(p_id uuid) returns wf.subject_info
language sql stable
set search_path = pg_catalog, hr, core
as $$
  select tenant_id, org_node_id, null::uuid, null::uuid, null::uuid, null::numeric, null::text,
         status = 'draft' and wf_request_id is null and created_by = core.current_user_id()
    from hr.role_change where id = p_id;
$$;

-- The person whose access changes does not approve it.
create function hr.role_change_excluded(p_id uuid) returns uuid[]
language sql stable
set search_path = pg_catalog, hr
as $$
  select array[target_user_id] from hr.role_change where id = p_id;
$$;

revoke execute on function hr.leave_subject(uuid), hr.swap_subject(uuid),
  hr.swap_excluded(uuid), hr.role_change_subject(uuid), hr.role_change_excluded(uuid)
  from public;

insert into core.subject_resolver (subject_type, resolver, excluded_resolver) values
  ('hr.leave_request', 'hr.leave_subject(uuid)', null),
  ('hr.shift_swap', 'hr.swap_subject(uuid)', 'hr.swap_excluded(uuid)'),
  ('hr.role_change', 'hr.role_change_subject(uuid)', 'hr.role_change_excluded(uuid)');

grant usage on schema hr, ops to app_rw, wf_executor;

-- migrate:down
delete from core.subject_resolver
 where subject_type in ('hr.leave_request', 'hr.shift_swap', 'hr.role_change');
drop function hr.leave_subject(uuid);
drop function hr.swap_subject(uuid);
drop function hr.swap_excluded(uuid);
drop function hr.role_change_subject(uuid);
drop function hr.role_change_excluded(uuid);
drop view hr.worker_directory;
delete from core.domain_table
 where table_name::text like 'hr.%' or table_name::text like 'ops.%';
drop table ops.notification, ops.event_requirement, ops.event,
  hr.attendance_exception, hr.attendance, hr.role_change, hr.shift_swap, hr.leave_request,
  hr.leave_balance, hr.leave_type, hr.shift_assignment, hr.shift, hr.shift_template,
  hr.worker_sensitive, hr.worker, hr.node_setting, hr.roster_setting, hr.job_role;
drop function ops.notify(uuid, uuid, text, text, text, text);
drop function hr.check_same_tenant();
drop function hr.roster_rules(uuid);
