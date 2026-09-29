-- migrate:up
-- Security enforcement (docs/LLD.md section 3) with the AWS overrides and ADR 002.

-- Flattened access per user. A plain view for now (LLD: switch to a materialised
-- view once data grows). Only active users and assignments valid today count.
create view core.effective_access as
select ra.user_id, d.code as domain, dp.access, n.type, n.path, ra.include_descendants
  from core.role_assignment ra
  join core.app_user u on u.id = ra.user_id and u.status = 'active'
  join core.hierarchy_node n on n.id = ra.node_id and n.archived_at is null
  join core.domain_policy dp on dp.group_id = ra.group_id
  join core.domain d on d.id = dp.domain_id and d.hierarchy_type = n.type
 where current_date >= ra.effective_from
   and (ra.effective_to is null or current_date <= ra.effective_to);

-- The single access decision function. Rules (LLD section 3, ADR 002):
--  1. hierarchy grant: an assignment at the row's node, or above it when the
--     assignment includes descendants
--  2. self-service: the SELF group's policy on rows the (active) user owns
-- Only active users get anything; domain and group codes resolve in the user's tenant.
--  3. derived view: DERIVED_<domain> on an org node linked (node_link) to the
--     row's delivery node; view only
create function core.can(
  p_domain text, p_access text,          -- access: 'view' | 'modify'
  p_org uuid, p_delivery uuid,           -- the row's nodes
  p_owner uuid default null              -- row owner's user id, for self-service
) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  with me as (
    -- the current user, only if active; codes are resolved within their tenant
    select u.id as uid, u.tenant_id
      from core.app_user u
     where u.id = core.current_user_id() and u.status = 'active'
  ),
  d as (
    select hierarchy_type from core.domain
     where code = p_domain and tenant_id = (select tenant_id from me)
  ),
  t as (
    select n.path, n.type from core.hierarchy_node n
     where n.id = case (select hierarchy_type from d)
                    when 'org' then p_org
                    when 'delivery' then p_delivery
                  end
  )
  select coalesce(
    (select uid from me) is not null
    and p_access in ('view', 'modify')
    and (
      -- 1. hierarchy grant
      exists (
        select 1 from core.effective_access ea, t
         where ea.user_id = (select uid from me)
           and ea.domain = p_domain
           and ea.type = t.type
           and (ea.path = t.path or (ea.include_descendants and ea.path @> t.path))
           and (ea.access = 'modify' or p_access = 'view'))
      -- 2. self-service
      or (p_owner = (select uid from me)
          and exists (
            select 1 from core.domain_policy dp
              join core.security_group g
                on g.id = dp.group_id and g.code = 'SELF' and g.tenant_id = (select tenant_id from me)
              join core.domain dd
                on dd.id = dp.domain_id and dd.code = p_domain and dd.tenant_id = (select tenant_id from me)
             where dp.access = 'modify' or p_access = 'view'))
      -- 3. derived cross-hierarchy view
      or (p_access = 'view'
          and (select hierarchy_type from d) = 'delivery'
          and exists (
            select 1 from core.node_link nl
              join core.hierarchy_node o on o.id = nl.org_node_id
              join core.effective_access ea
                on ea.type = 'org'
               and (ea.path = o.path or (ea.include_descendants and ea.path @> o.path))
             where nl.delivery_node_id = p_delivery
               and ea.user_id = (select uid from me)
               and ea.domain = 'DERIVED_' || p_domain))
    ),
    false);
$$;

grant execute on function core.current_user_id() to app_rw, wf_executor;
grant execute on function core.can(text, text, uuid, uuid, uuid) to app_rw, wf_executor;
grant execute on function core.uuid_v7() to app_rw, wf_executor;

-- Generates the RLS policies and grants for a table registered in core.domain_table.
-- Policy names start with dom_; core.rls_violations() rejects any other policy.
--   app_rw      select: can(view) on any node column (legs are OR'd)
--               insert: can(modify) per leg (one policy per node column)
--               update: can(modify) per leg, unless insert_only or the table has
--                       wf_request_id (status changes go through the executor)
--   wf_executor select + update on tables with wf_request_id
-- Nobody gets DELETE (no hard deletes on business data).
create function core.apply_domain_rls(p_table regclass) returns void
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
revoke execute on function core.apply_domain_rls(regclass) from public;

-- Lists every way a business table breaks CLAUDE.md rules 1 and 5. The build
-- fails (rls-coverage test) unless this returns no rows.
create function core.rls_violations()
returns table (table_name text, problem text)
language sql stable as $$
  with t as (
    select c.oid, c.oid::regclass::text as name, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('hr', 'inv', 'ops', 'wf', 'ai')
       and c.relkind in ('r', 'p')
       and not c.relispartition
  )
  select name, 'rls_disabled' from t where not relrowsecurity
  union all
  select name, 'not_registered' from t
   where not exists (select 1 from core.domain_table dt where dt.table_name = t.oid)
  union all
  select name, 'no_generated_policies' from t
   where not exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polname like 'dom\_%')
  union all
  select name, 'hand_written_policy' from t
   where exists (select 1 from pg_policy p where p.polrelid = t.oid and p.polname not like 'dom\_%')
  union all
  select name, 'no_audit_trigger' from t
   where not exists (select 1 from pg_trigger tg
                      where tg.tgrelid = t.oid and tg.tgfoid = 'audit.capture'::regproc)
$$;

-- audit.log: readable only with AUDIT view at the org root (AUDITOR, SECURITY_ADMIN).
-- Hand-written because the log has no node column; audit is outside the business
-- schemas that rule 1 covers.
alter table audit.log enable row level security;
-- The org root of a tenant (default: the current user's tenant). Used for
-- tenant-wide domains like AUDIT whose rows carry no node.
create function core.org_root(p_tenant uuid default null) returns uuid
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  select n.id from core.hierarchy_node n
   where n.type = 'org' and n.parent_id is null and n.archived_at is null
     and n.tenant_id = coalesce(p_tenant,
           (select u.tenant_id from core.app_user u where u.id = core.current_user_id()))
   order by n.created_at
   limit 1;
$$;
grant execute on function core.org_root(uuid) to app_rw, wf_executor;

create policy audit_read on audit.log for select to app_rw
  using (core.can('AUDIT', 'view', core.org_root(tenant_id), null));
grant select on audit.log to app_rw;

-- migrate:down
drop policy audit_read on audit.log;
revoke select on audit.log from app_rw;
alter table audit.log disable row level security;
drop function core.org_root(uuid);
drop function core.rls_violations();
drop function core.apply_domain_rls(regclass);
drop function core.can(text, text, uuid, uuid, uuid);
drop view core.effective_access;
