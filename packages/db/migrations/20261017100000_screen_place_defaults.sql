-- migrate:up
-- The place a screen opens on (UX review U-7, U-8). Before: the person's home place and
-- their outlet tied for first, so a commis reporting a problem started at the outlet, and a
-- general manager (whose home is the outlet, which Roster doesn't list) started at the
-- first department alphabetically, often an empty one. Now the home place comes first, then
-- the outlet; on Roster and Exceptions, departments with shifts this fortnight or open
-- attendance flags come before the rest. Which places are listed is unchanged.
CREATE OR REPLACE FUNCTION core.screen_places(p_screen text)
 RETURNS TABLE(id uuid, code text, name text, kind text, type text, timezone text, preferred integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr', 'inv', 'menu', 'ops'
AS $function$
declare
  v_home uuid := (select w.org_node_id from hr.worker w
                   where w.owner_user_id = core.current_user_id());
  v_outlet uuid := core.nearest(v_home, array['outlet', 'site']);
  v_stores uuid[];
  v_main uuid;
begin
  if p_screen is null or p_screen not in ('stock', 'count', 'wastage', 'orders', 'transfers',
      'variance', 'production', 'sales', 'menu', 'roster', 'exceptions', 'events',
      'tasks', 'tasks_new', 'checklists', 'maintenance', 'report') then
    raise exception 'INVALID_SCREEN' using detail = coalesce(p_screen, 'none');
  end if;
  v_stores := array(select nl.delivery_node_id from core.node_link nl
                     where nl.org_node_id = v_home);
  v_main := (select core.stock_location_of(nl.delivery_node_id) from core.node_link nl
               join core.hierarchy_node d on d.id = nl.delivery_node_id
              where nl.org_node_id = v_outlet and d.kind in ('outlet', 'hub')
              order by d.id limit 1);
  return query
    select n.id, n.code, n.name, n.kind, n.type,
           coalesce(n.timezone, (select t.default_timezone from core.tenant t
                                  where t.id = n.tenant_id)),
           case when n.id = v_home then 0
                when n.id = v_outlet then 1
                when n.id = any (v_stores) then 2
                when n.id = v_main then 3
                -- a manager's home is the outlet, which these screens don't list: open
                -- the departments with something on them before the empty ones
                when p_screen = 'roster' and exists (
                       select 1 from hr.shift s
                        where s.org_node_id = n.id
                          and s.local_date between current_date - 7 and current_date + 7) then 5
                when p_screen = 'exceptions' and exists (
                       select 1 from hr.attendance_exception x
                        where x.org_node_id = n.id and x.status = 'open') then 5
                else 9 end
      from core.hierarchy_node n
     where n.tenant_id = core.my_tenant() and n.archived_at is null
       and case
         when p_screen in ('stock', 'count', 'wastage', 'orders', 'transfers', 'variance',
                           'production') then
           n.type = 'delivery' and n.holds_stock and case p_screen
             when 'stock' then core.can('STOCK_LEVELS', 'view', null, n.id)
             when 'count' then core.can('STOCK_ADJUSTMENTS', 'modify', null, n.id)
             when 'wastage' then core.can('STOCK_ADJUSTMENTS', 'modify', null, n.id)
             when 'orders' then core.can('PURCHASE_ORDERS', 'view', null, n.id)
             when 'transfers' then core.can('TRANSFERS', 'view', null, n.id)
             when 'variance' then core.can('MENU', 'view', null, n.id)
             else exists (select 1 from inv.item_node x
                           where x.delivery_node_id = n.id and x.made_here
                             and x.archived_at is null)
                  and inv.can_produce_at(n.id) end
         when p_screen in ('sales', 'menu') then
           n.type = 'org'
           and exists (select 1 from menu.menu_outlet mo
                        where mo.org_node_id = n.id
                          and (mo.effective_to is null or mo.effective_to >= current_date)
                          and core.can(case p_screen when 'sales' then 'SALES' else 'MENU' end,
                                       case p_screen when 'sales' then 'modify' else 'view' end,
                                       null, mo.delivery_node_id))
         when p_screen = 'events' then
           n.type = 'org' and n.kind in ('outlet', 'site') and ops.can_read_event_node(n.id)
         when p_screen in ('tasks', 'tasks_new', 'checklists', 'maintenance', 'report') then
           n.type = 'org' and (core.is_team_place(n.id) or n.kind in ('outlet', 'site'))
           and case p_screen
             when 'tasks' then core.can('TASKS', 'view', n.id, null)
             when 'tasks_new' then core.can('TASKS', 'modify', n.id, null)
             when 'checklists' then core.can('CHECKLIST_TEMPLATES', 'view', n.id, null)
             when 'maintenance' then core.can('MAINTENANCE', 'view', n.id, null)
             else ops.works_at(n.id) end
         else
           core.is_team_place(n.id)
           and case p_screen
             when 'roster' then core.can('ROSTER', 'view', n.id, null)
             else core.can('ATTENDANCE', 'modify', n.id, null) end
       end
     order by 7, n.name;
end $function$;

-- migrate:down
CREATE OR REPLACE FUNCTION core.screen_places(p_screen text)
 RETURNS TABLE(id uuid, code text, name text, kind text, type text, timezone text, preferred integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr', 'inv', 'menu', 'ops'
AS $function$
declare
  v_home uuid := (select w.org_node_id from hr.worker w
                   where w.owner_user_id = core.current_user_id());
  v_outlet uuid := core.nearest(v_home, array['outlet', 'site']);
  v_stores uuid[];
  v_main uuid;
begin
  if p_screen is null or p_screen not in ('stock', 'count', 'wastage', 'orders', 'transfers',
      'variance', 'production', 'sales', 'menu', 'roster', 'exceptions', 'events',
      'tasks', 'tasks_new', 'checklists', 'maintenance', 'report') then
    raise exception 'INVALID_SCREEN' using detail = coalesce(p_screen, 'none');
  end if;
  v_stores := array(select nl.delivery_node_id from core.node_link nl
                     where nl.org_node_id = v_home);
  v_main := (select core.stock_location_of(nl.delivery_node_id) from core.node_link nl
               join core.hierarchy_node d on d.id = nl.delivery_node_id
              where nl.org_node_id = v_outlet and d.kind in ('outlet', 'hub')
              order by d.id limit 1);
  return query
    select n.id, n.code, n.name, n.kind, n.type,
           coalesce(n.timezone, (select t.default_timezone from core.tenant t
                                  where t.id = n.tenant_id)),
           case when n.id = v_home or n.id = v_outlet then 1
                when n.id = any (v_stores) then 2
                when n.id = v_main then 3
                else 9 end
      from core.hierarchy_node n
     where n.tenant_id = core.my_tenant() and n.archived_at is null
       and case
         when p_screen in ('stock', 'count', 'wastage', 'orders', 'transfers', 'variance',
                           'production') then
           n.type = 'delivery' and n.holds_stock and case p_screen
             when 'stock' then core.can('STOCK_LEVELS', 'view', null, n.id)
             when 'count' then core.can('STOCK_ADJUSTMENTS', 'modify', null, n.id)
             when 'wastage' then core.can('STOCK_ADJUSTMENTS', 'modify', null, n.id)
             when 'orders' then core.can('PURCHASE_ORDERS', 'view', null, n.id)
             when 'transfers' then core.can('TRANSFERS', 'view', null, n.id)
             when 'variance' then core.can('MENU', 'view', null, n.id)
             else exists (select 1 from inv.item_node x
                           where x.delivery_node_id = n.id and x.made_here
                             and x.archived_at is null)
                  and inv.can_produce_at(n.id) end
         when p_screen in ('sales', 'menu') then
           n.type = 'org'
           and exists (select 1 from menu.menu_outlet mo
                        where mo.org_node_id = n.id
                          and (mo.effective_to is null or mo.effective_to >= current_date)
                          and core.can(case p_screen when 'sales' then 'SALES' else 'MENU' end,
                                       case p_screen when 'sales' then 'modify' else 'view' end,
                                       null, mo.delivery_node_id))
         when p_screen = 'events' then
           n.type = 'org' and n.kind in ('outlet', 'site') and ops.can_read_event_node(n.id)
         when p_screen in ('tasks', 'tasks_new', 'checklists', 'maintenance', 'report') then
           n.type = 'org' and (core.is_team_place(n.id) or n.kind in ('outlet', 'site'))
           and case p_screen
             when 'tasks' then core.can('TASKS', 'view', n.id, null)
             when 'tasks_new' then core.can('TASKS', 'modify', n.id, null)
             when 'checklists' then core.can('CHECKLIST_TEMPLATES', 'view', n.id, null)
             when 'maintenance' then core.can('MAINTENANCE', 'view', n.id, null)
             else ops.works_at(n.id) end
         else
           core.is_team_place(n.id)
           and case p_screen
             when 'roster' then core.can('ROSTER', 'view', n.id, null)
             else core.can('ATTENDANCE', 'modify', n.id, null) end
       end
     order by 7, n.name;
end $function$;
