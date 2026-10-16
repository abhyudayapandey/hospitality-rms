-- migrate:up
-- Leave from the QA walk (ADR 163):
--  * whoever approves a leave request is told when it comes in;
--  * a leave request's state reads in words, from the moment it is decided: "Approved by
--    Calvin Rodrigues", "Rejected by …", "Waiting for … to approve", "Cancelled";
--  * the roster refuses a shift on a day of approved leave (LEAVE_CONFLICT, as before) and on a
--    day someone has asked for leave (LEAVE_PENDING): cancel or reject the leave first;
--  * approved leave not yet started may be cancelled, by the person or by whoever manages
--    their leave: the days go back to their balance (hr.cancel_leave);
--  * the team's leave, every request with its state, by day or by person (hr.team_leave).

-- The words for a leave request's state.
create function hr.leave_words(p_leave uuid) returns text
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
     where s.request_id = v_r.id and s.state = 'rejected' order by s.acted_at desc limit 1;
    return 'Rejected' || coalesce(' by ' || v_by, '');
  end if;
  if v_l.status = 'approved' or v_r.state in ('approved', 'executing', 'completed') then
    select u.display_name into v_by from wf.step_instance s join core.app_user u on u.id = s.actor_id
     where s.request_id = v_r.id and s.state = 'approved' order by s.acted_at desc limit 1;
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

-- The leave a person has, or has asked for, on a day.
create function hr.leave_on_day(p_worker uuid, p_day date)
returns table (id uuid, status text)
language sql stable security definer
set search_path = pg_catalog, hr
as $$
  select l.id, l.status from hr.leave_request l
   where l.worker_id = p_worker and l.status in ('approved', 'submitted')
     and p_day between l.from_date and l.to_date
   order by l.status = 'approved' desc, l.created_at
   limit 1;
$$;

-- A shift on a day of leave is refused: cancel approved leave, or reject a request, first.
create function hr.leave_block(p_worker uuid, p_day date) returns void
language plpgsql stable security definer
set search_path = pg_catalog, hr
as $$
declare
  v record;
begin
  select * into v from hr.leave_on_day(p_worker, p_day);
  if found then
    perform hr.fail(case v.status when 'approved' then 'LEAVE_CONFLICT' else 'LEAVE_PENDING' end,
                    'leave ' || v.id);
  end if;
end $$;

do $$
declare
  v_src text := pg_get_functiondef('hr.set_day_shift(uuid,date,uuid,text[])'::regprocedure);
  v_from text := E'    perform hr.fail(''PAST_DAY'', ''a day that has passed'');\n  end if;\n';
  v_to text := v_from || E'  -- a day of leave, approved or asked for (ADR 163)\n'
                      || E'  if p_template is not null then\n'
                      || E'    perform hr.leave_block(v_w.id, p_day);\n  end if;\n';
begin
  if position(v_from in v_src) = 0 then
    raise exception 'hr.set_day_shift has changed';
  end if;
  execute replace(v_src, v_from, v_to);
end $$;

do $$
declare
  v_src text := pg_get_functiondef(
    'hr.set_custom_shift(uuid,date,time without time zone,time without time zone,text[],integer)'::regprocedure);
  v_from text := E'  perform hr.require(''ROSTER'', ''modify'', v_w.org_node_id);\n';
  v_to text := v_from || E'  -- a day of leave, approved or asked for (ADR 163)\n'
                      || E'  perform hr.leave_block(v_w.id, p_day);\n';
begin
  if position(v_from in v_src) = 0 then
    raise exception 'hr.set_custom_shift has changed';
  end if;
  execute replace(v_src, v_from, v_to);
end $$;

-- Whoever approves it is told when a leave request comes in (its first step is open).
create function hr.notify_leave_asked() returns trigger
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf, inv, ops
as $$
declare
  v_r wf.request;
  v_type text;
begin
  if ops.replaying(new.tenant_id) then
    return new;
  end if;
  select * into v_r from wf.request where id = new.wf_request_id;
  if v_r.state <> 'in_approval' then
    return new;
  end if;
  select name into v_type from hr.leave_type where id = new.leave_type_id;
  perform ops.notify(new.tenant_id, u, 'leave_asked', 'Leave to approve',
            hr.user_name(new.owner_user_id) || ': ' || v_type || ', '
              || to_char(new.from_date, 'DD Mon')
              || case when new.to_date <> new.from_date
                      then ' – ' || to_char(new.to_date, 'DD Mon') else '' end,
            '/leave/' || new.id)
    from unnest(inv.step_people(v_r.id, v_r.current_step)) u
   where u is distinct from new.owner_user_id;
  return new;
end $$;

create trigger leave_asked after update of wf_request_id on hr.leave_request
  for each row when (old.wf_request_id is null and new.wf_request_id is not null)
  execute function hr.notify_leave_asked();

-- Approved leave not yet started is cancelled by the person, by whoever manages their leave, or
-- by whoever builds their roster (the roster's red line sends them here): the days go back to
-- the balance; the shifts it took off stay off (the roster is refilled).
create function hr.may_cancel_leave(p_leave uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select coalesce((
    select l.status = 'approved'
       and l.from_date > (now() at time zone hr.node_tz(l.org_node_id))::date
       and (l.owner_user_id = core.current_user_id()
            or core.can('LEAVE', 'modify', l.org_node_id, null)
            or core.can('ROSTER', 'modify', l.org_node_id, null))
      from hr.leave_request l
     where l.id = p_leave and l.tenant_id = core.my_tenant()), false);
$$;

create function hr.cancel_leave(p_leave uuid, p_reason text default null) returns void
language plpgsql security definer
set search_path = pg_catalog, core, hr, ops
as $$
declare
  v_l hr.leave_request;
  v_me uuid := core.current_user_id();
begin
  select * into v_l from hr.leave_request
   where id = p_leave and tenant_id = core.my_tenant() for update;
  if not found or not (v_l.owner_user_id = v_me
                       or core.can('LEAVE', 'modify', v_l.org_node_id, null)
                       or core.can('ROSTER', 'modify', v_l.org_node_id, null)) then
    perform hr.fail('NOT_AUTHORISED', 'cancel this leave');
  end if;
  if v_l.status <> 'approved' then
    perform hr.fail('INVALID_STATE', 'only approved leave is cancelled; reject a request instead');
  end if;
  if v_l.from_date <= (now() at time zone hr.node_tz(v_l.org_node_id))::date then
    perform hr.fail('LEAVE_STARTED', 'the leave has started');
  end if;
  update hr.leave_request set status = 'cancelled' where id = v_l.id;
  if (select annual_days from hr.leave_type where id = v_l.leave_type_id) is not null then
    update hr.leave_balance set used_days = greatest(used_days - v_l.days, 0)
     where worker_id = v_l.worker_id and leave_type_id = v_l.leave_type_id
       and year = extract(year from v_l.from_date)::int;
  end if;
  if v_l.owner_user_id <> v_me then
    perform ops.notify(v_l.tenant_id, v_l.owner_user_id, 'leave_cancelled', 'Leave cancelled',
      to_char(v_l.from_date, 'DD Mon') || ' – ' || to_char(v_l.to_date, 'DD Mon') || ' by '
        || hr.user_name(v_me) || coalesce(': ' || nullif(trim(p_reason), ''), ''),
      '/leave/' || v_l.id);
  end if;
end $$;

-- Team → Leave (ADR 035) lists every state, waiting, approved, rejected and cancelled, each
-- in words (ADR 163); the page shows it by day or by person.
drop function hr.team_leave(uuid, date, date);
create function hr.team_leave(p_node uuid, p_from date, p_to date)
returns table (leave_id uuid, worker_id uuid, name text, job_role text, place text,
               leave_type text, from_date date, to_date date, days numeric, status text,
               words text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
declare
  v_node core.hierarchy_node;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    perform hr.fail('INVALID_DATES', 'up to three months');
  end if;
  select * into v_node from core.hierarchy_node
   where id = p_node and tenant_id = core.my_tenant() and type = 'org';
  if not found or not core.can('LEAVE', 'view', p_node, null) then
    perform hr.fail('NOT_AUTHORISED', 'leave');
  end if;
  return query
    select l.id, w.id, u.display_name, coalesce(j.name, w.role_code), n.name, t.name,
           l.from_date, l.to_date, l.days, l.status, hr.leave_words(l.id)
      from hr.leave_request l
      join hr.worker w on w.id = l.worker_id
      join core.app_user u on u.id = w.owner_user_id
      join core.hierarchy_node n on n.id = l.org_node_id
      join hr.leave_type t on t.id = l.leave_type_id
      left join hr.job_role j on j.tenant_id = w.tenant_id and j.code = w.role_code
     where l.tenant_id = v_node.tenant_id and n.path <@ v_node.path
       and l.status in ('submitted', 'approved', 'rejected', 'cancelled')
       and l.from_date <= p_to and l.to_date >= p_from
       and core.can('LEAVE', 'view', l.org_node_id, null)
     order by l.from_date, u.display_name;
end $$;

-- The roster by person (ADR 082) shows who is on leave, or has asked for it, that day.
create function hr.leave_for_day(p_node uuid, p_day date)
returns table (worker_id uuid, leave_id uuid, status text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
begin
  if not core.can('ROSTER', 'view', p_node, null) then
    return;
  end if;
  return query
    select distinct on (w.id) w.id, l.id, l.status
      from hr.worker w
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node n on n.id = p_node
      join hr.leave_request l on l.worker_id = w.id
     where w.tenant_id = core.my_tenant() and n.tenant_id = core.my_tenant()
       and h.path operator(extensions.<@) n.path
       and l.status in ('approved', 'submitted')
       and p_day between l.from_date and l.to_date
     order by w.id, l.status = 'approved' desc, l.created_at;
end $$;

revoke execute on function hr.leave_words(uuid), hr.leave_on_day(uuid, date),
  hr.leave_block(uuid, date), hr.notify_leave_asked(), hr.cancel_leave(uuid, text), hr.may_cancel_leave(uuid),
  hr.team_leave(uuid, date, date), hr.leave_for_day(uuid, date) from public;
grant execute on function hr.leave_words(uuid), hr.cancel_leave(uuid, text),
  hr.may_cancel_leave(uuid), hr.team_leave(uuid, date, date), hr.leave_for_day(uuid, date) to app_rw;

-- migrate:down
drop function if exists hr.leave_for_day(uuid, date);
drop function if exists hr.team_leave(uuid, date, date);
create function hr.team_leave(p_node uuid, p_from date, p_to date)
returns table (leave_id uuid, worker_id uuid, name text, job_role text, place text,
               leave_type text, from_date date, to_date date, days numeric, status text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
declare
  v_node core.hierarchy_node;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    perform hr.fail('INVALID_DATES', 'up to three months');
  end if;
  select * into v_node from core.hierarchy_node
   where id = p_node and tenant_id = core.my_tenant() and type = 'org';
  if not found or not core.can('LEAVE', 'view', p_node, null) then
    perform hr.fail('NOT_AUTHORISED', 'leave');
  end if;
  return query
    select l.id, w.id, u.display_name, coalesce(j.name, w.role_code), n.name, t.name,
           l.from_date, l.to_date, l.days, l.status
      from hr.leave_request l
      join hr.worker w on w.id = l.worker_id
      join core.app_user u on u.id = w.owner_user_id
      join core.hierarchy_node n on n.id = l.org_node_id
      join hr.leave_type t on t.id = l.leave_type_id
      left join hr.job_role j on j.tenant_id = w.tenant_id and j.code = w.role_code
     where l.tenant_id = v_node.tenant_id and n.path <@ v_node.path
       and l.status in ('submitted', 'approved')
       and l.from_date <= p_to and l.to_date >= p_from
       and core.can('LEAVE', 'view', l.org_node_id, null)
     order by l.from_date, u.display_name;
end $$;
revoke execute on function hr.team_leave(uuid, date, date) from public;
grant execute on function hr.team_leave(uuid, date, date) to app_rw;
drop function if exists hr.cancel_leave(uuid, text);
drop function if exists hr.may_cancel_leave(uuid);
drop trigger if exists leave_asked on hr.leave_request;
drop function if exists hr.notify_leave_asked();
do $$
declare
  v_src text := pg_get_functiondef('hr.set_day_shift(uuid,date,uuid,text[])'::regprocedure);
begin
  execute replace(v_src, E'  -- a day of leave, approved or asked for (ADR 163)\n'
                         || E'  if p_template is not null then\n'
                         || E'    perform hr.leave_block(v_w.id, p_day);\n  end if;\n', '');
  v_src := pg_get_functiondef(
    'hr.set_custom_shift(uuid,date,time without time zone,time without time zone,text[],integer)'::regprocedure);
  execute replace(v_src, E'  -- a day of leave, approved or asked for (ADR 163)\n'
                         || E'  perform hr.leave_block(v_w.id, p_day);\n', '');
end $$;
drop function if exists hr.leave_block(uuid, date);
drop function if exists hr.leave_on_day(uuid, date);
drop function if exists hr.leave_words(uuid);
