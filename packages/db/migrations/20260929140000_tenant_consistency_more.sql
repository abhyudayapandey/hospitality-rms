-- migrate:up
-- Extends core.check_same_tenant() (ADR 003) to:
--   bp_policy:      the group belongs to the row's tenant
--   hierarchy_node: the parent belongs to the row's tenant

create or replace function core.check_same_tenant() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
declare
  v_bad text;
begin
  if tg_table_name = 'role_assignment' then
    select string_agg(what, ', ') into v_bad from (
      select 'user' as what from core.app_user where id = new.user_id and tenant_id <> new.tenant_id
      union all
      select 'group' from core.security_group where id = new.group_id and tenant_id <> new.tenant_id
      union all
      select 'node' from core.hierarchy_node where id = new.node_id and tenant_id <> new.tenant_id
    ) x;
  elsif tg_table_name = 'node_link' then
    select string_agg(what, ', ') into v_bad from (
      select 'org node' as what from core.hierarchy_node
       where id = new.org_node_id and tenant_id <> new.tenant_id
      union all
      select 'delivery node' from core.hierarchy_node
       where id = new.delivery_node_id and tenant_id <> new.tenant_id
    ) x;
  elsif tg_table_name = 'domain_policy' then
    select string_agg(what, ', ') into v_bad from (
      select 'group' as what from core.security_group
       where id = new.group_id and tenant_id <> new.tenant_id
      union all
      select 'domain' from core.domain where id = new.domain_id and tenant_id <> new.tenant_id
    ) x;
  elsif tg_table_name = 'bp_policy' then
    select 'group' into v_bad from core.security_group
     where id = new.group_id and tenant_id <> new.tenant_id;
  elsif tg_table_name = 'hierarchy_node' then
    select 'parent' into v_bad from core.hierarchy_node
     where id = new.parent_id and tenant_id <> new.tenant_id;
  end if;
  if v_bad is not null then
    raise exception 'TENANT_MISMATCH'
      using detail = format('%s.%s: %s not in tenant %s', tg_table_schema, tg_table_name, v_bad,
                            new.tenant_id);
  end if;
  return new;
end $$;

create trigger same_tenant before insert or update on core.bp_policy
  for each row execute function core.check_same_tenant();
-- Triggers fire in name order; 'a_same_tenant' runs before 'path', so a parent from
-- another tenant is rejected before any path is computed.
create trigger a_same_tenant before insert or update of parent_id, tenant_id on core.hierarchy_node
  for each row execute function core.check_same_tenant();

-- migrate:down
drop trigger a_same_tenant on core.hierarchy_node;
drop trigger same_tenant on core.bp_policy;
