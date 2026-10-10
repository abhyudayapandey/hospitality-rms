-- migrate:up
-- Rooms and minibars for people who read little (ADR 104).
--
-- * ops.minibar_places says whether the caller bills the outlet's minibars (`bills`): they
--   work in the department the bills go to (ops.minibar_biller: the front desk), or manage
--   its tasks there (TASKS modify, the outlet's managers); where no department takes the
--   bills, whoever checks minibars there. Only they see the rupees to charge and the "Added to
--   the bill" button on the Minibars screen. Marking a charge added is unchanged
--   (ops.mark_minibar_charged, MINIBAR modify).
-- * ops.minibar_rooms gives each room's status and whether its minibar is due a check today:
--   it has a minibar, it was not checked today, and a guest is in, arriving or leaving.

drop function ops.minibar_places();
create function ops.minibar_places()
returns table (outlet_id uuid, outlet text, rooms int, can_check boolean, bills boolean)
language sql stable security definer
set search_path = pg_catalog, core, hr, ops
as $$
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
$$;

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

revoke execute on function ops.minibar_places(), ops.minibar_rooms(uuid)
  from public, platform_loader;
grant execute on function ops.minibar_places(), ops.minibar_rooms(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.minibar_places();
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

drop function ops.minibar_rooms(uuid);
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
revoke execute on function ops.minibar_places(), ops.minibar_rooms(uuid)
  from public, platform_loader;
grant execute on function ops.minibar_places(), ops.minibar_rooms(uuid) to app_rw;
