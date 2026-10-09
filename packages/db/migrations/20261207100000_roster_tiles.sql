-- migrate:up
-- The roster as tiles, shift types and "repeat this pattern" (GM feedback item 4, ADR 082).
--
-- 1. Shift types (file 16): straight (one block), split (two blocks with a break between,
--    11:00-15:00 and 18:00-23:00) and panzer (the late evening or overnight shift, from about
--    18:00-19:00 to 03:00-04:00, one block across midnight). A template may also name an unpaid
--    break in minutes. A split shift is one shift from the first block's start to the second's
--    end with the gap as its break, so it is one shift worked (ADR 057: a shift is a person on
--    a shift), each block is its own clock-in and clock-out on that shift (the timeline already
--    pairs several on one shift), and its rostered hours leave the break out. A shift from a
--    template takes its type and break (a trigger, so every way shifts are made does).
-- 2. Rostered hours leave the break out everywhere they are summed: the weekly hours rule
--    and its warning, the assign candidates, the labour report, the People report and My week.
--    Worked hours come from the clock-ins, so they never held the break.
-- 3. The tiles: hr.set_day_shift puts one person on one of their department's shift types for a
--    day, or Off. It takes them off whatever they had that day there, finds or makes the day's
--    shift from the template (a draft until the week is published) and assigns them through
--    hr.assign, so every roster rule runs again; a shift already full takes one more, since the
--    manager chose it. hr.roster_day lists the department's people and shift types for a day.
-- 4. hr.repeat_pattern copies one week's assignments onto the same weekdays from one date to
--    another (eight weeks at most): each through hr.assign; what a rule refuses, or warns about,
--    is skipped and listed, never assigned silently.

-- ---------------------------------------------------------------------------
-- 1. Shift types
-- ---------------------------------------------------------------------------

alter table hr.shift_template
  add column shift_type text not null default 'straight'
    constraint shift_template_type check (shift_type in ('straight', 'split', 'panzer')),
  add column first_end time,
  add column second_start time,
  add column break_minutes int not null default 0
    constraint shift_template_break check (break_minutes between 0 and 240),
  add constraint shift_template_shape check (
    case shift_type
      when 'straight' then first_end is null and second_start is null
      when 'split' then first_end is not null and second_start is not null
                        and start_time < first_end and first_end < second_start
                        and second_start < end_time
      when 'panzer' then first_end is null and second_start is null
                         and start_time between time '17:00' and time '21:00'
                         and end_time between time '01:00' and time '05:00'
    end);

alter table hr.shift
  add column shift_type text not null default 'straight'
    constraint shift_type_check check (shift_type in ('straight', 'split', 'panzer')),
  add column break_minutes int not null default 0 constraint shift_break check (break_minutes >= 0),
  add column split_end_at timestamptz,     -- a split shift: when its first block ends
  add column split_start_at timestamptz,   -- and when its second starts
  add constraint shift_split check (
    (shift_type = 'split') = (split_end_at is not null and split_start_at is not null)
    and (split_end_at is null or (start_at < split_end_at and split_end_at < split_start_at
                                  and split_start_at < end_at))),
  add constraint shift_break_fits check (break_minutes * interval '1 minute' < end_at - start_at);

-- A shift from a template takes its type and break.
create function hr.shift_type_from_template() returns trigger
language plpgsql
set search_path = pg_catalog, hr
as $$
declare
  v_t hr.shift_template;
  v_tz text;
begin
  if new.template_id is null then
    return new;
  end if;
  select * into v_t from hr.shift_template where id = new.template_id;
  v_tz := hr.node_tz(new.org_node_id);
  new.shift_type := v_t.shift_type;
  if v_t.shift_type = 'split' then
    new.split_end_at := (new.local_date + v_t.first_end) at time zone v_tz;
    new.split_start_at := (new.local_date + v_t.second_start) at time zone v_tz;
    new.break_minutes := v_t.break_minutes
      + (extract(epoch from v_t.second_start - v_t.first_end) / 60)::int;
  else
    new.break_minutes := v_t.break_minutes;
  end if;
  return new;
end $$;
create trigger b_shift_type before insert on hr.shift
  for each row execute function hr.shift_type_from_template();

-- The unpaid break of a shift, as an interval (zero for none).
create function hr.break_of(p_shift uuid) returns interval
language sql stable
set search_path = pg_catalog, hr
as $$
  select coalesce((select break_minutes from hr.shift where id = p_shift), 0) * interval '1 minute';
$$;
grant execute on function hr.break_of(uuid) to app_rw, wf_executor;

-- ---------------------------------------------------------------------------
-- 2. Rostered hours without the break
-- ---------------------------------------------------------------------------

do $$
declare
  v_src text;
  v_new text;
  f text;
begin
  -- the weekly hours rule and its warning: the person's other shifts, and the one being given
  -- (found by its place, role and times; a split's break is the same on every day)
  foreach f in array array[
    'hr.assignment_checks(uuid, timestamptz, timestamptz, uuid, text, uuid)',
    'hr.assignment_violation(uuid, timestamptz, timestamptz, uuid, text, uuid)'] loop
    v_src := pg_get_functiondef(f::regprocedure);
    v_new := replace(v_src, 'sum(extract(epoch from a.end_at - a.start_at))',
                     'sum(extract(epoch from a.end_at - a.start_at - hr.break_of(a.shift_id)))');
    v_new := replace(v_new, 'extract(epoch from p_end - p_start) / 3600',
                     'extract(epoch from p_end - p_start - coalesce((select hr.break_of(s.id)
                        from hr.shift s where s.org_node_id = p_node and s.role_code = p_role
                         and s.start_at = p_start and s.end_at = p_end and s.status <> ''cancelled''
                       limit 1), interval ''0'')) / 3600');
    if v_new = v_src then
      raise exception '% changed; update this migration', f;
    end if;
    execute v_new;
  end loop;

  v_src := pg_get_functiondef('hr.assign_candidates(uuid)'::regprocedure);
  v_new := replace(v_src, 'sum(extract(epoch from a.end_at - a.start_at))',
                   'sum(extract(epoch from a.end_at - a.start_at - hr.break_of(a.shift_id)))');
  if v_new = v_src then raise exception 'hr.assign_candidates changed; update this migration'; end if;
  execute v_new;

  foreach f in array array['rpt.calc_labour_day(uuid[], date, date)',
                           'rpt.bd_people(text, uuid, date, date)'] loop
    v_src := pg_get_functiondef(f::regprocedure);
    v_new := replace(v_src, 'extract(epoch from s.end_at - s.start_at)',
                     'extract(epoch from s.end_at - s.start_at - s.break_minutes * interval ''1 minute'')');
    if v_new = v_src then raise exception '% changed; update this migration', f; end if;
    execute v_new;
  end loop;

  v_src := pg_get_functiondef('rpt.my_week(date)'::regprocedure);
  v_new := replace(v_src, 'select s.id, s.start_at, s.end_at from hr.shift_assignment a',
                   'select s.id, s.start_at, s.end_at - s.break_minutes * interval ''1 minute'' as end_at
        from hr.shift_assignment a');
  if v_new = v_src then raise exception 'rpt.my_week changed; update this migration'; end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The tiles
-- ---------------------------------------------------------------------------

-- A department's shift types and people for a day: each person, their job role, and the shift
-- type they are on that day (null: off); each type with its times. For those who roster there.
create function hr.roster_day(p_node uuid, p_day date)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_tz text;
begin
  perform hr.require('ROSTER', 'view', p_node);
  v_tz := hr.node_tz(p_node);
  return jsonb_build_object(
    'types', coalesce((
      select jsonb_agg(jsonb_build_object(
               'template_id', t.id, 'name', t.name, 'role_code', t.role_code,
               'shift_type', t.shift_type, 'start', to_char(t.start_time, 'HH24:MI'),
               'end', to_char(t.end_time, 'HH24:MI'),
               'first_end', to_char(t.first_end, 'HH24:MI'),
               'second_start', to_char(t.second_start, 'HH24:MI'),
               'break_minutes', t.break_minutes,
               'runs', extract(isodow from p_day)::int = any (t.weekdays))
             order by t.start_time, t.name, t.role_code)
        from hr.shift_template t
       where t.org_node_id = p_node and t.archived_at is null), '[]'),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
               'worker_id', w.id, 'name', u.display_name, 'role_code', w.role_code,
               'job_role', jr.name,
               'template_id', a.template_id, 'shift_id', a.shift_id, 'status', a.status)
             order by u.display_name)
        from hr.worker w
        join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
        left join hr.job_role jr on jr.tenant_id = w.tenant_id and jr.code = w.role_code
        left join lateral (
          select s.template_id, s.id as shift_id, s.status
            from hr.shift_assignment x join hr.shift s on s.id = x.shift_id
           where x.worker_id = w.id and x.status = 'assigned' and s.org_node_id = p_node
             and s.local_date = p_day and s.status <> 'cancelled'
           order by s.start_at limit 1) a on true
       where w.org_node_id = p_node and w.status = 'active'), '[]'));
end $$;

-- Puts one person on a shift type for a day, or Off (p_template null). Returns the assignment,
-- or null for Off. Every roster rule runs again (hr.assign); p_accept names the warnings the
-- manager saw and accepted (ADR 019).
create function hr.set_day_shift(p_worker uuid, p_day date, p_template uuid,
                                 p_accept text[] default '{}') returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker;
  v_t hr.shift_template;
  v_node uuid;
  v_shift hr.shift;
  v_a hr.shift_assignment;
  v_tz text;
begin
  select * into v_w from hr.worker where id = p_worker and tenant_id = core.my_tenant()
     and status = 'active';
  if not found then
    perform hr.fail('INVALID_WORKER', 'worker not found');
  end if;
  if p_template is not null then
    select * into v_t from hr.shift_template
     where id = p_template and tenant_id = v_w.tenant_id and archived_at is null;
    if not found then
      perform hr.fail('NOT_FOUND', 'shift type');
    end if;
    v_node := v_t.org_node_id;
  else
    v_node := v_w.org_node_id;
  end if;
  perform hr.require('ROSTER', 'modify', v_node);
  v_tz := hr.node_tz(v_node);
  if p_day < (now() at time zone v_tz)::date then
    perform hr.fail('PAST_DAY', 'a day that has passed');
  end if;

  -- off whatever they had that day here (not yet started)
  for v_a in
    select x.* from hr.shift_assignment x join hr.shift s on s.id = x.shift_id
     where x.worker_id = v_w.id and x.status = 'assigned' and s.org_node_id = v_node
       and s.local_date = p_day and s.status <> 'cancelled'
       and (p_template is null or s.template_id is distinct from p_template)
  loop
    if v_a.start_at <= now() then
      perform hr.fail('SHIFT_STARTED', 'the shift has started');
    end if;
    perform hr.unassign(v_a.id);
  end loop;
  if p_template is null then
    return null;
  end if;

  select * into v_shift from hr.shift
   where template_id = p_template and local_date = p_day and status <> 'cancelled';
  if not found then
    insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                          role_code, headcount)
    values (v_t.tenant_id, v_t.org_node_id, v_t.id, p_day, (p_day + v_t.start_time) at time zone v_tz,
            (p_day + case when v_t.end_time > v_t.start_time then 0 else 1 end + v_t.end_time)
              at time zone v_tz,
            v_t.role_code, v_t.headcount)
    returning * into v_shift;
  elsif not exists (select 1 from hr.shift_assignment
                     where shift_id = v_shift.id and worker_id = v_w.id and status = 'assigned')
        and (select count(*) from hr.shift_assignment
              where shift_id = v_shift.id and status = 'assigned') >= v_shift.headcount then
    -- full: the manager chose one more
    update hr.shift set headcount = headcount + 1 where id = v_shift.id;
  end if;
  return hr.assign(v_shift.id, v_w.id, p_accept);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Repeat this pattern
-- ---------------------------------------------------------------------------

-- Copies the week starting p_week (a Monday) at a department onto the same weekdays from
-- p_from to p_to. Returns {added, skipped: [{name, day, code, detail}]}.
create function hr.repeat_pattern(p_node uuid, p_week date, p_from date, p_to date)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_day date;
  v_src record;
  v_added int := 0;
  v_skipped jsonb := '[]';
  v_tz text;
  v_code text;
  v_detail text;
begin
  perform hr.require('ROSTER', 'modify', p_node);
  v_tz := hr.node_tz(p_node);
  if p_week is null or extract(isodow from p_week) <> 1 then
    perform hr.fail('INVALID_WEEK', 'weeks start on a Monday');
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62
     or p_from <= (now() at time zone v_tz)::date or p_from < p_week + 7 then
    perform hr.fail('INVALID_RANGE', 'from tomorrow (after the week copied), eight weeks at most');
  end if;
  for v_day in select d::date from generate_series(p_from, p_to, interval '1 day') d loop
    for v_src in
      select x.worker_id, s.template_id, u.display_name
        from hr.shift_assignment x
        join hr.shift s on s.id = x.shift_id and s.status <> 'cancelled'
        join hr.worker w on w.id = x.worker_id and w.status = 'active'
        join core.app_user u on u.id = w.owner_user_id
       where s.org_node_id = p_node and x.status = 'assigned' and s.template_id is not null
         and s.local_date = p_week + (extract(isodow from v_day)::int - 1)
       order by s.start_at, u.display_name
    loop
      if exists (select 1 from hr.shift_assignment x join hr.shift s on s.id = x.shift_id
                  where x.worker_id = v_src.worker_id and x.status = 'assigned'
                    and s.template_id = v_src.template_id and s.local_date = v_day) then
        continue;
      end if;
      begin
        perform hr.set_day_shift(v_src.worker_id, v_day, v_src.template_id, '{}');
        v_added := v_added + 1;
      exception when others then
        v_code := sqlerrm;
        get stacked diagnostics v_detail = pg_exception_detail;
        v_skipped := v_skipped || jsonb_build_object('name', v_src.display_name, 'day', v_day,
                                                     'code', v_code, 'detail', v_detail);
      end;
    end loop;
  end loop;
  return jsonb_build_object('added', v_added, 'skipped', v_skipped);
end $$;

revoke execute on function hr.roster_day(uuid, date), hr.set_day_shift(uuid, date, uuid, text[]),
  hr.repeat_pattern(uuid, date, date, date) from public;
grant execute on function hr.roster_day(uuid, date), hr.set_day_shift(uuid, date, uuid, text[]),
  hr.repeat_pattern(uuid, date, date, date) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function hr.repeat_pattern(uuid, date, date, date), hr.set_day_shift(uuid, date, uuid, text[]),
  hr.roster_day(uuid, date);
do $$
declare
  v_src text;
  f text;
begin
  foreach f in array array[
    'hr.assignment_checks(uuid, timestamptz, timestamptz, uuid, text, uuid)',
    'hr.assignment_violation(uuid, timestamptz, timestamptz, uuid, text, uuid)'] loop
    v_src := pg_get_functiondef(f::regprocedure);
    v_src := replace(v_src, 'sum(extract(epoch from a.end_at - a.start_at - hr.break_of(a.shift_id)))',
                     'sum(extract(epoch from a.end_at - a.start_at))');
    v_src := regexp_replace(v_src, 'extract\(epoch from p_end - p_start - coalesce\(.*?interval ''0''\)\) / 3600',
                            'extract(epoch from p_end - p_start) / 3600');
    execute v_src;
  end loop;
  execute replace(pg_get_functiondef('hr.assign_candidates(uuid)'::regprocedure),
    'sum(extract(epoch from a.end_at - a.start_at - hr.break_of(a.shift_id)))',
    'sum(extract(epoch from a.end_at - a.start_at))');
  foreach f in array array['rpt.calc_labour_day(uuid[], date, date)',
                           'rpt.bd_people(text, uuid, date, date)'] loop
    execute replace(pg_get_functiondef(f::regprocedure),
      'extract(epoch from s.end_at - s.start_at - s.break_minutes * interval ''1 minute'')',
      'extract(epoch from s.end_at - s.start_at)');
  end loop;
  execute replace(pg_get_functiondef('rpt.my_week(date)'::regprocedure),
    'select s.id, s.start_at, s.end_at - s.break_minutes * interval ''1 minute'' as end_at
        from hr.shift_assignment a',
    'select s.id, s.start_at, s.end_at from hr.shift_assignment a');
end $$;
drop function hr.break_of(uuid);
drop trigger b_shift_type on hr.shift;
drop function hr.shift_type_from_template();
alter table hr.shift drop constraint shift_break_fits, drop constraint shift_split,
  drop column split_start_at, drop column split_end_at, drop column break_minutes,
  drop column shift_type;
alter table hr.shift_template drop constraint shift_template_shape, drop column break_minutes,
  drop column second_start, drop column first_end, drop column shift_type;
