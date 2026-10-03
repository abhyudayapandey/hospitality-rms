-- migrate:up

-- Cost of sales, Purchasing and the expired-stock lines cut their periods at midnight, while
-- the pages end a period at the business day (rpt.today, which starts at 06:00, ADR 023) and
-- the report tables count sales and labour by business day. Between midnight and 06:00 a
-- closing count, wastage or receipt just made fell after the period's end and showed
-- nowhere. Their days now run 06:00 to 06:00 too, so a bar's count at 00:30 belongs to the
-- night it closes (ADR 037). Sales for a date are posted at 23:59:59 that day, so they stay
-- on it.
do $$
declare
  v_fn text;
  v_def text;
  v_pair text[];
  v_pairs text[][] := array[
    array['(p_to + 1)::timestamp at time zone v_tz', 'rpt.day_start(p_to + 1, v_tz)'],
    array['p_from::timestamp at time zone v_tz', 'rpt.day_start(p_from, v_tz)'],
    array['(p_to + 1)::timestamp at time zone coalesce(s.timezone, ''UTC'')',
          'rpt.day_start(p_to + 1, coalesce(s.timezone, ''UTC''))'],
    array['p_from::timestamp at time zone coalesce(s.timezone, ''UTC'')',
          'rpt.day_start(p_from, coalesce(s.timezone, ''UTC''))']];
  v_hits int;
begin
  foreach v_fn in array array[
    'inv.variance_of(uuid,date,date)', 'menu.cost_parts(uuid,uuid[],date,date)',
    'rpt.cost_totals(uuid,date,date)', 'rpt.cost_expired(uuid,date,date)',
    'rpt.price_changes(uuid,date,date)', 'inv.expired_wastage(uuid,date,date)']
  loop
    v_def := pg_get_functiondef(v_fn::regprocedure);
    v_hits := 0;
    foreach v_pair slice 1 in array v_pairs loop
      if position(v_pair[1] in v_def) > 0 then
        v_def := replace(v_def, v_pair[1], v_pair[2]);
        v_hits := v_hits + 1;
      end if;
    end loop;
    if v_hits <> 2 or position('::timestamp at time zone' in v_def) > 0 then
      raise exception '%: expected text not found', v_fn;
    end if;
    execute v_def;
  end loop;
end $$;

-- migrate:down

do $$
declare
  v_fn text;
  v_def text;
  v_pair text[];
  v_pairs text[][] := array[
    array['rpt.day_start(p_to + 1, v_tz)', '(p_to + 1)::timestamp at time zone v_tz'],
    array['rpt.day_start(p_from, v_tz)', 'p_from::timestamp at time zone v_tz'],
    array['rpt.day_start(p_to + 1, coalesce(s.timezone, ''UTC''))',
          '(p_to + 1)::timestamp at time zone coalesce(s.timezone, ''UTC'')'],
    array['rpt.day_start(p_from, coalesce(s.timezone, ''UTC''))',
          'p_from::timestamp at time zone coalesce(s.timezone, ''UTC'')']];
  v_hits int;
begin
  foreach v_fn in array array[
    'inv.variance_of(uuid,date,date)', 'menu.cost_parts(uuid,uuid[],date,date)',
    'rpt.cost_totals(uuid,date,date)', 'rpt.cost_expired(uuid,date,date)',
    'rpt.price_changes(uuid,date,date)', 'inv.expired_wastage(uuid,date,date)']
  loop
    v_def := pg_get_functiondef(v_fn::regprocedure);
    v_hits := 0;
    foreach v_pair slice 1 in array v_pairs loop
      if position(v_pair[1] in v_def) > 0 then
        v_def := replace(v_def, v_pair[1], v_pair[2]);
        v_hits := v_hits + 1;
      end if;
    end loop;
    if v_hits <> 2 then
      raise exception '%: expected text not found', v_fn;
    end if;
    execute v_def;
  end loop;
end $$;
