-- migrate:up
-- Rostering functions (docs/LLD.md sections 5 and 7, ADR 008).
--
-- Every function the app calls is SECURITY DEFINER and checks core.can() on the org node
-- it writes to (rule 2). Shift times are computed in the node's timezone. Assignment
-- rules live in one function, hr.assignment_violation, used by hr.assign, the candidate
-- list and shift-swap approval. Rules come from tenant config (hr.roster_rules).
-- Functions are naturally idempotent: repeating a call returns the same result.

-- ---------------------------------------------------------------------------
-- Helpers (not callable by app_rw)
-- ---------------------------------------------------------------------------

create function hr.fail(p_code text, p_detail text default null) returns void
language plpgsql as $$
begin
  raise exception '%', p_code using detail = coalesce(p_detail, '');
end $$;

-- Raises NOT_AUTHORISED unless the current user holds p_access on p_domain at p_node,
-- which must be an org node of their tenant.
create function hr.require(p_domain text, p_access text, p_node uuid) returns void
language plpgsql stable
set search_path = pg_catalog, core, hr
as $$
begin
  if p_node is null
     or not exists (select 1 from core.hierarchy_node
                     where id = p_node and type = 'org' and archived_at is null
                       and tenant_id = core.my_tenant())
     or not core.can(p_domain, p_access, p_node, null, null) then
    perform hr.fail('NOT_AUTHORISED', format('%s %s at %s', p_access, p_domain, p_node));
  end if;
end $$;

-- The node's IANA timezone (outlets store one), else the nearest ancestor's, else UTC.
create function hr.node_tz(p_node uuid) returns text
language sql stable
set search_path = pg_catalog, core, extensions
as $$
  select coalesce(
    (select a.timezone from core.hierarchy_node n
       join core.hierarchy_node a on a.path @> n.path and a.timezone is not null
      where n.id = p_node order by nlevel(a.path) desc limit 1),
    'UTC');
$$;

-- Monday of the ISO week containing p_day.
create function hr.week_start(p_day date) returns date
language sql immutable as $$
  select p_day - (extract(isodow from p_day)::int - 1);
$$;

-- The first rostering rule an assignment of p_worker to [p_start, p_end) at p_node for
-- p_role breaks, or no row. p_ignore: an assignment to leave out (the one being moved).
--   WORKER_NOT_AT_NODE  the worker's home node is another node (no cross-outlet cover)
--   ROLE_MISMATCH       the worker's role code differs from the shift's
--   SHIFT_OVERLAP       overlaps another assigned shift
--   REST_RULE           less than min_rest_hours between shifts
--   LEAVE_CONFLICT      approved leave on a local date the shift touches
--   WEEKLY_HOURS_CAP    hours in the shift's local Monday-Sunday week would pass the cap
create function hr.assignment_violation(p_worker uuid, p_start timestamptz, p_end timestamptz,
                                        p_node uuid, p_role text, p_ignore uuid default null)
returns table (code text, detail text)
language plpgsql stable
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker;
  v_rules record;
  v_tz text := hr.node_tz(p_node);
  v_first date := (p_start at time zone hr.node_tz(p_node))::date;
  v_last date := ((p_end - interval '1 microsecond') at time zone hr.node_tz(p_node))::date;
  v_week date := hr.week_start((p_start at time zone hr.node_tz(p_node))::date);
  v_hours numeric;
  v_other record;
begin
  select * into v_w from hr.worker where id = p_worker;
  if not found or v_w.status <> 'active' then
    return query select 'INVALID_WORKER'::text, 'worker not found or inactive'::text;
    return;
  end if;
  select * into v_rules from hr.roster_rules(v_w.tenant_id);

  if v_w.org_node_id <> p_node then
    return query select 'WORKER_NOT_AT_NODE'::text, 'the worker belongs to another location'::text;
    return;
  end if;
  if v_w.role_code <> p_role then
    return query select 'ROLE_MISMATCH'::text,
                        format('worker is %s, shift needs %s', v_w.role_code, p_role);
    return;
  end if;

  select a.start_at, a.end_at into v_other from hr.shift_assignment a
   where a.worker_id = p_worker and a.status = 'assigned' and a.id is distinct from p_ignore
     and a.start_at < p_end and a.end_at > p_start
   limit 1;
  if found then
    return query select 'SHIFT_OVERLAP'::text,
                        format('already on a shift %s to %s', v_other.start_at, v_other.end_at);
    return;
  end if;

  select a.start_at, a.end_at into v_other from hr.shift_assignment a
   where a.worker_id = p_worker and a.status = 'assigned' and a.id is distinct from p_ignore
     and a.start_at < p_end + make_interval(mins => (v_rules.min_rest_hours * 60)::int)
     and a.end_at > p_start - make_interval(mins => (v_rules.min_rest_hours * 60)::int)
   limit 1;
  if found then
    return query select 'REST_RULE'::text,
                        format('needs %s h rest between shifts', v_rules.min_rest_hours);
    return;
  end if;

  if exists (select 1 from hr.leave_request l
              where l.worker_id = p_worker and l.status = 'approved'
                and l.from_date <= v_last and l.to_date >= v_first) then
    return query select 'LEAVE_CONFLICT'::text, 'the worker is on approved leave'::text;
    return;
  end if;

  select coalesce(sum(extract(epoch from a.end_at - a.start_at)) / 3600, 0) into v_hours
    from hr.shift_assignment a
   where a.worker_id = p_worker and a.status = 'assigned' and a.id is distinct from p_ignore
     and (a.start_at at time zone v_tz)::date between v_week and v_week + 6;
  if v_hours + extract(epoch from p_end - p_start) / 3600 > v_rules.weekly_hours_cap then
    return query select 'WEEKLY_HOURS_CAP'::text,
                        format('%s h already this week, cap %s h', round(v_hours, 1),
                               v_rules.weekly_hours_cap);
    return;
  end if;
end $$;

-- Notifies a worker's user.
create function hr.notify_worker(p_worker uuid, p_kind text, p_title text,
                                 p_body text default null, p_link text default null)
returns void
language sql
set search_path = pg_catalog, hr, ops
as $$
  select ops.notify(w.tenant_id, w.owner_user_id, p_kind, p_title, p_body, p_link)
    from hr.worker w where w.id = p_worker;
$$;

revoke execute on function hr.fail(text, text), hr.require(text, text, uuid), hr.node_tz(uuid),
  hr.week_start(date), hr.assignment_violation(uuid, timestamptz, timestamptz, uuid, text, uuid),
  hr.notify_worker(uuid, text, text, text, text)
  from public;

-- ---------------------------------------------------------------------------
-- Functions for the app
-- ---------------------------------------------------------------------------

-- Creates the draft shifts of a node-week (Monday p_week_start) from its active templates.
-- Existing template shifts are kept. Returns the number created.
create function hr.generate_week(p_node uuid, p_week_start date) returns int
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_tz text;
  v_count int;
begin
  perform hr.require('ROSTER', 'modify', p_node);
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    perform hr.fail('INVALID_WEEK', 'weeks start on a Monday');
  end if;
  v_tz := hr.node_tz(p_node);
  insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                        role_code, headcount)
  select t.tenant_id, t.org_node_id, t.id, d.day,
         (d.day + t.start_time) at time zone v_tz,
         (d.day + case when t.end_time > t.start_time then 0 else 1 end + t.end_time) at time zone v_tz,
         t.role_code, t.headcount
    from hr.shift_template t
   cross join lateral (select p_week_start + i as day from generate_series(0, 6) i) d
   where t.org_node_id = p_node and t.archived_at is null
     and extract(isodow from d.day)::int = any (t.weekdays)
  on conflict (template_id, local_date) where template_id is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Assigns a worker to a shift after every rostering rule passes. Returns the assignment.
-- Already assigned: returns the existing assignment. Published shifts notify the worker.
create function hr.assign(p_shift uuid, p_worker uuid) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_shift hr.shift;
  v_w hr.worker;
  v_id uuid;
  v_bad record;
begin
  select * into v_shift from hr.shift where id = p_shift and tenant_id = core.my_tenant() for update;
  if not found then
    perform hr.fail('NOT_FOUND', 'shift');
  end if;
  perform hr.require('ROSTER', 'modify', v_shift.org_node_id);
  if v_shift.status = 'cancelled' then
    perform hr.fail('INVALID_STATE', 'shift is cancelled');
  end if;
  if v_shift.start_at <= now() then
    perform hr.fail('SHIFT_STARTED', 'the shift has started');
  end if;
  select * into v_w from hr.worker where id = p_worker and tenant_id = v_shift.tenant_id;
  if not found then
    perform hr.fail('INVALID_WORKER', 'worker not found');
  end if;
  -- serialise every roster change for this worker (rest and weekly-hours rules)
  perform pg_advisory_xact_lock(hashtextextended('hr.worker:' || p_worker, 0));

  select id into v_id from hr.shift_assignment
   where shift_id = p_shift and worker_id = p_worker and status = 'assigned';
  if found then
    return v_id;
  end if;
  if (select count(*) from hr.shift_assignment
       where shift_id = p_shift and status = 'assigned') >= v_shift.headcount then
    perform hr.fail('SHIFT_FULL', format('headcount %s reached', v_shift.headcount));
  end if;
  select * into v_bad from hr.assignment_violation(p_worker, v_shift.start_at, v_shift.end_at,
                                                    v_shift.org_node_id, v_shift.role_code);
  if v_bad.code is not null then
    perform hr.fail(v_bad.code, v_bad.detail);
  end if;

  insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                   start_at, end_at)
  values (v_shift.tenant_id, p_shift, p_worker, v_w.owner_user_id, v_shift.org_node_id,
          v_shift.start_at, v_shift.end_at)
  returning id into v_id;
  if v_shift.status = 'published' then
    perform hr.notify_worker(p_worker, 'roster_changed', 'New shift added',
      to_char(v_shift.start_at at time zone hr.node_tz(v_shift.org_node_id), 'Dy DD Mon HH24:MI'),
      '/roster/my');
  end if;
  return v_id;
end $$;

-- Removes a worker from a shift. Published shifts notify the worker.
create function hr.unassign(p_assignment uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_a hr.shift_assignment;
  v_shift hr.shift;
begin
  select * into v_a from hr.shift_assignment
   where id = p_assignment and tenant_id = core.my_tenant() for update;
  if not found then
    perform hr.fail('NOT_FOUND', 'assignment');
  end if;
  perform hr.require('ROSTER', 'modify', v_a.org_node_id);
  if v_a.status <> 'assigned' then
    return;
  end if;
  select * into v_shift from hr.shift where id = v_a.shift_id;
  if v_shift.start_at <= now() then
    perform hr.fail('SHIFT_STARTED', 'the shift has started');
  end if;
  update hr.shift_assignment set status = 'dropped', drop_reason = 'unassigned'
   where id = p_assignment;
  if v_shift.status = 'published' then
    perform hr.notify_worker(v_a.worker_id, 'roster_changed', 'Shift removed',
      to_char(v_shift.start_at at time zone hr.node_tz(v_shift.org_node_id), 'Dy DD Mon HH24:MI'),
      '/roster/my');
  end if;
end $$;

-- Publishes every draft shift of the node-week and notifies each assigned worker once.
-- Returns the number of shifts published.
create function hr.publish_week(p_node uuid, p_week_start date) returns int
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_ids uuid[];
begin
  perform hr.require('ROSTER', 'modify', p_node);
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    perform hr.fail('INVALID_WEEK', 'weeks start on a Monday');
  end if;
  with p as (
    update hr.shift set status = 'published', published_at = now()
     where org_node_id = p_node and status = 'draft'
       and local_date between p_week_start and p_week_start + 6
    returning id)
  select coalesce(array_agg(id), '{}') into v_ids from p;
  perform hr.notify_worker(w.worker_id, 'roster_published', 'Your roster is published',
                           'Week of ' || to_char(p_week_start, 'DD Mon'), '/roster/my')
     from (select distinct worker_id from hr.shift_assignment
            where shift_id = any (v_ids) and status = 'assigned') w;
  return cardinality(v_ids);
end $$;

-- Workers a manager could assign to a shift: active workers at the shift's node with its
-- role, each with the first rule they would break (null = assignable) and their hours
-- that week. Needs ROSTER modify at the node.
create function hr.assign_candidates(p_shift uuid)
returns table (worker_id uuid, display_name text, violation text, violation_detail text,
               week_hours numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_shift hr.shift;
  v_tz text;
  v_week date;
begin
  select * into v_shift from hr.shift where id = p_shift and tenant_id = core.my_tenant();
  if not found then
    perform hr.fail('NOT_FOUND', 'shift');
  end if;
  perform hr.require('ROSTER', 'modify', v_shift.org_node_id);
  v_tz := hr.node_tz(v_shift.org_node_id);
  v_week := hr.week_start(v_shift.local_date);
  return query
    select w.id, u.display_name, v.code, v.detail,
           round(coalesce((select sum(extract(epoch from a.end_at - a.start_at)) / 3600
                             from hr.shift_assignment a
                            where a.worker_id = w.id and a.status = 'assigned'
                              and (a.start_at at time zone v_tz)::date between v_week and v_week + 6), 0), 1)
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
      left join lateral hr.assignment_violation(w.id, v_shift.start_at, v_shift.end_at,
                                                v_shift.org_node_id, v_shift.role_code) v on true
     where w.org_node_id = v_shift.org_node_id and w.role_code = v_shift.role_code
       and w.status = 'active'
       and not exists (select 1 from hr.shift_assignment a
                        where a.shift_id = p_shift and a.worker_id = w.id and a.status = 'assigned')
     order by v.code nulls first, u.display_name;
end $$;

revoke execute on function hr.generate_week(uuid, date), hr.assign(uuid, uuid),
  hr.unassign(uuid), hr.publish_week(uuid, date), hr.assign_candidates(uuid) from public;
grant execute on function hr.generate_week(uuid, date), hr.assign(uuid, uuid),
  hr.unassign(uuid), hr.publish_week(uuid, date), hr.assign_candidates(uuid) to app_rw;

-- migrate:down
drop function hr.assign_candidates(uuid);
drop function hr.publish_week(uuid, date);
drop function hr.unassign(uuid);
drop function hr.assign(uuid, uuid);
drop function hr.generate_week(uuid, date);
drop function hr.notify_worker(uuid, text, text, text, text);
drop function hr.assignment_violation(uuid, timestamptz, timestamptz, uuid, text, uuid);
drop function hr.week_start(date);
drop function hr.node_tz(uuid);
drop function hr.require(text, text, uuid);
drop function hr.fail(text, text);
