-- migrate:up
-- Reporting, step R-1 (docs/reporting.md, ADR 023).
--
--   * Business day: 06:00 to 06:00 local time at every place (a bar's night belongs to the
--     day it started).
--   * Four daily summary tables in schema rpt, one row per place per business day, written
--     only by rpt.rebuild (the nightly job, as wf_executor). Each follows rule 1: RLS
--     generated from its source domain, the audit trigger, tenant_id and nodes. A rebuild
--     writes only rows whose figures changed, so the audit log records changes, not runs.
--   * Each figure is worked out once, in the rpt.calc_* functions. The rebuild stores what
--     they return; the reports read stored rows for past days and call them directly for
--     today and yesterday, so a day that is still open (until 06:00) is never stale.
--   * Access: a report opens where its source is visible (rule 2, core.can): the outlet
--     flash where the person sees the outlet's SALES, a department's day where they see
--     its ATTENDANCE, the store figures in it where they see that store's STOCK_LEVELS,
--     and everyone's own week. REPORTS (held by the Account Owner, view only) opens every
--     report in the company. Labour cost is not here: it needs LABOUR_COST (R-3).

create schema rpt;
grant usage on schema rpt to app_rw, wf_executor;

-- ---------------------------------------------------------------------------
-- The business day
-- ---------------------------------------------------------------------------

create function rpt.business_date(p_at timestamptz, p_tz text) returns date
language sql immutable
set search_path = pg_catalog
as $$ select ((p_at at time zone p_tz) - interval '6 hours')::date $$;

create function rpt.day_start(p_day date, p_tz text) returns timestamptz
language sql immutable
set search_path = pg_catalog
as $$ select (p_day + time '06:00') at time zone p_tz $$;

-- Today's business date at a place.
create function rpt.today(p_node uuid) returns date
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$ select rpt.business_date(now(), ops.tz_of(p_node)) $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Stock movements by value (₹ at the cost on the ledger line), per store per day.
-- Outflows are positive amounts; count_adjust is signed (a loss is negative).
create table rpt.store_day (
  id uuid primary key default core.uuid_v7(),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  business_date date not null,
  opening_value numeric(14,2) not null default 0,
  receipts numeric(14,2) not null default 0,
  transfers_in numeric(14,2) not null default 0,
  transfers_out numeric(14,2) not null default 0,
  production_in numeric(14,2) not null default 0,
  production_out numeric(14,2) not null default 0,
  wastage numeric(14,2) not null default 0,
  count_adjust numeric(14,2) not null default 0,
  sales_use numeric(14,2) not null default 0,
  other_use numeric(14,2) not null default 0,
  closing_value numeric(14,2) not null default 0,
  currency text not null default 'INR',
  unique (delivery_node_id, business_date)
);
select core.add_standard_columns('rpt.store_day');

-- Sales per outlet per day per menu (Food, Bar), with the recipe cost of what sold.
create table rpt.sales_day (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),      -- the outlet
  delivery_node_id uuid not null references core.hierarchy_node(id), -- its supply point
  business_date date not null,
  menu text not null check (menu in ('Food', 'Bar')),
  sales numeric(14,2) not null default 0,
  qty numeric(14,3) not null default 0,
  theoretical_cost numeric(14,2) not null default 0,
  discount numeric(14,2) not null default 0,                         -- from the POS import
  currency text not null default 'INR',
  unique (org_node_id, business_date, menu)
);
select core.add_standard_columns('rpt.sales_day');

-- Hours and attendance per team place per day. No pay: labour cost is R-3.
create table rpt.labour_day (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  business_date date not null,
  shifts int not null default 0,
  slots int not null default 0,
  filled int not null default 0,
  scheduled_hours numeric(10,2) not null default 0,
  worked_hours numeric(10,2) not null default 0,
  late int not null default 0,
  no_shows int not null default 0,
  unique (org_node_id, business_date)
);
select core.add_standard_columns('rpt.labour_day');

-- Tasks due per team place per day.
create table rpt.task_day (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  business_date date not null,
  due int not null default 0,
  done int not null default 0,
  done_on_time int not null default 0,
  flagged int not null default 0,
  overdue int not null default 0,
  unique (org_node_id, business_date)
);
select core.add_standard_columns('rpt.task_day');

-- ---------------------------------------------------------------------------
-- The figures (internal: called by the rebuild and the report functions)
-- ---------------------------------------------------------------------------

create function rpt.calc_store_day(p_stores uuid[], p_from date, p_to date)
returns table (tenant_id uuid, delivery_node_id uuid, business_date date,
               opening_value numeric, receipts numeric, transfers_in numeric,
               transfers_out numeric, production_in numeric, production_out numeric,
               wastage numeric, count_adjust numeric, sales_use numeric, other_use numeric,
               closing_value numeric)
language sql stable
set search_path = pg_catalog, core, inv, ops
as $$
  with s as (
    select n.id, n.tenant_id, ops.tz_of(n.id) as tz from core.hierarchy_node n
     where n.id = any (p_stores)
  ), opening as (
    select s.id, coalesce(sum(l.qty * l.unit_cost), 0) as v
      from s left join inv.stock_ledger l
        on l.delivery_node_id = s.id and l.occurred_at < rpt.day_start(p_from, s.tz)
     group by s.id
  ), mv as (
    select s.id, rpt.business_date(l.occurred_at, s.tz) as day,
           sum(l.qty * l.unit_cost) as net,
           sum(l.qty * l.unit_cost) filter (where l.movement_type = 'receipt') as receipts,
           sum(l.qty * l.unit_cost) filter (where l.movement_type = 'transfer_in') as tin,
           -sum(l.qty * l.unit_cost) filter (where l.movement_type = 'transfer_out') as tout,
           sum(l.qty * l.unit_cost) filter (where l.movement_type = 'production_in') as pin,
           -sum(l.qty * l.unit_cost) filter (where l.movement_type = 'production_out') as pout,
           -sum(l.qty * l.unit_cost) filter (where l.movement_type = 'wastage') as waste,
           sum(l.qty * l.unit_cost) filter (where l.movement_type = 'count_adjust') as adj,
           -sum(l.qty * l.unit_cost) filter (where l.movement_type = 'sales_depletion') as sold,
           -sum(l.qty * l.unit_cost) filter (where l.movement_type = 'consumption') as other
      from s join inv.stock_ledger l on l.delivery_node_id = s.id
     where l.occurred_at >= rpt.day_start(p_from, s.tz)
       and l.occurred_at < rpt.day_start(p_to + 1, s.tz)
     group by s.id, 2
  ), days as (
    select s.id, s.tenant_id, d::date as day from s
     cross join generate_series(p_from, p_to, interval '1 day') d
  ), running as (
    select days.id, days.tenant_id, days.day, mv.net, mv.receipts, mv.tin, mv.tout, mv.pin,
           mv.pout, mv.waste, mv.adj, mv.sold, mv.other,
           o.v
           + coalesce(sum(mv.net) over (partition by days.id order by days.day
                                        rows between unbounded preceding and 1 preceding), 0)
             as open_v
      from days
      join opening o on o.id = days.id
      left join mv on mv.id = days.id and mv.day = days.day
  )
  select r.tenant_id, r.id, r.day, round(r.open_v, 2),
         round(coalesce(r.receipts, 0), 2), round(coalesce(r.tin, 0), 2),
         round(coalesce(r.tout, 0), 2), round(coalesce(r.pin, 0), 2),
         round(coalesce(r.pout, 0), 2), round(coalesce(r.waste, 0), 2),
         round(coalesce(r.adj, 0), 2), round(coalesce(r.sold, 0), 2),
         round(coalesce(r.other, 0), 2), round(r.open_v + coalesce(r.net, 0), 2)
    from running r;
$$;

-- The recipe cost of a store's sales on a day is shared between Food and Bar by their
-- revenue from that store (as menu.cost_report does).
create function rpt.calc_sales_day(p_outlets uuid[], p_from date, p_to date)
returns table (tenant_id uuid, org_node_id uuid, delivery_node_id uuid, business_date date,
               menu text, sales numeric, qty numeric, theoretical_cost numeric)
language sql stable
set search_path = pg_catalog, core, inv, menu
as $$
  with sold as (
    select sd.tenant_id, sd.org_node_id, sd.delivery_node_id as supply, sd.business_date,
           mi.menu, sl.delivery_node_id as store,
           sum(sl.qty * sl.price) as revenue, sum(sl.qty) as qty
      from menu.sales_day sd
      join menu.sales_line sl on sl.sales_day_id = sd.id
      join menu.menu_item mi on mi.id = sl.menu_item_id
     where sd.org_node_id = any (p_outlets) and sd.business_date between p_from and p_to
     group by 1, 2, 3, 4, 5, 6
  ), depleted as (
    select sd.org_node_id, sd.business_date, l.delivery_node_id as store,
           sum(-l.qty * l.unit_cost) as cost
      from menu.sales_day sd
      join inv.stock_ledger l on l.ref_type = 'sales_day' and l.ref_id = sd.id
     where sd.org_node_id = any (p_outlets) and sd.business_date between p_from and p_to
     group by 1, 2, 3
  ), shared as (
    select s.*, s.revenue / nullif(sum(s.revenue) over (
             partition by s.org_node_id, s.business_date, s.store), 0) as share
      from sold s
  )
  select s.tenant_id, s.org_node_id, min(s.supply::text)::uuid, s.business_date, s.menu,
         round(sum(s.revenue), 2), sum(s.qty), round(sum(coalesce(d.cost, 0) * s.share), 2)
    from shared s
    left join depleted d on d.org_node_id = s.org_node_id and d.business_date = s.business_date
                        and d.store = s.store
   group by s.tenant_id, s.org_node_id, s.business_date, s.menu;
$$;

create function rpt.calc_labour_day(p_places uuid[], p_from date, p_to date)
returns table (tenant_id uuid, org_node_id uuid, business_date date, shifts int, slots int,
               filled int, scheduled_hours numeric, worked_hours numeric, late int,
               no_shows int)
language sql stable
set search_path = pg_catalog, core, hr, ops
as $$
  with p as (
    select n.id, n.tenant_id, ops.tz_of(n.id) as tz from core.hierarchy_node n
     where n.id = any (p_places)
  ), sh as (
    select p.id, rpt.business_date(s.start_at, p.tz) as day, count(*)::int as shifts,
           sum(s.headcount)::int as slots,
           sum(least(a.n, s.headcount))::int as filled,
           sum(a.n * extract(epoch from s.end_at - s.start_at) / 3600) as hours
      from p
      join hr.shift s on s.org_node_id = p.id and s.status = 'published'
      cross join lateral (select count(*)::int as n from hr.shift_assignment x
                           where x.shift_id = s.id and x.status = 'assigned') a
     where s.start_at >= rpt.day_start(p_from, p.tz) and s.start_at < rpt.day_start(p_to + 1, p.tz)
     group by 1, 2
  ), wk as (
    select p.id, rpt.business_date(a.clock_in_at, p.tz) as day,
           sum(extract(epoch from a.clock_out_at - a.clock_in_at) / 3600) as hours
      from p join hr.attendance a on a.org_node_id = p.id and a.clock_out_at is not null
     where a.clock_in_at >= rpt.day_start(p_from, p.tz)
       and a.clock_in_at < rpt.day_start(p_to + 1, p.tz)
     group by 1, 2
  ), ex as (
    select p.id, coalesce(rpt.business_date(s.start_at, p.tz), x.local_date) as day,
           count(*) filter (where x.kind = 'late')::int as late,
           count(*) filter (where x.kind = 'no_show')::int as no_shows
      from p join hr.attendance_exception x on x.org_node_id = p.id
      left join hr.shift s on s.id = x.shift_id
     where x.status <> 'dismissed' and x.kind in ('late', 'no_show')
       and x.local_date between p_from - 1 and p_to + 1
     group by 1, 2
  ), days as (
    select p.id, p.tenant_id, d::date as day from p
     cross join generate_series(p_from, p_to, interval '1 day') d
  )
  select d.tenant_id, d.id, d.day, coalesce(sh.shifts, 0), coalesce(sh.slots, 0),
         coalesce(sh.filled, 0), round(coalesce(sh.hours, 0), 2), round(coalesce(wk.hours, 0), 2),
         coalesce(ex.late, 0), coalesce(ex.no_shows, 0)
    from days d
    left join sh on sh.id = d.id and sh.day = d.day
    left join wk on wk.id = d.id and wk.day = d.day
    left join ex on ex.id = d.id and ex.day = d.day;
$$;

-- A task counts on the day it is due; done on time means completed by its due time;
-- overdue means not done by the end of that business day.
create function rpt.calc_task_day(p_places uuid[], p_from date, p_to date)
returns table (tenant_id uuid, org_node_id uuid, business_date date, due int, done int,
               done_on_time int, flagged int, overdue int)
language sql stable
set search_path = pg_catalog, core, ops
as $$
  with p as (
    select n.id, n.tenant_id, ops.tz_of(n.id) as tz from core.hierarchy_node n
     where n.id = any (p_places)
  ), t as (
    select p.id, rpt.business_date(t.due_at, p.tz) as day, count(*)::int as due,
           count(*) filter (where t.status = 'done')::int as done,
           count(*) filter (where t.status = 'done' and t.completed_at <= t.due_at)::int as on_time,
           count(*) filter (where t.status <> 'done' or t.completed_at
                              >= rpt.day_start(rpt.business_date(t.due_at, p.tz) + 1, p.tz))::int
             as overdue,
           coalesce(sum((select count(*) from ops.task_step st
                          where st.task_id = t.id and st.flagged)), 0)::int as flagged
      from p join ops.task t on t.org_node_id = p.id and t.status not in ('reported', 'cancelled')
     where t.due_at >= rpt.day_start(p_from, p.tz) and t.due_at < rpt.day_start(p_to + 1, p.tz)
     group by 1, 2
  ), days as (
    select p.id, p.tenant_id, d::date as day from p
     cross join generate_series(p_from, p_to, interval '1 day') d
  )
  select d.tenant_id, d.id, d.day, coalesce(t.due, 0), coalesce(t.done, 0),
         coalesce(t.on_time, 0), coalesce(t.flagged, 0), coalesce(t.overdue, 0)
    from days d left join t on t.id = d.id and t.day = d.day;
$$;

-- ---------------------------------------------------------------------------
-- Places
-- ---------------------------------------------------------------------------

-- Every store a report covers, in every customer: the stock-holding delivery nodes.
create function rpt.all_stores() returns uuid[]
language sql stable
set search_path = pg_catalog, core
as $$ select coalesce(array_agg(id), '{}') from core.hierarchy_node
       where type = 'delivery' and holds_stock and archived_at is null $$;

create function rpt.all_outlets() returns uuid[]
language sql stable
set search_path = pg_catalog, core
as $$ select coalesce(array_agg(id), '{}') from core.hierarchy_node
       where type = 'org' and kind = 'outlet' and archived_at is null $$;

create function rpt.all_team_places() returns uuid[]
language sql stable
set search_path = pg_catalog, core
as $$ select coalesce(array_agg(id), '{}') from core.hierarchy_node n
       where n.type = 'org' and n.archived_at is null and core.is_team_place(n.id) $$;

-- An outlet's stores (everything holding stock under its supply point), and its team
-- places (its departments, or the outlet itself when it has none).
create function rpt.outlet_stores(p_outlet uuid) returns uuid[]
language sql stable
set search_path = pg_catalog, core, extensions
as $$
  select coalesce(array_agg(distinct s.id), '{}')
    from core.node_link l
    join core.hierarchy_node sp on sp.id = l.delivery_node_id
    join core.hierarchy_node s on s.type = 'delivery' and s.path <@ sp.path
                              and s.holds_stock and s.archived_at is null
   where l.org_node_id = p_outlet
$$;

create function rpt.outlet_team_places(p_outlet uuid) returns uuid[]
language sql stable
set search_path = pg_catalog, core, extensions
as $$
  select coalesce(array_agg(n.id), '{}')
    from core.hierarchy_node o
    join core.hierarchy_node n on n.type = 'org' and n.path <@ o.path and n.archived_at is null
   where o.id = p_outlet and core.is_team_place(n.id)
$$;

-- A department's stores: the ones linked to it (Kitchen -> Kitchen Store).
create function rpt.team_stores(p_place uuid) returns uuid[]
language sql stable
set search_path = pg_catalog, core
as $$
  select coalesce(array_agg(s.id), '{}')
    from core.node_link l join core.hierarchy_node s on s.id = l.delivery_node_id
   where l.org_node_id = p_place and s.holds_stock and s.archived_at is null
$$;

-- ---------------------------------------------------------------------------
-- The rebuild (the nightly job, as wf_executor)
-- ---------------------------------------------------------------------------

create function rpt.rebuild(p_from date, p_to date) returns int
language plpgsql security definer
set search_path = pg_catalog, core, rpt
as $$
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
end $$;

-- The nightly run: the last 35 days, so late edits (back-dated sales, counts, receipts)
-- are picked up. Today and yesterday are read live by the reports.
create function rpt.nightly() returns int
language sql security definer
set search_path = pg_catalog, rpt
as $$ select rpt.rebuild(current_date - 36, current_date) $$;

-- ---------------------------------------------------------------------------
-- Who opens which report (rule 2: core.can only)
-- ---------------------------------------------------------------------------

create function rpt.can_open(p_report text, p_place uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce((
    select n.tenant_id = core.my_tenant() and n.archived_at is null and n.type = 'org'
           and case p_report
             when 'outlet_flash' then
               n.kind = 'outlet'
               and (core.can('REPORTS', 'view', n.id, null)
                    or exists (select 1 from core.node_link l where l.org_node_id = n.id
                                  and core.can('SALES', 'view', null, l.delivery_node_id)))
             when 'department' then
               core.is_team_place(n.id)
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('ATTENDANCE', 'view', n.id, null))
             else false end
      from core.hierarchy_node n where n.id = p_place), false)
$$;

create function rpt.require(p_report text, p_place uuid) returns void
language plpgsql stable
set search_path = pg_catalog, rpt
as $$
begin
  if not rpt.can_open(p_report, p_place) then
    raise exception 'NOT_AUTHORISED' using detail = format('%s at %s', p_report, p_place);
  end if;
end $$;

-- The places a person can open a report at; their own place first. The same rule as
-- rpt.can_open, worked out once per domain (core.visible_nodes calls core.can per node).
create function rpt.report_places(p_report text)
returns table (id uuid, code text, name text, kind text, preferred int)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
declare
  v_home core.hierarchy_node;
  v_all uuid[] := core.visible_nodes('REPORTS', 'view');
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
  else
    raise exception 'INVALID_REPORT' using detail = p_report;
  end if;
  select n.* into v_home from hr.worker w join core.hierarchy_node n on n.id = w.org_node_id
   where w.owner_user_id = core.current_user_id() and w.status = 'active';
  return query
    select n.id, n.code, n.name, n.kind,
           case when n.id = v_home.id then 0
                when v_home.id is not null and v_home.path <@ n.path then 1
                when v_home.id is not null and n.path <@ v_home.path then 2
                else 9 end
      from core.hierarchy_node n
     where n.id = any (v_ok) and n.tenant_id = core.my_tenant() and n.archived_at is null
     order by 5, n.name;
end $$;

-- The reports a person can open, in the order of docs/reporting.md section 5.
create function rpt.my_reports() returns table (report text)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select v.r from (values (1, 'outlet_flash'), (2, 'department'), (3, 'my_week')) v(o, r)
   where case v.r
           when 'my_week' then exists (select 1 from hr.worker w
                                        where w.owner_user_id = core.current_user_id()
                                          and w.status = 'active')
           else exists (select 1 from rpt.report_places(v.r)) end
   order by v.o
$$;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

-- One business day's rows: stored for days before yesterday, worked out live after.
create function rpt.sales_of(p_outlet uuid, p_day date)
returns table (menu text, sales numeric, theoretical_cost numeric)
language sql stable
set search_path = pg_catalog, rpt
as $$
  select c.menu, c.sales, c.theoretical_cost
    from rpt.calc_sales_day(array[p_outlet], p_day, p_day) c
   where p_day >= rpt.today(p_outlet) - 1
  union all
  select s.menu, s.sales, s.theoretical_cost from rpt.sales_day s
   where p_day < rpt.today(p_outlet) - 1 and s.org_node_id = p_outlet and s.business_date = p_day
$$;

create function rpt.stores_of(p_stores uuid[], p_day date, p_today date)
returns table (wastage numeric, closing_value numeric)
language sql stable
set search_path = pg_catalog, rpt
as $$
  select coalesce(sum(x.wastage), 0), coalesce(sum(x.closing_value), 0) from (
    select c.wastage, c.closing_value from rpt.calc_store_day(p_stores, p_day, p_day) c
     where p_day >= p_today - 1
    union all
    select s.wastage, s.closing_value from rpt.store_day s
     where p_day < p_today - 1 and s.delivery_node_id = any (p_stores) and s.business_date = p_day
  ) x
$$;

create function rpt.labour_of(p_places uuid[], p_day date, p_today date)
returns table (shifts bigint, slots bigint, filled bigint, scheduled_hours numeric,
               worked_hours numeric, late bigint, no_shows bigint)
language sql stable
set search_path = pg_catalog, rpt
as $$
  select coalesce(sum(x.shifts), 0), coalesce(sum(x.slots), 0), coalesce(sum(x.filled), 0),
         coalesce(sum(x.scheduled_hours), 0), coalesce(sum(x.worked_hours), 0),
         coalesce(sum(x.late), 0), coalesce(sum(x.no_shows), 0) from (
    select c.shifts, c.slots, c.filled, c.scheduled_hours, c.worked_hours, c.late, c.no_shows
      from rpt.calc_labour_day(p_places, p_day, p_day) c where p_day >= p_today - 1
    union all
    select l.shifts, l.slots, l.filled, l.scheduled_hours, l.worked_hours, l.late, l.no_shows
      from rpt.labour_day l
     where p_day < p_today - 1 and l.org_node_id = any (p_places) and l.business_date = p_day
  ) x
$$;

create function rpt.tasks_of(p_places uuid[], p_day date, p_today date)
returns table (due bigint, done bigint, done_on_time bigint, flagged bigint, overdue bigint)
language sql stable
set search_path = pg_catalog, rpt
as $$
  select coalesce(sum(x.due), 0), coalesce(sum(x.done), 0), coalesce(sum(x.done_on_time), 0),
         coalesce(sum(x.flagged), 0), coalesce(sum(x.overdue), 0) from (
    select c.due, c.done, c.done_on_time, c.flagged, c.overdue
      from rpt.calc_task_day(p_places, p_day, p_day) c where p_day >= p_today - 1
    union all
    select t.due, t.done, t.done_on_time, t.flagged, t.overdue from rpt.task_day t
     where p_day < p_today - 1 and t.org_node_id = any (p_places) and t.business_date = p_day
  ) x
$$;

-- The measures of a team place (or a set of them) and its stores on one day.
create function rpt.team_measures(p_places uuid[], p_stores uuid[], p_day date, p_today date)
returns table (measure text, value numeric)
language sql stable
set search_path = pg_catalog, rpt
as $$
  select m.measure, m.value from rpt.labour_of(p_places, p_day, p_today) l,
         rpt.tasks_of(p_places, p_day, p_today) t,
         lateral (values
           ('scheduled_hours', l.scheduled_hours), ('worked_hours', l.worked_hours),
           ('shifts', l.shifts::numeric), ('open_slots', (l.slots - l.filled)::numeric),
           ('late', l.late::numeric), ('no_shows', l.no_shows::numeric),
           ('tasks_due', t.due::numeric), ('tasks_done', t.done::numeric),
           ('tasks_on_time', t.done_on_time::numeric),
           ('task_pct', round(t.done_on_time * 100.0 / nullif(t.due, 0), 1)),
           ('flagged', t.flagged::numeric), ('overdue', t.overdue::numeric)) m(measure, value)
  union all
  select m.measure, m.value from rpt.stores_of(p_stores, p_day, p_today) s,
         lateral (values ('wastage', s.wastage), ('stock_value', s.closing_value)) m(measure, value)
   where cardinality(p_stores) > 0
$$;

-- The outlet's day (the daily flash) and the same day last week. No labour cost (R-3).
create function rpt.outlet_flash(p_outlet uuid, p_day date)
returns table (measure text, value numeric, last_week numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, rpt
as $$
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
end $$;

-- A department's day (Department today / Department flash) and the same day last week.
-- Its store figures need that store's stock levels (or REPORTS).
create function rpt.department_day(p_place uuid, p_day date)
returns table (measure text, value numeric, last_week numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, rpt
as $$
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
end $$;

-- Who is on shift at a team place today, and whether they have clocked in.
create function rpt.department_people(p_place uuid)
returns table (name text, role_code text, start_at timestamptz, end_at timestamptz,
               clocked_in_at timestamptz, clocked_out_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, rpt
as $$
declare
  v_tz text;
  v_today date;
begin
  perform rpt.require('department', p_place);
  v_tz := ops.tz_of(p_place);
  v_today := rpt.business_date(now(), v_tz);
  return query
    select u.display_name, s.role_code, s.start_at, s.end_at, att.clock_in_at, att.clock_out_at
      from hr.shift s
      join hr.shift_assignment a on a.shift_id = s.id and a.status = 'assigned'
      join core.app_user u on u.id = a.owner_user_id
      left join lateral (
        select x.clock_in_at, x.clock_out_at from hr.attendance x
         where x.worker_id = a.worker_id
           and x.clock_in_at between s.start_at - interval '3 hours' and s.end_at
         order by x.clock_in_at limit 1) att on true
     where s.org_node_id = p_place and s.status = 'published'
       and s.start_at >= rpt.day_start(v_today, v_tz)
       and s.start_at < rpt.day_start(v_today + 1, v_tz)
     order by s.start_at, u.display_name;
end $$;

-- The person's own week (Monday to Sunday by business day): no one else's figures.
create function rpt.my_week(p_monday date)
returns table (measure text, value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, rpt
as $$
declare
  v_w hr.worker;
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  select * into v_w from hr.worker
   where owner_user_id = core.current_user_id() and status = 'active'
     and tenant_id = core.my_tenant();
  if v_w.id is null then
    raise exception 'INVALID_WORKER' using detail = 'you are not set up as a worker';
  end if;
  if p_monday is null or extract(isodow from p_monday) <> 1 then
    raise exception 'INVALID_WEEK' using detail = 'weeks start on a Monday';
  end if;
  v_tz := ops.tz_of(v_w.org_node_id);
  v_start := rpt.day_start(p_monday, v_tz);
  v_end := rpt.day_start(p_monday + 7, v_tz);
  return query
    with sh as (
      select s.id, s.start_at, s.end_at from hr.shift_assignment a
        join hr.shift s on s.id = a.shift_id and s.status = 'published'
       where a.worker_id = v_w.id and a.status = 'assigned'
         and s.start_at >= v_start and s.start_at < v_end
    ), ex as (
      select x.kind from hr.attendance_exception x
       where x.worker_id = v_w.id and x.status <> 'dismissed'
         and x.shift_id in (select id from sh)
    ), tk as (
      select t.status, t.completed_at, t.due_at from ops.task t
       where t.completed_by = v_w.owner_user_id
         and t.completed_at >= v_start and t.completed_at < v_end
    )
    select m.measure, m.value from (values
      ('shifts', (select count(*) from sh)::numeric),
      ('scheduled_hours', (select round(coalesce(sum(extract(epoch from end_at - start_at)) / 3600, 0), 2) from sh)),
      ('worked_hours', (select round(coalesce(sum(extract(epoch from x.clock_out_at - x.clock_in_at)) / 3600, 0), 2)
                          from hr.attendance x
                         where x.worker_id = v_w.id and x.clock_out_at is not null
                           and x.clock_in_at >= v_start and x.clock_in_at < v_end)),
      ('late', (select count(*) from ex where kind = 'late')::numeric),
      ('no_shows', (select count(*) from ex where kind = 'no_show')::numeric),
      ('on_time', (select count(*) from sh where sh.start_at < now()
                     and not exists (select 1 from hr.attendance_exception x
                                      where x.shift_id = sh.id and x.worker_id = v_w.id
                                        and x.kind in ('late', 'no_show')
                                        and x.status <> 'dismissed'))::numeric),
      ('tasks_done', (select count(*) from tk)::numeric),
      ('tasks_on_time', (select count(*) from tk where completed_at <= due_at)::numeric)
    ) m(measure, value);
end $$;

-- ---------------------------------------------------------------------------
-- RLS registration (rule 1), audit (rule 5), grants
-- ---------------------------------------------------------------------------

insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('rpt.store_day', 'STOCK_LEVELS', 'delivery', true),
  ('rpt.sales_day', 'SALES', 'delivery', true),
  ('rpt.labour_day', 'ATTENDANCE', 'org', true),
  ('rpt.task_day', 'TASKS', 'org', true);

do $$
declare t regclass;
begin
  foreach t in array array['rpt.store_day', 'rpt.sales_day', 'rpt.labour_day',
                           'rpt.task_day']::regclass[] loop
    perform core.apply_domain_rls(t);
    perform audit.enable(t);
  end loop;
end $$;

-- Rule 1 covers rpt too.
create or replace function core.rls_violations()
returns table (table_name text, problem text)
language sql stable
as $$
  with t as (
    select c.oid, c.oid::regclass::text as name, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('hr', 'inv', 'ops', 'wf', 'ai', 'menu', 'rpt')
       and c.relkind in ('r', 'p')
       and not c.relispartition
  )
  select name, 'rls_disabled' from t where not relrowsecurity
  union all
  select name, 'not_registered' from t
   where not exists (select 1 from core.domain_table dt where dt.table_name = t.oid)
  union all
  select name, 'no_generated_policies' from t
   where not exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polname like 'dom\_%')
  union all
  select name, 'hand_written_policy' from t
   where exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polname not like 'dom\_%')
  union all
  select name, 'no_audit_trigger' from t
   where not exists (select 1 from pg_trigger tg
                      where tg.tgrelid = t.oid and tg.tgfoid = 'audit.capture'::regproc)
$$;

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
  rpt.my_week(date), rpt.today(uuid) to app_rw;
grant execute on function rpt.nightly(), rpt.rebuild(date, date) to wf_executor;

-- migrate:down
create or replace function core.rls_violations()
returns table (table_name text, problem text)
language sql stable
as $$
  with t as (
    select c.oid, c.oid::regclass::text as name, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('hr', 'inv', 'ops', 'wf', 'ai', 'menu')
       and c.relkind in ('r', 'p')
       and not c.relispartition
  )
  select name, 'rls_disabled' from t where not relrowsecurity
  union all
  select name, 'not_registered' from t
   where not exists (select 1 from core.domain_table dt where dt.table_name = t.oid)
  union all
  select name, 'no_generated_policies' from t
   where not exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polname like 'dom\_%')
  union all
  select name, 'hand_written_policy' from t
   where exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polname not like 'dom\_%')
  union all
  select name, 'no_audit_trigger' from t
   where not exists (select 1 from pg_trigger tg
                      where tg.tgrelid = t.oid and tg.tgfoid = 'audit.capture'::regproc)
$$;
delete from core.domain_table where table_name::text like 'rpt.%';
drop schema rpt cascade;
