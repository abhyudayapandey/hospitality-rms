-- migrate:up
-- A place's "today" is the 04:00 business day in its time zone (ADR 046, 169), like
-- rpt.business_date; ops.today_at took the calendar date, so a job marked done at 02:00 was
-- dated the next day and its next due moved on a day early.
create or replace function ops.today_at(p_node uuid, p_now timestamptz default now()) returns date
language sql stable
set search_path = pg_catalog, ops
as $$
  select ((p_now at time zone ops.tz_of(p_node)) - interval '4 hours')::date;
$$;

-- migrate:down
create or replace function ops.today_at(p_node uuid, p_now timestamptz default now()) returns date
language sql stable
set search_path = pg_catalog, ops
as $$
  select (p_now at time zone ops.tz_of(p_node))::date;
$$;
