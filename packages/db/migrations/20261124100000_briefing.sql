-- migrate:up
-- Today's briefing note (ADR 069): a short note for the outlet's shift from the head chef or a
-- manager, the SOPs' pre-shift briefing (specials, dishes that are off, guests to know about,
-- targets). It shows on Home for everyone who works at the outlet that business day (the
-- 04:00 cut in the outlet's time zone, ops.tz_of), for the whole day, or for lunch (until
-- 16:00) or dinner (from 16:00).
--
-- Written at a department or the outlet by whoever holds BRIEFING modify there: the duty
-- "Writes the shift briefing" (WRITES_SHIFT_BRIEFING -> BRIEFING_WRITER@home_department, held
-- by the heads of kitchen and service departments) or the outlet's managers (OUTLET_MANAGER).
-- A person covering a writer holds the same grant (ADR 061). One note per place, day and part:
-- saving again edits it, taking it down archives it. Read through ops.briefing_today, never
-- the table: names and words only. The BRIEFING domain and groups come from the product sync.

create table ops.briefing (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id), -- the department or outlet
  outlet_id uuid not null references core.hierarchy_node(id),   -- the outlet it is shown at
  business_day date not null,
  part text not null check (part in ('day', 'lunch', 'dinner')),
  body text not null default '' check (length(body) <= 1000),
  off_dishes uuid[] not null default '{}',
  archived_at timestamptz,
  idempotency_key text,
  check (length(btrim(body)) > 0 or cardinality(off_dishes) > 0)
);
select core.add_standard_columns('ops.briefing');
create unique index briefing_open on ops.briefing (org_node_id, business_day, part)
  where archived_at is null;
create index briefing_outlet_day on ops.briefing (outlet_id, business_day);
alter table ops.briefing add constraint briefing_idem
  unique (tenant_id, created_by, idempotency_key);

-- The part of the business day it is now at an outlet: lunch from the 04:00 cut until 16:00,
-- dinner from 16:00 until the next cut.
create function ops.briefing_part_now(p_outlet uuid, p_at timestamptz default now())
returns text
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select case when (p_at at time zone ops.tz_of(p_outlet))::time >= time '04:00'
               and (p_at at time zone ops.tz_of(p_outlet))::time < time '16:00'
              then 'lunch' else 'dinner' end;
$$;

-- The outlet a department or outlet belongs to, in the caller's company; null otherwise.
create function ops.briefing_outlet(p_place uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select core.nearest(n.id, array['outlet'])
    from core.hierarchy_node n
   where n.id = p_place and n.type = 'org' and n.kind in ('outlet', 'department')
     and n.archived_at is null and n.tenant_id = core.my_tenant();
$$;

-- Write or edit today's note at a place for a part of the day. Dishes that are off must be on
-- the outlet's menu today. Returns the note's id.
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
  if p_part is null or p_part not in ('day', 'lunch', 'dinner') then
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

-- Take a note down (archived, never deleted).
create function ops.take_down_briefing(p_id uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v ops.briefing;
begin
  select * into v from ops.briefing b
   where b.id = p_id and b.tenant_id = core.my_tenant() and b.archived_at is null
   for update;
  if v.id is null or not core.can('BRIEFING', 'modify', v.org_node_id, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('briefing %s', p_id);
  end if;
  update ops.briefing set archived_at = now() where id = p_id;
end $$;

-- Today's notes at an outlet that show now (the whole day's and this part's), for everyone
-- who works there (ops.works_at). Words and dish names only; can_edit for the writers.
create function ops.briefing_today(p_outlet uuid)
returns table (id uuid, place_id uuid, place text, part text, body text, off_dishes jsonb,
               written_by text, written_at timestamptz, can_edit boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, menu, ops, rpt
as $$
declare
  v_outlet core.hierarchy_node;
begin
  select * into v_outlet from core.hierarchy_node
   where hierarchy_node.id = p_outlet and tenant_id = core.my_tenant() and type = 'org'
     and kind = 'outlet';
  if v_outlet.id is null or not ops.works_at(p_outlet) then
    raise exception 'NOT_AUTHORISED' using detail = format('briefing at %s', p_outlet);
  end if;
  return query
    select b.id, b.org_node_id, n.name, b.part, b.body,
           coalesce((select jsonb_agg(jsonb_build_object('id', mi.id, 'name', mi.name)
                                      order by mi.name)
                       from menu.menu_item mi where mi.id = any (b.off_dishes)), '[]'::jsonb),
           u.display_name, b.updated_at,
           core.can('BRIEFING', 'modify', b.org_node_id, null, null)
      from ops.briefing b
      join core.hierarchy_node n on n.id = b.org_node_id
      left join core.app_user u on u.id = b.updated_by
     where b.outlet_id = p_outlet and b.business_day = rpt.today(p_outlet)
       and b.archived_at is null
       and b.part in ('day', ops.briefing_part_now(p_outlet))
     order by (n.kind = 'outlet') desc, coalesce(array_position(array['kitchen', 'service', 'housekeeping', 'other'], n.department_type), 9), n.name,
              b.part = 'day' desc;
end $$;

-- Home's card: today's notes at the caller's home outlet.
create function ops.my_briefing()
returns table (outlet_id uuid, outlet text, id uuid, place_id uuid, place text, part text,
               body text, off_dishes jsonb, written_by text, written_at timestamptz,
               can_edit boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops
as $$
declare
  v_outlet core.hierarchy_node;
begin
  select o.* into v_outlet
    from hr.worker w
    join core.hierarchy_node o on o.id = core.nearest(w.org_node_id, array['outlet'])
   where w.owner_user_id = core.current_user_id() and w.status = 'active'
   order by w.id limit 1;
  if v_outlet.id is null then
    return;
  end if;
  return query select v_outlet.id, v_outlet.name, t.* from ops.briefing_today(v_outlet.id) t;
end $$;

-- The places the caller may write a note at (departments and outlets), with their outlet.
create function ops.briefing_places()
returns table (place_id uuid, place text, kind text, outlet_id uuid, outlet text)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select n.id, n.name, n.kind, o.id, o.name
    from core.hierarchy_node n
    join core.hierarchy_node o on o.id = core.nearest(n.id, array['outlet'])
   where n.tenant_id = core.my_tenant() and n.type = 'org'
     and n.kind in ('outlet', 'department') and n.archived_at is null
     and core.can('BRIEFING', 'modify', n.id, null, null)
   order by o.name, (n.kind = 'outlet') desc, coalesce(array_position(array['kitchen', 'service', 'housekeeping', 'other'], n.department_type), 9), n.name;
$$;

-- What the write screen needs at a place: today's open notes there (every part) and the
-- dishes on its outlet's menu today. For writers only.
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
     order by array_position(array['day', 'lunch', 'dinner'], b.part);
end $$;

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

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.briefing', 'BRIEFING', 'org', true);
select core.apply_domain_rls('ops.briefing');
select audit.enable('ops.briefing');

revoke execute on function ops.briefing_part_now(uuid, timestamptz), ops.briefing_outlet(uuid),
  ops.save_briefing(uuid, text, text, uuid[], text), ops.take_down_briefing(uuid),
  ops.briefing_today(uuid), ops.my_briefing(), ops.briefing_places(), ops.briefing_at(uuid),
  ops.briefing_dishes(uuid)
  from public, platform_loader;
grant execute on function ops.save_briefing(uuid, text, text, uuid[], text),
  ops.take_down_briefing(uuid), ops.briefing_today(uuid), ops.my_briefing(),
  ops.briefing_places(), ops.briefing_at(uuid), ops.briefing_dishes(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.briefing_dishes(uuid);
drop function ops.briefing_at(uuid);
drop function ops.briefing_places();
drop function ops.my_briefing();
drop function ops.briefing_today(uuid);
drop function ops.take_down_briefing(uuid);
drop function ops.save_briefing(uuid, text, text, uuid[], text);
drop function ops.briefing_outlet(uuid);
drop function ops.briefing_part_now(uuid, timestamptz);
delete from core.domain_table where table_name = 'ops.briefing'::regclass;
drop table ops.briefing;
