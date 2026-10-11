-- migrate:up
-- A room's status carries what the front desk needs with it (ADR 117): arriving and leaving
-- rooms their time, an out-of-order room its reason, the day it is back and the maintenance
-- request for it (an open one at the outlet, or one raised from the room). House use is not
-- used: a room in it is clean, and no one may set it again. The statuses stay on the room, so
-- the next person on duty sees the same list.

alter table ops.room_status
  add column at_time time,
  add column reason text check (length(reason) <= 200),
  add column until date,
  add column maintenance_id uuid references ops.maintenance_request(id);

update ops.room_status set status = 'VC' where status = 'HM';

create or replace function ops.room_status_name(p_status text) returns text
language sql immutable
as $$
  select case p_status
           when 'VC' then 'Vacant clean' when 'VD' then 'Vacant dirty'
           when 'OCC' then 'Occupied' when 'ARR' then 'Arriving'
           when 'DEP' then 'Leaving' when 'OOO' then 'Out of order' end;
$$;

-- Set a room's status with its details (p_details: {"time": "14:00"} for arriving or leaving;
-- {"reason": ..., "until": "2026-10-20", "maintenance": <request id> | "raise": true} for out
-- of order). Whoever keeps the rooms there (ROOMS modify). Raising one reports it to
-- maintenance as the person setting it, at the room's outlet.
drop function ops.set_room_status(uuid, text);
create function ops.set_room_status(p_room uuid, p_status text, p_details jsonb default '{}')
returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_r ops.room;
  v_d jsonb := coalesce(p_details, '{}');
  v_time time;
  v_reason text;
  v_until date;
  v_req uuid;
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
    perform ops.fail('INVALID_VALUE', 'VC, VD, OCC, ARR, DEP or OOO');
  end if;
  if p_status in ('ARR', 'DEP') and nullif(v_d ->> 'time', '') is not null then
    begin
      v_time := (v_d ->> 'time')::time;
    exception when others then
      perform ops.fail('INVALID_VALUE', 'a time like 14:00');
    end;
  end if;
  if p_status = 'OOO' then
    v_reason := nullif(btrim(coalesce(v_d ->> 'reason', '')), '');
    if v_reason is null then
      perform ops.fail('REASON_REQUIRED', 'why the room is out of order');
    end if;
    if nullif(v_d ->> 'until', '') is not null then
      begin
        v_until := (v_d ->> 'until')::date;
      exception when others then
        perform ops.fail('INVALID_VALUE', 'a date');
      end;
      if v_until < rpt.today(v_r.org_node_id) then
        perform ops.fail('INVALID_VALUE', 'the day it is back is not in the past');
      end if;
    end if;
    if nullif(v_d ->> 'maintenance', '') is not null then
      select m.id into v_req from ops.maintenance_request m
        join core.hierarchy_node p on p.id = m.place_node_id
        join core.hierarchy_node o on o.id = v_r.org_node_id
       where m.id = (v_d ->> 'maintenance')::uuid and m.tenant_id = v_r.tenant_id
         and p.path operator(extensions.<@) o.path;
      if v_req is null then
        perform ops.fail('NOT_FOUND', 'no such maintenance request at this outlet');
      end if;
    elsif coalesce((v_d ->> 'raise')::boolean, false) then
      v_req := ops.raise_maintenance(v_r.org_node_id, 'Room ' || v_r.number || ': ' || v_reason,
                                     'Out of order' || coalesce(' until ' || to_char(v_until, 'DD Mon'), ''),
                                     null);
    end if;
  end if;
  insert into ops.room_status (tenant_id, org_node_id, room_id, status, set_at, set_by,
                               at_time, reason, until, maintenance_id)
  values (v_r.tenant_id, v_r.org_node_id, v_r.id, p_status, now(), core.current_user_id(),
          v_time, v_reason, v_until, v_req)
  on conflict (room_id) do update
     set status = excluded.status, set_at = excluded.set_at, set_by = excluded.set_by,
         at_time = excluded.at_time, reason = excluded.reason, until = excluded.until,
         maintenance_id = excluded.maintenance_id
   where (ops.room_status.status, ops.room_status.at_time, ops.room_status.reason,
          ops.room_status.until, ops.room_status.maintenance_id)
         is distinct from (excluded.status, excluded.at_time, excluded.reason, excluded.until,
                           excluded.maintenance_id);
end $$;

-- The outlet's rooms with their status and its details, whose they are today and whether
-- they are mine.
drop function ops.rooms(uuid);
create function ops.rooms(p_outlet uuid)
returns table (room_id uuid, number text, floor text, room_type text, status text,
               status_name text, set_at timestamptz, set_by_name text, can_set boolean,
               given_to uuid, given_to_name text, mine boolean,
               at_time text, reason text, until date, maintenance_id uuid,
               maintenance_title text, maintenance_status text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
begin
  if not core.can('ROOMS', 'view', p_outlet, null) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS view');
  end if;
  return query
    select r.id, r.number, r.floor, r.room_type, coalesce(s.status, 'VC'),
           ops.room_status_name(coalesce(s.status, 'VC')), s.set_at,
           (select display_name from core.app_user where id = s.set_by),
           core.can('ROOMS', 'modify', r.org_node_id, null),
           a.user_id, (select display_name from core.app_user where id = a.user_id),
           a.user_id is not distinct from core.current_user_id() and a.user_id is not null,
           to_char(s.at_time, 'HH24:MI'), s.reason, s.until, m.id, m.title, m.status
      from ops.room r
      left join ops.room_status s on s.room_id = r.id
      left join ops.maintenance_request m on m.id = s.maintenance_id
      left join ops.room_assignment a on a.room_id = r.id and a.day = rpt.today(p_outlet)
     where r.org_node_id = p_outlet and r.tenant_id = core.my_tenant() and r.archived_at is null
     order by r.floor nulls first, r.number;
end $$;

-- The open maintenance requests at a room's outlet, to tag it with when out of order: for
-- whoever keeps its rooms.
create function ops.room_maintenance_open(p_room uuid)
returns table (id uuid, title text, status text, created_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_outlet uuid;
begin
  select r.org_node_id into v_outlet from ops.room r
   where r.id = p_room and r.tenant_id = core.my_tenant() and r.archived_at is null;
  if v_outlet is null or not core.can('ROOMS', 'modify', v_outlet, null) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS modify');
  end if;
  return query
    select m.id, m.title, m.status, m.created_at
      from ops.maintenance_request m
      join core.hierarchy_node p on p.id = m.place_node_id
      join core.hierarchy_node o on o.id = v_outlet
     where m.tenant_id = core.my_tenant() and m.status <> 'done' and p.path operator(extensions.<@) o.path
     order by m.created_at desc
     limit 30;
end $$;

revoke execute on function ops.set_room_status(uuid, text, jsonb), ops.rooms(uuid),
  ops.room_maintenance_open(uuid) from public;
grant execute on function ops.set_room_status(uuid, text, jsonb), ops.rooms(uuid),
  ops.room_maintenance_open(uuid) to app_rw;

-- migrate:down
drop function ops.room_maintenance_open(uuid);
drop function ops.rooms(uuid);
create function ops.rooms(p_outlet uuid)
returns table (room_id uuid, number text, floor text, room_type text, status text,
               status_name text, set_at timestamptz, set_by_name text, can_set boolean,
               given_to uuid, given_to_name text, mine boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
begin
  if not core.can('ROOMS', 'view', p_outlet, null) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS view');
  end if;
  return query
    select r.id, r.number, r.floor, r.room_type, coalesce(s.status, 'VC'),
           ops.room_status_name(coalesce(s.status, 'VC')), s.set_at,
           (select display_name from core.app_user where id = s.set_by),
           core.can('ROOMS', 'modify', r.org_node_id, null),
           a.user_id, (select display_name from core.app_user where id = a.user_id),
           a.user_id is not distinct from core.current_user_id() and a.user_id is not null
      from ops.room r
      left join ops.room_status s on s.room_id = r.id
      left join ops.room_assignment a on a.room_id = r.id and a.day = rpt.today(p_outlet)
     where r.org_node_id = p_outlet and r.tenant_id = core.my_tenant() and r.archived_at is null
     order by r.floor nulls first, r.number;
end $$;
drop function ops.set_room_status(uuid, text, jsonb);
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
revoke execute on function ops.set_room_status(uuid, text), ops.rooms(uuid) from public;
grant execute on function ops.set_room_status(uuid, text), ops.rooms(uuid) to app_rw;
create or replace function ops.room_status_name(p_status text) returns text
language sql immutable
as $$
  select case p_status
           when 'VC' then 'Vacant clean' when 'VD' then 'Vacant dirty'
           when 'OCC' then 'Occupied' when 'ARR' then 'Arriving'
           when 'DEP' then 'Departing' when 'OOO' then 'Out of order'
           when 'HM' then 'House use' end;
$$;
alter table ops.room_status
  drop column maintenance_id,
  drop column until,
  drop column reason,
  drop column at_time;
