-- migrate:up
-- Checklists, part 2 (ADR 088): what was done about a reading, a round for each room or area,
-- and each room's status.
--
-- * A reading out of its range needs what was done about it (`action`) before it is saved; the
--   leads are told both. A step may also ask which food was probed (`food`) and whether
--   out-of-date food was thrown away (`thrown`): the SOP's temperature log.
-- * A checklist may repeat its steps for each room of its outlet (file 40) or for each named
--   area (`for_each`): its round is a grid, rooms or areas down, steps across. Each cell is a
--   step of its own (`grid_row`, `room_id`), done and checked like any other.
-- * Each room's status (VC vacant clean, VD vacant dirty, OCC occupied, ARR arriving, DEP
--   departing, OOO out of order, HM house use), set on the grid by housekeeping or on the Rooms
--   screen by front office: ops.room_status, the Rooms block (ROOMS, ADR 085).

-- ---------------------------------------------------------------------------
-- Readings
-- ---------------------------------------------------------------------------
alter table ops.task_step
  add column asks_food boolean not null default false,
  add column asks_thrown boolean not null default false,
  add column action_text text check (length(action_text) <= 500),
  add column food_text text check (length(food_text) <= 200),
  add column thrown_away boolean,
  add column grid_row text check (length(grid_row) <= 60),
  add column room_id uuid references ops.room(id);

select core.patch_function('ops.check_steps(jsonb)',
$x$    if v_s ? 'icon' and$x$,
$x$    if jsonb_typeof(v_s -> 'food') not in ('boolean', 'null') and v_s ? 'food'
       or jsonb_typeof(v_s -> 'thrown') not in ('boolean', 'null') and v_s ? 'thrown' then
      perform ops.fail('INVALID_STEPS', 'food and thrown are yes or no');
    end if;
    if coalesce((v_s ->> 'food')::boolean, false) and v_s ->> 'kind' <> 'number' then
      perform ops.fail('INVALID_STEPS', 'only a reading asks which food was probed');
    end if;
    if v_s ? 'icon' and$x$);

create or replace function ops.add_steps(p_task ops.task, p_steps jsonb) returns void
language sql security definer
set search_path = pg_catalog, ops
as $$
  insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind, min_value,
                             max_value, unit, photo_required, icon, asks_food, asks_thrown)
  select p_task.tenant_id, p_task.id, p_task.org_node_id, s.ord, btrim(s.v ->> 'label'),
         s.v ->> 'kind', (s.v ->> 'min')::numeric, (s.v ->> 'max')::numeric,
         nullif(btrim(s.v ->> 'unit'), ''), coalesce((s.v ->> 'photo_required')::boolean, false),
         nullif(s.v ->> 'icon', ''), coalesce((s.v ->> 'food')::boolean, false),
         coalesce((s.v ->> 'thrown')::boolean, false)
    from jsonb_array_elements(p_steps) with ordinality s(v, ord);
$$;

-- the reading's checks, before it is saved
select core.patch_function('ops.complete_step(uuid, uuid, jsonb)',
$x$  update ops.task_step
     set value_num = v_num, value_text = v_text, photo_key = v_photo,
         flagged = coalesce(v_flagged, false), done_by = core.current_user_id(), done_at = now()
   where id = v_s.id;$x$,
$x$  if coalesce(v_flagged, false) and nullif(btrim(p_value ->> 'action'), '') is null then
    perform ops.fail('ACTION_NEEDED', 'say what you did about it');
  end if;
  if v_s.asks_food and nullif(btrim(p_value ->> 'food'), '') is null then
    perform ops.fail('INVALID_VALUE', 'which food you probed');
  end if;
  if v_s.asks_thrown and jsonb_typeof(p_value -> 'thrown') is distinct from 'boolean' then
    perform ops.fail('INVALID_VALUE', 'whether out-of-date food was thrown away');
  end if;
  update ops.task_step
     set value_num = v_num, value_text = v_text, photo_key = v_photo,
         flagged = coalesce(v_flagged, false), done_by = core.current_user_id(), done_at = now(),
         action_text = case when coalesce(v_flagged, false)
                            then left(btrim(p_value ->> 'action'), 500) end,
         food_text = case when v_s.asks_food then left(btrim(p_value ->> 'food'), 200) end,
         thrown_away = case when v_s.asks_thrown then (p_value ->> 'thrown')::boolean end
   where id = v_s.id;$x$);
select core.patch_function('ops.complete_step(uuid, uuid, jsonb)',
$x$                            format('Acceptable: %s to %s', coalesce(v_s.min_value::text, '…'),
                                   coalesce(v_s.max_value::text, '…')));$x$,
$x$                            format('Acceptable: %s to %s. Done: %s',
                                   coalesce(v_s.min_value::text, '…'),
                                   coalesce(v_s.max_value::text, '…'),
                                   btrim(p_value ->> 'action')));$x$);

-- ---------------------------------------------------------------------------
-- For each room or area
-- ---------------------------------------------------------------------------
alter table ops.checklist_template add column for_each jsonb;

-- {"rooms": true} or {"areas": ["Lobby", "Pool deck"]}; null: once.
create function ops.check_for_each(p_for_each jsonb) returns void
language plpgsql immutable
as $$
begin
  if p_for_each is null or jsonb_typeof(p_for_each) = 'null' then
    return;
  end if;
  if p_for_each = '{"rooms": true}'::jsonb then
    return;
  end if;
  if jsonb_typeof(p_for_each -> 'areas') is distinct from 'array'
     or (select count(*) from jsonb_object_keys(p_for_each)) <> 1
     or jsonb_array_length(p_for_each -> 'areas') not between 1 and 60
     or exists (select 1 from jsonb_array_elements(p_for_each -> 'areas') a
                 where jsonb_typeof(a) <> 'string' or length(btrim(a #>> '{}')) not between 1 and 60)
     or (select count(distinct lower(btrim(a))) from jsonb_array_elements_text(p_for_each -> 'areas') a)
        <> jsonb_array_length(p_for_each -> 'areas') then
    perform ops.fail('INVALID_FOR_EACH', 'every room, or 1 to 60 named areas');
  end if;
end $$;

-- A round's steps: once, or for each room of its outlet (by floor and number) or named area.
create function ops.add_round_steps(p_task ops.task, p_steps jsonb, p_for_each jsonb)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_n int := jsonb_array_length(p_steps);
begin
  if p_for_each is null or jsonb_typeof(p_for_each) = 'null' then
    perform ops.add_steps(p_task, p_steps);
    return;
  end if;
  insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind, min_value,
                             max_value, unit, photo_required, icon, asks_food, asks_thrown,
                             grid_row, room_id)
  select p_task.tenant_id, p_task.id, p_task.org_node_id, (r.ord - 1) * v_n + s.ord,
         btrim(s.v ->> 'label'), s.v ->> 'kind', (s.v ->> 'min')::numeric,
         (s.v ->> 'max')::numeric, nullif(btrim(s.v ->> 'unit'), ''),
         coalesce((s.v ->> 'photo_required')::boolean, false), nullif(s.v ->> 'icon', ''),
         coalesce((s.v ->> 'food')::boolean, false), coalesce((s.v ->> 'thrown')::boolean, false),
         r.label, r.room_id
    from (select row_number() over (order by x.floor nulls first, x.number) as ord,
                 x.number as label, x.id as room_id
            from ops.room x
           where (p_for_each ->> 'rooms')::boolean
             and x.tenant_id = p_task.tenant_id and x.archived_at is null
             and x.org_node_id = core.nearest(p_task.org_node_id, array['outlet'])
          union all
          select a.ord, btrim(a.v), null
            from jsonb_array_elements_text(p_for_each -> 'areas') with ordinality a(v, ord)
           where p_for_each ? 'areas') r
   cross join jsonb_array_elements(p_steps) with ordinality s(v, ord);
end $$;

select core.patch_function('ops.tasks_tick(timestamptz)',
$x$perform ops.add_steps(v_t, ops.steps_on(v_tpl.steps,
                                    (v_at at time zone ops.tz_of(v_tpl.org_node_id))::date));$x$,
$x$perform ops.add_round_steps(v_t, ops.steps_on(v_tpl.steps,
                                          (v_at at time zone ops.tz_of(v_tpl.org_node_id))::date),
                                v_tpl.for_each);$x$);

-- ---------------------------------------------------------------------------
-- Room status (the Rooms block)
-- ---------------------------------------------------------------------------
create table ops.room_status (
  id uuid primary key default core.uuid_v7(),
  room_id uuid not null unique references ops.room(id),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the room's outlet
  status text not null check (status in ('VC', 'VD', 'OCC', 'ARR', 'DEP', 'OOO', 'HM')),
  set_at timestamptz not null default now(),
  set_by uuid references core.app_user(id)
);
select core.add_standard_columns('ops.room_status');

-- What each status is called on the screens and in the files.
create function ops.room_status_name(p_status text) returns text
language sql immutable
as $$
  select case p_status
           when 'VC' then 'Vacant clean' when 'VD' then 'Vacant dirty'
           when 'OCC' then 'Occupied' when 'ARR' then 'Arriving'
           when 'DEP' then 'Departing' when 'OOO' then 'Out of order'
           when 'HM' then 'House use' end;
$$;

-- Set a room's status: whoever keeps the rooms there (ROOMS modify: front office and
-- housekeeping through "Checks the rooms' minibars", the outlet's managers).
create function ops.set_room_status(p_room uuid, p_status text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_r ops.room;
begin
  select * into v_r from ops.room
   where id = p_room and tenant_id = core.my_tenant() and archived_at is null;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such room');
  end if;
  if not core.can('ROOMS', 'modify', v_r.org_node_id, null) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS modify');
  end if;
  if ops.room_status_name(p_status) is null then
    perform ops.fail('INVALID_VALUE', 'VC, VD, OCC, ARR, DEP, OOO or HM');
  end if;
  insert into ops.room_status (tenant_id, org_node_id, room_id, status, set_at, set_by)
  values (v_r.tenant_id, v_r.org_node_id, v_r.id, p_status, now(), core.current_user_id())
  on conflict (room_id) do update
     set status = excluded.status, set_at = excluded.set_at, set_by = excluded.set_by
   where ops.room_status.status is distinct from excluded.status;
end $$;

-- The outlet's rooms with their status (vacant clean when never set), for whoever may see them.
create function ops.rooms(p_outlet uuid)
returns table (room_id uuid, number text, floor text, room_type text, status text,
               status_name text, set_at timestamptz, set_by_name text, can_set boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
begin
  if not core.can('ROOMS', 'view', p_outlet, null) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS view');
  end if;
  return query
    select r.id, r.number, r.floor, r.room_type, coalesce(s.status, 'VC'),
           ops.room_status_name(coalesce(s.status, 'VC')), s.set_at,
           (select display_name from core.app_user where id = s.set_by),
           core.can('ROOMS', 'modify', r.org_node_id, null)
      from ops.room r
      left join ops.room_status s on s.room_id = r.id
     where r.org_node_id = p_outlet and r.tenant_id = core.my_tenant() and r.archived_at is null
     order by r.floor nulls first, r.number;
end $$;

-- The outlets with rooms where I may see them.
create function ops.room_outlets()
returns table (outlet_id uuid, name text, rooms int)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select n.id, n.name, count(r.id)::int
    from core.hierarchy_node n
    join ops.room r on r.org_node_id = n.id and r.archived_at is null
   where n.tenant_id = core.my_tenant() and n.archived_at is null
     and core.can('ROOMS', 'view', n.id, null)
   group by n.id, n.name
   order by n.name;
$$;

-- the grid shows each room's status beside its row
select core.patch_function('ops.task_detail(uuid)',
$x$               'checked_at', s.checked_at,$x$,
$x$               'action_text', s.action_text, 'food_text', s.food_text,
               'thrown_away', s.thrown_away, 'asks_food', s.asks_food,
               'asks_thrown', s.asks_thrown, 'grid_row', s.grid_row, 'room_id', s.room_id,
               'room_status', (select coalesce(rs.status, 'VC') from ops.room r
                                 left join ops.room_status rs on rs.room_id = r.id
                                where r.id = s.room_id),
               'checked_at', s.checked_at,$x$);
select core.patch_function('ops.task_detail(uuid)',
$x$    'can_work', coalesce(ops.can_work(v_t, v_me), false),$x$,
$x$    'can_set_room_status', exists (select 1 from ops.task_step s where s.task_id = v_t.id
                                       and s.room_id is not null)
                           and core.can('ROOMS', 'modify',
                                        core.nearest(v_t.org_node_id, array['outlet']), null),
    'can_work', coalesce(ops.can_work(v_t, v_me), false),$x$);

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.room_status', 'ROOMS', 'org', true);
select core.apply_domain_rls('ops.room_status');
select audit.enable('ops.room_status');

revoke execute on function ops.check_for_each(jsonb), ops.add_round_steps(ops.task, jsonb, jsonb),
  ops.room_status_name(text), ops.set_room_status(uuid, text), ops.rooms(uuid),
  ops.room_outlets(),
  -- and part 1's (ADR 087)
  ops.steps_on(jsonb, date), ops.role_level(uuid, text), ops.sign_off_signer(ops.task, text),
  ops.ask_sign_off(), ops.sign_off(uuid), ops.send_back(uuid, text)
  from public, platform_loader;
grant execute on function ops.set_room_status(uuid, text), ops.rooms(uuid), ops.room_outlets(),
  ops.room_status_name(text), ops.sign_off(uuid), ops.send_back(uuid, text) to app_rw;
grant execute on function ops.check_for_each(jsonb) to platform_loader;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
do $$
begin
  execute regexp_replace(pg_get_functiondef('ops.task_detail(uuid)'::regprocedure),
    E'    ''can_set_room_status''.*?(    ''can_work'')', E'\\1', 's');
  execute regexp_replace(pg_get_functiondef('ops.task_detail(uuid)'::regprocedure),
    E'               ''action_text''.*?(               ''checked_at'')', E'\\1', 's');
end $$;
drop function ops.room_outlets();
drop function ops.rooms(uuid);
drop function ops.set_room_status(uuid, text);
drop function ops.room_status_name(text);
delete from core.domain_table where table_name = 'ops.room_status'::regclass;
drop table ops.room_status;
select core.patch_function('ops.tasks_tick(timestamptz)',
$x$perform ops.add_round_steps(v_t, ops.steps_on(v_tpl.steps,
                                          (v_at at time zone ops.tz_of(v_tpl.org_node_id))::date),
                                v_tpl.for_each);$x$,
$x$perform ops.add_steps(v_t, ops.steps_on(v_tpl.steps,
                                    (v_at at time zone ops.tz_of(v_tpl.org_node_id))::date));$x$);
drop function ops.add_round_steps(ops.task, jsonb, jsonb);
drop function ops.check_for_each(jsonb);
alter table ops.checklist_template drop column for_each;
select core.patch_function('ops.complete_step(uuid, uuid, jsonb)',
$x$                            format('Acceptable: %s to %s. Done: %s',
                                   coalesce(v_s.min_value::text, '…'),
                                   coalesce(v_s.max_value::text, '…'),
                                   btrim(p_value ->> 'action')));$x$,
$x$                            format('Acceptable: %s to %s', coalesce(v_s.min_value::text, '…'),
                                   coalesce(v_s.max_value::text, '…')));$x$);
do $$
begin
  execute regexp_replace(pg_get_functiondef('ops.complete_step(uuid, uuid, jsonb)'::regprocedure),
    E'  if coalesce\\(v_flagged, false\\) and nullif.*?(  update ops.task_step)', E'\\1', 's');
end $$;
select core.patch_function('ops.complete_step(uuid, uuid, jsonb)',
$x$         flagged = coalesce(v_flagged, false), done_by = core.current_user_id(), done_at = now(),
         action_text = case when coalesce(v_flagged, false)
                            then left(btrim(p_value ->> 'action'), 500) end,
         food_text = case when v_s.asks_food then left(btrim(p_value ->> 'food'), 200) end,
         thrown_away = case when v_s.asks_thrown then (p_value ->> 'thrown')::boolean end$x$,
$x$         flagged = coalesce(v_flagged, false), done_by = core.current_user_id(), done_at = now()$x$);
create or replace function ops.add_steps(p_task ops.task, p_steps jsonb) returns void
language sql security definer
set search_path = pg_catalog, ops
as $$
  insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind, min_value,
                             max_value, unit, photo_required, icon)
  select p_task.tenant_id, p_task.id, p_task.org_node_id, s.ord, btrim(s.v ->> 'label'),
         s.v ->> 'kind', (s.v ->> 'min')::numeric, (s.v ->> 'max')::numeric,
         nullif(btrim(s.v ->> 'unit'), ''), coalesce((s.v ->> 'photo_required')::boolean, false),
         nullif(s.v ->> 'icon', '')
    from jsonb_array_elements(p_steps) with ordinality s(v, ord);
$$;
do $$
begin
  execute regexp_replace(pg_get_functiondef('ops.check_steps(jsonb)'::regprocedure),
    E'    if jsonb_typeof\\(v_s -> ''food''\\).*?(    if v_s \\? ''icon'')', E'\\1', 's');
end $$;
alter table ops.task_step drop column asks_food, drop column asks_thrown,
  drop column action_text, drop column food_text, drop column thrown_away,
  drop column grid_row, drop column room_id;
