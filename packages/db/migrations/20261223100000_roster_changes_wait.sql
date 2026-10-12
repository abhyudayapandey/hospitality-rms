-- migrate:up
-- Roster changes wait for Publish (ADR 135). Staff saw a change to a published shift at once:
-- taken off it (a tap on Off, another type, or the ✕), they were told "Shift removed"; put on
-- it, "New shift added". Publish counted only draft shifts, so those changes were not in its
-- count, and Start again could not take them back.
--
-- Now a change to a published shift waits like a draft:
-- - taken off: the assignment stays (coming_off), so they still see the shift and every rule
--   and report still counts it, until Publish drops it and tells them;
-- - put on: the assignment is 'pending', which nothing outside the roster counts, until
--   Publish makes it 'assigned' and tells them.
-- Publish (N) counts draft shifts and these changes; Start again discards them all.

alter table hr.shift_assignment
  add column coming_off boolean not null default false,
  drop constraint shift_assignment_status_check,
  add constraint shift_assignment_status_check
    check (status in ('assigned', 'pending', 'swapped', 'dropped')),
  drop constraint shift_assignment_check,
  add constraint shift_assignment_check
    check ((status in ('assigned', 'pending')) = (drop_reason is null)),
  add constraint shift_assignment_coming_off check (not coming_off or status = 'assigned');
comment on column hr.shift_assignment.coming_off is
  'taken off a published shift; dropped when the week is published (ADR 135)';
drop index hr.shift_assignment_active;
create unique index shift_assignment_active on hr.shift_assignment (shift_id, worker_id)
  where status in ('assigned', 'pending');

-- the roster's rules see the roster as it will be once published
select core.patch_function(
  'hr.assignment_checks(uuid, timestamptz, timestamptz, uuid, text, uuid)',
  $x$a.status = 'assigned' and a.id is distinct from p_ignore$x$,
  $x$a.status in ('assigned', 'pending') and not a.coming_off
     and a.id is distinct from p_ignore$x$);
select core.patch_function(
  'hr.assignment_violation(uuid, timestamptz, timestamptz, uuid, text, uuid)',
  $x$a.status = 'assigned' and a.id is distinct from p_ignore$x$,
  $x$a.status in ('assigned', 'pending') and not a.coming_off
     and a.id is distinct from p_ignore$x$);
select core.patch_function('hr.assign_candidates(uuid)',
  $x$where a.worker_id = w.id and a.status = 'assigned'$x$,
  $x$where a.worker_id = w.id and a.status in ('assigned', 'pending') and not a.coming_off$x$);
select core.patch_function('hr.assign_candidates(uuid)',
  $x$where a.shift_id = p_shift and a.worker_id = w.id and a.status = 'assigned')$x$,
  $x$where a.shift_id = p_shift and a.worker_id = w.id
                          and a.status in ('assigned', 'pending') and not a.coming_off)$x$);

-- put on a published shift: pending until Publish (back on one they were coming off: they stay)
select core.patch_function('hr.assign(uuid, uuid, text[])',
$x$  select id into v_id from hr.shift_assignment
   where shift_id = p_shift and worker_id = p_worker and status = 'assigned';
  if found then
    return v_id;
  end if;
  if (select count(*) from hr.shift_assignment
       where shift_id = p_shift and status = 'assigned') >= v_shift.headcount then$x$,
$x$  select id into v_id from hr.shift_assignment
   where shift_id = p_shift and worker_id = p_worker and status in ('assigned', 'pending');
  if found then
    update hr.shift_assignment set coming_off = false where id = v_id and coming_off;
    return v_id;
  end if;
  if (select count(*) from hr.shift_assignment
       where shift_id = p_shift and status in ('assigned', 'pending') and not coming_off)
     >= v_shift.headcount then$x$);
select core.patch_function('hr.assign(uuid, uuid, text[])',
$x$  insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                   start_at, end_at, warnings_accepted)
  values (v_shift.tenant_id, p_shift, p_worker, v_w.owner_user_id, v_shift.org_node_id,
          v_shift.start_at, v_shift.end_at, v_warn)
  returning id into v_id;
  if v_shift.status = 'published' then
    perform hr.notify_worker(p_worker, 'roster_changed', 'New shift added',
      to_char(v_shift.start_at at time zone hr.node_tz(v_shift.org_node_id), 'Dy DD Mon HH24:MI'),
      '/roster/my');
  end if;
  return v_id;$x$,
$x$  insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                   start_at, end_at, warnings_accepted, status)
  values (v_shift.tenant_id, p_shift, p_worker, v_w.owner_user_id, v_shift.org_node_id,
          v_shift.start_at, v_shift.end_at, v_warn,
          case when v_shift.status = 'published' then 'pending' else 'assigned' end)
  returning id into v_id;
  return v_id;$x$);

-- taken off a published shift: coming off until Publish; a pending one simply goes
create or replace function hr.unassign(p_assignment uuid) returns void
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
  if v_a.status not in ('assigned', 'pending') or v_a.coming_off then
    return;
  end if;
  select * into v_shift from hr.shift where id = v_a.shift_id;
  if v_shift.start_at <= now() then
    perform hr.fail('SHIFT_STARTED', 'the shift has started');
  end if;
  if v_a.status = 'assigned' and v_shift.status = 'published' then
    update hr.shift_assignment set coming_off = true where id = p_assignment;
  else
    update hr.shift_assignment set status = 'dropped', drop_reason = 'unassigned'
     where id = p_assignment;
  end if;
end $$;

-- a tile: what they are on that day is what they will be on once published
select core.patch_function('hr.set_day_shift(uuid, date, uuid, text[])',
$x$  select x.id into v_a from hr.shift_assignment x join hr.shift s on s.id = x.shift_id
   where x.worker_id = v_w.id and x.status = 'assigned' and s.org_node_id = v_node
     and s.local_date = p_day and s.status <> 'cancelled'
     and coalesce(s.template_id, s.copy_of) = p_template
   limit 1;
  if found then
    return v_a.id;
  end if;$x$,
$x$  select x.id, x.coming_off into v_a from hr.shift_assignment x join hr.shift s on s.id = x.shift_id
   where x.worker_id = v_w.id and x.status in ('assigned', 'pending') and s.org_node_id = v_node
     and s.local_date = p_day and s.status <> 'cancelled'
     and coalesce(s.template_id, s.copy_of) = p_template
   order by x.coming_off
   limit 1;
  if found and not v_a.coming_off then
    return v_a.id;
  end if;
  if found then
    -- back on the published shift they were coming off: whatever took its place goes
    perform hr.set_day_shift(p_worker, p_day, null);
    update hr.shift_assignment set coming_off = false where id = v_a.id;
    return v_a.id;
  end if;$x$);
select core.patch_function('hr.set_day_shift(uuid, date, uuid, text[])',
$x$     where x.worker_id = v_w.id and x.status = 'assigned' and s.org_node_id = v_node
       and s.local_date = p_day and s.status <> 'cancelled'
  loop$x$,
$x$     where x.worker_id = v_w.id and x.status in ('assigned', 'pending') and not x.coming_off
       and s.org_node_id = v_node and s.local_date = p_day and s.status <> 'cancelled'
  loop$x$);
select core.patch_function('hr.set_day_shift(uuid, date, uuid, text[])',
$x$    if v_a.personal and not exists (select 1 from hr.shift_assignment
                                     where shift_id = v_a.shift_id and status = 'assigned') then$x$,
$x$    if v_a.personal and not exists (select 1 from hr.shift_assignment
                                     where shift_id = v_a.shift_id
                                       and status in ('assigned', 'pending')) then$x$);
select core.patch_function('hr.set_day_shift(uuid, date, uuid, text[])',
$x$  elsif (select count(*) from hr.shift_assignment
          where shift_id = v_shift.id and status = 'assigned') >= v_shift.headcount then$x$,
$x$  elsif (select count(*) from hr.shift_assignment
          where shift_id = v_shift.id and status in ('assigned', 'pending') and not coming_off)
        >= v_shift.headcount then$x$);

-- The changes waiting in a node-week: draft shifts, and people coming on or off published ones.
create function hr.week_changes(p_node uuid, p_week_start date) returns int
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select case when core.can('ROSTER', 'modify', p_node, null, null) then
    (select count(*)::int from hr.shift
      where org_node_id = p_node and status = 'draft'
        and local_date between p_week_start and p_week_start + 6)
    + (select count(*)::int from hr.shift_assignment x join hr.shift s on s.id = x.shift_id
        where s.org_node_id = p_node and s.status = 'published'
          and s.local_date between p_week_start and p_week_start + 6
          and (x.status = 'pending' or (x.status = 'assigned' and x.coming_off)))
  else 0 end
$$;

-- Publishes the node-week: its draft shifts, and who comes on or off a published shift. Each
-- person is told once per change. Returns the number of changes published.
create or replace function hr.publish_week(p_node uuid, p_week_start date) returns int
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_ids uuid[];
  v_r record;
  v_n int := 0;
begin
  perform hr.require('ROSTER', 'modify', p_node);
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    perform hr.fail('INVALID_WEEK', 'weeks start on a Monday');
  end if;
  -- on a published shift
  for v_r in
    update hr.shift_assignment x set status = 'assigned'
      from hr.shift s
     where s.id = x.shift_id and s.org_node_id = p_node and s.status = 'published'
       and s.local_date between p_week_start and p_week_start + 6 and x.status = 'pending'
    returning x.worker_id, s.start_at, s.org_node_id
  loop
    v_n := v_n + 1;
    perform hr.notify_worker(v_r.worker_id, 'roster_changed', 'New shift added',
      to_char(v_r.start_at at time zone hr.node_tz(v_r.org_node_id), 'Dy DD Mon HH24:MI'),
      '/roster/my');
  end loop;
  -- off a published shift (one already under way, they stay on)
  update hr.shift_assignment x set coming_off = false
    from hr.shift s
   where s.id = x.shift_id and s.org_node_id = p_node
     and s.local_date between p_week_start and p_week_start + 6
     and x.coming_off and s.start_at <= now();
  for v_r in
    update hr.shift_assignment x
       set status = 'dropped', drop_reason = 'unassigned', coming_off = false
      from hr.shift s
     where s.id = x.shift_id and s.org_node_id = p_node
       and s.local_date between p_week_start and p_week_start + 6 and x.coming_off
    returning x.worker_id, s.start_at, s.org_node_id
  loop
    v_n := v_n + 1;
    perform hr.notify_worker(v_r.worker_id, 'roster_changed', 'Shift removed',
      to_char(v_r.start_at at time zone hr.node_tz(v_r.org_node_id), 'Dy DD Mon HH24:MI'),
      '/roster/my');
  end loop;
  -- a shift made for one person goes once nobody is left on it
  update hr.shift s set status = 'cancelled'
   where s.org_node_id = p_node and s.personal and s.status = 'published'
     and s.local_date between p_week_start and p_week_start + 6
     and not exists (select 1 from hr.shift_assignment x
                      where x.shift_id = s.id and x.status in ('assigned', 'pending'));
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
  return cardinality(v_ids) + v_n;
end $$;

-- Start again: also takes back who was put on or taken off a published shift
create or replace function hr.discard_drafts(p_node uuid, p_monday date) returns int
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_ids uuid[];
  v_n int;
  v_m int;
begin
  perform hr.require('ROSTER', 'modify', p_node);
  with c as (
    update hr.shift s set status = 'cancelled'
      from hr.template_window(p_node) w
     where s.org_node_id = p_node and s.status = 'draft' and s.start_at > now()
       and (s.local_date between w.from_day and w.to_day
            or s.local_date between p_monday and p_monday + 6)
    returning s.id)
  select coalesce(array_agg(id), '{}') into v_ids from c;
  update hr.shift_assignment set status = 'dropped', drop_reason = 'shift_cancelled'
   where shift_id = any (v_ids) and status = 'assigned';
  update hr.shift_assignment x set status = 'dropped', drop_reason = 'unassigned'
    from hr.shift s, hr.template_window(p_node) w
   where s.id = x.shift_id and s.org_node_id = p_node and x.status = 'pending'
     and s.start_at > now()
     and (s.local_date between w.from_day and w.to_day
          or s.local_date between p_monday and p_monday + 6);
  get diagnostics v_n = row_count;
  update hr.shift_assignment x set coming_off = false
    from hr.shift s, hr.template_window(p_node) w
   where s.id = x.shift_id and s.org_node_id = p_node and x.coming_off
     and s.start_at > now()
     and (s.local_date between w.from_day and w.to_day
          or s.local_date between p_monday and p_monday + 6);
  get diagnostics v_m = row_count;
  return cardinality(v_ids) + v_n + v_m;
end $$;

-- the tiles show the day as it will be once published, and who has a change not yet published
select core.patch_function('hr.roster_day(uuid, date)',
$x$               'shift_name', a.shift_name,$x$,
$x$               'shift_name', a.shift_name,
               'changed', coalesce(a.status = 'draft' or a.pending, false) or exists (
                 select 1 from hr.shift_assignment c join hr.shift cs on cs.id = c.shift_id
                  where c.worker_id = w.id and c.coming_off and cs.org_node_id = p_node
                    and cs.local_date = p_day),$x$);
select core.patch_function('hr.roster_day(uuid, date)',
$x$          select coalesce(s.template_id, s.copy_of) as template_id, s.id as shift_id, s.status,$x$,
$x$          select coalesce(s.template_id, s.copy_of) as template_id, s.id as shift_id, s.status,
                 x.status = 'pending' as pending,$x$);
select core.patch_function('hr.roster_day(uuid, date)',
$x$           where x.worker_id = w.id and x.status = 'assigned' and s.org_node_id = p_node$x$,
$x$           where x.worker_id = w.id and x.status in ('assigned', 'pending') and not x.coming_off
             and s.org_node_id = p_node$x$);

revoke execute on function hr.week_changes(uuid, date) from public;
grant execute on function hr.week_changes(uuid, date) to app_rw;

-- migrate:down
