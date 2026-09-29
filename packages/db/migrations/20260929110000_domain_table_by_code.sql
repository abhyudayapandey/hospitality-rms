-- migrate:up
-- core.domain_table becomes tenant-independent (ADR 003). Domain codes are unique per
-- tenant (ADR 002), but tables are registered in migrations, before any tenant or
-- domain row exists. Registrations therefore name the domain by code and declare its
-- tree; core.can() resolves the code in the current user's tenant at query time.
--
-- New registration modes (all generate dom_* policies only):
--   domain_column  the row carries its domain code (e.g. wf.request.domain_code);
--                  can() receives both org_node_id and delivery_node_id and picks
--                  the node by that domain's tree
--   owner_column   owner for self-service (default: owner_user_id if present)
--   rpc_only       select policy + grant only; writes go through SECURITY DEFINER RPCs
--   tenant_scoped  rows have no node; checked at core.org_root(tenant_id)

alter table core.domain_table
  drop column domain_id,
  drop column modify_domain_id,
  drop column tenant_id,
  add column domain_code text,
  add column modify_domain_code text,
  add column hierarchy_type text check (hierarchy_type in ('org', 'delivery', 'self')),
  add column domain_column text,
  add column owner_column text,
  add column rpc_only boolean not null default false,
  add column tenant_scoped boolean not null default false,
  add constraint domain_table_mode check (
    (domain_column is null and domain_code is not null and hierarchy_type is not null)
    or (domain_column is not null and domain_code is null and modify_domain_code is null
        and hierarchy_type is null and node_columns is null and not tenant_scoped)),
  add constraint domain_table_tenant_scope check (not tenant_scoped or hierarchy_type = 'org');

create function core.has_column(p_table regclass, p_column text) returns boolean
language sql stable as $$
  select exists (select 1 from pg_attribute
                  where attrelid = p_table and attname = p_column
                    and attnum > 0 and not attisdropped);
$$;
revoke execute on function core.has_column(regclass, text) from public;

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

-- migrate:down
create or replace function core.apply_domain_rls(p_table regclass) returns void
language plpgsql as $$
declare
  v_dt core.domain_table;
  v_view_domain core.domain;
  v_mod_domain core.domain;
  v_cols text[];
  v_col text;
  v_has_owner boolean;
  v_has_wf boolean;
  v_pol record;
  v_view_expr text;
  v_mod_expr text;
  v_owner text;

  -- can() argument list for one node column
  function_args text;
begin
  select * into v_dt from core.domain_table where table_name = p_table;
  if not found then
    raise exception 'DOMAIN_TABLE_NOT_REGISTERED' using detail = p_table::text;
  end if;
  select * into v_view_domain from core.domain where id = v_dt.domain_id;
  select * into v_mod_domain from core.domain where id = coalesce(v_dt.modify_domain_id, v_dt.domain_id);
  if v_view_domain.hierarchy_type <> v_mod_domain.hierarchy_type then
    raise exception 'DOMAIN_TREE_MISMATCH' using detail = p_table::text;
  end if;

  v_cols := coalesce(v_dt.node_columns, case v_view_domain.hierarchy_type
    when 'org' then array['org_node_id']
    when 'delivery' then array['delivery_node_id']
    else array[]::text[] end);

  foreach v_col in array v_cols loop
    if not exists (select 1 from pg_attribute
                    where attrelid = p_table and attname = v_col and not attisdropped) then
      raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_col);
    end if;
  end loop;

  select exists (select 1 from pg_attribute where attrelid = p_table
                  and attname = 'owner_user_id' and not attisdropped) into v_has_owner;
  select exists (select 1 from pg_attribute where attrelid = p_table
                  and attname = 'wf_request_id' and not attisdropped) into v_has_wf;
  if v_view_domain.hierarchy_type = 'self' and not v_has_owner then
    raise exception 'OWNER_COLUMN_MISSING' using detail = p_table::text;
  end if;
  v_owner := case when v_has_owner then 'owner_user_id' else 'null' end;

  -- Drop previously generated policies so this is idempotent.
  for v_pol in select polname from pg_policy
                where polrelid = p_table and polname like 'dom\_%' loop
    execute format('drop policy %I on %s', v_pol.polname, p_table);
  end loop;

  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from app_rw, wf_executor', p_table);

  -- A 'self' domain has no node column: one policy on the owner alone.
  if cardinality(v_cols) = 0 then
    v_cols := array[null::text];
  end if;

  v_view_expr := '';
  foreach v_col in array v_cols loop
    function_args := case v_view_domain.hierarchy_type
      when 'org' then format('%I, null', v_col)
      when 'delivery' then format('null, %I', v_col)
      else 'null, null' end;

    v_view_expr := v_view_expr || case when v_view_expr = '' then '' else ' or ' end
      || format('core.can(%L, ''view'', %s, %s)', v_view_domain.code, function_args, v_owner);
    v_mod_expr := format('core.can(%L, ''modify'', %s, %s)', v_mod_domain.code, function_args, v_owner);

    execute format('create policy %I on %s for insert to app_rw with check (%s)',
                   'dom_insert_' || coalesce(v_col, 'owner'), p_table, v_mod_expr);
    if not v_dt.insert_only and not v_has_wf then
      execute format('create policy %I on %s for update to app_rw using (%s) with check (%s)',
                     'dom_update_' || coalesce(v_col, 'owner'), p_table, v_mod_expr, v_mod_expr);
    end if;
  end loop;

  execute format('create policy dom_select on %s for select to app_rw using (%s)', p_table, v_view_expr);
  execute format('grant select, insert on %s to app_rw', p_table);
  if not v_dt.insert_only and not v_has_wf then
    execute format('grant update on %s to app_rw', p_table);
  end if;

  if v_has_wf then
    execute format('create policy dom_exec_select on %s for select to wf_executor using (true)', p_table);
    execute format('create policy dom_exec_update on %s for update to wf_executor using (true) with check (true)', p_table);
    execute format('grant select, update on %s to wf_executor', p_table);
  end if;
end $$;

drop function core.has_column(regclass, text);
alter table core.domain_table
  drop constraint domain_table_tenant_scope,
  drop constraint domain_table_mode,
  drop column tenant_scoped,
  drop column rpc_only,
  drop column owner_column,
  drop column domain_column,
  drop column hierarchy_type,
  drop column modify_domain_code,
  drop column domain_code,
  add column tenant_id uuid references core.tenant(id),
  add column domain_id uuid references core.domain(id),
  add column modify_domain_id uuid references core.domain(id);
