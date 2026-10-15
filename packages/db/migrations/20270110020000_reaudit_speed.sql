-- migrate:up
-- The re-audit's slow screens (ADR 160).
--
-- * Request from a store and an item's page: inv.ask_items asked inv.source_for (and with it
--   inv.transfer_sources) once per item of the company, and inv.item_group twice per item.
--   It now reads the stores it may ask once, ranks them per item the same way, and works out
--   each item's group from the site's stores once. The item's page asks inv.ask_source for its
--   one item instead of reading the whole list.
-- * Home: ops.late_count ran ops.task_homes for every late task once per department. Home asks
--   ops.late_counts for all its departments at once, each late task's homes worked out once.
-- * ops.my_tasks (Home, the To do list, its count on every screen) asked ops.leads once per
--   task; it asks once per place.

create or replace function inv.ask_items(p_to uuid)
returns table (item_id uuid, name text, base_uom text, on_hand numeric, avg_cost numeric,
               item_group text, par_level numeric, source_id uuid, source_name text,
               source_on_hand numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_site uuid;
  v_parent uuid;
  v_hk boolean;
begin
  perform wf.me();
  perform inv.require('TRANSFERS', 'modify', p_to);
  v_site := core.stock_site(p_to);
  v_hk := inv.store_team_type(p_to) = 'housekeeping';
  select parent_id into v_parent from core.hierarchy_node where id = p_to;
  return query
    with src as materialized (
      -- the stores it may ask, once (inv.source_for ranks them per item the same way)
      select s.id, inv.is_main_store(s.id) as main, n.parent_id is not distinct from v_parent as here,
             n.name,
             -- the outlet's own stores by their short names ("Bar"), a central kitchen in full
             case when n.parent_id is not distinct from v_parent then inv.short_name(s.id)
                  else core.node_name(s.id) end as label
        from inv.transfer_sources(p_to) s
        join core.hierarchy_node n on n.id = s.id
       where s.id <> p_to
    ), main as (
      select (select a.id from src a where a.main order by a.id limit 1) as id,
             exists (select 1 from src a where a.main and a.here) as here
    ), wanted as (
      select n.item_id from inv.item_node n
       where n.delivery_node_id = p_to and n.archived_at is null
      union
      select f.item_id from inv.item_node f
       where f.delivery_node_id = (select id from main) and f.archived_at is null
    ), sites as materialized (
      -- the stores at this site that keep a wanted item, with their team (inv.item_group)
      select d.id, inv.store_team_type(d.id) as t
        from (select distinct x.delivery_node_id as id
                from inv.item_node x join wanted w on w.item_id = x.item_id
               where x.archived_at is null) d
       where core.stock_site(d.id) = v_site
    ), grp as (
      select x.item_id,
             case when bool_or(st.t = 'housekeeping') and not bool_or(st.t in ('kitchen', 'service'))
                  then 'housekeeping' else 'kitchen_bar' end as g
        from inv.item_node x
        join wanted w on w.item_id = x.item_id
        join sites st on st.id = x.delivery_node_id
       where x.archived_at is null
       group by x.item_id
    )
    select i.id, i.name, i.base_uom, coalesce(s.on_hand, 0), coalesce(s.avg_cost, 0),
           coalesce(g.g, 'kitchen_bar'), coalesce(t.par_level, 0), src.id, src.label,
           coalesce(ss.on_hand, 0)
      from wanted w
      join inv.item i on i.id = w.item_id and i.archived_at is null
      left join grp g on g.item_id = i.id
      left join inv.item_node t on t.item_id = i.id and t.delivery_node_id = p_to
                               and t.archived_at is null
      left join inv.stock_level s on s.item_id = i.id and s.delivery_node_id = p_to
      left join lateral (
        select r.id, r.label from (
          select a.id, a.label, a.name,
                 case when (select here from main)
                      then case when a.main and a.here and k.keeps then 0
                                when not a.here and k.keeps then 1
                                when a.main and a.here then 2 end
                      else case when a.here and k.keeps then 0
                                when k.keeps then 1 end end as rank
            from src a
            cross join lateral (select exists (
              select 1 from inv.item_node x where x.item_id = i.id and x.delivery_node_id = a.id
                 and x.archived_at is null) as keeps) k) r
         where r.rank is not null order by r.rank, r.name limit 1) src on true
      left join inv.stock_level ss on ss.item_id = i.id and ss.delivery_node_id = src.id
     order by (coalesce(g.g, 'kitchen_bar') = 'housekeeping') = v_hk desc, i.name;
end $$;

-- Where more of one item comes from for a store: inv.ask_items' source for it (ADR 115, 134).
create function inv.ask_source(p_to uuid, p_item uuid)
returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_main uuid;
begin
  perform wf.me();
  perform inv.require('TRANSFERS', 'modify', p_to);
  select s.id into v_main from inv.transfer_sources(p_to) s
   where inv.is_main_store(s.id) and s.id <> p_to order by s.id limit 1;
  -- only an item the store may ask for: one it keeps, or one its Main Store gives
  if not exists (select 1 from inv.item_node n
                   join inv.item i on i.id = n.item_id and i.archived_at is null
                  where n.item_id = p_item and n.archived_at is null
                    and (n.delivery_node_id = p_to or n.delivery_node_id = v_main)) then
    return null;
  end if;
  return inv.source_for(p_to, p_item);
end $$;

revoke execute on function inv.ask_source(uuid, uuid) from public;
grant execute on function inv.ask_source(uuid, uuid) to app_rw;

-- ops.late_count for several places at once (Home's departments), each the same count.
create function ops.late_counts(p_nodes uuid[], p_from date, p_to date)
returns table (node_id uuid, n int)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, hr, extensions
as $$
declare
  v uuid;
begin
  foreach v in array coalesce(p_nodes, '{}') loop
    perform hr.require('TASKS', 'view', v);
  end loop;
  return query
    with p as materialized (
      select x.id, x.path, x.tenant_id, ops.tz_of(x.id) as tz,
             core.nearest(x.id, array['outlet', 'site']) as home
        from core.hierarchy_node x where x.id = any(p_nodes)
    ), late as materialized (
      select t.id, t.due_at, t.tenant_id, n.path, t.assignee_user_id is not null as given,
             core.nearest(t.org_node_id, array['outlet', 'site']) as home, t as task
        from ops.task t
        join core.hierarchy_node n on n.id = t.org_node_id
       where t.tenant_id in (select p.tenant_id from p)
         and t.status in ('open', 'in_progress') and t.due_at < now()
         -- the first day in any time zone; the exact day is checked per place below
         and t.due_at >= p_from::timestamptz - interval '2 days'
    ), homed as materialized (
      -- whose places a task is in, once a task (ops.late_count asks it once a place)
      select l.id,
             array(select h.path from ops.task_homes(l.task) th
                     join core.hierarchy_node h on h.id = th) as homes
        from late l
       where l.given or l.home in (select p.home from p)
    )
    select p.id, count(l.id)::int
      from p
      left join late l
        on l.tenant_id = p.tenant_id
       and (l.due_at at time zone p.tz)::date between p_from and p_to
       and (l.path operator(extensions.<@) p.path
            or ((l.given or l.home = p.home)
                and exists (select 1 from homed hd cross join unnest(hd.homes) hp
                             where hd.id = l.id and hp operator(extensions.<@) p.path)))
     group by p.id;
end $$;

revoke execute on function ops.late_counts(uuid[], date, date) from public;
grant execute on function ops.late_counts(uuid[], date, date) to app_rw;


-- ops.in_pool with whether the person leads the task's place already known (null: work it out).
-- ops.my_tasks (Home, the To do list and its count on every screen) asks ops.leads once per
-- place instead of once per task.
create function ops.in_pool(p_task ops.task, p_user uuid, p_led boolean)
returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select case p_task.assign_mode
    when 'job_role' then
      case
        when ops.of_task_role(p_task, p_user) then ops.working_at(p_user, p_task.due_at)
        -- a head's fallback: asked only of someone who holds a head's group at all
        when exists (select 1 from core.role_assignment ra
                       join core.security_group g on g.id = ra.group_id
                      where ra.user_id = p_user and ra.tenant_id = p_task.tenant_id
                        and (g.code in ('DEPARTMENT_HEAD', 'OUTLET_MANAGER')
                             or g.acts_as && array['DEPARTMENT_HEAD', 'OUTLET_MANAGER'])
                        and ra.effective_from <= current_date
                        and (ra.effective_to is null or ra.effective_to >= current_date))
          then coalesce(p_led, p_user = any (ops.leads(p_task.org_node_id)))
               and cardinality(ops.job_role_workers(p_task)) = 0
        else false
      end
    when 'on_shift' then exists (
      select 1 from hr.shift_assignment a
        join hr.shift s on s.id = a.shift_id and s.status = 'published'
        join core.hierarchy_node h on h.id = a.org_node_id
        join core.hierarchy_node n on n.id = p_task.org_node_id
       where a.owner_user_id = p_user and a.status = 'assigned' and a.tenant_id = p_task.tenant_id
         and a.start_at <= p_task.due_at and a.end_at >= p_task.due_at
         and h.path operator(extensions.<@) n.path)
    else false end
    and exists (select 1 from core.app_user u where u.id = p_user and u.status = 'active');
$$;

revoke execute on function ops.in_pool(ops.task, uuid, boolean) from public;
grant execute on function ops.in_pool(ops.task, uuid, boolean) to platform_loader;

create or replace function ops.in_pool(p_task ops.task, p_user uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select ops.in_pool(p_task, p_user, null);
$$;

create or replace function ops.my_tasks()
 RETURNS TABLE(id uuid, kind text, title text, org_node_id uuid, place_name text, due_at timestamp with time zone, priority text, status text, assign_mode text, taken boolean, steps_total integer, steps_done integer, overdue boolean, covering text, assigned_at timestamp with time zone, assigned_by_name text, completed_at timestamp with time zone, done_by_name text, not_given_reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'ops'
AS $function$
  -- whether I lead each place with open job-role tasks, once a place (ops.in_pool asks it of
  -- a head; null: it works it out)
  with led as materialized (
    select o.org_node_id, core.current_user_id() = any (ops.leads(o.org_node_id)) as led
      from (select distinct t.org_node_id from ops.task t
             where t.tenant_id = core.my_tenant() and t.assign_mode = 'job_role'
               and t.assignee_user_id is null and t.status in ('open', 'in_progress')) o
     where exists (select 1 from core.role_assignment ra
                     join core.security_group g on g.id = ra.group_id
                    where ra.user_id = core.current_user_id()
                      and (g.code in ('DEPARTMENT_HEAD', 'OUTLET_MANAGER')
                           or g.acts_as && array['DEPARTMENT_HEAD', 'OUTLET_MANAGER'])
                      and ra.effective_from <= current_date
                      and (ra.effective_to is null or ra.effective_to >= current_date))
  )
  select t.id, t.kind, t.title, t.org_node_id, n.name, t.due_at, t.priority, t.status,
         t.assign_mode, t.assignee_user_id is not null,
         (select count(*)::int from ops.task_step s where s.task_id = t.id),
         (select count(*)::int from ops.task_step s where s.task_id = t.id and s.done_at is not null),
         t.status in ('open', 'in_progress') and t.due_at < now(),
         case when t.assign_mode = 'job_role'
                   and ops.covers(core.current_user_id(), t.job_role_code, t.org_node_id)
              then (select j.name from hr.job_role j
                     where j.tenant_id = t.tenant_id and j.code = t.job_role_code) end,
         t.assigned_at,
         (select u.display_name from core.app_user u
           where u.id = t.assigned_by and u.id <> core.current_user_id()),
         case when t.status = 'done' then t.completed_at end,
         -- who did it, when it was someone else (null: you)
         case when t.status = 'done' then
           (select u.display_name from core.app_user u
             where u.id = coalesce(t.completed_by, t.assignee_user_id)
               and u.id <> core.current_user_id()) end,
         ops.not_given_reason(t)
    from ops.task t
    join core.hierarchy_node n on n.id = t.org_node_id
    left join led l on l.org_node_id = t.org_node_id
   where t.tenant_id = core.my_tenant()
     and ((t.status in ('open', 'in_progress')
           and (t.assignee_user_id = core.current_user_id()
                or (t.assignee_user_id is null and ops.in_pool(t, core.current_user_id(), l.led))))
          or (ops.done_lately(t)
              and (t.assignee_user_id = core.current_user_id()
                   or t.completed_by = core.current_user_id()
                   or (t.assign_mode in ('job_role', 'on_shift')
                       and ops.in_pool(t, core.current_user_id(), l.led)))))
   order by t.status in ('done'), t.due_at, t.priority = 'high' desc;
$function$;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous functions for local work.
create or replace function ops.my_tasks()
 RETURNS TABLE(id uuid, kind text, title text, org_node_id uuid, place_name text, due_at timestamp with time zone, priority text, status text, assign_mode text, taken boolean, steps_total integer, steps_done integer, overdue boolean, covering text, assigned_at timestamp with time zone, assigned_by_name text, completed_at timestamp with time zone, done_by_name text, not_given_reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'ops'
AS $function$
  select t.id, t.kind, t.title, t.org_node_id, n.name, t.due_at, t.priority, t.status,
         t.assign_mode, t.assignee_user_id is not null,
         (select count(*)::int from ops.task_step s where s.task_id = t.id),
         (select count(*)::int from ops.task_step s where s.task_id = t.id and s.done_at is not null),
         t.status in ('open', 'in_progress') and t.due_at < now(),
         case when t.assign_mode = 'job_role'
                   and ops.covers(core.current_user_id(), t.job_role_code, t.org_node_id)
              then (select j.name from hr.job_role j
                     where j.tenant_id = t.tenant_id and j.code = t.job_role_code) end,
         t.assigned_at,
         (select u.display_name from core.app_user u
           where u.id = t.assigned_by and u.id <> core.current_user_id()),
         case when t.status = 'done' then t.completed_at end,
         -- who did it, when it was someone else (null: you)
         case when t.status = 'done' then
           (select u.display_name from core.app_user u
             where u.id = coalesce(t.completed_by, t.assignee_user_id)
               and u.id <> core.current_user_id()) end,
         ops.not_given_reason(t)
    from ops.task t
    join core.hierarchy_node n on n.id = t.org_node_id
   where t.tenant_id = core.my_tenant()
     and ((t.status in ('open', 'in_progress')
           and (t.assignee_user_id = core.current_user_id()
                or (t.assignee_user_id is null and ops.in_pool(t, core.current_user_id()))))
          or (ops.done_lately(t)
              and (t.assignee_user_id = core.current_user_id()
                   or t.completed_by = core.current_user_id()
                   or (t.assign_mode in ('job_role', 'on_shift')
                       and ops.in_pool(t, core.current_user_id())))))
   order by t.status in ('done'), t.due_at, t.priority = 'high' desc;
$function$

;
create or replace function ops.in_pool(p_task ops.task, p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr', 'extensions'
AS $function$
  select case p_task.assign_mode
    when 'job_role' then
      case
        when ops.of_task_role(p_task, p_user) then ops.working_at(p_user, p_task.due_at)
        -- a head's fallback: asked only of someone who holds a head's group at all
        when exists (select 1 from core.role_assignment ra
                       join core.security_group g on g.id = ra.group_id
                      where ra.user_id = p_user and ra.tenant_id = p_task.tenant_id
                        and (g.code in ('DEPARTMENT_HEAD', 'OUTLET_MANAGER')
                             or g.acts_as && array['DEPARTMENT_HEAD', 'OUTLET_MANAGER'])
                        and ra.effective_from <= current_date
                        and (ra.effective_to is null or ra.effective_to >= current_date))
          then p_user = any (ops.leads(p_task.org_node_id))
               and cardinality(ops.job_role_workers(p_task)) = 0
        else false
      end
    when 'on_shift' then exists (
      select 1 from hr.shift_assignment a
        join hr.shift s on s.id = a.shift_id and s.status = 'published'
        join core.hierarchy_node h on h.id = a.org_node_id
        join core.hierarchy_node n on n.id = p_task.org_node_id
       where a.owner_user_id = p_user and a.status = 'assigned' and a.tenant_id = p_task.tenant_id
         and a.start_at <= p_task.due_at and a.end_at >= p_task.due_at
         and h.path operator(extensions.<@) n.path)
    else false end
    and exists (select 1 from core.app_user u where u.id = p_user and u.status = 'active');
$function$

;
drop function ops.in_pool(ops.task, uuid, boolean);
drop function ops.late_counts(uuid[], date, date);
drop function inv.ask_source(uuid, uuid);
create or replace function inv.ask_items(p_to uuid)
 RETURNS TABLE(item_id uuid, name text, base_uom text, on_hand numeric, avg_cost numeric, item_group text, par_level numeric, source_id uuid, source_name text, source_on_hand numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'wf'
AS $function$
declare
  v_main uuid;
begin
  perform wf.me();
  perform inv.require('TRANSFERS', 'modify', p_to);
  select s.id into v_main from inv.transfer_sources(p_to) s
   where inv.is_main_store(s.id) and s.id <> p_to order by s.id limit 1;
  return query
    with wanted as (
      select n.item_id from inv.item_node n
       where n.delivery_node_id = p_to and n.archived_at is null
      union
      select x.item_id from inv.sendable_items(v_main, p_to) x where v_main is not null
    )
    select i.id, i.name, i.base_uom, coalesce(s.on_hand, 0), coalesce(s.avg_cost, 0),
           inv.item_group(i.id, p_to), coalesce(t.par_level, 0), src.id,
           -- the outlet's own stores by their short names ("Bar"), a central kitchen in full
           case when src.id is null then null
                when (select parent_id from core.hierarchy_node where id = src.id)
                     is not distinct from (select parent_id from core.hierarchy_node where id = p_to)
                then inv.short_name(src.id)
                else core.node_name(src.id) end,
           coalesce(ss.on_hand, 0)
      from wanted w
      join inv.item i on i.id = w.item_id and i.archived_at is null
      left join inv.item_node t on t.item_id = i.id and t.delivery_node_id = p_to
                               and t.archived_at is null
      left join inv.stock_level s on s.item_id = i.id and s.delivery_node_id = p_to
      left join lateral (select inv.source_for(p_to, i.id) as id) src on true
      left join inv.stock_level ss on ss.item_id = i.id and ss.delivery_node_id = src.id
     order by inv.own_group(inv.item_group(i.id, p_to), p_to) desc, i.name;
end $function$
;
