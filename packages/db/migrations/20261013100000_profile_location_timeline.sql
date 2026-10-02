-- migrate:up
-- Profile, outlet location, My shifts and Clock (Prompt 11a, ADR 018).
--
--   core.my_profile, core.my_access              your own details and grants, read-only
--   core.sign_out_everywhere                     ends every app session (sessions_valid_from)
--   core.record_own_password_change              audits a password change made in Cognito
--   hr.set_place_location, hr.location_places    an outlet's or site's geofence, set in the app
--   hr.attendance_timeline                       matching punches to shifts, splitting extra time
--   hr.my_timeline, hr.worker_timeline           that timeline for a person, with local dates
--   hr.nightly_attendance                        rewritten on the timeline; adds left_early
--
-- Forward-only: the down section is never run in deployed environments.

-- ---------------------------------------------------------------------------
-- Profile: own login actions
-- ---------------------------------------------------------------------------

-- Session cookies issued before this are refused (core.my_sessions_valid_from).
alter table core.app_user add column sessions_valid_from timestamptz;

alter table core.login_admin_event drop constraint login_admin_event_action_check;
alter table core.login_admin_event add constraint login_admin_event_action_check
  check (action in ('reset_password', 'disable_login', 'enable_login', 'change_own_password',
                    'change_own_password_failed', 'sign_out_everywhere'));

create function core.my_profile()
returns table (display_name text, username text, email text, login_type text, job_role text,
               home_place text, last_sign_in_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select u.display_name, u.username, u.email, u.login_type, jr.name, n.name, u.last_sign_in_at
    from core.app_user u
    left join hr.worker w on w.owner_user_id = u.id and w.status = 'active'
    left join hr.job_role jr on jr.tenant_id = u.tenant_id and jr.code = w.role_code
    left join core.hierarchy_node n on n.id = w.org_node_id
   where u.id = core.current_user_id() and u.status = 'active';
$$;

-- Your grants: one row per active assignment, plus SELF (place null: yourself, anywhere),
-- each with the domains it gives and the strongest access in each.
create function core.my_access()
returns table (access_group text, group_name text, place text, include_descendants boolean,
               effective_to date, domains jsonb)
language sql stable security definer
set search_path = pg_catalog, core
as $$
  with me as (select * from core.me()),
  grants as (
    select g.id as group_id, g.code, g.name, n.name as place, ra.include_descendants,
           ra.effective_to, n.path
      from me
      join core.role_assignment ra on ra.user_id = me.id
      join core.security_group g on g.id = ra.group_id
      join core.hierarchy_node n on n.id = ra.node_id
     where ra.effective_from <= current_date
       and (ra.effective_to is null or ra.effective_to >= current_date)
    union all
    select g.id, g.code, g.name, null, null, null, null
      from me join core.security_group g on g.tenant_id = me.tenant_id and g.code = 'SELF')
  select gr.code, gr.name, gr.place, gr.include_descendants, gr.effective_to,
         coalesce((select jsonb_agg(jsonb_build_object('domain', x.domain, 'access', x.access)
                                    order by x.domain)
                     from (select d.code as domain,
                                  case when bool_or(dp.access = 'modify') then 'modify'
                                       else 'view' end as access
                             from core.domain_policy dp
                             join core.domain d on d.id = dp.domain_id
                            where dp.group_id = gr.group_id
                            group by d.code) x), '[]'::jsonb)
    from grants gr
   order by gr.place is not null, gr.path, gr.code;
$$;

create function core.my_sessions_valid_from() returns timestamptz
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select sessions_valid_from from core.app_user
   where id = core.current_user_id() and status = 'active';
$$;

-- Ends every app session of the caller from now and records it. Returns what Cognito's
-- AdminUserGlobalSignOut needs; the server calls it next.
create function core.sign_out_everywhere()
returns table (username text, email text, login_type text, cognito_sub text)
language plpgsql security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_u core.app_user;
begin
  update core.app_user set sessions_valid_from = now()
   where id = core.current_user_id() and status = 'active' and kind = 'human'
  returning * into v_u;
  if not found then
    perform wf.fail('NOT_AUTHORISED', 'no signed-in person');
  end if;
  insert into core.login_admin_event (tenant_id, user_id, action)
  values (v_u.tenant_id, v_u.id, 'sign_out_everywhere');
  return query select v_u.username, v_u.email, v_u.login_type, v_u.cognito_sub;
end $$;

-- Records the caller's own password change (made in Cognito by the server), or a failed
-- attempt. Username logins only: email logins have no password.
create function core.record_own_password_change(p_ok boolean) returns void
language plpgsql security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_u core.app_user;
begin
  select * into v_u from core.app_user
   where id = core.current_user_id() and status = 'active' and kind = 'human';
  if not found then
    perform wf.fail('NOT_AUTHORISED', 'no signed-in person');
  end if;
  if v_u.login_type <> 'username' then
    perform wf.fail('INVALID_ACTION', 'email logins have no password');
  end if;
  insert into core.login_admin_event (tenant_id, user_id, action)
  values (v_u.tenant_id, v_u.id,
          case when p_ok then 'change_own_password' else 'change_own_password_failed' end);
end $$;

revoke execute on function core.my_profile(), core.my_access(), core.my_sessions_valid_from(),
  core.sign_out_everywhere(), core.record_own_password_change(boolean) from public;
grant execute on function core.my_profile(), core.my_access(), core.my_sessions_valid_from(),
  core.sign_out_everywhere(), core.record_own_password_change(boolean) to app_rw;

-- ---------------------------------------------------------------------------
-- Outlet location, set in the app
-- ---------------------------------------------------------------------------

-- Who set the row in the app, and when; cleared when file 04 is imported again. The
-- import's dry run warns before replacing such a row.
alter table hr.node_setting
  add column set_in_app_by uuid references core.app_user (id),
  add column set_in_app_at timestamptz,
  add constraint node_setting_set_in_app check ((set_in_app_by is null) = (set_in_app_at is null));

-- Whether the caller may set this place's location: ATTENDANCE modify at the place (the GM
-- and AGM), or COMPANY_SETTINGS modify (the Account Owner).
create function hr.can_set_location(p_node uuid) returns boolean
language sql stable
set search_path = pg_catalog, core
as $$
  select core.can('ATTENDANCE', 'modify', p_node, null, null)
      or core.can('COMPANY_SETTINGS', 'modify', p_node, null, null);
$$;
revoke execute on function hr.can_set_location(uuid) from public;

create function hr.location_places()
returns table (node_id uuid, code text, name text, kind text, latitude numeric,
               longitude numeric, geofence_radius_m int, set_in_app_by text,
               set_in_app_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select n.id, n.code, n.name, n.kind, s.latitude, s.longitude, s.geofence_radius_m,
         u.display_name, s.set_in_app_at
    from core.hierarchy_node n
    left join hr.node_setting s on s.org_node_id = n.id
    left join core.app_user u on u.id = s.set_in_app_by
   where n.tenant_id = core.my_tenant() and n.type = 'org' and n.kind in ('outlet', 'site')
     and n.archived_at is null and hr.can_set_location(n.id)
   order by n.path;
$$;

create function hr.set_place_location(p_node uuid, p_lat numeric, p_lng numeric,
                                      p_radius int) returns void
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_n core.hierarchy_node;
begin
  select * into v_n from core.hierarchy_node
   where id = p_node and tenant_id = core.my_tenant() and archived_at is null;
  if not found then
    perform hr.fail('NOT_AUTHORISED', 'place');
  end if;
  if v_n.type <> 'org' or v_n.kind not in ('outlet', 'site') then
    perform hr.fail('INVALID_PLACE', 'locations are set for an outlet or site');
  end if;
  if not hr.can_set_location(p_node) then
    perform hr.fail('NOT_AUTHORISED', 'location of ' || v_n.name);
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90
     or p_lng not between -180 and 180 then
    perform hr.fail('INVALID_LOCATION');
  end if;
  if p_radius is null or p_radius not between 10 and 5000 then
    perform hr.fail('INVALID_RADIUS', 'between 10 and 5000 m');
  end if;
  insert into hr.node_setting (tenant_id, org_node_id, latitude, longitude, geofence_radius_m,
                               set_in_app_by, set_in_app_at)
  values (v_n.tenant_id, p_node, round(p_lat, 6), round(p_lng, 6), p_radius,
          core.current_user_id(), now())
  on conflict (tenant_id, org_node_id) do update
     set latitude = excluded.latitude, longitude = excluded.longitude,
         geofence_radius_m = excluded.geofence_radius_m,
         set_in_app_by = excluded.set_in_app_by, set_in_app_at = excluded.set_in_app_at;
end $$;

revoke execute on function hr.location_places(), hr.set_place_location(uuid, numeric, numeric, int)
  from public;
grant execute on function hr.location_places(), hr.set_place_location(uuid, numeric, numeric, int)
  to app_rw;

-- ---------------------------------------------------------------------------
-- Matching punches to shifts
-- ---------------------------------------------------------------------------

-- Time worked outside a shift shows as its own row from this many minutes (file 15).
alter table hr.roster_setting
  add column extra_time_min_minutes int not null default 30
    check (extra_time_min_minutes between 0 and 240);

drop function hr.roster_rules(uuid);
create function hr.roster_rules(p_tenant uuid,
                                out min_rest_hours numeric, out weekly_hours_cap numeric,
                                out late_threshold_min int, out extra_time_min_minutes int)
language sql stable security definer
set search_path = pg_catalog, hr
as $$
  select coalesce(s.min_rest_hours, 10), coalesce(s.weekly_hours_cap, 48),
         coalesce(s.late_threshold_min, 10), coalesce(s.extra_time_min_minutes, 30)
    from (select 1) one
    left join hr.roster_setting s on s.tenant_id = p_tenant;
$$;
revoke execute on function hr.roster_rules(uuid) from public;

-- One worker's shifts and clock sessions, matched and split. Pure: shifts
-- [{id, start, end}] and sessions [{id, in, out}] in, rows out.
--
-- Matching. A closed session belongs to every shift it overlaps; an open one to the shift
-- it started in. A session that overlaps none belongs to the nearest shift it starts or
-- ends within 30 minutes of; otherwise it is unrostered. A session spanning two shifts is
-- cut at the second shift's start: the gap between them is the first shift's.
--
-- Splitting. Time worked before a shift's start (after its end) becomes its own row,
-- extra_before (extra_after), when it is p_extra_min minutes or more, or when no time was
-- worked inside the shift at all. Shorter differences stay in the shift row's From/To.
-- Extra after a shift is only split once the session is closed.
--
-- Statuses of a shift row, in this order:
--   in_progress / missing_clock_out  a session is open (missing 4 h after the shift's end)
--   upcoming / due / no_show         nothing worked inside the shift: before, during, after it
--   late                             first in after start + p_late_min (late_min)
--   clocked_out                      everyone has clocked out but the shift is still running
--   left_early                       last out before end - p_late_min (early_min)
--   on_time
-- late_min and early_min are both given when both apply. Unrostered rows: unrostered,
-- in_progress, or missing_clock_out 16 h after the clock-in.
create function hr.attendance_timeline(p_shifts jsonb, p_sessions jsonb, p_late_min int,
                                       p_extra_min int, p_now timestamptz)
returns table (kind text, shift_id uuid, attendance_ids uuid[], shift_start timestamptz,
               shift_end timestamptz, from_at timestamptz, to_at timestamptz, minutes int,
               status text, late_min int, early_min int)
language sql immutable parallel safe
set search_path = pg_catalog
as $$
  with sh as (
    select x.id, x.start as s, x."end" as e
      from jsonb_to_recordset(coalesce(p_shifts, '[]'))
           as x (id uuid, start timestamptz, "end" timestamptz)),
  se as (
    select x.id, x."in" as i, x."out" as o
      from jsonb_to_recordset(coalesce(p_sessions, '[]'))
           as x (id uuid, "in" timestamptz, "out" timestamptz)),
  ov as (
    select se.id as att, sh.id as shift
      from se join sh on case when se.o is null then se.i >= sh.s and se.i < sh.e
                              else se.i < sh.e and se.o > sh.s end),
  near as (
    select distinct on (se.id) se.id as att, sh.id as shift
      from se
      join sh on sh.s - interval '30 minutes' <= coalesce(se.o, se.i)
             and sh.e + interval '30 minutes' >= se.i
     where not exists (select 1 from ov where ov.att = se.id)
     order by se.id, least(abs(extract(epoch from sh.s - coalesce(se.o, se.i))),
                           abs(extract(epoch from se.i - sh.e)))),
  m as (select att, shift from ov union all select att, shift from near),
  -- each session's piece per shift: [pf, pt), pt null while open; pe = worked up to now
  pn as (
    select m.shift, m.att, se.i, se.o, sh.s,
           lag(sh.s) over w as prev_s, lead(sh.s) over w as next_s
      from m join se on se.id = m.att join sh on sh.id = m.shift
    window w as (partition by m.att order by sh.s)),
  pp as (
    select pn.shift, pn.att, case when pn.prev_s is null then pn.i else pn.s end as pf,
           coalesce(pn.next_s, pn.o) as pt
      from pn),
  pc as (select pp.*, coalesce(pp.pt, greatest(pp.pf, p_now)) as pe from pp),
  agg as (
    select sh.id, sh.s, sh.e,
           array_agg(pc.att order by pc.pf) filter (where pc.att is not null) as atts,
           min(pc.pf) as first_in,
           max(pc.pt) as last_out,
           coalesce(bool_or(pc.att is not null and pc.pt is null), false) as open,
           min(greatest(pc.pf, sh.s)) filter (where pc.pe > sh.s and pc.pf < sh.e) as in_first,
           max(least(pc.pt, sh.e)) filter (where pc.pt > sh.s and pc.pf < sh.e) as in_last,
           sum(extract(epoch from least(pc.pe, sh.e) - greatest(pc.pf, sh.s)))
             filter (where pc.pe > sh.s and pc.pf < sh.e) as inside_s,
           sum(extract(epoch from least(pc.pe, sh.s) - pc.pf)) filter (where pc.pf < sh.s) as before_s,
           max(least(pc.pe, sh.s)) filter (where pc.pf < sh.s) as before_to,
           sum(extract(epoch from pc.pt - greatest(pc.pf, sh.e))) filter (where pc.pt > sh.e) as after_s,
           min(greatest(pc.pf, sh.e)) filter (where pc.pt > sh.e) as after_from
      from sh left join pc on pc.shift = sh.id
     group by sh.id, sh.s, sh.e),
  f as (
    select a.*,
           coalesce(a.before_s, 0) > 0
             and (a.before_s >= p_extra_min * 60 or a.in_first is null) as split_before,
           coalesce(a.after_s, 0) > 0 and not a.open
             and (a.after_s >= p_extra_min * 60 or a.in_first is null) as split_after,
           case when a.in_first > a.s + make_interval(mins => p_late_min)
                then floor(extract(epoch from a.in_first - a.s) / 60)::int end as late,
           case when not a.open and p_now >= a.e
                     and a.in_last < a.e - make_interval(mins => p_late_min)
                then floor(extract(epoch from a.e - a.in_last) / 60)::int end as early
      from agg a),
  rows as (
    select 'shift' as kind, f.id as shift_id, coalesce(f.atts, '{}') as attendance_ids,
           f.s as shift_start, f.e as shift_end,
           case when f.in_first is null then null
                when f.split_before then f.in_first else f.first_in end as from_at,
           case when f.in_first is null or f.open then null
                when f.split_after then f.in_last else f.last_out end as to_at,
           floor((coalesce(f.inside_s, 0)
                  + case when f.split_before then 0 else coalesce(f.before_s, 0) end
                  + case when f.split_after then 0 else coalesce(f.after_s, 0) end) / 60)::int
             as minutes,
           case when f.open then case when p_now >= f.e + interval '4 hours'
                                      then 'missing_clock_out' else 'in_progress' end
                when f.in_first is null then case when p_now < f.s then 'upcoming'
                                                  when p_now < f.e then 'due'
                                                  else 'no_show' end
                when f.late is not null then 'late'
                when p_now < f.e then 'clocked_out'
                when f.early is not null then 'left_early'
                else 'on_time' end as status,
           f.late as late_min, f.early as early_min, 1 as rank
      from f
    union all
    select 'extra_before', f.id, f.atts, f.s, f.e, f.first_in, f.before_to,
           floor(f.before_s / 60)::int, null, null, null, 0
      from f where f.split_before
    union all
    select 'extra_after', f.id, f.atts, f.s, f.e, f.after_from, f.last_out,
           floor(f.after_s / 60)::int, null, null, null, 2
      from f where f.split_after
    union all
    select 'unrostered', null, array[se.id], null, null, se.i, se.o,
           floor(extract(epoch from coalesce(se.o, greatest(se.i, p_now)) - se.i) / 60)::int,
           case when se.o is not null then 'unrostered'
                when p_now >= se.i + interval '16 hours' then 'missing_clock_out'
                else 'in_progress' end,
           null, null, 1
      from se where not exists (select 1 from m where m.att = se.id))
  select r.kind, r.shift_id, r.attendance_ids, r.shift_start, r.shift_end, r.from_at, r.to_at,
         r.minutes, r.status, r.late_min, r.early_min
    from rows r
   order by coalesce(r.shift_start, r.from_at), r.rank, r.from_at;
$$;

revoke execute on function hr.attendance_timeline(jsonb, jsonb, int, int, timestamptz) from public;

-- A worker's timeline for local days p_from..p_to (the worker's home time zone), with each
-- row's local day, place and job role. Unchecked: callers check access.
create function hr.timeline_rows(p_w hr.worker, p_from date, p_to date, p_now timestamptz)
returns table (local_date date, kind text, shift_id uuid, attendance_ids uuid[],
               shift_start timestamptz, shift_end timestamptz, from_at timestamptz,
               to_at timestamptz, minutes int, status text, late_min int, early_min int,
               role_code text, place_id uuid, place_name text)
language plpgsql stable
set search_path = pg_catalog, core, hr
as $$
declare
  v_tz text := hr.node_tz(p_w.org_node_id);
  v_rules record := hr.roster_rules(p_w.tenant_id);
begin
  return query
  with sh as (
    select s.id, a.start_at, a.end_at, s.local_date, s.role_code, s.org_node_id
      from hr.shift_assignment a
      join hr.shift s on s.id = a.shift_id and s.status = 'published'
     where a.worker_id = p_w.id and a.status = 'assigned'
       and s.local_date between p_from - 1 and p_to + 1),
  se as (
    select a.id, a.clock_in_at, a.clock_out_at, a.org_node_id
      from hr.attendance a
     where a.worker_id = p_w.id
       and a.clock_in_at >= (p_from - 1)::timestamp at time zone v_tz
       and a.clock_in_at < (p_to + 2)::timestamp at time zone v_tz),
  t as (
    select * from hr.attendance_timeline(
      (select jsonb_agg(jsonb_build_object('id', id, 'start', start_at, 'end', end_at)) from sh),
      (select jsonb_agg(jsonb_build_object('id', id, 'in', clock_in_at, 'out', clock_out_at))
         from se),
      v_rules.late_threshold_min, v_rules.extra_time_min_minutes, p_now) with ordinality)
  select coalesce(sh.local_date, (t.from_at at time zone v_tz)::date), t.kind, t.shift_id,
         t.attendance_ids, t.shift_start, t.shift_end, t.from_at, t.to_at, t.minutes, t.status,
         t.late_min, t.early_min, sh.role_code, coalesce(sh.org_node_id, se.org_node_id), n.name
    from t
    left join sh on sh.id = t.shift_id
    left join se on se.id = t.attendance_ids[1] and t.shift_id is null
    left join core.hierarchy_node n on n.id = coalesce(sh.org_node_id, se.org_node_id)
   where coalesce(sh.local_date, (t.from_at at time zone v_tz)::date) between p_from and p_to
   order by t.ordinality;
end $$;
revoke execute on function hr.timeline_rows(hr.worker, date, date, timestamptz) from public;

-- A worker's timeline, for the worker themselves or anyone with ATTENDANCE view over them.
create function hr.worker_timeline(p_worker uuid, p_from date, p_to date)
returns table (local_date date, kind text, shift_id uuid, attendance_ids uuid[],
               shift_start timestamptz, shift_end timestamptz, from_at timestamptz,
               to_at timestamptz, minutes int, status text, late_min int, early_min int,
               role_code text, place_id uuid, place_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker;
begin
  select * into v_w from hr.worker where id = p_worker and tenant_id = core.my_tenant();
  if not found or not core.can('ATTENDANCE', 'view', v_w.org_node_id, null, v_w.owner_user_id) then
    perform hr.fail('NOT_AUTHORISED', 'attendance of this worker');
  end if;
  if p_to < p_from or p_to - p_from > 92 then
    perform hr.fail('INVALID_DATE', 'at most 93 days');
  end if;
  return query select * from hr.timeline_rows(v_w, p_from, p_to, now());
end $$;

-- The caller's own timeline (My shifts, Clock).
create function hr.my_timeline(p_from date, p_to date)
returns table (local_date date, kind text, shift_id uuid, attendance_ids uuid[],
               shift_start timestamptz, shift_end timestamptz, from_at timestamptz,
               to_at timestamptz, minutes int, status text, late_min int, early_min int,
               role_code text, place_id uuid, place_name text)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select * from hr.worker_timeline((hr.my_worker()).id, p_from, p_to);
$$;

revoke execute on function hr.worker_timeline(uuid, date, date), hr.my_timeline(date, date)
  from public;
grant execute on function hr.worker_timeline(uuid, date, date), hr.my_timeline(date, date)
  to app_rw;

-- ---------------------------------------------------------------------------
-- The nightly job on the timeline
-- ---------------------------------------------------------------------------

alter table hr.attendance_exception drop constraint attendance_exception_kind_check;
alter table hr.attendance_exception add constraint attendance_exception_kind_check
  check (kind in ('late', 'left_early', 'no_show', 'missing_clock_out', 'unscheduled',
                  'outside_geofence', 'no_location'));

-- As in 20260930180000, with the exceptions read from each worker's timeline for the last
-- p_days local days, so they match what the person and their manager see:
--   late, left_early   a shift row's late_min / early_min (detail: minutes)
--   no_show            a shift that ended with no time worked inside it
--   missing_clock_out  a session open 4 h after its shift (16 h after an unrostered clock-in)
--   unscheduled        an unrostered session
-- Idempotent: existing exceptions are kept as they are.
create or replace function hr.nightly_attendance(p_as_of timestamptz default now(),
                                                 p_days int default 2)
returns table (exceptions int, purged int)
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_added int := 0;
  v_n int;
  v_purged int;
  v_w hr.worker;
  v_today date;
begin
  for v_w in
    select w.* from hr.worker w
     where exists (select 1 from hr.shift_assignment a
                    where a.worker_id = w.id and a.status = 'assigned'
                      and a.start_at < p_as_of
                      and a.end_at > p_as_of - make_interval(days => p_days + 2))
        or exists (select 1 from hr.attendance a
                    where a.worker_id = w.id and a.clock_in_at < p_as_of
                      and a.clock_in_at > p_as_of - make_interval(days => p_days + 2))
  loop
    v_today := (p_as_of at time zone hr.node_tz(v_w.org_node_id))::date;
    insert into hr.attendance_exception (tenant_id, org_node_id, worker_id, owner_user_id,
                                         shift_id, attendance_id, local_date, kind, detail)
    select v_w.tenant_id, t.place_id, v_w.id, v_w.owner_user_id, t.shift_id, x.attendance_id,
           t.local_date, x.kind, x.detail
      from hr.timeline_rows(v_w, v_today - p_days, v_today, p_as_of) t
      cross join lateral (values
        ('late', t.attendance_ids[1], jsonb_build_object('minutes', t.late_min),
         t.kind = 'shift' and t.late_min is not null),
        ('left_early', t.attendance_ids[cardinality(t.attendance_ids)],
         jsonb_build_object('minutes', t.early_min), t.kind = 'shift' and t.early_min is not null),
        ('no_show', null, '{}'::jsonb, t.kind = 'shift' and t.status = 'no_show'),
        ('missing_clock_out', t.attendance_ids[cardinality(t.attendance_ids)], '{}'::jsonb,
         t.kind in ('shift', 'unrostered') and t.status = 'missing_clock_out'),
        ('unscheduled', t.attendance_ids[1], '{}'::jsonb, t.kind = 'unrostered'))
        as x (kind, attendance_id, detail, raise)
     where x.raise
    on conflict on constraint attendance_exception_key do nothing;
    get diagnostics v_n = row_count;
    v_added := v_added + v_n;
  end loop;

  -- data minimisation (ADR 008): raw coordinates kept 90 days; distance and flag stay
  update hr.attendance
     set in_lat = null, in_lng = null, in_accuracy_m = null,
         out_lat = null, out_lng = null, out_accuracy_m = null, geo_purged_at = p_as_of
   where clock_in_at < p_as_of - interval '90 days' and geo_purged_at is null;
  get diagnostics v_purged = row_count;

  return query select v_added, v_purged;
end $$;

-- ---------------------------------------------------------------------------
-- hr.clock: the same matching rule as the timeline
-- ---------------------------------------------------------------------------

-- hr.clock as in 20261001110000, with the shift found as hr.attendance_timeline matches an
-- open session (was: from 2 h before the start to the end).
create or replace function hr.clock(p_action text, p_lat numeric default null, p_lng numeric default null,
                         p_accuracy_m numeric default null, p_client_ts timestamptz default null,
                         p_source text default 'online', p_key text default null)
returns table (attendance_id uuid, clock_in_at timestamptz, clock_out_at timestamptz,
               shift_id uuid, inside boolean, distance_m numeric, flags text[])
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker := hr.my_worker();
  v_at timestamptz;
  v_key text := coalesce(nullif(trim(p_key), ''), gen_random_uuid()::text);
  v_set hr.node_setting;
  v_dist numeric;
  v_inside boolean;
  v_att hr.attendance;
  v_shift uuid;
  v_flag text;
begin
  if p_action not in ('in', 'out') or p_source not in ('online', 'offline') then
    perform hr.fail('INVALID_ACTION', p_action || '/' || p_source);
  end if;
  if not core.can('ATTENDANCE', 'modify', v_w.org_node_id, null, v_w.owner_user_id) then
    perform hr.fail('NOT_AUTHORISED', 'cannot clock');
  end if;
  if (p_lat is null) <> (p_lng is null) or p_lat not between -90 and 90
     or p_lng not between -180 and 180 then
    perform hr.fail('INVALID_LOCATION');
  end if;

  -- Replays of the same punch (same device key) return the recorded result.
  select * into v_att from hr.attendance a
   where a.worker_id = v_w.id
     and ((p_action = 'in' and a.in_key = v_key) or (p_action = 'out' and a.out_key = v_key));
  if found then
    return query select v_att.id, v_att.clock_in_at, v_att.clock_out_at, v_att.shift_id,
      case p_action when 'in' then v_att.in_inside else v_att.out_inside end,
      case p_action when 'in' then v_att.in_distance_m else v_att.out_distance_m end,
      array(select e.kind from hr.attendance_exception e
             where e.attendance_id = v_att.id and e.phase = p_action order by e.kind);
    return;
  end if;

  if p_source = 'online' then
    v_at := now();
  elsif p_client_ts is null or p_client_ts > now() + interval '2 minutes'
        or p_client_ts < now() - interval '24 hours' then
    perform hr.fail('INVALID_TIMESTAMP', 'offline punches must be from the last 24 hours');
  else
    v_at := p_client_ts;
  end if;

  v_set := hr.geofence_for(v_w.org_node_id);
  if v_set.latitude is not null and p_lat is not null then
    v_dist := hr.distance_m(v_set.latitude, v_set.longitude, p_lat, p_lng);
    v_inside := v_dist <= v_set.geofence_radius_m;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hr.attendance:' || v_w.id, 0));
  if p_action = 'in' then
    if exists (select 1 from hr.attendance a where a.worker_id = v_w.id and a.clock_out_at is null) then
      perform hr.fail('ALREADY_CLOCKED_IN');
    end if;
    -- the worker's published shift this punch belongs to, as hr.attendance_timeline
    -- matches an open session: the shift it starts in, else the nearest within 30 minutes
    select s.id into v_shift
      from hr.shift_assignment a join hr.shift s on s.id = a.shift_id and s.status = 'published'
     where a.worker_id = v_w.id and a.status = 'assigned'
       and v_at between a.start_at - interval '30 minutes' and a.end_at + interval '30 minutes'
     order by (v_at >= a.start_at and v_at < a.end_at) desc,
              least(abs(extract(epoch from a.start_at - v_at)),
                    abs(extract(epoch from v_at - a.end_at)))
     limit 1;
    insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, shift_id,
                               clock_in_at, in_source, in_key, in_lat, in_lng, in_accuracy_m,
                               in_distance_m, in_inside)
    values (v_w.tenant_id, v_w.id, v_w.owner_user_id, v_w.org_node_id, v_shift, v_at, p_source,
            v_key, p_lat, p_lng, p_accuracy_m, v_dist, v_inside)
    returning * into v_att;
  else
    select * into v_att from hr.attendance a
     where a.worker_id = v_w.id and a.clock_out_at is null for update;
    if not found then
      perform hr.fail('NOT_CLOCKED_IN');
    end if;
    if v_at < v_att.clock_in_at then
      perform hr.fail('INVALID_TIMESTAMP', 'clock-out is before clock-in');
    end if;
    update hr.attendance a
       set clock_out_at = v_at, out_source = p_source, out_received_at = now(), out_key = v_key,
           out_lat = p_lat, out_lng = p_lng, out_accuracy_m = p_accuracy_m,
           out_distance_m = v_dist, out_inside = v_inside
     where a.id = v_att.id
    returning * into v_att;
  end if;

  if v_set.latitude is not null then
    v_flag := hr.flag_geo(v_att, p_action, v_inside, v_dist, v_set.geofence_radius_m);
  end if;
  return query select v_att.id, v_att.clock_in_at, v_att.clock_out_at, v_att.shift_id,
                      v_inside, v_dist, array_remove(array[v_flag], null);
end $$;

-- ---------------------------------------------------------------------------
-- The access audit names own login actions
-- ---------------------------------------------------------------------------

-- core.access_audit as in 20261004100000, plus: password changed, password change failed,
-- signed out of all devices.
drop function core.access_audit(int);
create function core.access_audit(p_limit int default 100)
returns table (occurred_at timestamptz, actor text, action text, person text,
               access_group text, place text, request_id uuid, note text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf, audit
as $$
begin
  if not core.can_any('USER_ACCESS', 'view') then
    perform wf.fail('NOT_AUTHORISED', 'USER_ACCESS view required');
  end if;
  return query
  with ev as (
    select l.occurred_at, l.actor_id, l.table_name, l.op, l.changed_fields, l.request_id,
           coalesce(l.after, l.before) as r, l.after
      from audit.log l
     where l.tenant_id = core.my_tenant()
       and l.table_name in ('core.role_assignment', 'core.app_user', 'hr.role_change',
                            'wf.step_instance', 'core.login_admin_event')
     order by l.occurred_at desc
     limit 5000),
  x as (
    select ev.occurred_at, ev.actor_id, ev.request_id,
           case ev.table_name
             when 'core.role_assignment' then
               case when ev.op = 'INSERT' then 'granted'
                    when ev.op = 'DELETE' then 'removed'
                    when 'effective_to' = any (ev.changed_fields) then 'ended'
                    when ev.changed_fields && array['group_id', 'node_id', 'effective_from',
                                                    'include_descendants'] then 'changed' end
             when 'core.app_user' then
               case when ev.op = 'INSERT' then 'user created'
                    when 'status' = any (ev.changed_fields) then
                      case ev.after ->> 'status' when 'inactive' then 'user deactivated'
                           else 'user reactivated' end
                    when ev.changed_fields && array['display_name', 'username', 'email',
                                                    'login_type'] then 'user changed' end
             when 'core.login_admin_event' then
               case ev.r ->> 'action' when 'reset_password' then 'password reset'
                    when 'disable_login' then 'login disabled'
                    when 'enable_login' then 'login enabled'
                    when 'change_own_password' then 'password changed'
                    when 'change_own_password_failed' then 'password change failed'
                    when 'sign_out_everywhere' then 'signed out of all devices' end
             when 'hr.role_change' then
               case when ev.op = 'INSERT' then 'role change requested'
                    when 'status' = any (ev.changed_fields)
                         and ev.after ->> 'status' in ('applied', 'rejected', 'cancelled')
                      then 'role change ' || (ev.after ->> 'status') end
             when 'wf.step_instance' then
               case when (ev.after ->> 'top_of_chain')::boolean
                         and ev.after ->> 'state' = 'approved'
                         and ev.changed_fields && array['state', 'top_of_chain']
                      then 'approved at the top of the chain'
                    when ev.r ->> 'domain_code' = 'USER_ACCESS' and 'state' = any (ev.changed_fields)
                         and ev.after ->> 'state' in ('approved', 'rejected')
                      then 'role change ' || (ev.after ->> 'state') || ' by approver' end
           end as action,
           case ev.table_name
             when 'core.role_assignment' then (ev.r ->> 'user_id')::uuid
             when 'core.app_user' then (ev.r ->> 'id')::uuid
             when 'core.login_admin_event' then (ev.r ->> 'user_id')::uuid
             when 'hr.role_change' then (ev.r ->> 'target_user_id')::uuid
             else coalesce((select rc.target_user_id from hr.role_change rc
                             where rc.wf_request_id = (ev.r ->> 'request_id')::uuid),
                           (ev.r ->> 'initiator_id')::uuid) end as person_id,
           case ev.table_name
             when 'core.role_assignment' then (ev.r ->> 'group_id')::uuid
             when 'hr.role_change' then (ev.r ->> 'group_id')::uuid
             when 'wf.step_instance' then (select rc.group_id from hr.role_change rc
                    where rc.wf_request_id = (ev.r ->> 'request_id')::uuid) end as group_id,
           case ev.table_name
             when 'core.role_assignment' then (ev.r ->> 'node_id')::uuid
             when 'hr.role_change' then (ev.r ->> 'node_id')::uuid
             when 'wf.step_instance' then coalesce((ev.r ->> 'org_node_id')::uuid,
                                                   (ev.r ->> 'delivery_node_id')::uuid)
             when 'core.login_admin_event' then core.home_node((ev.r ->> 'user_id')::uuid)
             else core.home_node((ev.r ->> 'id')::uuid) end as node_id,
           case ev.table_name
             when 'core.role_assignment' then
               case when ev.op = 'INSERT' then ev.r ->> 'source_note' end
             when 'wf.step_instance' then
               case when (ev.after ->> 'top_of_chain')::boolean
                      then 'top of chain: no higher approver ('
                           || (select rq.process_type from wf.request rq
                                where rq.id = (ev.r ->> 'request_id')::uuid)
                           || ' ' || (ev.r ->> 'step') || ')' end
           end as note
      from ev)
  select x.occurred_at, coalesce(a.display_name, 'Platform'), x.action, p.display_name, g.code,
         n.name, x.request_id, x.note
    from x
    left join core.app_user a on a.id = x.actor_id
    left join core.app_user p on p.id = x.person_id
    left join core.security_group g on g.id = x.group_id
    left join core.hierarchy_node n on n.id = x.node_id
   where x.action is not null and x.node_id is not null
     and core.in_user_access_scope(x.node_id, 'view')
   order by x.occurred_at desc
   limit least(greatest(p_limit, 1), 500);
end $$;
revoke execute on function core.access_audit(int) from public;
grant execute on function core.access_audit(int) to app_rw;

-- migrate:down
-- Forward-only (CLAUDE.md): this section exists for local rollback only.
drop function core.access_audit(int);
create function core.access_audit(p_limit int default 100)
returns table (occurred_at timestamptz, actor text, action text, person text,
               access_group text, place text, request_id uuid, note text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf, audit
as $$
begin
  if not core.can_any('USER_ACCESS', 'view') then
    perform wf.fail('NOT_AUTHORISED', 'USER_ACCESS view required');
  end if;
  return query
  with ev as (
    select l.occurred_at, l.actor_id, l.table_name, l.op, l.changed_fields, l.request_id,
           coalesce(l.after, l.before) as r, l.after
      from audit.log l
     where l.tenant_id = core.my_tenant()
       and l.table_name in ('core.role_assignment', 'core.app_user', 'hr.role_change',
                            'wf.step_instance', 'core.login_admin_event')
     order by l.occurred_at desc
     limit 5000),
  x as (
    select ev.occurred_at, ev.actor_id, ev.request_id,
           case ev.table_name
             when 'core.role_assignment' then
               case when ev.op = 'INSERT' then 'granted'
                    when ev.op = 'DELETE' then 'removed'
                    when 'effective_to' = any (ev.changed_fields) then 'ended'
                    when ev.changed_fields && array['group_id', 'node_id', 'effective_from',
                                                    'include_descendants'] then 'changed' end
             when 'core.app_user' then
               case when ev.op = 'INSERT' then 'user created'
                    when 'status' = any (ev.changed_fields) then
                      case ev.after ->> 'status' when 'inactive' then 'user deactivated'
                           else 'user reactivated' end
                    when ev.changed_fields && array['display_name', 'username', 'email',
                                                    'login_type'] then 'user changed' end
             when 'core.login_admin_event' then
               case ev.r ->> 'action' when 'reset_password' then 'password reset'
                    when 'disable_login' then 'login disabled'
                    when 'enable_login' then 'login enabled' end
             when 'hr.role_change' then
               case when ev.op = 'INSERT' then 'role change requested'
                    when 'status' = any (ev.changed_fields)
                         and ev.after ->> 'status' in ('applied', 'rejected', 'cancelled')
                      then 'role change ' || (ev.after ->> 'status') end
             when 'wf.step_instance' then
               case when (ev.after ->> 'top_of_chain')::boolean
                         and ev.after ->> 'state' = 'approved'
                         and ev.changed_fields && array['state', 'top_of_chain']
                      then 'approved at the top of the chain'
                    when ev.r ->> 'domain_code' = 'USER_ACCESS' and 'state' = any (ev.changed_fields)
                         and ev.after ->> 'state' in ('approved', 'rejected')
                      then 'role change ' || (ev.after ->> 'state') || ' by approver' end
           end as action,
           case ev.table_name
             when 'core.role_assignment' then (ev.r ->> 'user_id')::uuid
             when 'core.app_user' then (ev.r ->> 'id')::uuid
             when 'core.login_admin_event' then (ev.r ->> 'user_id')::uuid
             when 'hr.role_change' then (ev.r ->> 'target_user_id')::uuid
             else coalesce((select rc.target_user_id from hr.role_change rc
                             where rc.wf_request_id = (ev.r ->> 'request_id')::uuid),
                           (ev.r ->> 'initiator_id')::uuid) end as person_id,
           case ev.table_name
             when 'core.role_assignment' then (ev.r ->> 'group_id')::uuid
             when 'hr.role_change' then (ev.r ->> 'group_id')::uuid
             when 'wf.step_instance' then (select rc.group_id from hr.role_change rc
                    where rc.wf_request_id = (ev.r ->> 'request_id')::uuid) end as group_id,
           case ev.table_name
             when 'core.role_assignment' then (ev.r ->> 'node_id')::uuid
             when 'hr.role_change' then (ev.r ->> 'node_id')::uuid
             when 'wf.step_instance' then coalesce((ev.r ->> 'org_node_id')::uuid,
                                                   (ev.r ->> 'delivery_node_id')::uuid)
             when 'core.login_admin_event' then core.home_node((ev.r ->> 'user_id')::uuid)
             else core.home_node((ev.r ->> 'id')::uuid) end as node_id,
           case ev.table_name
             when 'core.role_assignment' then
               case when ev.op = 'INSERT' then ev.r ->> 'source_note' end
             when 'wf.step_instance' then
               case when (ev.after ->> 'top_of_chain')::boolean
                      then 'top of chain: no higher approver ('
                           || (select rq.process_type from wf.request rq
                                where rq.id = (ev.r ->> 'request_id')::uuid)
                           || ' ' || (ev.r ->> 'step') || ')' end
           end as note
      from ev)
  select x.occurred_at, coalesce(a.display_name, 'Platform'), x.action, p.display_name, g.code,
         n.name, x.request_id, x.note
    from x
    left join core.app_user a on a.id = x.actor_id
    left join core.app_user p on p.id = x.person_id
    left join core.security_group g on g.id = x.group_id
    left join core.hierarchy_node n on n.id = x.node_id
   where x.action is not null and x.node_id is not null
     and core.in_user_access_scope(x.node_id, 'view')
   order by x.occurred_at desc
   limit least(greatest(p_limit, 1), 500);
end $$;
revoke execute on function core.access_audit(int) from public;
grant execute on function core.access_audit(int) to app_rw;
create or replace function hr.clock(p_action text, p_lat numeric default null, p_lng numeric default null,
                         p_accuracy_m numeric default null, p_client_ts timestamptz default null,
                         p_source text default 'online', p_key text default null)
returns table (attendance_id uuid, clock_in_at timestamptz, clock_out_at timestamptz,
               shift_id uuid, inside boolean, distance_m numeric, flags text[])
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker := hr.my_worker();
  v_at timestamptz;
  v_key text := coalesce(nullif(trim(p_key), ''), gen_random_uuid()::text);
  v_set hr.node_setting;
  v_dist numeric;
  v_inside boolean;
  v_att hr.attendance;
  v_shift uuid;
  v_flag text;
begin
  if p_action not in ('in', 'out') or p_source not in ('online', 'offline') then
    perform hr.fail('INVALID_ACTION', p_action || '/' || p_source);
  end if;
  if not core.can('ATTENDANCE', 'modify', v_w.org_node_id, null, v_w.owner_user_id) then
    perform hr.fail('NOT_AUTHORISED', 'cannot clock');
  end if;
  if (p_lat is null) <> (p_lng is null) or p_lat not between -90 and 90
     or p_lng not between -180 and 180 then
    perform hr.fail('INVALID_LOCATION');
  end if;

  -- Replays of the same punch (same device key) return the recorded result.
  select * into v_att from hr.attendance a
   where a.worker_id = v_w.id
     and ((p_action = 'in' and a.in_key = v_key) or (p_action = 'out' and a.out_key = v_key));
  if found then
    return query select v_att.id, v_att.clock_in_at, v_att.clock_out_at, v_att.shift_id,
      case p_action when 'in' then v_att.in_inside else v_att.out_inside end,
      case p_action when 'in' then v_att.in_distance_m else v_att.out_distance_m end,
      array(select e.kind from hr.attendance_exception e
             where e.attendance_id = v_att.id and e.phase = p_action order by e.kind);
    return;
  end if;

  if p_source = 'online' then
    v_at := now();
  elsif p_client_ts is null or p_client_ts > now() + interval '2 minutes'
        or p_client_ts < now() - interval '24 hours' then
    perform hr.fail('INVALID_TIMESTAMP', 'offline punches must be from the last 24 hours');
  else
    v_at := p_client_ts;
  end if;

  v_set := hr.geofence_for(v_w.org_node_id);
  if v_set.latitude is not null and p_lat is not null then
    v_dist := hr.distance_m(v_set.latitude, v_set.longitude, p_lat, p_lng);
    v_inside := v_dist <= v_set.geofence_radius_m;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hr.attendance:' || v_w.id, 0));
  if p_action = 'in' then
    if exists (select 1 from hr.attendance a where a.worker_id = v_w.id and a.clock_out_at is null) then
      perform hr.fail('ALREADY_CLOCKED_IN');
    end if;
    -- the worker's published shift this punch belongs to: from 2 h before start to its end
    select s.id into v_shift
      from hr.shift_assignment a join hr.shift s on s.id = a.shift_id and s.status = 'published'
     where a.worker_id = v_w.id and a.status = 'assigned'
       and v_at between a.start_at - interval '2 hours' and a.end_at
     order by abs(extract(epoch from a.start_at - v_at))
     limit 1;
    insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, shift_id,
                               clock_in_at, in_source, in_key, in_lat, in_lng, in_accuracy_m,
                               in_distance_m, in_inside)
    values (v_w.tenant_id, v_w.id, v_w.owner_user_id, v_w.org_node_id, v_shift, v_at, p_source,
            v_key, p_lat, p_lng, p_accuracy_m, v_dist, v_inside)
    returning * into v_att;
  else
    select * into v_att from hr.attendance a
     where a.worker_id = v_w.id and a.clock_out_at is null for update;
    if not found then
      perform hr.fail('NOT_CLOCKED_IN');
    end if;
    if v_at < v_att.clock_in_at then
      perform hr.fail('INVALID_TIMESTAMP', 'clock-out is before clock-in');
    end if;
    update hr.attendance a
       set clock_out_at = v_at, out_source = p_source, out_received_at = now(), out_key = v_key,
           out_lat = p_lat, out_lng = p_lng, out_accuracy_m = p_accuracy_m,
           out_distance_m = v_dist, out_inside = v_inside
     where a.id = v_att.id
    returning * into v_att;
  end if;

  if v_set.latitude is not null then
    v_flag := hr.flag_geo(v_att, p_action, v_inside, v_dist, v_set.geofence_radius_m);
  end if;
  return query select v_att.id, v_att.clock_in_at, v_att.clock_out_at, v_att.shift_id,
                      v_inside, v_dist, array_remove(array[v_flag], null);
end $$;
create or replace function hr.nightly_attendance(p_as_of timestamptz default now(), p_days int default 2)
returns table (exceptions int, purged int)
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_added int := 0;
  v_n int;
  v_purged int;
begin
  -- late: clocked in for the shift more than the tenant's late threshold after its start
  insert into hr.attendance_exception (tenant_id, org_node_id, worker_id, owner_user_id,
                                       shift_id, attendance_id, local_date, kind, detail)
  select a.tenant_id, a.org_node_id, a.worker_id, a.owner_user_id, s.id, a.id, s.local_date,
         'late', jsonb_build_object('minutes', floor(extract(epoch from a.clock_in_at - s.start_at) / 60))
    from hr.attendance a
    join hr.shift s on s.id = a.shift_id
   where s.local_date >= (p_as_of at time zone hr.node_tz(s.org_node_id))::date - p_days
     and s.start_at < p_as_of
     and a.clock_in_at > s.start_at
                         + make_interval(mins => (hr.roster_rules(a.tenant_id)).late_threshold_min)
  on conflict on constraint attendance_exception_key do nothing;
  get diagnostics v_n = row_count;
  v_added := v_added + v_n;

  -- no_show: a published, still-assigned shift that ended with no punch for it
  insert into hr.attendance_exception (tenant_id, org_node_id, worker_id, owner_user_id,
                                       shift_id, local_date, kind)
  select sa.tenant_id, s.org_node_id, sa.worker_id, sa.owner_user_id, s.id, s.local_date, 'no_show'
    from hr.shift_assignment sa
    join hr.shift s on s.id = sa.shift_id and s.status = 'published'
   where sa.status = 'assigned'
     and s.end_at <= p_as_of
     and s.local_date >= (p_as_of at time zone hr.node_tz(s.org_node_id))::date - p_days
     and not exists (select 1 from hr.attendance a
                      where a.worker_id = sa.worker_id and a.shift_id = s.id)
  on conflict on constraint attendance_exception_key do nothing;
  get diagnostics v_n = row_count;
  v_added := v_added + v_n;

  -- missing_clock_out: still open 4 h after the shift ended (16 h after an unscheduled punch)
  insert into hr.attendance_exception (tenant_id, org_node_id, worker_id, owner_user_id,
                                       shift_id, attendance_id, local_date, kind)
  select a.tenant_id, a.org_node_id, a.worker_id, a.owner_user_id, a.shift_id, a.id,
         (a.clock_in_at at time zone hr.node_tz(a.org_node_id))::date, 'missing_clock_out'
    from hr.attendance a
    left join hr.shift s on s.id = a.shift_id
   where a.clock_out_at is null
     and coalesce(s.end_at + interval '4 hours', a.clock_in_at + interval '16 hours') <= p_as_of
  on conflict on constraint attendance_exception_key do nothing;
  get diagnostics v_n = row_count;
  v_added := v_added + v_n;

  -- unscheduled: a punch that matched no rostered shift
  insert into hr.attendance_exception (tenant_id, org_node_id, worker_id, owner_user_id,
                                       attendance_id, local_date, kind)
  select a.tenant_id, a.org_node_id, a.worker_id, a.owner_user_id, a.id,
         (a.clock_in_at at time zone hr.node_tz(a.org_node_id))::date, 'unscheduled'
    from hr.attendance a
   where a.shift_id is null
     and a.clock_in_at < p_as_of
     and (a.clock_in_at at time zone hr.node_tz(a.org_node_id))::date
         >= (p_as_of at time zone hr.node_tz(a.org_node_id))::date - p_days
  on conflict on constraint attendance_exception_key do nothing;
  get diagnostics v_n = row_count;
  v_added := v_added + v_n;

  -- data minimisation (ADR 008): raw coordinates kept 90 days; distance and flag stay
  update hr.attendance
     set in_lat = null, in_lng = null, in_accuracy_m = null,
         out_lat = null, out_lng = null, out_accuracy_m = null, geo_purged_at = p_as_of
   where clock_in_at < p_as_of - interval '90 days' and geo_purged_at is null;
  get diagnostics v_purged = row_count;

  return query select v_added, v_purged;
end $$;

drop function hr.my_timeline(date, date);
drop function hr.worker_timeline(uuid, date, date);
drop function hr.timeline_rows(hr.worker, date, date, timestamptz);
drop function hr.attendance_timeline(jsonb, jsonb, int, int, timestamptz);
delete from hr.attendance_exception where kind = 'left_early';
alter table hr.attendance_exception drop constraint attendance_exception_kind_check;
alter table hr.attendance_exception add constraint attendance_exception_kind_check
  check (kind in ('late', 'no_show', 'missing_clock_out', 'unscheduled', 'outside_geofence',
                  'no_location'));
drop function hr.roster_rules(uuid);
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
alter table hr.roster_setting drop column extra_time_min_minutes;
drop function hr.set_place_location(uuid, numeric, numeric, int);
drop function hr.location_places();
drop function hr.can_set_location(uuid);
alter table hr.node_setting drop constraint node_setting_set_in_app,
  drop column set_in_app_at, drop column set_in_app_by;
drop function core.record_own_password_change(boolean);
drop function core.sign_out_everywhere();
drop function core.my_sessions_valid_from();
drop function core.my_access();
drop function core.my_profile();
delete from core.login_admin_event
 where action in ('change_own_password', 'change_own_password_failed', 'sign_out_everywhere');
alter table core.login_admin_event drop constraint login_admin_event_action_check;
alter table core.login_admin_event add constraint login_admin_event_action_check
  check (action in ('reset_password', 'disable_login', 'enable_login'));
alter table core.app_user drop column sessions_valid_from;
