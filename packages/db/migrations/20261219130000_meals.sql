-- migrate:up
-- Meals (ADR 121): breakfast, lunch and dinner, each the way breakfast was (ADR 094, 110), by
-- room. A meal's guests are its rooms': there is no total typed on its own any more (one kept
-- from before still shows for its day). Each meal has its cut-off (company settings
-- `breakfast_ends` 12:00, `lunch_ends` 16:00, `dinner_ends` 23:30): until then the next one is
-- today's, after it tomorrow's. The team that serves it decides: whoever works in a service
-- department of the outlet (the restaurant, in-room dining, a breakfast team), or at the
-- outlet itself (its managers). Front office, housekeeping and the kitchen read it.

alter table ops.breakfast
  add column meal text not null default 'breakfast'
    check (meal in ('breakfast', 'lunch', 'dinner'));
alter table ops.breakfast_room
  add column meal text not null default 'breakfast'
    check (meal in ('breakfast', 'lunch', 'dinner'));
drop index ops.breakfast_day;
create unique index breakfast_day on ops.breakfast (org_node_id, day, meal, mode);
drop index ops.breakfast_room_day;
create unique index breakfast_room_day on ops.breakfast_room (room_id, day, meal);

-- When a meal is over (time of day, the outlet's), from the company's settings.
create function ops.meal_ends(p_outlet uuid, p_meal text) returns time
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce((select (t.settings ->> (p_meal || '_ends'))::time
                     from core.tenant t join core.hierarchy_node n on n.tenant_id = t.id
                    where n.id = p_outlet),
                  case p_meal when 'breakfast' then time '12:00' when 'lunch' then time '16:00'
                              else time '23:30' end);
$$;

-- The meal still to come: today's until it is over, then tomorrow's.
create function ops.meal_next(p_outlet uuid, p_meal text) returns date
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select case
           when (now() at time zone ops.tz_of(p_outlet))::time < ops.meal_ends(p_outlet, p_meal)
             then (now() at time zone ops.tz_of(p_outlet))::date
           else (now() at time zone ops.tz_of(p_outlet))::date + 1
         end;
$$;

-- Breakfast's, as before.
create or replace function ops.breakfast_next(p_outlet uuid) returns date
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select ops.meal_next(p_outlet, 'breakfast');
$$;

-- Whether I set an outlet's meals: I work at the outlet itself or in one of its service
-- departments that serves food (a bar or lounge on its own does not), with Rooms in the plan.
create function ops.serves_meals(p_outlet uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select core.module_on(core.my_tenant(), 'rooms') and exists (
    select 1 from hr.worker w
      join core.hierarchy_node d on d.id = w.org_node_id
      join core.hierarchy_node o on o.id = p_outlet
     where w.owner_user_id = core.current_user_id() and w.status = 'active'
       and o.tenant_id = core.my_tenant() and o.kind = 'outlet'
       and (d.id = o.id
            or (d.path operator(extensions.<@) o.path and d.department_type = 'service'
                and not (d.name ~* '\mbar\M|\mpub\M|lounge|cellar'
                         and d.name !~* 'restaurant|dining|caf[eé]|coffee'))));
$$;

-- The day a meal may be changed: from the next one, up to a week ahead (BREAKFAST_SERVED for
-- one already served, whichever meal).
create function ops.check_meal_day(p_outlet uuid, p_day date, p_meal text) returns void
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
begin
  if p_meal is null or p_meal not in ('breakfast', 'lunch', 'dinner') then
    perform ops.fail('INVALID_VALUE', 'breakfast, lunch or dinner');
  end if;
  if p_day is null then
    perform ops.fail('INVALID_VALUE', 'a day');
  end if;
  if p_day < ops.meal_next(p_outlet, p_meal) then
    perform ops.fail('BREAKFAST_SERVED', p_day::text);
  end if;
  if p_day > ops.meal_next(p_outlet, p_meal) + 7 then
    perform ops.fail('INVALID_VALUE', 'within a week');
  end if;
end $$;

-- A meal's rooms for a day and a mode, all at once: each room's guests (0 takes it off). The
-- rooms of that meal and mode not listed are left as they are.
create function ops.set_meal_rooms(p_outlet uuid, p_day date, p_meal text, p_mode text,
                                   p_rooms jsonb)
returns int
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_line jsonb;
  v_room ops.room;
  v_guests int;
  v_n int := 0;
begin
  if not ops.serves_meals(p_outlet) then
    perform ops.fail('NOT_AUTHORISED', 'the outlet''s service team sets its meals');
  end if;
  if p_mode is null or p_mode not in ('in_room', 'buffet') then
    perform ops.fail('INVALID_VALUE', 'in-room or in the restaurant');
  end if;
  perform ops.check_meal_day(p_outlet, p_day, p_meal);
  if jsonb_typeof(p_rooms) is distinct from 'array' then
    perform ops.fail('INVALID_VALUE', 'the rooms');
  end if;
  for v_line in select * from jsonb_array_elements(p_rooms) loop
    select * into v_room from ops.room
     where id = (v_line ->> 'room_id')::uuid and org_node_id = p_outlet and archived_at is null;
    if not found then
      perform ops.fail('NOT_FOUND', 'no such room here');
    end if;
    v_guests := (v_line ->> 'guests')::int;
    if v_guests is null or v_guests < 0 or v_guests > 20 then
      perform ops.fail('INVALID_VALUE', '0 to 20 guests');
    end if;
    insert into ops.breakfast_room (tenant_id, org_node_id, day, meal, room_id, mode, guests,
                                    note)
    values (v_room.tenant_id, p_outlet, p_day, p_meal, v_room.id, p_mode, v_guests,
            left(nullif(btrim(v_line ->> 'note'), ''), 200))
    on conflict (room_id, day, meal) do update
      set mode = excluded.mode, guests = excluded.guests, note = excluded.note;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- A meal on a day, per mode: its guests (its rooms', else a total typed before ADR 121), its
-- rooms, and whether I may change it (the service team, until it is served).
create function ops.meal_day(p_outlet uuid, p_day date, p_meal text)
returns table (mode text, total int, rooms int, room_list jsonb, can_edit boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
#variable_conflict use_column
begin
  if not ops.reads_breakfast(p_outlet) and not ops.serves_meals(p_outlet) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS view');
  end if;
  return query
    select m.mode,
           coalesce(nullif((select sum(x.guests)::int from ops.breakfast_room x
                             where x.org_node_id = p_outlet and x.day = p_day
                               and x.meal = p_meal and x.mode = m.mode), 0), b.guests),
           coalesce((select sum(x.guests)::int from ops.breakfast_room x
                      where x.org_node_id = p_outlet and x.day = p_day and x.meal = p_meal
                        and x.mode = m.mode), 0),
           coalesce((select jsonb_agg(jsonb_build_object(
                              'room_id', r.id, 'number', r.number, 'guests', x.guests,
                              'note', x.note,
                              'by', (select u.display_name from core.app_user u
                                      where u.id = x.updated_by))
                              order by r.number)
                       from ops.breakfast_room x join ops.room r on r.id = x.room_id
                      where x.org_node_id = p_outlet and x.day = p_day and x.meal = p_meal
                        and x.mode = m.mode and x.guests > 0), '[]'),
           ops.serves_meals(p_outlet) and p_day >= ops.meal_next(p_outlet, p_meal)
      from (values ('buffet'), ('in_room')) m(mode)
      left join ops.breakfast b on b.org_node_id = p_outlet and b.day = p_day
                               and b.meal = p_meal and b.mode = m.mode;
end $$;

-- The outlets with rooms whose meals I read or set, with each meal's next day.
create function ops.meal_outlets()
returns table (outlet_id uuid, name text, today date, breakfast_next date, lunch_next date,
               dinner_next date, can_edit boolean)
language sql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
  select n.id, n.name, rpt.today(n.id), ops.meal_next(n.id, 'breakfast'),
         ops.meal_next(n.id, 'lunch'), ops.meal_next(n.id, 'dinner'), ops.serves_meals(n.id)
    from core.hierarchy_node n
   where n.tenant_id = core.my_tenant() and n.kind = 'outlet' and n.archived_at is null
     and exists (select 1 from ops.room r where r.org_node_id = n.id and r.archived_at is null)
     and (ops.reads_breakfast(n.id) or ops.serves_meals(n.id))
   order by n.name;
$$;

-- Breakfast, as before, through the meals: the day's breakfast; a room's breakfast; a total
-- (kept for a customer's own scripts: the screen no longer types one).
create or replace function ops.breakfast_day(p_outlet uuid, p_day date)
returns table (mode text, total int, rooms int, room_list jsonb, can_edit boolean)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select * from ops.meal_day(p_outlet, p_day, 'breakfast');
$$;

create or replace function ops.set_breakfast_room(p_room uuid, p_day date, p_mode text,
                                                  p_guests int, p_note text)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_outlet uuid;
begin
  select org_node_id into v_outlet from ops.room
   where id = p_room and tenant_id = core.my_tenant() and archived_at is null;
  if v_outlet is null then
    perform ops.fail('NOT_FOUND', 'no such room');
  end if;
  perform ops.set_meal_rooms(v_outlet, p_day, 'breakfast', p_mode,
                             jsonb_build_array(jsonb_build_object(
                               'room_id', p_room, 'guests', p_guests, 'note', p_note)));
end $$;

create or replace function ops.set_breakfast_total(p_outlet uuid, p_day date, p_mode text,
                                                   p_guests int)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
begin
  if not ops.serves_meals(p_outlet) then
    perform ops.fail('NOT_AUTHORISED', 'the outlet''s service team sets its meals');
  end if;
  if p_mode is null or p_mode not in ('in_room', 'buffet') then
    perform ops.fail('INVALID_VALUE', 'in-room or buffet');
  end if;
  if p_guests is null or p_guests < 0 or p_guests > 5000 then
    perform ops.fail('INVALID_VALUE', '0 to 5000 guests');
  end if;
  perform ops.check_meal_day(p_outlet, p_day, 'breakfast');
  insert into ops.breakfast (tenant_id, org_node_id, day, meal, mode, guests)
  values (core.my_tenant(), p_outlet, p_day, 'breakfast', p_mode, p_guests)
  on conflict (org_node_id, day, meal, mode) do update set guests = excluded.guests;
end $$;

-- The Meals tile: wherever I read or set an outlet's meals.
create or replace function ops.breakfast_outlets()
returns table (outlet_id uuid, name text, today date, next_day date)
language sql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
  select n.id, n.name, rpt.today(n.id), ops.breakfast_next(n.id)
    from core.hierarchy_node n
   where n.tenant_id = core.my_tenant() and n.kind = 'outlet' and n.archived_at is null
     and exists (select 1 from ops.room r where r.org_node_id = n.id and r.archived_at is null)
     and (ops.reads_breakfast(n.id) or ops.serves_meals(n.id))
   order by n.name;
$$;

revoke execute on function ops.meal_ends(uuid, text), ops.meal_next(uuid, text),
  ops.serves_meals(uuid), ops.check_meal_day(uuid, date, text),
  ops.set_meal_rooms(uuid, date, text, text, jsonb), ops.meal_day(uuid, date, text),
  ops.meal_outlets() from public;
grant execute on function ops.meal_next(uuid, text), ops.serves_meals(uuid),
  ops.set_meal_rooms(uuid, date, text, text, jsonb), ops.meal_day(uuid, date, text),
  ops.meal_outlets() to app_rw;

-- migrate:down
create or replace function ops.breakfast_outlets()
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
create or replace function ops.set_breakfast_total(p_outlet uuid, p_day date, p_mode text,
                                                   p_guests int)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
begin
  if not exists (select 1 from core.hierarchy_node
                  where id = p_outlet and tenant_id = core.my_tenant() and kind = 'outlet')
     or not core.can('ROOMS', 'modify', p_outlet, null) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS modify');
  end if;
  if p_mode is null or p_mode not in ('in_room', 'buffet') then
    perform ops.fail('INVALID_VALUE', 'in-room or buffet');
  end if;
  if p_guests is null or p_guests < 0 or p_guests > 5000 then
    perform ops.fail('INVALID_VALUE', '0 to 5000 guests');
  end if;
  perform ops.check_breakfast_day(p_outlet, p_day);
  insert into ops.breakfast (tenant_id, org_node_id, day, mode, guests)
  values (core.my_tenant(), p_outlet, p_day, p_mode, p_guests)
  on conflict (org_node_id, day, mode) do update set guests = excluded.guests;
end $$;

create or replace function ops.set_breakfast_room(p_room uuid, p_day date, p_mode text,
                                                  p_guests int, p_note text)
returns void
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
  if p_mode is null or p_mode not in ('in_room', 'buffet') then
    perform ops.fail('INVALID_VALUE', 'in-room or buffet');
  end if;
  if p_guests is null or p_guests < 0 or p_guests > 20 then
    perform ops.fail('INVALID_VALUE', '0 to 20 guests');
  end if;
  perform ops.check_breakfast_day(v_r.org_node_id, p_day);
  insert into ops.breakfast_room (tenant_id, org_node_id, day, room_id, mode, guests, note)
  values (v_r.tenant_id, v_r.org_node_id, p_day, v_r.id, p_mode, p_guests,
          left(nullif(btrim(p_note), ''), 200))
  on conflict (room_id, day) do update
    set mode = excluded.mode, guests = excluded.guests, note = excluded.note;
end $$;

drop function ops.breakfast_day(uuid, date);
create function ops.breakfast_day(p_outlet uuid, p_day date)
returns table (mode text, total int, rooms int, room_list jsonb, can_edit boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
#variable_conflict use_column
begin
  if not ops.reads_breakfast(p_outlet) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS view');
  end if;
  return query
    select m.mode, b.guests,
           coalesce((select sum(x.guests)::int from ops.breakfast_room x
                      where x.org_node_id = p_outlet and x.day = p_day and x.mode = m.mode), 0),
           coalesce((select jsonb_agg(jsonb_build_object(
                              'room_id', r.id, 'number', r.number, 'guests', x.guests,
                              'note', x.note,
                              'by', (select u.display_name from core.app_user u
                                      where u.id = x.updated_by))
                              order by r.number)
                       from ops.breakfast_room x join ops.room r on r.id = x.room_id
                      where x.org_node_id = p_outlet and x.day = p_day and x.mode = m.mode
                        and x.guests > 0), '[]'),
           core.can('ROOMS', 'modify', p_outlet, null)
      from (values ('in_room'), ('buffet')) m(mode)
      left join ops.breakfast b on b.org_node_id = p_outlet and b.day = p_day
                               and b.mode = m.mode;
end $$;
revoke execute on function ops.breakfast_day(uuid, date) from public;
grant execute on function ops.breakfast_day(uuid, date) to app_rw;

create or replace function ops.breakfast_next(p_outlet uuid) returns date
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

drop function ops.meal_outlets();
drop function ops.meal_day(uuid, date, text);
drop function ops.set_meal_rooms(uuid, date, text, text, jsonb);
drop function ops.check_meal_day(uuid, date, text);
drop function ops.serves_meals(uuid);
drop function ops.meal_next(uuid, text);
drop function ops.meal_ends(uuid, text);
delete from ops.breakfast_room where meal <> 'breakfast';
delete from ops.breakfast where meal <> 'breakfast';
drop index ops.breakfast_room_day;
create unique index breakfast_room_day on ops.breakfast_room (room_id, day);
drop index ops.breakfast_day;
create unique index breakfast_day on ops.breakfast (org_node_id, day, mode);
alter table ops.breakfast_room drop column meal;
alter table ops.breakfast drop column meal;
