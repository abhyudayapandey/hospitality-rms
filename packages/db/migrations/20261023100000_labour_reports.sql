-- migrate:up
-- Reporting, step R-3 (docs/reporting.md, ADR 030): labour cost, the cost breakdown, the
-- People report and the central kitchen report.
--
--   * Labour cost (LABOUR_COST, totals only, decided 2 Oct). Hourly staff cost the hours
--     they worked × their rate; salaried staff cost their monthly rate × 12 ÷ 365 for every
--     day they are employed. Cost belongs to the person's home place (department or outlet)
--     and to the business day. Overtime (beyond the weekly cap) is counted in hours and
--     costed at the normal rate for now.
--   * No figure covers fewer than 3 people. Per outlet and day: a department with fewer
--     than 3 paid people goes into "Other departments"; if that group still has fewer than
--     3, the smallest shown department joins it; an outlet with fewer than 3 shows nothing.
--     Every stored row (rpt.labour_cost_day) and every figure on screen is one of these
--     rows or a sum of them over days, so no subtraction isolates fewer than 3 people.
--   * The cost breakdown: menu.cost_calc's actual cost, part by part (recipe cost of what
--     sold, expired, transit loss, other wastage, other use, count loss), then labour, and
--     the total (prime cost). menu.cost_calc is now the sum of menu.cost_parts.

-- ---------------------------------------------------------------------------
-- Labour cost per place and day
-- ---------------------------------------------------------------------------

create table rpt.labour_cost_day (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id), -- department, or the outlet
  outlet_id uuid not null references core.hierarchy_node(id),   -- the outlet or site
  business_date date not null,
  part text not null check (part in ('department', 'other', 'outlet')),
  people int not null default 0,
  hours numeric(10,2) not null default 0,
  overtime_hours numeric(10,2) not null default 0,
  hourly_cost numeric(14,2) not null default 0,
  salary_cost numeric(14,2) not null default 0,
  currency text not null default 'INR',
  unique (org_node_id, business_date, part)
);
select core.add_standard_columns('rpt.labour_cost_day');

-- Outlets and sites: the places labour cost is shown for.
create function rpt.all_labour_places() returns uuid[]
language sql stable
set search_path = pg_catalog, core
as $$ select coalesce(array_agg(id), '{}') from core.hierarchy_node
       where type = 'org' and kind in ('outlet', 'site') and archived_at is null $$;

-- Hours worked per person and business day (sessions by clock-in day, in the time zone of
-- their home place), and the part beyond the weekly cap (ROS-2's weekly_hours_cap, the week
-- from Monday): the hour that crosses the cap and those after it are overtime. One
-- definition, for labour cost and the People report.
create function rpt.worker_hours(p_workers uuid[], p_from date, p_to date)
returns table (worker_id uuid, business_date date, hours numeric, overtime_hours numeric)
language sql stable
set search_path = pg_catalog, core, hr, ops, rpt
as $$
  with w as (
    select w.id, ops.tz_of(w.org_node_id) as tz,
           (hr.roster_rules(w.tenant_id)).weekly_hours_cap as cap
      from hr.worker w where w.id = any (p_workers)
  ), worked as (
    -- from the Monday before p_from, for the weekly count
    select w.id, rpt.business_date(a.clock_in_at, w.tz) as day,
           sum(extract(epoch from a.clock_out_at - a.clock_in_at) / 3600) as hours
      from w join hr.attendance a on a.worker_id = w.id and a.clock_out_at is not null
     where a.clock_in_at >= rpt.day_start(hr.week_start(p_from), w.tz)
       and a.clock_in_at < rpt.day_start(p_to + 1, w.tz)
     group by 1, 2
  ), x as (
    select k.*, sum(k.hours) over (partition by k.id, hr.week_start(k.day) order by k.day)
             as week_hours
      from worked k
  )
  select x.id, x.day, x.hours,
         greatest(x.week_hours - w.cap, 0) - greatest(x.week_hours - x.hours - w.cap, 0)
    from x join w on w.id = x.id
   where x.day between p_from and p_to
$$;

-- Each home place's labour per business day, before the small-group rule. Never shown or
-- stored: rpt.labour_cost_rows applies the rule.
create function rpt.calc_labour_people(p_outlets uuid[], p_from date, p_to date)
returns table (tenant_id uuid, outlet_id uuid, group_id uuid, business_date date, people int,
               hours numeric, overtime_hours numeric, hourly_cost numeric, salary_cost numeric)
language sql stable
set search_path = pg_catalog, core, hr, ops, rpt, extensions
as $$
  with o as (
    select n.id, n.tenant_id, n.path from core.hierarchy_node n where n.id = any (p_outlets)
  ), w as (
    select w.id, w.org_node_id as group_id, w.joined_on, w.status, o.id as outlet_id,
           o.tenant_id, s.pay_rate, s.pay_basis
      from o
      join core.hierarchy_node h on h.type = 'org' and h.path <@ o.path
      join hr.worker w on w.org_node_id = h.id
      join hr.worker_sensitive s on s.worker_id = w.id and s.pay_rate is not null
     where core.nearest(h.id, array['outlet', 'site']) = o.id
  ), ot as (
    select h.worker_id as id, h.business_date as day, h.hours, h.overtime_hours as overtime
      from rpt.worker_hours(array(select w.id from w), p_from, p_to) h
  ), per as (
    select w.tenant_id, w.outlet_id, w.group_id, d::date as day, w.id,
           coalesce(ot.hours, 0) as hours, coalesce(ot.overtime, 0) as overtime,
           case when w.pay_basis = 'hourly' then coalesce(ot.hours, 0) * w.pay_rate else 0 end
             as hourly_cost,
           case when w.pay_basis = 'monthly' and w.status = 'active'
                     and (w.joined_on is null or w.joined_on <= d::date)
                then w.pay_rate * 12 / 365 else 0 end as salary_cost
      from w
      cross join generate_series(p_from, p_to, interval '1 day') d
      left join ot on ot.id = w.id and ot.day = d::date
  )
  select p.tenant_id, p.outlet_id, p.group_id, p.day,
         count(*) filter (where p.hourly_cost + p.salary_cost > 0)::int,
         sum(p.hours), sum(p.overtime), sum(p.hourly_cost), sum(p.salary_cost)
    from per p
   group by p.tenant_id, p.outlet_id, p.group_id, p.day
$$;

-- The rows that may be shown: the small-group rule applied per outlet and day.
--   department  a home place with 3 or more paid people (the outlet itself for staff whose
--               home is the outlet)
--   other       every smaller place together, at the outlet; when that is fewer than 3
--               people, the smallest department joins it (one is enough: it has 3 or more)
--   outlet      the whole outlet; nothing at all when it has fewer than 3 paid people
create function rpt.labour_cost_rows(p_outlets uuid[], p_from date, p_to date)
returns table (tenant_id uuid, org_node_id uuid, outlet_id uuid, business_date date,
               part text, people int, hours numeric, overtime_hours numeric,
               hourly_cost numeric, salary_cost numeric)
language sql stable
set search_path = pg_catalog, rpt
as $$
  with c as (
    select * from rpt.calc_labour_people(p_outlets, p_from, p_to) where people > 0
  ), s as (
    select c.*,
           sum(case when c.people < 3 then c.people else 0 end) over w as small,
           sum(c.people) over w as total,
           row_number() over (partition by c.outlet_id, c.business_date
                              order by (c.people < 3), c.people,
                                       c.hourly_cost + c.salary_cost, c.group_id) as rk
      from c
    window w as (partition by c.outlet_id, c.business_date)
  ), m as (
    select s.*, (s.people < 3 or (s.small between 1 and 2 and s.rk = 1)) as folded
      from s where s.total >= 3
  )
  select m.tenant_id, m.group_id, m.outlet_id, m.business_date, 'department', m.people,
         round(m.hours, 2), round(m.overtime_hours, 2), round(m.hourly_cost, 2),
         round(m.salary_cost, 2)
    from m where not m.folded
  union all
  select m.tenant_id, m.outlet_id, m.outlet_id, m.business_date, 'other', sum(m.people)::int,
         round(sum(m.hours), 2), round(sum(m.overtime_hours), 2), round(sum(m.hourly_cost), 2),
         round(sum(m.salary_cost), 2)
    from m where m.folded
   group by m.tenant_id, m.outlet_id, m.business_date
  union all
  select m.tenant_id, m.outlet_id, m.outlet_id, m.business_date, 'outlet', sum(m.people)::int,
         round(sum(m.hours), 2), round(sum(m.overtime_hours), 2), round(sum(m.hourly_cost), 2),
         round(sum(m.salary_cost), 2)
    from m
   group by m.tenant_id, m.outlet_id, m.business_date
$$;

-- The nightly part (rpt.rebuild calls it): rows that changed, and rows the rule no longer
-- shows set to zero (no deletes; a zero row shows nothing).
create function rpt.rebuild_labour_cost(p_from date, p_to date) returns int
language plpgsql security definer
set search_path = pg_catalog, core, rpt
as $$
declare
  v_n int;
begin
  -- one statement: the inserts and updates touch different rows (in r, or not in r)
  with r as (
    select * from rpt.labour_cost_rows(rpt.all_labour_places(), p_from, p_to)
  ), ins as (
    insert into rpt.labour_cost_day as t (tenant_id, org_node_id, outlet_id, business_date,
           part, people, hours, overtime_hours, hourly_cost, salary_cost)
    select r.tenant_id, r.org_node_id, r.outlet_id, r.business_date, r.part, r.people,
           r.hours, r.overtime_hours, r.hourly_cost, r.salary_cost
      from r
    on conflict (org_node_id, business_date, part) do update
       set outlet_id = excluded.outlet_id, people = excluded.people, hours = excluded.hours,
           overtime_hours = excluded.overtime_hours, hourly_cost = excluded.hourly_cost,
           salary_cost = excluded.salary_cost
     where (t.outlet_id, t.people, t.hours, t.overtime_hours, t.hourly_cost, t.salary_cost)
           is distinct from
           (excluded.outlet_id, excluded.people, excluded.hours, excluded.overtime_hours,
            excluded.hourly_cost, excluded.salary_cost)
    returning 1
  ), zeroed as (
    update rpt.labour_cost_day t
       set people = 0, hours = 0, overtime_hours = 0, hourly_cost = 0, salary_cost = 0
     where t.business_date between p_from and p_to
       and (t.people, t.hours, t.overtime_hours, t.hourly_cost, t.salary_cost)
           <> (0, 0, 0, 0, 0)
       and not exists (select 1 from r
                        where r.org_node_id = t.org_node_id
                          and r.business_date = t.business_date and r.part = t.part)
    returning 1
  )
  select (select count(*) from ins) + (select count(*) from zeroed) into v_n;
  return v_n;
end $$;

-- An outlet's rows over a period: stored days, and today and yesterday worked out live.
create function rpt.labour_cost_of(p_outlet uuid, p_from date, p_to date)
returns table (org_node_id uuid, part text, business_date date, people int, hours numeric,
               overtime_hours numeric, hourly_cost numeric, salary_cost numeric)
language sql stable
set search_path = pg_catalog, rpt
as $$
  select r.org_node_id, r.part, r.business_date, r.people, r.hours, r.overtime_hours,
         r.hourly_cost, r.salary_cost
    from rpt.labour_cost_rows(array[p_outlet], greatest(p_from, rpt.today(p_outlet) - 1), p_to) r
   where p_to >= rpt.today(p_outlet) - 1
  union all
  select l.org_node_id, l.part, l.business_date, l.people, l.hours, l.overtime_hours,
         l.hourly_cost, l.salary_cost
    from rpt.labour_cost_day l
   where l.outlet_id = p_outlet and l.people > 0
     and l.business_date between p_from and least(p_to, rpt.today(p_outlet) - 2)
$$;

-- ---------------------------------------------------------------------------
-- The cost breakdown: menu.cost_calc's actual cost, part by part
-- ---------------------------------------------------------------------------

-- Per menu (Food, Bar) at an outlet over the given stores: sales, and the cost of what sold
-- by recipe (sales depletion) plus each kind of loss at those stores, shared between the
-- menus by each store's sales. Unrounded; callers round. Actual cost = the sum of the parts.
create function menu.cost_parts(p_outlet uuid, p_stores uuid[], p_from date, p_to date)
returns table (menu text, revenue numeric, recipe_cost numeric, expired numeric,
               transit_loss numeric, wastage_other numeric, other_use numeric,
               count_loss numeric)
language plpgsql stable
set search_path = pg_catalog, core, inv, menu
as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_outlet), 'UTC');
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  return query
    with stores as (
      select distinct mo.delivery_node_id as store from menu.menu_outlet mo
       where mo.org_node_id = p_outlet and mo.delivery_node_id = any (p_stores)
    ), sold as (
      select mi.menu, sl.delivery_node_id as store, sum(sl.qty * sl.price) as revenue
        from menu.sales_day sd
        join menu.sales_line sl on sl.sales_day_id = sd.id
        join menu.menu_item mi on mi.id = sl.menu_item_id
       where sd.org_node_id = p_outlet and sd.business_date between p_from and p_to
         and sl.delivery_node_id in (select store from stores)
       group by mi.menu, sl.delivery_node_id
    ), share as (
      select s.menu, s.store, s.revenue,
             s.revenue / nullif(sum(s.revenue) over (partition by s.store), 0) as share
        from sold s
    ), depleted as (
      select l.delivery_node_id as store, sum(-l.qty * l.unit_cost) as cost
        from inv.stock_ledger l
        join menu.sales_day sd on sd.id = l.ref_id and l.ref_type = 'sales_day'
       where sd.org_node_id = p_outlet and sd.business_date between p_from and p_to
         and l.delivery_node_id in (select store from stores)
       group by l.delivery_node_id
    ), losses as (
      select l.delivery_node_id as store,
             sum(-l.qty * l.unit_cost) filter (where l.movement_type = 'wastage'
                                                 and l.reason = 'expired') as expired,
             sum(-l.qty * l.unit_cost) filter (where l.movement_type = 'wastage'
                                                 and l.reason = 'transit_loss') as transit_loss,
             sum(-l.qty * l.unit_cost) filter (where l.movement_type = 'wastage'
                                                 and l.reason is distinct from 'expired'
                                                 and l.reason is distinct from 'transit_loss')
               as wastage_other,
             sum(-l.qty * l.unit_cost) filter (where l.movement_type = 'consumption') as other_use,
             sum(-l.qty * l.unit_cost) filter (where l.movement_type = 'count_adjust') as count_loss
        from inv.stock_ledger l
       where l.delivery_node_id in (select store from stores)
         and l.occurred_at >= v_start and l.occurred_at < v_end
       group by l.delivery_node_id
    )
    select s.menu, sum(s.revenue),
           sum(coalesce(d.cost, 0) * s.share),
           sum(coalesce(lo.expired, 0) * s.share),
           sum(coalesce(lo.transit_loss, 0) * s.share),
           sum(coalesce(lo.wastage_other, 0) * s.share),
           sum(coalesce(lo.other_use, 0) * s.share),
           sum(coalesce(lo.count_loss, 0) * s.share)
      from share s
      left join depleted d on d.store = s.store
      left join losses lo on lo.store = s.store
     group by s.menu
     order by s.menu;
end $$;
revoke execute on function menu.cost_parts(uuid, uuid[], date, date) from public;

-- The same figures as before, from the parts (one definition, ADR 028).
create or replace function menu.cost_calc(p_outlet uuid, p_stores uuid[], p_from date, p_to date)
returns table (menu text, revenue numeric, theoretical_cost numeric, theoretical_pct numeric,
               actual_cost numeric, actual_pct numeric)
language sql stable
set search_path = pg_catalog, menu
as $$
  select p.menu, round(p.revenue, 2), round(p.recipe_cost, 2),
         round(p.recipe_cost / nullif(p.revenue, 0) * 100, 1),
         round(p.recipe_cost + p.expired + p.transit_loss + p.wastage_other + p.other_use
               + p.count_loss, 2),
         round((p.recipe_cost + p.expired + p.transit_loss + p.wastage_other + p.other_use
                + p.count_loss) / nullif(p.revenue, 0) * 100, 1)
    from menu.cost_parts(p_outlet, p_stores, p_from, p_to) p
   order by p.menu
$$;

-- ---------------------------------------------------------------------------
-- Who opens what (rule 2: core.can only)
-- ---------------------------------------------------------------------------

-- A central kitchen's store: linked to a site (the kitchen) or one of its departments.
create function rpt.is_kitchen_store(p_store uuid) returns boolean
language sql stable
set search_path = pg_catalog, core, extensions
as $$
  select exists (select 1 from core.node_link l
                   join core.hierarchy_node o on o.id = l.org_node_id
                   join core.hierarchy_node site on site.type = 'org' and site.kind = 'site'
                                                and o.path <@ site.path
                  where l.delivery_node_id = p_store)
$$;

-- Labour cost at an outlet or site (LABOUR_COST or REPORTS there); the People report where
-- the person keeps worker records (WORKERS modify: HR) or REPORTS; the central kitchen
-- report at a kitchen's store, for its cost people (the R-2 store rule).
create or replace function rpt.can_open(p_report text, p_place uuid)
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
             else false end
      from core.hierarchy_node n where n.id = p_place), false)
$function$;

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
  v_workers uuid[];
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

create or replace function rpt.my_reports()
 RETURNS TABLE(report text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr'
AS $function$
  select v.r from (values (1, 'outlet_flash'), (2, 'department'), (3, 'cost_of_sales'),
                          (4, 'menu_engineering'), (5, 'stock_position'), (6, 'purchasing'),
                          (7, 'central_kitchen'), (8, 'people'), (9, 'my_week')) v(o, r)
   where case v.r
           when 'my_week' then exists (select 1 from hr.worker w
                                        where w.owner_user_id = core.current_user_id()
                                          and w.status = 'active')
           when 'cost_of_sales' then core.module_on(core.my_tenant(), 'menu_sales')
                                     and exists (select 1 from rpt.report_places(v.r))
           when 'menu_engineering' then core.module_on(core.my_tenant(), 'menu_sales')
                                        and exists (select 1 from rpt.report_places(v.r))
           else exists (select 1 from rpt.report_places(v.r)) end
   order by v.o
$function$;

-- ---------------------------------------------------------------------------
-- Labour cost and the cost breakdown, for the screens
-- ---------------------------------------------------------------------------

-- Labour cost at an outlet or site over a period, row by row as the small-group rule
-- allows: each department shown, "Other departments", and the whole place. A department is
-- summed over the days it was shown; on the other days it is part of "Other departments".
create function rpt.labour_cost(p_place uuid, p_from date, p_to date)
returns table (org_node_id uuid, name text, part text, days int, people int, hours numeric,
               overtime_hours numeric, hourly_cost numeric, salary_cost numeric,
               cost numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, rpt
as $$
begin
  perform rpt.require('labour_cost', p_place);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    raise exception 'INVALID_DATE' using detail = 'a period of at most 93 days';
  end if;
  return query
    select l.org_node_id, n.name, l.part, count(*)::int, max(l.people), sum(l.hours),
           sum(l.overtime_hours), sum(l.hourly_cost), sum(l.salary_cost),
           sum(l.hourly_cost + l.salary_cost)
      from rpt.labour_cost_of(p_place, p_from, p_to) l
      join core.hierarchy_node n on n.id = l.org_node_id
     group by l.org_node_id, n.name, l.part
     order by case l.part when 'outlet' then 0 when 'department' then 1 else 2 end,
              sum(l.hourly_cost + l.salary_cost) desc, n.name;
end $$;

-- Where the money went at an outlet or site over a period (Cost of sales): each part of
-- the actual cost of what sold, then labour where the person sees labour cost, and the
-- total (prime cost), each in ₹ and as a share of sales. Labour is empty (null) when the
-- place had fewer than 3 paid people.
create function rpt.cost_breakdown(p_place uuid, p_from date, p_to date)
returns table (part text, value numeric, pct numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, menu, rpt
as $$
declare
  v_stores uuid[];
  v_labour boolean;
begin
  perform rpt.require('cost_of_sales', p_place);
  perform core.require_module('menu_sales');
  v_stores := rpt.cost_stores(p_place);
  v_labour := rpt.can_open('labour_cost', p_place);
  return query
    with c as (
      select * from menu.cost_parts(p_place, v_stores, p_from, p_to)
    ), s as (
      select coalesce(sum(c.revenue), 0) as sales,
             coalesce(sum(c.recipe_cost + c.expired + c.transit_loss + c.wastage_other
                          + c.other_use + c.count_loss), 0) as materials
        from c
    ), l as (
      select sum(x.hourly_cost) as hourly, sum(x.salary_cost) as salary
        from rpt.labour_cost_of(p_place, p_from, p_to) x
       where v_labour and x.part = 'outlet'
    ), parts(o, part, value) as (
      values
        (1, 'food_recipe', (select coalesce(sum(c.recipe_cost), 0) from c where c.menu = 'Food')),
        (2, 'bar_recipe', (select coalesce(sum(c.recipe_cost), 0) from c where c.menu = 'Bar')),
        (3, 'expired', (select coalesce(sum(c.expired), 0) from c)),
        (4, 'transit_loss', (select coalesce(sum(c.transit_loss), 0) from c)),
        (5, 'wastage_other', (select coalesce(sum(c.wastage_other), 0) from c)),
        (6, 'other_use', (select coalesce(sum(c.other_use), 0) from c)),
        (7, 'count_loss', (select coalesce(sum(c.count_loss), 0) from c)),
        (8, 'materials', (select s.materials from s)),
        (9, 'labour_hourly', (select l.hourly from l)),
        (10, 'labour_salary', (select l.salary from l)),
        (11, 'labour', (select l.hourly + l.salary from l)),
        (12, 'prime', (select s.materials + l.hourly + l.salary from s, l))
    )
    select p.part, round(p.value, 2), round(p.value * 100 / nullif((select s.sales from s), 0), 1)
      from parts p
     where p.o <= 8 or v_labour
     order by p.o;
end $$;

-- Outlet today (the daily flash, ADR 023) gains sales per labour hour, the cost breakdown
-- and, for people who see labour cost, labour cost, labour % and prime cost (R-3).
create or replace function rpt.outlet_flash(p_outlet uuid, p_day date)
 RETURNS TABLE(measure text, value numeric, last_week numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'menu', 'rpt'
AS $function$
declare
  v_today date;
  v_places uuid[];
  v_stores uuid[];
  v_labour boolean;
begin
  perform rpt.require('outlet_flash', p_outlet);
  v_today := rpt.today(p_outlet);
  if p_day is null or p_day > v_today then
    raise exception 'INVALID_DATE' using detail = 'today or an earlier day';
  end if;
  v_places := rpt.outlet_team_places(p_outlet);
  v_stores := rpt.outlet_stores(p_outlet);
  v_labour := rpt.can_open('labour_cost', p_outlet);
  return query
    with d(day, k) as (values (p_day, 'now'), (p_day - 7, 'then')),
    sales as (
      select d.k, s.menu, s.sales, s.theoretical_cost
        from d cross join lateral rpt.sales_of(p_outlet, d.day) s
    ), sm as (
      select d.k, m.measure, m.value from d cross join lateral (
        select 'sales' as measure, coalesce(sum(s.sales), 0) as value from sales s where s.k = d.k
        union all
        select 'food_sales', coalesce(sum(s.sales), 0) from sales s where s.k = d.k and s.menu = 'Food'
        union all
        select 'bar_sales', coalesce(sum(s.sales), 0) from sales s where s.k = d.k and s.menu = 'Bar'
        union all
        select 'food_cost_pct', round(sum(s.theoretical_cost) * 100 / nullif(sum(s.sales), 0), 1)
          from sales s where s.k = d.k and s.menu = 'Food'
        union all
        select 'bar_cost_pct', round(sum(s.theoretical_cost) * 100 / nullif(sum(s.sales), 0), 1)
          from sales s where s.k = d.k and s.menu = 'Bar'
      ) m
    ), tm as (
      select d.k, m.measure, m.value
        from d cross join lateral rpt.team_measures(v_places, v_stores, d.day, v_today) m
    ), cp as (
      select d.k, p.* from d cross join lateral menu.cost_parts(p_outlet, v_stores, d.day, d.day) p
    ), cm as (
      select d.k, m.measure, round(coalesce(m.value, 0), 2) as value from d cross join lateral (
        select 'cost_food_recipe' as measure,
               sum(c.recipe_cost) filter (where c.menu = 'Food') as value from cp c where c.k = d.k
        union all
        select 'cost_bar_recipe', sum(c.recipe_cost) filter (where c.menu = 'Bar') from cp c where c.k = d.k
        union all
        select 'cost_expired', sum(c.expired) from cp c where c.k = d.k
        union all
        select 'cost_transit_loss', sum(c.transit_loss) from cp c where c.k = d.k
        union all
        select 'cost_wastage_other', sum(c.wastage_other) from cp c where c.k = d.k
        union all
        select 'cost_other_use', sum(c.other_use) from cp c where c.k = d.k
        union all
        select 'cost_count_loss', sum(c.count_loss) from cp c where c.k = d.k
        union all
        select 'cost_materials', sum(c.recipe_cost + c.expired + c.transit_loss + c.wastage_other
                                     + c.other_use + c.count_loss) from cp c where c.k = d.k
      ) m
    ), lb as (
      -- labour of the whole outlet that day; none when it had fewer than 3 paid people
      select d.k, sum(l.hourly_cost) as hourly, sum(l.salary_cost) as salary
        from d cross join lateral rpt.labour_cost_of(p_outlet, d.day, d.day) l
       where v_labour and l.part = 'outlet'
       group by d.k
    ), lm as (
      select d.k, m.measure, m.value
        from d left join lb on lb.k = d.k
        cross join lateral (values ('labour_hourly', lb.hourly), ('labour_salary', lb.salary),
                                   ('labour_cost', lb.hourly + lb.salary)) m(measure, value)
       where v_labour
    ), allm as (
      select * from sm union all select * from tm union all select * from cm union all select * from lm
      union all
      select s.k, 'splh', round(s.value / nullif(w.value, 0), 0)
        from sm s join tm w on w.k = s.k and w.measure = 'worked_hours' where s.measure = 'sales'
      union all
      select s.k, 'labour_pct', round(l.value * 100 / nullif(s.value, 0), 1)
        from sm s join lm l on l.k = s.k and l.measure = 'labour_cost' where s.measure = 'sales'
      union all
      select c.k, 'prime_cost', c.value + l.value
        from cm c join lm l on l.k = c.k and l.measure = 'labour_cost'
       where c.measure = 'cost_materials'
      union all
      select c.k, 'prime_cost_pct', round((c.value + l.value) * 100 / nullif(s.value, 0), 1)
        from cm c join lm l on l.k = c.k and l.measure = 'labour_cost'
        join sm s on s.k = c.k and s.measure = 'sales'
       where c.measure = 'cost_materials'
      union all
      select w.k, 'wastage_pct',
             round(w.value * 100 / nullif((select s.value from sm s
                                            where s.k = w.k and s.measure = 'sales'), 0), 1)
        from tm w where w.measure = 'wastage'
    )
    select a.measure, a.value, b.value
      from allm a left join allm b on b.measure = a.measure and b.k = 'then'
     where a.k = 'now';
end $function$;

-- Department today gains the department's labour cost, for people who see labour cost
-- there; empty on a day it had fewer than 3 paid people (it is in "Other departments").
create or replace function rpt.department_day(p_place uuid, p_day date)
 RETURNS TABLE(measure text, value numeric, last_week numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'rpt'
AS $function$
declare
  v_today date;
  v_stores uuid[];
  v_outlet uuid;
  v_labour boolean;
begin
  perform rpt.require('department', p_place);
  v_today := rpt.today(p_place);
  if p_day is null or p_day > v_today then
    raise exception 'INVALID_DATE' using detail = 'today or an earlier day';
  end if;
  select coalesce(array_agg(s), '{}') into v_stores from unnest(rpt.team_stores(p_place)) s
   where core.can('REPORTS', 'view', p_place, null)
      or core.can('STOCK_LEVELS', 'view', null, s);
  -- the department's own labour cost, when it had 3 or more paid people that day (R-3)
  v_outlet := core.nearest(p_place, array['outlet', 'site']);
  v_labour := v_outlet is not null
              and (core.can('REPORTS', 'view', p_place, null)
                   or core.can('LABOUR_COST', 'view', p_place, null));
  return query
    select a.measure, a.value, b.value
      from rpt.team_measures(array[p_place], v_stores, p_day, v_today) a
      left join rpt.team_measures(array[p_place], v_stores, p_day - 7, v_today) b
        on b.measure = a.measure
    union all
    select 'labour_cost',
           (select sum(l.hourly_cost + l.salary_cost) from rpt.labour_cost_of(v_outlet, p_day, p_day) l
             where l.part = 'department' and l.org_node_id = p_place),
           (select sum(l.hourly_cost + l.salary_cost)
              from rpt.labour_cost_of(v_outlet, p_day - 7, p_day - 7) l
             where l.part = 'department' and l.org_node_id = p_place)
     where v_labour;
end $function$;

-- The nightly rebuild also stores labour cost (the last 35 days, like the other tables).
do $$
declare
  v_src text := pg_get_functiondef('rpt.rebuild(date, date)'::regprocedure);
  v_old text := E'  get diagnostics v_c = row_count;\n  return v_n + v_c;\nend';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'rpt.rebuild changed; update this migration';
  end if;
  execute replace(v_src, v_old,
    E'  get diagnostics v_c = row_count;\n  -- labour cost (R-3, ADR 030)\n'
    || E'  return v_n + v_c + rpt.rebuild_labour_cost(p_from, p_to);\nend');
end $$;

-- ---------------------------------------------------------------------------
-- Test customers only (ADR 017, file 35): past attendance at the time it happened
-- ---------------------------------------------------------------------------

-- Records a past session (in and out) for the person running it, as a clock-in would
-- have. Test customers only; both times in the past, out after in, no overlap with the
-- person's other sessions. A second load with the same key changes nothing.
create function hr.record_test_attendance(p_in timestamptz, p_out timestamptz, p_key text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr, inv
as $$
declare
  v_w hr.worker := hr.my_worker();
  v_id uuid;
begin
  perform inv.require_test_time(p_in);
  perform inv.require_test_time(p_out);
  if p_out <= p_in or p_out - p_in > interval '16 hours' then
    raise exception 'INVALID_DATE' using detail = 'clock-out after clock-in, within 16 hours';
  end if;
  if p_key is null or p_key = '' then
    raise exception 'INVALID_KEY';
  end if;
  select a.id into v_id from hr.attendance a where a.worker_id = v_w.id and a.in_key = p_key;
  if found then
    return v_id;
  end if;
  if exists (select 1 from hr.attendance a
              where a.worker_id = v_w.id
                and tstzrange(a.clock_in_at, coalesce(a.clock_out_at, 'infinity'))
                    && tstzrange(p_in, p_out)) then
    raise exception 'INVALID_DATE' using detail = 'overlaps another session';
  end if;
  insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, clock_in_at,
                             clock_out_at, in_source, out_source, in_key, out_key,
                             out_received_at)
  values (v_w.tenant_id, v_w.id, v_w.owner_user_id, v_w.org_node_id, p_in, p_out, 'online',
          'online', p_key, p_key || ':out', p_out)
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function hr.record_test_attendance(timestamptz, timestamptz, text) from public;
grant execute on function hr.record_test_attendance(timestamptz, timestamptz, text)
  to platform_loader;

-- ---------------------------------------------------------------------------
-- The People report (HR): WORKERS modify at the place, or REPORTS
-- ---------------------------------------------------------------------------

-- Everyone whose home place is the place or under it, active or not.
create function rpt.place_workers(p_place uuid) returns uuid[]
language sql stable
set search_path = pg_catalog, core, hr, extensions
as $$
  select coalesce(array_agg(w.id), '{}')
    from core.hierarchy_node p
    join core.hierarchy_node h on h.type = 'org' and h.path <@ p.path
    join hr.worker w on w.org_node_id = h.id
   where p.id = p_place
$$;

create function rpt.check_period(p_from date, p_to date) returns void
language plpgsql immutable
set search_path = pg_catalog
as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    raise exception 'INVALID_DATE' using detail = 'a period of at most 93 days';
  end if;
end $$;

-- Per person over a period: shifts that started, late and no-show flags not dismissed,
-- hours and overtime, and approved leave days in the period (calendar days, ADR 008).
create function rpt.people_rows(p_workers uuid[], p_from date, p_to date)
returns table (worker_id uuid, shifts int, late int, no_shows int, hours numeric,
               overtime_hours numeric, leave_days numeric)
language sql stable
set search_path = pg_catalog, core, hr, rpt
as $$
  select w.id,
         (select count(*)::int from hr.shift_assignment a
            join hr.shift s on s.id = a.shift_id and s.status = 'published'
           where a.worker_id = w.id and a.status = 'assigned'
             and s.local_date between p_from and p_to and s.start_at < now()),
         (select count(*)::int from hr.attendance_exception x
           where x.worker_id = w.id and x.kind = 'late' and x.status <> 'dismissed'
             and x.local_date between p_from and p_to),
         (select count(*)::int from hr.attendance_exception x
           where x.worker_id = w.id and x.kind = 'no_show' and x.status <> 'dismissed'
             and x.local_date between p_from and p_to),
         coalesce(h.hours, 0), coalesce(h.overtime, 0),
         coalesce((select sum(least(l.to_date, p_to) - greatest(l.from_date, p_from) + 1)::numeric
                     from hr.leave_request l
                    where l.worker_id = w.id and l.status = 'approved'
                      and l.from_date <= p_to and l.to_date >= p_from), 0)
    from hr.worker w
    left join (select x.worker_id, sum(x.hours) as hours, sum(x.overtime_hours) as overtime
                 from rpt.worker_hours(p_workers, p_from, p_to) x group by x.worker_id) h
           on h.worker_id = w.id
   where w.id = any (p_workers)
$$;

-- Unused paid leave this year per person and leave type, and a day's pay (salaried:
-- monthly rate × 12 ÷ 365; hourly: 8 hours), for the liability.
create function rpt.leave_rows(p_workers uuid[], p_year int)
returns table (worker_id uuid, leave_type_id uuid, remaining numeric, day_rate numeric)
language sql stable
set search_path = pg_catalog, hr
as $$
  select b.worker_id, b.leave_type_id, greatest(b.entitled_days - b.used_days, 0),
         case s.pay_basis when 'monthly' then s.pay_rate * 12 / 365
                          when 'hourly' then s.pay_rate * 8 end
    from hr.leave_balance b
    join hr.worker w on w.id = b.worker_id and w.status = 'active'
    join hr.leave_type t on t.id = b.leave_type_id and t.annual_days is not null
    left join hr.worker_sensitive s on s.worker_id = b.worker_id
   where b.worker_id = any (p_workers) and b.year = p_year
$$;

-- The place's figures. Leave liability in ₹ only for people who see labour cost there,
-- and only for leave types that 3 or more people hold (decided 2 Oct).
create function rpt.people_summary(p_place uuid, p_from date, p_to date)
returns table (measure text, value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, rpt
as $$
declare
  v_workers uuid[];
  v_money boolean;
begin
  perform rpt.require('people', p_place);
  perform rpt.check_period(p_from, p_to);
  v_workers := rpt.place_workers(p_place);
  v_money := core.can('REPORTS', 'view', p_place, null)
             or core.can('LABOUR_COST', 'view', p_place, null);
  return query
    with w as (
      select * from hr.worker x where x.id = any (v_workers)
    ), r as (
      select * from rpt.people_rows(v_workers, p_from, p_to)
    ), b as (
      select * from rpt.leave_rows(v_workers, extract(year from p_to)::int)
    )
    select m.measure, m.value from (values
      ('headcount', (select count(*) from w where w.status = 'active')::numeric),
      ('joiners', (select count(*) from w where w.joined_on between p_from and p_to)::numeric),
      ('inactive', (select count(*) from w where w.status = 'inactive')::numeric),
      ('shifts', (select coalesce(sum(r.shifts), 0) from r)::numeric),
      ('late', (select coalesce(sum(r.late), 0) from r)::numeric),
      ('no_shows', (select coalesce(sum(r.no_shows), 0) from r)::numeric),
      ('on_time_pct', (select round((sum(r.shifts) - sum(r.late) - sum(r.no_shows)) * 100.0
                                    / nullif(sum(r.shifts), 0), 1) from r)),
      ('worked_hours', (select round(coalesce(sum(r.hours), 0), 2) from r)),
      ('overtime_hours', (select round(coalesce(sum(r.overtime_hours), 0), 2) from r)),
      ('leave_days', (select coalesce(sum(r.leave_days), 0) from r)),
      ('swaps', (select count(*) from hr.shift_swap x
                  where x.from_worker_id = any (v_workers) and x.status = 'approved'
                    and x.updated_at >= p_from and x.updated_at < p_to + 1)::numeric),
      ('leave_balance_days', (select coalesce(sum(b.remaining), 0) from b)),
      -- the sum of the leave types people_leave shows (each held by 3 or more), so no
      -- subtraction gives a smaller group's figure
      ('leave_liability', case when v_money then
                             (select round(sum(t.money), 2) from (
                                select sum(b.remaining * b.day_rate) as money
                                  from b group by b.leave_type_id
                                having count(distinct b.worker_id)
                                         filter (where b.remaining > 0
                                                   and b.day_rate is not null) >= 3) t) end)
    ) m(measure, value);
end $$;

-- The same per home place (department, or the outlet for its own staff).
create function rpt.people_departments(p_place uuid, p_from date, p_to date)
returns table (org_node_id uuid, name text, headcount int, shifts int, late int,
               no_shows int, on_time_pct numeric, hours numeric, overtime_hours numeric,
               leave_days numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, rpt
as $$
declare
  v_workers uuid[];
begin
  perform rpt.require('people', p_place);
  perform rpt.check_period(p_from, p_to);
  v_workers := rpt.place_workers(p_place);
  return query
    select n.id, n.name, count(*) filter (where w.status = 'active')::int,
           sum(r.shifts)::int, sum(r.late)::int, sum(r.no_shows)::int,
           round((sum(r.shifts) - sum(r.late) - sum(r.no_shows)) * 100.0
                 / nullif(sum(r.shifts), 0), 1),
           round(sum(r.hours), 2), round(sum(r.overtime_hours), 2), sum(r.leave_days)
      from rpt.people_rows(v_workers, p_from, p_to) r
      join hr.worker w on w.id = r.worker_id
      join core.hierarchy_node n on n.id = w.org_node_id
     group by n.id, n.name
     order by n.name;
end $$;

-- Who was late or did not turn up, by name: only for people who keep the records (WORKERS
-- modify). REPORTS shows totals, never a single person (ADR 023), so the owner gets none.
create function rpt.people_flags(p_place uuid, p_from date, p_to date)
returns table (user_id uuid, name text, job_title text, place text, late int, no_shows int)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, rpt
as $$
begin
  perform rpt.require('people', p_place);
  perform rpt.check_period(p_from, p_to);
  if not core.can('WORKERS', 'modify', p_place, null) then
    return;
  end if;
  return query
    select u.id, u.display_name, coalesce(j.name, w.role_code), n.name, r.late, r.no_shows
      from rpt.people_rows(rpt.place_workers(p_place), p_from, p_to) r
      join hr.worker w on w.id = r.worker_id
      join core.app_user u on u.id = w.owner_user_id
      join core.hierarchy_node n on n.id = w.org_node_id
      left join hr.job_role j on j.tenant_id = w.tenant_id and j.code = w.role_code
     where r.late + r.no_shows > 0
     order by r.no_shows + r.late desc, u.display_name;
end $$;

-- Leave by type: taken in the period, unused this year, and the liability (as above).
create function rpt.people_leave(p_place uuid, p_from date, p_to date)
returns table (leave_type text, taken_days numeric, balance_days numeric, liability numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, rpt
as $$
declare
  v_workers uuid[];
  v_money boolean;
begin
  perform rpt.require('people', p_place);
  perform rpt.check_period(p_from, p_to);
  v_workers := rpt.place_workers(p_place);
  v_money := core.can('REPORTS', 'view', p_place, null)
             or core.can('LABOUR_COST', 'view', p_place, null);
  return query
    with taken as (
      select l.leave_type_id,
             sum(least(l.to_date, p_to) - greatest(l.from_date, p_from) + 1)::numeric as days
        from hr.leave_request l
       where l.worker_id = any (v_workers) and l.status = 'approved'
         and l.from_date <= p_to and l.to_date >= p_from
       group by l.leave_type_id
    ), bal as (
      select b.leave_type_id, sum(b.remaining) as days,
             count(distinct b.worker_id)
               filter (where b.remaining > 0 and b.day_rate is not null) as people,
             sum(b.remaining * b.day_rate) as money
        from rpt.leave_rows(v_workers, extract(year from p_to)::int) b
       group by b.leave_type_id
    )
    select t.name, coalesce(tk.days, 0), coalesce(bl.days, 0),
           case when v_money and bl.people >= 3 then round(bl.money, 2) end
      from hr.leave_type t
      left join taken tk on tk.leave_type_id = t.id
      left join bal bl on bl.leave_type_id = t.id
     where t.tenant_id = core.my_tenant() and t.archived_at is null
       and (tk.days is not null or bl.days is not null)
     order by t.name;
end $$;

-- ---------------------------------------------------------------------------
-- The central kitchen report (at the kitchen's store), and what outlets received from it
-- ---------------------------------------------------------------------------

-- Transfer lines out of a store dispatched in a period (store's business days), valued at
-- the cost on the line (the hub's average at dispatch).
create function rpt.dispatch_lines(p_store uuid, p_from date, p_to date)
returns table (transfer_id uuid, to_node_id uuid, item_id uuid, requested numeric,
               dispatched numeric, received numeric, unit_cost numeric, received_at timestamptz)
language sql stable
set search_path = pg_catalog, core, inv, ops, rpt
as $$
  select t.id, t.to_node_id, l.item_id, l.requested_qty, coalesce(l.dispatched_qty, 0),
         l.received_qty, coalesce(l.unit_cost, 0), t.received_at
    from inv.transfer t
    join inv.transfer_line l on l.transfer_id = t.id
   where t.from_node_id = p_store and t.dispatched_at is not null
     and t.dispatched_at >= rpt.day_start(p_from, ops.tz_of(p_store))
     and t.dispatched_at < rpt.day_start(p_to + 1, ops.tz_of(p_store))
$$;

create function rpt.kitchen_summary(p_store uuid, p_from date, p_to date)
returns table (measure text, value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
begin
  perform rpt.require('central_kitchen', p_store);
  perform rpt.check_period(p_from, p_to);
  v_start := rpt.day_start(p_from, ops.tz_of(p_store));
  v_end := rpt.day_start(p_to + 1, ops.tz_of(p_store));
  return query
    with made as (
      select p.id, p.qty_made * p.unit_cost as amount from inv.production p
       where p.delivery_node_id = p_store and p.made_at >= v_start and p.made_at < v_end
    ), over as (
      select sum((pl.actual_qty - pl.planned_qty) * pl.unit_cost) as amount
        from inv.production_line pl where pl.production_id in (select id from made)
    ), expired as (
      select coalesce(sum(-l.qty * l.unit_cost), 0) as amount from inv.stock_ledger l
       where l.delivery_node_id = p_store and l.movement_type = 'wastage'
         and l.reason = 'expired' and l.occurred_at >= v_start and l.occurred_at < v_end
    ), d as (
      select * from rpt.dispatch_lines(p_store, p_from, p_to)
    )
    select m.measure, m.value from (values
      ('batches', (select count(*) from made)::numeric),
      ('made_value', (select round(coalesce(sum(x.amount), 0), 2) from made x)),
      ('ingredients_over', (select round(coalesce(x.amount, 0), 2) from over x)),
      ('expired_value', (select round(x.amount, 2) from expired x)),
      ('expired_pct', (select round(e.amount * 100
                                    / nullif((select sum(m.amount) from made m), 0), 1)
                         from expired e)),
      ('transfers', (select count(distinct transfer_id) from d)::numeric),
      ('requested_value', (select round(coalesce(sum(requested * unit_cost), 0), 2) from d)),
      ('dispatched_value', (select round(coalesce(sum(dispatched * unit_cost), 0), 2) from d)),
      ('fill_pct', (select round(sum(least(dispatched, requested) * unit_cost) * 100
                                 / nullif(sum(requested * unit_cost), 0), 1) from d)),
      ('transit_loss', (select round(coalesce(sum((dispatched - received) * unit_cost), 0), 2)
                          from d where received_at is not null)),
      ('in_transit_value', (select round(coalesce(sum(coalesce(l.dispatched_qty, 0)
                                                      * coalesce(l.unit_cost, 0)), 0), 2)
                              from inv.transfer t join inv.transfer_line l on l.transfer_id = t.id
                             where t.from_node_id = p_store and t.dispatched_at is not null
                               and t.received_at is null and t.status = 'submitted'))
    ) m(measure, value);
end $$;

-- Each prep item: planned on prep lists due in the period, made, batches.
create function rpt.kitchen_production(p_store uuid, p_from date, p_to date)
returns table (item_id uuid, sku text, name text, unit text, planned numeric, made numeric,
               batches int)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
begin
  perform rpt.require('central_kitchen', p_store);
  perform rpt.check_period(p_from, p_to);
  v_start := rpt.day_start(p_from, ops.tz_of(p_store));
  v_end := rpt.day_start(p_to + 1, ops.tz_of(p_store));
  return query
    with plan as (
      select t.item_id, sum(t.target_qty) as qty from ops.task t
       where t.kind = 'prep' and t.delivery_node_id = p_store and t.status <> 'cancelled'
         and t.due_at >= v_start and t.due_at < v_end and t.item_id is not null
       group by t.item_id
    ), made as (
      select p.prep_item_id as item_id, sum(p.qty_made) as qty, count(*)::int as batches
        from inv.production p
       where p.delivery_node_id = p_store and p.made_at >= v_start and p.made_at < v_end
       group by p.prep_item_id
    )
    select i.id, i.sku, i.name, i.base_uom, coalesce(pl.qty, 0), coalesce(m.qty, 0),
           coalesce(m.batches, 0)
      from inv.item i
      left join plan pl on pl.item_id = i.id
      left join made m on m.item_id = i.id
     where pl.item_id is not null or m.item_id is not null
     order by i.name;
end $$;

-- Each store the kitchen sent to: transfers dispatched in the period, requested,
-- dispatched and received by value, fill rate, transit loss and lines sent short.
create function rpt.kitchen_dispatch(p_store uuid, p_from date, p_to date)
returns table (store_id uuid, store_name text, transfers int, requested_value numeric,
               dispatched_value numeric, received_value numeric, fill_pct numeric,
               transit_loss numeric, short_lines int)
language plpgsql stable security definer
set search_path = pg_catalog, core, rpt
as $$
begin
  perform rpt.require('central_kitchen', p_store);
  perform rpt.check_period(p_from, p_to);
  return query
    select d.to_node_id, n.name, count(distinct d.transfer_id)::int,
           round(sum(d.requested * d.unit_cost), 2), round(sum(d.dispatched * d.unit_cost), 2),
           round(sum(coalesce(d.received, 0) * d.unit_cost), 2),
           round(sum(least(d.dispatched, d.requested) * d.unit_cost) * 100
                 / nullif(sum(d.requested * d.unit_cost), 0), 1),
           round(coalesce(sum((d.dispatched - d.received) * d.unit_cost)
                            filter (where d.received_at is not null), 0), 2),
           (count(*) filter (where d.dispatched < d.requested))::int
      from rpt.dispatch_lines(p_store, p_from, p_to) d
      join core.hierarchy_node n on n.id = d.to_node_id
     group by d.to_node_id, n.name
     order by n.name;
end $$;

-- What is on the road now from the kitchen.
create function rpt.kitchen_in_transit(p_store uuid)
returns table (transfer_id uuid, store_name text, dispatched_at timestamptz, lines int,
               value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, rpt
as $$
begin
  perform rpt.require('central_kitchen', p_store);
  return query
    select t.id, n.name, t.dispatched_at, count(*)::int,
           round(sum(coalesce(l.dispatched_qty, 0) * coalesce(l.unit_cost, 0)), 2)
      from inv.transfer t
      join inv.transfer_line l on l.transfer_id = t.id
      join core.hierarchy_node n on n.id = t.to_node_id
     where t.from_node_id = p_store and t.dispatched_at is not null and t.received_at is null
       and t.status = 'submitted'
     group by t.id, n.name, t.dispatched_at
     order by t.dispatched_at;
end $$;

-- Purchasing, "From the central kitchen": at a store, what came in from each kitchen
-- store in the period (received), against what was asked for.
create function rpt.transfers_in(p_store uuid, p_from date, p_to date)
returns table (from_id uuid, from_name text, transfers int, requested_value numeric,
               received_value numeric, fill_pct numeric, transit_loss numeric,
               short_lines int)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
begin
  perform rpt.require('purchasing', p_store);
  perform rpt.check_period(p_from, p_to);
  return query
    select t.from_node_id, n.name, count(distinct t.id)::int,
           round(sum(l.requested_qty * coalesce(l.unit_cost, 0)), 2),
           round(sum(coalesce(l.received_qty, 0) * coalesce(l.unit_cost, 0)), 2),
           round(sum(least(coalesce(l.received_qty, 0), l.requested_qty) * coalesce(l.unit_cost, 0))
                 * 100 / nullif(sum(l.requested_qty * coalesce(l.unit_cost, 0)), 0), 1),
           round(sum((coalesce(l.dispatched_qty, 0) - coalesce(l.received_qty, 0))
                     * coalesce(l.unit_cost, 0)), 2),
           (count(*) filter (where coalesce(l.received_qty, 0) < l.requested_qty))::int
      from inv.transfer t
      join inv.transfer_line l on l.transfer_id = t.id
      join core.hierarchy_node n on n.id = t.from_node_id
     where t.to_node_id = p_store and t.received_at is not null
       and rpt.is_kitchen_store(t.from_node_id)
       and t.received_at >= rpt.day_start(p_from, ops.tz_of(p_store))
       and t.received_at < rpt.day_start(p_to + 1, ops.tz_of(p_store))
     group by t.from_node_id, n.name
     order by n.name;
end $$;

-- ---------------------------------------------------------------------------
-- Test customers only (ADR 017, file 36): past transfers from the central kitchen
-- ---------------------------------------------------------------------------

-- A ledger row at a given time, with a reason (transit loss).
create function inv.post_at(p_item uuid, p_node uuid, p_type text, p_qty numeric,
                            p_unit_cost numeric, p_ref_type text, p_ref_id uuid,
                            p_at timestamptz, p_reason text) returns void
language sql
set search_path = pg_catalog, core, inv
as $$
  insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                unit_cost, reason, ref_type, ref_id, occurred_at)
  select tenant_id, p_item, p_node, p_type, p_qty, coalesce(p_unit_cost, 0), p_reason,
         p_ref_type, p_ref_id, p_at
    from core.hierarchy_node where id = p_node;
$$;
revoke execute on function inv.post_at(uuid, uuid, text, numeric, numeric, text, uuid,
                                       timestamptz, text) from public;

-- inv.dispatch_transfer and inv.receive_transfer with the time as a parameter, made from
-- their current definitions (20261002120000_store_transfers changed them), so every check
-- they make stays. The app's functions call them with now().
do $$
declare
  v_src text;
  v_rep text[][];
  i int;
begin
  v_src := pg_get_functiondef('inv.dispatch_transfer(uuid, jsonb, text)'::regprocedure);
  v_rep := array[
    array['inv.dispatch_transfer(p_transfer uuid, p_lines jsonb DEFAULT ''[]''::jsonb, p_comment text DEFAULT NULL::text)',
          'inv.dispatch_transfer_at(p_transfer uuid, p_lines jsonb, p_comment text, p_at timestamp with time zone)'],
    array[E'      perform inv.post(v_l.item_id, v_t.from_node_id, ''transfer_out'', -v_qty, v_cost,\n                       ''transfer'', p_transfer);',
          E'      perform inv.post_at(v_l.item_id, v_t.from_node_id, ''transfer_out'', -v_qty, v_cost,\n                          ''transfer'', p_transfer, p_at);'],
    array['set dispatched_at = now(), dispatched_by', 'set dispatched_at = p_at, dispatched_by']];
  for i in 1 .. array_length(v_rep, 1) loop
    if position(v_rep[i][1] in v_src) = 0 then
      raise exception 'inv.dispatch_transfer changed; update this migration (%)', i;
    end if;
    v_src := replace(v_src, v_rep[i][1], v_rep[i][2]);
  end loop;
  execute v_src;

  v_src := pg_get_functiondef('inv.receive_transfer(uuid, jsonb, text)'::regprocedure);
  v_rep := array[
    array['inv.receive_transfer(p_transfer uuid, p_lines jsonb DEFAULT ''[]''::jsonb, p_comment text DEFAULT NULL::text)',
          'inv.receive_transfer_at(p_transfer uuid, p_lines jsonb, p_comment text, p_at timestamp with time zone)'],
    array[E'      perform inv.post(v_l.item_id, v_t.to_node_id, ''transfer_in'', v_l.dispatched_qty,\n                       v_l.unit_cost, ''transfer'', p_transfer);',
          E'      perform inv.post_at(v_l.item_id, v_t.to_node_id, ''transfer_in'', v_l.dispatched_qty,\n                          v_l.unit_cost, ''transfer'', p_transfer, p_at);'],
    array[E'      perform inv.post(v_l.item_id, v_t.to_node_id, ''wastage'', v_qty - v_l.dispatched_qty,\n                       v_l.unit_cost, ''transfer'', p_transfer, ''transit_loss'');',
          E'      perform inv.post_at(v_l.item_id, v_t.to_node_id, ''wastage'', v_qty - v_l.dispatched_qty,\n                          v_l.unit_cost, ''transfer'', p_transfer, p_at, ''transit_loss'');'],
    array['set received_at = now(), received_by', 'set received_at = p_at, received_by']];
  for i in 1 .. array_length(v_rep, 1) loop
    if position(v_rep[i][1] in v_src) = 0 then
      raise exception 'inv.receive_transfer changed; update this migration (%)', i;
    end if;
    v_src := replace(v_src, v_rep[i][1], v_rep[i][2]);
  end loop;
  execute v_src;
end $$;
revoke execute on function inv.dispatch_transfer_at(uuid, jsonb, text, timestamptz),
  inv.receive_transfer_at(uuid, jsonb, text, timestamptz) from public;

-- Unchanged for the app: now.
create or replace function inv.dispatch_transfer(p_transfer uuid, p_lines jsonb default '[]',
                                                 p_comment text default null) returns text
language sql security definer
set search_path = pg_catalog, core, inv, wf
as $$ select inv.dispatch_transfer_at(p_transfer, p_lines, p_comment, now()) $$;
create or replace function inv.receive_transfer(p_transfer uuid, p_lines jsonb default '[]',
                                                p_comment text default null) returns text
language sql security definer
set search_path = pg_catalog, core, inv, wf
as $$ select inv.receive_transfer_at(p_transfer, p_lines, p_comment, now()) $$;

-- The loader's entry points: a test customer, a past time, received after dispatched.
create function inv.record_test_dispatch(p_transfer uuid, p_lines jsonb, p_at timestamptz)
returns text
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
begin
  perform inv.require_test_time(p_at);
  return inv.dispatch_transfer_at(p_transfer, p_lines, null, p_at);
end $$;
create function inv.record_test_transfer_receipt(p_transfer uuid, p_lines jsonb,
                                                 p_at timestamptz) returns text
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
begin
  perform inv.require_test_time(p_at);
  if p_at < (select t.dispatched_at from inv.transfer t where t.id = p_transfer) then
    raise exception 'INVALID_DATE' using detail = 'received before it was dispatched';
  end if;
  return inv.receive_transfer_at(p_transfer, p_lines, null, p_at);
end $$;
revoke execute on function inv.record_test_dispatch(uuid, jsonb, timestamptz),
  inv.record_test_transfer_receipt(uuid, jsonb, timestamptz) from public;
grant execute on function inv.record_test_dispatch(uuid, jsonb, timestamptz),
  inv.record_test_transfer_receipt(uuid, jsonb, timestamptz) to platform_loader;

-- ---------------------------------------------------------------------------
-- RLS registration (rule 1), audit (rule 5), grants
-- ---------------------------------------------------------------------------

insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('rpt.labour_cost_day', 'LABOUR_COST', 'org', true);
select core.apply_domain_rls('rpt.labour_cost_day');
select audit.enable('rpt.labour_cost_day');

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'rpt' loop
    execute format('revoke execute on function %s from public', f);
  end loop;
end $$;
grant execute on function rpt.report_places(text), rpt.my_reports(),
  rpt.outlet_flash(uuid, date), rpt.department_day(uuid, date), rpt.department_people(uuid),
  rpt.my_week(date), rpt.today(uuid),
  rpt.cost_items(uuid, date, date), rpt.cost_totals(uuid, date, date),
  rpt.cost_expired(uuid, date, date), rpt.menu_engineering(uuid, date, date),
  rpt.stock_items(uuid), rpt.stock_summary(uuid), rpt.price_changes(uuid, date, date),
  rpt.supplier_fill(uuid, date, date), rpt.short_deliveries(uuid, date, date),
  rpt.labour_cost(uuid, date, date), rpt.cost_breakdown(uuid, date, date),
  rpt.people_summary(uuid, date, date), rpt.people_departments(uuid, date, date),
  rpt.people_flags(uuid, date, date), rpt.people_leave(uuid, date, date),
  rpt.kitchen_summary(uuid, date, date), rpt.kitchen_production(uuid, date, date),
  rpt.kitchen_dispatch(uuid, date, date), rpt.kitchen_in_transit(uuid),
  rpt.transfers_in(uuid, date, date) to app_rw;
grant execute on function rpt.nightly(), rpt.rebuild(date, date) to wf_executor;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.

create or replace function rpt.can_open(p_report text, p_place uuid)
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
             else false end
      from core.hierarchy_node n where n.id = p_place), false)
$function$;

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

create or replace function rpt.my_reports()
 RETURNS TABLE(report text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr'
AS $function$
  select v.r from (values (1, 'outlet_flash'), (2, 'department'), (3, 'cost_of_sales'),
                          (4, 'menu_engineering'), (5, 'stock_position'), (6, 'purchasing'),
                          (7, 'my_week')) v(o, r)
   where case v.r
           when 'my_week' then exists (select 1 from hr.worker w
                                        where w.owner_user_id = core.current_user_id()
                                          and w.status = 'active')
           when 'cost_of_sales' then core.module_on(core.my_tenant(), 'menu_sales')
                                     and exists (select 1 from rpt.report_places(v.r))
           when 'menu_engineering' then core.module_on(core.my_tenant(), 'menu_sales')
                                        and exists (select 1 from rpt.report_places(v.r))
           else exists (select 1 from rpt.report_places(v.r)) end
   order by v.o
$function$;

create or replace function rpt.outlet_flash(p_outlet uuid, p_day date)
 RETURNS TABLE(measure text, value numeric, last_week numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'rpt'
AS $function$
declare
  v_today date;
  v_places uuid[];
  v_stores uuid[];
begin
  perform rpt.require('outlet_flash', p_outlet);
  v_today := rpt.today(p_outlet);
  if p_day is null or p_day > v_today then
    raise exception 'INVALID_DATE' using detail = 'today or an earlier day';
  end if;
  v_places := rpt.outlet_team_places(p_outlet);
  v_stores := rpt.outlet_stores(p_outlet);
  return query
    with d(day, k) as (values (p_day, 'now'), (p_day - 7, 'then')),
    sales as (
      select d.k, s.menu, s.sales, s.theoretical_cost
        from d cross join lateral rpt.sales_of(p_outlet, d.day) s
    ), sm as (
      select d.k, m.measure, m.value from d cross join lateral (
        select 'sales' as measure, coalesce(sum(s.sales), 0) as value from sales s where s.k = d.k
        union all
        select 'food_sales', coalesce(sum(s.sales), 0) from sales s where s.k = d.k and s.menu = 'Food'
        union all
        select 'bar_sales', coalesce(sum(s.sales), 0) from sales s where s.k = d.k and s.menu = 'Bar'
        union all
        select 'food_cost_pct', round(sum(s.theoretical_cost) * 100 / nullif(sum(s.sales), 0), 1)
          from sales s where s.k = d.k and s.menu = 'Food'
        union all
        select 'bar_cost_pct', round(sum(s.theoretical_cost) * 100 / nullif(sum(s.sales), 0), 1)
          from sales s where s.k = d.k and s.menu = 'Bar'
      ) m
    ), tm as (
      select d.k, m.measure, m.value
        from d cross join lateral rpt.team_measures(v_places, v_stores, d.day, v_today) m
    ), allm as (
      select * from sm union all select * from tm
      union all
      select w.k, 'wastage_pct',
             round(w.value * 100 / nullif((select s.value from sm s
                                            where s.k = w.k and s.measure = 'sales'), 0), 1)
        from tm w where w.measure = 'wastage'
    )
    select a.measure, a.value, b.value
      from allm a left join allm b on b.measure = a.measure and b.k = 'then'
     where a.k = 'now';
end $function$;

create or replace function rpt.department_day(p_place uuid, p_day date)
 RETURNS TABLE(measure text, value numeric, last_week numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'rpt'
AS $function$
declare
  v_today date;
  v_stores uuid[];
begin
  perform rpt.require('department', p_place);
  v_today := rpt.today(p_place);
  if p_day is null or p_day > v_today then
    raise exception 'INVALID_DATE' using detail = 'today or an earlier day';
  end if;
  select coalesce(array_agg(s), '{}') into v_stores from unnest(rpt.team_stores(p_place)) s
   where core.can('REPORTS', 'view', p_place, null)
      or core.can('STOCK_LEVELS', 'view', null, s);
  return query
    select a.measure, a.value, b.value
      from rpt.team_measures(array[p_place], v_stores, p_day, v_today) a
      left join rpt.team_measures(array[p_place], v_stores, p_day - 7, v_today) b
        on b.measure = a.measure;
end $function$;

create or replace function rpt.rebuild(p_from date, p_to date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'rpt'
AS $function$
declare
  v_n int := 0;
  v_c int;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'INVALID_DATES' using detail = 'a period of at most 400 days';
  end if;

  insert into rpt.store_day as t (tenant_id, delivery_node_id, business_date, opening_value,
         receipts, transfers_in, transfers_out, production_in, production_out, wastage,
         count_adjust, sales_use, other_use, closing_value)
  select * from rpt.calc_store_day(rpt.all_stores(), p_from, p_to)
  on conflict (delivery_node_id, business_date) do update
     set opening_value = excluded.opening_value, receipts = excluded.receipts,
         transfers_in = excluded.transfers_in, transfers_out = excluded.transfers_out,
         production_in = excluded.production_in, production_out = excluded.production_out,
         wastage = excluded.wastage, count_adjust = excluded.count_adjust,
         sales_use = excluded.sales_use, other_use = excluded.other_use,
         closing_value = excluded.closing_value
   where (t.opening_value, t.receipts, t.transfers_in, t.transfers_out, t.production_in,
          t.production_out, t.wastage, t.count_adjust, t.sales_use, t.other_use,
          t.closing_value)
         is distinct from
         (excluded.opening_value, excluded.receipts, excluded.transfers_in,
          excluded.transfers_out, excluded.production_in, excluded.production_out,
          excluded.wastage, excluded.count_adjust, excluded.sales_use, excluded.other_use,
          excluded.closing_value);
  get diagnostics v_c = row_count;
  v_n := v_n + v_c;

  insert into rpt.sales_day as t (tenant_id, org_node_id, delivery_node_id, business_date,
         menu, sales, qty, theoretical_cost)
  select * from rpt.calc_sales_day(rpt.all_outlets(), p_from, p_to)
  on conflict (org_node_id, business_date, menu) do update
     set delivery_node_id = excluded.delivery_node_id, sales = excluded.sales,
         qty = excluded.qty, theoretical_cost = excluded.theoretical_cost
   where (t.delivery_node_id, t.sales, t.qty, t.theoretical_cost)
         is distinct from
         (excluded.delivery_node_id, excluded.sales, excluded.qty, excluded.theoretical_cost);
  get diagnostics v_c = row_count;
  v_n := v_n + v_c;
  -- a day whose sales were removed keeps a row, at zero (no hard deletes)
  update rpt.sales_day t set sales = 0, qty = 0, theoretical_cost = 0
   where t.business_date between p_from and p_to and (t.sales, t.qty, t.theoretical_cost) <> (0, 0, 0)
     and not exists (select 1 from rpt.calc_sales_day(array[t.org_node_id], t.business_date,
                                                      t.business_date) c where c.menu = t.menu);

  insert into rpt.labour_day as t (tenant_id, org_node_id, business_date, shifts, slots, filled,
         scheduled_hours, worked_hours, late, no_shows)
  select * from rpt.calc_labour_day(rpt.all_team_places(), p_from, p_to)
  on conflict (org_node_id, business_date) do update
     set shifts = excluded.shifts, slots = excluded.slots, filled = excluded.filled,
         scheduled_hours = excluded.scheduled_hours, worked_hours = excluded.worked_hours,
         late = excluded.late, no_shows = excluded.no_shows
   where (t.shifts, t.slots, t.filled, t.scheduled_hours, t.worked_hours, t.late, t.no_shows)
         is distinct from
         (excluded.shifts, excluded.slots, excluded.filled, excluded.scheduled_hours,
          excluded.worked_hours, excluded.late, excluded.no_shows);
  get diagnostics v_c = row_count;
  v_n := v_n + v_c;

  insert into rpt.task_day as t (tenant_id, org_node_id, business_date, due, done, done_on_time,
         flagged, overdue)
  select * from rpt.calc_task_day(rpt.all_team_places(), p_from, p_to)
  on conflict (org_node_id, business_date) do update
     set due = excluded.due, done = excluded.done, done_on_time = excluded.done_on_time,
         flagged = excluded.flagged, overdue = excluded.overdue
   where (t.due, t.done, t.done_on_time, t.flagged, t.overdue)
         is distinct from
         (excluded.due, excluded.done, excluded.done_on_time, excluded.flagged, excluded.overdue);
  get diagnostics v_c = row_count;
  return v_n + v_c;
end $function$;

create or replace function menu.cost_calc(p_outlet uuid, p_stores uuid[], p_from date, p_to date)
 RETURNS TABLE(menu text, revenue numeric, theoretical_cost numeric, theoretical_pct numeric, actual_cost numeric, actual_pct numeric)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'core', 'inv', 'menu'
AS $function$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_outlet), 'UTC');
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  return query
    with stores as (
      select distinct mo.delivery_node_id as store from menu.menu_outlet mo
       where mo.org_node_id = p_outlet and mo.delivery_node_id = any (p_stores)
    ), sold as (
      select mi.menu, sl.delivery_node_id as store, sum(sl.qty * sl.price) as revenue, sd.id as day
        from menu.sales_day sd
        join menu.sales_line sl on sl.sales_day_id = sd.id
        join menu.menu_item mi on mi.id = sl.menu_item_id
       where sd.org_node_id = p_outlet and sd.business_date between p_from and p_to
         and sl.delivery_node_id in (select store from stores)
       group by mi.menu, sl.delivery_node_id, sd.id
    ), rev as (
      select s.menu, s.store, sum(s.revenue) as revenue from sold s group by s.menu, s.store
    ), share as (
      select r.menu, r.store, r.revenue,
             r.revenue / nullif(sum(r.revenue) over (partition by r.store), 0) as share
        from rev r
    ), depleted as (
      select l.delivery_node_id as store, sum(-l.qty * l.unit_cost) as cost
        from inv.stock_ledger l
        join menu.sales_day sd on sd.id = l.ref_id and l.ref_type = 'sales_day'
       where sd.org_node_id = p_outlet and sd.business_date between p_from and p_to
         and l.delivery_node_id in (select store from stores)
       group by l.delivery_node_id
    ), losses as (
      select l.delivery_node_id as store,
             sum(-l.qty * l.unit_cost) filter (where l.movement_type in ('wastage', 'consumption', 'count_adjust')) as cost
        from inv.stock_ledger l
       where l.delivery_node_id in (select store from stores)
         and l.occurred_at >= v_start and l.occurred_at < v_end
       group by l.delivery_node_id
    )
    select s.menu, round(sum(s.revenue), 2),
           round(sum(coalesce(d.cost, 0) * s.share), 2),
           round(sum(coalesce(d.cost, 0) * s.share) / nullif(sum(s.revenue), 0) * 100, 1),
           round(sum((coalesce(d.cost, 0) + coalesce(lo.cost, 0)) * s.share), 2),
           round(sum((coalesce(d.cost, 0) + coalesce(lo.cost, 0)) * s.share)
                 / nullif(sum(s.revenue), 0) * 100, 1)
      from share s
      left join depleted d on d.store = s.store
      left join losses lo on lo.store = s.store
     group by s.menu
     order by s.menu;
end $function$;

create or replace function inv.dispatch_transfer(p_transfer uuid, p_lines jsonb DEFAULT '[]'::jsonb, p_comment text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'wf'
AS $function$
declare
  v_me core.app_user := wf.me();
  v_t inv.transfer;
  v_l inv.transfer_line;
  v_qty numeric;
  v_cost numeric;
  v_state text;
begin
  select * into v_t from inv.transfer
   where id = p_transfer and tenant_id = v_me.tenant_id for update;
  if not found then
    perform inv.fail('NOT_AUTHORISED', 'transfer not found');
  end if;
  perform inv.require_step(v_t.wf_request_id, 'dispatch');
  if v_t.status <> 'submitted' or v_t.dispatched_at is not null then
    perform inv.fail('INVALID_STATE', 'transfer is not waiting for dispatch');
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]')) <> 'array'
     or exists (select 1 from jsonb_to_recordset(coalesce(p_lines, '[]')) as l(item_id uuid, qty numeric)
                 where l.qty is null or l.qty < 0
                    or not exists (select 1 from inv.transfer_line
                                    where transfer_id = p_transfer and item_id = l.item_id)) then
    perform inv.fail('INVALID_LINES', 'dispatch lines must be items on this transfer, 0 or more');
  end if;

  -- Checks the caller may act on the dispatch step (and rule 7) before posting anything.
  v_state := wf.act_as_module(v_t.wf_request_id, 'dispatch', p_comment);

  for v_l in select * from inv.transfer_line where transfer_id = p_transfer order by id loop
    v_qty := coalesce((select (e ->> 'qty')::numeric from jsonb_array_elements(p_lines) e
                        where (e ->> 'item_id')::uuid = v_l.item_id), v_l.requested_qty);
    v_cost := inv.avg_cost(v_l.item_id, v_t.from_node_id);
    if v_qty > 0 then
      perform inv.post(v_l.item_id, v_t.from_node_id, 'transfer_out', -v_qty, v_cost,
                       'transfer', p_transfer);
    end if;
    update inv.transfer_line set dispatched_qty = v_qty, unit_cost = v_cost where id = v_l.id;
  end loop;
  update inv.transfer set dispatched_at = now(), dispatched_by = v_me.id where id = p_transfer;
  return v_state;
end $function$;

create or replace function inv.receive_transfer(p_transfer uuid, p_lines jsonb DEFAULT '[]'::jsonb, p_comment text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'wf'
AS $function$
declare
  v_me core.app_user := wf.me();
  v_t inv.transfer;
  v_l inv.transfer_line;
  v_qty numeric;
  v_state text;
begin
  select * into v_t from inv.transfer
   where id = p_transfer and tenant_id = v_me.tenant_id for update;
  if not found then
    perform inv.fail('NOT_AUTHORISED', 'transfer not found');
  end if;
  perform inv.require_step(v_t.wf_request_id, 'receipt');
  if v_t.status <> 'submitted' or v_t.dispatched_at is null or v_t.received_at is not null then
    perform inv.fail('INVALID_STATE', 'transfer is not in transit');
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]')) <> 'array'
     or exists (select 1 from jsonb_to_recordset(coalesce(p_lines, '[]')) as l(item_id uuid, qty numeric)
                 where l.qty is null or l.qty < 0
                    or not exists (select 1 from inv.transfer_line tl
                                    where tl.transfer_id = p_transfer and tl.item_id = l.item_id
                                      and l.qty <= tl.dispatched_qty)) then
    perform inv.fail('INVALID_QUANTITY', 'cannot receive more than was dispatched');
  end if;

  v_state := wf.act_as_module(v_t.wf_request_id, 'receipt', p_comment);

  for v_l in select * from inv.transfer_line where transfer_id = p_transfer order by id loop
    v_qty := coalesce((select (e ->> 'qty')::numeric from jsonb_array_elements(p_lines) e
                        where (e ->> 'item_id')::uuid = v_l.item_id), v_l.dispatched_qty);
    if v_l.dispatched_qty > 0 then
      perform inv.post(v_l.item_id, v_t.to_node_id, 'transfer_in', v_l.dispatched_qty,
                       v_l.unit_cost, 'transfer', p_transfer);
    end if;
    if v_l.dispatched_qty > v_qty then
      perform inv.post(v_l.item_id, v_t.to_node_id, 'wastage', v_qty - v_l.dispatched_qty,
                       v_l.unit_cost, 'transfer', p_transfer, 'transit_loss');
    end if;
    update inv.transfer_line set received_qty = v_qty where id = v_l.id;
  end loop;
  update inv.transfer set received_at = now(), received_by = v_me.id where id = p_transfer;
  return v_state;
end $function$;

drop function inv.record_test_dispatch(uuid, jsonb, timestamptz),
  inv.record_test_transfer_receipt(uuid, jsonb, timestamptz),
  inv.dispatch_transfer_at(uuid, jsonb, text, timestamptz),
  inv.receive_transfer_at(uuid, jsonb, text, timestamptz),
  inv.post_at(uuid, uuid, text, numeric, numeric, text, uuid, timestamptz, text);
delete from core.domain_table where table_name = 'rpt.labour_cost_day'::regclass;
drop table rpt.labour_cost_day;
drop function rpt.transfers_in(uuid, date, date), rpt.kitchen_in_transit(uuid),
  rpt.kitchen_dispatch(uuid, date, date), rpt.kitchen_production(uuid, date, date),
  rpt.kitchen_summary(uuid, date, date), rpt.dispatch_lines(uuid, date, date),
  rpt.people_leave(uuid, date, date), rpt.people_flags(uuid, date, date),
  rpt.people_departments(uuid, date, date), rpt.people_summary(uuid, date, date),
  rpt.leave_rows(uuid[], int), rpt.people_rows(uuid[], date, date),
  rpt.check_period(date, date), rpt.place_workers(uuid),
  hr.record_test_attendance(timestamptz, timestamptz, text),
  rpt.cost_breakdown(uuid, date, date), rpt.labour_cost(uuid, date, date),
  rpt.is_kitchen_store(uuid), menu.cost_parts(uuid, uuid[], date, date),
  rpt.labour_cost_of(uuid, date, date), rpt.rebuild_labour_cost(date, date),
  rpt.labour_cost_rows(uuid[], date, date), rpt.calc_labour_people(uuid[], date, date),
  rpt.worker_hours(uuid[], date, date), rpt.all_labour_places();
