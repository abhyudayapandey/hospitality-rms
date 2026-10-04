-- migrate:up

-- The business day runs 04:00 to 04:00 local time (ADR 046), not 06:00 to 06:00. Most bars
-- close by 4 am and no kitchen opens before it, so a night's sales, wastage, counts and
-- punches belong to the day the night began. Every report, the Today home, the cost pages,
-- the expiry alert and the report tables count their days through these two functions, so
-- this is the whole change. The report tables keep the old boundary for days already
-- stored; the nightly job rebuilds the last 35 days (pnpm ... reports-rebuild does it now).

create or replace function rpt.business_date(p_at timestamptz, p_tz text) returns date
language sql immutable
set search_path = pg_catalog
as $$ select ((p_at at time zone p_tz) - interval '4 hours')::date $$;

create or replace function rpt.day_start(p_day date, p_tz text) returns timestamptz
language sql immutable
set search_path = pg_catalog
as $$ select (p_day + time '04:00') at time zone p_tz $$;

-- migrate:down

create or replace function rpt.business_date(p_at timestamptz, p_tz text) returns date
language sql immutable
set search_path = pg_catalog
as $$ select ((p_at at time zone p_tz) - interval '6 hours')::date $$;

create or replace function rpt.day_start(p_day date, p_tz text) returns timestamptz
language sql immutable
set search_path = pg_catalog
as $$ select (p_day + time '06:00') at time zone p_tz $$;
