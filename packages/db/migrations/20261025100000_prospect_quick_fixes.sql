-- migrate:up
-- Quick fixes from prospect feedback (ADR 033).
--
-- DB-2: a department carries a type (kitchen, service, housekeeping or other; file 01's
-- department_type) and core.department_of tells Home which department each flagged place
-- belongs to and in what order to show them.
-- NT-2: every wastage notifies the outlet's managers (OUTLET_MANAGER at the store's outlet),
-- never the person who recorded it.
-- INV-12: inv.expiry_list, the dated batches expired or expiring at the stores the person
-- sees stock levels at.
-- RPT-13: menu engineering over up to a year.
-- RPT-14: stock position values expired and expiring stock, and opens for all of an
-- outlet's (or hub's) stores together at its supply point.

-- ---------------------------------------------------------------------------
-- Department types (DB-2)
-- ---------------------------------------------------------------------------

alter table core.hierarchy_node add column department_type text,
  add constraint hierarchy_node_department_type check (
    department_type is null
    or (type = 'org' and kind = 'department'
        and department_type in ('kitchen', 'service', 'housekeeping', 'other')));

-- For each place (org or delivery) of the person's own company: its department, the
-- department's type and its place in the order (1 kitchen, 2 service, 3 housekeeping,
-- 4 other, 5 no department: the outlet itself), and its outlet or site. A store belongs to
-- the department it is linked to; an unlinked store to its supply point's outlet. Names
-- and order only: what the place holds is read under RLS by the caller.
create function core.department_of(p_nodes uuid[])
returns table (node_id uuid, department_id uuid, department text, department_type text,
               rank int, outlet_id uuid, outlet text)
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  with input as (
    select n.* from core.hierarchy_node n
     where n.id = any (p_nodes) and n.tenant_id = core.my_tenant()
  ), anchor as (
    select i.id as node_id,
           case when i.type = 'org' then i.id
                else coalesce(
                  (select l.org_node_id from core.node_link l
                     join core.hierarchy_node o on o.id = l.org_node_id
                    where l.delivery_node_id = i.id
                    order by (o.kind = 'department') desc, o.name limit 1),
                  (select l.org_node_id from core.node_link l
                     join core.hierarchy_node o on o.id = l.org_node_id
                    where l.delivery_node_id = core.stock_site(i.id)
                    order by nlevel(o.path), o.name limit 1)) end as org_id
      from input i
  )
  select a.node_id, d.id, d.name, t.type,
         case t.type when 'kitchen' then 1 when 'service' then 2 when 'housekeeping' then 3
                     when 'other' then 4 else 5 end,
         o.id, o.name
    from anchor a
    left join core.hierarchy_node x on x.id = a.org_id
    left join lateral (
      select h.* from core.hierarchy_node h
       where h.type = 'org' and h.kind = 'department' and h.path @> x.path
       order by nlevel(h.path) desc limit 1) d on true
    left join lateral (
      select h.* from core.hierarchy_node h
       where h.type = 'org' and h.kind in ('outlet', 'site') and h.path @> x.path
       order by nlevel(h.path) desc limit 1) o on true
    cross join lateral (
      select case when d.id is null then null else coalesce(d.department_type, 'other') end
    ) t(type)
$$;
revoke execute on function core.department_of(uuid[]) from public;
grant execute on function core.department_of(uuid[]) to app_rw;

-- ---------------------------------------------------------------------------
-- Any discard tells the GM (NT-2)
-- ---------------------------------------------------------------------------

-- One notification per wastage to the outlet managers of the store's outlet, except the
-- people in p_exclude (who recorded it, and the lead who asked for it).
create function inv.notify_wastage(p_wastage uuid, p_exclude uuid[]) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_w inv.wastage;
  v_store text;
  v_lines text;
  v_total numeric;
  v_count int;
  v_by text;
  v_group uuid;
  v_body text;
begin
  select * into v_w from inv.wastage where id = p_wastage;
  select name into v_store from core.hierarchy_node where id = v_w.delivery_node_id;
  select string_agg(format('%s %s %s, %s (₹%s)', i.name, trim_scale(l.qty), i.base_uom,
                           initcap(replace(l.reason, '_', ' ')),
                           to_char(l.value, 'FM9999999990.00')),
                    '; ' order by l.value desc, i.name),
         sum(l.value), count(*)
    into v_lines, v_total, v_count
    from inv.wastage_line l join inv.item i on i.id = l.item_id
   where l.wastage_id = p_wastage;
  select display_name into v_by from core.app_user where id = v_w.created_by;
  select id into v_group from core.security_group
   where tenant_id = v_w.tenant_id and code = 'OUTLET_MANAGER';
  v_body := case when v_count > 1
                 then format('₹%s in all: ', to_char(v_total, 'FM9999999990.00')) else '' end
            || v_lines || '. Recorded by ' || coalesce(v_by, 'someone') || '.'
            || case when v_w.adjustment_id is not null then ' Waiting for approval.' else '' end;
  perform ops.notify(v_w.tenant_id, h, 'wastage', 'Wastage at ' || v_store, v_body,
                     '/stock/wastage')
     from core.site_group_holders(v_group, v_w.delivery_node_id) h
    where v_group is not null
      and not (h = any (array_remove(coalesce(p_exclude, '{}'), null)));
end $$;
revoke execute on function inv.notify_wastage(uuid, uuid[]) from public;

do $$
declare
  v_src text := pg_get_functiondef('inv.post_wastage(uuid, jsonb, text, uuid, uuid)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_src, E'  return v_w.id;\nend',
    E'  perform inv.notify_wastage(v_w.id, array[v_me.id, p_submitter]);\n  return v_w.id;\nend');
  if v_new = v_src then
    raise exception 'inv.post_wastage changed; update this migration';
  end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Expiring and expired batches (INV-12)
-- ---------------------------------------------------------------------------

-- The dated batches with stock left at every store where the person sees stock levels:
-- expired (use-by passed) or with a use-by date (store time) within p_days of today there.
create function inv.expiry_list(p_days int)
returns table (store_id uuid, store text, item_id uuid, sku text, name text, unit text,
               batch_no text, made_at timestamptz, expires_at timestamptz, remaining numeric,
               expired boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
begin
  if p_days is null or p_days < 0 or p_days > 14 then
    raise exception 'INVALID_DAYS' using detail = 'look ahead 0 to 14 days';
  end if;
  return query
    select n.id, n.name, i.id, i.sku, i.name, i.base_uom, b.batch_no, b.made_at,
           b.expires_at, b.remaining, b.expires_at <= now()
      from core.hierarchy_node n
      cross join lateral (select coalesce(ops.tz_of(n.id), 'UTC') as tz) z
      join inv.item_node x on x.delivery_node_id = n.id and x.archived_at is null
      join inv.item i on i.id = x.item_id
      cross join lateral inv.batch_rows(x.item_id, n.id) b
     where n.id = any (core.visible_nodes('STOCK_LEVELS', 'view'))
       and n.tenant_id = core.my_tenant() and n.type = 'delivery' and n.holds_stock
       and n.archived_at is null
       and exists (select 1 from inv.stock_ledger l
                    where l.item_id = x.item_id and l.delivery_node_id = n.id
                      and l.expires_at is not null)
       and b.remaining > 0
       and (b.expires_at <= now()
            or (b.expires_at at time zone z.tz)::date <= (now() at time zone z.tz)::date + p_days)
     order by b.expires_at, i.name, n.name;
end $$;
revoke execute on function inv.expiry_list(int) from public;
grant execute on function inv.expiry_list(int) to app_rw;

-- ---------------------------------------------------------------------------
-- Menu engineering over up to a year (RPT-13)
-- ---------------------------------------------------------------------------

do $$
declare
  v_src text := pg_get_functiondef('rpt.menu_engineering(uuid, date, date)'::regprocedure);
  v_new text;
begin
  v_new := replace(replace(v_src,
    'if p_from is null or p_to is null or p_to < p_from then',
    'if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then'),
    $q$'the period ends on or after its start'$q$,
    $q$'the period ends on or after its start, a year at most'$q$);
  if v_new = v_src then
    raise exception 'rpt.menu_engineering changed; update this migration';
  end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Stock position: expiry values and all of an outlet's stores (RPT-14)
-- ---------------------------------------------------------------------------

-- The stores of an outlet's (or hub's) supply point whose cost the person answers for:
-- the stock-holding places whose site it is (the store rule of rpt.can_open).
create function rpt.site_stores(p_site uuid) returns uuid[]
language sql stable
set search_path = pg_catalog, core, rpt, extensions
as $$
  select coalesce(array_agg(s.id order by s.name), '{}')
    from core.hierarchy_node p
    join core.hierarchy_node s on s.type = 'delivery' and s.path <@ p.path
   where p.id = p_site and p.type = 'delivery'
     and s.holds_stock and s.archived_at is null
     and core.stock_site(s.id) = p_site and rpt.store_cost_access(s.id)
$$;

-- The stores a stock position place stands for: a supply point with two or more of them
-- open stands for all of them; a store for itself.
create function rpt.stock_stores(p_place uuid) returns uuid[]
language sql stable
set search_path = pg_catalog, core, rpt
as $$
  select case when n.kind in ('outlet', 'hub') and cardinality(rpt.site_stores(n.id)) >= 2
              then rpt.site_stores(n.id) else array[n.id] end
    from core.hierarchy_node n where n.id = p_place
$$;

CREATE OR REPLACE FUNCTION rpt.can_open(p_report text, p_place uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'rpt'
AS $function$
  select coalesce((
    select n.tenant_id = core.my_tenant() and n.archived_at is null
           and case p_report
             when 'outlet_flash' then
               n.type = 'org' and n.kind = 'outlet'
               and (core.can('REPORTS', 'view', n.id, null)
                    or exists (select 1 from core.node_link l where l.org_node_id = n.id
                                  and core.can('SALES', 'view', null, l.delivery_node_id)))
             when 'department' then
               n.type = 'org' and core.is_team_place(n.id)
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('ATTENDANCE', 'view', n.id, null))
             when 'cost_of_sales' then
               n.type = 'org' and n.kind in ('outlet', 'site')
               and cardinality(rpt.cost_stores(n.id)) > 0
             when 'menu_engineering' then
               n.type = 'org' and n.kind = 'outlet'
               and exists (select 1 from menu.menu_outlet mo where mo.org_node_id = n.id
                              and (core.can('REPORTS', 'view', n.id, null)
                                   or core.can('MENU', 'view', null, mo.delivery_node_id)))
             when 'stock_position' then
               n.type = 'delivery'
               and ((n.holds_stock and rpt.store_cost_access(n.id))
                    -- all of an outlet's (or hub's) stores together (RPT-14, ADR 033)
                    or (n.kind in ('outlet', 'hub') and cardinality(rpt.site_stores(n.id)) >= 2))
             when 'purchasing' then
               n.type = 'delivery' and n.holds_stock and rpt.store_cost_access(n.id)
             -- R-3 (ADR 030)
             when 'labour_cost' then
               n.type = 'org' and n.kind in ('outlet', 'site')
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('LABOUR_COST', 'view', n.id, null))
             when 'people' then
               n.type = 'org' and n.kind in ('company', 'region', 'area', 'outlet', 'site')
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('WORKERS', 'modify', n.id, null))
             when 'central_kitchen' then
               n.type = 'delivery' and n.holds_stock and rpt.is_kitchen_store(n.id)
               and rpt.store_cost_access(n.id)
             -- R-4 (ADR 031)
             when 'league' then
               n.type = 'org' and n.kind in ('company', 'region', 'area')
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('DERIVED_SALES', 'view', n.id, null))
               and (select count(*) from core.hierarchy_node o
                     where o.type = 'org' and o.kind = 'outlet' and o.archived_at is null
                       and o.path operator(extensions.<@) n.path
                       and rpt.can_open('outlet_flash', o.id)) >= 2
             else false end
      from core.hierarchy_node n where n.id = p_place), false)
$function$
;

CREATE OR REPLACE FUNCTION rpt.report_places(p_report text)
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
  v_workers uuid[];
  v_ok uuid[];
  v_dsales uuid[];
  v_sites uuid[] := '{}';
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
    -- all of an outlet's (or hub's) stores together, where two or more open (RPT-14)
    if p_report = 'stock_position' then
      select coalesce(array_agg(x.site), '{}') into v_sites
        from (select core.stock_site(s) as site from unnest(v_ok) s
               group by 1 having count(*) >= 2) x
        join core.hierarchy_node h on h.id = x.site and h.kind in ('outlet', 'hub');
      v_ok := v_ok || v_sites;
    end if;
  elsif p_report = 'people' then
    v_workers := core.visible_nodes('WORKERS', 'modify');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('company', 'region', 'area', 'outlet', 'site')
       and n.tenant_id = core.my_tenant()
       and (n.id = any (v_all) or n.id = any (v_workers));
  elsif p_report = 'central_kitchen' then
    v_menu := core.visible_nodes('MENU', 'view');
    v_orders := core.visible_nodes('PURCHASE_ORDERS', 'modify');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'delivery' and n.holds_stock and n.tenant_id = core.my_tenant()
       and rpt.is_kitchen_store(n.id)
       and (n.id = any (v_menu)
            or n.id = any (v_orders)
            or exists (select 1 from core.node_link l where l.delivery_node_id = n.id
                          and l.org_node_id = any (v_all)));
  elsif p_report = 'league' then
    v_dsales := core.visible_nodes('DERIVED_SALES', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('company', 'region', 'area')
       and n.tenant_id = core.my_tenant()
       and (n.id = any (v_all) or n.id = any (v_dsales))
       and (select count(*) from core.hierarchy_node o
             where o.type = 'org' and o.kind = 'outlet' and o.archived_at is null
               and o.path <@ n.path and rpt.can_open('outlet_flash', o.id)) >= 2;
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
    select n.id, n.code,
           case when n.id = any (v_sites)
                then coalesce(
                       (select o.name from core.node_link l
                          join core.hierarchy_node o on o.id = l.org_node_id
                         where l.delivery_node_id = n.id
                         order by nlevel(o.path), o.name limit 1), n.name) || ' – All stores'
                else n.name end,
           n.kind,
           case when n.type = 'delivery' then
                  case when exists (select 1 from core.node_link l
                                     where l.delivery_node_id = n.id and l.org_node_id = v_home.id)
                       then 0
                       when n.id = any (v_sites) and exists (
                              select 1 from core.node_link l
                               where l.delivery_node_id = n.id and l.org_node_id = v_site.id)
                       then 1
                       when v_site.id is not null
                            and n.id = any (rpt.place_stores(v_site.id)) then 1
                       else 9 end
                when n.id = v_home.id then 0
                when v_home.id is not null and v_home.path <@ n.path then 1
                when v_home.id is not null and n.path <@ v_home.path then 2
                else 9 end
      from core.hierarchy_node n
     where n.id = any (v_ok) and n.tenant_id = core.my_tenant() and n.archived_at is null
     order by 5, 3;
end $function$
;

drop function rpt.stock_summary(uuid);
drop function rpt.stock_items(uuid);

-- Internal: one store's items (no access check; rpt.stock_items checks). Usage is stock
-- that left for use: sales, production, other use, wastage and transfers out, over the
-- last 28 business days. A store that began using stock less than 28 days ago is averaged
-- over the days since its first use (at least 7, else no days on hand). Dead stock: on
-- hand, with nothing but its opening stock, or no movement at all, in the last 30 days.
-- Expired and expiring (use-by within three days, store time): what is left of each dated
-- batch, at the item's average cost at the store.
create function rpt.store_items(p_store uuid)
returns table (item_id uuid, sku text, name text, category text, unit text, on_hand numeric,
               value numeric, used_qty numeric, basis_days int, days_on_hand numeric,
               last_moved_at timestamptz, dead boolean, expired_value numeric,
               expiring_value numeric)
language plpgsql stable
set search_path = pg_catalog, core, inv, ops, rpt
as $$
declare
  v_tz text;
  v_today date;
  v_since timestamptz;
  v_first date;
  v_basis int;
begin
  v_tz := ops.tz_of(p_store);
  v_today := rpt.today(p_store);
  v_since := rpt.day_start(v_today - 27, v_tz);
  select rpt.business_date(min(l.occurred_at), v_tz) into v_first from inv.stock_ledger l
   where l.delivery_node_id = p_store
     and l.movement_type in ('sales_depletion', 'production_out', 'consumption', 'wastage',
                             'transfer_out');
  v_basis := least(28, v_today - v_first + 1);
  return query
    with u as (
      select l.item_id, sum(-l.qty) as qty from inv.stock_ledger l
       where l.delivery_node_id = p_store and l.occurred_at >= v_since
         and l.movement_type in ('sales_depletion', 'production_out', 'consumption', 'wastage',
                                 'transfer_out')
       group by l.item_id
    ), m as (
      select l.item_id, max(l.occurred_at) as at from inv.stock_ledger l
       where l.delivery_node_id = p_store and l.ref_type <> 'opening'
       group by l.item_id
    ), e as (
      select x.item_id,
             coalesce(sum(b.remaining) filter (where b.expires_at <= now()), 0) as expired,
             coalesce(sum(b.remaining) filter (
               where b.expires_at > now()
                 and (b.expires_at at time zone coalesce(v_tz, 'UTC'))::date <= v_today + 3),
               0) as expiring
        from inv.item_node x
        cross join lateral inv.batch_rows(x.item_id, p_store) b
       where x.delivery_node_id = p_store and x.archived_at is null and b.remaining > 0
         and exists (select 1 from inv.stock_ledger l
                      where l.item_id = x.item_id and l.delivery_node_id = p_store
                        and l.expires_at is not null)
       group by x.item_id
    )
    select i.id, i.sku, i.name, i.category, i.base_uom, coalesce(s.on_hand, 0),
           coalesce(s.value, 0), coalesce(u.qty, 0), v_basis,
           case when v_basis >= 7 and u.qty > 0
                then round(coalesce(s.on_hand, 0) / (u.qty / v_basis), 1) end,
           m.at,
           coalesce(s.on_hand, 0) > 0 and (m.at is null or m.at < now() - interval '30 days'),
           coalesce(round(e.expired * s.value / nullif(s.on_hand, 0), 2), 0),
           coalesce(round(e.expiring * s.value / nullif(s.on_hand, 0), 2), 0)
      from inv.item_node x
      join inv.item i on i.id = x.item_id
      left join inv.stock_level s on s.item_id = x.item_id and s.delivery_node_id = p_store
      left join u on u.item_id = x.item_id
      left join m on m.item_id = x.item_id
      left join e on e.item_id = x.item_id
     where x.delivery_node_id = p_store and x.archived_at is null
     order by coalesce(s.value, 0) desc, i.name;
end $$;
revoke execute on function rpt.store_items(uuid) from public;

-- A store's items, or every item of all the stores a supply point stands for, each with
-- its store.
create function rpt.stock_items(p_place uuid)
returns table (store_id uuid, store text, item_id uuid, sku text, name text, category text,
               unit text, on_hand numeric, value numeric, used_qty numeric, basis_days int,
               days_on_hand numeric, last_moved_at timestamptz, dead boolean,
               expired_value numeric, expiring_value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, rpt
as $$
begin
  perform rpt.require('stock_position', p_place);
  return query
    select h.id, h.name, x.*
      from unnest(rpt.stock_stores(p_place)) s(id)
      join core.hierarchy_node h on h.id = s.id
      cross join lateral rpt.store_items(s.id) x
     order by x.value desc, x.name, h.name;
end $$;

-- The figures: value now and at the end of each of the last four weeks, usage, days on
-- hand (value over average daily usage by value, each store over its own days in use),
-- dead stock, and the value expired and expiring within three days.
create function rpt.stock_summary(p_place uuid)
returns table (measure text, value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
declare
  v_stores uuid[];
  v_store uuid;
  v_today date;
  v_basis int;
  v_b int;
  v_u numeric;
  v_used numeric := 0;
  v_rate numeric := 0;
begin
  perform rpt.require('stock_position', p_place);
  v_stores := rpt.stock_stores(p_place);
  v_today := rpt.today(v_stores[1]);
  foreach v_store in array v_stores loop
    select min(i.basis_days) into v_b from rpt.store_items(v_store) i;
    select coalesce(sum(-l.qty * l.unit_cost), 0) into v_u from inv.stock_ledger l
     where l.delivery_node_id = v_store
       and l.occurred_at >= rpt.day_start(v_today - 27, ops.tz_of(v_store))
       and l.movement_type in ('sales_depletion', 'production_out', 'consumption', 'wastage',
                               'transfer_out');
    v_used := v_used + v_u;
    v_basis := least(v_basis, v_b);
    if v_b > 0 then v_rate := v_rate + v_u / v_b; end if;
  end loop;
  return query
    with items as (
      select x.* from unnest(v_stores) s(id) cross join lateral rpt.store_items(s.id) x
    )
    select 'stock_value', coalesce(sum(i.value), 0) from items i
    union all
    select 'value_' || w::text, round(s.closing_value, 2)
      from unnest(array[7, 14, 21, 28]) w
      cross join lateral rpt.stores_of(v_stores, v_today - w, v_today) s
    union all select 'used_value', round(v_used, 2)
    union all select 'basis_days', v_basis::numeric
    union all
    select 'days_on_hand',
           case when v_basis >= 7 and v_rate > 0
                then round(coalesce(sum(i.value), 0) / v_rate, 1) end
      from items i
    union all select 'dead_items', count(*) filter (where i.dead)::numeric from items i
    union all select 'dead_value', coalesce(sum(i.value) filter (where i.dead), 0) from items i
    union all select 'expired_stock_value', coalesce(sum(i.expired_value), 0) from items i
    union all select 'expiring_stock_value', coalesce(sum(i.expiring_value), 0) from items i;
end $$;
revoke execute on function rpt.stock_items(uuid), rpt.stock_summary(uuid),
  rpt.site_stores(uuid), rpt.stock_stores(uuid) from public;
grant execute on function rpt.stock_items(uuid), rpt.stock_summary(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function rpt.stock_summary(uuid);
drop function rpt.stock_items(uuid);
drop function rpt.store_items(uuid);

CREATE OR REPLACE FUNCTION rpt.stock_items(p_store uuid)
 RETURNS TABLE(item_id uuid, sku text, name text, category text, unit text, on_hand numeric, value numeric, used_qty numeric, basis_days integer, days_on_hand numeric, last_moved_at timestamp with time zone, dead boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'ops', 'rpt'
AS $function$
declare
  v_tz text;
  v_today date;
  v_since timestamptz;
  v_first date;
  v_basis int;
begin
  perform rpt.require('stock_position', p_store);
  v_tz := ops.tz_of(p_store);
  v_today := rpt.today(p_store);
  v_since := rpt.day_start(v_today - 27, v_tz);
  select rpt.business_date(min(l.occurred_at), v_tz) into v_first from inv.stock_ledger l
   where l.delivery_node_id = p_store
     and l.movement_type in ('sales_depletion', 'production_out', 'consumption', 'wastage',
                             'transfer_out');
  v_basis := least(28, v_today - v_first + 1);
  return query
    with u as (
      select l.item_id, sum(-l.qty) as qty from inv.stock_ledger l
       where l.delivery_node_id = p_store and l.occurred_at >= v_since
         and l.movement_type in ('sales_depletion', 'production_out', 'consumption', 'wastage',
                                 'transfer_out')
       group by l.item_id
    ), m as (
      select l.item_id, max(l.occurred_at) as at from inv.stock_ledger l
       where l.delivery_node_id = p_store and l.ref_type <> 'opening'
       group by l.item_id
    )
    select i.id, i.sku, i.name, i.category, i.base_uom, coalesce(s.on_hand, 0),
           coalesce(s.value, 0), coalesce(u.qty, 0), v_basis,
           case when v_basis >= 7 and u.qty > 0
                then round(coalesce(s.on_hand, 0) / (u.qty / v_basis), 1) end,
           m.at,
           coalesce(s.on_hand, 0) > 0 and (m.at is null or m.at < now() - interval '30 days')
      from inv.item_node x
      join inv.item i on i.id = x.item_id
      left join inv.stock_level s on s.item_id = x.item_id and s.delivery_node_id = p_store
      left join u on u.item_id = x.item_id
      left join m on m.item_id = x.item_id
     where x.delivery_node_id = p_store and x.archived_at is null
     order by coalesce(s.value, 0) desc, i.name;
end $function$
;

CREATE OR REPLACE FUNCTION rpt.stock_summary(p_store uuid)
 RETURNS TABLE(measure text, value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'ops', 'rpt'
AS $function$
declare
  v_tz text;
  v_today date;
  v_basis int;
  v_used numeric;
begin
  perform rpt.require('stock_position', p_store);
  v_tz := ops.tz_of(p_store);
  v_today := rpt.today(p_store);
  select min(i.basis_days) into v_basis from rpt.stock_items(p_store) i;
  select coalesce(sum(-l.qty * l.unit_cost), 0) into v_used from inv.stock_ledger l
   where l.delivery_node_id = p_store and l.occurred_at >= rpt.day_start(v_today - 27, v_tz)
     and l.movement_type in ('sales_depletion', 'production_out', 'consumption', 'wastage',
                             'transfer_out');
  return query
    with items as (select * from rpt.stock_items(p_store))
    select 'stock_value', coalesce(sum(i.value), 0) from items i
    union all
    select 'value_' || w::text, round(s.closing_value, 2)
      from unnest(array[7, 14, 21, 28]) w
      cross join lateral rpt.stores_of(array[p_store], v_today - w, v_today) s
    union all select 'used_value', round(v_used, 2)
    union all select 'basis_days', v_basis::numeric
    union all
    select 'days_on_hand',
           case when v_basis >= 7 and v_used > 0
                then round(coalesce(sum(i.value), 0) / (v_used / v_basis), 1) end
      from items i
    union all select 'dead_items', count(*) filter (where i.dead)::numeric from items i
    union all select 'dead_value', coalesce(sum(i.value) filter (where i.dead), 0) from items i;
end $function$
;

revoke execute on function rpt.stock_items(uuid), rpt.stock_summary(uuid) from public;
grant execute on function rpt.stock_items(uuid), rpt.stock_summary(uuid) to app_rw;

CREATE OR REPLACE FUNCTION rpt.can_open(p_report text, p_place uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'rpt'
AS $function$
  select coalesce((
    select n.tenant_id = core.my_tenant() and n.archived_at is null
           and case p_report
             when 'outlet_flash' then
               n.type = 'org' and n.kind = 'outlet'
               and (core.can('REPORTS', 'view', n.id, null)
                    or exists (select 1 from core.node_link l where l.org_node_id = n.id
                                  and core.can('SALES', 'view', null, l.delivery_node_id)))
             when 'department' then
               n.type = 'org' and core.is_team_place(n.id)
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('ATTENDANCE', 'view', n.id, null))
             when 'cost_of_sales' then
               n.type = 'org' and n.kind in ('outlet', 'site')
               and cardinality(rpt.cost_stores(n.id)) > 0
             when 'menu_engineering' then
               n.type = 'org' and n.kind = 'outlet'
               and exists (select 1 from menu.menu_outlet mo where mo.org_node_id = n.id
                              and (core.can('REPORTS', 'view', n.id, null)
                                   or core.can('MENU', 'view', null, mo.delivery_node_id)))
             when 'stock_position' then
               n.type = 'delivery' and n.holds_stock and rpt.store_cost_access(n.id)
             when 'purchasing' then
               n.type = 'delivery' and n.holds_stock and rpt.store_cost_access(n.id)
             -- R-3 (ADR 030)
             when 'labour_cost' then
               n.type = 'org' and n.kind in ('outlet', 'site')
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('LABOUR_COST', 'view', n.id, null))
             when 'people' then
               n.type = 'org' and n.kind in ('company', 'region', 'area', 'outlet', 'site')
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('WORKERS', 'modify', n.id, null))
             when 'central_kitchen' then
               n.type = 'delivery' and n.holds_stock and rpt.is_kitchen_store(n.id)
               and rpt.store_cost_access(n.id)
             -- R-4 (ADR 031)
             when 'league' then
               n.type = 'org' and n.kind in ('company', 'region', 'area')
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('DERIVED_SALES', 'view', n.id, null))
               and (select count(*) from core.hierarchy_node o
                     where o.type = 'org' and o.kind = 'outlet' and o.archived_at is null
                       and o.path operator(extensions.<@) n.path
                       and rpt.can_open('outlet_flash', o.id)) >= 2
             else false end
      from core.hierarchy_node n where n.id = p_place), false)
$function$
;

CREATE OR REPLACE FUNCTION rpt.report_places(p_report text)
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
  v_workers uuid[];
  v_ok uuid[];
  v_dsales uuid[];
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
  elsif p_report = 'people' then
    v_workers := core.visible_nodes('WORKERS', 'modify');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('company', 'region', 'area', 'outlet', 'site')
       and n.tenant_id = core.my_tenant()
       and (n.id = any (v_all) or n.id = any (v_workers));
  elsif p_report = 'central_kitchen' then
    v_menu := core.visible_nodes('MENU', 'view');
    v_orders := core.visible_nodes('PURCHASE_ORDERS', 'modify');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'delivery' and n.holds_stock and n.tenant_id = core.my_tenant()
       and rpt.is_kitchen_store(n.id)
       and (n.id = any (v_menu)
            or n.id = any (v_orders)
            or exists (select 1 from core.node_link l where l.delivery_node_id = n.id
                          and l.org_node_id = any (v_all)));
  elsif p_report = 'league' then
    v_dsales := core.visible_nodes('DERIVED_SALES', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('company', 'region', 'area')
       and n.tenant_id = core.my_tenant()
       and (n.id = any (v_all) or n.id = any (v_dsales))
       and (select count(*) from core.hierarchy_node o
             where o.type = 'org' and o.kind = 'outlet' and o.archived_at is null
               and o.path <@ n.path and rpt.can_open('outlet_flash', o.id)) >= 2;
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

drop function rpt.stock_stores(uuid);
drop function rpt.site_stores(uuid);

do $$
declare
  v_src text := pg_get_functiondef('rpt.menu_engineering(uuid, date, date)'::regprocedure);
begin
  execute replace(replace(v_src,
    'if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then',
    'if p_from is null or p_to is null or p_to < p_from then'),
    $q$'the period ends on or after its start, a year at most'$q$,
    $q$'the period ends on or after its start'$q$);
end $$;

drop function inv.expiry_list(int);

do $$
declare
  v_src text := pg_get_functiondef('inv.post_wastage(uuid, jsonb, text, uuid, uuid)'::regprocedure);
begin
  execute replace(v_src,
    E'  perform inv.notify_wastage(v_w.id, array[v_me.id, p_submitter]);\n', '');
end $$;
drop function inv.notify_wastage(uuid, uuid[]);

drop function core.department_of(uuid[]);
alter table core.hierarchy_node drop constraint hierarchy_node_department_type,
  drop column department_type;
