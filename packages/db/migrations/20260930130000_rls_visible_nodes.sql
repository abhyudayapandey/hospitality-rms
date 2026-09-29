-- migrate:up
-- ADR 007: generated RLS no longer calls core.can() once per row for node-bound rows.
-- The caller's visible node set is computed once per query (an InitPlan) by functions
-- that call core.can() once per node, so core.can() stays the single decision
-- (rule 2); policies only test membership. Equivalence with per-row core.can() is
-- proved for every seeded user and business table (rls-equivalence.db.test.ts).
--
--   node legs (literal domain)  node = any(core.visible_nodes(domain, access))
--   per-row domain (wf tables)  'DOMAIN:node' = any(core.visible_domain_nodes(access))
--   owner (SELF)                unchanged: core.can(domain, access, null, null, owner)
--   tenant-scoped rows          unchanged: core.can(domain, access, org_root(tenant))

-- Nodes (in the caller's tenant, in the domain's tree) where
-- core.can(p_domain, p_access, <node>) is true. Only domains the caller holds directly
-- or through DERIVED_ can be true on a node, so others short-circuit to empty.
create function core.visible_nodes(p_domain text, p_access text) returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  select coalesce(array_agg(n.id order by n.id), '{}')
    from core.domain d
    join core.hierarchy_node n on n.tenant_id = d.tenant_id and n.type = d.hierarchy_type
   where d.code = p_domain
     and d.tenant_id = core.my_tenant()
     and exists (select 1 from core.effective_access ea
                  where ea.user_id = core.current_user_id()
                    and ea.domain in (p_domain, 'DERIVED_' || p_domain))
     and core.can(p_domain, p_access,
                  case when n.type = 'org' then n.id end,
                  case when n.type = 'delivery' then n.id end);
$$;

-- The same for rows that carry their own domain (wf tables): 'DOMAIN:node' pairs.
create function core.visible_domain_nodes(p_access text) returns text[]
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  select coalesce(array_agg(d.code || ':' || n.id order by d.code, n.id), '{}')
    from core.domain d
    join core.hierarchy_node n on n.tenant_id = d.tenant_id and n.type = d.hierarchy_type
   where d.tenant_id = core.my_tenant()
     and exists (select 1 from core.effective_access ea
                  where ea.user_id = core.current_user_id()
                    and ea.domain in (d.code, 'DERIVED_' || d.code))
     and core.can(d.code, p_access,
                  case when n.type = 'org' then n.id end,
                  case when n.type = 'delivery' then n.id end);
$$;
grant execute on function core.visible_nodes(text, text), core.visible_domain_nodes(text)
  to app_rw, wf_executor;

-- One policy leg as SQL. p_label is the leg's node column, or 'row' (per-row domain),
-- 'tenant' or 'owner'; p_dom is the domain as SQL (a literal, or the domain column).
create function core.rls_leg(p_label text, p_dom text, p_access text, p_legs text,
                             p_owner text, p_domain_column text) returns text
language plpgsql immutable as $$
declare
  v_expr text;
  v_self text;
begin
  v_self := case when p_owner is not null then
    format('(%1$I = core.current_user_id() and core.can(%2$s, %3$L, null, null, %1$I))',
           p_owner, p_dom, p_access) end;
  case p_label
  when 'owner' then
    return format('core.can(%s, %L, null, null, %s)', p_dom, p_access, quote_ident(p_owner));
  when 'tenant' then
    return format('core.can(%s, %L, %s, %s)', p_dom, p_access, p_legs,
                  coalesce(quote_ident(p_owner), 'null'));
  when 'row' then
    v_expr := format(
      '((%1$I || '':'' || org_node_id::text) = any ((select core.visible_domain_nodes(%2$L))::text[])'
      ' or (%1$I || '':'' || delivery_node_id::text) = any ((select core.visible_domain_nodes(%2$L))::text[]))',
      p_domain_column, p_access);
  else
    v_expr := format('%I = any ((select core.visible_nodes(%s, %L))::uuid[])',
                     p_label, p_dom, p_access);
  end case;
  return case when v_self is null then v_expr else '(' || v_expr || ' or ' || v_self || ')' end;
end $$;
revoke execute on function core.rls_leg(text, text, text, text, text, text) from public;

create or replace function core.apply_domain_rls(p_table regclass) returns void
language plpgsql as $$
declare
  v_dt core.domain_table;
  v_cols text[];
  v_col text;
  v_owner text;
  v_has_wf boolean;
  v_pol record;
  v_view_dom text;          -- SQL for the view domain: a literal code or a column
  v_mod_dom text;           -- SQL for the modify domain
  v_legs text[] := '{}';    -- can() node arguments per leg: '<org>, <delivery>'
  v_labels text[] := '{}';  -- policy name suffix per leg
  v_view_expr text := '';
  v_mod_expr text;
begin
  select * into v_dt from core.domain_table where table_name = p_table;
  if not found then
    raise exception 'DOMAIN_TABLE_NOT_REGISTERED' using detail = p_table::text;
  end if;

  v_owner := coalesce(v_dt.owner_column,
                      case when core.has_column(p_table, 'owner_user_id') then 'owner_user_id' end);
  if v_owner is not null and not core.has_column(p_table, v_owner) then
    raise exception 'OWNER_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_owner);
  end if;
  v_has_wf := core.has_column(p_table, 'wf_request_id');

  -- Catalogue rows (items, suppliers): no node; readable by anyone in the tenant who
  -- holds view on the domain (or its DERIVED_ domain) at some node. Both checks are
  -- scalar subqueries, so they run once per query, not once per row. Writes: RPCs only.
  if v_dt.catalog then
    for v_pol in select polname from pg_policy
                  where polrelid = p_table and polname like 'dom\_%' loop
      execute format('drop policy %I on %s', v_pol.polname, p_table);
    end loop;
    execute format('alter table %s enable row level security', p_table);
    execute format('revoke all on %s from app_rw, wf_executor', p_table);
    execute format(
      'create policy dom_select on %s for select to app_rw using '
      '(tenant_id = (select core.my_tenant()) and (select core.can_any(%L, ''view'')))',
      p_table, v_dt.domain_code);
    execute format('grant select on %s to app_rw', p_table);
    return;
  end if;

  if v_dt.domain_column is not null then
    -- Per-row domain: can() picks org or delivery node by the row's domain tree.
    foreach v_col in array array[v_dt.domain_column, 'org_node_id', 'delivery_node_id'] loop
      if not core.has_column(p_table, v_col) then
        raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_col);
      end if;
    end loop;
    v_view_dom := quote_ident(v_dt.domain_column);
    v_mod_dom := v_view_dom;
    v_legs := array['org_node_id, delivery_node_id'];
    v_labels := array['row'];
  else
    v_view_dom := quote_literal(v_dt.domain_code);
    v_mod_dom := quote_literal(coalesce(v_dt.modify_domain_code, v_dt.domain_code));
    if v_dt.tenant_scoped then
      -- Tenant-wide rows (no node): checked at the tenant's org root, like audit.log.
      if not core.has_column(p_table, 'tenant_id') then
        raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.tenant_id', p_table);
      end if;
      v_legs := array['core.org_root(tenant_id), null'];
      v_labels := array['tenant'];
    else
      v_cols := coalesce(v_dt.node_columns, case v_dt.hierarchy_type
        when 'org' then array['org_node_id']
        when 'delivery' then array['delivery_node_id']
        else array[]::text[] end);
      foreach v_col in array v_cols loop
        if not core.has_column(p_table, v_col) then
          raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_col);
        end if;
        v_legs := v_legs || case v_dt.hierarchy_type
          when 'org' then format('%I, null', v_col)
          when 'delivery' then format('null, %I', v_col)
          else 'null, null' end;
        v_labels := v_labels || v_col;
      end loop;
      if cardinality(v_legs) = 0 then
        if v_owner is null then
          raise exception 'OWNER_COLUMN_MISSING' using detail = p_table::text;
        end if;
        v_legs := array['null, null'];
        v_labels := array['owner'];
      end if;
    end if;
  end if;

  -- Drop previously generated policies so this is idempotent.
  for v_pol in select polname from pg_policy
                where polrelid = p_table and polname like 'dom\_%' loop
    execute format('drop policy %I on %s', v_pol.polname, p_table);
  end loop;

  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from app_rw, wf_executor', p_table);

  for i in 1 .. cardinality(v_legs) loop
    v_view_expr := v_view_expr || case when i > 1 then ' or ' else '' end
      || core.rls_leg(v_labels[i], v_view_dom, 'view', v_legs[i], v_owner, v_dt.domain_column);
    v_mod_expr := core.rls_leg(v_labels[i], v_mod_dom, 'modify', v_legs[i], v_owner, v_dt.domain_column);
    if not v_dt.rpc_only then
      execute format('create policy %I on %s for insert to app_rw with check (%s)',
                     'dom_insert_' || v_labels[i], p_table, v_mod_expr);
      if not v_dt.insert_only and not v_has_wf then
        execute format('create policy %I on %s for update to app_rw using (%s) with check (%s)',
                       'dom_update_' || v_labels[i], p_table, v_mod_expr, v_mod_expr);
      end if;
    end if;
  end loop;

  execute format('create policy dom_select on %s for select to app_rw using (%s)', p_table, v_view_expr);
  execute format('grant select on %s to app_rw', p_table);
  if not v_dt.rpc_only then
    execute format('grant insert on %s to app_rw', p_table);
    if not v_dt.insert_only and not v_has_wf then
      execute format('grant update on %s to app_rw', p_table);
    end if;
  end if;

  if v_has_wf then
    execute format('create policy dom_exec_select on %s for select to wf_executor using (true)', p_table);
    execute format('create policy dom_exec_update on %s for update to wf_executor using (true) with check (true)', p_table);
    execute format('grant select, update on %s to wf_executor', p_table);
  end if;
end $$;

-- Regenerate every registered table's policies.
select core.apply_domain_rls(table_name) from core.domain_table order by table_name::text;

-- migrate:down
create or replace function core.apply_domain_rls(p_table regclass) returns void
language plpgsql as $$
declare
  v_dt core.domain_table;
  v_cols text[];
  v_col text;
  v_owner text;
  v_has_wf boolean;
  v_pol record;
  v_view_dom text;          -- SQL for the view domain: a literal code or a column
  v_mod_dom text;           -- SQL for the modify domain
  v_legs text[] := '{}';    -- can() node arguments per leg: '<org>, <delivery>'
  v_labels text[] := '{}';  -- policy name suffix per leg
  v_view_expr text := '';
  v_mod_expr text;
begin
  select * into v_dt from core.domain_table where table_name = p_table;
  if not found then
    raise exception 'DOMAIN_TABLE_NOT_REGISTERED' using detail = p_table::text;
  end if;

  v_owner := coalesce(v_dt.owner_column,
                      case when core.has_column(p_table, 'owner_user_id') then 'owner_user_id' end);
  if v_owner is not null and not core.has_column(p_table, v_owner) then
    raise exception 'OWNER_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_owner);
  end if;
  v_has_wf := core.has_column(p_table, 'wf_request_id');

  -- Catalogue rows (items, suppliers): no node; readable by anyone in the tenant who
  -- holds view on the domain (or its DERIVED_ domain) at some node. Both checks are
  -- scalar subqueries, so they run once per query, not once per row. Writes: RPCs only.
  if v_dt.catalog then
    for v_pol in select polname from pg_policy
                  where polrelid = p_table and polname like 'dom\_%' loop
      execute format('drop policy %I on %s', v_pol.polname, p_table);
    end loop;
    execute format('alter table %s enable row level security', p_table);
    execute format('revoke all on %s from app_rw, wf_executor', p_table);
    execute format(
      'create policy dom_select on %s for select to app_rw using '
      '(tenant_id = (select core.my_tenant()) and (select core.can_any(%L, ''view'')))',
      p_table, v_dt.domain_code);
    execute format('grant select on %s to app_rw', p_table);
    return;
  end if;

  if v_dt.domain_column is not null then
    -- Per-row domain: can() picks org or delivery node by the row's domain tree.
    foreach v_col in array array[v_dt.domain_column, 'org_node_id', 'delivery_node_id'] loop
      if not core.has_column(p_table, v_col) then
        raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_col);
      end if;
    end loop;
    v_view_dom := quote_ident(v_dt.domain_column);
    v_mod_dom := v_view_dom;
    v_legs := array['org_node_id, delivery_node_id'];
    v_labels := array['row'];
  else
    v_view_dom := quote_literal(v_dt.domain_code);
    v_mod_dom := quote_literal(coalesce(v_dt.modify_domain_code, v_dt.domain_code));
    if v_dt.tenant_scoped then
      -- Tenant-wide rows (no node): checked at the tenant's org root, like audit.log.
      if not core.has_column(p_table, 'tenant_id') then
        raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.tenant_id', p_table);
      end if;
      v_legs := array['core.org_root(tenant_id), null'];
      v_labels := array['tenant'];
    else
      v_cols := coalesce(v_dt.node_columns, case v_dt.hierarchy_type
        when 'org' then array['org_node_id']
        when 'delivery' then array['delivery_node_id']
        else array[]::text[] end);
      foreach v_col in array v_cols loop
        if not core.has_column(p_table, v_col) then
          raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_col);
        end if;
        v_legs := v_legs || case v_dt.hierarchy_type
          when 'org' then format('%I, null', v_col)
          when 'delivery' then format('null, %I', v_col)
          else 'null, null' end;
        v_labels := v_labels || v_col;
      end loop;
      if cardinality(v_legs) = 0 then
        if v_owner is null then
          raise exception 'OWNER_COLUMN_MISSING' using detail = p_table::text;
        end if;
        v_legs := array['null, null'];
        v_labels := array['owner'];
      end if;
    end if;
  end if;

  -- Drop previously generated policies so this is idempotent.
  for v_pol in select polname from pg_policy
                where polrelid = p_table and polname like 'dom\_%' loop
    execute format('drop policy %I on %s', v_pol.polname, p_table);
  end loop;

  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from app_rw, wf_executor', p_table);

  for i in 1 .. cardinality(v_legs) loop
    v_view_expr := v_view_expr || case when i > 1 then ' or ' else '' end
      || format('core.can(%s, ''view'', %s, %s)', v_view_dom, v_legs[i], coalesce(quote_ident(v_owner), 'null'));
    v_mod_expr := format('core.can(%s, ''modify'', %s, %s)', v_mod_dom, v_legs[i], coalesce(quote_ident(v_owner), 'null'));
    if not v_dt.rpc_only then
      execute format('create policy %I on %s for insert to app_rw with check (%s)',
                     'dom_insert_' || v_labels[i], p_table, v_mod_expr);
      if not v_dt.insert_only and not v_has_wf then
        execute format('create policy %I on %s for update to app_rw using (%s) with check (%s)',
                       'dom_update_' || v_labels[i], p_table, v_mod_expr, v_mod_expr);
      end if;
    end if;
  end loop;

  execute format('create policy dom_select on %s for select to app_rw using (%s)', p_table, v_view_expr);
  execute format('grant select on %s to app_rw', p_table);
  if not v_dt.rpc_only then
    execute format('grant insert on %s to app_rw', p_table);
    if not v_dt.insert_only and not v_has_wf then
      execute format('grant update on %s to app_rw', p_table);
    end if;
  end if;

  if v_has_wf then
    execute format('create policy dom_exec_select on %s for select to wf_executor using (true)', p_table);
    execute format('create policy dom_exec_update on %s for update to wf_executor using (true) with check (true)', p_table);
    execute format('grant select, update on %s to wf_executor', p_table);
  end if;
end $$;

select core.apply_domain_rls(table_name) from core.domain_table order by table_name::text;
drop function core.rls_leg(text, text, text, text, text, text);
drop function core.visible_domain_nodes(text);
drop function core.visible_nodes(text, text);
