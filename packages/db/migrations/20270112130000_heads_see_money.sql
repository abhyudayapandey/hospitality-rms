-- migrate:up
-- Department heads see the money of their department's stores (ADR 145, the owner's call):
-- order values, line prices, received value, wastage worth and breakage value. Nobody below
-- them does, except whoever reads the store's cost (the cost controller, the
-- GM, the account owner: rpt.store_cost_access), its bills, or places its orders.

-- whether the person heads a department this store serves (DEPARTMENT_HEAD there, or above it)
create function inv.heads_store(p_store uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce(exists (
    select 1
      from core.node_link l
      join core.security_group g on g.tenant_id = core.my_tenant() and g.code = 'DEPARTMENT_HEAD'
     where l.delivery_node_id = p_store and l.tenant_id = core.my_tenant()
       and core.current_user_id() in (select core.group_holders(g.id, l.org_node_id))), false);
$$;
revoke execute on function inv.heads_store(uuid) from public;
grant execute on function inv.heads_store(uuid) to app_rw;

create or replace function inv.sees_store_money(p_store uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, rpt
as $$
  select coalesce(rpt.store_cost_access(p_store), false)
      or coalesce(core.can('BILLS', 'view', null, p_store), false)
      or inv.heads_store(p_store);
$$;

-- breakage value follows the same rule as the rest of a store's money
select core.patch_function('inv.breakage_log(uuid,date)',
  $x$case when rpt.store_cost_access(b.delivery_node_id) then b.value end$x$,
  $x$case when inv.sees_store_money(b.delivery_node_id) then b.value end$x$);
select core.patch_function('inv.breakage_months(uuid)',
  $x$sum(case when rpt.store_cost_access(b.delivery_node_id) then b.value end)$x$,
  $x$sum(case when inv.sees_store_money(b.delivery_node_id) then b.value end)$x$);

-- migrate:down
select core.patch_function('inv.breakage_months(uuid)',
  $x$sum(case when inv.sees_store_money(b.delivery_node_id) then b.value end)$x$,
  $x$sum(case when rpt.store_cost_access(b.delivery_node_id) then b.value end)$x$);
select core.patch_function('inv.breakage_log(uuid,date)',
  $x$case when inv.sees_store_money(b.delivery_node_id) then b.value end$x$,
  $x$case when rpt.store_cost_access(b.delivery_node_id) then b.value end$x$);

create or replace function inv.sees_store_money(p_store uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, rpt
as $$
  select coalesce(rpt.store_cost_access(p_store), false)
      or coalesce(core.can('BILLS', 'view', null, p_store), false);
$$;
drop function inv.heads_store(uuid);
