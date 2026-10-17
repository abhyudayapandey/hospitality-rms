-- migrate:up
-- A round after midnight belongs to the night it began (ADR 169). ops.occurrences already
-- starts a day early so a 22:00 to 04:00 window is made whole, but ops.tasks_tick then took
-- each round's steps from its own calendar date: the 00:00, 02:00 and 04:00 rounds of a
-- Monday night got Tuesday's steps, or none, and were skipped. ops.occurrence_days returns
-- each time with the day its window or time belongs to, and the tick uses that day.
create function ops.occurrence_days(p_schedule jsonb, p_tz text, p_from timestamptz,
                                    p_to timestamptz)
returns table (occurs_at timestamptz, window_day date)
language plpgsql stable
as $function$
declare
  v_day date;
  v_last date := (p_to at time zone p_tz)::date;
  v_t text;
  v_at timestamptz;
  v_from interval;
  v_to interval;
  v_step interval;
  v_off interval;
begin
  perform ops.check_schedule(p_schedule);
  -- start a day early: a window that runs past midnight belongs to the day it began
  v_day := (p_from at time zone p_tz)::date - 1;
  while v_day <= v_last loop
    if p_schedule ->> 'kind' in ('daily', 'weekly', 'monthly', 'nth_weekday') then
      if p_schedule ->> 'kind' = 'daily'
         or (p_schedule ->> 'kind' = 'weekly'
             and (p_schedule -> 'weekdays') @> to_jsonb(extract(isodow from v_day)::int))
         -- a day past the month's end (the 31st in April) falls on its last day
         or (p_schedule ->> 'kind' = 'monthly'
             and exists (select 1 from jsonb_array_elements_text(p_schedule -> 'days') d
                          where least(d::int, extract(day from date_trunc('month', v_day)
                                                               + interval '1 month - 1 day')::int)
                                = extract(day from v_day)::int))
         or (p_schedule ->> 'kind' = 'nth_weekday'
             and extract(isodow from v_day)::int = (p_schedule ->> 'weekday')::int
             and (p_schedule -> 'nths') @> to_jsonb((extract(day from v_day)::int - 1) / 7 + 1))
      then
        for v_t in select jsonb_array_elements_text(p_schedule -> 'times') loop
          v_at := (v_day + v_t::time) at time zone p_tz;
          if v_at > p_from and v_at <= p_to then
            occurs_at := v_at;
            window_day := v_day;
            return next;
          end if;
        end loop;
      end if;
    else
      v_from := (p_schedule ->> 'from')::time - time '00:00';
      v_to := (p_schedule ->> 'to')::time - time '00:00';
      if v_to < v_from then
        v_to := v_to + interval '1 day';
      end if;
      v_step := make_interval(hours => (p_schedule ->> 'every')::int);
      v_off := v_from;
      while v_off <= v_to loop
        v_at := (v_day + v_off) at time zone p_tz;
        if v_at > p_from and v_at <= p_to then
          occurs_at := v_at;
          window_day := v_day;
          return next;
        end if;
        v_off := v_off + v_step;
      end loop;
    end if;
    v_day := v_day + 1;
  end loop;
end $function$;

create or replace function ops.occurrences(p_schedule jsonb, p_tz text, p_from timestamptz,
                                           p_to timestamptz)
returns setof timestamptz
language sql stable
as $$ select o.occurs_at from ops.occurrence_days(p_schedule, p_tz, p_from, p_to) o $$;

select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
$x$  v_at timestamptz;
$x$,
$x$  v_at timestamptz;
  v_day date;
$x$);
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
$x$    for v_at in select * from ops.occurrences(v_tpl.schedule, ops.tz_of(v_tpl.org_node_id),$x$,
$x$    for v_at, v_day in select * from ops.occurrence_days(v_tpl.schedule,
                                                         ops.tz_of(v_tpl.org_node_id),$x$);
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
$x$(v_at at time zone ops.tz_of(v_tpl.org_node_id))::date$x$,
$x$v_day$x$);

-- migrate:down
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
$x$ops.steps_on(v_tpl.steps,
                                            v_day)$x$,
$x$ops.steps_on(v_tpl.steps,
                                            (v_at at time zone ops.tz_of(v_tpl.org_node_id))::date)$x$);
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
$x$ops.steps_on(v_tpl.steps,
                                          v_day)$x$,
$x$ops.steps_on(v_tpl.steps,
                                          (v_at at time zone ops.tz_of(v_tpl.org_node_id))::date)$x$);
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
$x$    for v_at, v_day in select * from ops.occurrence_days(v_tpl.schedule,
                                                         ops.tz_of(v_tpl.org_node_id),$x$,
$x$    for v_at in select * from ops.occurrences(v_tpl.schedule, ops.tz_of(v_tpl.org_node_id),$x$);
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
$x$  v_at timestamptz;
  v_day date;
$x$,
$x$  v_at timestamptz;
$x$);
CREATE OR REPLACE FUNCTION ops.occurrences(p_schedule jsonb, p_tz text, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS SETOF timestamp with time zone
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_day date;
  v_last date := (p_to at time zone p_tz)::date;
  v_t text;
  v_at timestamptz;
  v_from interval;
  v_to interval;
  v_step interval;
  v_off interval;
begin
  perform ops.check_schedule(p_schedule);
  -- start a day early: a window that runs past midnight belongs to the day it began
  v_day := (p_from at time zone p_tz)::date - 1;
  while v_day <= v_last loop
    if p_schedule ->> 'kind' in ('daily', 'weekly', 'monthly', 'nth_weekday') then
      if p_schedule ->> 'kind' = 'daily'
         or (p_schedule ->> 'kind' = 'weekly'
             and (p_schedule -> 'weekdays') @> to_jsonb(extract(isodow from v_day)::int))
         -- a day past the month's end (the 31st in April) falls on its last day
         or (p_schedule ->> 'kind' = 'monthly'
             and exists (select 1 from jsonb_array_elements_text(p_schedule -> 'days') d
                          where least(d::int, extract(day from date_trunc('month', v_day)
                                                               + interval '1 month - 1 day')::int)
                                = extract(day from v_day)::int))
         or (p_schedule ->> 'kind' = 'nth_weekday'
             and extract(isodow from v_day)::int = (p_schedule ->> 'weekday')::int
             and (p_schedule -> 'nths') @> to_jsonb((extract(day from v_day)::int - 1) / 7 + 1))
      then
        for v_t in select jsonb_array_elements_text(p_schedule -> 'times') loop
          v_at := (v_day + v_t::time) at time zone p_tz;
          if v_at > p_from and v_at <= p_to then
            return next v_at;
          end if;
        end loop;
      end if;
    else
      v_from := (p_schedule ->> 'from')::time - time '00:00';
      v_to := (p_schedule ->> 'to')::time - time '00:00';
      if v_to < v_from then
        v_to := v_to + interval '1 day';
      end if;
      v_step := make_interval(hours => (p_schedule ->> 'every')::int);
      v_off := v_from;
      while v_off <= v_to loop
        v_at := (v_day + v_off) at time zone p_tz;
        if v_at > p_from and v_at <= p_to then
          return next v_at;
        end if;
        v_off := v_off + v_step;
      end loop;
    end if;
    v_day := v_day + 1;
  end loop;
end $function$;
drop function ops.occurrence_days(jsonb, text, timestamptz, timestamptz);
