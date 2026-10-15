-- migrate:up

-- Office Homes (ADR 151, P3): whoever keeps a Main Store (the store keeper, the purchase
-- manager) sees the order desk's tiles on Home: what to order, what to receive. A store kept
-- by a department head is not a Main Store and gives no tiles.
create function inv.keeps_main_store() returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select exists (
    select 1 from core.hierarchy_node m
     where m.tenant_id = core.my_tenant() and m.is_main_store and m.archived_at is null
       and core.current_user_id() = any(inv.desk_keepers(m.id)));
$$;

revoke execute on function inv.keeps_main_store() from public, platform_loader;
grant execute on function inv.keeps_main_store() to app_rw;

-- migrate:down
drop function inv.keeps_main_store();
