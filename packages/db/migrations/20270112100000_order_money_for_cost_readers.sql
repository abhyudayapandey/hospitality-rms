-- migrate:up
-- Order values only for those who read cost (KI-09, ADR 104, 123). Staff who only take in
-- deliveries (a chef de partie, a head bartender, a laundry attendant) see what came and how
-- much, never what it is worth. Whoever reads the cost of the store (`rpt.store_cost_access`:
-- MENU view, PURCHASE_ORDERS modify, or REPORTS there) or reads its bills (BILLS view: the
-- accountant, the purchase manager, ADR 109, 123) sees the money; the order desk too, which
-- places the order and so sets its prices. Everyone else gets null in place of ₹.
-- Receiving still asks for the bill amount per line (ADR 051): that is typed, not shown.

-- whoever may see the money of a store's orders, bills and wastage
create function inv.sees_store_money(p_store uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, rpt
as $$
  select coalesce(rpt.store_cost_access(p_store), false)
      or coalesce(core.can('BILLS', 'view', null, p_store), false);
$$;

-- whoever may see the money of an order: at its store, or the desk that places it (ADR 049)
create function inv.po_sees_money(p_po uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select coalesce((select inv.sees_store_money(po.delivery_node_id) or inv.can_place(p_po)
                     from inv.purchase_order po
                    where po.id = p_po and po.tenant_id = core.my_tenant()), false);
$$;

revoke execute on function inv.sees_store_money(uuid), inv.po_sees_money(uuid) from public;
grant execute on function inv.sees_store_money(uuid), inv.po_sees_money(uuid) to app_rw;

-- what was received and what it cost (ADR 051): null for whoever may not see the money
create or replace function inv.po_received_value(p_po uuid) returns numeric
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select round(sum(gl.qty * gl.unit_cost), 2)
    from inv.goods_receipt_line gl join inv.goods_receipt g on g.id = gl.receipt_id
   where g.po_id = p_po and g.tenant_id = core.my_tenant()
     and (core.can('PURCHASE_ORDERS', 'view', null, g.delivery_node_id) or inv.can_place(p_po))
     and inv.po_sees_money(p_po);
$$;

-- migrate:down
create or replace function inv.po_received_value(p_po uuid) returns numeric
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select round(sum(gl.qty * gl.unit_cost), 2)
    from inv.goods_receipt_line gl join inv.goods_receipt g on g.id = gl.receipt_id
   where g.po_id = p_po and g.tenant_id = core.my_tenant()
     and (core.can('PURCHASE_ORDERS', 'view', null, g.delivery_node_id) or inv.can_place(p_po));
$$;

drop function inv.po_sees_money(uuid);
drop function inv.sees_store_money(uuid);
