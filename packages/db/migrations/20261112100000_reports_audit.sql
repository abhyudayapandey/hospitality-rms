-- migrate:up
-- Reports audit (ADR 057): one meaning per figure, the drill-down adds up to it, one business
-- day everywhere, and nothing a report hides is shown behind it.

create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare
  v_def text := pg_get_functiondef(p_fn);
  v_new text := replace(v_def, p_old, p_new);
begin
  if v_new = v_def then
    raise exception 'audit patch did not apply to %: %', p_fn, left(p_old, 80);
  end if;
  execute v_new;
end $$;

-- 1. Shifts are the shifts someone is on: one per person assigned (an open slot is not a shift
--    worked; it is counted under open slots). Department, outlet, the trends, Home's "On shift
--    today", the people list behind them and My week now agree.
select pg_temp.patch('rpt.calc_labour_day(uuid[], date, date)',
  $o$rpt.business_date(s.start_at, p.tz) as day, count(*)::int as shifts,$o$,
  $n$rpt.business_date(s.start_at, p.tz) as day, sum(a.n)::int as shifts,$n$);

-- 2. Tasks today count only what has come due: a task due at 18:00 is not "due", "overdue" or
--    against the on-time share at 09:00 unless it is already done.
select pg_temp.patch('rpt.calc_task_day(uuid[], date, date)',
  $o$     where t.due_at >= rpt.day_start(p_from, p.tz) and t.due_at < rpt.day_start(p_to + 1, p.tz)
     group by 1, 2$o$,
  $n$     where t.due_at >= rpt.day_start(p_from, p.tz) and t.due_at < rpt.day_start(p_to + 1, p.tz)
       and (t.status = 'done' or t.due_at <= now())
     group by 1, 2$n$);
select pg_temp.patch('rpt.bd_tasks(text, uuid, date, date)',
  $o$       where t.due_at >= rpt.day_start(p_from, p.tz) and t.due_at < rpt.day_start(p_to + 1, p.tz)
    )$o$,
  $n$       where t.due_at >= rpt.day_start(p_from, p.tz) and t.due_at < rpt.day_start(p_to + 1, p.tz)
         and (t.status = 'done' or t.due_at <= now())
    )$n$);
select pg_temp.patch('rpt.bd_readings(text, uuid, date, date)',
  $o$       and t.due_at < rpt.day_start(p_to + 1, ops.tz_of(pl.id))$o$,
  $n$       and t.due_at < rpt.day_start(p_to + 1, ops.tz_of(pl.id))
       and (t.status = 'done' or t.due_at <= now())$n$);

-- 3. The People report: the people who belong to the place, wherever they worked. Shifts are
--    every shift they are on in the period, by the business day it starts (as everywhere);
--    late and no-shows by their shift's business day; on time is a share of the shifts that
--    have started.
drop function rpt.people_rows(uuid[], date, date);
create function rpt.people_rows(p_workers uuid[], p_from date, p_to date)
returns table (worker_id uuid, shifts integer, late integer, no_shows integer, hours numeric,
               overtime_hours numeric, leave_days numeric, started integer)
language sql stable
set search_path = pg_catalog, core, hr, ops, rpt
as $$
  with sh as (
    select a.worker_id, s.start_at from hr.shift_assignment a
      join hr.shift s on s.id = a.shift_id and s.status = 'published'
     where a.worker_id = any (p_workers) and a.status = 'assigned'
       and rpt.business_date(s.start_at, ops.tz_of(s.org_node_id)) between p_from and p_to
  ), ex as (
    select x.worker_id, x.kind from hr.attendance_exception x
      left join hr.shift s on s.id = x.shift_id
     where x.worker_id = any (p_workers) and x.status <> 'dismissed'
       and x.kind in ('late', 'no_show')
       and coalesce(rpt.business_date(s.start_at, ops.tz_of(s.org_node_id)), x.local_date)
           between p_from and p_to
  )
  select w.id,
         (select count(*)::int from sh where sh.worker_id = w.id),
         (select count(*)::int from ex where ex.worker_id = w.id and ex.kind = 'late'),
         (select count(*)::int from ex where ex.worker_id = w.id and ex.kind = 'no_show'),
         coalesce(h.hours, 0), coalesce(h.overtime, 0),
         coalesce((select sum(least(l.to_date, p_to) - greatest(l.from_date, p_from) + 1)::numeric
                     from hr.leave_request l
                    where l.worker_id = w.id and l.status = 'approved'
                      and l.from_date <= p_to and l.to_date >= p_from), 0),
         (select count(*)::int from sh where sh.worker_id = w.id and sh.start_at < now())
    from hr.worker w
    left join (select x.worker_id, sum(x.hours) as hours, sum(x.overtime_hours) as overtime
                 from rpt.worker_hours(p_workers, p_from, p_to) x group by x.worker_id) h
           on h.worker_id = w.id
   where w.id = any (p_workers)
$$;
revoke all on function rpt.people_rows(uuid[], date, date) from public;

select pg_temp.patch('rpt.people_summary(uuid, date, date)',
  $o$      ('on_time_pct', (select round((sum(r.shifts) - sum(r.late) - sum(r.no_shows)) * 100.0
                                    / nullif(sum(r.shifts), 0), 1) from r)),$o$,
  $n$      ('on_time_pct', (select round((sum(r.started) - sum(r.late) - sum(r.no_shows)) * 100.0
                                    / nullif(sum(r.started), 0), 1) from r)),$n$);
-- approved swaps by the place's business day, not by the UTC date
select pg_temp.patch('rpt.people_summary(uuid, date, date)',
  $o$and x.updated_at >= p_from and x.updated_at < p_to + 1)::numeric),$o$,
  $n$and x.updated_at >= rpt.day_start(p_from, ops.tz_of(p_place))
                    and x.updated_at < rpt.day_start(p_to + 1, ops.tz_of(p_place)))::numeric),$n$);
select pg_temp.patch('rpt.people_summary(uuid, date, date)',
  $o$SET search_path TO 'pg_catalog', 'core', 'hr', 'rpt'$o$,
  $n$SET search_path TO 'pg_catalog', 'core', 'hr', 'ops', 'rpt'$n$);
select pg_temp.patch('rpt.people_departments(uuid, date, date)',
  $o$           round((sum(r.shifts) - sum(r.late) - sum(r.no_shows)) * 100.0
                 / nullif(sum(r.shifts), 0), 1),$o$,
  $n$           round((sum(r.started) - sum(r.late) - sum(r.no_shows)) * 100.0
                 / nullif(sum(r.started), 0), 1),$n$);

-- the People report's list of people is the people the report counts: those who belong to
-- the place (rpt.place_workers), at every place they worked; the other reports keep the
-- people who worked at the place
select pg_temp.patch('rpt.bd_people(text, uuid, date, date)',
  $o$declare
  v_places uuid[];
begin$o$,
  $n$declare
  v_places uuid[];
  v_workers uuid[];
begin$n$);
select pg_temp.patch('rpt.bd_people(text, uuid, date, date)',
  $o$  perform rpt.check_period(p_from, p_to);
  return query$o$,
  $n$  perform rpt.check_period(p_from, p_to);
  if p_report = 'people' then
    v_workers := rpt.place_workers(p_node);
    select coalesce(array_agg(distinct s.org_node_id), '{}') into v_places
      from hr.shift s join hr.shift_assignment a on a.shift_id = s.id
     where a.worker_id = any (v_workers);
    v_places := v_places || array(
      select distinct x.org_node_id from hr.attendance x where x.worker_id = any (v_workers)
      union select distinct x.org_node_id from hr.attendance_exception x
       where x.worker_id = any (v_workers));
  end if;
  return query$n$);
select pg_temp.patch('rpt.bd_people(text, uuid, date, date)',
  $o$        join hr.shift_assignment a on a.shift_id = s.id and a.status = 'assigned'
       where s.start_at$o$,
  $n$        join hr.shift_assignment a on a.shift_id = s.id and a.status = 'assigned'
       where (v_workers is null or a.worker_id = any (v_workers))
         and s.start_at$n$);
select pg_temp.patch('rpt.bd_people(text, uuid, date, date)',
  $o$        from p join hr.attendance a on a.org_node_id = p.id and a.clock_out_at is not null
       where a.clock_in_at$o$,
  $n$        from p join hr.attendance a on a.org_node_id = p.id and a.clock_out_at is not null
       where (v_workers is null or a.worker_id = any (v_workers))
         and a.clock_in_at$n$);
select pg_temp.patch('rpt.bd_people(text, uuid, date, date)',
  $o$       where x.status <> 'dismissed' and x.kind in ('late', 'no_show')$o$,
  $n$       where (v_workers is null or x.worker_id = any (v_workers))
         and x.status <> 'dismissed' and x.kind in ('late', 'no_show')$n$);

-- 4. One business day everywhere: a store or outlet with no time zone of its own takes its
--    outlet's (ops.tz_of), never UTC
select pg_temp.patch('rpt.cost_totals(uuid, date, date)',
  $o$       where l.occurred_at >= (rpt.day_start(p_from, coalesce(s.timezone, 'UTC')))
         and l.occurred_at < (rpt.day_start(p_to + 1, coalesce(s.timezone, 'UTC')))$o$,
  $n$       where l.occurred_at >= rpt.day_start(p_from, ops.tz_of(st))
         and l.occurred_at < rpt.day_start(p_to + 1, ops.tz_of(st))$n$);
select pg_temp.patch('rpt.cost_totals(uuid, date, date)',
  $o$SET search_path TO 'pg_catalog', 'core', 'inv', 'menu', 'rpt'$o$,
  $n$SET search_path TO 'pg_catalog', 'core', 'inv', 'menu', 'ops', 'rpt'$n$);
select pg_temp.patch('rpt.cost_expired(uuid, date, date)',
  $o$     where l.created_at >= (rpt.day_start(p_from, coalesce(s.timezone, 'UTC')))
       and l.created_at < (rpt.day_start(p_to + 1, coalesce(s.timezone, 'UTC')))$o$,
  $n$     where l.created_at >= rpt.day_start(p_from, ops.tz_of(st))
       and l.created_at < rpt.day_start(p_to + 1, ops.tz_of(st))$n$);
select pg_temp.patch('menu.cost_parts(uuid, uuid[], date, date)',
  $o$  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_outlet), 'UTC');$o$,
  $n$  v_tz := ops.tz_of(p_outlet);$n$);
select pg_temp.patch('inv.variance_of(uuid, date, date)',
  $o$  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_store), 'UTC');$o$,
  $n$  v_tz := ops.tz_of(p_store);$n$);

-- 5. The dishes behind Cost of sales are the dishes of the stores the report covers for this
--    person: a bar manager's food figures are not shown behind the bar's.
select pg_temp.patch('rpt.bd_dishes(text, uuid, date, date)',
  $o$begin
  perform rpt.bd_scope(p_report, p_node, array['outlet_flash', 'cost_of_sales']);$o$,
  $n$declare
  v_stores uuid[];
begin
  select s.stores into v_stores
    from rpt.bd_scope(p_report, p_node, array['outlet_flash', 'cost_of_sales']) s;$n$);
select pg_temp.patch('rpt.bd_dishes(text, uuid, date, date)',
  $o$       where sd.org_node_id = p_node and sd.business_date between p_from and p_to
       group by 1, 2, 3, 4, 5$o$,
  $n$       where sd.org_node_id = p_node and sd.business_date between p_from and p_to
         and (p_report <> 'cost_of_sales' or sl.delivery_node_id = any (v_stores))
       group by 1, 2, 3, 4, 5$n$);

-- the stored days, again, with the figures as they now read
do $$
declare
  v_first date := (select least(
    (select min(business_date) from rpt.labour_day), (select min(business_date) from rpt.task_day),
    current_date));
  v_from date := v_first;
begin
  while v_from <= current_date loop
    perform rpt.rebuild(v_from, least(v_from + 399, current_date));
    v_from := v_from + 400;
  end loop;
end $$;

drop function pg_temp.patch(regprocedure, text, text);

-- migrate:down
create or replace function pg_temp.patch(p_fn regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare
  v_def text := pg_get_functiondef(p_fn);
  v_new text := replace(v_def, p_old, p_new);
begin
  if v_new = v_def then
    raise exception 'audit unpatch did not apply to %: %', p_fn, left(p_old, 80);
  end if;
  execute v_new;
end $$;

select pg_temp.patch('rpt.calc_labour_day(uuid[], date, date)',
  $n$rpt.business_date(s.start_at, p.tz) as day, sum(a.n)::int as shifts,$n$,
  $o$rpt.business_date(s.start_at, p.tz) as day, count(*)::int as shifts,$o$);
select pg_temp.patch('rpt.calc_task_day(uuid[], date, date)',
  $n$
       and (t.status = 'done' or t.due_at <= now())
     group by 1, 2$n$, $o$
     group by 1, 2$o$);
select pg_temp.patch('rpt.bd_tasks(text, uuid, date, date)',
  $n$
         and (t.status = 'done' or t.due_at <= now())
    )$n$, $o$
    )$o$);
select pg_temp.patch('rpt.bd_readings(text, uuid, date, date)',
  $n$
       and (t.status = 'done' or t.due_at <= now())$n$, '');

select pg_temp.patch('rpt.people_summary(uuid, date, date)',
  $n$(sum(r.started) - sum(r.late) - sum(r.no_shows)) * 100.0
                                    / nullif(sum(r.started), 0)$n$,
  $o$(sum(r.shifts) - sum(r.late) - sum(r.no_shows)) * 100.0
                                    / nullif(sum(r.shifts), 0)$o$);
select pg_temp.patch('rpt.people_summary(uuid, date, date)',
  $n$and x.updated_at >= rpt.day_start(p_from, ops.tz_of(p_place))
                    and x.updated_at < rpt.day_start(p_to + 1, ops.tz_of(p_place)))::numeric),$n$,
  $o$and x.updated_at >= p_from and x.updated_at < p_to + 1)::numeric),$o$);
select pg_temp.patch('rpt.people_summary(uuid, date, date)',
  $n$SET search_path TO 'pg_catalog', 'core', 'hr', 'ops', 'rpt'$n$,
  $o$SET search_path TO 'pg_catalog', 'core', 'hr', 'rpt'$o$);
select pg_temp.patch('rpt.people_departments(uuid, date, date)',
  $n$(sum(r.started) - sum(r.late) - sum(r.no_shows)) * 100.0
                 / nullif(sum(r.started), 0)$n$,
  $o$(sum(r.shifts) - sum(r.late) - sum(r.no_shows)) * 100.0
                 / nullif(sum(r.shifts), 0)$o$);

drop function rpt.people_rows(uuid[], date, date);
create function rpt.people_rows(p_workers uuid[], p_from date, p_to date)
returns table (worker_id uuid, shifts integer, late integer, no_shows integer, hours numeric,
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
revoke all on function rpt.people_rows(uuid[], date, date) from public;

select pg_temp.patch('rpt.bd_people(text, uuid, date, date)',
  $n$  if p_report = 'people' then
    v_workers := rpt.place_workers(p_node);
    select coalesce(array_agg(distinct s.org_node_id), '{}') into v_places
      from hr.shift s join hr.shift_assignment a on a.shift_id = s.id
     where a.worker_id = any (v_workers);
    v_places := v_places || array(
      select distinct x.org_node_id from hr.attendance x where x.worker_id = any (v_workers)
      union select distinct x.org_node_id from hr.attendance_exception x
       where x.worker_id = any (v_workers));
  end if;
$n$, '');
select pg_temp.patch('rpt.bd_people(text, uuid, date, date)',
  $n$       where (v_workers is null or a.worker_id = any (v_workers))
         and s.start_at$n$, $o$       where s.start_at$o$);
select pg_temp.patch('rpt.bd_people(text, uuid, date, date)',
  $n$       where (v_workers is null or a.worker_id = any (v_workers))
         and a.clock_in_at$n$, $o$       where a.clock_in_at$o$);
select pg_temp.patch('rpt.bd_people(text, uuid, date, date)',
  $n$       where (v_workers is null or x.worker_id = any (v_workers))
         and x.status <> 'dismissed'$n$, $o$       where x.status <> 'dismissed'$o$);

select pg_temp.patch('rpt.bd_people(text, uuid, date, date)',
  $n$
  v_workers uuid[];
begin$n$, $o$
begin$o$);

select pg_temp.patch('rpt.cost_totals(uuid, date, date)',
  $n$       where l.occurred_at >= rpt.day_start(p_from, ops.tz_of(st))
         and l.occurred_at < rpt.day_start(p_to + 1, ops.tz_of(st))$n$,
  $o$       where l.occurred_at >= (rpt.day_start(p_from, coalesce(s.timezone, 'UTC')))
         and l.occurred_at < (rpt.day_start(p_to + 1, coalesce(s.timezone, 'UTC')))$o$);
select pg_temp.patch('rpt.cost_totals(uuid, date, date)',
  $n$SET search_path TO 'pg_catalog', 'core', 'inv', 'menu', 'ops', 'rpt'$n$,
  $o$SET search_path TO 'pg_catalog', 'core', 'inv', 'menu', 'rpt'$o$);
select pg_temp.patch('rpt.cost_expired(uuid, date, date)',
  $n$     where l.created_at >= rpt.day_start(p_from, ops.tz_of(st))
       and l.created_at < rpt.day_start(p_to + 1, ops.tz_of(st))$n$,
  $o$     where l.created_at >= (rpt.day_start(p_from, coalesce(s.timezone, 'UTC')))
       and l.created_at < (rpt.day_start(p_to + 1, coalesce(s.timezone, 'UTC')))$o$);
select pg_temp.patch('menu.cost_parts(uuid, uuid[], date, date)',
  $n$  v_tz := ops.tz_of(p_outlet);$n$,
  $o$  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_outlet), 'UTC');$o$);
select pg_temp.patch('inv.variance_of(uuid, date, date)',
  $n$  v_tz := ops.tz_of(p_store);$n$,
  $o$  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_store), 'UTC');$o$);

select pg_temp.patch('rpt.bd_dishes(text, uuid, date, date)',
  $n$declare
  v_stores uuid[];
begin
  select s.stores into v_stores
    from rpt.bd_scope(p_report, p_node, array['outlet_flash', 'cost_of_sales']) s;$n$,
  $o$begin
  perform rpt.bd_scope(p_report, p_node, array['outlet_flash', 'cost_of_sales']);$o$);
select pg_temp.patch('rpt.bd_dishes(text, uuid, date, date)',
  $n$
         and (p_report <> 'cost_of_sales' or sl.delivery_node_id = any (v_stores))$n$, '');

do $$
declare
  v_first date := (select least(
    (select min(business_date) from rpt.labour_day), (select min(business_date) from rpt.task_day),
    current_date));
  v_from date := v_first;
begin
  while v_from <= current_date loop
    perform rpt.rebuild(v_from, least(v_from + 399, current_date));
    v_from := v_from + 400;
  end loop;
end $$;

drop function pg_temp.patch(regprocedure, text, text);
