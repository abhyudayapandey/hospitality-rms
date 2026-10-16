-- migrate:up
-- A leave's pill follows its words (ADR 164). Team -> Leave showed "Waiting" next to "Approved
-- by Rhea" (the last person said yes; the executor had not run yet) and next to "It could not
-- go through". Now one state, hr.leave_state, decides both: submitted (waiting), approved (as
-- soon as the last person says yes), rejected, cancelled, failed. The words, Team -> Leave and
-- the roster's day of leave all read it; a leave that could not go through is no leave on the
-- roster.
create function hr.leave_state(p_leave uuid) returns text
language sql stable security definer
set search_path = pg_catalog, hr, wf
as $$
  select case
    when l.status = 'cancelled' then 'cancelled'
    when l.status = 'rejected' or r.state = 'rejected' then 'rejected'
    when l.status = 'approved' or r.state in ('approved', 'executing', 'completed')
      then 'approved'
    when r.state = 'failed' then 'failed'
    else 'submitted'
  end
    from hr.leave_request l
    left join wf.request r on r.id = l.wf_request_id
   where l.id = p_leave;
$$;
revoke execute on function hr.leave_state(uuid) from public;

create or replace function hr.leave_words(p_leave uuid) returns text
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf, inv
as $$
declare
  v_l hr.leave_request;
  v_r wf.request;
  v_by text;
begin
  select * into v_l from hr.leave_request where id = p_leave and tenant_id = core.my_tenant();
  if not found or not (v_l.owner_user_id = core.current_user_id()
                       or core.can('LEAVE', 'view', v_l.org_node_id, null, v_l.owner_user_id)) then
    return null;
  end if;
  select * into v_r from wf.request where id = v_l.wf_request_id;
  case hr.leave_state(p_leave)
  when 'cancelled' then
    return 'Cancelled';
  when 'rejected' then
    select u.display_name into v_by from wf.step_instance s join core.app_user u on u.id = s.actor_id
     where s.request_id = v_r.id and s.state = 'rejected' order by s.seq desc limit 1;
    return 'Rejected' || coalesce(' by ' || v_by, '');
  when 'approved' then
    select u.display_name into v_by from wf.step_instance s join core.app_user u on u.id = s.actor_id
     where s.request_id = v_r.id and s.state = 'approved' order by s.seq desc limit 1;
    return 'Approved' || coalesce(' by ' || v_by, '');
  when 'failed' then
    return 'It could not go through. Tell your manager.';
  else
    if v_r.state = 'in_approval' then
      return 'Waiting for '
        || coalesce(inv.people_words(inv.step_people(v_r.id, v_r.current_step)), 'approval')
        || ' to approve';
    end if;
    return 'Waiting for approval';
  end case;
end $$;

-- Team -> Leave: its status is the state the words say
select core.patch_function('hr.team_leave(uuid, date, date)',
  $x$l.from_date, l.to_date, l.days, l.status, hr.leave_words(l.id)$x$,
  $x$l.from_date, l.to_date, l.days, hr.leave_state(l.id), hr.leave_words(l.id)$x$);

-- the roster's day of leave: approved once the last person said yes; one that could not go
-- through is none
create or replace function hr.leave_on_day(p_worker uuid, p_day date)
returns table (id uuid, status text)
language sql stable security definer
set search_path = pg_catalog, hr
as $$
  select l.id, s.state from hr.leave_request l
   cross join lateral (select hr.leave_state(l.id) as state) s
   where l.worker_id = p_worker and l.status in ('approved', 'submitted')
     and s.state in ('approved', 'submitted')
     and p_day between l.from_date and l.to_date
   order by s.state = 'approved' desc, l.created_at, l.id
   limit 1;
$$;
select core.patch_function('hr.leave_for_day(uuid, date)',
  $x$    select distinct on (w.id) w.id, l.id, l.status
      from hr.worker w$x$,
  $x$    select distinct on (w.id) w.id, l.id, s.state
      from hr.worker w$x$);
select core.patch_function('hr.leave_for_day(uuid, date)',
  $x$      join hr.leave_request l on l.worker_id = w.id
     where$x$,
  $x$      join hr.leave_request l on l.worker_id = w.id
      cross join lateral (select hr.leave_state(l.id) as state) s
     where$x$);
select core.patch_function('hr.leave_for_day(uuid, date)',
  $x$       and l.status in ('approved', 'submitted')
       and p_day between l.from_date and l.to_date
     order by w.id, l.status = 'approved' desc, l.created_at, l.id;$x$,
  $x$       and l.status in ('approved', 'submitted') and s.state in ('approved', 'submitted')
       and p_day between l.from_date and l.to_date
     order by w.id, s.state = 'approved' desc, l.created_at, l.id;$x$);

-- migrate:down
select core.patch_function('hr.leave_for_day(uuid, date)',
  $x$       and l.status in ('approved', 'submitted') and s.state in ('approved', 'submitted')
       and p_day between l.from_date and l.to_date
     order by w.id, s.state = 'approved' desc, l.created_at, l.id;$x$,
  $x$       and l.status in ('approved', 'submitted')
       and p_day between l.from_date and l.to_date
     order by w.id, l.status = 'approved' desc, l.created_at, l.id;$x$);
select core.patch_function('hr.leave_for_day(uuid, date)',
  $x$      join hr.leave_request l on l.worker_id = w.id
      cross join lateral (select hr.leave_state(l.id) as state) s
     where$x$,
  $x$      join hr.leave_request l on l.worker_id = w.id
     where$x$);
select core.patch_function('hr.leave_for_day(uuid, date)',
  $x$    select distinct on (w.id) w.id, l.id, s.state
      from hr.worker w$x$,
  $x$    select distinct on (w.id) w.id, l.id, l.status
      from hr.worker w$x$);
create or replace function hr.leave_on_day(p_worker uuid, p_day date)
returns table (id uuid, status text)
language sql stable security definer
set search_path = pg_catalog, hr
as $$
  select l.id, l.status from hr.leave_request l
   where l.worker_id = p_worker and l.status in ('approved', 'submitted')
     and p_day between l.from_date and l.to_date
   order by l.status = 'approved' desc, l.created_at, l.id
   limit 1;
$$;
select core.patch_function('hr.team_leave(uuid, date, date)',
  $x$l.from_date, l.to_date, l.days, hr.leave_state(l.id), hr.leave_words(l.id)$x$,
  $x$l.from_date, l.to_date, l.days, l.status, hr.leave_words(l.id)$x$);
create or replace function hr.leave_words(p_leave uuid) returns text
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf, inv
as $$
declare
  v_l hr.leave_request;
  v_r wf.request;
  v_by text;
begin
  select * into v_l from hr.leave_request where id = p_leave and tenant_id = core.my_tenant();
  if not found or not (v_l.owner_user_id = core.current_user_id()
                       or core.can('LEAVE', 'view', v_l.org_node_id, null, v_l.owner_user_id)) then
    return null;
  end if;
  select * into v_r from wf.request where id = v_l.wf_request_id;
  if v_l.status = 'cancelled' then
    return 'Cancelled';
  end if;
  if v_l.status = 'rejected' or v_r.state = 'rejected' then
    select u.display_name into v_by from wf.step_instance s join core.app_user u on u.id = s.actor_id
     where s.request_id = v_r.id and s.state = 'rejected' order by s.seq desc limit 1;
    return 'Rejected' || coalesce(' by ' || v_by, '');
  end if;
  if v_l.status = 'approved' or v_r.state in ('approved', 'executing', 'completed') then
    select u.display_name into v_by from wf.step_instance s join core.app_user u on u.id = s.actor_id
     where s.request_id = v_r.id and s.state = 'approved' order by s.seq desc limit 1;
    return 'Approved' || coalesce(' by ' || v_by, '');
  end if;
  if v_r.state = 'failed' then
    return 'It could not go through. Tell your manager.';
  end if;
  if v_r.state = 'in_approval' then
    return 'Waiting for '
      || coalesce(inv.people_words(inv.step_people(v_r.id, v_r.current_step)), 'approval')
      || ' to approve';
  end if;
  return 'Waiting for approval';
end $$;
drop function hr.leave_state(uuid);
