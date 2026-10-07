-- migrate:up
-- The rooms' minibars (ADR 072). A hotel's rooms (file 40) each have a minibar set (file 41):
-- the items it holds, their par and the price charged to the guest, refilled from one store
-- of the outlet. Housekeeping checks a room (at checkout or the daily service): for each item
-- they count what is left; what is missing was used and is charged, and the room is refilled
-- to par from the store (a 'consumption' out of the store at its average cost, as far as the
-- store has it). Front Office adds the charge to the guest's bill and marks it added.
--
-- Everything is at the outlet (org tree, MINIBAR): the duty "Checks the rooms' minibars"
-- (CHECKS_MINIBARS -> MINIBAR_KEEPER@whole_outlet; housekeeping and front office) and the
-- outlet's managers modify; area managers view. Read and written through ops.* functions
-- only. The MINIBAR domain and group come from the product sync.

create table ops.minibar_set (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the outlet
  name text not null check (length(btrim(name)) between 1 and 80),
  store_id uuid not null references core.hierarchy_node(id),      -- refilled from here
  archived_at timestamptz
);
select core.add_standard_columns('ops.minibar_set');
create unique index minibar_set_name on ops.minibar_set (org_node_id, lower(name))
  where archived_at is null;

create table ops.minibar_set_line (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  set_id uuid not null references ops.minibar_set(id),
  item_id uuid not null references inv.item(id),
  par numeric(14,3) not null check (par > 0),
  price numeric(14,2) not null check (price >= 0),
  position int not null default 0,
  unique (set_id, item_id)
);
select core.add_standard_columns('ops.minibar_set_line');

create table ops.room (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the outlet
  number text not null check (length(btrim(number)) between 1 and 20),
  floor text,
  room_type text,
  minibar_set_id uuid references ops.minibar_set(id),
  archived_at timestamptz
);
select core.add_standard_columns('ops.room');
create unique index room_number on ops.room (org_node_id, lower(number))
  where archived_at is null;

create table ops.minibar_check (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the outlet
  room_id uuid not null references ops.room(id),
  store_id uuid not null references core.hierarchy_node(id),
  checked_at timestamptz not null,
  business_day date not null,
  charge numeric(14,2) not null default 0 check (charge >= 0),
  short boolean not null default false,   -- the store couldn't refill all of it
  charged_at timestamptz,
  charged_by uuid references core.app_user(id),
  idempotency_key text
);
select core.add_standard_columns('ops.minibar_check');
create index minibar_check_room on ops.minibar_check (room_id, checked_at desc);
create index minibar_check_day on ops.minibar_check (org_node_id, business_day);
alter table ops.minibar_check add constraint minibar_check_idem
  unique (tenant_id, created_by, idempotency_key);

create table ops.minibar_check_line (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  check_id uuid not null references ops.minibar_check(id),
  item_id uuid not null references inv.item(id),
  par numeric(14,3) not null,
  left_qty numeric(14,3) not null check (left_qty >= 0),
  used_qty numeric(14,3) not null check (used_qty >= 0),
  refilled_qty numeric(14,3) not null check (refilled_qty >= 0),
  price numeric(14,2) not null,
  unit_cost numeric(14,4) not null default 0,
  unique (check_id, item_id)
);
select core.add_standard_columns('ops.minibar_check_line');

-- A room of the caller's company, with its outlet; null when it is not one.
create function ops.minibar_room_row(p_room uuid) returns ops.room
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select r.* from ops.room r
   where r.id = p_room and r.tenant_id = core.my_tenant() and r.archived_at is null;
$$;

-- The outlets whose minibars the caller sees, with whether they check them.
create function ops.minibar_places()
returns table (outlet_id uuid, outlet text, rooms int, can_check boolean)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select o.id, o.name, count(r.id)::int, core.can('MINIBAR', 'modify', o.id, null, null)
    from ops.room r join core.hierarchy_node o on o.id = r.org_node_id
   where r.tenant_id = core.my_tenant() and r.archived_at is null
     and core.can('MINIBAR', 'view', o.id, null, null)
   group by o.id, o.name
   order by o.name;
$$;

-- Every room at an outlet: its set, its last check and whether it was checked today, and
-- what is still to be added to the guest's bill.
create function ops.minibar_rooms(p_outlet uuid)
returns table (id uuid, number text, floor text, room_type text, set_name text,
               last_checked_at timestamptz, last_checked_by text, last_used int,
               checked_today boolean, to_charge numeric)
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
                      where x.room_id = r.id and x.charged_at is null), 0)
      from ops.room r
      left join ops.minibar_set s on s.id = r.minibar_set_id
      left join lateral (select x.* from ops.minibar_check x where x.room_id = r.id
                          order by x.checked_at desc limit 1) c on true
      left join core.app_user u on u.id = c.created_by
     where r.org_node_id = p_outlet and r.archived_at is null
     order by r.floor nulls last, length(r.number), r.number;
end $$;

-- A room's minibar: each item of its set with its par and price, what the store has, and
-- the room's recent checks.
create function ops.minibar_room(p_room uuid)
returns table (room_id uuid, number text, outlet_id uuid, store text, can_check boolean,
               item_id uuid, item text, unit text, par numeric, price numeric,
               in_store numeric, sort_order int)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_room ops.room := ops.minibar_room_row(p_room);
begin
  if v_room.id is null or not core.can('MINIBAR', 'view', v_room.org_node_id, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('room %s', p_room);
  end if;
  return query
    select v_room.id, v_room.number, v_room.org_node_id, st.name,
           core.can('MINIBAR', 'modify', v_room.org_node_id, null, null),
           i.id, i.name, i.base_uom, l.par, l.price, inv.on_hand(i.id, s.store_id), l.position
      from ops.minibar_set s
      join core.hierarchy_node st on st.id = s.store_id
      join ops.minibar_set_line l on l.set_id = s.id
      join inv.item i on i.id = l.item_id
     where s.id = v_room.minibar_set_id
     order by l.position, i.name;
end $$;

create function ops.minibar_history(p_room uuid)
returns table (id uuid, checked_at timestamptz, checked_by text, used jsonb, charge numeric,
               short boolean, charged_at timestamptz, charged_by text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_room ops.room := ops.minibar_room_row(p_room);
begin
  if v_room.id is null or not core.can('MINIBAR', 'view', v_room.org_node_id, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('room %s', p_room);
  end if;
  return query
    select c.id, c.checked_at, u.display_name,
           coalesce((select jsonb_agg(jsonb_build_object('item', i.name, 'qty', l.used_qty)
                                      order by i.name)
                       from ops.minibar_check_line l join inv.item i on i.id = l.item_id
                      where l.check_id = c.id and l.used_qty > 0), '[]'::jsonb),
           c.charge, c.short, c.charged_at, cu.display_name
      from ops.minibar_check c
      left join core.app_user u on u.id = c.created_by
      left join core.app_user cu on cu.id = c.charged_by
     where c.room_id = p_room
     order by c.checked_at desc
     limit 10;
end $$;

-- Checks a room: p_lines = [{item_id, left}] for every item of its set. What is missing was
-- used and is charged at the set's price; the room is refilled to par from the set's store,
-- as far as the store has it (short when not). Returns the check's id.
create function ops.check_minibar(p_room uuid, p_lines jsonb, p_idempotency_key text default null)
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

-- Front Office: the charge is on the guest's bill.
create function ops.mark_minibar_charged(p_check uuid) returns void
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

-- What is still to be added to guests' bills at an outlet.
create function ops.minibar_to_charge(p_outlet uuid)
returns table (id uuid, room text, checked_at timestamptz, checked_by text, used jsonb,
               charge numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
begin
  if not core.can('MINIBAR', 'view', p_outlet, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('MINIBAR view at %s', p_outlet);
  end if;
  return query
    select c.id, r.number, c.checked_at, u.display_name,
           coalesce((select jsonb_agg(jsonb_build_object('item', i.name, 'qty', l.used_qty,
                                                         'price', l.price) order by i.name)
                       from ops.minibar_check_line l join inv.item i on i.id = l.item_id
                      where l.check_id = c.id and l.used_qty > 0), '[]'::jsonb),
           c.charge
      from ops.minibar_check c
      join ops.room r on r.id = c.room_id
      left join core.app_user u on u.id = c.created_by
     where c.org_node_id = p_outlet and c.charged_at is null
     order by c.checked_at;
end $$;

-- What the minibars sold over business days p_from..p_to: each item's quantity used, what it
-- earned at the set's price, what it cost at the store's average cost, and how much the
-- refills took from the store.
create function ops.minibar_usage(p_outlet uuid, p_from date, p_to date)
returns table (item_id uuid, item text, unit text, used numeric, revenue numeric,
               cost numeric, refilled numeric, rooms int)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
begin
  if not core.can('MINIBAR', 'view', p_outlet, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('MINIBAR view at %s', p_outlet);
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'INVALID_SUBJECT' using detail = 'period';
  end if;
  return query
    select i.id, i.name, i.base_uom, sum(l.used_qty), round(sum(l.used_qty * l.price), 2),
           round(sum(l.used_qty * l.unit_cost), 2), sum(l.refilled_qty),
           count(distinct c.room_id)::int
      from ops.minibar_check c
      join ops.minibar_check_line l on l.check_id = c.id
      join inv.item i on i.id = l.item_id
     where c.org_node_id = p_outlet and c.business_day between p_from and p_to
     group by i.id, i.name, i.base_uom
    having sum(l.used_qty) > 0
     order by sum(l.used_qty * l.price) desc, i.name;
end $$;

-- Test data only (file 42, ADR 072): a check made at a past time, as the person named.
create function ops.record_test_minibar_check(p_room uuid, p_lines jsonb, p_at timestamptz,
                                              p_key text)
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

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.minibar_set', 'MINIBAR', 'org', true),
  ('ops.minibar_set_line', 'MINIBAR', 'org', true),
  ('ops.room', 'MINIBAR', 'org', true),
  ('ops.minibar_check', 'MINIBAR', 'org', true),
  ('ops.minibar_check_line', 'MINIBAR', 'org', true);
select core.apply_domain_rls('ops.minibar_set');
select core.apply_domain_rls('ops.minibar_set_line');
select core.apply_domain_rls('ops.room');
select core.apply_domain_rls('ops.minibar_check');
select core.apply_domain_rls('ops.minibar_check_line');
select audit.enable('ops.minibar_set');
select audit.enable('ops.minibar_set_line');
select audit.enable('ops.room');
select audit.enable('ops.minibar_check');
select audit.enable('ops.minibar_check_line');

revoke execute on function ops.minibar_room_row(uuid), ops.minibar_places(),
  ops.minibar_rooms(uuid), ops.minibar_room(uuid), ops.minibar_history(uuid),
  ops.check_minibar(uuid, jsonb, text), ops.mark_minibar_charged(uuid),
  ops.minibar_to_charge(uuid), ops.minibar_usage(uuid, date, date),
  ops.record_test_minibar_check(uuid, jsonb, timestamptz, text)
  from public, platform_loader;
grant execute on function ops.minibar_places(), ops.minibar_rooms(uuid),
  ops.minibar_room(uuid), ops.minibar_history(uuid), ops.check_minibar(uuid, jsonb, text),
  ops.mark_minibar_charged(uuid), ops.minibar_to_charge(uuid),
  ops.minibar_usage(uuid, date, date) to app_rw;
grant execute on function ops.record_test_minibar_check(uuid, jsonb, timestamptz, text)
  to platform_loader;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.record_test_minibar_check(uuid, jsonb, timestamptz, text);
drop function ops.minibar_usage(uuid, date, date);
drop function ops.minibar_to_charge(uuid);
drop function ops.mark_minibar_charged(uuid);
drop function ops.check_minibar(uuid, jsonb, text);
drop function ops.minibar_history(uuid);
drop function ops.minibar_room(uuid);
drop function ops.minibar_rooms(uuid);
drop function ops.minibar_places();
drop function ops.minibar_room_row(uuid);
delete from core.domain_table where table_name in ('ops.minibar_check_line'::regclass,
  'ops.minibar_check'::regclass, 'ops.room'::regclass, 'ops.minibar_set_line'::regclass,
  'ops.minibar_set'::regclass);
drop table ops.minibar_check_line;
drop table ops.minibar_check;
drop table ops.room;
drop table ops.minibar_set_line;
drop table ops.minibar_set;
