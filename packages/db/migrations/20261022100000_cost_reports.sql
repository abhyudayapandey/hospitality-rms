-- migrate:up
-- The cost controller's reports (R-2, ADR 028): cost of sales (actual against recipe, item
-- by item, replacing the Variance screen), menu engineering, the stock position (value,
-- days on hand, dead stock) and purchasing (price changes, supplier fill rate).
--
-- Every figure comes from one definition:
--   * item variance: inv.variance_of, the body of inv.variance (unchanged for the app);
--   * cost %: menu.cost_calc, the body of menu.cost_report over a given list of stores;
--   * stock value by day: rpt.stores_of (R-1, ADR 023).
-- Item detail is read on demand from the source tables (docs/reporting.md section 3); no
-- new rpt tables.
--
-- Who opens what (rule 2: core.can only):
--   * cost_of_sales: an outlet or site, where the person holds MENU view at one of its
--     stores, or REPORTS there (the Account Owner). It shows only those stores.
--   * menu_engineering: an outlet with a menu, the same way (MENU view at a store it sells
--     from, or REPORTS).
--   * stock_position, purchasing: a stock-holding store, for the people who answer for its cost:
--     MENU view (cost controllers, hub and outlet managers) or PURCHASE_ORDERS modify
--     (store keepers) there, or REPORTS at a place it serves. STOCK_LEVELS and
--     PURCHASE_ORDERS view are not enough: commis and bartenders hold them to use the store.
-- Cost of sales and menu engineering need the Menu and sales module (ADR 026).
--
-- Test customers only (ADR 017): inv.record_test_release and inv.record_test_receipt let
-- the loader record file 33's past purchases at the time they happened, through the same
-- receipt code as the app (inv.receive_at).

-- ---------------------------------------------------------------------------
-- One definition each: item variance, cost %, receipts at a time
-- ---------------------------------------------------------------------------

create function inv.variance_of(p_store uuid, p_from date, p_to date)
returns table (item_id uuid, sku text, name text, unit text, opening numeric, receipts numeric,
               transfers_in numeric, transfers_out numeric, wastage numeric,
               production_in numeric, production_out numeric, sales_use numeric,
               other_use numeric, expected_closing numeric, variance_qty numeric,
               variance_value numeric, closing numeric, counted boolean, pending_qty numeric,
               unexplained boolean)
language plpgsql stable
set search_path = pg_catalog, core, inv
as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start';
  end if;
  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_store), 'UTC');
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  return query
    with m as (
      select l.item_id,
             sum(l.qty) filter (where l.occurred_at < v_start) as opening,
             sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'receipt') as receipts,
             sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'transfer_in') as tin,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'transfer_out') as tout,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'wastage') as waste,
             sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'production_in') as pin,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'production_out') as pout,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'sales_depletion') as sales,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'consumption') as other,
             sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'count_adjust') as var_qty,
             sum(l.qty * l.unit_cost) filter (where l.occurred_at >= v_start
                                               and l.movement_type = 'count_adjust') as var_value
        from inv.stock_ledger l
       where l.delivery_node_id = p_store and l.occurred_at < v_end
       group by l.item_id
    ), c as (
      select cl.item_id, true as counted,
             sum(case when cl.outcome = 'approval' and a.posted_at is null
                      then cl.counted_qty - cl.system_qty else 0 end) as pending
        from inv.stock_count sc
        join inv.stock_count_line cl on cl.count_id = sc.id
        left join inv.stock_adjustment a on a.id = sc.adjustment_id
       where sc.delivery_node_id = p_store and sc.status = 'submitted'
         and sc.submitted_at >= v_start and sc.submitted_at < v_end
         and cl.counted_qty is not null
       group by cl.item_id
    )
    select i.id, i.sku, i.name, i.base_uom,
           coalesce(m.opening, 0), coalesce(m.receipts, 0), coalesce(m.tin, 0), coalesce(m.tout, 0),
           coalesce(m.waste, 0), coalesce(m.pin, 0), coalesce(m.pout, 0), coalesce(m.sales, 0),
           coalesce(m.other, 0),
           coalesce(m.opening, 0) + coalesce(m.receipts, 0) + coalesce(m.tin, 0) - coalesce(m.tout, 0)
             - coalesce(m.waste, 0) + coalesce(m.pin, 0) - coalesce(m.pout, 0) - coalesce(m.sales, 0)
             - coalesce(m.other, 0),
           coalesce(m.var_qty, 0), round(coalesce(m.var_value, 0), 2),
           coalesce(m.opening, 0) + coalesce(m.receipts, 0) + coalesce(m.tin, 0) - coalesce(m.tout, 0)
             - coalesce(m.waste, 0) + coalesce(m.pin, 0) - coalesce(m.pout, 0) - coalesce(m.sales, 0)
             - coalesce(m.other, 0) + coalesce(m.var_qty, 0),
           coalesce(c.counted, false), coalesce(c.pending, 0),
           coalesce(m.var_qty, 0) < 0
             and abs(m.var_qty) > greatest(
                   coalesce(x.count_tolerance_qty, 0),
                   coalesce(x.count_tolerance_pct, 0) / 100
                     * greatest(coalesce(m.opening, 0) + coalesce(m.receipts, 0) + coalesce(m.tin, 0)
                                + coalesce(m.pin, 0), 0))
      from inv.item_node x
      join inv.item i on i.id = x.item_id
      left join m on m.item_id = x.item_id
      left join c on c.item_id = x.item_id
     where x.delivery_node_id = p_store and x.archived_at is null
     order by i.category, i.name;
end $$;
revoke execute on function inv.variance_of(uuid, date, date) from public;

create or replace function inv.variance(p_store uuid, p_from date, p_to date)
returns table (item_id uuid, sku text, name text, unit text, opening numeric, receipts numeric,
               transfers_in numeric, transfers_out numeric, wastage numeric,
               production_in numeric, production_out numeric, sales_use numeric,
               other_use numeric, expected_closing numeric, variance_qty numeric,
               variance_value numeric, closing numeric, counted boolean, pending_qty numeric,
               unexplained boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not core.can('MENU', 'view', null, p_store) then
    raise exception 'NOT_AUTHORISED' using detail = format('view MENU at %s', p_store);
  end if;
  return query select * from inv.variance_of(p_store, p_from, p_to);
end $$;

-- Food and beverage cost % at an outlet over the given stores (menu.cost_report's
-- definition; the caller decides which stores).
create function menu.cost_calc(p_outlet uuid, p_stores uuid[], p_from date, p_to date)
returns table (menu text, revenue numeric, theoretical_cost numeric, theoretical_pct numeric,
               actual_cost numeric, actual_pct numeric)
language plpgsql stable
set search_path = pg_catalog, core, inv, menu
as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_outlet), 'UTC');
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  return query
    with stores as (
      select distinct mo.delivery_node_id as store from menu.menu_outlet mo
       where mo.org_node_id = p_outlet and mo.delivery_node_id = any (p_stores)
    ), sold as (
      select mi.menu, sl.delivery_node_id as store, sum(sl.qty * sl.price) as revenue, sd.id as day
        from menu.sales_day sd
        join menu.sales_line sl on sl.sales_day_id = sd.id
        join menu.menu_item mi on mi.id = sl.menu_item_id
       where sd.org_node_id = p_outlet and sd.business_date between p_from and p_to
         and sl.delivery_node_id in (select store from stores)
       group by mi.menu, sl.delivery_node_id, sd.id
    ), rev as (
      select s.menu, s.store, sum(s.revenue) as revenue from sold s group by s.menu, s.store
    ), share as (
      select r.menu, r.store, r.revenue,
             r.revenue / nullif(sum(r.revenue) over (partition by r.store), 0) as share
        from rev r
    ), depleted as (
      select l.delivery_node_id as store, sum(-l.qty * l.unit_cost) as cost
        from inv.stock_ledger l
        join menu.sales_day sd on sd.id = l.ref_id and l.ref_type = 'sales_day'
       where sd.org_node_id = p_outlet and sd.business_date between p_from and p_to
         and l.delivery_node_id in (select store from stores)
       group by l.delivery_node_id
    ), losses as (
      select l.delivery_node_id as store,
             sum(-l.qty * l.unit_cost) filter (where l.movement_type in ('wastage', 'consumption', 'count_adjust')) as cost
        from inv.stock_ledger l
       where l.delivery_node_id in (select store from stores)
         and l.occurred_at >= v_start and l.occurred_at < v_end
       group by l.delivery_node_id
    )
    select s.menu, round(sum(s.revenue), 2),
           round(sum(coalesce(d.cost, 0) * s.share), 2),
           round(sum(coalesce(d.cost, 0) * s.share) / nullif(sum(s.revenue), 0) * 100, 1),
           round(sum((coalesce(d.cost, 0) + coalesce(lo.cost, 0)) * s.share), 2),
           round(sum((coalesce(d.cost, 0) + coalesce(lo.cost, 0)) * s.share)
                 / nullif(sum(s.revenue), 0) * 100, 1)
      from share s
      left join depleted d on d.store = s.store
      left join losses lo on lo.store = s.store
     group by s.menu
     order by s.menu;
end $$;
revoke execute on function menu.cost_calc(uuid, uuid[], date, date) from public;

create or replace function menu.cost_report(p_outlet uuid, p_from date, p_to date)
returns table (menu text, revenue numeric, theoretical_cost numeric, theoretical_pct numeric,
               actual_cost numeric, actual_pct numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
begin
  if not exists (select 1 from menu.menu_outlet mo
                  where mo.org_node_id = p_outlet and mo.tenant_id = core.my_tenant()
                    and core.can('MENU', 'view', null, mo.delivery_node_id)) then
    raise exception 'NOT_AUTHORISED' using detail = format('view MENU at %s', p_outlet);
  end if;
  return query
    select * from menu.cost_calc(p_outlet,
      (select coalesce(array_agg(distinct mo.delivery_node_id), '{}') from menu.menu_outlet mo
        where mo.org_node_id = p_outlet and core.can('MENU', 'view', null, mo.delivery_node_id)),
      p_from, p_to);
end $$;

-- A ledger row at a given time (inv.post at now() is unchanged).
create function inv.post_at(p_item uuid, p_node uuid, p_type text, p_qty numeric,
                            p_unit_cost numeric, p_ref_type text, p_ref_id uuid,
                            p_at timestamptz) returns void
language sql
set search_path = pg_catalog, core, inv
as $$
  insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                unit_cost, ref_type, ref_id, occurred_at)
  select tenant_id, p_item, p_node, p_type, p_qty, coalesce(p_unit_cost, 0), p_ref_type,
         p_ref_id, p_at
    from core.hierarchy_node where id = p_node;
$$;
revoke execute on function inv.post_at(uuid, uuid, text, numeric, numeric, text, uuid,
                                       timestamptz) from public;

-- inv.receive's body with the receipt time as a parameter. Not for the app.
create function inv.receive_at(p_po uuid, p_lines jsonb, p_idempotency_key text,
                               p_at timestamptz) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_po inv.purchase_order;
  v_gr inv.goods_receipt;
  v_line record;
  v_pol inv.purchase_order_line;
  v_prior numeric;
  v_cap numeric;
  v_accept numeric;
  v_cost numeric;
  v_excess jsonb := '[]';
begin
  if p_idempotency_key is not null then
    select * into v_gr from inv.goods_receipt
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_gr.id; end if;
  end if;
  select * into v_po from inv.purchase_order
   where id = p_po and tenant_id = v_me.tenant_id for update;
  if not found then
    perform inv.fail('NOT_AUTHORISED', 'purchase order not found');
  end if;
  perform inv.require('PURCHASE_ORDERS', 'view', v_po.delivery_node_id);
  -- receiving changes stock: whoever may adjust stock at the store (stock users and up,
  -- 20261001120000_access_groups)
  perform inv.require('STOCK_ADJUSTMENTS', 'modify', v_po.delivery_node_id);
  if v_po.status <> 'released' then
    perform inv.fail('INVALID_STATE', format('purchase order is %s', v_po.status));
  end if;
  perform inv.check_lines(p_lines, v_po.delivery_node_id);

  insert into inv.goods_receipt (tenant_id, po_id, delivery_node_id, received_at, idempotency_key)
  values (v_me.tenant_id, p_po, v_po.delivery_node_id, p_at, p_idempotency_key) returning * into v_gr;

  for v_line in select * from jsonb_to_recordset(p_lines)
                  as l(item_id uuid, qty numeric, unit_cost numeric) loop
    select * into v_pol from inv.purchase_order_line where po_id = p_po and item_id = v_line.item_id;
    if not found then
      perform inv.fail('INVALID_ITEM', 'item is not on this purchase order');
    end if;
    if v_line.qty is null or v_line.qty < 0 or v_line.unit_cost < 0 then
      perform inv.fail('INVALID_QUANTITY', 'received quantity must be zero or more');
    end if;
    select coalesce(sum(qty), 0) into v_prior from inv.goods_receipt_line where po_line_id = v_pol.id;
    v_cap := greatest(round(v_pol.qty * 1.05, 3) - v_prior, 0);
    v_accept := least(v_line.qty, v_cap);
    v_cost := coalesce(v_line.unit_cost, v_pol.unit_cost);
    insert into inv.goods_receipt_line (tenant_id, receipt_id, po_line_id, item_id,
                                        delivery_node_id, qty, excess_qty, unit_cost)
    values (v_me.tenant_id, v_gr.id, v_pol.id, v_line.item_id, v_po.delivery_node_id, v_accept,
            v_line.qty - v_accept, v_cost);
    if v_accept > 0 then
      perform inv.post_at(v_line.item_id, v_po.delivery_node_id, 'receipt', v_accept, v_cost,
                          'goods_receipt', v_gr.id, p_at);
    end if;
    if v_line.qty > v_accept then
      v_excess := v_excess || jsonb_build_object(
        'item_id', v_line.item_id, 'movement_type', 'receipt', 'qty', v_line.qty - v_accept,
        'unit_cost', v_cost, 'reason', 'supplier_excess');
    end if;
  end loop;

  if jsonb_array_length(v_excess) > 0 then
    update inv.goods_receipt
       set excess_adjustment_id = inv.submit_adjustment(v_po.delivery_node_id, 'supplier_excess',
                                                        'goods_receipt', v_gr.id, v_excess)
     where id = v_gr.id;
  end if;
  return v_gr.id;
end $$;
revoke execute on function inv.receive_at(uuid, jsonb, text, timestamptz) from public;

-- Unchanged for the app: it receives now.
create or replace function inv.receive(p_po uuid, p_lines jsonb,
                                       p_idempotency_key text default null) returns uuid
language sql security definer
set search_path = pg_catalog, core, inv, wf
as $$ select inv.receive_at(p_po, p_lines, p_idempotency_key, now()) $$;

-- ---------------------------------------------------------------------------
-- Test customers only (ADR 017, file 33): past purchases at the time they happened
-- ---------------------------------------------------------------------------

create function inv.require_test_time(p_at timestamptz) returns void
language plpgsql stable security definer
set search_path = pg_catalog, core
as $$
begin
  if not coalesce((select t.is_test from core.tenant t where t.id = core.my_tenant()), false) then
    raise exception 'TEST_CUSTOMER_ONLY'
      using detail = 'purchases at a past time are recorded for test customers only';
  end if;
  if p_at is null or p_at > now() then
    raise exception 'INVALID_DATE' using detail = 'a past time';
  end if;
end $$;
revoke execute on function inv.require_test_time(timestamptz) from public;

-- Releases an approved order at a past time: what the executor's inv.po.release handler
-- does (it finds the order already released and leaves it). Only after its approval.
create function inv.record_test_release(p_po uuid, p_at timestamptz) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_po inv.purchase_order;
begin
  perform inv.require_test_time(p_at);
  select * into v_po from inv.purchase_order
   where id = p_po and tenant_id = core.my_tenant() for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'no such purchase order';
  end if;
  if v_po.status <> 'submitted' or not exists (
       select 1 from wf.request r where r.id = v_po.wf_request_id
          and r.state in ('approved', 'executing', 'completed')) then
    raise exception 'INVALID_STATE' using detail = 'the order is released only once approved';
  end if;
  update inv.purchase_order set status = 'released', released_at = p_at where id = p_po;
end $$;

-- Receives against a released order at a past time, as the person set in app.user_id
-- (PURCHASE_ORDERS modify at the store, as every receipt).
create function inv.record_test_receipt(p_po uuid, p_lines jsonb, p_at timestamptz,
                                        p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
begin
  perform inv.require_test_time(p_at);
  if p_at < (select released_at from inv.purchase_order where id = p_po) then
    raise exception 'INVALID_DATE' using detail = 'received after the order was released';
  end if;
  return inv.receive_at(p_po, p_lines, p_idempotency_key, p_at);
end $$;
revoke execute on function inv.record_test_release(uuid, timestamptz),
  inv.record_test_receipt(uuid, jsonb, timestamptz, text) from public;
grant execute on function inv.record_test_release(uuid, timestamptz),
  inv.record_test_receipt(uuid, jsonb, timestamptz, text) to platform_loader;

-- ---------------------------------------------------------------------------
-- Who opens which report
-- ---------------------------------------------------------------------------

-- A store's cost people: MENU view or PURCHASE_ORDERS modify there, or REPORTS at a place
-- it serves.
create function rpt.store_cost_access(p_store uuid) returns boolean
language sql stable
set search_path = pg_catalog, core
as $$
  select core.can('MENU', 'view', null, p_store)
      or core.can('PURCHASE_ORDERS', 'modify', null, p_store)
      or exists (select 1 from core.node_link l where l.delivery_node_id = p_store
                    and core.can('REPORTS', 'view', l.org_node_id, null))
$$;

-- An outlet's or site's own stores: those linked to it or to one of its departments. Not
-- rpt.outlet_stores (the supply point's subtree): a central kitchen's hub sits above the
-- outlets it supplies, and their stores are not its own.
create function rpt.place_stores(p_place uuid) returns uuid[]
language sql stable
set search_path = pg_catalog, core, extensions
as $$
  select coalesce(array_agg(distinct s.id), '{}')
    from core.hierarchy_node p
    join core.hierarchy_node o on o.type = 'org' and o.path <@ p.path
    join core.node_link l on l.org_node_id = o.id
    join core.hierarchy_node s on s.id = l.delivery_node_id
   where p.id = p_place and s.holds_stock and s.archived_at is null
$$;

-- The place's stores whose costs the person sees: MENU view there, or all of them with
-- REPORTS at the place.
create function rpt.cost_stores(p_place uuid) returns uuid[]
language sql stable
set search_path = pg_catalog, core, rpt
as $$
  select coalesce(array_agg(s order by s), '{}') from unnest(rpt.place_stores(p_place)) s
   where core.can('REPORTS', 'view', p_place, null) or core.can('MENU', 'view', null, s)
$$;

create or replace function rpt.can_open(p_report text, p_place uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, rpt
as $$
  select coalesce((
    select n.tenant_id = core.my_tenant() and n.archived_at is null
           and case p_report
             when 'outlet_flash' then
               n.type = 'org' and n.kind = 'outlet'
               and (core.can('REPORTS', 'view', n.id, null)
                    or exists (select 1 from core.node_link l where l.org_node_id = n.id
                                  and core.can('SALES', 'view', null, l.delivery_node_id)))
             when 'department' then
               n.type = 'org' and core.is_team_place(n.id)
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('ATTENDANCE', 'view', n.id, null))
             when 'cost_of_sales' then
               n.type = 'org' and n.kind in ('outlet', 'site')
               and cardinality(rpt.cost_stores(n.id)) > 0
             when 'menu_engineering' then
               n.type = 'org' and n.kind = 'outlet'
               and exists (select 1 from menu.menu_outlet mo where mo.org_node_id = n.id
                              and (core.can('REPORTS', 'view', n.id, null)
                                   or core.can('MENU', 'view', null, mo.delivery_node_id)))
             when 'stock_position' then
               n.type = 'delivery' and n.holds_stock and rpt.store_cost_access(n.id)
             when 'purchasing' then
               n.type = 'delivery' and n.holds_stock and rpt.store_cost_access(n.id)
             else false end
      from core.hierarchy_node n where n.id = p_place), false)
$$;

-- The places a person can open a report at; their own first. The same rules as
-- rpt.can_open, worked out once per domain (core.visible_nodes calls core.can per node).
create or replace function rpt.report_places(p_report text)
returns table (id uuid, code text, name text, kind text, preferred int)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
declare
  v_home core.hierarchy_node;
  v_site core.hierarchy_node;
  v_all uuid[] := core.visible_nodes('REPORTS', 'view');
  v_menu uuid[];
  v_ok uuid[];
begin
  if p_report = 'outlet_flash' then
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.kind = 'outlet' and n.type = 'org'
       and (n.id = any (v_all)
            or exists (select 1 from core.node_link l
                        where l.org_node_id = n.id
                          and l.delivery_node_id = any (core.visible_nodes('SALES', 'view'))));
  elsif p_report = 'department' then
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('outlet', 'site', 'department')
       and (n.id = any (v_all) or n.id = any (core.visible_nodes('ATTENDANCE', 'view')))
       and core.is_team_place(n.id);
  elsif p_report = 'cost_of_sales' then
    v_menu := core.visible_nodes('MENU', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('outlet', 'site') and n.tenant_id = core.my_tenant()
       and cardinality(rpt.place_stores(n.id)) > 0
       and (n.id = any (v_all) or rpt.place_stores(n.id) && v_menu);
  elsif p_report = 'menu_engineering' then
    v_menu := core.visible_nodes('MENU', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind = 'outlet' and n.tenant_id = core.my_tenant()
       and exists (select 1 from menu.menu_outlet mo where mo.org_node_id = n.id
                      and (n.id = any (v_all) or mo.delivery_node_id = any (v_menu)));
  elsif p_report in ('stock_position', 'purchasing') then
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'delivery' and n.holds_stock and n.tenant_id = core.my_tenant()
       and (n.id = any (core.visible_nodes('MENU', 'view'))
            or n.id = any (core.visible_nodes('PURCHASE_ORDERS', 'modify'))
            or exists (select 1 from core.node_link l where l.delivery_node_id = n.id
                          and l.org_node_id = any (v_all)));
  else
    raise exception 'INVALID_REPORT' using detail = p_report;
  end if;
  select n.* into v_home from hr.worker w join core.hierarchy_node n on n.id = w.org_node_id
   where w.owner_user_id = core.current_user_id() and w.status = 'active';
  -- the person's outlet or site, for stores: those of their own outlet come first
  select a.* into v_site from core.hierarchy_node a
   where v_home.id is not null and v_home.path <@ a.path and a.kind in ('outlet', 'site')
   order by nlevel(a.path) desc limit 1;
  return query
    select n.id, n.code, n.name, n.kind,
           case when n.type = 'delivery' then
                  case when exists (select 1 from core.node_link l
                                     where l.delivery_node_id = n.id and l.org_node_id = v_home.id)
                       then 0
                       when v_site.id is not null
                            and n.id = any (rpt.place_stores(v_site.id)) then 1
                       else 9 end
                when n.id = v_home.id then 0
                when v_home.id is not null and v_home.path <@ n.path then 1
                when v_home.id is not null and n.path <@ v_home.path then 2
                else 9 end
      from core.hierarchy_node n
     where n.id = any (v_ok) and n.tenant_id = core.my_tenant() and n.archived_at is null
     order by 5, n.name;
end $$;

-- The reports a person can open, in the order of docs/reporting.md section 5. Cost of
-- sales and menu engineering only while the company has Menu and sales on (ADR 026).
create or replace function rpt.my_reports() returns table (report text)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select v.r from (values (1, 'outlet_flash'), (2, 'department'), (3, 'cost_of_sales'),
                          (4, 'menu_engineering'), (5, 'stock_position'), (6, 'purchasing'),
                          (7, 'my_week')) v(o, r)
   where case v.r
           when 'my_week' then exists (select 1 from hr.worker w
                                        where w.owner_user_id = core.current_user_id()
                                          and w.status = 'active')
           when 'cost_of_sales' then core.module_on(core.my_tenant(), 'menu_sales')
                                     and exists (select 1 from rpt.report_places(v.r))
           when 'menu_engineering' then core.module_on(core.my_tenant(), 'menu_sales')
                                        and exists (select 1 from rpt.report_places(v.r))
           else exists (select 1 from rpt.report_places(v.r)) end
   order by v.o
$$;

-- ---------------------------------------------------------------------------
-- Cost of sales (replaces the Variance screen, UX U-14)
-- ---------------------------------------------------------------------------

-- Every item that moved at the place's stores in the period (whole days, store time
-- zone), with its variance: inv.variance's figures, store by store.
create function rpt.cost_items(p_place uuid, p_from date, p_to date)
returns table (store_id uuid, store_name text, item_id uuid, sku text, name text, unit text,
               opening numeric, came_in numeric, went_out numeric, used numeric,
               expected_closing numeric, variance_qty numeric, variance_value numeric,
               counted boolean, pending_qty numeric, unexplained boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, rpt
as $$
begin
  perform rpt.require('cost_of_sales', p_place);
  perform core.require_module('menu_sales');
  return query
    select s.id, s.name, v.item_id, v.sku, v.name, v.unit, v.opening,
           v.receipts + v.transfers_in + v.production_in,
           v.transfers_out + v.wastage + v.other_use,
           v.sales_use + v.production_out,
           v.expected_closing, v.variance_qty, v.variance_value, v.counted, v.pending_qty,
           v.unexplained
      from unnest(rpt.cost_stores(p_place)) st
      join core.hierarchy_node s on s.id = st
      cross join lateral inv.variance_of(st, p_from, p_to) v
     where v.opening <> 0 or v.expected_closing <> 0 or v.variance_qty <> 0
     order by v.variance_value, s.name, v.name;
end $$;

-- The headline figures: sales and cost % per menu (actual and recipe), what was lost at
-- the count, items beyond tolerance, items not counted, wastage and expired wastage.
create function rpt.cost_totals(p_place uuid, p_from date, p_to date)
returns table (measure text, value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, menu, rpt
as $$
declare
  v_stores uuid[];
begin
  perform rpt.require('cost_of_sales', p_place);
  perform core.require_module('menu_sales');
  v_stores := rpt.cost_stores(p_place);
  return query
    with c as (
      select * from menu.cost_calc(p_place, v_stores, p_from, p_to)
    ), v as (
      select x.* from unnest(v_stores) st cross join lateral inv.variance_of(st, p_from, p_to) x
       where x.opening <> 0 or x.expected_closing <> 0 or x.variance_qty <> 0
    ), w as (
      select coalesce(sum(-l.qty * l.unit_cost), 0) as wastage,
             coalesce(sum(-l.qty * l.unit_cost) filter (where l.reason = 'expired'), 0) as expired
        from unnest(v_stores) st
        join core.hierarchy_node s on s.id = st
        join inv.stock_ledger l on l.delivery_node_id = st and l.movement_type = 'wastage'
       where l.occurred_at >= (p_from::timestamp at time zone coalesce(s.timezone, 'UTC'))
         and l.occurred_at < ((p_to + 1)::timestamp at time zone coalesce(s.timezone, 'UTC'))
    )
    select 'food_sales', c.revenue from c where c.menu = 'Food'
    union all select 'food_cost_pct', c.actual_pct from c where c.menu = 'Food'
    union all select 'food_recipe_pct', c.theoretical_pct from c where c.menu = 'Food'
    union all select 'bar_sales', c.revenue from c where c.menu = 'Bar'
    union all select 'bar_cost_pct', c.actual_pct from c where c.menu = 'Bar'
    union all select 'bar_recipe_pct', c.theoretical_pct from c where c.menu = 'Bar'
    union all select 'count_loss', coalesce(-sum(least(v.variance_value, 0)), 0) from v
    union all select 'beyond_tolerance', count(*) filter (where v.unexplained)::numeric from v
    union all select 'not_counted', count(*) filter (where not v.counted)::numeric from v
    union all select 'wastage', round(w.wastage, 2) from w
    union all select 'expired', round(w.expired, 2) from w;
end $$;

-- Expired batches thrown away at the place's stores (inv.expired_wastage's lines).
create function rpt.cost_expired(p_place uuid, p_from date, p_to date)
returns table (store_name text, sku text, name text, unit text, batch_no text,
               made_qty numeric, wasted_qty numeric, value numeric, outcome text,
               reported_by text, discarded_by text, remade_qty numeric, wasted_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
begin
  perform rpt.require('cost_of_sales', p_place);
  perform core.require_module('menu_sales');
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start';
  end if;
  return query
    select s.name, i.sku, i.name, i.base_uom, t.batch_no, p.qty_made, l.qty, l.value,
           l.outcome,
           (select display_name from core.app_user where id = t.reported_by),
           (select display_name from core.app_user where id = l.created_by),
           (select sum(r.qty_made) from inv.production r where r.task_id = t.id),
           l.created_at
      from unnest(rpt.cost_stores(p_place)) st
      join core.hierarchy_node s on s.id = st
      join inv.wastage_line l on l.delivery_node_id = st and l.reason = 'expired'
      join inv.item i on i.id = l.item_id
      left join ops.task t on t.id = l.task_id
      left join inv.production p on p.delivery_node_id = l.delivery_node_id
                                and p.prep_item_id = l.item_id and p.batch_no = t.batch_no
     where l.created_at >= (p_from::timestamp at time zone coalesce(s.timezone, 'UTC'))
       and l.created_at < ((p_to + 1)::timestamp at time zone coalesce(s.timezone, 'UTC'))
     order by l.created_at;
end $$;

-- ---------------------------------------------------------------------------
-- Menu engineering (Kasavana–Smith), per menu (Food, Bar)
-- ---------------------------------------------------------------------------

-- Every dish on the outlet's menu during the period, at the stores the person sees:
--   * margin per serve: price before tax minus the recipe cost (the recipe in force on the
--     day of each sale, ingredients at their average cost), averaged over what sold; a
--     dish that didn't sell uses its price and recipe cost on the last day;
--   * mix: its share of the dishes sold on its menu;
--   * high popularity: mix at least 70% of an equal share (0.7 / dishes on the menu);
--   * high margin: at least the menu's average margin, weighted by what sold.
-- Star (both high), plowhorse (popular, low margin), puzzle (high margin, unpopular),
-- dog (neither). No class while nothing on the menu sold, or for a dish without a recipe.
create function rpt.menu_engineering(p_outlet uuid, p_from date, p_to date)
returns table (menu text, menu_item_id uuid, code text, name text, category text,
               sold numeric, revenue numeric, price numeric, cost numeric, margin numeric,
               mix_pct numeric, avg_margin numeric, popular_from_pct numeric, class text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, menu, rpt
as $$
declare
  v_stores uuid[];
begin
  perform rpt.require('menu_engineering', p_outlet);
  perform core.require_module('menu_sales');
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start';
  end if;
  select coalesce(array_agg(distinct mo.delivery_node_id), '{}') into v_stores
    from menu.menu_outlet mo
   where mo.org_node_id = p_outlet
     and (core.can('REPORTS', 'view', p_outlet, null)
          or core.can('MENU', 'view', null, mo.delivery_node_id));
  return query
    with on_menu as (
      select distinct on (mo.menu_item_id) mo.menu_item_id, mo.delivery_node_id, mo.price
        from menu.menu_outlet mo
       where mo.org_node_id = p_outlet and mo.delivery_node_id = any (v_stores)
         and mo.effective_from <= p_to and (mo.effective_to is null or mo.effective_to >= p_from)
       order by mo.menu_item_id, mo.effective_from desc
    ), sold as (
      select sl.menu_item_id, sl.delivery_node_id, sd.business_date, sum(sl.qty) as qty,
             sum(sl.qty * sl.price) as revenue
        from menu.sales_day sd
        join menu.sales_line sl on sl.sales_day_id = sd.id
       where sd.org_node_id = p_outlet and sd.business_date between p_from and p_to
         and sl.delivery_node_id = any (v_stores)
       group by 1, 2, 3
    ), costed as (
      select s.menu_item_id, s.qty, s.revenue,
             s.qty * inv.recipe_cost((inv.recipe_on(null, s.menu_item_id, s.business_date)).id,
                                     s.delivery_node_id, 'current', s.business_date) as cost
        from sold s
    ), items as (
      select o.menu_item_id, m.menu, m.code, m.name, m.category,
             coalesce(sum(c.qty), 0) as sold, coalesce(sum(c.revenue), 0) as revenue,
             case when sum(c.qty) > 0 then sum(c.revenue) / sum(c.qty) else o.price end as price,
             case when sum(c.qty) > 0 then sum(c.cost) / sum(c.qty)
                  else inv.recipe_cost((inv.recipe_on(null, o.menu_item_id, p_to)).id,
                                       o.delivery_node_id, 'current', p_to) end as cost
        from on_menu o
        join menu.menu_item m on m.id = o.menu_item_id
        left join costed c on c.menu_item_id = o.menu_item_id
       group by o.menu_item_id, o.price, o.delivery_node_id, m.menu, m.code, m.name, m.category
    ), per as (
      select i.*, i.price - i.cost as margin,
             sum(i.sold) over (partition by i.menu) as menu_sold,
             count(*) over (partition by i.menu) as dishes
        from items i
    ), stats as (
      select p.*,
             sum(p.sold * p.margin) over (partition by p.menu)
               / nullif(sum(p.sold) filter (where p.margin is not null)
                          over (partition by p.menu), 0) as avg_margin,
             p.sold / nullif(p.menu_sold, 0) as mix,
             0.7 / p.dishes as popular_from
        from per p
    )
    select s.menu, s.menu_item_id, s.code, s.name, s.category, s.sold, round(s.revenue, 2),
           round(s.price, 2), round(s.cost, 2), round(s.margin, 2), round(s.mix * 100, 1),
           round(s.avg_margin, 2), round(s.popular_from * 100, 1),
           case when s.menu_sold = 0 or s.margin is null or s.avg_margin is null then null
                when s.mix >= s.popular_from and s.margin >= s.avg_margin then 'star'
                when s.mix >= s.popular_from then 'plowhorse'
                when s.margin >= s.avg_margin then 'puzzle'
                else 'dog' end
      from stats s
     order by s.menu, s.margin * s.sold desc nulls last, s.name;
end $$;

-- ---------------------------------------------------------------------------
-- Stock position: value, days on hand, dead stock
-- ---------------------------------------------------------------------------

-- Usage is stock that left for use: sales, production, other use, wastage and transfers
-- out, over the last 28 business days. A store that began using stock less than 28 days
-- ago is averaged over the days since its first use (at least 7, else no days on hand).
-- Dead stock: on hand, with nothing but its opening stock, or no movement at all, in the
-- last 30 days.
create function rpt.stock_items(p_store uuid)
returns table (item_id uuid, sku text, name text, category text, unit text, on_hand numeric,
               value numeric, used_qty numeric, basis_days int, days_on_hand numeric,
               last_moved_at timestamptz, dead boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
declare
  v_tz text;
  v_today date;
  v_since timestamptz;
  v_first date;
  v_basis int;
begin
  perform rpt.require('stock_position', p_store);
  v_tz := ops.tz_of(p_store);
  v_today := rpt.today(p_store);
  v_since := rpt.day_start(v_today - 27, v_tz);
  select rpt.business_date(min(l.occurred_at), v_tz) into v_first from inv.stock_ledger l
   where l.delivery_node_id = p_store
     and l.movement_type in ('sales_depletion', 'production_out', 'consumption', 'wastage',
                             'transfer_out');
  v_basis := least(28, v_today - v_first + 1);
  return query
    with u as (
      select l.item_id, sum(-l.qty) as qty from inv.stock_ledger l
       where l.delivery_node_id = p_store and l.occurred_at >= v_since
         and l.movement_type in ('sales_depletion', 'production_out', 'consumption', 'wastage',
                                 'transfer_out')
       group by l.item_id
    ), m as (
      select l.item_id, max(l.occurred_at) as at from inv.stock_ledger l
       where l.delivery_node_id = p_store and l.ref_type <> 'opening'
       group by l.item_id
    )
    select i.id, i.sku, i.name, i.category, i.base_uom, coalesce(s.on_hand, 0),
           coalesce(s.value, 0), coalesce(u.qty, 0), v_basis,
           case when v_basis >= 7 and u.qty > 0
                then round(coalesce(s.on_hand, 0) / (u.qty / v_basis), 1) end,
           m.at,
           coalesce(s.on_hand, 0) > 0 and (m.at is null or m.at < now() - interval '30 days')
      from inv.item_node x
      join inv.item i on i.id = x.item_id
      left join inv.stock_level s on s.item_id = x.item_id and s.delivery_node_id = p_store
      left join u on u.item_id = x.item_id
      left join m on m.item_id = x.item_id
     where x.delivery_node_id = p_store and x.archived_at is null
     order by coalesce(s.value, 0) desc, i.name;
end $$;

-- The store's figures: value now and at the end of each of the last four weeks, usage,
-- days on hand (value over average daily usage by value) and dead stock.
create function rpt.stock_summary(p_store uuid)
returns table (measure text, value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
declare
  v_tz text;
  v_today date;
  v_basis int;
  v_used numeric;
begin
  perform rpt.require('stock_position', p_store);
  v_tz := ops.tz_of(p_store);
  v_today := rpt.today(p_store);
  select min(i.basis_days) into v_basis from rpt.stock_items(p_store) i;
  select coalesce(sum(-l.qty * l.unit_cost), 0) into v_used from inv.stock_ledger l
   where l.delivery_node_id = p_store and l.occurred_at >= rpt.day_start(v_today - 27, v_tz)
     and l.movement_type in ('sales_depletion', 'production_out', 'consumption', 'wastage',
                             'transfer_out');
  return query
    with items as (select * from rpt.stock_items(p_store))
    select 'stock_value', coalesce(sum(i.value), 0) from items i
    union all
    select 'value_' || w::text, round(s.closing_value, 2)
      from unnest(array[7, 14, 21, 28]) w
      cross join lateral rpt.stores_of(array[p_store], v_today - w, v_today) s
    union all select 'used_value', round(v_used, 2)
    union all select 'basis_days', v_basis::numeric
    union all
    select 'days_on_hand',
           case when v_basis >= 7 and v_used > 0
                then round(coalesce(sum(i.value), 0) / (v_used / v_basis), 1) end
      from items i
    union all select 'dead_items', count(*) filter (where i.dead)::numeric from items i
    union all select 'dead_value', coalesce(sum(i.value) filter (where i.dead), 0) from items i;
end $$;

-- ---------------------------------------------------------------------------
-- Purchasing: price changes and supplier fill rate
-- ---------------------------------------------------------------------------

-- Each receipt line in the period (whole days, store time zone) against the store's
-- previous receipt of the item from any supplier, else the item's standard cost:
-- (price paid - previous price) x quantity received.
create function rpt.price_changes(p_store uuid, p_from date, p_to date)
returns table (item_id uuid, sku text, name text, unit text, supplier text,
               received_at timestamptz, qty numeric, unit_cost numeric, previous_cost numeric,
               basis text, change_value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
declare
  v_tz text;
begin
  perform rpt.require('purchasing', p_store);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start';
  end if;
  v_tz := ops.tz_of(p_store);
  return query
    with r as (
      select gl.item_id, gl.qty, gl.unit_cost, g.received_at, po.supplier_id,
             lag(gl.unit_cost) over (partition by gl.item_id
                                     order by g.received_at, gl.id) as prev
        from inv.goods_receipt_line gl
        join inv.goods_receipt g on g.id = gl.receipt_id
        join inv.purchase_order po on po.id = g.po_id
       where gl.delivery_node_id = p_store and gl.qty > 0
    )
    select r.item_id, i.sku, i.name, i.base_uom, s.name, r.received_at, r.qty, r.unit_cost,
           coalesce(r.prev, i.standard_unit_cost),
           case when r.prev is null then 'standard' else 'previous' end,
           round((r.unit_cost - coalesce(r.prev, i.standard_unit_cost)) * r.qty, 2)
      from r
      join inv.item i on i.id = r.item_id
      join inv.supplier s on s.id = r.supplier_id
     where r.received_at >= (p_from::timestamp at time zone v_tz)
       and r.received_at < ((p_to + 1)::timestamp at time zone v_tz)
     order by 11 desc nulls last, r.received_at;
end $$;

-- Orders released in the period that count: received at least in part, or past their due
-- day (the release day plus the supplier's lead time). Each line at its ordered price.
create function rpt.po_lines(p_store uuid, p_from date, p_to date)
returns table (po_id uuid, supplier_id uuid, released_on date, due_on date, item_id uuid,
               ordered numeric, received numeric, unit_cost numeric, first_received_on date)
language sql stable
set search_path = pg_catalog, core, inv, ops, rpt
as $$
  with o as (
    select po.id, po.supplier_id, rpt.business_date(po.released_at, ops.tz_of(p_store)) as rel,
           s.lead_time_days
      from inv.purchase_order po join inv.supplier s on s.id = po.supplier_id
     where po.delivery_node_id = p_store and po.status = 'released'
       and rpt.business_date(po.released_at, ops.tz_of(p_store)) between p_from and p_to
  )
  select o.id, o.supplier_id, o.rel, o.rel + o.lead_time_days, pl.item_id, pl.qty,
         coalesce(g.qty, 0), pl.unit_cost, g.first_on
    from o
    join inv.purchase_order_line pl on pl.po_id = o.id
    left join lateral (
      select sum(gl.qty) as qty,
             min(rpt.business_date(gr.received_at, ops.tz_of(p_store))) as first_on
        from inv.goods_receipt_line gl join inv.goods_receipt gr on gr.id = gl.receipt_id
       where gl.po_line_id = pl.id) g on true
   where g.qty > 0 or o.rel + o.lead_time_days < rpt.today(p_store)
$$;

-- Per supplier: orders, fill rate (received over ordered, by value at the ordered price,
-- never above 100% a line), orders whose first delivery came by the due day, and orders
-- not yet due.
create function rpt.supplier_fill(p_store uuid, p_from date, p_to date)
returns table (supplier_id uuid, supplier text, orders int, ordered_value numeric,
               received_value numeric, fill_pct numeric, on_time int, late int,
               not_delivered int, not_due int)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
begin
  perform rpt.require('purchasing', p_store);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start';
  end if;
  return query
    with l as (select * from rpt.po_lines(p_store, p_from, p_to)),
    o as (
      select l.po_id, l.supplier_id, min(l.due_on) as due_on, min(l.first_received_on) as first_on,
             sum(l.ordered * l.unit_cost) as ordered_value,
             sum(least(l.received, l.ordered) * l.unit_cost) as received_value
        from l group by l.po_id, l.supplier_id
    ), nd as (
      select po.supplier_id, count(*)::int as n
        from inv.purchase_order po join inv.supplier s on s.id = po.supplier_id
       where po.delivery_node_id = p_store and po.status = 'released'
         and rpt.business_date(po.released_at, ops.tz_of(p_store)) between p_from and p_to
         and not exists (select 1 from l where l.po_id = po.id)
       group by po.supplier_id
    ), sup as (
      select o.supplier_id from o union select nd.supplier_id from nd
    )
    select s.id, s.name, count(o.po_id)::int, round(coalesce(sum(o.ordered_value), 0), 2),
           round(coalesce(sum(o.received_value), 0), 2),
           round(sum(o.received_value) * 100 / nullif(sum(o.ordered_value), 0), 1),
           (count(*) filter (where o.first_on <= o.due_on))::int,
           (count(*) filter (where o.first_on > o.due_on))::int,
           (count(*) filter (where o.po_id is not null and o.first_on is null))::int,
           coalesce(max(nd.n), 0)
      from sup
      join inv.supplier s on s.id = sup.supplier_id
      left join o on o.supplier_id = sup.supplier_id
      left join nd on nd.supplier_id = sup.supplier_id
     group by s.id, s.name
     order by 6 nulls last, s.name;
end $$;

-- The lines behind a fill rate below 100%: delivered short, or not delivered.
create function rpt.short_deliveries(p_store uuid, p_from date, p_to date)
returns table (supplier text, sku text, name text, unit text, released_on date, due_on date,
               ordered numeric, received numeric, short_value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, rpt
as $$
begin
  perform rpt.require('purchasing', p_store);
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start';
  end if;
  return query
    select s.name, i.sku, i.name, i.base_uom, l.released_on, l.due_on, l.ordered, l.received,
           round((l.ordered - l.received) * l.unit_cost, 2)
      from rpt.po_lines(p_store, p_from, p_to) l
      join inv.supplier s on s.id = l.supplier_id
      join inv.item i on i.id = l.item_id
     where l.received < l.ordered
     order by 9 desc, s.name, i.name;
end $$;

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'rpt' loop
    execute format('revoke execute on function %s from public', f);
  end loop;
end $$;
grant execute on function rpt.cost_items(uuid, date, date), rpt.cost_totals(uuid, date, date),
  rpt.cost_expired(uuid, date, date), rpt.menu_engineering(uuid, date, date),
  rpt.stock_items(uuid), rpt.stock_summary(uuid), rpt.price_changes(uuid, date, date),
  rpt.supplier_fill(uuid, date, date), rpt.short_deliveries(uuid, date, date) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function rpt.cost_items(uuid, date, date), rpt.cost_totals(uuid, date, date),
  rpt.cost_expired(uuid, date, date), rpt.menu_engineering(uuid, date, date),
  rpt.stock_summary(uuid), rpt.stock_items(uuid), rpt.price_changes(uuid, date, date),
  rpt.supplier_fill(uuid, date, date), rpt.short_deliveries(uuid, date, date),
  rpt.po_lines(uuid, date, date);
drop function rpt.can_open(text, uuid), rpt.require(text, uuid), rpt.report_places(text),
  rpt.my_reports() cascade;
drop function rpt.cost_stores(uuid), rpt.place_stores(uuid), rpt.store_cost_access(uuid);
create function rpt.can_open(p_report text, p_place uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce((
    select n.tenant_id = core.my_tenant() and n.archived_at is null and n.type = 'org'
           and case p_report
             when 'outlet_flash' then
               n.kind = 'outlet'
               and (core.can('REPORTS', 'view', n.id, null)
                    or exists (select 1 from core.node_link l where l.org_node_id = n.id
                                  and core.can('SALES', 'view', null, l.delivery_node_id)))
             when 'department' then
               core.is_team_place(n.id)
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('ATTENDANCE', 'view', n.id, null))
             else false end
      from core.hierarchy_node n where n.id = p_place), false)
$$;

create function rpt.require(p_report text, p_place uuid) returns void
language plpgsql stable
set search_path = pg_catalog, rpt
as $$
begin
  if not rpt.can_open(p_report, p_place) then
    raise exception 'NOT_AUTHORISED' using detail = format('%s at %s', p_report, p_place);
  end if;
end $$;

-- The places a person can open a report at; their own place first. The same rule as
-- rpt.can_open, worked out once per domain (core.visible_nodes calls core.can per node).
create function rpt.report_places(p_report text)
returns table (id uuid, code text, name text, kind text, preferred int)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
declare
  v_home core.hierarchy_node;
  v_all uuid[] := core.visible_nodes('REPORTS', 'view');
  v_ok uuid[];
begin
  if p_report = 'outlet_flash' then
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.kind = 'outlet' and n.type = 'org'
       and (n.id = any (v_all)
            or exists (select 1 from core.node_link l
                        where l.org_node_id = n.id
                          and l.delivery_node_id = any (core.visible_nodes('SALES', 'view'))));
  elsif p_report = 'department' then
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('outlet', 'site', 'department')
       and (n.id = any (v_all) or n.id = any (core.visible_nodes('ATTENDANCE', 'view')))
       and core.is_team_place(n.id);
  else
    raise exception 'INVALID_REPORT' using detail = p_report;
  end if;
  select n.* into v_home from hr.worker w join core.hierarchy_node n on n.id = w.org_node_id
   where w.owner_user_id = core.current_user_id() and w.status = 'active';
  return query
    select n.id, n.code, n.name, n.kind,
           case when n.id = v_home.id then 0
                when v_home.id is not null and v_home.path <@ n.path then 1
                when v_home.id is not null and n.path <@ v_home.path then 2
                else 9 end
      from core.hierarchy_node n
     where n.id = any (v_ok) and n.tenant_id = core.my_tenant() and n.archived_at is null
     order by 5, n.name;
end $$;

-- The reports a person can open, in the order of docs/reporting.md section 5.
create function rpt.my_reports() returns table (report text)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select v.r from (values (1, 'outlet_flash'), (2, 'department'), (3, 'my_week')) v(o, r)
   where case v.r
           when 'my_week' then exists (select 1 from hr.worker w
                                        where w.owner_user_id = core.current_user_id()
                                          and w.status = 'active')
           else exists (select 1 from rpt.report_places(v.r)) end
   order by v.o
$$;

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'rpt' loop
    execute format('revoke execute on function %s from public', f);
  end loop;
end $$;
grant execute on function rpt.report_places(text), rpt.my_reports() to app_rw;
drop function inv.record_test_release(uuid, timestamptz),
  inv.record_test_receipt(uuid, jsonb, timestamptz, text), inv.require_test_time(timestamptz);
drop function inv.receive(uuid, jsonb, text);
create function inv.receive(p_po uuid, p_lines jsonb,
                            p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_po inv.purchase_order;
  v_gr inv.goods_receipt;
  v_line record;
  v_pol inv.purchase_order_line;
  v_prior numeric;
  v_cap numeric;
  v_accept numeric;
  v_cost numeric;
  v_excess jsonb := '[]';
begin
  if p_idempotency_key is not null then
    select * into v_gr from inv.goods_receipt
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_gr.id; end if;
  end if;
  select * into v_po from inv.purchase_order
   where id = p_po and tenant_id = v_me.tenant_id for update;
  if not found then
    perform inv.fail('NOT_AUTHORISED', 'purchase order not found');
  end if;
  perform inv.require('PURCHASE_ORDERS', 'view', v_po.delivery_node_id);
  -- receiving changes stock: whoever may adjust stock at the store (stock users and up,
  -- 20261001120000_access_groups)
  perform inv.require('STOCK_ADJUSTMENTS', 'modify', v_po.delivery_node_id);
  if v_po.status <> 'released' then
    perform inv.fail('INVALID_STATE', format('purchase order is %s', v_po.status));
  end if;
  perform inv.check_lines(p_lines, v_po.delivery_node_id);

  insert into inv.goods_receipt (tenant_id, po_id, delivery_node_id, idempotency_key)
  values (v_me.tenant_id, p_po, v_po.delivery_node_id, p_idempotency_key) returning * into v_gr;

  for v_line in select * from jsonb_to_recordset(p_lines)
                  as l(item_id uuid, qty numeric, unit_cost numeric) loop
    select * into v_pol from inv.purchase_order_line where po_id = p_po and item_id = v_line.item_id;
    if not found then
      perform inv.fail('INVALID_ITEM', 'item is not on this purchase order');
    end if;
    if v_line.qty is null or v_line.qty < 0 or v_line.unit_cost < 0 then
      perform inv.fail('INVALID_QUANTITY', 'received quantity must be zero or more');
    end if;
    select coalesce(sum(qty), 0) into v_prior from inv.goods_receipt_line where po_line_id = v_pol.id;
    v_cap := greatest(round(v_pol.qty * 1.05, 3) - v_prior, 0);
    v_accept := least(v_line.qty, v_cap);
    v_cost := coalesce(v_line.unit_cost, v_pol.unit_cost);
    insert into inv.goods_receipt_line (tenant_id, receipt_id, po_line_id, item_id,
                                        delivery_node_id, qty, excess_qty, unit_cost)
    values (v_me.tenant_id, v_gr.id, v_pol.id, v_line.item_id, v_po.delivery_node_id, v_accept,
            v_line.qty - v_accept, v_cost);
    if v_accept > 0 then
      perform inv.post(v_line.item_id, v_po.delivery_node_id, 'receipt', v_accept, v_cost,
                       'goods_receipt', v_gr.id);
    end if;
    if v_line.qty > v_accept then
      v_excess := v_excess || jsonb_build_object(
        'item_id', v_line.item_id, 'movement_type', 'receipt', 'qty', v_line.qty - v_accept,
        'unit_cost', v_cost, 'reason', 'supplier_excess');
    end if;
  end loop;

  if jsonb_array_length(v_excess) > 0 then
    update inv.goods_receipt
       set excess_adjustment_id = inv.submit_adjustment(v_po.delivery_node_id, 'supplier_excess',
                                                        'goods_receipt', v_gr.id, v_excess)
     where id = v_gr.id;
  end if;
  return v_gr.id;
end $$;
revoke execute on function inv.receive(uuid, jsonb, text) from public;
grant execute on function inv.receive(uuid, jsonb, text) to app_rw;
drop function inv.receive_at(uuid, jsonb, text, timestamptz),
  inv.post_at(uuid, uuid, text, numeric, numeric, text, uuid, timestamptz);
drop function menu.cost_report(uuid, date, date), inv.variance(uuid, date, date);
create function inv.variance(p_store uuid, p_from date, p_to date)
returns table (item_id uuid, sku text, name text, unit text, opening numeric, receipts numeric,
               transfers_in numeric, transfers_out numeric, wastage numeric,
               production_in numeric, production_out numeric, sales_use numeric,
               other_use numeric, expected_closing numeric, variance_qty numeric,
               variance_value numeric, closing numeric, counted boolean, pending_qty numeric,
               unexplained boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  if not core.can('MENU', 'view', null, p_store) then
    raise exception 'NOT_AUTHORISED' using detail = format('view MENU at %s', p_store);
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start';
  end if;
  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_store), 'UTC');
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  return query
    with m as (
      select l.item_id,
             sum(l.qty) filter (where l.occurred_at < v_start) as opening,
             sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'receipt') as receipts,
             sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'transfer_in') as tin,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'transfer_out') as tout,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'wastage') as waste,
             sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'production_in') as pin,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'production_out') as pout,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'sales_depletion') as sales,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'consumption') as other,
             sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'count_adjust') as var_qty,
             sum(l.qty * l.unit_cost) filter (where l.occurred_at >= v_start
                                               and l.movement_type = 'count_adjust') as var_value
        from inv.stock_ledger l
       where l.delivery_node_id = p_store and l.occurred_at < v_end
       group by l.item_id
    ), c as (
      select cl.item_id, true as counted,
             sum(case when cl.outcome = 'approval' and a.posted_at is null
                      then cl.counted_qty - cl.system_qty else 0 end) as pending
        from inv.stock_count sc
        join inv.stock_count_line cl on cl.count_id = sc.id
        left join inv.stock_adjustment a on a.id = sc.adjustment_id
       where sc.delivery_node_id = p_store and sc.status = 'submitted'
         and sc.submitted_at >= v_start and sc.submitted_at < v_end
         and cl.counted_qty is not null
       group by cl.item_id
    )
    select i.id, i.sku, i.name, i.base_uom,
           coalesce(m.opening, 0), coalesce(m.receipts, 0), coalesce(m.tin, 0), coalesce(m.tout, 0),
           coalesce(m.waste, 0), coalesce(m.pin, 0), coalesce(m.pout, 0), coalesce(m.sales, 0),
           coalesce(m.other, 0),
           coalesce(m.opening, 0) + coalesce(m.receipts, 0) + coalesce(m.tin, 0) - coalesce(m.tout, 0)
             - coalesce(m.waste, 0) + coalesce(m.pin, 0) - coalesce(m.pout, 0) - coalesce(m.sales, 0)
             - coalesce(m.other, 0),
           coalesce(m.var_qty, 0), round(coalesce(m.var_value, 0), 2),
           coalesce(m.opening, 0) + coalesce(m.receipts, 0) + coalesce(m.tin, 0) - coalesce(m.tout, 0)
             - coalesce(m.waste, 0) + coalesce(m.pin, 0) - coalesce(m.pout, 0) - coalesce(m.sales, 0)
             - coalesce(m.other, 0) + coalesce(m.var_qty, 0),
           coalesce(c.counted, false), coalesce(c.pending, 0),
           coalesce(m.var_qty, 0) < 0
             and abs(m.var_qty) > greatest(
                   coalesce(x.count_tolerance_qty, 0),
                   coalesce(x.count_tolerance_pct, 0) / 100
                     * greatest(coalesce(m.opening, 0) + coalesce(m.receipts, 0) + coalesce(m.tin, 0)
                                + coalesce(m.pin, 0), 0))
      from inv.item_node x
      join inv.item i on i.id = x.item_id
      left join m on m.item_id = x.item_id
      left join c on c.item_id = x.item_id
     where x.delivery_node_id = p_store and x.archived_at is null
     order by i.category, i.name;
end $$;
create function menu.cost_report(p_outlet uuid, p_from date, p_to date)
returns table (menu text, revenue numeric, theoretical_cost numeric, theoretical_pct numeric,
               actual_cost numeric, actual_pct numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  if not exists (select 1 from menu.menu_outlet mo
                  where mo.org_node_id = p_outlet and mo.tenant_id = core.my_tenant()
                    and core.can('MENU', 'view', null, mo.delivery_node_id)) then
    raise exception 'NOT_AUTHORISED' using detail = format('view MENU at %s', p_outlet);
  end if;
  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_outlet), 'UTC');
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  return query
    with stores as (
      select distinct mo.delivery_node_id as store from menu.menu_outlet mo
       where mo.org_node_id = p_outlet and core.can('MENU', 'view', null, mo.delivery_node_id)
    ), sold as (
      select mi.menu, sl.delivery_node_id as store, sum(sl.qty * sl.price) as revenue, sd.id as day
        from menu.sales_day sd
        join menu.sales_line sl on sl.sales_day_id = sd.id
        join menu.menu_item mi on mi.id = sl.menu_item_id
       where sd.org_node_id = p_outlet and sd.business_date between p_from and p_to
         and sl.delivery_node_id in (select store from stores)
       group by mi.menu, sl.delivery_node_id, sd.id
    ), rev as (
      select s.menu, s.store, sum(s.revenue) as revenue from sold s group by s.menu, s.store
    ), share as (
      select r.menu, r.store, r.revenue,
             r.revenue / nullif(sum(r.revenue) over (partition by r.store), 0) as share
        from rev r
    ), depleted as (
      select l.delivery_node_id as store, sum(-l.qty * l.unit_cost) as cost
        from inv.stock_ledger l
        join menu.sales_day sd on sd.id = l.ref_id and l.ref_type = 'sales_day'
       where sd.org_node_id = p_outlet and sd.business_date between p_from and p_to
         and l.delivery_node_id in (select store from stores)
       group by l.delivery_node_id
    ), losses as (
      select l.delivery_node_id as store,
             sum(-l.qty * l.unit_cost) filter (where l.movement_type in ('wastage', 'consumption', 'count_adjust')) as cost
        from inv.stock_ledger l
       where l.delivery_node_id in (select store from stores)
         and l.occurred_at >= v_start and l.occurred_at < v_end
       group by l.delivery_node_id
    )
    select s.menu, round(sum(s.revenue), 2),
           round(sum(coalesce(d.cost, 0) * s.share), 2),
           round(sum(coalesce(d.cost, 0) * s.share) / nullif(sum(s.revenue), 0) * 100, 1),
           round(sum((coalesce(d.cost, 0) + coalesce(lo.cost, 0)) * s.share), 2),
           round(sum((coalesce(d.cost, 0) + coalesce(lo.cost, 0)) * s.share)
                 / nullif(sum(s.revenue), 0) * 100, 1)
      from share s
      left join depleted d on d.store = s.store
      left join losses lo on lo.store = s.store
     group by s.menu
     order by s.menu;
end $$;
revoke execute on function inv.variance(uuid, date, date), menu.cost_report(uuid, date, date)
  from public;
grant execute on function inv.variance(uuid, date, date), menu.cost_report(uuid, date, date)
  to app_rw;
drop function menu.cost_calc(uuid, uuid[], date, date), inv.variance_of(uuid, date, date);
