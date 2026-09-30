-- migrate:up
-- Audit rows belong to exactly one customer (ADR 009, found with the two test customers).
-- core.org_root(null) falls back to the caller's tenant, so audit rows with no tenant_id
-- were readable by every tenant's auditors: the core.tenant rows (another customer's name
-- and settings) and platform configuration (core.domain_table, core.subject_resolver).
--   * a tenant row's audit entry now carries the tenant's own id; existing ones are fixed
--   * rows without a tenant (platform configuration) are not shown to any tenant

create or replace function audit.capture() returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changed text[];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);

  select array_agg(k order by k) into v_changed
    from (select jsonb_object_keys(coalesce(v_new, '{}')) as k
          union
          select jsonb_object_keys(coalesce(v_old, '{}'))) keys
   where (v_old -> k) is distinct from (v_new -> k);

  if tg_nargs > 0 and tg_argv[0] = 'names_only' then
    v_old := null;
    v_new := null;
  end if;

  insert into audit.log (tenant_id, actor_id, actor_kind, table_name, row_id, op,
                         before, after, changed_fields, granting_node_id, request_id)
  values (coalesce((v_row ->> 'tenant_id')::uuid,
                   case when tg_table_schema = 'core' and tg_table_name = 'tenant'
                        then (v_row ->> 'id')::uuid end),
          core.current_user_id(),
          coalesce(nullif(current_setting('app.actor_kind', true), ''), 'human'),
          tg_table_schema || '.' || tg_table_name,
          (v_row ->> 'id')::uuid,
          tg_op,
          v_old, v_new, v_changed,
          nullif(current_setting('app.granting_node', true), '')::uuid,
          nullif(current_setting('app.wf_request', true), '')::uuid);
  return coalesce(new, old);
end $$;

update audit.log set tenant_id = row_id where table_name = 'core.tenant' and tenant_id is null;

drop policy audit_read on audit.log;
create policy audit_read on audit.log for select to app_rw
  using (tenant_id is not null
         and core.can('AUDIT', 'view', core.org_root(tenant_id), null));

-- migrate:down
drop policy audit_read on audit.log;
create policy audit_read on audit.log for select to app_rw
  using (core.can('AUDIT', 'view', core.org_root(tenant_id), null));
create or replace function audit.capture() returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changed text[];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);

  select array_agg(k order by k) into v_changed
    from (select jsonb_object_keys(coalesce(v_new, '{}')) as k
          union
          select jsonb_object_keys(coalesce(v_old, '{}'))) keys
   where (v_old -> k) is distinct from (v_new -> k);

  if tg_nargs > 0 and tg_argv[0] = 'names_only' then
    v_old := null;
    v_new := null;
  end if;

  insert into audit.log (tenant_id, actor_id, actor_kind, table_name, row_id, op,
                         before, after, changed_fields, granting_node_id, request_id)
  values ((v_row ->> 'tenant_id')::uuid,
          core.current_user_id(),
          coalesce(nullif(current_setting('app.actor_kind', true), ''), 'human'),
          tg_table_schema || '.' || tg_table_name,
          (v_row ->> 'id')::uuid,
          tg_op,
          v_old, v_new, v_changed,
          nullif(current_setting('app.granting_node', true), '')::uuid,
          nullif(current_setting('app.wf_request', true), '')::uuid);
  return coalesce(new, old);
end $$;
