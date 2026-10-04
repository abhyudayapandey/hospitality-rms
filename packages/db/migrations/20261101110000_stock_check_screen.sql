-- migrate:up

-- The stock check screen's places (ADR 042): stores where the caller holds STOCK_CHECK
-- (modify to count, view to see the Verified / Not verified tags).
do $$
declare
  v_def text := pg_get_functiondef('core.screen_places(text)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def, $a$'team_people', 'team_leave', 'pos_import') then$a$,
                          $a$'team_people', 'team_leave', 'pos_import', 'check') then$a$);
  v_new := replace(v_new, $a$when p_screen in ('stock', 'count', 'wastage', 'orders', 'transfers', 'variance',
                           'production') then$a$,
                          $a$when p_screen in ('stock', 'count', 'wastage', 'orders', 'transfers', 'variance',
                           'production', 'check') then$a$);
  v_new := replace(v_new, $a$             when 'count' then core.can('STOCK_ADJUSTMENTS', 'modify', null, n.id)$a$,
                          $a$             when 'check' then core.can('STOCK_CHECK', 'view', null, n.id)
             when 'count' then core.can('STOCK_ADJUSTMENTS', 'modify', null, n.id)$a$);
  if length(v_new) - length(v_def) < 80 then
    raise exception 'core.screen_places did not take the check screen';
  end if;
  execute v_new;
end $$;

-- migrate:down
do $$
declare
  v_def text := pg_get_functiondef('core.screen_places(text)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def, $a$, 'pos_import', 'check') then$a$, $a$, 'pos_import') then$a$);
  v_new := replace(v_new, $a$'production', 'check') then$a$, $a$'production') then$a$);
  v_new := replace(v_new, E'             when ''check'' then core.can(''STOCK_CHECK'', ''view'', null, n.id)\n', '');
  execute v_new;
end $$;
