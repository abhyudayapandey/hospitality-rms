-- migrate:up
-- rpt.report_places (ADR 023, ADR 028) worked out core.visible_nodes inside the row filter
-- for outlet_flash (SALES), department (ATTENDANCE) and the store reports (MENU,
-- PURCHASE_ORDERS modify), so Postgres ran it again for every node it tested: 0.3 s for
-- one report and 0.8 s for rpt.my_reports() for a general manager. Each set is now worked
-- out once per call. The rules are unchanged (reports-access.db.test.ts checks every user
-- against them).

create or replace function rpt.report_places(p_report text)
 RETURNS TABLE(id uuid, code text, name text, kind text, preferred integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr', 'extensions'
AS $function$
declare
  v_home core.hierarchy_node;
  v_site core.hierarchy_node;
  v_all uuid[] := core.visible_nodes('REPORTS', 'view');
  v_menu uuid[];
  v_sales uuid[];
  v_orders uuid[];
  v_attendance uuid[];
  v_ok uuid[];
begin
  if p_report = 'outlet_flash' then
    v_sales := core.visible_nodes('SALES', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.kind = 'outlet' and n.type = 'org'
       and (n.id = any (v_all)
            or exists (select 1 from core.node_link l
                        where l.org_node_id = n.id
                          and l.delivery_node_id = any (v_sales)));
  elsif p_report = 'department' then
    v_attendance := core.visible_nodes('ATTENDANCE', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('outlet', 'site', 'department')
       and (n.id = any (v_all) or n.id = any (v_attendance))
       and core.is_team_place(n.id);
  elsif p_report = 'cost_of_sales' then
    v_menu := core.visible_nodes('MENU', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('outlet', 'site') and n.tenant_id = core.my_tenant()
       and cardinality(rpt.place_stores(n.id)) > 0
       and (n.id = any (v_all) or rpt.place_stores(n.id) && v_menu);
  elsif p_report = 'menu_engineering' then
    v_menu := core.visible_nodes('MENU', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind = 'outlet' and n.tenant_id = core.my_tenant()
       and exists (select 1 from menu.menu_outlet mo where mo.org_node_id = n.id
                      and (n.id = any (v_all) or mo.delivery_node_id = any (v_menu)));
  elsif p_report in ('stock_position', 'purchasing') then
    v_menu := core.visible_nodes('MENU', 'view');
    v_orders := core.visible_nodes('PURCHASE_ORDERS', 'modify');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'delivery' and n.holds_stock and n.tenant_id = core.my_tenant()
       and (n.id = any (v_menu)
            or n.id = any (v_orders)
            or exists (select 1 from core.node_link l where l.delivery_node_id = n.id
                          and l.org_node_id = any (v_all)));
  else
    raise exception 'INVALID_REPORT' using detail = p_report;
  end if;
  select n.* into v_home from hr.worker w join core.hierarchy_node n on n.id = w.org_node_id
   where w.owner_user_id = core.current_user_id() and w.status = 'active';
  -- the person's outlet or site, for stores: those of their own outlet come first
  select a.* into v_site from core.hierarchy_node a
   where v_home.id is not null and v_home.path <@ a.path and a.kind in ('outlet', 'site')
   order by nlevel(a.path) desc limit 1;
  return query
    select n.id, n.code, n.name, n.kind,
           case when n.type = 'delivery' then
                  case when exists (select 1 from core.node_link l
                                     where l.delivery_node_id = n.id and l.org_node_id = v_home.id)
                       then 0
                       when v_site.id is not null
                            and n.id = any (rpt.place_stores(v_site.id)) then 1
                       else 9 end
                when n.id = v_home.id then 0
                when v_home.id is not null and v_home.path <@ n.path then 1
                when v_home.id is not null and n.path <@ v_home.path then 2
                else 9 end
      from core.hierarchy_node n
     where n.id = any (v_ok) and n.tenant_id = core.my_tenant() and n.archived_at is null
     order by 5, n.name;
end $function$;

-- migrate:down

create or replace function rpt.report_places(p_report text)
 RETURNS TABLE(id uuid, code text, name text, kind text, preferred integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr', 'extensions'
AS $function$
declare
  v_home core.hierarchy_node;
  v_site core.hierarchy_node;
  v_all uuid[] := core.visible_nodes('REPORTS', 'view');
  v_menu uuid[];
  v_ok uuid[];
begin
  if p_report = 'outlet_flash' then
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.kind = 'outlet' and n.type = 'org'
       and (n.id = any (v_all)
            or exists (select 1 from core.node_link l
                        where l.org_node_id = n.id
                          and l.delivery_node_id = any (core.visible_nodes('SALES', 'view'))));
  elsif p_report = 'department' then
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('outlet', 'site', 'department')
       and (n.id = any (v_all) or n.id = any (core.visible_nodes('ATTENDANCE', 'view')))
       and core.is_team_place(n.id);
  elsif p_report = 'cost_of_sales' then
    v_menu := core.visible_nodes('MENU', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('outlet', 'site') and n.tenant_id = core.my_tenant()
       and cardinality(rpt.place_stores(n.id)) > 0
       and (n.id = any (v_all) or rpt.place_stores(n.id) && v_menu);
  elsif p_report = 'menu_engineering' then
    v_menu := core.visible_nodes('MENU', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind = 'outlet' and n.tenant_id = core.my_tenant()
       and exists (select 1 from menu.menu_outlet mo where mo.org_node_id = n.id
                      and (n.id = any (v_all) or mo.delivery_node_id = any (v_menu)));
  elsif p_report in ('stock_position', 'purchasing') then
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'delivery' and n.holds_stock and n.tenant_id = core.my_tenant()
       and (n.id = any (core.visible_nodes('MENU', 'view'))
            or n.id = any (core.visible_nodes('PURCHASE_ORDERS', 'modify'))
            or exists (select 1 from core.node_link l where l.delivery_node_id = n.id
                          and l.org_node_id = any (v_all)));
  else
    raise exception 'INVALID_REPORT' using detail = p_report;
  end if;
  select n.* into v_home from hr.worker w join core.hierarchy_node n on n.id = w.org_node_id
   where w.owner_user_id = core.current_user_id() and w.status = 'active';
  -- the person's outlet or site, for stores: those of their own outlet come first
  select a.* into v_site from core.hierarchy_node a
   where v_home.id is not null and v_home.path <@ a.path and a.kind in ('outlet', 'site')
   order by nlevel(a.path) desc limit 1;
  return query
    select n.id, n.code, n.name, n.kind,
           case when n.type = 'delivery' then
                  case when exists (select 1 from core.node_link l
                                     where l.delivery_node_id = n.id and l.org_node_id = v_home.id)
                       then 0
                       when v_site.id is not null
                            and n.id = any (rpt.place_stores(v_site.id)) then 1
                       else 9 end
                when n.id = v_home.id then 0
                when v_home.id is not null and v_home.path <@ n.path then 1
                when v_home.id is not null and n.path <@ v_home.path then 2
                else 9 end
      from core.hierarchy_node n
     where n.id = any (v_ok) and n.tenant_id = core.my_tenant() and n.archived_at is null
     order by 5, n.name;
end $function$
;
