-- migrate:up
-- Swaps for managers only, always (ADR 152): offering a shift in a swap is for someone who
-- changes the roster at the shift's place. It was a company setting (SW-4, on by default);
-- it is now the rule for every company and the setting is gone. Frontline staff still accept
-- a swap offered to them; their own shifts are changed by their managers on the roster.

do $$
declare
  v_src text := pg_get_functiondef('hr.request_swap(uuid, uuid, text)'::regprocedure);
  v_old text := '  -- SW-4: with swaps for management only (the default), only someone who changes the
  -- roster at the shift''s place offers a swap
  if coalesce((core.settings_of(v_w.tenant_id) ->> ''swaps_managers_only'')::boolean, true)
     and not core.can(''ROSTER'', ''modify'', v_a.org_node_id, null) then';
  v_new text := '  -- swaps for managers only (ADR 152): only someone who changes the roster at the
  -- shift''s place offers a swap
  if not core.can(''ROSTER'', ''modify'', v_a.org_node_id, null) then';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'hr.request_swap changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

do $$
declare
  v_src text := pg_get_functiondef('core.set_company_settings(jsonb)'::regprocedure);
  v_old text := 'elsif v_key in (''po_send_prices'', ''swaps_managers_only'') then';
  v_new text := 'elsif v_key = ''po_send_prices'' then';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'core.set_company_settings changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

do $$
declare
  v_src text := pg_get_functiondef('core.settings_defaults()'::regprocedure);
  v_old text := '''swaps_managers_only'', true,';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'core.settings_defaults changed; update this migration';
  end if;
  execute replace(v_src, v_old, '');
end $$;

update core.tenant set settings = settings - 'swaps_managers_only'
 where settings ? 'swaps_managers_only';

-- migrate:down
do $$
declare
  v_src text := pg_get_functiondef('core.settings_defaults()'::regprocedure);
  v_old text := '''po_send_prices'', false,';
begin
  execute replace(v_src, v_old, v_old || ' ''swaps_managers_only'', true,');
end $$;

do $$
declare
  v_src text := pg_get_functiondef('core.set_company_settings(jsonb)'::regprocedure);
begin
  execute replace(v_src, 'elsif v_key = ''po_send_prices'' then',
                  'elsif v_key in (''po_send_prices'', ''swaps_managers_only'') then');
end $$;

do $$
declare
  v_src text := pg_get_functiondef('hr.request_swap(uuid, uuid, text)'::regprocedure);
begin
  execute replace(v_src,
    '  -- swaps for managers only (ADR 152): only someone who changes the roster at the
  -- shift''s place offers a swap
  if not core.can(''ROSTER'', ''modify'', v_a.org_node_id, null) then',
    '  -- SW-4: with swaps for management only (the default), only someone who changes the
  -- roster at the shift''s place offers a swap
  if coalesce((core.settings_of(v_w.tenant_id) ->> ''swaps_managers_only'')::boolean, true)
     and not core.can(''ROSTER'', ''modify'', v_a.org_node_id, null) then');
end $$;
