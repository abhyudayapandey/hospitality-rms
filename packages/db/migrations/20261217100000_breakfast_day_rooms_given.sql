-- migrate:up
-- Breakfast is planned for the next one, and rooms are given to attendants (ADR 110, 111).
--
-- * ops.breakfast_next(outlet): the breakfast still to come. Before the outlet's breakfast
--   ends (company setting `breakfast_ends`, 12:00 by default) it is today's, after that
--   tomorrow's (dates in the outlet's time zone). A breakfast before it has been served:
--   ops.set_breakfast_total and ops.set_breakfast_room refuse it (BREAKFAST_SERVED) and accept
--   up to a week ahead of it. Every day stays readable (ops.breakfast_day).
-- * ops.room_assignment: the rooms given to a person for a day. Given by whoever keeps the
--   rooms (ROOMS modify) and manages tasks at the outlet or at one of its housekeeping
--   departments; to someone who works in one of those departments. Nobody is limited to their
--   own rooms: ops.rooms and ops.minibar_rooms say whose each room is today and which are mine.

-- ---------------------------------------------------------------------------
-- Breakfast: the next one
-- ---------------------------------------------------------------------------
create function ops.breakfast_next(p_outlet uuid) returns date
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select case
           when (now() at time zone ops.tz_of(p_outlet))::time
                < coalesce((select (t.settings ->> 'breakfast_ends')::time
                              from core.tenant t join core.hierarchy_node n on n.tenant_id = t.id
                             where n.id = p_outlet), time '12:00')
             then (now() at time zone ops.tz_of(p_outlet))::date
           else (now() at time zone ops.tz_of(p_outlet))::date + 1
         end;
$$;

-- The day a breakfast may be changed: from the next one, up to a week ahead.
create function ops.check_breakfast_day(p_outlet uuid, p_day date) returns void
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
begin
  if p_day is null then
    perform ops.fail('INVALID_VALUE', 'a day');
  end if;
  if p_day < ops.breakfast_next(p_outlet) then
    perform ops.fail('BREAKFAST_SERVED', p_day::text);
  end if;
  if p_day > ops.breakfast_next(p_outlet) + 7 then
    perform ops.fail('INVALID_VALUE', 'within a week');
  end if;
end $$;

select core.patch_function('ops.set_breakfast_total(uuid,date,text,int)',
  $x$  if p_day is null or abs(p_day - rpt.today(p_outlet)) > 7 then
    perform ops.fail('INVALID_VALUE', 'within a week of today');
  end if;$x$,
  $x$  perform ops.check_breakfast_day(p_outlet, p_day);$x$);

select core.patch_function('ops.set_breakfast_room(uuid,date,text,int,text)',
  $x$  if p_day is null or abs(p_day - rpt.today(v_r.org_node_id)) > 7 then
    perform ops.fail('INVALID_VALUE', 'within a week of today');
  end if;$x$,
  $x$  perform ops.check_breakfast_day(v_r.org_node_id, p_day);$x$);

-- The outlets with rooms whose breakfast I read, with their next breakfast.
drop function ops.breakfast_outlets();
create function ops.breakfast_outlets()
returns table (outlet_id uuid, name text, today date, next_day date)
language sql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
  select n.id, n.name, rpt.today(n.id), ops.breakfast_next(n.id)
    from core.hierarchy_node n
   where n.tenant_id = core.my_tenant() and n.kind = 'outlet' and n.archived_at is null
     and exists (select 1 from ops.room r where r.org_node_id = n.id and r.archived_at is null)
     and ops.reads_breakfast(n.id)
   order by n.name;
$$;

-- ---------------------------------------------------------------------------
-- Rooms given to a person for a day
-- ---------------------------------------------------------------------------
create table ops.room_assignment (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the room's outlet
  day date not null,
  room_id uuid not null references ops.room(id),
  user_id uuid not null references core.app_user(id)
);
select core.add_standard_columns('ops.room_assignment');
create unique index room_assignment_day on ops.room_assignment (room_id, day);
create index room_assignment_user on ops.room_assignment (user_id, day);

-- The outlet's housekeeping departments (where rooms are given out).
create function ops.housekeeping_departments(p_outlet uuid) returns setof uuid
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  select d.id from core.hierarchy_node d join core.hierarchy_node o on o.id = p_outlet
   where d.tenant_id = o.tenant_id and d.archived_at is null
     and d.department_type = 'housekeeping'
     and d.path operator(extensions.<@) o.path;
$$;

-- Whether I may give out the outlet's rooms.
create function ops.gives_rooms(p_outlet uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select core.can('ROOMS', 'modify', p_outlet, null)
     and (core.can('TASKS', 'modify', p_outlet, null)
          or exists (select 1 from ops.housekeeping_departments(p_outlet) d
                      where core.can('TASKS', 'modify', d, null)));
$$;

-- Who rooms may be given to: the active people of the outlet's housekeeping departments.
create function ops.room_people(p_outlet uuid)
returns table (user_id uuid, name text, role_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops
as $$
begin
  if not core.can('ROOMS', 'view', p_outlet, null) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS view');
  end if;
  return query
    select distinct on (u.id) u.id, u.display_name, coalesce(jr.name, w.role_code)
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id
      left join hr.job_role jr on jr.tenant_id = w.tenant_id and jr.code = w.role_code
     where w.status = 'active' and w.org_node_id in (select ops.housekeeping_departments(p_outlet))
     order by u.id, u.display_name;
end $$;

-- Give rooms for a day: p_user gets exactly p_rooms (rooms another had move to them, rooms
-- they had that are not in the list are taken off). p_user null takes p_rooms off whoever had them.
create function ops.give_rooms(p_outlet uuid, p_day date, p_user uuid, p_rooms uuid[])
returns int
language plpgsql security definer
set search_path = pg_catalog, core, ops, rpt
as $$
declare
  v_n int;
begin
  if not exists (select 1 from core.hierarchy_node
                  where id = p_outlet and tenant_id = core.my_tenant() and kind = 'outlet')
     or not ops.gives_rooms(p_outlet) then
    perform ops.fail('NOT_AUTHORISED', 'gives rooms');
  end if;
  if p_day is null or p_day < rpt.today(p_outlet) or p_day > rpt.today(p_outlet) + 7 then
    perform ops.fail('INVALID_VALUE', 'today up to a week ahead');
  end if;
  if exists (select 1 from unnest(coalesce(p_rooms, '{}')) x(id)
              where not exists (select 1 from ops.room r where r.id = x.id
                                   and r.org_node_id = p_outlet and r.archived_at is null)) then
    perform ops.fail('NOT_FOUND', 'a room of this outlet');
  end if;
  if p_user is not null and not exists (select 1 from ops.room_people(p_outlet) p
                                         where p.user_id = p_user) then
    perform ops.fail('INVALID_VALUE', 'someone in housekeeping here');
  end if;
  if p_user is null then
    delete from ops.room_assignment
     where org_node_id = p_outlet and day = p_day and room_id = any (coalesce(p_rooms, '{}'));
    get diagnostics v_n = row_count;
    return v_n;
  end if;
  delete from ops.room_assignment
   where org_node_id = p_outlet and day = p_day and user_id = p_user
     and room_id <> all (coalesce(p_rooms, '{}'));
  insert into ops.room_assignment (tenant_id, org_node_id, day, room_id, user_id)
  select core.my_tenant(), p_outlet, p_day, x.id, p_user
    from unnest(coalesce(p_rooms, '{}')) x(id)
  on conflict (room_id, day) do update set user_id = excluded.user_id
   where ops.room_assignment.user_id is distinct from excluded.user_id;
  return coalesce(array_length(p_rooms, 1), 0);
end $$;

-- The outlet's rooms with their status, whose they are today and whether they are mine.
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

-- The rooms given out on a day (for giving out tomorrow's), for whoever sees the rooms.
create function ops.room_assignments(p_outlet uuid, p_day date)
returns table (room_id uuid, user_id uuid, name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
begin
  if not core.can('ROOMS', 'view', p_outlet, null) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS view');
  end if;
  return query
    select a.room_id, a.user_id, u.display_name
      from ops.room_assignment a join core.app_user u on u.id = a.user_id
     where a.org_node_id = p_outlet and a.day = p_day;
end $$;

-- The minibars, with whether the room is mine today.
drop function ops.minibar_rooms(uuid);
create function ops.minibar_rooms(p_outlet uuid)
returns table (id uuid, number text, floor text, room_type text, set_name text,
               last_checked_at timestamptz, last_checked_by text, last_used int,
               checked_today boolean, to_charge numeric, status text, due_today boolean,
               mine boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
begin
  if not core.can('MINIBAR', 'view', p_outlet, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('MINIBAR view at %s', p_outlet);
  end if;
  return query
    select r.id, r.number, r.floor, r.room_type, s.name, c.checked_at, u.display_name,
           (select count(*)::int from ops.minibar_check_line l
             where l.check_id = c.id and l.used_qty > 0),
           c.business_day is not distinct from rpt.today(p_outlet),
           coalesce((select sum(x.charge) from ops.minibar_check x
                      where x.room_id = r.id and x.charged_at is null), 0),
           coalesce(st.status, 'VC'),
           s.id is not null
             and c.business_day is distinct from rpt.today(p_outlet)
             and coalesce(st.status, 'VC') in ('OCC', 'ARR', 'DEP'),
           exists (select 1 from ops.room_assignment a
                    where a.room_id = r.id and a.day = rpt.today(p_outlet)
                      and a.user_id = core.current_user_id())
      from ops.room r
      left join ops.minibar_set s on s.id = r.minibar_set_id and s.archived_at is null
      left join ops.room_status st on st.room_id = r.id
      left join lateral (select x.* from ops.minibar_check x where x.room_id = r.id
                          order by x.checked_at desc limit 1) c on true
      left join core.app_user u on u.id = c.created_by
     where r.org_node_id = p_outlet and r.archived_at is null
     order by r.floor nulls last, length(r.number), r.number;
end $$;

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.room_assignment', 'ROOMS', 'org', true);
select core.apply_domain_rls('ops.room_assignment');
select audit.enable('ops.room_assignment');

revoke execute on function ops.breakfast_next(uuid), ops.check_breakfast_day(uuid, date),
  ops.breakfast_outlets(), ops.housekeeping_departments(uuid), ops.gives_rooms(uuid),
  ops.room_people(uuid), ops.give_rooms(uuid, date, uuid, uuid[]), ops.rooms(uuid),
  ops.room_assignments(uuid, date), ops.minibar_rooms(uuid)
  from public, platform_loader;
grant execute on function ops.breakfast_next(uuid), ops.breakfast_outlets(),
  ops.gives_rooms(uuid), ops.room_people(uuid), ops.give_rooms(uuid, date, uuid, uuid[]),
  ops.rooms(uuid), ops.room_assignments(uuid, date), ops.minibar_rooms(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.room_assignments(uuid, date);
drop function ops.give_rooms(uuid, date, uuid, uuid[]);
drop function ops.room_people(uuid);
drop function ops.gives_rooms(uuid);
drop function ops.housekeeping_departments(uuid);
delete from core.domain_table where table_name = 'ops.room_assignment'::regclass;
drop table ops.room_assignment;
drop function ops.minibar_rooms(uuid);
create function ops.minibar_rooms(p_outlet uuid)
returns table (id uuid, number text, floor text, room_type text, set_name text,
               last_checked_at timestamptz, last_checked_by text, last_used int,
               checked_today boolean, to_charge numeric, status text, due_today boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
begin
  if not core.can('MINIBAR', 'view', p_outlet, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('MINIBAR view at %s', p_outlet);
  end if;
  return query
    select r.id, r.number, r.floor, r.room_type, s.name, c.checked_at, u.display_name,
           (select count(*)::int from ops.minibar_check_line l
             where l.check_id = c.id and l.used_qty > 0),
           c.business_day is not distinct from rpt.today(p_outlet),
           coalesce((select sum(x.charge) from ops.minibar_check x
                      where x.room_id = r.id and x.charged_at is null), 0),
           coalesce(st.status, 'VC'),
           s.id is not null
             and c.business_day is distinct from rpt.today(p_outlet)
             and coalesce(st.status, 'VC') in ('OCC', 'ARR', 'DEP')
      from ops.room r
      left join ops.minibar_set s on s.id = r.minibar_set_id and s.archived_at is null
      left join ops.room_status st on st.room_id = r.id
      left join lateral (select x.* from ops.minibar_check x where x.room_id = r.id
                          order by x.checked_at desc limit 1) c on true
      left join core.app_user u on u.id = c.created_by
     where r.org_node_id = p_outlet and r.archived_at is null
     order by r.floor nulls last, length(r.number), r.number;
end $$;
grant execute on function ops.minibar_rooms(uuid) to app_rw;
drop function ops.rooms(uuid);
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
grant execute on function ops.rooms(uuid) to app_rw;
drop function ops.breakfast_outlets();
create function ops.breakfast_outlets()
returns table (outlet_id uuid, name text, today date)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select n.id, n.name, rpt.today(n.id)
    from core.hierarchy_node n
   where n.tenant_id = core.my_tenant() and n.kind = 'outlet' and n.archived_at is null
     and exists (select 1 from ops.room r where r.org_node_id = n.id and r.archived_at is null)
     and ops.reads_breakfast(n.id)
   order by n.name;
$$;
grant execute on function ops.breakfast_outlets() to app_rw;
select core.patch_function('ops.set_breakfast_total(uuid,date,text,int)',
  $x$  perform ops.check_breakfast_day(p_outlet, p_day);$x$,
  $x$  if p_day is null or abs(p_day - rpt.today(p_outlet)) > 7 then
    perform ops.fail('INVALID_VALUE', 'within a week of today');
  end if;$x$);
select core.patch_function('ops.set_breakfast_room(uuid,date,text,int,text)',
  $x$  perform ops.check_breakfast_day(v_r.org_node_id, p_day);$x$,
  $x$  if p_day is null or abs(p_day - rpt.today(v_r.org_node_id)) > 7 then
    perform ops.fail('INVALID_VALUE', 'within a week of today');
  end if;$x$);
drop function ops.check_breakfast_day(uuid, date);
drop function ops.breakfast_next(uuid);
