-- migrate:up
-- Homes that show the job (ADR 113).
--
-- Breakfast is read by those who serve it: a hotel's kitchen and its restaurant, not its bar
-- (a bar is a "service" department too). Front office and housekeeping keep it, as before.
create or replace function ops.reads_breakfast(p_outlet uuid) returns boolean
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
           and (d.department_type = 'kitchen'
                or (d.department_type = 'service'
                    and not (d.name ~* '\mbar\M|\mpub\M|lounge|cellar'
                             and d.name !~* 'restaurant|dining|caf[eé]|coffee'))));
$$;

-- An event's people: for each job role it needs, how many are rostered on a shift of that role
-- at the event's outlet that overlaps the time it needs them (ADR 113). Whoever sees the event
-- sees this, even where they don't see those shifts themselves.
create function ops.event_staffing(p_event uuid)
returns table (role_code text, needed int, rostered int)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
declare
  v_node uuid;
begin
  select e.org_node_id into v_node from ops.event e
   where e.id = p_event and e.tenant_id = core.my_tenant();
  if v_node is null or not core.can('EVENTS', 'view', v_node, null) then
    raise exception 'NOT_AUTHORISED' using detail = 'EVENTS view';
  end if;
  return query
    with outlet as (
      select o.path from core.hierarchy_node n
        join core.hierarchy_node o on o.tenant_id = n.tenant_id and o.kind = 'outlet'
                                  and n.path operator(extensions.<@) o.path
       where n.id = v_node
       order by nlevel(o.path) desc limit 1)
    select q.role_code, sum(q.headcount)::int,
           (select count(distinct a.worker_id)::int
              from hr.shift s
              join hr.shift_assignment a on a.shift_id = s.id and a.status = 'assigned'
              join core.hierarchy_node sn on sn.id = s.org_node_id
             where s.tenant_id = core.my_tenant() and s.status <> 'cancelled'
               and s.role_code = q.role_code
               and sn.path operator(extensions.<@) coalesce((select path from outlet),
                                                             (select path from core.hierarchy_node
                                                               where id = v_node))
               and a.start_at < max(q.ends_at) and a.end_at > min(q.starts_at))
      from ops.event_requirement q
     where q.event_id = p_event and q.kind = 'role' and q.archived_at is null
     group by q.role_code
     order by q.role_code;
end $$;

-- Who is on shift at a place today (ADR 113): a published shift on today's business day, or
-- clocked in now. Person pickers put them first and say so; whoever gives out tasks there
-- (TASKS modify) may ask.
create function ops.on_shift_today(p_node uuid) returns setof uuid
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, rpt, extensions
as $$
begin
  if not core.can('TASKS', 'modify', p_node, null) then
    raise exception 'NOT_AUTHORISED' using detail = 'TASKS modify';
  end if;
  return query
    select distinct w.owner_user_id
      from hr.worker w
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node n on n.id = p_node and n.tenant_id = w.tenant_id
     where w.status = 'active' and h.path operator(extensions.<@) n.path
       and (ops.clocked_in(w.owner_user_id, now())
            or exists (select 1 from hr.shift_assignment a
                         join hr.shift s on s.id = a.shift_id and s.status = 'published'
                        where a.owner_user_id = w.owner_user_id and a.status = 'assigned'
                          and s.local_date = rpt.business_date(now(), ops.tz_of(p_node))));
end $$;

revoke execute on function ops.on_shift_today(uuid) from public, platform_loader;
grant execute on function ops.on_shift_today(uuid) to app_rw;

revoke execute on function ops.event_staffing(uuid) from public, platform_loader;
grant execute on function ops.event_staffing(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.on_shift_today(uuid);
drop function ops.event_staffing(uuid);
create or replace function ops.reads_breakfast(p_outlet uuid) returns boolean
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
