-- migrate:up
-- Roles with little to do (ADR 109): whoever reads a store's vendor bills (BILLS view, the
-- ACCOUNTS group of the READS_BILLS duty: an accountant) opens that store's purchasing report
-- too: price changes, supplier fill rate, short deliveries and transfers in, the money side of
-- what was bought. Nothing else changes: stock position still needs MENU view, PURCHASE_ORDERS
-- modify or REPORTS (rpt.store_cost_access), and every other holder of BILLS view (the GM,
-- store keepers, cost controllers, hub managers) already opened purchasing there.
do $$
declare
  v_src text := pg_get_functiondef('rpt.can_open(text, uuid)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_src,
    'n.type = ''delivery'' and n.holds_stock and rpt.store_cost_access(n.id)
             -- R-3 (ADR 030)',
    'n.type = ''delivery'' and n.holds_stock
               and (rpt.store_cost_access(n.id)
                    -- those who read its bills (ADR 109)
                    or core.report_can(''BILLS'', ''view'', null, n.id))
             -- R-3 (ADR 030)');
  if v_new = v_src then raise exception 'rpt.can_open: purchasing anchor not found'; end if;
  execute v_new;

  v_src := pg_get_functiondef('rpt.report_places(text)'::regprocedure);
  v_new := replace(v_src,
    'elsif p_report in (''stock_position'', ''purchasing'') then
    v_menu := core.report_nodes(''MENU'', ''view'');',
    'elsif p_report in (''stock_position'', ''purchasing'') then
    v_menu := core.report_nodes(''MENU'', ''view'');
    -- purchasing: also the stores whose bills they read (ADR 109)
    if p_report = ''purchasing'' then
      v_menu := v_menu || core.report_nodes(''BILLS'', ''view'');
    end if;');
  if v_new = v_src then raise exception 'rpt.report_places: purchasing anchor not found'; end if;
  execute v_new;
end $$;

-- migrate:down
do $$
declare
  v_src text := pg_get_functiondef('rpt.can_open(text, uuid)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_src,
    'n.type = ''delivery'' and n.holds_stock
               and (rpt.store_cost_access(n.id)
                    -- those who read its bills (ADR 109)
                    or core.report_can(''BILLS'', ''view'', null, n.id))
             -- R-3 (ADR 030)',
    'n.type = ''delivery'' and n.holds_stock and rpt.store_cost_access(n.id)
             -- R-3 (ADR 030)');
  execute v_new;
  v_src := pg_get_functiondef('rpt.report_places(text)'::regprocedure);
  v_new := replace(v_src,
    '
    -- purchasing: also the stores whose bills they read (ADR 109)
    if p_report = ''purchasing'' then
      v_menu := v_menu || core.report_nodes(''BILLS'', ''view'');
    end if;', '');
  execute v_new;
end $$;
