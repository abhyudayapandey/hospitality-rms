-- migrate:up

-- Rest and weekly hours become warnings (ADR 019). The other rostering rules still block.
-- A shift swap no longer stops the person offering or the colleague accepting on a
-- warning; the approver sees the warnings and approves past the ones they name, or assigns
-- the shift to someone else directly. A manager assigning a shift can do the same.

alter table hr.shift_assignment
  add column warnings_accepted text[] not null default '{}';   -- warnings assigned past
alter table hr.shift_swap
  add column warnings_accepted text[] not null default '{}',
  add column reassigned_worker_id uuid references hr.worker(id);
alter table hr.shift_swap drop constraint shift_swap_status_check;
alter table hr.shift_swap add constraint shift_swap_status_check check (status in
  ('proposed', 'declined', 'withdrawn', 'submitted', 'approved', 'rejected', 'cancelled',
   'reassigned'));

-- Every rostering rule an assignment of p_worker to [p_start, p_end) at p_node for p_role
-- breaks, in this order. warning = true for rest and weekly hours.
--   INVALID_WORKER, WORKER_NOT_AT_NODE, ROLE_MISMATCH   (stop here; nothing else applies)
--   SHIFT_OVERLAP, LEAVE_CONFLICT                       blocking
--   REST_RULE, WEEKLY_HOURS_CAP                         warnings
-- The details are worded for "<name> would have ...".
create function hr.assignment_checks(p_worker uuid, p_start timestamptz, p_end timestamptz,
                                     p_node uuid, p_role text, p_ignore uuid default null)
returns table (code text, detail text, warning boolean)
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
  v_rest interval := interval '0';
  v_gap numeric;
  v_hours numeric;
  v_other record;
begin
  select * into v_w from hr.worker where id = p_worker;
  if not found or v_w.status <> 'active' then
    return query select 'INVALID_WORKER'::text, 'worker not found or inactive'::text, false;
    return;
  end if;
  select * into v_rules from hr.roster_rules(v_w.tenant_id);
  v_rest := make_interval(mins => (v_rules.min_rest_hours * 60)::int);

  if not hr.works_under(v_w.org_node_id, p_node) then
    return query select 'WORKER_NOT_AT_NODE'::text, 'the worker belongs to another location'::text,
                        false;
    return;
  end if;
  if v_w.role_code <> p_role then
    return query select 'ROLE_MISMATCH'::text,
                        format('worker is %s, shift needs %s', v_w.role_code, p_role), false;
    return;
  end if;

  select a.start_at, a.end_at into v_other from hr.shift_assignment a
   where a.worker_id = p_worker and a.status = 'assigned' and a.id is distinct from p_ignore
     and a.start_at < p_end and a.end_at > p_start
   limit 1;
  if found then
    return query select 'SHIFT_OVERLAP'::text,
                        format('already on a shift %s to %s', v_other.start_at, v_other.end_at),
                        false;
  end if;

  if exists (select 1 from hr.leave_request l
              where l.worker_id = p_worker and l.status = 'approved'
                and l.from_date <= v_last and l.to_date >= v_first) then
    return query select 'LEAVE_CONFLICT'::text, 'the worker is on approved leave'::text, false;
  end if;

  -- the shortest gap to a shift that doesn't overlap this one
  select min(extract(epoch from case when a.end_at <= p_start then p_start - a.end_at
                                     else a.start_at - p_end end)) / 3600
    into v_gap
    from hr.shift_assignment a
   where a.worker_id = p_worker and a.status = 'assigned' and a.id is distinct from p_ignore
     and a.start_at < p_end + v_rest and a.end_at > p_start - v_rest
     and not (a.start_at < p_end and a.end_at > p_start);
  if v_gap is not null then
    return query select 'REST_RULE'::text,
                        format('would have %s h rest between shifts (needs %s h)',
                               trim_scale(round(v_gap, 1)), trim_scale(v_rules.min_rest_hours)),
                        true;
  end if;

  select coalesce(sum(extract(epoch from a.end_at - a.start_at)) / 3600, 0) into v_hours
    from hr.shift_assignment a
   where a.worker_id = p_worker and a.status = 'assigned' and a.id is distinct from p_ignore
     and (a.start_at at time zone v_tz)::date between v_week and v_week + 6;
  v_hours := v_hours + extract(epoch from p_end - p_start) / 3600;
  if v_hours > v_rules.weekly_hours_cap then
    return query select 'WEEKLY_HOURS_CAP'::text,
                        format('would have %s h this week (limit %s h)',
                               trim_scale(round(v_hours, 1)),
                               trim_scale(v_rules.weekly_hours_cap)),
                        true;
  end if;
end $$;

-- The first blocking rule, or no row (warnings left out).
create function hr.assignment_blocker(p_worker uuid, p_start timestamptz, p_end timestamptz,
                                      p_node uuid, p_role text, p_ignore uuid default null)
returns table (code text, detail text)
language sql stable
set search_path = pg_catalog, hr
as $$
  select c.code, c.detail from hr.assignment_checks(p_worker, p_start, p_end, p_node, p_role,
                                                    p_ignore) c
   where not c.warning limit 1;
$$;

-- Raises the first blocking rule, then the first warning not in p_accept. Returns the
-- warnings that apply (all of them in p_accept), to record on the assignment.
create function hr.check_assignment(p_worker uuid, p_start timestamptz, p_end timestamptz,
                                    p_node uuid, p_role text, p_accept text[])
returns text[]
language plpgsql stable
set search_path = pg_catalog, hr
as $$
declare
  r record;
  v_warn text[] := '{}';
begin
  for r in select * from hr.assignment_checks(p_worker, p_start, p_end, p_node, p_role)
            where not warning loop
    perform hr.fail(r.code, r.detail);
  end loop;
  for r in select * from hr.assignment_checks(p_worker, p_start, p_end, p_node, p_role)
            where warning loop
    if not r.code = any (coalesce(p_accept, '{}')) then
      perform hr.fail(r.code, r.detail);
    end if;
    v_warn := v_warn || r.code;
  end loop;
  return v_warn;
end $$;

-- The current user must be able to act on the swap's pending step.
create function hr.require_swap_approver(p_sw hr.shift_swap) returns void
language plpgsql stable
set search_path = pg_catalog, core, hr, wf
as $$
begin
  if p_sw.status <> 'submitted' or p_sw.wf_request_id is null then
    perform hr.fail('INVALID_STATE', 'swap is not waiting for approval');
  end if;
  if not exists (select 1 from wf.step_instance si
                  where si.request_id = p_sw.wf_request_id and si.state = 'pending'
                    and wf.can_act_on_step(core.current_user_id(), si, 'SHIFT_SWAP')) then
    if core.current_user_id() in (p_sw.owner_user_id, p_sw.to_user_id) then
      perform hr.fail('SEGREGATION_OF_DUTIES', 'a party to the swap cannot approve it');
    end if;
    perform hr.fail('NOT_AUTHORISED', 'not an approver for this swap');
  end if;
end $$;

revoke execute on function
  hr.assignment_checks(uuid, timestamptz, timestamptz, uuid, text, uuid),
  hr.assignment_blocker(uuid, timestamptz, timestamptz, uuid, text, uuid),
  hr.check_assignment(uuid, timestamptz, timestamptz, uuid, text, text[]),
  hr.require_swap_approver(hr.shift_swap)
  from public;

-- Offering and accepting stop only on blocking rules; the executor's safety net likewise
-- (the approver has already seen the warnings).
do $$
declare
  v_fn text;
  v_src text;
begin
  foreach v_fn in array array['hr.request_swap(uuid, uuid, text)', 'hr.respond_swap(uuid, boolean)',
                              'hr.execute(text, uuid)'] loop
    v_src := pg_get_functiondef(v_fn::regprocedure);
    if position('hr.assignment_violation(' in v_src) = 0 then
      raise exception '% changed; update this migration', v_fn;
    end if;
    execute replace(v_src, 'hr.assignment_violation(', 'hr.assignment_blocker(');
  end loop;

  -- the swapped-in assignment records the warnings the approver approved past
  v_src := pg_get_functiondef('hr.execute(text, uuid)'::regprocedure);
  if position('start_at, end_at, swap_id)' in v_src) = 0
     or position('v_s.start_at, v_s.end_at, v_sw.id)' in v_src) = 0 then
    raise exception 'hr.execute changed; update this migration';
  end if;
  execute replace(replace(v_src, 'start_at, end_at, swap_id)',
                          'start_at, end_at, swap_id, warnings_accepted)'),
                  'v_s.start_at, v_s.end_at, v_sw.id)',
                  'v_s.start_at, v_s.end_at, v_sw.id, v_sw.warnings_accepted)');
end $$;

-- A manager assigns past the warnings they name (p_accept). hr.assign(shift, worker) is
-- unchanged: it still stops on every rule.
create function hr.assign(p_shift uuid, p_worker uuid, p_accept text[]) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_shift hr.shift;
  v_w hr.worker;
  v_id uuid;
  v_warn text[];
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
  v_warn := hr.check_assignment(p_worker, v_shift.start_at, v_shift.end_at, v_shift.org_node_id,
                                v_shift.role_code, p_accept);

  insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                   start_at, end_at, warnings_accepted)
  values (v_shift.tenant_id, p_shift, p_worker, v_w.owner_user_id, v_shift.org_node_id,
          v_shift.start_at, v_shift.end_at, v_warn)
  returning id into v_id;
  if v_shift.status = 'published' then
    perform hr.notify_worker(p_worker, 'roster_changed', 'New shift added',
      to_char(v_shift.start_at at time zone hr.node_tz(v_shift.org_node_id), 'Dy DD Mon HH24:MI'),
      '/roster/my');
  end if;
  return v_id;
end $$;

-- Candidates for a shift: violation is the first blocking rule (null = assignable);
-- warnings [{code, detail}] the ones a manager can assign past.
drop function hr.assign_candidates(uuid);
create function hr.assign_candidates(p_shift uuid)
returns table (worker_id uuid, display_name text, violation text, violation_detail text,
               week_hours numeric, warnings jsonb)
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
    select w.id, u.display_name, b.code, b.detail,
           round(coalesce((select sum(extract(epoch from a.end_at - a.start_at)) / 3600
                             from hr.shift_assignment a
                            where a.worker_id = w.id and a.status = 'assigned'
                              and (a.start_at at time zone v_tz)::date between v_week and v_week + 6), 0), 1),
           coalesce(wn.list, '[]'::jsonb)
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
      left join lateral hr.assignment_blocker(w.id, v_shift.start_at, v_shift.end_at,
                                              v_shift.org_node_id, v_shift.role_code) b on true
      left join lateral (
        select jsonb_agg(jsonb_build_object('code', c.code, 'detail', c.detail)) as list
          from hr.assignment_checks(w.id, v_shift.start_at, v_shift.end_at,
                                    v_shift.org_node_id, v_shift.role_code) c
         where c.warning) wn on true
     where hr.works_under(w.org_node_id, v_shift.org_node_id) and w.role_code = v_shift.role_code
       and w.status = 'active'
       and not exists (select 1 from hr.shift_assignment a
                        where a.shift_id = p_shift and a.worker_id = w.id and a.status = 'assigned')
     order by b.code nulls first, jsonb_array_length(coalesce(wn.list, '[]'::jsonb)),
              u.display_name;
end $$;

-- What the swap's approver needs to know about the colleague taking the shift: every rule
-- that applies now (warning = false ones stop approval whatever is acknowledged).
create function hr.swap_checks(p_swap uuid)
returns table (code text, detail text, warning boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_sw hr.shift_swap;
  v_s hr.shift;
begin
  select * into v_sw from hr.shift_swap where id = p_swap and tenant_id = core.my_tenant();
  if not found then
    perform hr.fail('NOT_FOUND', 'swap');
  end if;
  perform hr.require_swap_approver(v_sw);
  select * into v_s from hr.shift where id = v_sw.shift_id;
  return query select c.code, c.detail, c.warning
                 from hr.assignment_checks(v_sw.to_worker_id, v_s.start_at, v_s.end_at,
                                           v_s.org_node_id, v_s.role_code) c;
end $$;

-- Approves a submitted swap past the warnings the approver names (p_accept). Any other
-- rule, or a warning not named (it appeared after the screen loaded), stops it with its
-- code. hr.approve_swap(swap, comment) is unchanged: it stops on every rule.
create function hr.approve_swap(p_swap uuid, p_comment text, p_accept text[]) returns text
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_sw hr.shift_swap;
  v_a hr.shift_assignment;
  v_s hr.shift;
  v_warn text[];
begin
  perform wf.me();
  select * into v_sw from hr.shift_swap
   where id = p_swap and tenant_id = core.my_tenant() for update;
  if not found then
    perform hr.fail('NOT_FOUND', 'swap');
  end if;
  perform hr.require_swap_approver(v_sw);
  select * into v_a from hr.shift_assignment where id = v_sw.assignment_id;
  select * into v_s from hr.shift where id = v_sw.shift_id;
  if v_s.start_at <= now() then
    perform hr.fail('SHIFT_STARTED');
  end if;
  if v_a.status <> 'assigned' then
    perform hr.fail('INVALID_STATE', 'the original assignment has changed');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hr.worker:' || v_sw.to_worker_id, 0));
  v_warn := hr.check_assignment(v_sw.to_worker_id, v_s.start_at, v_s.end_at, v_s.org_node_id,
                                v_s.role_code, p_accept);
  update hr.shift_swap set warnings_accepted = v_warn where id = p_swap;
  return wf.act_as_module(v_sw.wf_request_id, 'manager_approval', p_comment);
end $$;

-- The approver gives the shift to someone else instead: it goes straight onto their
-- roster (no further approval), off the original person's, and the swap request closes
-- (rejected, with a comment naming who got it). Needs ROSTER modify at the shift's place,
-- like any roster change. Returns the new assignment.
create function hr.reassign_swap(p_swap uuid, p_worker uuid, p_accept text[],
                                 p_comment text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_sw hr.shift_swap;
  v_a hr.shift_assignment;
  v_s hr.shift;
  v_w hr.worker;
  v_warn text[];
  v_id uuid;
  v_name text;
  v_when text;
begin
  perform wf.me();
  select * into v_sw from hr.shift_swap
   where id = p_swap and tenant_id = core.my_tenant() for update;
  if not found then
    perform hr.fail('NOT_FOUND', 'swap');
  end if;
  perform hr.require_swap_approver(v_sw);
  select * into v_s from hr.shift where id = v_sw.shift_id;
  perform hr.require('ROSTER', 'modify', v_s.org_node_id);
  select * into v_a from hr.shift_assignment where id = v_sw.assignment_id for update;
  if v_s.start_at <= now() then
    perform hr.fail('SHIFT_STARTED');
  end if;
  if v_a.status <> 'assigned' then
    perform hr.fail('INVALID_STATE', 'the original assignment has changed');
  end if;
  select * into v_w from hr.worker
   where id = p_worker and tenant_id = v_sw.tenant_id and status = 'active';
  if not found then
    perform hr.fail('INVALID_WORKER', 'worker not found');
  end if;
  if v_w.owner_user_id = core.current_user_id() then
    perform hr.fail('SEGREGATION_OF_DUTIES', 'you cannot give the shift to yourself');
  end if;
  if p_worker in (v_sw.from_worker_id, v_sw.to_worker_id) then
    perform hr.fail('INVALID_WORKER', 'approve or reject the swap instead');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hr.worker:' || p_worker, 0));
  v_warn := hr.check_assignment(p_worker, v_s.start_at, v_s.end_at, v_s.org_node_id,
                                v_s.role_code, p_accept);

  update hr.shift_assignment set status = 'swapped', drop_reason = 'swap', swap_id = v_sw.id
   where id = v_a.id;
  insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                   start_at, end_at, swap_id, warnings_accepted)
  values (v_sw.tenant_id, v_s.id, p_worker, v_w.owner_user_id, v_s.org_node_id,
          v_s.start_at, v_s.end_at, v_sw.id, v_warn)
  returning id into v_id;
  update hr.shift_swap
     set status = 'reassigned', decided_at = now(), new_assignment_id = v_id,
         reassigned_worker_id = p_worker, warnings_accepted = v_warn
   where id = p_swap;

  v_name := hr.user_name(v_w.owner_user_id);
  -- the reject handler leaves a reassigned swap alone
  perform wf.act(v_sw.wf_request_id, 'reject',
                 coalesce(nullif(trim(p_comment), ''), 'Assigned to ' || v_name || ' instead'));

  v_when := to_char(v_s.start_at at time zone hr.node_tz(v_s.org_node_id), 'Dy DD Mon HH24:MI');
  perform ops.notify(v_sw.tenant_id, u, 'swap_reassigned', 'Shift given to ' || v_name,
                     v_when, '/roster/swaps')
     from unnest(array[v_sw.owner_user_id, v_sw.to_user_id]) u;
  perform hr.notify_worker(p_worker, 'roster_changed', 'New shift added', v_when, '/roster/my');
  return v_id;
end $$;

revoke execute on function hr.assign(uuid, uuid, text[]), hr.assign_candidates(uuid),
  hr.swap_checks(uuid), hr.approve_swap(uuid, text, text[]),
  hr.reassign_swap(uuid, uuid, text[], text) from public;
grant execute on function hr.assign(uuid, uuid, text[]), hr.assign_candidates(uuid),
  hr.swap_checks(uuid), hr.approve_swap(uuid, text, text[]),
  hr.reassign_swap(uuid, uuid, text[], text) to app_rw;

-- migrate:down
drop function hr.reassign_swap(uuid, uuid, text[], text);
drop function hr.approve_swap(uuid, text, text[]);
drop function hr.swap_checks(uuid);
drop function hr.assign_candidates(uuid);
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
     where hr.works_under(w.org_node_id, v_shift.org_node_id) and w.role_code = v_shift.role_code
       and w.status = 'active'
       and not exists (select 1 from hr.shift_assignment a
                        where a.shift_id = p_shift and a.worker_id = w.id and a.status = 'assigned')
     order by v.code nulls first, u.display_name;
end $$;
revoke execute on function hr.assign_candidates(uuid) from public;
grant execute on function hr.assign_candidates(uuid) to app_rw;
drop function hr.assign(uuid, uuid, text[]);
do $$
declare
  v_fn text;
  v_src text;
begin
  v_src := pg_get_functiondef('hr.execute(text, uuid)'::regprocedure);
  execute replace(replace(v_src, 'start_at, end_at, swap_id, warnings_accepted)',
                          'start_at, end_at, swap_id)'),
                  'v_s.start_at, v_s.end_at, v_sw.id, v_sw.warnings_accepted)',
                  'v_s.start_at, v_s.end_at, v_sw.id)');
  foreach v_fn in array array['hr.request_swap(uuid, uuid, text)', 'hr.respond_swap(uuid, boolean)',
                              'hr.execute(text, uuid)'] loop
    execute replace(pg_get_functiondef(v_fn::regprocedure), 'hr.assignment_blocker(',
                    'hr.assignment_violation(');
  end loop;
end $$;
drop function hr.require_swap_approver(hr.shift_swap);
drop function hr.check_assignment(uuid, timestamptz, timestamptz, uuid, text, text[]);
drop function hr.assignment_blocker(uuid, timestamptz, timestamptz, uuid, text, uuid);
drop function hr.assignment_checks(uuid, timestamptz, timestamptz, uuid, text, uuid);
update hr.shift_swap set status = 'rejected' where status = 'reassigned';
alter table hr.shift_swap drop constraint shift_swap_status_check;
alter table hr.shift_swap add constraint shift_swap_status_check check (status in
  ('proposed', 'declined', 'withdrawn', 'submitted', 'approved', 'rejected', 'cancelled'));
alter table hr.shift_swap drop column reassigned_worker_id, drop column warnings_accepted;
alter table hr.shift_assignment drop column warnings_accepted;
