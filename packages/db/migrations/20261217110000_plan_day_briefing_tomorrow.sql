-- migrate:up
-- The day to plan (ADR 112). From the evening (company setting `evening_from`, 18:00 by default,
-- in the outlet's time zone) until the 04:00 cut, the day people plan for is tomorrow's
-- business day; before that it is today's. Screens that plan ahead start from it: the briefing,
-- the prep list's "ready by", the roster's week, a leave request's first day.
--
-- The briefing can now be written for tomorrow as well as today: ops.save_briefing,
-- ops.briefing_at and ops.briefing_dishes take an optional day (today or tomorrow, nothing
-- else); without one they work on today, as before. Home shows today's notes, as before.

create function ops.plan_day(p_outlet uuid) returns date
language sql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
  select case
           when (now() at time zone ops.tz_of(p_outlet))::time
                  >= coalesce((select (t.settings ->> 'evening_from')::time
                                 from core.tenant t join core.hierarchy_node n
                                   on n.tenant_id = t.id where n.id = p_outlet),
                              time '18:00')
             or (now() at time zone ops.tz_of(p_outlet))::time < time '04:00'
             then rpt.today(p_outlet) + 1
           else rpt.today(p_outlet)
         end;
$$;

-- The briefing's day: today unless tomorrow is asked for; nothing else.
create function ops.briefing_day(p_outlet uuid, p_day date) returns date
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
begin
  if p_day is null or p_day = rpt.today(p_outlet) then
    return rpt.today(p_outlet);
  end if;
  if p_day = rpt.today(p_outlet) + 1 then
    return p_day;
  end if;
  raise exception 'INVALID_VALUE' using detail = 'today or tomorrow';
end $$;

drop function ops.save_briefing(uuid, text, text, uuid[], text);
create function ops.save_briefing(p_place uuid, p_part text, p_body text, p_off_dishes uuid[],
                                  p_idempotency_key text default null, p_day date default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, menu, ops, rpt
as $$
declare
  v_outlet uuid := ops.briefing_outlet(p_place);
  v_day date;
  v_body text := btrim(coalesce(p_body, ''));
  v_dishes uuid[];
  v_id uuid;
begin
  if v_outlet is null
     or not core.can('BRIEFING', 'modify', p_place, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('BRIEFING modify at %s', p_place);
  end if;
  if p_idempotency_key is not null then
    select b.id into v_id from ops.briefing b
     where b.tenant_id = core.my_tenant() and b.created_by = core.current_user_id()
       and b.idempotency_key = p_idempotency_key;
    if v_id is not null then
      return v_id;
    end if;
  end if;
  if p_part is null or p_part not in ('day', 'breakfast', 'lunch', 'dinner', 'late_night') then
    raise exception 'INVALID_SUBJECT' using detail = format('part %s', p_part);
  end if;
  v_day := ops.briefing_day(v_outlet, p_day);
  select coalesce(array_agg(distinct d order by d), '{}') into v_dishes
    from unnest(coalesce(p_off_dishes, '{}')) d where d is not null;
  if exists (
    select 1 from unnest(v_dishes) d
     where not exists (
       select 1 from menu.menu_outlet mo join menu.menu_item mi on mi.id = mo.menu_item_id
        where mo.menu_item_id = d and mo.org_node_id = v_outlet and mi.archived_at is null
          and mo.effective_from <= v_day
          and (mo.effective_to is null or mo.effective_to >= v_day))) then
    raise exception 'NOT_ON_MENU';
  end if;
  if length(v_body) = 0 and cardinality(v_dishes) = 0 then
    raise exception 'BRIEFING_EMPTY';
  end if;
  if length(v_body) > 1000 then
    raise exception 'BRIEFING_TOO_LONG';
  end if;

  select b.id into v_id from ops.briefing b
   where b.org_node_id = p_place and b.business_day = v_day and b.part = p_part
     and b.archived_at is null
   for update;
  if v_id is null then
    insert into ops.briefing (tenant_id, org_node_id, outlet_id, business_day, part, body,
                              off_dishes, idempotency_key)
    values (core.my_tenant(), p_place, v_outlet, v_day, p_part, v_body, v_dishes,
            p_idempotency_key)
    returning id into v_id;
  else
    update ops.briefing set body = v_body, off_dishes = v_dishes
     where id = v_id and (body, off_dishes) is distinct from (v_body, v_dishes);
  end if;
  return v_id;
end $$;

drop function ops.briefing_at(uuid);
create function ops.briefing_at(p_place uuid, p_day date default null)
returns table (id uuid, part text, body text, off_dishes uuid[], written_by text,
               written_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
declare
  v_outlet uuid := ops.briefing_outlet(p_place);
begin
  if v_outlet is null or not core.can('BRIEFING', 'modify', p_place, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('BRIEFING modify at %s', p_place);
  end if;
  return query
    select b.id, b.part, b.body, b.off_dishes, u.display_name, b.updated_at
      from ops.briefing b left join core.app_user u on u.id = b.updated_by
     where b.org_node_id = p_place and b.business_day = ops.briefing_day(v_outlet, p_day)
       and b.archived_at is null
     order by array_position(array['day', 'breakfast', 'lunch', 'dinner', 'late_night'], b.part);
end $$;

drop function ops.briefing_dishes(uuid);
create function ops.briefing_dishes(p_place uuid, p_day date default null)
returns table (id uuid, name text, menu text)
language plpgsql stable security definer
set search_path = pg_catalog, core, menu, ops, rpt
as $$
declare
  v_outlet uuid := ops.briefing_outlet(p_place);
  v_day date;
begin
  if v_outlet is null or not core.can('BRIEFING', 'modify', p_place, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('BRIEFING modify at %s', p_place);
  end if;
  v_day := ops.briefing_day(v_outlet, p_day);
  return query
    select distinct mi.id, mi.name, mi.menu
      from menu.menu_outlet mo join menu.menu_item mi on mi.id = mo.menu_item_id
     where mo.org_node_id = v_outlet and mi.archived_at is null
       and mo.effective_from <= v_day and (mo.effective_to is null or mo.effective_to >= v_day)
     order by mi.name, mi.menu;
end $$;

revoke execute on function ops.plan_day(uuid), ops.briefing_day(uuid, date),
  ops.save_briefing(uuid, text, text, uuid[], text, date), ops.briefing_at(uuid, date),
  ops.briefing_dishes(uuid, date)
  from public, platform_loader;
grant execute on function ops.plan_day(uuid), ops.save_briefing(uuid, text, text, uuid[], text, date),
  ops.briefing_at(uuid, date), ops.briefing_dishes(uuid, date) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.briefing_dishes(uuid, date);
create function ops.briefing_dishes(p_place uuid)
returns table (id uuid, name text, menu text)
language plpgsql stable security definer
set search_path = pg_catalog, core, menu, ops, rpt
as $$
declare
  v_outlet uuid := ops.briefing_outlet(p_place);
  v_day date;
begin
  if v_outlet is null or not core.can('BRIEFING', 'modify', p_place, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('BRIEFING modify at %s', p_place);
  end if;
  v_day := rpt.today(v_outlet);
  return query
    select distinct mi.id, mi.name, mi.menu
      from menu.menu_outlet mo join menu.menu_item mi on mi.id = mo.menu_item_id
     where mo.org_node_id = v_outlet and mi.archived_at is null
       and mo.effective_from <= v_day and (mo.effective_to is null or mo.effective_to >= v_day)
     order by mi.name, mi.menu;
end $$;
drop function ops.briefing_at(uuid, date);
create function ops.briefing_at(p_place uuid)
returns table (id uuid, part text, body text, off_dishes uuid[], written_by text,
               written_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
declare
  v_outlet uuid := ops.briefing_outlet(p_place);
begin
  if v_outlet is null or not core.can('BRIEFING', 'modify', p_place, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('BRIEFING modify at %s', p_place);
  end if;
  return query
    select b.id, b.part, b.body, b.off_dishes, u.display_name, b.updated_at
      from ops.briefing b left join core.app_user u on u.id = b.updated_by
     where b.org_node_id = p_place and b.business_day = rpt.today(v_outlet)
       and b.archived_at is null
     order by array_position(array['day', 'breakfast', 'lunch', 'dinner', 'late_night'], b.part);
end $$;
drop function ops.save_briefing(uuid, text, text, uuid[], text, date);
create function ops.save_briefing(p_place uuid, p_part text, p_body text, p_off_dishes uuid[],
                                  p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, menu, ops, rpt
as $$
declare
  v_outlet uuid := ops.briefing_outlet(p_place);
  v_day date;
  v_body text := btrim(coalesce(p_body, ''));
  v_dishes uuid[];
  v_id uuid;
begin
  if v_outlet is null
     or not core.can('BRIEFING', 'modify', p_place, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('BRIEFING modify at %s', p_place);
  end if;
  if p_idempotency_key is not null then
    select b.id into v_id from ops.briefing b
     where b.tenant_id = core.my_tenant() and b.created_by = core.current_user_id()
       and b.idempotency_key = p_idempotency_key;
    if v_id is not null then
      return v_id;
    end if;
  end if;
  if p_part is null or p_part not in ('day', 'breakfast', 'lunch', 'dinner', 'late_night') then
    raise exception 'INVALID_SUBJECT' using detail = format('part %s', p_part);
  end if;
  v_day := rpt.today(v_outlet);
  select coalesce(array_agg(distinct d order by d), '{}') into v_dishes
    from unnest(coalesce(p_off_dishes, '{}')) d where d is not null;
  if exists (
    select 1 from unnest(v_dishes) d
     where not exists (
       select 1 from menu.menu_outlet mo join menu.menu_item mi on mi.id = mo.menu_item_id
        where mo.menu_item_id = d and mo.org_node_id = v_outlet and mi.archived_at is null
          and mo.effective_from <= v_day
          and (mo.effective_to is null or mo.effective_to >= v_day))) then
    raise exception 'NOT_ON_MENU';
  end if;
  if length(v_body) = 0 and cardinality(v_dishes) = 0 then
    raise exception 'BRIEFING_EMPTY';
  end if;
  if length(v_body) > 1000 then
    raise exception 'BRIEFING_TOO_LONG';
  end if;

  select b.id into v_id from ops.briefing b
   where b.org_node_id = p_place and b.business_day = v_day and b.part = p_part
     and b.archived_at is null
   for update;
  if v_id is null then
    insert into ops.briefing (tenant_id, org_node_id, outlet_id, business_day, part, body,
                              off_dishes, idempotency_key)
    values (core.my_tenant(), p_place, v_outlet, v_day, p_part, v_body, v_dishes,
            p_idempotency_key)
    returning id into v_id;
  else
    update ops.briefing set body = v_body, off_dishes = v_dishes
     where id = v_id and (body, off_dishes) is distinct from (v_body, v_dishes);
  end if;
  return v_id;
end $$;
grant execute on function ops.save_briefing(uuid, text, text, uuid[], text),
  ops.briefing_at(uuid), ops.briefing_dishes(uuid) to app_rw;
drop function ops.briefing_day(uuid, date);
drop function ops.plan_day(uuid);
