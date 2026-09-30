-- migrate:up
-- Attendance (docs/LLD.md sections 5 and 7, ADR 008).
--
-- hr.clock: clock in/out for the current user's worker, idempotent on the device's key.
-- Online punches use the server time; offline punches (replayed from the device queue)
-- keep the device time, if at most 24 h old and not in the future. Location is checked
-- against the home node's geofence: outside the radius, or no location, is recorded and
-- raised as an exception, never blocked.
-- hr.nightly_attendance (wf_executor, systemd timer): late, no_show, missing_clock_out and
-- unscheduled exceptions for recent local days, and the 90-day purge of raw coordinates.

-- Great-circle distance in metres (haversine).
create function hr.distance_m(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric)
returns numeric
language sql immutable parallel safe as $$
  select round((2 * 6371000 * asin(sqrt(
      power(sin(radians(p_lat2 - p_lat1) / 2), 2)
      + cos(radians(p_lat1)) * cos(radians(p_lat2)) * power(sin(radians(p_lng2 - p_lng1) / 2), 2)
    )))::numeric, 1);
$$;

-- Records a geofence exception for one punch (idempotent).
create function hr.flag_geo(p_att hr.attendance, p_phase text, p_inside boolean, p_distance numeric,
                            p_radius int) returns text
language plpgsql
set search_path = pg_catalog, hr
as $$
declare
  v_kind text := case when p_inside is null then 'no_location' when not p_inside then 'outside_geofence' end;
begin
  if v_kind is null then
    return null;
  end if;
  insert into hr.attendance_exception (tenant_id, org_node_id, worker_id, owner_user_id,
                                       shift_id, attendance_id, local_date, kind, phase, detail)
  values (p_att.tenant_id, p_att.org_node_id, p_att.worker_id, p_att.owner_user_id,
          p_att.shift_id, p_att.id,
          ((case p_phase when 'in' then p_att.clock_in_at else p_att.clock_out_at end)
             at time zone hr.node_tz(p_att.org_node_id))::date,
          v_kind, p_phase,
          jsonb_strip_nulls(jsonb_build_object('distance_m', p_distance, 'radius_m', p_radius)))
  on conflict on constraint attendance_exception_key do nothing;
  return v_kind;
end $$;

revoke execute on function hr.flag_geo(hr.attendance, text, boolean, numeric, int) from public;

-- Clock in ('in') or out ('out'). Returns the attendance row's state after the punch and
-- the exceptions it raised ('outside_geofence', 'no_location').
create function hr.clock(p_action text, p_lat numeric default null, p_lng numeric default null,
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

  select * into v_set from hr.node_setting where org_node_id = v_w.org_node_id;
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

-- Managers resolve or dismiss an exception at a node where they hold ATTENDANCE modify.
-- Their own exceptions go to someone else (segregation of duties).
create function hr.resolve_exception(p_id uuid, p_status text, p_note text default null)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_e hr.attendance_exception;
begin
  select * into v_e from hr.attendance_exception
   where id = p_id and tenant_id = core.my_tenant() for update;
  if not found then
    perform hr.fail('NOT_FOUND', 'exception');
  end if;
  perform hr.require('ATTENDANCE', 'modify', v_e.org_node_id);
  if v_e.owner_user_id = core.current_user_id() then
    perform hr.fail('SEGREGATION_OF_DUTIES', 'someone else resolves your own exceptions');
  end if;
  if p_status not in ('resolved', 'dismissed') then
    perform hr.fail('INVALID_ACTION', p_status);
  end if;
  if v_e.status = p_status then
    return;
  end if;
  if v_e.status <> 'open' then
    perform hr.fail('INVALID_STATE', 'already ' || v_e.status);
  end if;
  update hr.attendance_exception
     set status = p_status, resolution_note = nullif(trim(p_note), ''),
         resolved_by = core.current_user_id(), resolved_at = now()
   where id = p_id;
end $$;

-- The nightly job. Looks at shifts and punches from the last p_days local days per node
-- (idempotent: existing exceptions are kept as they are) and nulls raw coordinates on
-- punches older than 90 days. Returns how many exceptions were added and rows purged.
create function hr.nightly_attendance(p_as_of timestamptz default now(), p_days int default 2)
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

revoke execute on function hr.clock(text, numeric, numeric, numeric, timestamptz, text, text),
  hr.resolve_exception(uuid, text, text), hr.nightly_attendance(timestamptz, int),
  hr.distance_m(numeric, numeric, numeric, numeric) from public;
grant execute on function hr.clock(text, numeric, numeric, numeric, timestamptz, text, text),
  hr.resolve_exception(uuid, text, text) to app_rw;
grant execute on function hr.nightly_attendance(timestamptz, int) to wf_executor;

-- migrate:down
drop function hr.nightly_attendance(timestamptz, int);
drop function hr.resolve_exception(uuid, text, text);
drop function hr.clock(text, numeric, numeric, numeric, timestamptz, text, text);
drop function hr.flag_geo(hr.attendance, text, boolean, numeric, int);
drop function hr.distance_m(numeric, numeric, numeric, numeric);
