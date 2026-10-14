-- migrate:up
-- Money only for those whose job it is (KI-09, ADR 104, 109, 123). Frontline people see what
-- to do, never what it is worth:
-- * a minibar's guest prices and charges are for whoever bills them (`ops.minibar_bills`) and
--   for those who read the cost of its store (`rpt.store_cost_access`); what it cost us is for
--   the latter only. Everyone else gets the items and the counts, with null in place of ₹.
-- * breakage's ₹ value is for those who read the cost of the store it broke at.
-- The functions keep their shape; only the money columns come back null. A zero is no money:
-- it comes back as 0 to everyone, so the free bottle of water is never "to charge".

-- whoever bills the outlet's minibars: the front desk and those who give its tasks, else
-- whoever checks them where there is no front desk (ADR 104)
create function ops.minibar_bills(p_outlet uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, ops
as $$
  select coalesce((
    select case
             when b.department is null then core.can('MINIBAR', 'modify', p_outlet, null, null)
             else core.can('TASKS', 'modify', b.department, null, null)
                  or exists (select 1 from hr.worker w
                              where w.owner_user_id = core.current_user_id()
                                and w.status = 'active'
                                and w.org_node_id = b.department)
           end
      from ops.minibar_biller(p_outlet) b), core.can('MINIBAR', 'modify', p_outlet, null, null));
$$;

-- they read the cost of a store the outlet's minibars are filled from
create function ops.minibar_sees_cost(p_outlet uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
  select exists (select 1 from ops.minibar_set s
                  where s.org_node_id = p_outlet and s.archived_at is null
                    and rpt.store_cost_access(s.store_id));
$$;

-- guest prices and charges: the billers and the cost readers
create function ops.minibar_sees_prices(p_outlet uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, ops
as $$
  select ops.minibar_bills(p_outlet) or ops.minibar_sees_cost(p_outlet);
$$;

revoke execute on function ops.minibar_bills(uuid), ops.minibar_sees_cost(uuid),
  ops.minibar_sees_prices(uuid) from public;
grant execute on function ops.minibar_bills(uuid), ops.minibar_sees_cost(uuid),
  ops.minibar_sees_prices(uuid) to app_rw, platform_loader;

create or replace function ops.minibar_places()
 returns table(outlet_id uuid, outlet text, rooms integer, can_check boolean, bills boolean)
 language sql stable security definer
 set search_path to 'pg_catalog', 'core', 'hr', 'ops'
as $function$
  select o.id, o.name, count(r.id)::int, core.can('MINIBAR', 'modify', o.id, null, null),
         ops.minibar_bills(o.id)
    from ops.room r join core.hierarchy_node o on o.id = r.org_node_id
   where r.tenant_id = core.my_tenant() and r.archived_at is null
     and core.can('MINIBAR', 'view', o.id, null, null)
   group by o.id, o.name
   order by o.name;
$function$;

create or replace function ops.minibar_room(p_room uuid)
 returns table(room_id uuid, number text, outlet_id uuid, store text, can_check boolean, item_id uuid, item text, unit text, par numeric, price numeric, in_store numeric, sort_order integer)
 language plpgsql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv', 'ops'
as $function$
declare
  v_room ops.room := ops.minibar_room_row(p_room);
  v_prices boolean;
begin
  if v_room.id is null or not core.can('MINIBAR', 'view', v_room.org_node_id, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('room %s', p_room);
  end if;
  v_prices := ops.minibar_sees_prices(v_room.org_node_id);
  return query
    select v_room.id, v_room.number, v_room.org_node_id, st.name,
           core.can('MINIBAR', 'modify', v_room.org_node_id, null, null),
           i.id, i.name, i.base_uom, l.par, case when v_prices or l.price = 0 then l.price end,
           inv.on_hand(i.id, s.store_id), l.position
      from ops.minibar_set s
      join core.hierarchy_node st on st.id = s.store_id
      join ops.minibar_set_line l on l.set_id = s.id
      join inv.item i on i.id = l.item_id
     where s.id = v_room.minibar_set_id
     order by l.position, i.name;
end $function$;

create or replace function ops.minibar_history(p_room uuid)
 returns table(id uuid, checked_at timestamp with time zone, checked_by text, used jsonb, charge numeric, short boolean, charged_at timestamp with time zone, charged_by text)
 language plpgsql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv', 'ops'
as $function$
declare
  v_room ops.room := ops.minibar_room_row(p_room);
  v_prices boolean;
begin
  if v_room.id is null or not core.can('MINIBAR', 'view', v_room.org_node_id, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('room %s', p_room);
  end if;
  v_prices := ops.minibar_sees_prices(v_room.org_node_id);
  return query
    select c.id, c.checked_at, u.display_name,
           coalesce((select jsonb_agg(jsonb_build_object('item', i.name, 'qty', l.used_qty)
                                      order by i.name)
                       from ops.minibar_check_line l join inv.item i on i.id = l.item_id
                      where l.check_id = c.id and l.used_qty > 0), '[]'::jsonb),
           case when v_prices or c.charge = 0 then c.charge end, c.short, c.charged_at, cu.display_name
      from ops.minibar_check c
      left join core.app_user u on u.id = c.created_by
      left join core.app_user cu on cu.id = c.charged_by
     where c.room_id = p_room
     order by c.checked_at desc
     limit 10;
end $function$;

create or replace function ops.minibar_rooms(p_outlet uuid)
 returns table(id uuid, number text, floor text, room_type text, set_name text, last_checked_at timestamp with time zone, last_checked_by text, last_used integer, checked_today boolean, to_charge numeric, status text, due_today boolean, mine boolean)
 language plpgsql stable security definer
 set search_path to 'pg_catalog', 'core', 'ops', 'rpt'
as $function$
declare
  v_prices boolean;
begin
  if not core.can('MINIBAR', 'view', p_outlet, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('MINIBAR view at %s', p_outlet);
  end if;
  v_prices := ops.minibar_sees_prices(p_outlet);
  return query
    select r.id, r.number, r.floor, r.room_type, s.name, c.checked_at, u.display_name,
           (select count(*)::int from ops.minibar_check_line l
             where l.check_id = c.id and l.used_qty > 0),
           c.business_day is not distinct from rpt.today(p_outlet),
           (select case when v_prices or t.v = 0 then t.v end
              from (select coalesce(sum(x.charge), 0) as v from ops.minibar_check x
                     where x.room_id = r.id and x.charged_at is null) t),
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
end $function$;

create or replace function ops.minibar_to_charge(p_outlet uuid)
 returns table(id uuid, room text, checked_at timestamp with time zone, checked_by text, used jsonb, charge numeric)
 language plpgsql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv', 'ops'
as $function$
declare
  v_prices boolean;
begin
  if not core.can('MINIBAR', 'view', p_outlet, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('MINIBAR view at %s', p_outlet);
  end if;
  v_prices := ops.minibar_sees_prices(p_outlet);
  return query
    select c.id, r.number, c.checked_at, u.display_name,
           coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                        'item', i.name, 'qty', l.used_qty,
                                        'price', case when v_prices or l.price = 0 then l.price end))
                                      order by i.name)
                       from ops.minibar_check_line l join inv.item i on i.id = l.item_id
                      where l.check_id = c.id and l.used_qty > 0), '[]'::jsonb),
           case when v_prices or c.charge = 0 then c.charge end
      from ops.minibar_check c
      join ops.room r on r.id = c.room_id
      left join core.app_user u on u.id = c.created_by
     where c.org_node_id = p_outlet and c.charged_at is null
     order by c.checked_at;
end $function$;

create or replace function ops.minibar_charged(p_outlet uuid, p_from date, p_to date)
 returns table(id uuid, room text, checked_at timestamp with time zone, checked_by text, used jsonb, charge numeric, charged_at timestamp with time zone, charged_by text)
 language plpgsql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv', 'ops', 'rpt'
as $function$
declare
  v_prices boolean;
begin
  if not core.can('MINIBAR', 'view', p_outlet, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('MINIBAR view at %s', p_outlet);
  end if;
  if p_to < p_from or p_to - p_from > 366 then
    perform ops.fail('INVALID_VALUE', 'a period of a year at most');
  end if;
  v_prices := ops.minibar_sees_prices(p_outlet);
  return query
    select c.id, r.number, c.checked_at, uc.display_name,
           coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                        'item', i.name, 'qty', l.used_qty,
                                        'price', case when v_prices or l.price = 0 then l.price end))
                                      order by i.name)
                       from ops.minibar_check_line l join inv.item i on i.id = l.item_id
                      where l.check_id = c.id and l.used_qty > 0), '[]'::jsonb),
           case when v_prices or c.charge = 0 then c.charge end, c.charged_at, ub.display_name
      from ops.minibar_check c
      join ops.room r on r.id = c.room_id
      left join core.app_user uc on uc.id = c.created_by
      left join core.app_user ub on ub.id = c.charged_by
     where c.org_node_id = p_outlet and c.charged_at is not null
       and rpt.business_date(c.charged_at, ops.tz_of(p_outlet)) between p_from and p_to
     order by c.charged_at desc;
end $function$;

create or replace function ops.minibar_usage(p_outlet uuid, p_from date, p_to date)
 returns table(item_id uuid, item text, unit text, used numeric, revenue numeric, cost numeric, refilled numeric, rooms integer)
 language plpgsql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv', 'ops'
as $function$
declare
  v_prices boolean;
  v_cost boolean;
begin
  if not core.can('MINIBAR', 'view', p_outlet, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('MINIBAR view at %s', p_outlet);
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'INVALID_SUBJECT' using detail = 'period';
  end if;
  v_prices := ops.minibar_sees_prices(p_outlet);
  v_cost := ops.minibar_sees_cost(p_outlet);
  return query
    select i.id, i.name, i.base_uom, sum(l.used_qty),
           case when v_prices then round(sum(l.used_qty * l.price), 2) end,
           case when v_cost then round(sum(l.used_qty * l.unit_cost), 2) end,
           sum(l.refilled_qty), count(distinct c.room_id)::int
      from ops.minibar_check c
      join ops.minibar_check_line l on l.check_id = c.id
      join inv.item i on i.id = l.item_id
     where c.org_node_id = p_outlet and c.business_day between p_from and p_to
     group by i.id, i.name, i.base_uom
    having sum(l.used_qty) > 0
     -- the most used first for those who see no money
     order by case when v_prices then sum(l.used_qty * l.price) end desc nulls last,
              sum(l.used_qty) desc, i.name;
end $function$;

create or replace function ops.minibar_task_check(p_task uuid)
 returns table(check_id uuid, room text, store text, used jsonb, charge numeric, charged_at timestamp with time zone, refilled boolean, short boolean)
 language plpgsql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv', 'ops'
as $function$
declare
  v_t ops.task;
  v_prices boolean;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant();
  if not found or v_t.minibar_check_id is null or not ops.sees_task(v_t) then
    perform ops.fail('NOT_AUTHORISED', 'see this task');
  end if;
  select ops.minibar_sees_prices(c.org_node_id) into v_prices
    from ops.minibar_check c where c.id = v_t.minibar_check_id;
  return query
    select c.id, r.number, core.node_name(c.store_id),
           coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                                        'item', i.name, 'qty', l.used_qty,
                                        'price', case when v_prices or l.price = 0 then l.price end,
                                        'unit', i.base_uom))
                                      order by l.id)
                       from ops.minibar_check_line l join inv.item i on i.id = l.item_id
                      where l.check_id = c.id and l.used_qty > 0), '[]'::jsonb),
           case when v_prices or c.charge = 0 then c.charge end, c.charged_at,
           not exists (select 1 from ops.minibar_check_line l
                        where l.check_id = c.id and l.refilled_qty < l.used_qty
                          and v_t.kind = 'minibar_refill' and v_t.status in ('open', 'in_progress')),
           c.short
      from ops.minibar_check c join ops.room r on r.id = c.room_id
     where c.id = v_t.minibar_check_id;
end $function$;

-- breakage's value: for those who read the cost of the store it broke at
create or replace function inv.breakage_log(p_place uuid, p_month date)
 returns table(id uuid, broken_at timestamp with time zone, place text, store text, item_id uuid, item text, unit text, qty numeric, reason text, broken_by text, person text, note text, value numeric, recorded_by text)
 language plpgsql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv', 'ops', 'rpt', 'extensions'
as $function$
#variable_conflict use_column
declare
  v_tz text := coalesce(ops.tz_of(p_place), 'UTC');
  v_from date := date_trunc('month', p_month)::date;
begin
  if not inv.reads_breakage(p_place) then
    perform inv.fail('NOT_AUTHORISED', 'BREAKAGE view');
  end if;
  return query
    select b.id, b.broken_at, d.name, s.name, i.id, i.name, i.base_uom, b.qty, b.reason,
           b.broken_by, (select u.display_name from core.app_user u where u.id = b.person_id),
           b.note, case when rpt.store_cost_access(b.delivery_node_id) then b.value end,
           (select u.display_name from core.app_user u where u.id = b.created_by)
      from inv.breakage b
      join core.hierarchy_node d on d.id = b.org_node_id
      join core.hierarchy_node p on p.id = p_place
      join core.hierarchy_node s on s.id = b.delivery_node_id
      join inv.item i on i.id = b.item_id
     where b.tenant_id = core.my_tenant()
       and d.path operator(extensions.<@) p.path
       and rpt.business_date(b.broken_at, v_tz) >= v_from
       and rpt.business_date(b.broken_at, v_tz) < (v_from + interval '1 month')::date
     order by b.broken_at desc;
end $function$;

-- a month's value adds up the entries whose value the reader sees, as its log does; null
-- when they see none
create or replace function inv.breakage_months(p_place uuid)
 returns table(month date, entries integer, value numeric)
 language plpgsql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv', 'ops', 'rpt', 'extensions'
as $function$
#variable_conflict use_column
declare
  v_tz text := coalesce(ops.tz_of(p_place), 'UTC');
  v_from date := (date_trunc('month', rpt.business_date(now(), v_tz)) - interval '11 months')::date;
begin
  if not inv.reads_breakage(p_place) then
    perform inv.fail('NOT_AUTHORISED', 'BREAKAGE view');
  end if;
  return query
    select date_trunc('month', rpt.business_date(b.broken_at, v_tz))::date, count(*)::int,
           sum(case when rpt.store_cost_access(b.delivery_node_id) then b.value end)
      from inv.breakage b
      join core.hierarchy_node d on d.id = b.org_node_id
      join core.hierarchy_node p on p.id = p_place
     where b.tenant_id = core.my_tenant()
       and d.path operator(extensions.<@) p.path
       and rpt.business_date(b.broken_at, v_tz) >= v_from
     group by 1
     order by 1 desc;
end $function$;

-- migrate:down
CREATE OR REPLACE FUNCTION inv.breakage_log(p_place uuid, p_month date)
 RETURNS TABLE(id uuid, broken_at timestamp with time zone, place text, store text, item_id uuid, item text, unit text, qty numeric, reason text, broken_by text, person text, note text, value numeric, recorded_by text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'ops', 'rpt', 'extensions'
AS $function$
#variable_conflict use_column
declare
  v_tz text := coalesce(ops.tz_of(p_place), 'UTC');
  v_from date := date_trunc('month', p_month)::date;
begin
  if not inv.reads_breakage(p_place) then
    perform inv.fail('NOT_AUTHORISED', 'BREAKAGE view');
  end if;
  return query
    select b.id, b.broken_at, d.name, s.name, i.id, i.name, i.base_uom, b.qty, b.reason,
           b.broken_by, (select u.display_name from core.app_user u where u.id = b.person_id),
           b.note, b.value,
           (select u.display_name from core.app_user u where u.id = b.created_by)
      from inv.breakage b
      join core.hierarchy_node d on d.id = b.org_node_id
      join core.hierarchy_node p on p.id = p_place
      join core.hierarchy_node s on s.id = b.delivery_node_id
      join inv.item i on i.id = b.item_id
     where b.tenant_id = core.my_tenant()
       and d.path operator(extensions.<@) p.path
       and rpt.business_date(b.broken_at, v_tz) >= v_from
       and rpt.business_date(b.broken_at, v_tz) < (v_from + interval '1 month')::date
     order by b.broken_at desc;
end $function$
;

CREATE OR REPLACE FUNCTION inv.breakage_months(p_place uuid)
 RETURNS TABLE(month date, entries integer, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'ops', 'rpt', 'extensions'
AS $function$
#variable_conflict use_column
declare
  v_tz text := coalesce(ops.tz_of(p_place), 'UTC');
  v_from date := (date_trunc('month', rpt.business_date(now(), v_tz)) - interval '11 months')::date;
begin
  if not inv.reads_breakage(p_place) then
    perform inv.fail('NOT_AUTHORISED', 'BREAKAGE view');
  end if;
  return query
    select date_trunc('month', rpt.business_date(b.broken_at, v_tz))::date, count(*)::int,
           sum(b.value)
      from inv.breakage b
      join core.hierarchy_node d on d.id = b.org_node_id
      join core.hierarchy_node p on p.id = p_place
     where b.tenant_id = core.my_tenant()
       and d.path operator(extensions.<@) p.path
       and rpt.business_date(b.broken_at, v_tz) >= v_from
     group by 1
     order by 1 desc;
end $function$
;

CREATE OR REPLACE FUNCTION ops.minibar_charged(p_outlet uuid, p_from date, p_to date)
 RETURNS TABLE(id uuid, room text, checked_at timestamp with time zone, checked_by text, used jsonb, charge numeric, charged_at timestamp with time zone, charged_by text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'ops', 'rpt'
AS $function$
begin
  if not core.can('MINIBAR', 'view', p_outlet, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('MINIBAR view at %s', p_outlet);
  end if;
  if p_to < p_from or p_to - p_from > 366 then
    perform ops.fail('INVALID_VALUE', 'a period of a year at most');
  end if;
  return query
    select c.id, r.number, c.checked_at, uc.display_name,
           coalesce((select jsonb_agg(jsonb_build_object('item', i.name, 'qty', l.used_qty,
                                                         'price', l.price) order by i.name)
                       from ops.minibar_check_line l join inv.item i on i.id = l.item_id
                      where l.check_id = c.id and l.used_qty > 0), '[]'::jsonb),
           c.charge, c.charged_at, ub.display_name
      from ops.minibar_check c
      join ops.room r on r.id = c.room_id
      left join core.app_user uc on uc.id = c.created_by
      left join core.app_user ub on ub.id = c.charged_by
     where c.org_node_id = p_outlet and c.charged_at is not null
       and rpt.business_date(c.charged_at, ops.tz_of(p_outlet)) between p_from and p_to
     order by c.charged_at desc;
end $function$
;

CREATE OR REPLACE FUNCTION ops.minibar_history(p_room uuid)
 RETURNS TABLE(id uuid, checked_at timestamp with time zone, checked_by text, used jsonb, charge numeric, short boolean, charged_at timestamp with time zone, charged_by text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'ops'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION ops.minibar_places()
 RETURNS TABLE(outlet_id uuid, outlet text, rooms integer, can_check boolean, bills boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr', 'ops'
AS $function$
  select o.id, o.name, count(r.id)::int, core.can('MINIBAR', 'modify', o.id, null, null),
         coalesce((
           select case
                    when b.department is null then core.can('MINIBAR', 'modify', o.id, null, null)
                    else core.can('TASKS', 'modify', b.department, null, null)
                         or exists (select 1 from hr.worker w
                                     where w.owner_user_id = core.current_user_id()
                                       and w.status = 'active'
                                       and w.org_node_id = b.department)
                  end
             from ops.minibar_biller(o.id) b), core.can('MINIBAR', 'modify', o.id, null, null))
    from ops.room r join core.hierarchy_node o on o.id = r.org_node_id
   where r.tenant_id = core.my_tenant() and r.archived_at is null
     and core.can('MINIBAR', 'view', o.id, null, null)
   group by o.id, o.name
   order by o.name;
$function$
;

CREATE OR REPLACE FUNCTION ops.minibar_room(p_room uuid)
 RETURNS TABLE(room_id uuid, number text, outlet_id uuid, store text, can_check boolean, item_id uuid, item text, unit text, par numeric, price numeric, in_store numeric, sort_order integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'ops'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION ops.minibar_rooms(p_outlet uuid)
 RETURNS TABLE(id uuid, number text, floor text, room_type text, set_name text, last_checked_at timestamp with time zone, last_checked_by text, last_used integer, checked_today boolean, to_charge numeric, status text, due_today boolean, mine boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'ops', 'rpt'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION ops.minibar_task_check(p_task uuid)
 RETURNS TABLE(check_id uuid, room text, store text, used jsonb, charge numeric, charged_at timestamp with time zone, refilled boolean, short boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'ops'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION ops.minibar_to_charge(p_outlet uuid)
 RETURNS TABLE(id uuid, room text, checked_at timestamp with time zone, checked_by text, used jsonb, charge numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'ops'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION ops.minibar_usage(p_outlet uuid, p_from date, p_to date)
 RETURNS TABLE(item_id uuid, item text, unit text, used numeric, revenue numeric, cost numeric, refilled numeric, rooms integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'ops'
AS $function$
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
end $function$
;

drop function ops.minibar_sees_prices(uuid);
drop function ops.minibar_sees_cost(uuid);
drop function ops.minibar_bills(uuid);
