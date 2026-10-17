-- migrate:up
-- Leave meets a shift on the shift's business day; Publish checks the rules again (ADR 167,
-- review M30 and M31).
--
-- 1. hr.leave_shifts, and the leave rule in hr.assignment_checks / hr.assignment_violation,
--    compared the leave's dates with the calendar date the shift ends on, so leave from Tuesday
--    took the Monday 19:00-04:00 shift and stopped anyone rostering it. A shift belongs to the
--    day it starts (hr.shift.local_date), and that day alone is compared with the leave.
-- 2. hr.publish_week turned every waiting change into a live shift without asking the roster
--    rules again. hr.publish_left_out lists, in words, what breaks a rule now: leave approved
--    since, or the person left or moved (overlap, rest and hours were checked when rostered).
--    Publish leaves those out (dropped, never seen by staff) and the screen says who and when.

create or replace function hr.leave_shifts(p_leave uuid)
returns table (assignment_id uuid, shift_id uuid, local_date date, start_at timestamptz,
               end_at timestamptz, role_code text)
language sql stable
set search_path = pg_catalog, hr
as $$
  select a.id, s.id, s.local_date, s.start_at, s.end_at, s.role_code
    from hr.leave_request l
    join hr.shift_assignment a on a.worker_id = l.worker_id and a.status in ('assigned', 'pending')
    join hr.shift s on s.id = a.shift_id and s.status <> 'cancelled'
   where l.id = p_leave
     and s.local_date between l.from_date and l.to_date
   order by s.start_at;
$$;

select core.patch_function(
  'hr.assignment_checks(uuid, timestamptz, timestamptz, uuid, text, uuid)',
  $x$and l.from_date <= v_last and l.to_date >= v_first$x$,
  $x$and v_first between l.from_date and l.to_date$x$);
select core.patch_function(
  'hr.assignment_violation(uuid, timestamptz, timestamptz, uuid, text, uuid)',
  $x$and l.from_date <= v_last and l.to_date >= v_first$x$,
  $x$and v_first between l.from_date and l.to_date$x$);

-- What Publish would leave out at this place in this week: a waiting change on a published
-- shift, or anyone on a draft shift, not yet started, who is now on approved leave that day,
-- has left or works somewhere else.
create function hr.publish_left_out(p_node uuid, p_week_start date)
returns table (assignment_id uuid, worker_name text, local_date date, code text, words text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr
as $$
begin
  perform hr.require('ROSTER', 'modify', p_node);
  return query
    select distinct on (a.id) a.id, coalesce(u.display_name, 'Someone'), s.local_date, c.code,
           case c.code
             when 'LEAVE_CONFLICT' then 'on leave'
             when 'WORKER_NOT_AT_NODE' then 'now works somewhere else'
             when 'INVALID_WORKER' then 'no longer works here'
           end
      from hr.shift s
      join hr.shift_assignment a on a.shift_id = s.id
      left join core.app_user u on u.id = a.owner_user_id
     cross join lateral hr.assignment_checks(a.worker_id, a.start_at, a.end_at, s.org_node_id,
                                             s.role_code, a.id) c
     where s.org_node_id = p_node and s.local_date between p_week_start and p_week_start + 6
       and s.start_at > now() -- a shift under way stays as it is
       and ((s.status = 'published' and a.status = 'pending')
            or (s.status = 'draft' and a.status = 'assigned'))
       -- what can break since they were rostered: leave approved since, or the person left or
       -- moved. Overlap, rest and hours were checked then against everyone rostered before,
       -- and everyone rostered after was checked against them.
       and c.code in ('LEAVE_CONFLICT', 'INVALID_WORKER', 'WORKER_NOT_AT_NODE')
     order by a.id, c.code;
end $$;
revoke execute on function hr.publish_left_out(uuid, date) from public;
grant execute on function hr.publish_left_out(uuid, date) to app_rw;

select core.patch_function('hr.publish_week(uuid, date)',
  $x$  -- on a published shift
  for v_r in$x$,
  $x$  -- what breaks a roster rule now is left out (ADR 167): nobody saw it yet
  update hr.shift_assignment x set status = 'dropped', drop_reason = 'unassigned',
         coming_off = false
    from hr.publish_left_out(p_node, p_week_start) lo
   where x.id = lo.assignment_id;
  -- on a published shift
  for v_r in$x$);

-- migrate:down
select core.patch_function('hr.publish_week(uuid, date)',
  $x$  -- what breaks a roster rule now is left out (ADR 167): nobody saw it yet
  update hr.shift_assignment x set status = 'dropped', drop_reason = 'unassigned',
         coming_off = false
    from hr.publish_left_out(p_node, p_week_start) lo
   where x.id = lo.assignment_id;
  -- on a published shift
  for v_r in$x$,
  $x$  -- on a published shift
  for v_r in$x$);
drop function hr.publish_left_out(uuid, date);
select core.patch_function(
  'hr.assignment_violation(uuid, timestamptz, timestamptz, uuid, text, uuid)',
  $x$and v_first between l.from_date and l.to_date$x$,
  $x$and l.from_date <= v_last and l.to_date >= v_first$x$);
select core.patch_function(
  'hr.assignment_checks(uuid, timestamptz, timestamptz, uuid, text, uuid)',
  $x$and v_first between l.from_date and l.to_date$x$,
  $x$and l.from_date <= v_last and l.to_date >= v_first$x$);
create or replace function hr.leave_shifts(p_leave uuid)
returns table (assignment_id uuid, shift_id uuid, local_date date, start_at timestamptz,
               end_at timestamptz, role_code text)
language sql stable
set search_path = pg_catalog, hr
as $$
  select a.id, s.id, s.local_date, s.start_at, s.end_at, s.role_code
    from hr.leave_request l
    join hr.shift_assignment a on a.worker_id = l.worker_id and a.status in ('assigned', 'pending')
    join hr.shift s on s.id = a.shift_id and s.status <> 'cancelled'
   where l.id = p_leave
     and (a.start_at at time zone hr.node_tz(a.org_node_id))::date <= l.to_date
     and ((a.end_at - interval '1 microsecond') at time zone hr.node_tz(a.org_node_id))::date >= l.from_date
   order by s.start_at;
$$;
