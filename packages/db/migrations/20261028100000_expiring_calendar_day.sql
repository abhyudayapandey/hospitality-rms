-- migrate:up

-- Stock position's "expiring within 3 days" (RPT-14, ADR 033) counted from the business day
-- (rpt.today, which starts at 06:00), while the Stock banners and lists (inv.expiry_list)
-- count from the store's calendar day. Between midnight and 06:00 the two disagreed by a
-- day. Stock position now counts from the calendar day too, like the banners (ADR 037).
do $$
declare
  v_def text := pg_get_functiondef('rpt.store_items(uuid)'::regprocedure);
  v_old text := '::date <= v_today + 3)';
  v_new text := '::date <= (now() at time zone coalesce(v_tz, ''UTC''))::date + 3)';
begin
  if position(v_old in v_def) = 0 then
    raise exception 'rpt.store_items: expected text not found';
  end if;
  execute replace(v_def, v_old, v_new);
end $$;

-- migrate:down

do $$
declare
  v_def text := pg_get_functiondef('rpt.store_items(uuid)'::regprocedure);
  v_new text := '::date <= v_today + 3)';
  v_old text := '::date <= (now() at time zone coalesce(v_tz, ''UTC''))::date + 3)';
begin
  if position(v_old in v_def) = 0 then
    raise exception 'rpt.store_items: expected text not found';
  end if;
  execute replace(v_def, v_old, v_new);
end $$;
