-- migrate:up
-- Which meal is next goes by the outlet's 04:00 business day (ADR 169). It compared the
-- clock with the cut-off on the calendar day, so a dinner set to end after midnight (00:30)
-- showed tomorrow's dinner all evening, and at 00:15 the next calendar day's. Now: the
-- business day's meal until its cut-off (a cut-off before 04:00 is that night, after
-- midnight), then the next day's. p_now is for tests.
create function ops.meal_next(p_outlet uuid, p_meal text, p_now timestamptz)
returns date
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  with d as (
    select ((p_now at time zone ops.tz_of(p_outlet)) - interval '4 hours')::date as day,
           ops.meal_ends(p_outlet, p_meal) as ends
  )
  select case
           when p_now < ((d.day + d.ends
                          + case when d.ends < time '04:00' then interval '1 day'
                                 else interval '0' end)
                         at time zone ops.tz_of(p_outlet))
             then d.day
           else d.day + 1
         end
    from d;
$$;
revoke execute on function ops.meal_next(uuid, text, timestamptz) from public;
grant execute on function ops.meal_next(uuid, text, timestamptz) to app_rw;

create or replace function ops.meal_next(p_outlet uuid, p_meal text) returns date
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select ops.meal_next(p_outlet, p_meal, now());
$$;

-- migrate:down
create or replace function ops.meal_next(p_outlet uuid, p_meal text) returns date
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select case
           when (now() at time zone ops.tz_of(p_outlet))::time < ops.meal_ends(p_outlet, p_meal)
             then (now() at time zone ops.tz_of(p_outlet))::date
           else (now() at time zone ops.tz_of(p_outlet))::date + 1
         end;
$$;
drop function ops.meal_next(uuid, text, timestamptz);
