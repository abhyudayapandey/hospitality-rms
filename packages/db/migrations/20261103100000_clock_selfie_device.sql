-- migrate:up

-- Clock-in records the device and a selfie (ATT-7, ADR 045).
--
--   * The device is a random id kept in the phone's browser (browsers give no hardware id)
--     with the phone model. A device the person has not used before is flagged "new device"
--     once their first week is over (a phone change in the first week is normal), and one
--     device used by several people on one day is flagged "shared device" on every punch
--     that used it. Flags go to the exceptions screen and never block a clock-in.
--   * The selfie is taken at clock-in only. A phone with no camera clocks in and is flagged
--     "no selfie", as a missing location is.
--   * Selfies are personnel data: seen by HR, the head of the person's department and the
--     person (a new ATTENDANCE_SELFIES domain), never by the GM or the area manager; kept
--     under the NFR Data retention rule and purged nightly.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

alter table hr.attendance
  add column in_device_id text check (in_device_id is null or in_device_id ~ '^[A-Za-z0-9._-]{1,80}$'),
  add column in_device_model text check (in_device_model is null or length(in_device_model) <= 80);

-- The selfie of a clock-in, in a table of its own so that it follows its own domain: the
-- people who see attendance do not all see faces.
create table hr.attendance_selfie (
  id uuid primary key default core.uuid_v7(),
  attendance_id uuid not null references hr.attendance(id),
  worker_id uuid not null references hr.worker(id),
  owner_user_id uuid not null references core.app_user(id),
  org_node_id uuid not null references core.hierarchy_node(id),
  selfie_key text,                       -- null once purged
  purged_at timestamptz,
  check ((selfie_key is null) = (purged_at is not null))
);
select core.add_standard_columns('hr.attendance_selfie');
alter table hr.attendance_selfie add constraint attendance_selfie_one unique (attendance_id);

-- The devices each person has clocked in with.
create table hr.worker_device (
  id uuid primary key default core.uuid_v7(),
  worker_id uuid not null references hr.worker(id),
  owner_user_id uuid not null references core.app_user(id),
  org_node_id uuid not null references core.hierarchy_node(id),
  device_id text not null check (device_id ~ '^[A-Za-z0-9._-]{1,80}$'),
  model text check (model is null or length(model) <= 80),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null
);
select core.add_standard_columns('hr.worker_device');
alter table hr.worker_device add constraint worker_device_one unique (worker_id, device_id);

alter table hr.attendance_exception drop constraint attendance_exception_kind_check;
alter table hr.attendance_exception add constraint attendance_exception_kind_check
  check (kind in ('late', 'left_early', 'no_show', 'missing_clock_out', 'unscheduled',
                  'outside_geofence', 'no_location', 'no_selfie', 'new_device', 'shared_device'));

-- ---------------------------------------------------------------------------
-- Retention (NFR Data retention, decided 3 Oct)
-- ---------------------------------------------------------------------------

-- Personnel data is kept for at least one year and back to the start of the previous
-- calendar year and the start of the previous financial year (1 April), whichever is
-- earliest. In September 2026 that is 1 January 2025.
create function hr.personnel_cutoff(p_today date) returns date
language sql immutable
set search_path = pg_catalog
as $$
  select least(
    (p_today - interval '1 year')::date,
    make_date(extract(year from p_today)::int - 1, 1, 1),
    make_date(extract(year from p_today)::int
              - case when extract(month from p_today) >= 4 then 1 else 2 end, 4, 1));
$$;

-- Removes selfies and devices older than the cut-off; the clock-in itself stays. Run
-- nightly by the executor. Returns how many selfies and devices were removed.
create function hr.purge_personnel(p_as_of timestamptz default now()) returns integer
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_cut timestamptz := hr.personnel_cutoff((p_as_of at time zone 'UTC')::date)::timestamp
                       at time zone 'UTC';
  v_selfies int;
  v_devices int;
begin
  update hr.attendance_selfie s set selfie_key = null, purged_at = p_as_of
   where s.selfie_key is not null
     and exists (select 1 from hr.attendance a
                  where a.id = s.attendance_id and a.clock_in_at < v_cut);
  get diagnostics v_selfies = row_count;
  delete from hr.worker_device where last_seen_at < v_cut;
  get diagnostics v_devices = row_count;
  return v_selfies + v_devices;
end $$;
revoke execute on function hr.personnel_cutoff(date), hr.purge_personnel(timestamptz) from public;
grant execute on function hr.purge_personnel(timestamptz) to wf_executor;

-- ---------------------------------------------------------------------------
-- Clocking in
-- ---------------------------------------------------------------------------

-- Adds an exception of one kind to a punch (not blocking); the same punch and kind once.
create function hr.flag_kind(p_att hr.attendance, p_phase text, p_kind text, p_detail jsonb)
returns text
language plpgsql
set search_path = pg_catalog, hr
as $$
begin
  insert into hr.attendance_exception (tenant_id, org_node_id, worker_id, owner_user_id,
                                       shift_id, attendance_id, local_date, kind, phase, detail)
  values (p_att.tenant_id, p_att.org_node_id, p_att.worker_id, p_att.owner_user_id,
          p_att.shift_id, p_att.id,
          (p_att.clock_in_at at time zone hr.node_tz(p_att.org_node_id))::date,
          p_kind, p_phase, coalesce(p_detail, '{}'))
  on conflict on constraint attendance_exception_key do nothing;
  return p_kind;
end $$;
revoke execute on function hr.flag_kind(hr.attendance, text, text, jsonb) from public;

-- hr.clock, as before, with the device and the selfie of a clock-in. p_selfie_key is a key
-- under selfies/<company>/<place>/ that the phone has uploaded (a presigned POST); clock-out
-- takes no selfie.
drop function hr.clock(text, numeric, numeric, numeric, timestamptz, text, text);
create function hr.clock(p_action text, p_lat numeric default null, p_lng numeric default null,
                         p_accuracy_m numeric default null, p_client_ts timestamptz default null,
                         p_source text default 'online', p_key text default null,
                         p_device_id text default null, p_device_model text default null,
                         p_selfie_key text default null)
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
  v_flags text[] := '{}';
  v_day date;
  v_other hr.attendance;
  v_first timestamptz;
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
  if p_device_id is not null and p_device_id !~ '^[A-Za-z0-9._-]{1,80}$' then
    perform hr.fail('INVALID_DEVICE');
  end if;
  if p_selfie_key is not null
     and p_selfie_key !~ format('^selfies/%s/%s/[0-9a-f-]{36}\.(jpg|png|webp)$',
                                v_w.tenant_id, v_w.org_node_id) then
    perform hr.fail('INVALID_PHOTO', 'selfie was not uploaded for this place');
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
                               in_distance_m, in_inside, in_device_id, in_device_model)
    values (v_w.tenant_id, v_w.id, v_w.owner_user_id, v_w.org_node_id, v_shift, v_at, p_source,
            v_key, p_lat, p_lng, p_accuracy_m, v_dist, v_inside, p_device_id,
            nullif(left(trim(p_device_model), 80), ''))
    returning * into v_att;

    -- the selfie, or a flag for a phone with no camera (never blocking)
    if p_selfie_key is not null then
      insert into hr.attendance_selfie (tenant_id, attendance_id, worker_id, owner_user_id,
                                        org_node_id, selfie_key)
      values (v_w.tenant_id, v_att.id, v_w.id, v_w.owner_user_id, v_w.org_node_id, p_selfie_key);
    else
      v_flags := v_flags || hr.flag_kind(v_att, 'in', 'no_selfie', null);
    end if;

    -- the device: new after the first week, shared within the day
    if p_device_id is not null then
      select min(d.first_seen_at) into v_first from hr.worker_device d where d.worker_id = v_w.id;
      if not exists (select 1 from hr.worker_device d
                      where d.worker_id = v_w.id and d.device_id = p_device_id) then
        if v_first is not null and v_first <= v_at - interval '7 days' then
          v_flags := v_flags || hr.flag_kind(v_att, 'in', 'new_device',
                       jsonb_build_object('device_model', v_att.in_device_model));
        end if;
        insert into hr.worker_device (tenant_id, worker_id, owner_user_id, org_node_id, device_id,
                                      model, first_seen_at, last_seen_at)
        values (v_w.tenant_id, v_w.id, v_w.owner_user_id, v_w.org_node_id, p_device_id,
                v_att.in_device_model, v_at, v_at);
      else
        update hr.worker_device
           set last_seen_at = greatest(last_seen_at, v_at),
               model = coalesce(v_att.in_device_model, model)
         where worker_id = v_w.id and device_id = p_device_id;
      end if;
      v_day := (v_at at time zone hr.node_tz(v_w.org_node_id))::date;
      for v_other in
        select a.* from hr.attendance a
         where a.tenant_id = v_w.tenant_id and a.in_device_id = p_device_id
           and a.worker_id <> v_w.id
           and (a.clock_in_at at time zone hr.node_tz(a.org_node_id))::date = v_day
      loop
        v_flags := v_flags || hr.flag_kind(v_att, 'in', 'shared_device',
                     jsonb_build_object('device_model', v_att.in_device_model));
        perform hr.flag_kind(v_other, 'in', 'shared_device',
                     jsonb_build_object('device_model', v_other.in_device_model));
      end loop;
    end if;
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
                      v_inside, v_dist,
                      array(select distinct f from unnest(array_remove(array[v_flag], null) || v_flags) f
                             order by f);
end $$;
revoke execute on function hr.clock(text, numeric, numeric, numeric, timestamptz, text, text,
                                    text, text, text) from public;
grant execute on function hr.clock(text, numeric, numeric, numeric, timestamptz, text, text,
                                   text, text, text) to app_rw;

-- ---------------------------------------------------------------------------
-- Seeing a selfie
-- ---------------------------------------------------------------------------

-- The key of a clock-in's selfie, for whoever may see it: HR, the head of the person's
-- department and the person (ATTENDANCE_SELFIES). Null when there is none or it has been
-- purged; NOT_AUTHORISED for anyone else, however much of attendance they see.
create function hr.selfie_of(p_attendance uuid) returns text
language plpgsql stable security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_a hr.attendance;
  v_key text;
begin
  perform hr.my_worker();
  select * into v_a from hr.attendance where id = p_attendance and tenant_id = core.my_tenant();
  if not found
     or not core.can('ATTENDANCE_SELFIES', 'view', v_a.org_node_id, null, v_a.owner_user_id) then
    perform hr.fail('NOT_AUTHORISED', 'selfie');
  end if;
  select s.selfie_key into v_key from hr.attendance_selfie s where s.attendance_id = p_attendance;
  return v_key;
end $$;
revoke execute on function hr.selfie_of(uuid) from public;
grant execute on function hr.selfie_of(uuid) to app_rw;

-- The selfies of a list of exceptions, for the people who may see them: exception id and
-- selfie key. Others get nothing, and no error, so the exceptions screen needs no second path.
create function hr.exception_selfies(p_exceptions uuid[])
returns table (exception_id uuid, attendance_id uuid, selfie_key text)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select e.id, e.attendance_id, s.selfie_key
    from hr.attendance_exception e
    join hr.attendance_selfie s on s.attendance_id = e.attendance_id
   where e.id = any (p_exceptions) and e.tenant_id = core.my_tenant()
     and s.selfie_key is not null
     and core.can('ATTENDANCE_SELFIES', 'view', s.org_node_id, null, s.owner_user_id);
$$;
revoke execute on function hr.exception_selfies(uuid[]) from public;
grant execute on function hr.exception_selfies(uuid[]) to app_rw;

-- ---------------------------------------------------------------------------
-- RLS registration (rule 1), audit (rule 5)
-- ---------------------------------------------------------------------------

insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only, owner_column) values
  ('hr.attendance_selfie', 'ATTENDANCE_SELFIES', 'org', true, 'owner_user_id'),
  ('hr.worker_device', 'ATTENDANCE', 'org', true, 'owner_user_id');
select core.apply_domain_rls('hr.attendance_selfie');
select core.apply_domain_rls('hr.worker_device');
select audit.enable('hr.attendance_selfie');
select audit.enable('hr.worker_device');

-- migrate:down
drop function hr.exception_selfies(uuid[]);
drop function hr.selfie_of(uuid);
drop function hr.clock(text, numeric, numeric, numeric, timestamptz, text, text, text, text, text);
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
revoke execute on function hr.clock(text, numeric, numeric, numeric, timestamptz, text, text) from public;
grant execute on function hr.clock(text, numeric, numeric, numeric, timestamptz, text, text) to app_rw;
drop function hr.purge_personnel(timestamptz);
drop function hr.personnel_cutoff(date);
drop function hr.flag_kind(hr.attendance, text, text, jsonb);
delete from hr.attendance_exception where kind in ('no_selfie', 'new_device', 'shared_device');
alter table hr.attendance_exception drop constraint attendance_exception_kind_check;
alter table hr.attendance_exception add constraint attendance_exception_kind_check
  check (kind in ('late', 'left_early', 'no_show', 'missing_clock_out', 'unscheduled',
                  'outside_geofence', 'no_location'));
delete from core.domain_table where table_name::text in ('hr.attendance_selfie', 'hr.worker_device');
drop table hr.worker_device;
drop table hr.attendance_selfie;
alter table hr.attendance drop column in_device_model, drop column in_device_id;
