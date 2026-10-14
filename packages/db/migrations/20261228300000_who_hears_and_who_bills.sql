-- migrate:up
-- Who hears about a task, and who gets a bill (QA of the Passport Hotel demo):
--
-- 1. An overdue task is told to whoever gave it only when they answer for it (ADR 020): they
--    look after its place's tasks, or they handed it on (ops.looks_after, as them). A task the
--    app routes for someone (a minibar bill from a room attendant's check) is not theirs to
--    chase. The hour-later step to the place's heads is unchanged.
-- 2. A minibar bill is routed, not handed on: whoever checked is not recorded as giving it, so
--    it is not on their "Given to others" and they are not told when it is done.
-- 3. Whoever is on shift: on shift now, else the next to start this business day
--    (ops.on_shift_next); never someone off until tomorrow. A minibar bill goes there, else to
--    the front office's head, else to the front desk's people. Its due time is an hour after
--    the check, or after the start of the shift of whoever gets it, if later.
-- 4. A test customer's past, replayed by the loader (app.replay), tells nobody now: ops.notify
--    sends nothing while it replays (ops.replaying).

-- 4 -------------------------------------------------------------------------------------------
create function ops.replaying(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce(current_setting('app.replay', true), '') = 'on'
     and coalesce((select t.is_test from core.tenant t where t.id = p_tenant), false);
$$;
revoke execute on function ops.replaying(uuid) from public;

create or replace function ops.notify(p_tenant uuid, p_user uuid, p_kind text, p_title text,
                                      p_body text default null, p_link text default null)
returns void
language sql security definer
set search_path = pg_catalog, ops
as $$
  insert into ops.notification (tenant_id, owner_user_id, kind, title, body, link)
  select p_tenant, p_user, p_kind, p_title, p_body, p_link
   where not ops.replaying(p_tenant);
$$;

-- 1 -------------------------------------------------------------------------------------------
-- Whether p_user answers for a task: ops.looks_after(task, 'modify') as them.
create function ops.answers_for(p_task ops.task, p_user uuid) returns boolean
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_was text := current_setting('app.user_id', true);
  v_ok boolean;
begin
  if p_user is null then
    return false;
  end if;
  perform set_config('app.user_id', p_user::text, true);
  v_ok := ops.looks_after(p_task, 'modify');
  perform set_config('app.user_id', coalesce(v_was, ''), true);
  return coalesce(v_ok, false);
end $$;
revoke execute on function ops.answers_for(ops.task, uuid) from public;

select core.patch_function('ops.tasks_tick(timestamptz)',
$x$    v_to := array_remove(array[v_t.assigned_by], v_t.assignee_user_id);$x$,
$x$    -- whoever gave it, if they answer for it (never someone it was routed for)
    v_to := array_remove(array[case when ops.answers_for(v_t, v_t.assigned_by)
                                    then v_t.assigned_by end], v_t.assignee_user_id);$x$);

-- 3 -------------------------------------------------------------------------------------------
-- Who in a team is on shift at p_at (someone clocked in first), else whose shift starts next
-- in the same business day; with p_roles, only people in those job roles, in that order.
create function ops.on_shift_next(p_team uuid, p_roles text[] default null,
                                  p_at timestamptz default now())
returns table (person uuid, starts_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, core, hr, ops, rpt, extensions
as $$
  select a.owner_user_id, a.start_at
    from hr.shift_assignment a
    join hr.shift s on s.id = a.shift_id and s.status = 'published'
    join core.hierarchy_node h on h.id = a.org_node_id
    join core.hierarchy_node n on n.id = p_team
    join core.app_user u on u.id = a.owner_user_id and u.status = 'active'
    cross join lateral (
      select min(array_position(p_roles, w.role_code)) as rank
        from hr.worker w
       where w.owner_user_id = a.owner_user_id and w.status = 'active'
         and w.tenant_id = a.tenant_id) r
   where a.status = 'assigned' and a.tenant_id = n.tenant_id
     and h.path operator(extensions.<@) n.path
     and a.end_at > p_at
     and (a.start_at <= p_at or s.local_date = rpt.business_date(p_at, ops.tz_of(p_team)))
     and (p_roles is null or r.rank is not null)
   order by a.start_at <= p_at desc, ops.clocked_in(a.owner_user_id, p_at) desc, r.rank,
            a.start_at, a.owner_user_id
   limit 1;
$$;
revoke execute on function ops.on_shift_next(uuid, text[], timestamptz) from public;

-- the receive task and the store keeper's flow use it too: on shift now, else later today
create or replace function ops.on_shift_now(p_team uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select person from ops.on_shift_next(p_team);
$$;

create or replace function ops.minibar_biller(p_outlet uuid)
returns table (department uuid, person uuid, job_role text)
language sql stable security definer
set search_path = pg_catalog, core, hr, ops
as $$
  with desk as (
    select w.org_node_id as dept
      from hr.worker w
      join core.hierarchy_node n on n.id = w.org_node_id
      join core.hierarchy_node o on o.id = p_outlet
     where w.status = 'active' and w.role_code in ('FRONT_DESK_EXECUTIVE', 'FRONT_OFFICE_MANAGER')
       and n.path operator(extensions.<@) o.path
     order by (w.role_code = 'FRONT_DESK_EXECUTIVE') desc, n.path
     limit 1
  )
  select d.dept,
         (select x.person
            from ops.on_shift_next(d.dept, array['FRONT_DESK_EXECUTIVE', 'FRONT_OFFICE_MANAGER']) x),
         case when exists (select 1 from hr.worker w where w.org_node_id = d.dept
                              and w.role_code = 'FRONT_DESK_EXECUTIVE' and w.status = 'active')
              then 'FRONT_DESK_EXECUTIVE' end
    from desk d;
$$;

create or replace function ops.minibar_tasks(p_check uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, hr, inv, ops
as $$
declare
  v_c ops.minibar_check;
  v_room text;
  v_used text;
  v_me uuid := core.current_user_id();
  v_place uuid;
  v_t ops.task;
  v_b record;
  v_head uuid;
  v_start timestamptz;
begin
  select * into v_c from ops.minibar_check where id = p_check;
  v_used := ops.minibar_used_words(p_check);
  if v_used is null then
    return;
  end if;
  select number into v_room from ops.room where id = v_c.room_id;
  -- the refill: for whoever checked, at their own department of this outlet
  select w.org_node_id into v_place
    from hr.worker w
    join core.hierarchy_node n on n.id = w.org_node_id
    join core.hierarchy_node o on o.id = v_c.org_node_id
   where w.owner_user_id = v_me and w.status = 'active'
     and n.path operator(extensions.<@) o.path;
  insert into ops.task (tenant_id, org_node_id, delivery_node_id, kind, title, description,
                        priority, due_at, status, assign_mode, assignee_user_id, assigned_by,
                        minibar_check_id)
  values (v_c.tenant_id, coalesce(v_place, v_c.org_node_id), v_c.store_id, 'minibar_refill',
          left('Refill minibar, room ' || v_room, 200),
          'From ' || core.node_name(v_c.store_id) || ': ' || v_used || '.',
          'normal', v_c.checked_at + interval '2 hours', 'open', 'person', v_me, v_me, p_check)
  returning * into v_t;

  -- the bill: the front desk on shift now, else the next to start today, else its head,
  -- else the front desk's people
  if v_c.charge > 0 then
    select * into v_b from ops.minibar_biller(v_c.org_node_id);
    if v_b.person is not null then
      select x.starts_at into v_start
        from ops.on_shift_next(v_b.department, array['FRONT_DESK_EXECUTIVE', 'FRONT_OFFICE_MANAGER']) x;
    elsif v_b.department is not null then
      v_head := (ops.leads(v_b.department, array['DEPARTMENT_HEAD', 'OUTLET_MANAGER'], '{}'))[1];
    end if;
    insert into ops.task (tenant_id, org_node_id, kind, title, description, priority, due_at,
                          status, assign_mode, job_role_code, assignee_user_id, assigned_by,
                          minibar_check_id)
    values (v_c.tenant_id, coalesce(v_b.department, v_c.org_node_id), 'minibar_bill',
            left('Bill room ' || v_room || ': ' || v_used, 200),
            format('Add %s to the guest''s bill, then mark it added.', v_c.charge),
            'high', greatest(v_c.checked_at, coalesce(v_start, v_c.checked_at)) + interval '1 hour',
            'open',
            case when coalesce(v_b.person, v_head) is not null then 'person'
                 when v_b.job_role is not null then 'job_role' else 'on_shift' end,
            case when coalesce(v_b.person, v_head) is null then v_b.job_role end,
            coalesce(v_b.person, v_head), v_me, p_check)
    returning * into v_t;
    -- routed, not handed on by whoever checked (2)
    update ops.task_handover set by_user = null where task_id = v_t.id;
    if v_t.assignee_user_id is not null then
      perform ops.notify_task(v_t, array[v_t.assignee_user_id], 'task_assigned',
                              'New task: ' || v_t.title);
    end if;
  end if;
end $$;

-- migrate:down
