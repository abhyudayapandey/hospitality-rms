-- migrate:up
-- The minibar's refill and billing as tasks (GM feedback item 20, ADR 081).
--
-- A check that finds items used now makes two To do items, through ops.task and its handover
-- rules (ADR 074, 075):
--   * "Refill minibar, room 104" for whoever checked it (the attendant), at their department;
--   * "Bill room 104: 1 Lager Beer, 2 Tonic Water" for the front desk: the Front Desk
--     Executive (or Front Office Manager) on shift there now, else the Front Desk Executives'
--     job role, else the department's head.
-- The stock leaves the store when the refill is done (ops.refill_minibar), as far as the store
-- has it, no longer at the check: that is when someone takes it. Marking the charge added to
-- the bill (ops.mark_minibar_charged) closes the billing task and tells the attendant and the
-- housekeeping heads. Neither task is closed through ops.complete_task: each has its button.
-- The test customers' past checks (file 42) are refilled at once, as the person, at the time.

alter table ops.task drop constraint task_kind_check,
  add constraint task_kind_check check (kind in ('one_off', 'checklist', 'prep', 'expiry',
    'receive', 'licence', 'compliance', 'minibar_refill', 'minibar_bill'));
alter table ops.task add column minibar_check_id uuid references ops.minibar_check(id),
  add constraint task_minibar check ((kind in ('minibar_refill', 'minibar_bill'))
                                     = (minibar_check_id is not null));
create index task_minibar_check on ops.task (minibar_check_id) where minibar_check_id is not null;

-- What was used, in words: "1 Lager Beer, 2 Tonic Water".
create function ops.minibar_used_words(p_check uuid) returns text
language sql stable security definer
set search_path = pg_catalog, inv, ops
as $$
  select string_agg(trim_scale(l.used_qty) || ' ' || i.name, ', ' order by l.id)
    from ops.minibar_check_line l join inv.item i on i.id = l.item_id
   where l.check_id = p_check and l.used_qty > 0;
$$;
revoke execute on function ops.minibar_used_words(uuid) from public;

-- Who bills a room at this outlet now: a front desk person on shift, else the role's pool.
create function ops.minibar_biller(p_outlet uuid)
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
         (select a.owner_user_id
            from hr.shift_assignment a
            join hr.shift s on s.id = a.shift_id and s.status = 'published'
            join hr.worker w on w.owner_user_id = a.owner_user_id and w.status = 'active'
            join core.app_user u on u.id = a.owner_user_id and u.status = 'active'
           where a.status = 'assigned' and a.org_node_id = d.dept
             and w.role_code in ('FRONT_DESK_EXECUTIVE', 'FRONT_OFFICE_MANAGER')
             and a.start_at <= now() and a.end_at > now()
           order by (w.role_code = 'FRONT_DESK_EXECUTIVE') desc, a.start_at, a.owner_user_id
           limit 1),
         case when exists (select 1 from hr.worker w where w.org_node_id = d.dept
                              and w.role_code = 'FRONT_DESK_EXECUTIVE' and w.status = 'active')
              then 'FRONT_DESK_EXECUTIVE' end
    from desk d;
$$;
revoke execute on function ops.minibar_biller(uuid) from public;

-- The two tasks for a check that found something used. Called by ops.check_minibar.
create function ops.minibar_tasks(p_check uuid) returns void
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

  -- the bill: the front desk
  if v_c.charge > 0 then
    select * into v_b from ops.minibar_biller(v_c.org_node_id);
    if v_b.person is null and v_b.job_role is null and v_b.department is not null then
      v_head := (ops.leads(v_b.department, array['DEPARTMENT_HEAD', 'OUTLET_MANAGER'], '{}'))[1];
    end if;
    insert into ops.task (tenant_id, org_node_id, kind, title, description, priority, due_at,
                          status, assign_mode, job_role_code, assignee_user_id, assigned_by,
                          minibar_check_id)
    values (v_c.tenant_id, coalesce(v_b.department, v_c.org_node_id), 'minibar_bill',
            left('Bill room ' || v_room || ': ' || v_used, 200),
            format('Add %s to the guest''s bill, then mark it added.', v_c.charge),
            'high', v_c.checked_at + interval '1 hour', 'open',
            case when coalesce(v_b.person, v_head) is not null then 'person'
                 when v_b.job_role is not null then 'job_role' else 'on_shift' end,
            case when coalesce(v_b.person, v_head) is null then v_b.job_role end,
            coalesce(v_b.person, v_head), v_me, p_check)
    returning * into v_t;
    if v_t.assignee_user_id is not null then
      perform ops.notify_task(v_t, array[v_t.assignee_user_id], 'task_assigned',
                              'New task: ' || v_t.title);
    end if;
  end if;
end $$;
revoke execute on function ops.minibar_tasks(uuid) from public;

-- Takes what was used out of the store for the room, as far as the store has it, at p_at.
create function ops.minibar_refill_at(p_check uuid, p_at timestamptz) returns boolean
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_c ops.minibar_check;
  v_l ops.minibar_check_line;
  v_refill numeric;
  v_cost numeric;
  v_short boolean := false;
begin
  select * into v_c from ops.minibar_check where id = p_check for update;
  for v_l in select * from ops.minibar_check_line
              where check_id = p_check and used_qty > refilled_qty loop
    v_refill := least(v_l.used_qty - v_l.refilled_qty,
                      greatest(inv.on_hand(v_l.item_id, v_c.store_id), 0));
    v_short := v_short or v_refill < v_l.used_qty - v_l.refilled_qty;
    v_cost := inv.avg_cost(v_l.item_id, v_c.store_id);
    if v_refill > 0 then
      perform inv.post_at(v_l.item_id, v_c.store_id, 'consumption', -v_refill, v_cost,
                          'minibar', p_check, p_at);
    end if;
    update ops.minibar_check_line
       set refilled_qty = refilled_qty + v_refill, unit_cost = coalesce(v_cost, unit_cost)
     where id = v_l.id;
  end loop;
  update ops.minibar_check set short = v_short where id = p_check;
  return v_short;
end $$;
revoke execute on function ops.minibar_refill_at(uuid, timestamptz) from public;

-- The attendant refilled the room: the stock leaves the store, the task is done. Whoever has
-- the refill task (ADR 074). Returns whether the store was short.
create function ops.refill_minibar(p_task uuid) returns boolean
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task := ops.task_to_work(p_task);
  v_short boolean;
begin
  if v_t.kind <> 'minibar_refill' then
    perform ops.fail('INVALID_STATE', 'not a minibar refill');
  end if;
  v_short := ops.minibar_refill_at(v_t.minibar_check_id, now());
  update ops.task set status = 'done', completed_by = core.current_user_id(), completed_at = now()
   where id = v_t.id;
  return v_short;
end $$;
revoke execute on function ops.refill_minibar(uuid) from public;
grant execute on function ops.refill_minibar(uuid) to app_rw;

-- A check: what is left, what was used and its charge; the refill and the bill are tasks.
create or replace function ops.check_minibar(p_room uuid, p_lines jsonb, p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
declare
  v_room ops.room := ops.minibar_room_row(p_room);
  v_set ops.minibar_set;
  v_id uuid;
  v_at timestamptz := coalesce(nullif(current_setting('app.occurred_at', true), '')::timestamptz,
                               now());
  v_line record;
  v_used numeric;
  v_charge numeric := 0;
begin
  if v_room.id is null or not core.can('MINIBAR', 'modify', v_room.org_node_id, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('room %s', p_room);
  end if;
  if p_idempotency_key is not null then
    select c.id into v_id from ops.minibar_check c
     where c.tenant_id = core.my_tenant() and c.created_by = core.current_user_id()
       and c.idempotency_key = p_idempotency_key;
    if v_id is not null then
      return v_id;
    end if;
  end if;
  select * into v_set from ops.minibar_set
   where id = v_room.minibar_set_id and archived_at is null;
  if v_set.id is null then
    raise exception 'NO_MINIBAR' using detail = format('room %s has no minibar set', p_room);
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'INVALID_LINES';
  end if;
  -- every item of the set, once, with a count of zero or more
  if exists (select 1 from jsonb_to_recordset(p_lines) as x(item_id uuid, "left" numeric)
              where x.item_id is null or x."left" is null or x."left" < 0
                 or not exists (select 1 from ops.minibar_set_line l
                                 where l.set_id = v_set.id and l.item_id = x.item_id))
     or (select count(distinct x.item_id) from jsonb_to_recordset(p_lines) as x(item_id uuid))
        <> jsonb_array_length(p_lines)
     or jsonb_array_length(p_lines)
        <> (select count(*) from ops.minibar_set_line l where l.set_id = v_set.id) then
    raise exception 'INVALID_LINES' using detail = 'count every item of the minibar once';
  end if;

  insert into ops.minibar_check (tenant_id, org_node_id, room_id, store_id, checked_at,
                                 business_day, idempotency_key)
  values (v_room.tenant_id, v_room.org_node_id, v_room.id, v_set.store_id, v_at,
          rpt.business_date(v_at, ops.tz_of(v_room.org_node_id)), p_idempotency_key)
  returning id into v_id;

  for v_line in
    select l.item_id, l.par, l.price, x."left"
      from ops.minibar_set_line l
      join jsonb_to_recordset(p_lines) as x(item_id uuid, "left" numeric)
        on x.item_id = l.item_id
     where l.set_id = v_set.id
     order by l.position
  loop
    v_used := greatest(v_line.par - v_line."left", 0);
    insert into ops.minibar_check_line (tenant_id, org_node_id, check_id, item_id, par,
                                        left_qty, used_qty, refilled_qty, price, unit_cost)
    values (v_room.tenant_id, v_room.org_node_id, v_id, v_line.item_id, v_line.par,
            v_line."left", v_used, 0, v_line.price,
            coalesce(inv.avg_cost(v_line.item_id, v_set.store_id), 0));
    v_charge := v_charge + v_used * v_line.price;
  end loop;

  update ops.minibar_check set charge = round(v_charge, 2),
         -- nothing to charge: nothing to add to the bill
         charged_at = case when v_charge = 0 then v_at end
   where id = v_id;
  perform ops.minibar_tasks(v_id);
  return v_id;
end $$;

-- Front Office: the charge is on the guest's bill. Closes the billing task and tells the
-- attendant and the housekeeping heads.
create or replace function ops.mark_minibar_charged(p_check uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v ops.minibar_check;
  v_bill ops.task;
  v_refill ops.task;
  v_room text;
  v_tell uuid[];
begin
  select * into v from ops.minibar_check c
   where c.id = p_check and c.tenant_id = core.my_tenant()
   for update;
  if v.id is null or not core.can('MINIBAR', 'modify', v.org_node_id, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('minibar check %s', p_check);
  end if;
  if v.charged_at is not null then
    return;
  end if;
  update ops.minibar_check set charged_at = coalesce(nullif(current_setting('app.occurred_at', true), '')::timestamptz, now()),
         charged_by = core.current_user_id()
   where id = p_check;
  update ops.task set status = 'done', completed_by = core.current_user_id(),
         completed_at = coalesce(nullif(current_setting('app.occurred_at', true), '')::timestamptz, now())
   where minibar_check_id = p_check and kind = 'minibar_bill' and status in ('open', 'in_progress')
  returning * into v_bill;
  select * into v_refill from ops.task where minibar_check_id = p_check and kind = 'minibar_refill';
  if v_refill.id is not null then
    select number into v_room from ops.room where id = v.room_id;
    v_tell := array(select distinct u from unnest(
                array[v_refill.assignee_user_id]
                || ops.leads(v_refill.org_node_id, array['DEPARTMENT_HEAD'],
                             array[core.current_user_id()])) u
                    where u is not null and u <> core.current_user_id());
    perform ops.notify_task(v_refill, v_tell, 'minibar_billed',
                            'Room ' || v_room || ': minibar added to the bill',
                            ops.minibar_used_words(p_check) || '.');
  end if;
end $$;

-- A minibar task is done from its own button, never through ops.complete_task.
do $$
declare
  v_src text := pg_get_functiondef('ops.complete_task(uuid, text)'::regprocedure);
  v_old text := 'begin
  if exists (select 1 from ops.task_step where task_id = v_t.id and done_at is null) then';
  v_new text := 'begin
  if v_t.kind in (''minibar_refill'', ''minibar_bill'') then
    perform ops.fail(''INVALID_STATE'', ''refill or bill it from the task'');
  end if;
  if exists (select 1 from ops.task_step where task_id = v_t.id and done_at is null) then';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'ops.complete_task changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- The test customers' past checks (file 42): refilled at once, as the person, at the time.
create or replace function ops.record_test_minibar_check(p_room uuid, p_lines jsonb,
                                                         p_at timestamptz, p_key text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_id uuid;
begin
  if not coalesce((select t.is_test from core.tenant t where t.id = core.my_tenant()), false) then
    raise exception 'NOT_A_TEST_CUSTOMER';
  end if;
  perform set_config('app.occurred_at', p_at::text, true);
  v_id := ops.check_minibar(p_room, p_lines, p_key);
  perform ops.minibar_refill_at(v_id, p_at);
  update ops.task set status = 'done', completed_by = core.current_user_id(), completed_at = p_at
   where minibar_check_id = v_id and kind = 'minibar_refill' and status = 'open';
  perform set_config('app.occurred_at', '', true);
  return v_id;
end $$;

-- A minibar task's check, for its page: the room, what was used and the charge.
create function ops.minibar_task_check(p_task uuid)
returns table (check_id uuid, room text, store text, used jsonb, charge numeric,
               charged_at timestamptz, refilled boolean, short boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant();
  if not found or v_t.minibar_check_id is null or not ops.sees_task(v_t) then
    perform ops.fail('NOT_AUTHORISED', 'see this task');
  end if;
  return query
    select c.id, r.number, core.node_name(c.store_id),
           coalesce((select jsonb_agg(jsonb_build_object('item', i.name, 'qty', l.used_qty,
                                                         'price', l.price, 'unit', i.base_uom)
                                      order by l.id)
                       from ops.minibar_check_line l join inv.item i on i.id = l.item_id
                      where l.check_id = c.id and l.used_qty > 0), '[]'::jsonb),
           c.charge, c.charged_at,
           not exists (select 1 from ops.minibar_check_line l
                        where l.check_id = c.id and l.refilled_qty < l.used_qty
                          and v_t.kind = 'minibar_refill' and v_t.status in ('open', 'in_progress')),
           c.short
      from ops.minibar_check c join ops.room r on r.id = c.room_id
     where c.id = v_t.minibar_check_id;
end $$;
revoke execute on function ops.minibar_task_check(uuid) from public;
grant execute on function ops.minibar_task_check(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.minibar_task_check(uuid);
do $$
begin
  execute replace(pg_get_functiondef('ops.complete_task(uuid, text)'::regprocedure),
    '  if v_t.kind in (''minibar_refill'', ''minibar_bill'') then
    perform ops.fail(''INVALID_STATE'', ''refill or bill it from the task'');
  end if;
', '');
end $$;
create or replace function ops.record_test_minibar_check(p_room uuid, p_lines jsonb,
                                                         p_at timestamptz, p_key text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_id uuid;
begin
  if not coalesce((select t.is_test from core.tenant t where t.id = core.my_tenant()), false) then
    raise exception 'NOT_A_TEST_CUSTOMER';
  end if;
  perform set_config('app.occurred_at', p_at::text, true);
  v_id := ops.check_minibar(p_room, p_lines, p_key);
  perform set_config('app.occurred_at', '', true);
  return v_id;
end $$;
create or replace function ops.mark_minibar_charged(p_check uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v ops.minibar_check;
begin
  select * into v from ops.minibar_check c
   where c.id = p_check and c.tenant_id = core.my_tenant()
   for update;
  if v.id is null or not core.can('MINIBAR', 'modify', v.org_node_id, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('minibar check %s', p_check);
  end if;
  if v.charged_at is not null then
    return;
  end if;
  update ops.minibar_check set charged_at = now(), charged_by = core.current_user_id()
   where id = p_check;
end $$;
create or replace function ops.check_minibar(p_room uuid, p_lines jsonb, p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
declare
  v_room ops.room := ops.minibar_room_row(p_room);
  v_set ops.minibar_set;
  v_id uuid;
  v_at timestamptz := coalesce(nullif(current_setting('app.occurred_at', true), '')::timestamptz,
                               now());
  v_line record;
  v_left numeric;
  v_used numeric;
  v_refill numeric;
  v_cost numeric;
  v_charge numeric := 0;
  v_short boolean := false;
begin
  if v_room.id is null or not core.can('MINIBAR', 'modify', v_room.org_node_id, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('room %s', p_room);
  end if;
  if p_idempotency_key is not null then
    select c.id into v_id from ops.minibar_check c
     where c.tenant_id = core.my_tenant() and c.created_by = core.current_user_id()
       and c.idempotency_key = p_idempotency_key;
    if v_id is not null then
      return v_id;
    end if;
  end if;
  select * into v_set from ops.minibar_set
   where id = v_room.minibar_set_id and archived_at is null;
  if v_set.id is null then
    raise exception 'NO_MINIBAR' using detail = format('room %s has no minibar set', p_room);
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'INVALID_LINES';
  end if;
  -- every item of the set, once, with a count of zero or more
  if exists (select 1 from jsonb_to_recordset(p_lines) as x(item_id uuid, "left" numeric)
              where x.item_id is null or x."left" is null or x."left" < 0
                 or not exists (select 1 from ops.minibar_set_line l
                                 where l.set_id = v_set.id and l.item_id = x.item_id))
     or (select count(distinct x.item_id) from jsonb_to_recordset(p_lines) as x(item_id uuid))
        <> jsonb_array_length(p_lines)
     or jsonb_array_length(p_lines)
        <> (select count(*) from ops.minibar_set_line l where l.set_id = v_set.id) then
    raise exception 'INVALID_LINES' using detail = 'count every item of the minibar once';
  end if;

  insert into ops.minibar_check (tenant_id, org_node_id, room_id, store_id, checked_at,
                                 business_day, idempotency_key)
  values (v_room.tenant_id, v_room.org_node_id, v_room.id, v_set.store_id, v_at,
          rpt.business_date(v_at, ops.tz_of(v_room.org_node_id)), p_idempotency_key)
  returning id into v_id;

  for v_line in
    select l.item_id, l.par, l.price, x."left"
      from ops.minibar_set_line l
      join jsonb_to_recordset(p_lines) as x(item_id uuid, "left" numeric)
        on x.item_id = l.item_id
     where l.set_id = v_set.id
     order by l.position
  loop
    v_left := v_line."left";
    v_used := greatest(v_line.par - v_left, 0);
    v_refill := least(v_used, greatest(inv.on_hand(v_line.item_id, v_set.store_id), 0));
    v_short := v_short or v_refill < v_used;
    v_cost := inv.avg_cost(v_line.item_id, v_set.store_id);
    if v_refill > 0 then
      perform inv.post(v_line.item_id, v_set.store_id, 'consumption', -v_refill, v_cost,
                       'minibar', v_id, 'minibar refill');
    end if;
    insert into ops.minibar_check_line (tenant_id, org_node_id, check_id, item_id, par,
                                        left_qty, used_qty, refilled_qty, price, unit_cost)
    values (v_room.tenant_id, v_room.org_node_id, v_id, v_line.item_id, v_line.par, v_left,
            v_used, v_refill, v_line.price, coalesce(v_cost, 0));
    v_charge := v_charge + v_used * v_line.price;
  end loop;

  update ops.minibar_check set charge = round(v_charge, 2), short = v_short,
         -- nothing to charge: nothing to add to the bill
         charged_at = case when v_charge = 0 then v_at end
   where id = v_id;
  return v_id;
end $$;
drop function ops.refill_minibar(uuid), ops.minibar_refill_at(uuid, timestamptz),
  ops.minibar_tasks(uuid), ops.minibar_biller(uuid), ops.minibar_used_words(uuid);
delete from ops.task_handover where task_id in
  (select id from ops.task where kind in ('minibar_refill', 'minibar_bill'));
delete from ops.task where kind in ('minibar_refill', 'minibar_bill');
alter table ops.task drop constraint task_minibar, drop column minibar_check_id;
alter table ops.task drop constraint task_kind_check,
  add constraint task_kind_check check (kind in ('one_off', 'checklist', 'prep', 'expiry',
    'receive', 'licence', 'compliance'));
