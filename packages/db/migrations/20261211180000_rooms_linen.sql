-- migrate:up
-- Rooms (contents, breakfast) and Linen & uniforms (ADR 094).
--
-- Rooms block (domain ROOMS, org tree, at the outlet; front office and housekeeping hold it):
-- * What a room holds (file 44): durable things and amenities with the count each should have,
--   by room type or for one room (a room's own line wins). Counted, not stocked: a count is
--   kept per room and item (ops.room_count), never a ledger movement. The grid shows every
--   room, what it should have and what was last counted.
-- * Breakfast by mode for a business day: front office gives the totals (in-room, buffet), then
--   the rooms; housekeeping may add or change a room (a guest calling at night). Whoever holds
--   ROOMS reads it, and so does the outlet's kitchen and restaurant (department_type kitchen or
--   service), who cook and serve it.
--
-- Linen & uniforms block (domain LINEN, org tree):
-- * The laundry exchange: per place (housekeeping, the outlet) and day, how many of each item
--   went to the laundry soiled and came back fresh; what is still at the laundry is the
--   running difference.
-- * Uniforms issued to a person (item, size, how many) and returned.
-- * Linen kept in a store is counted in the usual month-end stock check (durable items).

-- ---------------------------------------------------------------------------
-- Room contents
-- ---------------------------------------------------------------------------
create table ops.room_item (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the outlet
  room_type text,
  room_id uuid references ops.room(id),
  item_id uuid not null references inv.item(id),
  qty numeric(14,3) not null check (qty > 0),
  archived_at timestamptz,
  check ((room_type is null) <> (room_id is null))
);
select core.add_standard_columns('ops.room_item');
create unique index room_item_type on ops.room_item (org_node_id, lower(room_type), item_id)
  where room_type is not null and archived_at is null;
create unique index room_item_room on ops.room_item (room_id, item_id)
  where room_id is not null and archived_at is null;

create table ops.room_count (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the outlet
  room_id uuid not null references ops.room(id),
  item_id uuid not null references inv.item(id),
  expected numeric(14,3) not null,
  counted numeric(14,3) not null check (counted >= 0),
  counted_at timestamptz not null default now()
);
select core.add_standard_columns('ops.room_count');
create index room_count_room on ops.room_count (room_id, item_id, counted_at desc);

-- What a room should hold: its own lines, else its room type's.
create function ops.room_expected(p_room uuid)
returns table (item_id uuid, qty numeric)
language sql stable security definer
set search_path = pg_catalog, ops
as $$
  select distinct on (i.item_id) i.item_id, i.qty
    from ops.room r
    join ops.room_item i on i.org_node_id = r.org_node_id and i.archived_at is null
                        and (i.room_id = r.id or lower(i.room_type) = lower(r.room_type))
   where r.id = p_room
   order by i.item_id, (i.room_id is not null) desc;
$$;

-- Count a room: [{item_id, counted}] for what it should hold. Returns how many lines are short.
create function ops.count_room(p_room uuid, p_lines jsonb) returns int
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_r ops.room;
  v_short int := 0;
  v_line record;
  v_expected numeric;
begin
  select * into v_r from ops.room
   where id = p_room and tenant_id = core.my_tenant() and archived_at is null;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such room');
  end if;
  if not core.can('ROOMS', 'modify', v_r.org_node_id, null) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS modify');
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    perform ops.fail('INVALID_VALUE', 'what was counted');
  end if;
  for v_line in select * from jsonb_to_recordset(p_lines) as l(item_id uuid, counted numeric) loop
    select e.qty into v_expected from ops.room_expected(p_room) e where e.item_id = v_line.item_id;
    if v_expected is null then
      perform ops.fail('INVALID_VALUE', 'the room does not hold that');
    end if;
    if v_line.counted is null or v_line.counted < 0 then
      perform ops.fail('INVALID_VALUE', 'a count is not negative');
    end if;
    insert into ops.room_count (tenant_id, org_node_id, room_id, item_id, expected, counted)
    values (v_r.tenant_id, v_r.org_node_id, v_r.id, v_line.item_id, v_expected, v_line.counted);
    if v_line.counted < v_expected then
      v_short := v_short + 1;
    end if;
  end loop;
  return v_short;
end $$;

-- What is where: every room of the outlet and what it should hold, with its last count.
create function ops.room_contents(p_outlet uuid)
returns table (room_id uuid, number text, floor text, room_type text, item_id uuid,
               item text, unit text, expected numeric, counted numeric,
               counted_at timestamptz, counted_by text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
#variable_conflict use_column
begin
  if not core.can('ROOMS', 'view', p_outlet, null) then
    perform ops.fail('NOT_AUTHORISED', 'ROOMS view');
  end if;
  return query
    select r.id, r.number, r.floor, r.room_type, i.id, i.name, i.base_uom, e.qty,
           c.counted, c.counted_at,
           (select u.display_name from core.app_user u where u.id = c.created_by)
      from ops.room r
      cross join lateral ops.room_expected(r.id) e
      join inv.item i on i.id = e.item_id
      left join lateral (
        select x.counted, x.counted_at, x.created_by from ops.room_count x
         where x.room_id = r.id and x.item_id = e.item_id
         order by x.counted_at desc limit 1) c on true
     where r.org_node_id = p_outlet and r.tenant_id = core.my_tenant()
       and r.archived_at is null
     order by r.floor nulls first, r.number, i.name;
end $$;

-- ---------------------------------------------------------------------------
-- Breakfast by mode
-- ---------------------------------------------------------------------------
create table ops.breakfast (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the outlet
  day date not null,
  mode text not null check (mode in ('in_room', 'buffet')),
  guests int not null check (guests between 0 and 5000)
);
select core.add_standard_columns('ops.breakfast');
create unique index breakfast_day on ops.breakfast (org_node_id, day, mode);

create table ops.breakfast_room (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the outlet
  day date not null,
  room_id uuid not null references ops.room(id),
  mode text not null check (mode in ('in_room', 'buffet')),
  guests int not null check (guests between 0 and 20),
  note text check (length(note) <= 200)
);
select core.add_standard_columns('ops.breakfast_room');
create unique index breakfast_room_day on ops.breakfast_room (room_id, day);

-- Who reads an outlet's breakfast: ROOMS there, or someone working in its kitchen or restaurant.
create function ops.reads_breakfast(p_outlet uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select core.can('ROOMS', 'view', p_outlet, null)
      or exists (
        select 1 from hr.worker w
          join core.hierarchy_node d on d.id = w.org_node_id
          join core.hierarchy_node o on o.id = p_outlet
         where w.owner_user_id = core.current_user_id() and w.status = 'active'
           and d.path operator(extensions.<@) o.path
           and d.department_type in ('kitchen', 'service'));
$$;

create function ops.set_breakfast_total(p_outlet uuid, p_day date, p_mode text, p_guests int)
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
  if p_day is null or abs(p_day - rpt.today(p_outlet)) > 7 then
    perform ops.fail('INVALID_VALUE', 'within a week of today');
  end if;
  insert into ops.breakfast (tenant_id, org_node_id, day, mode, guests)
  values (core.my_tenant(), p_outlet, p_day, p_mode, p_guests)
  on conflict (org_node_id, day, mode) do update set guests = excluded.guests;
end $$;

create function ops.set_breakfast_room(p_room uuid, p_day date, p_mode text, p_guests int,
                                       p_note text)
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
  if p_day is null or abs(p_day - rpt.today(v_r.org_node_id)) > 7 then
    perform ops.fail('INVALID_VALUE', 'within a week of today');
  end if;
  insert into ops.breakfast_room (tenant_id, org_node_id, day, room_id, mode, guests, note)
  values (v_r.tenant_id, v_r.org_node_id, p_day, v_r.id, p_mode, p_guests,
          left(nullif(btrim(p_note), ''), 200))
  on conflict (room_id, day) do update
    set mode = excluded.mode, guests = excluded.guests, note = excluded.note;
end $$;

-- A day's breakfast: the totals front office gave, then the rooms. `rooms` sums the rooms'.
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

-- The outlets with rooms whose breakfast I read.
create function ops.breakfast_outlets()
returns table (outlet_id uuid, name text, today date)
language sql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
  select n.id, n.name, rpt.today(n.id)
    from core.hierarchy_node n
   where n.tenant_id = core.my_tenant() and n.kind = 'outlet' and n.archived_at is null
     and exists (select 1 from ops.room r where r.org_node_id = n.id and r.archived_at is null)
     and ops.reads_breakfast(n.id)
   order by n.name;
$$;

-- ---------------------------------------------------------------------------
-- Linen & uniforms
-- ---------------------------------------------------------------------------
create table ops.laundry_exchange (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the place
  day date not null,
  item_id uuid not null references inv.item(id),
  sent int not null default 0 check (sent >= 0),
  received int not null default 0 check (received >= 0)
);
select core.add_standard_columns('ops.laundry_exchange');
create unique index laundry_exchange_day on ops.laundry_exchange (org_node_id, day, item_id);

create table ops.uniform_issue (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the place it is kept for
  person_id uuid not null references core.app_user(id),
  item text not null check (length(btrim(item)) between 1 and 60),
  size text check (length(size) <= 10),
  qty int not null check (qty between 1 and 20),
  issued_at timestamptz not null default now(),
  returned_at timestamptz,
  returned_by uuid references core.app_user(id)
);
select core.add_standard_columns('ops.uniform_issue');
create index uniform_issue_place on ops.uniform_issue (org_node_id, issued_at desc);

-- A day's exchange at a place: [{item_id, sent, received}], what the laundry took and gave
-- back. Saving the same day again replaces its lines.
create function ops.record_laundry(p_place uuid, p_day date, p_lines jsonb) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, rpt
as $$
declare
  v_line record;
begin
  if not exists (select 1 from core.hierarchy_node
                  where id = p_place and tenant_id = core.my_tenant() and type = 'org'
                    and kind in ('outlet', 'department') and archived_at is null)
     or not core.can('LINEN', 'modify', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'LINEN modify');
  end if;
  if p_day is null or p_day > rpt.today(p_place) or p_day < rpt.today(p_place) - 7 then
    perform ops.fail('INVALID_VALUE', 'today or the week before');
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    perform ops.fail('INVALID_VALUE', 'what went and came back');
  end if;
  for v_line in select * from jsonb_to_recordset(p_lines)
                  as l(item_id uuid, sent int, received int) loop
    if not exists (select 1 from inv.item i
                    where i.id = v_line.item_id and i.tenant_id = core.my_tenant()) then
      perform ops.fail('NOT_FOUND', 'no such item');
    end if;
    if coalesce(v_line.sent, 0) < 0 or coalesce(v_line.received, 0) < 0 then
      perform ops.fail('INVALID_VALUE', 'not negative');
    end if;
    insert into ops.laundry_exchange (tenant_id, org_node_id, day, item_id, sent, received)
    values (core.my_tenant(), p_place, p_day, v_line.item_id, coalesce(v_line.sent, 0),
            coalesce(v_line.received, 0))
    on conflict (org_node_id, day, item_id) do update
      set sent = excluded.sent, received = excluded.received;
  end loop;
end $$;

-- A place's exchanges the last p_days days, each with what is still at the laundry after it
-- (all the place's exchanges up to that day).
create function ops.laundry(p_place uuid, p_days int default 14)
returns table (day date, item_id uuid, item text, sent int, received int, at_laundry int)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
#variable_conflict use_column
begin
  if not core.can('LINEN', 'view', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'LINEN view');
  end if;
  return query
    select x.day, x.item_id, i.name, x.sent, x.received,
           (sum(x.sent - x.received) over (partition by x.item_id order by x.day))::int
      from ops.laundry_exchange x join inv.item i on i.id = x.item_id
     where x.org_node_id = p_place and x.tenant_id = core.my_tenant()
     order by x.day desc, i.name
     limit 2000;
end $$;

-- Linen items a place exchanges: the durable items in the stores of its department.
create function ops.linen_items(p_place uuid)
returns table (item_id uuid, name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, inv
as $$
#variable_conflict use_column
begin
  if not core.can('LINEN', 'view', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'LINEN view');
  end if;
  return query
    select distinct i.id, i.name
      from inv.item i
      join inv.item_node x on x.item_id = i.id and x.archived_at is null
     where i.tenant_id = core.my_tenant() and i.durable and i.archived_at is null
       and core.nearest(ops.team_of_store(x.delivery_node_id), array['outlet'])
           = core.nearest(p_place, array['outlet'])
     order by i.name;
end $$;

create function ops.issue_uniform(p_place uuid, p_person uuid, p_item text, p_size text,
                                  p_qty int)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr, extensions
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from core.hierarchy_node
                  where id = p_place and tenant_id = core.my_tenant() and type = 'org'
                    and kind in ('outlet', 'department') and archived_at is null)
     or not core.can('LINEN', 'modify', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'LINEN modify');
  end if;
  if not exists (select 1 from hr.worker w
                   join core.hierarchy_node h on h.id = w.org_node_id
                   join core.hierarchy_node p on p.id = core.nearest(p_place, array['outlet'])
                  where w.owner_user_id = p_person and w.status = 'active'
                    and h.path operator(extensions.<@) p.path) then
    perform ops.fail('INVALID_VALUE', 'someone who works at the outlet');
  end if;
  if nullif(btrim(p_item), '') is null or length(btrim(p_item)) > 60 then
    perform ops.fail('INVALID_VALUE', 'what was issued');
  end if;
  if p_qty is null or p_qty < 1 or p_qty > 20 then
    perform ops.fail('INVALID_VALUE', '1 to 20');
  end if;
  insert into ops.uniform_issue (tenant_id, org_node_id, person_id, item, size, qty)
  values (core.my_tenant(), p_place, p_person, btrim(p_item),
          left(nullif(btrim(p_size), ''), 10), p_qty)
  returning id into v_id;
  return v_id;
end $$;

create function ops.return_uniform(p_issue uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_u ops.uniform_issue;
begin
  select * into v_u from ops.uniform_issue
   where id = p_issue and tenant_id = core.my_tenant() for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such issue');
  end if;
  if not core.can('LINEN', 'modify', v_u.org_node_id, null) then
    perform ops.fail('NOT_AUTHORISED', 'LINEN modify');
  end if;
  if v_u.returned_at is not null then
    perform ops.fail('INVALID_STATE', 'already returned');
  end if;
  update ops.uniform_issue set returned_at = now(), returned_by = core.current_user_id()
   where id = v_u.id;
end $$;

-- Uniforms issued at a place: what each person holds, then the last 90 days' returns.
create function ops.uniforms(p_place uuid)
returns table (id uuid, person text, item text, size text, qty int, issued_at timestamptz,
               returned_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
#variable_conflict use_column
begin
  if not core.can('LINEN', 'view', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'LINEN view');
  end if;
  return query
    select u.id, (select a.display_name from core.app_user a where a.id = u.person_id),
           u.item, u.size, u.qty, u.issued_at, u.returned_at
      from ops.uniform_issue u
     where u.org_node_id = p_place and u.tenant_id = core.my_tenant()
       and (u.returned_at is null or u.returned_at > now() - interval '90 days')
     order by u.returned_at is null desc, 2, u.issued_at desc;
end $$;

-- The places where I keep linen and uniforms, with the people who work there.
create function ops.linen_places()
returns table (place_id uuid, name text, kind text, can_edit boolean, people jsonb)
language sql stable security definer
set search_path = pg_catalog, core, ops, hr, extensions
as $$
  select n.id, n.name, n.kind, core.can('LINEN', 'modify', n.id, null),
         coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.display_name)
                                    order by a.display_name)
                     from hr.worker w
                     join core.hierarchy_node h on h.id = w.org_node_id
                     join core.hierarchy_node o on o.id = core.nearest(n.id, array['outlet'])
                     join core.app_user a on a.id = w.owner_user_id
                    where w.status = 'active' and h.path operator(extensions.<@) o.path),
                  '[]')
    from core.hierarchy_node n
   where n.tenant_id = core.my_tenant() and n.type = 'org' and n.archived_at is null
     and n.kind in ('outlet', 'department')
     and core.can('LINEN', 'modify', n.id, null)
   order by (n.kind = 'outlet') desc, n.name;
$$;

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.room_item', 'ROOMS', 'org', true),
  ('ops.room_count', 'ROOMS', 'org', true),
  ('ops.breakfast', 'ROOMS', 'org', true),
  ('ops.breakfast_room', 'ROOMS', 'org', true),
  ('ops.laundry_exchange', 'LINEN', 'org', true),
  ('ops.uniform_issue', 'LINEN', 'org', true);
select core.apply_domain_rls(t) from unnest(array['ops.room_item', 'ops.room_count',
  'ops.breakfast', 'ops.breakfast_room', 'ops.laundry_exchange', 'ops.uniform_issue']) t;
select audit.enable(t) from unnest(array['ops.room_item', 'ops.room_count',
  'ops.breakfast', 'ops.breakfast_room', 'ops.laundry_exchange', 'ops.uniform_issue']) t;

revoke execute on function ops.room_expected(uuid), ops.count_room(uuid, jsonb),
  ops.room_contents(uuid), ops.reads_breakfast(uuid),
  ops.set_breakfast_total(uuid, date, text, int),
  ops.set_breakfast_room(uuid, date, text, int, text), ops.breakfast_day(uuid, date),
  ops.breakfast_outlets(), ops.record_laundry(uuid, date, jsonb), ops.laundry(uuid, int),
  ops.linen_items(uuid), ops.issue_uniform(uuid, uuid, text, text, int),
  ops.return_uniform(uuid), ops.uniforms(uuid), ops.linen_places()
  from public, platform_loader;
grant execute on function ops.count_room(uuid, jsonb), ops.room_contents(uuid),
  ops.set_breakfast_total(uuid, date, text, int),
  ops.set_breakfast_room(uuid, date, text, int, text), ops.breakfast_day(uuid, date),
  ops.breakfast_outlets(), ops.record_laundry(uuid, date, jsonb), ops.laundry(uuid, int),
  ops.linen_items(uuid), ops.issue_uniform(uuid, uuid, text, text, int),
  ops.return_uniform(uuid), ops.uniforms(uuid), ops.linen_places()
  to app_rw;
grant select, insert, update on ops.room_item to platform_loader;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
revoke select, insert, update on ops.room_item from platform_loader;
drop function ops.linen_places();
drop function ops.uniforms(uuid);
drop function ops.return_uniform(uuid);
drop function ops.issue_uniform(uuid, uuid, text, text, int);
drop function ops.linen_items(uuid);
drop function ops.laundry(uuid, int);
drop function ops.record_laundry(uuid, date, jsonb);
drop function ops.breakfast_outlets();
drop function ops.breakfast_day(uuid, date);
drop function ops.set_breakfast_room(uuid, date, text, int, text);
drop function ops.set_breakfast_total(uuid, date, text, int);
drop function ops.reads_breakfast(uuid);
drop function ops.room_contents(uuid);
drop function ops.count_room(uuid, jsonb);
drop function ops.room_expected(uuid);
delete from core.domain_table where table_name in (
  'ops.room_item'::regclass, 'ops.room_count'::regclass, 'ops.breakfast'::regclass,
  'ops.breakfast_room'::regclass, 'ops.laundry_exchange'::regclass,
  'ops.uniform_issue'::regclass);
drop table ops.uniform_issue;
drop table ops.laundry_exchange;
drop table ops.breakfast_room;
drop table ops.breakfast;
drop table ops.room_count;
drop table ops.room_item;
