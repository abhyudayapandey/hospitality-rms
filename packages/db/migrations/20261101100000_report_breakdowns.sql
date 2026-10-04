-- migrate:up

-- What management asks after a figure (owner review, 4 Oct; ADR 042).
--
-- 1. People cost % and Materials % are shares of the total cost (materials + people), not
--    of sales: they add up to 100, and prime cost is the total in ₹. The people cost
--    target is a share of cost too (default 50%); there is no prime cost target.
-- 2. Each figure opens what is behind it, for a week or a month: the dishes behind sales
--    and recipe cost, the items behind wastage and the stock value, the people behind
--    hours, late and no-shows, their tasks, and the readings that were flagged. Each
--    breakdown adds up to the report's figure and opens where the report opens; names of
--    people only for those who see the team (WORKERS) or every report (REPORTS).

-- Replaces one exact piece of a function's source, or fails: the source must be the one
-- this migration was written against.
create function pg_temp.patch(p_fn regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare
  v text := pg_get_functiondef(p_fn);
  n int := (length(v) - length(replace(v, p_old, ''))) / length(p_old);
begin
  if n <> 1 then
    raise exception 'patching %: expected 1 match, found %', p_fn, n;
  end if;
  execute replace(v, p_old, p_new);
end $$;

-- 1a. Outlet today: people and materials as shares of the total cost.
select pg_temp.patch('rpt.outlet_flash(uuid,date)',
$o$      select s.k, 'labour_pct', round(l.value * 100 / nullif(s.value, 0), 1)
        from sm s join lm l on l.k = s.k and l.measure = 'labour_cost' where s.measure = 'sales'$o$,
$n$      select c.k, 'labour_pct', round(l.value * 100 / nullif(c.value + l.value, 0), 1)
        from cm c join lm l on l.k = c.k and l.measure = 'labour_cost'
       where c.measure = 'cost_materials'$n$);
select pg_temp.patch('rpt.outlet_flash(uuid,date)',
$o$      select c.k, 'prime_cost_pct', round((c.value + l.value) * 100 / nullif(s.value, 0), 1)
        from cm c join lm l on l.k = c.k and l.measure = 'labour_cost'
        join sm s on s.k = c.k and s.measure = 'sales'
       where c.measure = 'cost_materials'$o$,
$n$      select c.k, 'materials_pct', round(c.value * 100 / nullif(c.value + l.value, 0), 1)
        from cm c join lm l on l.k = c.k and l.measure = 'labour_cost'
       where c.measure = 'cost_materials'$n$);

-- 1b. The cost breakdown: each part as a share of the total cost the person sees.
select pg_temp.patch('rpt.cost_breakdown(uuid,date,date)',
$o$    select p.part, round(p.value, 2), round(p.value * 100 / nullif((select s.sales from s), 0), 1)$o$,
$n$    select p.part, round(p.value, 2),
           round(p.value * 100 / nullif((select s.materials
                                                + case when v_labour
                                                       then coalesce(l.hourly, 0) + coalesce(l.salary, 0)
                                                       else 0 end
                                           from s, l), 0), 1)$n$);

-- 1c. The trend of a figure: the same shares, period by period.
select pg_temp.patch('rpt.team_trend(uuid,uuid[],uuid[],date,text,date,date,uuid,text,uuid,boolean)',
$o$      ('labour_pct', round(p.labour * 100 / nullif(p.sales, 0), 1)),
      ('prime_cost', pm.materials + p.labour),
      ('prime_cost_pct', round((pm.materials + p.labour) * 100 / nullif(p.sales, 0), 1))$o$,
$n$      ('labour_pct', round(p.labour * 100 / nullif(pm.materials + p.labour, 0), 1)),
      ('prime_cost', pm.materials + p.labour),
      ('materials_pct', round(pm.materials * 100 / nullif(pm.materials + p.labour, 0), 1))$n$);
select pg_temp.patch('rpt.measure_trend(text,uuid,text,text,date,date,uuid)',
$o$    'flagged', 'splh', 'labour_cost', 'labour_pct', 'prime_cost', 'prime_cost_pct'];$o$,
$n$    'flagged', 'splh', 'labour_cost', 'labour_pct', 'prime_cost', 'materials_pct'];$n$);
select pg_temp.patch('rpt.measure_trend(text,uuid,text,text,date,date,uuid)',
$o$    'bar_cost_pct', 'wastage_pct', 'splh', 'labour_pct', 'prime_cost', 'prime_cost_pct'];$o$,
$n$    'bar_cost_pct', 'wastage_pct', 'splh', 'labour_pct', 'prime_cost', 'materials_pct'];$n$);
select pg_temp.patch('rpt.measure_trend(text,uuid,text,text,date,date,uuid)',
$o$  c_labour constant text[] := array['labour_cost', 'labour_pct', 'prime_cost', 'prime_cost_pct'];$o$,
$n$  c_labour constant text[] := array['labour_cost', 'labour_pct', 'prime_cost', 'materials_pct'];$n$);
select pg_temp.patch('rpt.measure_trend(text,uuid,text,text,date,date,uuid)',
$o$                            p_measure in ('prime_cost', 'prime_cost_pct')) t$o$,
$n$                            p_measure in ('prime_cost', 'labour_pct', 'materials_pct')) t$n$);

-- 1d. Outlets side by side: people and materials as shares of each outlet's total cost.
do $$
declare
  v text := pg_get_functiondef('rpt.league(uuid,date,date)'::regprocedure);
begin
  if position('labour_pct numeric, prime_pct numeric' in v) = 0
     or position('round((m.materials + l.labour) * 100 / nullif(s.sales, 0), 1),' in v) = 0 then
    raise exception 'rpt.league is not the source this migration was written against';
  end if;
  v := replace(v, 'labour_pct numeric, prime_pct numeric', 'labour_pct numeric, materials_pct numeric');
  v := replace(v, 'round(l.labour * 100 / nullif(s.sales, 0), 1),',
                  'round(l.labour * 100 / nullif(m.materials + l.labour, 0), 1),');
  v := replace(v, 'round((m.materials + l.labour) * 100 / nullif(s.sales, 0), 1),',
                  'round(m.materials * 100 / nullif(m.materials + l.labour, 0), 1),');
  drop function rpt.league(uuid, date, date);
  execute v;
end $$;
revoke execute on function rpt.league(uuid, date, date) from public;
grant execute on function rpt.league(uuid, date, date) to app_rw;

-- 1e. Targets: people cost is a share of cost; no prime cost target. A company's people
-- target set against sales means something else now, so it starts again at the default.
select pg_temp.patch('core.settings_defaults()',
$o$'targets', jsonb_build_object('food', 30, 'drink', 22, 'labour', 25, 'prime', 60,
                                  'wastage', 2, 'tasks', 90),$o$,
$n$'targets', jsonb_build_object('food', 30, 'drink', 22, 'labour', 50,
                                  'wastage', 2, 'tasks', 90),$n$);
select pg_temp.patch('core.set_company_settings(jsonb)',
$o$        if v_target not in ('food', 'drink', 'labour', 'prime', 'wastage', 'tasks')$o$,
$n$        if v_target not in ('food', 'drink', 'labour', 'wastage', 'tasks')$n$);
update core.tenant
   set settings = jsonb_set(settings #- '{targets,prime}', '{targets,labour}', '50')
 where settings -> 'targets' ? 'labour' or settings -> 'targets' ? 'prime';

-- 2. Breakdowns. Each takes the report it was opened from and the place, checks the
-- report opens there, and works on that report's places and stores.

-- The places (teams) and stores of a report at a place, once the report opens there.
create function rpt.bd_scope(p_report text, p_node uuid, p_reports text[],
                             out places uuid[], out stores uuid[])
language plpgsql stable
set search_path = pg_catalog, core, rpt
as $$
begin
  if p_report is null or not (p_report = any (p_reports)) then
    raise exception 'INVALID_REPORT' using detail = format('%s has no such breakdown', p_report);
  end if;
  perform rpt.require(p_report, p_node);
  case p_report
    when 'outlet_flash' then
      places := rpt.outlet_team_places(p_node);
      stores := rpt.outlet_stores(p_node);
    when 'department' then
      places := array[p_node];
      -- the stores the department report shows (rpt.department_day)
      select coalesce(array_agg(s), '{}') into stores from unnest(rpt.team_stores(p_node)) s
       where core.can('REPORTS', 'view', p_node, null)
          or core.can('STOCK_LEVELS', 'view', null, s);
    when 'cost_of_sales' then
      places := '{}';
      stores := rpt.cost_stores(p_node);
    when 'stock_position' then
      places := '{}';
      stores := rpt.stock_stores(p_node);
    when 'people' then
      select coalesce(array_agg(h.id), '{}') into places
        from core.hierarchy_node p join core.hierarchy_node h
          on h.type = 'org' and h.path operator(extensions.<@) p.path
       where p.id = p_node;
      stores := '{}';
  end case;
end $$;

-- Names of people only for those who see the team or every report at the place.
create function rpt.bd_require_people(p_node uuid) returns void
language plpgsql stable
set search_path = pg_catalog, core
as $$
begin
  if not (core.can('WORKERS', 'view', p_node, null) or core.can('REPORTS', 'view', p_node, null)) then
    raise exception 'NOT_AUTHORISED' using detail = format('the team at %s', p_node);
  end if;
end $$;

-- Sales and recipe cost by dish. Recipe cost is what the day's sales took from each store,
-- shared between the dishes sold from it by their sales, as rpt.calc_sales_day shares it
-- between food and drinks, so the dishes add up to the report.
create function rpt.bd_dishes(p_report text, p_node uuid, p_from date, p_to date)
returns table (menu text, dish text, qty numeric, sales numeric, cost numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, menu, rpt
as $$
begin
  perform rpt.bd_scope(p_report, p_node, array['outlet_flash', 'cost_of_sales']);
  perform core.require_module('menu_sales');
  perform rpt.check_period(p_from, p_to);
  return query
    with sold as (
      select sd.id as day_id, sd.business_date, sl.delivery_node_id as store, mi.menu, mi.name,
             sum(coalesce(sl.net, sl.qty * sl.price)) as revenue, sum(sl.qty) as qty
        from menu.sales_day sd
        join menu.sales_line sl on sl.sales_day_id = sd.id
        join menu.menu_item mi on mi.id = sl.menu_item_id
       where sd.org_node_id = p_node and sd.business_date between p_from and p_to
       group by 1, 2, 3, 4, 5
    ), depleted as (
      select l.ref_id as day_id, l.delivery_node_id as store, sum(-l.qty * l.unit_cost) as cost
        from inv.stock_ledger l
       where l.ref_type = 'sales_day' and l.ref_id in (select s.day_id from sold s)
       group by 1, 2
    ), shared as (
      select s.*, s.revenue / nullif(sum(s.revenue) over (partition by s.day_id, s.store), 0)
               as share
        from sold s
    )
    select s.menu, s.name, sum(s.qty), round(sum(s.revenue), 2),
           round(sum(coalesce(d.cost, 0) * coalesce(s.share, 0)), 2)
      from shared s
      left join depleted d on d.day_id = s.day_id and d.store = s.store
     group by s.menu, s.name
     order by sum(s.revenue) desc, s.name;
end $$;

-- What was thrown away, by item, store and reason: how much, what it cost, who recorded it.
create function rpt.bd_wastage(p_report text, p_node uuid, p_from date, p_to date)
returns table (item text, unit text, store text, reason text, qty numeric, value numeric,
               entries int, recorded_by text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
declare
  v_stores uuid[];
begin
  select s.stores into v_stores
    from rpt.bd_scope(p_report, p_node, array['outlet_flash', 'department', 'cost_of_sales']) s;
  perform rpt.check_period(p_from, p_to);
  return query
    select i.name, i.base_uom, n.name, coalesce(l.reason, 'other'),
           round(sum(-l.qty), 3), round(sum(-l.qty * l.unit_cost), 2), count(*)::int,
           string_agg(distinct coalesce(u.display_name, '–'), ', ')
      from unnest(v_stores) st(id)
      join core.hierarchy_node n on n.id = st.id
      join inv.stock_ledger l on l.delivery_node_id = st.id and l.movement_type = 'wastage'
      join inv.item i on i.id = l.item_id
      left join core.app_user u on u.id = l.created_by
     where l.occurred_at >= rpt.day_start(p_from, ops.tz_of(st.id))
       and l.occurred_at < rpt.day_start(p_to + 1, ops.tz_of(st.id))
     group by i.name, i.base_uom, n.name, coalesce(l.reason, 'other')
     order by sum(-l.qty * l.unit_cost) desc, i.name;
end $$;

-- What the stores hold now, by item, at its average cost.
create function rpt.bd_stock(p_report text, p_node uuid)
returns table (item text, category text, store text, qty numeric, unit text, value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, rpt
as $$
declare
  v_stores uuid[];
begin
  select s.stores into v_stores
    from rpt.bd_scope(p_report, p_node, array['outlet_flash', 'department', 'stock_position']) s;
  return query
    select x.name, x.category, n.name, x.on_hand, x.unit, round(x.value, 2)
      from unnest(v_stores) st(id)
      join core.hierarchy_node n on n.id = st.id
      cross join lateral rpt.store_items(st.id) x
     where x.on_hand <> 0
     order by x.value desc, x.name;
end $$;

-- Each person's shifts, rostered and worked hours, late and no-shows at the report's
-- places, from the sources rpt.calc_labour_day adds up.
create function rpt.bd_people(p_report text, p_node uuid, p_from date, p_to date)
returns table (person text, job text, shifts int, rostered_hours numeric, worked_hours numeric,
               late int, no_shows int)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, rpt
as $$
declare
  v_places uuid[];
begin
  select s.places into v_places
    from rpt.bd_scope(p_report, p_node, array['outlet_flash', 'department', 'people']) s;
  perform rpt.bd_require_people(p_node);
  perform rpt.check_period(p_from, p_to);
  return query
    with p as (
      select n.id, ops.tz_of(n.id) as tz from core.hierarchy_node n where n.id = any (v_places)
    ), sh as (
      select a.worker_id, count(*)::int as shifts,
             sum(extract(epoch from s.end_at - s.start_at) / 3600) as hours
        from p
        join hr.shift s on s.org_node_id = p.id and s.status = 'published'
        join hr.shift_assignment a on a.shift_id = s.id and a.status = 'assigned'
       where s.start_at >= rpt.day_start(p_from, p.tz) and s.start_at < rpt.day_start(p_to + 1, p.tz)
       group by 1
    ), wk as (
      select a.worker_id, sum(extract(epoch from a.clock_out_at - a.clock_in_at) / 3600) as hours
        from p join hr.attendance a on a.org_node_id = p.id and a.clock_out_at is not null
       where a.clock_in_at >= rpt.day_start(p_from, p.tz)
         and a.clock_in_at < rpt.day_start(p_to + 1, p.tz)
       group by 1
    ), ex as (
      select x.worker_id,
             count(*) filter (where x.kind = 'late')::int as late,
             count(*) filter (where x.kind = 'no_show')::int as no_shows
        from p join hr.attendance_exception x on x.org_node_id = p.id
        left join hr.shift s on s.id = x.shift_id
       where x.status <> 'dismissed' and x.kind in ('late', 'no_show')
         and coalesce(rpt.business_date(s.start_at, p.tz), x.local_date) between p_from and p_to
       group by 1
    ), who as (
      select worker_id from sh union select worker_id from wk union select worker_id from ex
    )
    select coalesce(u.display_name, '–'), coalesce(jr.name, w.role_code),
           coalesce(sh.shifts, 0), round(coalesce(sh.hours, 0), 2), round(coalesce(wk.hours, 0), 2),
           coalesce(ex.late, 0), coalesce(ex.no_shows, 0)
      from who
      join hr.worker w on w.id = who.worker_id
      left join core.app_user u on u.id = w.owner_user_id
      left join hr.job_role jr on jr.tenant_id = w.tenant_id and jr.code = w.role_code
      left join sh on sh.worker_id = who.worker_id
      left join wk on wk.worker_id = who.worker_id
      left join ex on ex.worker_id = who.worker_id
     order by coalesce(ex.late, 0) + coalesce(ex.no_shows, 0) desc,
              coalesce(wk.hours, 0) desc, u.display_name;
end $$;

-- Each person's tasks due at the report's places: done on time, overdue, readings flagged.
-- A task is the assignee's, else whoever did it; a task for a job role nobody did yet is
-- "Not done yet (role)".
create function rpt.bd_tasks(p_report text, p_node uuid, p_from date, p_to date)
returns table (person text, due int, done int, on_time int, overdue int, flagged int)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, rpt
as $$
declare
  v_places uuid[];
begin
  select s.places into v_places
    from rpt.bd_scope(p_report, p_node, array['outlet_flash', 'department']) s;
  perform rpt.bd_require_people(p_node);
  perform rpt.check_period(p_from, p_to);
  return query
    with p as (
      select n.id, ops.tz_of(n.id) as tz from core.hierarchy_node n where n.id = any (v_places)
    ), t as (
      select t.*, p.tz,
             coalesce(u.display_name,
                      'Not done yet' || coalesce(' (' || coalesce(jr.name, t.job_role_code) || ')', ''))
               as who
        from p
        join ops.task t on t.org_node_id = p.id and t.status not in ('reported', 'cancelled')
        left join core.app_user u on u.id = coalesce(t.assignee_user_id, t.completed_by)
        left join hr.job_role jr on jr.tenant_id = t.tenant_id and jr.code = t.job_role_code
       where t.due_at >= rpt.day_start(p_from, p.tz) and t.due_at < rpt.day_start(p_to + 1, p.tz)
    )
    select t.who, count(*)::int,
           count(*) filter (where t.status = 'done')::int,
           count(*) filter (where t.status = 'done' and t.completed_at <= t.due_at)::int,
           count(*) filter (where t.status <> 'done' or t.completed_at
                              >= rpt.day_start(rpt.business_date(t.due_at, t.tz) + 1, t.tz))::int,
           coalesce(sum((select count(*) from ops.task_step st
                          where st.task_id = t.id and st.flagged)), 0)::int
      from t
     group by t.who
     order by count(*) filter (where t.status = 'done' and t.completed_at <= t.due_at)::numeric
              / nullif(count(*), 0), t.who;
end $$;

-- The readings flagged out of range in tasks due at the report's places.
create function rpt.bd_readings(p_report text, p_node uuid, p_from date, p_to date)
returns table (done_at timestamptz, task text, reading text, value text, allowed text,
               by_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
declare
  v_places uuid[];
begin
  select s.places into v_places
    from rpt.bd_scope(p_report, p_node, array['outlet_flash', 'department']) s;
  perform rpt.bd_require_people(p_node);
  perform rpt.check_period(p_from, p_to);
  return query
    select st.done_at, t.title, st.label,
           coalesce(trim_scale(st.value_num)::text || coalesce(' ' || st.unit, ''), st.value_text, '–'),
           case when st.min_value is not null or st.max_value is not null
                then coalesce(trim_scale(st.min_value)::text, '…') || ' to '
                     || coalesce(trim_scale(st.max_value)::text, '…') || coalesce(' ' || st.unit, '')
           end,
           coalesce(u.display_name, '–')
      from unnest(v_places) pl(id)
      join ops.task t on t.org_node_id = pl.id and t.status not in ('reported', 'cancelled')
      join ops.task_step st on st.task_id = t.id and st.flagged
      left join core.app_user u on u.id = st.done_by
     where t.due_at >= rpt.day_start(p_from, ops.tz_of(pl.id))
       and t.due_at < rpt.day_start(p_to + 1, ops.tz_of(pl.id))
     order by st.done_at desc nulls last;
end $$;

revoke execute on function rpt.bd_scope(text, uuid, text[]), rpt.bd_require_people(uuid)
  from public;
revoke execute on function rpt.bd_dishes(text, uuid, date, date),
  rpt.bd_wastage(text, uuid, date, date), rpt.bd_stock(text, uuid),
  rpt.bd_people(text, uuid, date, date), rpt.bd_tasks(text, uuid, date, date),
  rpt.bd_readings(text, uuid, date, date) from public;
grant execute on function rpt.bd_dishes(text, uuid, date, date),
  rpt.bd_wastage(text, uuid, date, date), rpt.bd_stock(text, uuid),
  rpt.bd_people(text, uuid, date, date), rpt.bd_tasks(text, uuid, date, date),
  rpt.bd_readings(text, uuid, date, date) to app_rw;

-- migrate:down

create function pg_temp.patch(p_fn regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare
  v text := pg_get_functiondef(p_fn);
  n int := (length(v) - length(replace(v, p_old, ''))) / length(p_old);
begin
  if n <> 1 then
    raise exception 'patching %: expected 1 match, found %', p_fn, n;
  end if;
  execute replace(v, p_old, p_new);
end $$;

drop function rpt.bd_readings(text, uuid, date, date);
drop function rpt.bd_tasks(text, uuid, date, date);
drop function rpt.bd_people(text, uuid, date, date);
drop function rpt.bd_stock(text, uuid);
drop function rpt.bd_wastage(text, uuid, date, date);
drop function rpt.bd_dishes(text, uuid, date, date);
drop function rpt.bd_require_people(uuid);
drop function rpt.bd_scope(text, uuid, text[]);

-- the companies' targets keep the defaults the up section put back
select pg_temp.patch('core.set_company_settings(jsonb)',
$n$        if v_target not in ('food', 'drink', 'labour', 'wastage', 'tasks')$n$,
$o$        if v_target not in ('food', 'drink', 'labour', 'prime', 'wastage', 'tasks')$o$);
select pg_temp.patch('core.settings_defaults()',
$n$'targets', jsonb_build_object('food', 30, 'drink', 22, 'labour', 50,
                                  'wastage', 2, 'tasks', 90),$n$,
$o$'targets', jsonb_build_object('food', 30, 'drink', 22, 'labour', 25, 'prime', 60,
                                  'wastage', 2, 'tasks', 90),$o$);

do $$
declare
  v text := pg_get_functiondef('rpt.league(uuid,date,date)'::regprocedure);
begin
  v := replace(v, 'labour_pct numeric, materials_pct numeric', 'labour_pct numeric, prime_pct numeric');
  v := replace(v, 'round(l.labour * 100 / nullif(m.materials + l.labour, 0), 1),',
                  'round(l.labour * 100 / nullif(s.sales, 0), 1),');
  v := replace(v, 'round(m.materials * 100 / nullif(m.materials + l.labour, 0), 1),',
                  'round((m.materials + l.labour) * 100 / nullif(s.sales, 0), 1),');
  drop function rpt.league(uuid, date, date);
  execute v;
end $$;
revoke execute on function rpt.league(uuid, date, date) from public;
grant execute on function rpt.league(uuid, date, date) to app_rw;

select pg_temp.patch('rpt.measure_trend(text,uuid,text,text,date,date,uuid)',
$n$                            p_measure in ('prime_cost', 'labour_pct', 'materials_pct')) t$n$,
$o$                            p_measure in ('prime_cost', 'prime_cost_pct')) t$o$);
select pg_temp.patch('rpt.measure_trend(text,uuid,text,text,date,date,uuid)',
$n$  c_labour constant text[] := array['labour_cost', 'labour_pct', 'prime_cost', 'materials_pct'];$n$,
$o$  c_labour constant text[] := array['labour_cost', 'labour_pct', 'prime_cost', 'prime_cost_pct'];$o$);
select pg_temp.patch('rpt.measure_trend(text,uuid,text,text,date,date,uuid)',
$n$    'bar_cost_pct', 'wastage_pct', 'splh', 'labour_pct', 'prime_cost', 'materials_pct'];$n$,
$o$    'bar_cost_pct', 'wastage_pct', 'splh', 'labour_pct', 'prime_cost', 'prime_cost_pct'];$o$);
select pg_temp.patch('rpt.measure_trend(text,uuid,text,text,date,date,uuid)',
$n$    'flagged', 'splh', 'labour_cost', 'labour_pct', 'prime_cost', 'materials_pct'];$n$,
$o$    'flagged', 'splh', 'labour_cost', 'labour_pct', 'prime_cost', 'prime_cost_pct'];$o$);
select pg_temp.patch('rpt.team_trend(uuid,uuid[],uuid[],date,text,date,date,uuid,text,uuid,boolean)',
$n$      ('labour_pct', round(p.labour * 100 / nullif(pm.materials + p.labour, 0), 1)),
      ('prime_cost', pm.materials + p.labour),
      ('materials_pct', round(pm.materials * 100 / nullif(pm.materials + p.labour, 0), 1))$n$,
$o$      ('labour_pct', round(p.labour * 100 / nullif(p.sales, 0), 1)),
      ('prime_cost', pm.materials + p.labour),
      ('prime_cost_pct', round((pm.materials + p.labour) * 100 / nullif(p.sales, 0), 1))$o$);

select pg_temp.patch('rpt.cost_breakdown(uuid,date,date)',
$n$    select p.part, round(p.value, 2),
           round(p.value * 100 / nullif((select s.materials
                                                + case when v_labour
                                                       then coalesce(l.hourly, 0) + coalesce(l.salary, 0)
                                                       else 0 end
                                           from s, l), 0), 1)$n$,
$o$    select p.part, round(p.value, 2), round(p.value * 100 / nullif((select s.sales from s), 0), 1)$o$);

select pg_temp.patch('rpt.outlet_flash(uuid,date)',
$n$      select c.k, 'materials_pct', round(c.value * 100 / nullif(c.value + l.value, 0), 1)
        from cm c join lm l on l.k = c.k and l.measure = 'labour_cost'
       where c.measure = 'cost_materials'$n$,
$o$      select c.k, 'prime_cost_pct', round((c.value + l.value) * 100 / nullif(s.value, 0), 1)
        from cm c join lm l on l.k = c.k and l.measure = 'labour_cost'
        join sm s on s.k = c.k and s.measure = 'sales'
       where c.measure = 'cost_materials'$o$);
select pg_temp.patch('rpt.outlet_flash(uuid,date)',
$n$      select c.k, 'labour_pct', round(l.value * 100 / nullif(c.value + l.value, 0), 1)
        from cm c join lm l on l.k = c.k and l.measure = 'labour_cost'
       where c.measure = 'cost_materials'$n$,
$o$      select s.k, 'labour_pct', round(l.value * 100 / nullif(s.value, 0), 1)
        from sm s join lm l on l.k = s.k and l.measure = 'labour_cost' where s.measure = 'sales'$o$);
