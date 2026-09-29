-- migrate:up
-- Rows that join tenant-scoped records must stay inside one tenant (ADR 003). Without
-- this, an assignment could give a user access in another tenant's tree.
--   role_assignment: user, group and node belong to the row's tenant
--   node_link:       both nodes belong to the row's tenant
--   domain_policy:   group and domain belong to the row's tenant

create function core.check_same_tenant() returns trigger
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
  end if;
  if v_bad is not null then
    raise exception 'TENANT_MISMATCH'
      using detail = format('%s.%s: %s not in tenant %s', tg_table_schema, tg_table_name, v_bad,
                            new.tenant_id);
  end if;
  return new;
end $$;
revoke execute on function core.check_same_tenant() from public;

create trigger same_tenant before insert or update on core.role_assignment
  for each row execute function core.check_same_tenant();
create trigger same_tenant before insert or update on core.node_link
  for each row execute function core.check_same_tenant();
create trigger same_tenant before insert or update on core.domain_policy
  for each row execute function core.check_same_tenant();

-- migrate:down
drop trigger same_tenant on core.domain_policy;
drop trigger same_tenant on core.node_link;
drop trigger same_tenant on core.role_assignment;
drop function core.check_same_tenant();
