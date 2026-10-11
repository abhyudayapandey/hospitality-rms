-- migrate:up
-- A list's days (ADR 120): business days at a place (04:00 to 04:00 in its time zone, ADR 046)
-- as the stretch of time they cover, so a list can keep the rows of any days chosen on the
-- calendar with an index-friendly `window @> created_at`. Says nothing but the place's clock.
create function rpt.days_window(p_node uuid, p_from date, p_to date) returns tstzrange
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select tstzrange((p_from + time '04:00') at time zone ops.tz_of(p_node),
                   (p_to + 1 + time '04:00') at time zone ops.tz_of(p_node), '[)')
   where p_from <= p_to;
$$;

revoke execute on function rpt.days_window(uuid, date, date) from public;
grant execute on function rpt.days_window(uuid, date, date) to app_rw;

-- migrate:down
drop function rpt.days_window(uuid, date, date);
