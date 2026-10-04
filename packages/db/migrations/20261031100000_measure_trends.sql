-- migrate:up

-- Every figure on a report opens its trend (RPT-12, ADR 041): rpt.measure_trend gives one
-- measure of one report at one place by day, week or month. By day it is the figure the
-- report shows for that day; by week or month money, hours and counts add up, a stock
-- value is the one at the end of the period, and percentages are worked out again from
-- what they are a share of. It opens where the report opens, and labour only for people
-- who see labour there.

-- A year by week or month starts on a Monday or the 1st: up to 400 days.
create or replace function rpt.periods(p_grain text, p_from date, p_to date)
returns setof date
language plpgsql immutable
set search_path = pg_catalog
as $$
begin
  if p_grain is null or p_grain not in ('day', 'week', 'month') then
    raise exception 'INVALID_GRAIN' using detail = 'by day, week or month';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start, a year at most';
  end if;
  return query
    select g::date from generate_series(date_trunc(p_grain, p_from::timestamp),
                                        date_trunc(p_grain, p_to::timestamp),
                                        ('1 ' || p_grain)::interval) g;
end $$;

-- The outlet's and the department's figures for each period, from the report tables for
-- the days the nightly rebuild has done and worked out live for yesterday and today, as
-- rpt.sales_of, stores_of, labour_of and tasks_of do for one day. Internal: the caller
-- has checked access. p_outlet is null for a department (no sales); p_labour_part is
-- null when the caller does not see labour.
create function rpt.team_trend(p_outlet uuid, p_places uuid[], p_stores uuid[], p_today date,
                               p_grain text, p_from date, p_to date, p_labour_outlet uuid,
                               p_labour_part text, p_labour_node uuid, p_prime boolean)
returns table (period date, measure text, value numeric)
language sql stable
set search_path = pg_catalog, core, menu, rpt
as $$
  with d as (
    select g::date as day, date_trunc(p_grain, g)::date as period
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
  ), s as (
    select x.business_date as day, x.menu, x.sales, x.theoretical_cost from rpt.sales_day x
     where p_outlet is not null and x.org_node_id = p_outlet
       and x.business_date between p_from and least(p_to, p_today - 2)
    union all
    select x.business_date, x.menu, x.sales, x.theoretical_cost
      from rpt.calc_sales_day(array[p_outlet], greatest(p_from, p_today - 1), p_to) x
     where p_outlet is not null and p_to >= p_today - 1
  ), sg as (
    select s.day, sum(s.sales) as sales,
           sum(s.sales) filter (where s.menu = 'Food') as food_sales,
           sum(s.theoretical_cost) filter (where s.menu = 'Food') as food_cost,
           sum(s.sales) filter (where s.menu = 'Bar') as bar_sales,
           sum(s.theoretical_cost) filter (where s.menu = 'Bar') as bar_cost
      from s group by s.day
  ), st as (
    select x.business_date as day, x.wastage, x.closing_value from rpt.store_day x
     where x.delivery_node_id = any (p_stores)
       and x.business_date between p_from and least(p_to, p_today - 2)
    union all
    select x.business_date, x.wastage, x.closing_value
      from rpt.calc_store_day(p_stores, greatest(p_from, p_today - 1), p_to) x
     where p_to >= p_today - 1
  ), stg as (
    select st.day, sum(st.wastage) as wastage, sum(st.closing_value) as closing
      from st group by st.day
  ), lb as (
    select x.business_date as day, x.shifts, x.slots, x.filled, x.scheduled_hours,
           x.worked_hours, x.late, x.no_shows from rpt.labour_day x
     where x.org_node_id = any (p_places)
       and x.business_date between p_from and least(p_to, p_today - 2)
    union all
    select x.business_date, x.shifts, x.slots, x.filled, x.scheduled_hours, x.worked_hours,
           x.late, x.no_shows
      from rpt.calc_labour_day(p_places, greatest(p_from, p_today - 1), p_to) x
     where p_to >= p_today - 1
  ), lbg as (
    select lb.day, sum(lb.shifts) as shifts, sum(lb.slots - lb.filled) as open_slots,
           sum(lb.scheduled_hours) as scheduled_hours, sum(lb.worked_hours) as worked_hours,
           sum(lb.late) as late, sum(lb.no_shows) as no_shows
      from lb group by lb.day
  ), tk as (
    select x.business_date as day, x.due, x.done, x.done_on_time, x.flagged, x.overdue
      from rpt.task_day x
     where x.org_node_id = any (p_places)
       and x.business_date between p_from and least(p_to, p_today - 2)
    union all
    select x.business_date, x.due, x.done, x.done_on_time, x.flagged, x.overdue
      from rpt.calc_task_day(p_places, greatest(p_from, p_today - 1), p_to) x
     where p_to >= p_today - 1
  ), tkg as (
    select tk.day, sum(tk.due) as due, sum(tk.done) as done, sum(tk.done_on_time) as on_time,
           sum(tk.flagged) as flagged, sum(tk.overdue) as overdue
      from tk group by tk.day
  ), lc as (
    -- labour cost of the outlet, or of the department, each day it had 3 or more paid people
    select l.business_date as day, sum(l.hourly_cost + l.salary_cost) as cost
      from rpt.labour_cost_of(p_labour_outlet, p_from, p_to) l
     where p_labour_part is not null and l.part = p_labour_part
       and (p_labour_node is null or l.org_node_id = p_labour_node)
     group by l.business_date
  ), daily as (
    select d.day, d.period,
           coalesce(sg.sales, 0) as sales, coalesce(sg.food_sales, 0) as food_sales,
           sg.food_cost, coalesce(sg.bar_sales, 0) as bar_sales, sg.bar_cost,
           coalesce(stg.wastage, 0) as wastage, coalesce(stg.closing, 0) as closing,
           coalesce(lbg.shifts, 0) as shifts, coalesce(lbg.open_slots, 0) as open_slots,
           coalesce(lbg.scheduled_hours, 0) as scheduled_hours,
           coalesce(lbg.worked_hours, 0) as worked_hours, coalesce(lbg.late, 0) as late,
           coalesce(lbg.no_shows, 0) as no_shows,
           coalesce(tkg.due, 0) as due, coalesce(tkg.done, 0) as done,
           coalesce(tkg.on_time, 0) as on_time, coalesce(tkg.flagged, 0) as flagged,
           coalesce(tkg.overdue, 0) as overdue, lc.cost as labour
      from d
      left join sg on sg.day = d.day
      left join stg on stg.day = d.day
      left join lbg on lbg.day = d.day
      left join tkg on tkg.day = d.day
      left join lc on lc.day = d.day
  ), p as (
    select x.period, max(x.day) as last_day, min(x.day) as first_day,
           sum(x.sales) as sales, sum(x.food_sales) as food_sales, sum(x.food_cost) as food_cost,
           sum(x.bar_sales) as bar_sales, sum(x.bar_cost) as bar_cost,
           sum(x.wastage) as wastage, sum(x.shifts) as shifts, sum(x.open_slots) as open_slots,
           sum(x.scheduled_hours) as scheduled_hours, sum(x.worked_hours) as worked_hours,
           sum(x.late) as late, sum(x.no_shows) as no_shows, sum(x.due) as due,
           sum(x.done) as done, sum(x.on_time) as on_time, sum(x.flagged) as flagged,
           sum(x.overdue) as overdue, sum(x.labour) as labour
      from daily x group by x.period
  ), pm as (
    -- materials for prime cost, over the whole period (as the cost breakdown works them out)
    select p.period,
           round(coalesce((select sum(c.recipe_cost + c.expired + c.transit_loss
                                      + c.wastage_other + c.other_use + c.count_loss)
                             from menu.cost_parts(p_outlet, p_stores, p.first_day, p.last_day) c),
                          0), 2) as materials
      from p where p_prime and p_outlet is not null
  )
  select p.period, m.measure, m.value
    from p
    left join daily e on e.day = p.last_day
    left join pm on pm.period = p.period
    cross join lateral (values
      ('sales', case when p_outlet is not null then p.sales end),
      ('food_sales', case when p_outlet is not null then p.food_sales end),
      ('bar_sales', case when p_outlet is not null then p.bar_sales end),
      ('food_cost_pct', round(p.food_cost * 100 / nullif(p.food_sales, 0), 1)),
      ('bar_cost_pct', round(p.bar_cost * 100 / nullif(p.bar_sales, 0), 1)),
      ('wastage', case when cardinality(p_stores) > 0 then p.wastage end),
      ('wastage_pct', case when p_outlet is not null and cardinality(p_stores) > 0
                           then round(p.wastage * 100 / nullif(p.sales, 0), 1) end),
      ('stock_value', case when cardinality(p_stores) > 0 then e.closing end),
      ('shifts', p.shifts::numeric), ('open_slots', p.open_slots::numeric),
      ('scheduled_hours', p.scheduled_hours), ('worked_hours', p.worked_hours),
      ('late', p.late::numeric), ('no_shows', p.no_shows::numeric),
      ('tasks_due', p.due::numeric), ('tasks_done', p.done::numeric),
      ('tasks_on_time', p.on_time::numeric),
      ('task_pct', round(p.on_time * 100.0 / nullif(p.due, 0), 1)),
      ('flagged', p.flagged::numeric), ('overdue', p.overdue::numeric),
      ('splh', case when p_outlet is not null
                    then round(p.sales / nullif(p.worked_hours, 0), 0) end),
      ('labour_cost', p.labour),
      ('labour_pct', round(p.labour * 100 / nullif(p.sales, 0), 1)),
      ('prime_cost', pm.materials + p.labour),
      ('prime_cost_pct', round((pm.materials + p.labour) * 100 / nullif(p.sales, 0), 1))
    ) m(measure, value)
$$;

-- One figure of a report over time. p_key picks a row of a list: a supplier on Purchasing,
-- a receiving store on the central kitchen's dispatch.
create function rpt.measure_trend(p_report text, p_node uuid, p_measure text, p_grain text,
                                  p_from date, p_to date, p_key uuid default null)
returns table (period date, value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, rpt
as $$
declare
  v_today date;
  v_outlet uuid;
  v_stores uuid[];
  v_labour boolean;
  v_end text := '1 ' || coalesce(p_grain, 'day');
  c_outlet constant text[] := array['sales', 'food_sales', 'bar_sales', 'food_cost_pct',
    'bar_cost_pct', 'wastage', 'wastage_pct', 'stock_value', 'scheduled_hours', 'worked_hours',
    'open_slots', 'late', 'no_shows', 'task_pct', 'tasks_due', 'tasks_done', 'overdue',
    'flagged', 'splh', 'labour_cost', 'labour_pct', 'prime_cost', 'prime_cost_pct'];
  c_sales constant text[] := array['sales', 'food_sales', 'bar_sales', 'food_cost_pct',
    'bar_cost_pct', 'wastage_pct', 'splh', 'labour_pct', 'prime_cost', 'prime_cost_pct'];
  c_labour constant text[] := array['labour_cost', 'labour_pct', 'prime_cost', 'prime_cost_pct'];
  c_department constant text[] := array['shifts', 'scheduled_hours', 'worked_hours',
    'open_slots', 'late', 'no_shows', 'labour_cost', 'task_pct', 'tasks_due', 'tasks_done',
    'tasks_on_time', 'overdue', 'flagged', 'wastage', 'stock_value'];
  c_cost constant text[] := array['food_sales', 'bar_sales', 'food_cost_pct', 'food_recipe_pct',
    'bar_cost_pct', 'bar_recipe_pct', 'count_loss', 'beyond_tolerance', 'wastage', 'expired'];
  c_people constant text[] := array['joiners', 'shifts', 'late', 'no_shows', 'on_time_pct',
    'worked_hours', 'overtime_hours', 'leave_days', 'swaps'];
  c_kitchen constant text[] := array['batches', 'made_value', 'ingredients_over',
    'expired_value', 'expired_pct', 'transfers', 'requested_value', 'dispatched_value',
    'fill_pct', 'transit_loss'];
  c_dispatch constant text[] := array['transfers', 'requested_value', 'dispatched_value',
    'received_value', 'fill_pct', 'transit_loss'];
  c_supplier constant text[] := array['orders', 'ordered_value', 'received_value', 'fill_pct',
    'late', 'not_delivered'];
begin
  -- the grain and the period first (rpt.periods says what is wrong with them)
  perform 1 from rpt.periods(p_grain, p_from, p_to) limit 1;
  if p_report is null or p_measure is null
     or not (case p_report
               when 'outlet_flash' then p_measure = any (c_outlet) and p_key is null
               when 'department' then p_measure = any (c_department) and p_key is null
               when 'cost_of_sales' then p_measure = any (c_cost) and p_key is null
               when 'people' then p_measure = any (c_people) and p_key is null
               when 'central_kitchen' then
                 case when p_key is null then p_measure = any (c_kitchen)
                      else p_measure = any (c_dispatch) end
               when 'stock_position' then p_measure = 'stock_value' and p_key is null
               when 'purchasing' then p_measure = any (c_supplier) and p_key is not null
               else false end) then
    raise exception 'INVALID_MEASURE' using detail = format('%s on %s', p_measure, p_report);
  end if;
  perform rpt.require(p_report, p_node);
  v_today := rpt.today(p_node);
  if p_to > v_today then
    raise exception 'INVALID_DATE' using detail = 'today or an earlier day';
  end if;

  if p_report = 'outlet_flash' then
    if p_measure = any (c_sales) then
      perform core.require_module('menu_sales');
    end if;
    v_labour := rpt.can_open('labour_cost', p_node);
    if p_measure = any (c_labour) and not v_labour then
      raise exception 'NOT_AUTHORISED' using detail = format('labour_cost at %s', p_node);
    end if;
    return query
      select t.period, t.value
        from rpt.team_trend(p_node, rpt.outlet_team_places(p_node), rpt.outlet_stores(p_node),
                            v_today, p_grain, p_from, p_to, p_node,
                            case when v_labour then 'outlet' end, null,
                            p_measure in ('prime_cost', 'prime_cost_pct')) t
       where t.measure = p_measure
       order by t.period;
  elsif p_report = 'department' then
    -- the stores and the labour the department report shows (rpt.department_day)
    select coalesce(array_agg(s), '{}') into v_stores from unnest(rpt.team_stores(p_node)) s
     where core.can('REPORTS', 'view', p_node, null)
        or core.can('STOCK_LEVELS', 'view', null, s);
    v_outlet := core.nearest(p_node, array['outlet', 'site']);
    v_labour := v_outlet is not null
                and (core.can('REPORTS', 'view', p_node, null)
                     or core.can('LABOUR_COST', 'view', p_node, null));
    if p_measure = 'labour_cost' and not v_labour then
      raise exception 'NOT_AUTHORISED' using detail = format('labour_cost at %s', p_node);
    end if;
    if p_measure in ('wastage', 'stock_value') and cardinality(v_stores) = 0 then
      raise exception 'NOT_AUTHORISED' using detail = format('stock at %s', p_node);
    end if;
    return query
      select t.period, t.value
        from rpt.team_trend(null, array[p_node], v_stores, v_today, p_grain, p_from, p_to,
                            v_outlet, case when v_labour then 'department' end, p_node, false) t
       where t.measure = p_measure
       order by t.period;
  elsif p_report = 'stock_position' then
    return query
      select t.period, t.value
        from rpt.team_trend(null, '{}', rpt.stock_stores(p_node), v_today, p_grain, p_from,
                            p_to, null, null, null, false) t
       where t.measure = 'stock_value'
       order by t.period;
  else
    -- the period reports: the report itself over each period (it checks access again)
    return query
      with pr as (
        select g as period, greatest(g, p_from) as f,
               least((g + v_end::interval)::date - 1, p_to) as t
          from rpt.periods(p_grain, p_from, p_to) g
      )
      select pr.period,
             case p_report
               when 'cost_of_sales' then
                 (select x.value from rpt.cost_totals(p_node, pr.f, pr.t) x
                   where x.measure = p_measure)
               when 'people' then
                 (select x.value from rpt.people_summary(p_node, pr.f, pr.t) x
                   where x.measure = p_measure)
               when 'central_kitchen' then
                 case when p_key is null then
                   (select x.value from rpt.kitchen_summary(p_node, pr.f, pr.t) x
                     where x.measure = p_measure)
                 else
                   (select case p_measure
                             when 'transfers' then x.transfers::numeric
                             when 'requested_value' then x.requested_value
                             when 'dispatched_value' then x.dispatched_value
                             when 'received_value' then x.received_value
                             when 'fill_pct' then x.fill_pct
                             when 'transit_loss' then x.transit_loss end
                      from rpt.kitchen_dispatch(p_node, pr.f, pr.t) x where x.store_id = p_key)
                 end
               when 'purchasing' then
                 (select case p_measure
                           when 'orders' then x.orders::numeric
                           when 'ordered_value' then x.ordered_value
                           when 'received_value' then x.received_value
                           when 'fill_pct' then x.fill_pct
                           when 'late' then x.late::numeric
                           when 'not_delivered' then x.not_delivered::numeric end
                    from rpt.supplier_fill(p_node, pr.f, pr.t) x where x.supplier_id = p_key)
             end
        from pr
       order by pr.period;
  end if;
end $$;

revoke execute on function rpt.team_trend(uuid, uuid[], uuid[], date, text, date, date, uuid,
  text, uuid, boolean) from public;
revoke execute on function rpt.measure_trend(text, uuid, text, text, date, date, uuid) from public;
grant execute on function rpt.measure_trend(text, uuid, text, text, date, date, uuid) to app_rw;

-- migrate:down

revoke execute on function rpt.measure_trend(text, uuid, text, text, date, date, uuid) from app_rw;
drop function rpt.measure_trend(text, uuid, text, text, date, date, uuid);
drop function rpt.team_trend(uuid, uuid[], uuid[], date, text, date, date, uuid, text, uuid,
  boolean);

create or replace function rpt.periods(p_grain text, p_from date, p_to date)
returns setof date
language plpgsql immutable
set search_path = pg_catalog
as $$
begin
  if p_grain is null or p_grain not in ('day', 'week', 'month') then
    raise exception 'INVALID_GRAIN' using detail = 'by day, week or month';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start, a year at most';
  end if;
  return query
    select g::date from generate_series(date_trunc(p_grain, p_from::timestamp),
                                        date_trunc(p_grain, p_to::timestamp),
                                        ('1 ' || p_grain)::interval) g;
end $$;
