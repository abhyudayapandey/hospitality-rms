-- migrate:up
-- Inventory, order and transfer functions (docs/LLD.md sections 5 and 7, ADR 006).
--
-- Every function the app calls is SECURITY DEFINER, checks core.can() on the node it
-- writes to (rule 2), and changes stock only by inserting inv.stock_ledger rows (rule 3).
-- Workflow subjects are created as 'draft' and handed to wf.submit in the same
-- transaction; later status changes come from the executor (inv.execute) or wf.act.
-- Mutating functions take an optional idempotency key: a repeat returns the first result.

-- ---------------------------------------------------------------------------
-- Helpers (not callable by app_rw)
-- ---------------------------------------------------------------------------

create function inv.fail(p_code text, p_detail text default null) returns void
language plpgsql as $$
begin
  raise exception '%', p_code using detail = coalesce(p_detail, '');
end $$;

-- Raises NOT_AUTHORISED unless the current user holds p_access on p_domain at p_node,
-- which must be a delivery node of their tenant.
create function inv.require(p_domain text, p_access text, p_node uuid) returns void
language plpgsql stable
set search_path = pg_catalog, core, inv
as $$
begin
  if p_node is null
     or not exists (select 1 from core.hierarchy_node
                     where id = p_node and type = 'delivery' and archived_at is null
                       and tenant_id = core.my_tenant())
     or not core.can(p_domain, p_access, null, p_node, null) then
    perform inv.fail('NOT_AUTHORISED', format('%s %s at %s', p_access, p_domain, p_node));
  end if;
end $$;

-- Validates a lines array: non-empty, every item once, items of the caller's tenant that
-- are set up (inv.item_node) at p_node.
create function inv.check_lines(p_lines jsonb, p_node uuid) returns void
language plpgsql stable
set search_path = pg_catalog, core, inv
as $$
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    perform inv.fail('INVALID_LINES', 'no lines');
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e
              where jsonb_typeof(e -> 'item_id') is distinct from 'string') then
    perform inv.fail('INVALID_LINES', 'line without item');
  end if;
  if (select count(distinct e ->> 'item_id') from jsonb_array_elements(p_lines) e)
     <> jsonb_array_length(p_lines) then
    perform inv.fail('INVALID_LINES', 'an item appears twice');
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e
              where not exists (select 1 from inv.item_node n
                                  join inv.item i on i.id = n.item_id
                                 where n.item_id = (e ->> 'item_id')::uuid
                                   and n.delivery_node_id = p_node
                                   and n.archived_at is null and i.archived_at is null
                                   and i.tenant_id = core.my_tenant())) then
    perform inv.fail('INVALID_ITEM', 'item is not stocked at this location');
  end if;
end $$;

create function inv.on_hand(p_item uuid, p_node uuid) returns numeric
language sql stable
set search_path = pg_catalog, inv
as $$
  select coalesce((select on_hand from inv.stock_level
                    where item_id = p_item and delivery_node_id = p_node), 0);
$$;

create function inv.avg_cost(p_item uuid, p_node uuid) returns numeric
language sql stable
set search_path = pg_catalog, inv
as $$
  select coalesce((select avg_cost from inv.stock_level
                    where item_id = p_item and delivery_node_id = p_node), 0);
$$;

-- Posts one ledger movement for the current transaction's actor.
create function inv.post(p_item uuid, p_node uuid, p_type text, p_qty numeric,
                         p_unit_cost numeric, p_ref_type text, p_ref_id uuid,
                         p_reason text default null) returns void
language sql
set search_path = pg_catalog, core, inv
as $$
  insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                unit_cost, reason, ref_type, ref_id)
  select tenant_id, p_item, p_node, p_type, p_qty, coalesce(p_unit_cost, 0), p_reason,
         p_ref_type, p_ref_id
    from core.hierarchy_node where id = p_node;
$$;

-- Creates a draft STOCK_ADJUSTMENT from p_lines ([{item_id, movement_type, qty,
-- unit_cost, reason, photo_key}]) and submits it. Returns the adjustment id.
create function inv.submit_adjustment(p_node uuid, p_reason text, p_source_type text,
                                      p_source_id uuid, p_lines jsonb) returns uuid
language plpgsql
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_adj inv.stock_adjustment;
  v_request uuid;
begin
  insert into inv.stock_adjustment (tenant_id, delivery_node_id, reason, source_type, source_id,
                                    amount)
  select core.my_tenant(), p_node, p_reason, p_source_type, p_source_id,
         round(sum(abs((l ->> 'qty')::numeric) * (l ->> 'unit_cost')::numeric), 2)
    from jsonb_array_elements(p_lines) l
  returning * into v_adj;
  insert into inv.stock_adjustment_line (tenant_id, adjustment_id, item_id, delivery_node_id,
                                         movement_type, qty, unit_cost, reason, photo_key)
  select v_adj.tenant_id, v_adj.id, (l ->> 'item_id')::uuid, p_node, l ->> 'movement_type',
         (l ->> 'qty')::numeric, (l ->> 'unit_cost')::numeric, l ->> 'reason', l ->> 'photo_key'
    from jsonb_array_elements(p_lines) l;
  v_request := wf.submit('STOCK_ADJUSTMENT', 'inv.stock_adjustment', v_adj.id);
  update inv.stock_adjustment set status = 'submitted', wf_request_id = v_request
   where id = v_adj.id;
  return v_adj.id;
end $$;

-- ---------------------------------------------------------------------------
-- Wastage
-- ---------------------------------------------------------------------------

-- p_lines: [{item_id, qty, reason, photo_key?}]. A line worth more than the node's
-- wastage_approval_value (default 2,000) needs a photo and goes to STOCK_ADJUSTMENT
-- approval; the rest posts wastage rows now. Returns the wastage id.
create function inv.record_wastage(p_node uuid, p_lines jsonb,
                                   p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_w inv.wastage;
  v_threshold numeric;
  v_line record;
  v_cost numeric;
  v_value numeric;
  v_approval jsonb := '[]';
  v_photo_re text;
begin
  if p_idempotency_key is not null then
    select * into v_w from inv.wastage
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_w.id; end if;
  end if;
  perform inv.require('STOCK_ADJUSTMENTS', 'modify', p_node);
  perform inv.check_lines(p_lines, p_node);
  v_threshold := coalesce((select wastage_approval_value from inv.node_setting
                            where delivery_node_id = p_node), 2000);
  v_photo_re := format('^wastage/%s/%s/[0-9a-f-]{36}\.(jpg|png|webp)$', v_me.tenant_id, p_node);

  insert into inv.wastage (tenant_id, delivery_node_id, idempotency_key)
  values (v_me.tenant_id, p_node, p_idempotency_key) returning * into v_w;

  for v_line in select * from jsonb_to_recordset(p_lines)
                  as l(item_id uuid, qty numeric, reason text, photo_key text) loop
    if v_line.qty is null or v_line.qty <= 0 then
      perform inv.fail('INVALID_QUANTITY', 'wastage quantity must be positive');
    end if;
    if v_line.reason is null
       or v_line.reason not in ('expired', 'spoiled', 'prep_error', 'damaged', 'other') then
      perform inv.fail('INVALID_LINES', 'unknown wastage reason');
    end if;
    if v_line.photo_key is not null and v_line.photo_key !~ v_photo_re then
      perform inv.fail('INVALID_PHOTO', 'photo was not uploaded for this location');
    end if;
    if inv.on_hand(v_line.item_id, p_node) < v_line.qty then
      perform inv.fail('INSUFFICIENT_STOCK', format('item %s', v_line.item_id));
    end if;
    v_cost := inv.avg_cost(v_line.item_id, p_node);
    v_value := round(v_line.qty * v_cost, 2);

    if v_value > v_threshold then
      if v_line.photo_key is null then
        perform inv.fail('PHOTO_REQUIRED', format('wastage worth %s needs a photo', v_value));
      end if;
      v_approval := v_approval || jsonb_build_object(
        'item_id', v_line.item_id, 'movement_type', 'wastage', 'qty', -v_line.qty,
        'unit_cost', v_cost, 'reason', v_line.reason, 'photo_key', v_line.photo_key);
    else
      perform inv.post(v_line.item_id, p_node, 'wastage', -v_line.qty, v_cost, 'wastage',
                       v_w.id, v_line.reason);
    end if;
    insert into inv.wastage_line (tenant_id, wastage_id, item_id, delivery_node_id, qty, reason,
                                  unit_cost, value, photo_key, outcome)
    values (v_me.tenant_id, v_w.id, v_line.item_id, p_node, v_line.qty, v_line.reason, v_cost,
            v_value, v_line.photo_key,
            case when v_value > v_threshold then 'approval' else 'posted' end);
  end loop;

  if jsonb_array_length(v_approval) > 0 then
    update inv.wastage
       set adjustment_id = inv.submit_adjustment(p_node, 'wastage', 'wastage', v_w.id, v_approval)
     where id = v_w.id;
  end if;
  return v_w.id;
end $$;

-- ---------------------------------------------------------------------------
-- Stock counts
-- ---------------------------------------------------------------------------

-- Opens a count for p_node with system_qty snapshotted for every item set up there.
-- An open count for the node is resumed rather than duplicated.
create function inv.start_count(p_node uuid) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_id uuid;
begin
  perform inv.require('STOCK_ADJUSTMENTS', 'modify', p_node);
  perform pg_advisory_xact_lock(hashtextextended('inv.count:' || p_node, 0));
  select id into v_id from inv.stock_count
   where delivery_node_id = p_node and status = 'open' order by started_at limit 1;
  if found then return v_id; end if;

  insert into inv.stock_count (tenant_id, delivery_node_id)
  values (v_me.tenant_id, p_node) returning id into v_id;
  insert into inv.stock_count_line (tenant_id, count_id, item_id, delivery_node_id, system_qty,
                                    unit_cost)
  select v_me.tenant_id, v_id, n.item_id, p_node, coalesce(s.on_hand, 0), coalesce(s.avg_cost, 0)
    from inv.item_node n
    join inv.item i on i.id = n.item_id and i.archived_at is null
    left join inv.stock_level s on s.item_id = n.item_id and s.delivery_node_id = p_node
   where n.delivery_node_id = p_node and n.archived_at is null;
  return v_id;
end $$;

-- p_lines: [{item_id, counted_qty}]. Uncounted lines are left as no change. Variance
-- within the item's count_tolerance_qty posts count_adjust now; beyond it goes to
-- STOCK_ADJUSTMENT approval. Returns {posted, approval, no_change, adjustment_id}.
-- Submitting an already submitted count returns the same summary.
create function inv.submit_count(p_count_id uuid, p_lines jsonb) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_count inv.stock_count;
  v_line record;
  v_variance numeric;
  v_tolerance numeric;
  v_approval jsonb := '[]';
begin
  perform wf.me();
  select * into v_count from inv.stock_count
   where id = p_count_id and tenant_id = core.my_tenant() for update;
  if not found then
    perform inv.fail('NOT_AUTHORISED', 'count not found');
  end if;
  perform inv.require('STOCK_ADJUSTMENTS', 'modify', v_count.delivery_node_id);

  if v_count.status = 'open' then
    if jsonb_typeof(p_lines) is distinct from 'array' then
      perform inv.fail('INVALID_LINES', 'lines must be an array');
    end if;
    for v_line in select * from jsonb_to_recordset(p_lines) as l(item_id uuid, counted_qty numeric) loop
      if v_line.counted_qty is null or v_line.counted_qty < 0 then
        perform inv.fail('INVALID_QUANTITY', 'counted quantity must be zero or more');
      end if;
      update inv.stock_count_line set counted_qty = v_line.counted_qty
       where count_id = p_count_id and item_id = v_line.item_id;
      if not found then
        perform inv.fail('INVALID_ITEM', 'item is not on this count');
      end if;
    end loop;

    for v_line in select cl.*, coalesce(n.count_tolerance_qty, 0) as tolerance
                    from inv.stock_count_line cl
                    left join inv.item_node n
                      on n.item_id = cl.item_id and n.delivery_node_id = cl.delivery_node_id
                   where cl.count_id = p_count_id loop
      v_variance := coalesce(v_line.counted_qty - v_line.system_qty, 0);
      if v_line.counted_qty is null or v_variance = 0 then
        update inv.stock_count_line set outcome = 'no_change' where id = v_line.id;
      elsif abs(v_variance) <= v_line.tolerance then
        perform inv.post(v_line.item_id, v_line.delivery_node_id, 'count_adjust', v_variance,
                         v_line.unit_cost, 'stock_count', p_count_id);
        update inv.stock_count_line set outcome = 'posted' where id = v_line.id;
      else
        v_approval := v_approval || jsonb_build_object(
          'item_id', v_line.item_id, 'movement_type', 'count_adjust', 'qty', v_variance,
          'unit_cost', v_line.unit_cost, 'reason', 'count_variance');
        update inv.stock_count_line set outcome = 'approval' where id = v_line.id;
      end if;
    end loop;

    update inv.stock_count
       set status = 'submitted', submitted_at = now(),
           adjustment_id = case when jsonb_array_length(v_approval) > 0 then
             inv.submit_adjustment(v_count.delivery_node_id, 'count_variance', 'stock_count',
                                   p_count_id, v_approval) end
     where id = p_count_id
    returning * into v_count;
  end if;

  return (select jsonb_build_object(
            'posted', count(*) filter (where outcome = 'posted'),
            'approval', count(*) filter (where outcome = 'approval'),
            'no_change', count(*) filter (where outcome = 'no_change'),
            'adjustment_id', v_count.adjustment_id)
            from inv.stock_count_line where count_id = p_count_id);
end $$;

-- ---------------------------------------------------------------------------
-- Purchase orders and receipts
-- ---------------------------------------------------------------------------

-- p_lines: [{item_id, qty, unit_cost}]. Creates the PO and submits PURCHASE_ORDER.
create function inv.create_po(p_node uuid, p_supplier uuid, p_lines jsonb,
                              p_notes text default null,
                              p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_po inv.purchase_order;
  v_request uuid;
begin
  if p_idempotency_key is not null then
    select * into v_po from inv.purchase_order
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_po.id; end if;
  end if;
  perform inv.require('PURCHASE_ORDERS', 'modify', p_node);
  perform inv.check_lines(p_lines, p_node);
  if not exists (select 1 from inv.supplier where id = p_supplier and tenant_id = v_me.tenant_id
                                               and archived_at is null) then
    perform inv.fail('INVALID_SUPPLIER', 'unknown supplier');
  end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as l(qty numeric, unit_cost numeric)
              where l.qty is null or l.qty <= 0 or l.unit_cost is null or l.unit_cost < 0) then
    perform inv.fail('INVALID_QUANTITY', 'every line needs a positive quantity and a price');
  end if;

  insert into inv.purchase_order (tenant_id, delivery_node_id, supplier_id, notes, total,
                                  idempotency_key)
  select v_me.tenant_id, p_node, p_supplier, p_notes, round(sum(l.qty * l.unit_cost), 2),
         p_idempotency_key
    from jsonb_to_recordset(p_lines) as l(qty numeric, unit_cost numeric)
  returning * into v_po;
  insert into inv.purchase_order_line (tenant_id, po_id, item_id, delivery_node_id, qty, unit_cost)
  select v_me.tenant_id, v_po.id, l.item_id, p_node, l.qty, l.unit_cost
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric, unit_cost numeric);

  v_request := wf.submit('PURCHASE_ORDER', 'inv.purchase_order', v_po.id);
  update inv.purchase_order set status = 'submitted', wf_request_id = v_request
   where id = v_po.id;
  return v_po.id;
end $$;

-- Goods receipt against a released PO. p_lines: [{item_id, qty, unit_cost?}]. Each line
-- is capped at ordered + 5% minus what was already received: the capped quantity posts
-- as receipt now, any excess becomes a STOCK_ADJUSTMENT (supplier_excess) for approval.
-- Returns the goods receipt id.
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
  perform inv.require('PURCHASE_ORDERS', 'modify', v_po.delivery_node_id);
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

-- Suggested order quantity per item at p_node (LLD section 5, forecast 0 for the MVP):
-- max(0, par_level - on_hand - open_po_qty), with the last price paid.
create function inv.suggested_order(p_node uuid)
returns table (item_id uuid, on_hand numeric, par_level numeric, open_po_qty numeric,
               suggested_qty numeric, preferred_supplier_id uuid, last_unit_cost numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
begin
  perform wf.me();
  perform inv.require('PURCHASE_ORDERS', 'view', p_node);
  return query
  with open_po as (
    select pl.item_id, sum(pl.qty - coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                                where gl.po_line_id = pl.id), 0)) as qty
      from inv.purchase_order_line pl
      join inv.purchase_order po on po.id = pl.po_id
     where po.delivery_node_id = p_node and po.status in ('submitted', 'released')
     group by pl.item_id
  )
  select n.item_id, coalesce(s.on_hand, 0), n.par_level, greatest(coalesce(o.qty, 0), 0),
         greatest(n.par_level - coalesce(s.on_hand, 0) - greatest(coalesce(o.qty, 0), 0), 0),
         n.preferred_supplier_id,
         (select pl.unit_cost from inv.purchase_order_line pl
           where pl.item_id = n.item_id and pl.delivery_node_id = p_node
           order by pl.created_at desc limit 1)
    from inv.item_node n
    join inv.item i on i.id = n.item_id and i.archived_at is null
    left join inv.stock_level s on s.item_id = n.item_id and s.delivery_node_id = p_node
    left join open_po o on o.item_id = n.item_id
   where n.delivery_node_id = p_node and n.archived_at is null;
end $$;

-- ---------------------------------------------------------------------------
-- Transfers
-- ---------------------------------------------------------------------------

-- Raised by the receiving side (TRANSFERS modify at p_to). p_lines: [{item_id, qty}].
create function inv.request_transfer(p_from uuid, p_to uuid, p_lines jsonb,
                                     p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_t inv.transfer;
  v_request uuid;
begin
  if p_idempotency_key is not null then
    select * into v_t from inv.transfer
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_t.id; end if;
  end if;
  perform inv.require('TRANSFERS', 'modify', p_to);
  if p_from is null or p_from = p_to
     or not exists (select 1 from core.hierarchy_node where id = p_from and type = 'delivery'
                                                         and tenant_id = v_me.tenant_id
                                                         and archived_at is null) then
    perform inv.fail('INVALID_SUBJECT', 'choose another location to transfer from');
  end if;
  perform inv.check_lines(p_lines, p_to);
  if exists (select 1 from jsonb_to_recordset(p_lines) as l(qty numeric)
              where l.qty is null or l.qty <= 0) then
    perform inv.fail('INVALID_QUANTITY', 'every line needs a positive quantity');
  end if;

  insert into inv.transfer (tenant_id, from_node_id, to_node_id, idempotency_key)
  values (v_me.tenant_id, p_from, p_to, p_idempotency_key) returning * into v_t;
  insert into inv.transfer_line (tenant_id, transfer_id, item_id, from_node_id, to_node_id,
                                 requested_qty)
  select v_me.tenant_id, v_t.id, l.item_id, p_from, p_to, l.qty
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric);

  v_request := wf.submit('TRANSFER', 'inv.transfer', v_t.id);
  update inv.transfer set status = 'submitted', wf_request_id = v_request where id = v_t.id;
  return v_t.id;
end $$;

-- The dispatching side approves the dispatch step and posts transfer_out, in one
-- transaction. p_lines: [{item_id, qty}] (missing lines ship the requested quantity;
-- 0 = not sent). After this the request cannot be rejected or cancelled.
create function inv.dispatch_transfer(p_transfer uuid, p_lines jsonb default '[]',
                                      p_comment text default null) returns text
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_t inv.transfer;
  v_l inv.transfer_line;
  v_qty numeric;
  v_cost numeric;
  v_state text;
begin
  select * into v_t from inv.transfer
   where id = p_transfer and tenant_id = v_me.tenant_id for update;
  if not found then
    perform inv.fail('NOT_AUTHORISED', 'transfer not found');
  end if;
  perform inv.require('TRANSFERS', 'modify', v_t.from_node_id);
  if v_t.status <> 'submitted' or v_t.dispatched_at is not null then
    perform inv.fail('INVALID_STATE', 'transfer is not waiting for dispatch');
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]')) <> 'array'
     or exists (select 1 from jsonb_to_recordset(coalesce(p_lines, '[]')) as l(item_id uuid, qty numeric)
                 where l.qty is null or l.qty < 0
                    or not exists (select 1 from inv.transfer_line
                                    where transfer_id = p_transfer and item_id = l.item_id)) then
    perform inv.fail('INVALID_LINES', 'dispatch lines must be items on this transfer, 0 or more');
  end if;

  -- Checks the caller may act on the dispatch step (and rule 7) before posting anything.
  v_state := wf.act_as_module(v_t.wf_request_id, 'dispatch', p_comment);

  for v_l in select * from inv.transfer_line where transfer_id = p_transfer order by id loop
    v_qty := coalesce((select (e ->> 'qty')::numeric from jsonb_array_elements(p_lines) e
                        where (e ->> 'item_id')::uuid = v_l.item_id), v_l.requested_qty);
    v_cost := inv.avg_cost(v_l.item_id, v_t.from_node_id);
    if v_qty > 0 then
      perform inv.post(v_l.item_id, v_t.from_node_id, 'transfer_out', -v_qty, v_cost,
                       'transfer', p_transfer);
    end if;
    update inv.transfer_line set dispatched_qty = v_qty, unit_cost = v_cost where id = v_l.id;
  end loop;
  update inv.transfer set dispatched_at = now(), dispatched_by = v_me.id where id = p_transfer;
  return v_state;
end $$;

-- The receiving side approves the receipt step: transfer_in of what was dispatched, and
-- any shortfall as wastage 'transit_loss' at the receiving node. p_lines: [{item_id, qty}]
-- (missing lines = received in full; more than dispatched is refused).
create function inv.receive_transfer(p_transfer uuid, p_lines jsonb default '[]',
                                     p_comment text default null) returns text
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_t inv.transfer;
  v_l inv.transfer_line;
  v_qty numeric;
  v_state text;
begin
  select * into v_t from inv.transfer
   where id = p_transfer and tenant_id = v_me.tenant_id for update;
  if not found then
    perform inv.fail('NOT_AUTHORISED', 'transfer not found');
  end if;
  perform inv.require('TRANSFERS', 'modify', v_t.to_node_id);
  if v_t.status <> 'submitted' or v_t.dispatched_at is null or v_t.received_at is not null then
    perform inv.fail('INVALID_STATE', 'transfer is not in transit');
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]')) <> 'array'
     or exists (select 1 from jsonb_to_recordset(coalesce(p_lines, '[]')) as l(item_id uuid, qty numeric)
                 where l.qty is null or l.qty < 0
                    or not exists (select 1 from inv.transfer_line tl
                                    where tl.transfer_id = p_transfer and tl.item_id = l.item_id
                                      and l.qty <= tl.dispatched_qty)) then
    perform inv.fail('INVALID_QUANTITY', 'cannot receive more than was dispatched');
  end if;

  v_state := wf.act_as_module(v_t.wf_request_id, 'receipt', p_comment);

  for v_l in select * from inv.transfer_line where transfer_id = p_transfer order by id loop
    v_qty := coalesce((select (e ->> 'qty')::numeric from jsonb_array_elements(p_lines) e
                        where (e ->> 'item_id')::uuid = v_l.item_id), v_l.dispatched_qty);
    if v_l.dispatched_qty > 0 then
      perform inv.post(v_l.item_id, v_t.to_node_id, 'transfer_in', v_l.dispatched_qty,
                       v_l.unit_cost, 'transfer', p_transfer);
    end if;
    if v_l.dispatched_qty > v_qty then
      perform inv.post(v_l.item_id, v_t.to_node_id, 'wastage', v_qty - v_l.dispatched_qty,
                       v_l.unit_cost, 'transfer', p_transfer, 'transit_loss');
    end if;
    update inv.transfer_line set received_qty = v_qty where id = v_l.id;
  end loop;
  update inv.transfer set received_at = now(), received_by = v_me.id where id = p_transfer;
  return v_state;
end $$;

-- ---------------------------------------------------------------------------
-- Executor entry point (wf_executor only). Idempotent per request.
-- ---------------------------------------------------------------------------

create function inv.execute(p_handler text, p_request_id uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_req wf.request;
  v_adj inv.stock_adjustment;
  v_line inv.stock_adjustment_line;
  v_closed text;
begin
  -- onApproved handlers run while the request is executing; onRejected handlers run on
  -- rejected or cancelled requests (their state is kept).
  select * into v_req from wf.request where id = p_request_id;
  if not found or v_req.state not in ('executing', 'rejected', 'cancelled') then
    perform inv.fail('INVALID_STATE', 'request is not being executed');
  end if;
  v_closed := case v_req.state when 'cancelled' then 'cancelled' else 'rejected' end;

  case p_handler
  when 'inv.stock_adjustment.post' then
    select * into v_adj from inv.stock_adjustment where wf_request_id = p_request_id for update;
    if v_adj.status = 'submitted' then
      for v_line in select * from inv.stock_adjustment_line where adjustment_id = v_adj.id
                     order by id loop
        perform inv.post(v_line.item_id, v_line.delivery_node_id, v_line.movement_type,
                         v_line.qty, v_line.unit_cost, 'stock_adjustment', v_adj.id,
                         coalesce(v_line.reason, v_adj.reason));
      end loop;
      update inv.stock_adjustment set status = 'posted', posted_at = now() where id = v_adj.id;
    end if;
  when 'inv.stock_adjustment.reject' then
    update inv.stock_adjustment set status = v_closed
     where wf_request_id = p_request_id and status = 'submitted';
  when 'inv.po.release' then
    update inv.purchase_order set status = 'released', released_at = now()
     where wf_request_id = p_request_id and status = 'submitted';
  when 'inv.po.reject' then
    update inv.purchase_order set status = v_closed
     where wf_request_id = p_request_id and status = 'submitted';
  when 'inv.transfer.post' then
    -- the legs were posted by dispatch_transfer / receive_transfer
    update inv.transfer set status = 'completed'
     where wf_request_id = p_request_id and status = 'submitted' and received_at is not null;
  when 'inv.transfer.reject' then
    update inv.transfer set status = v_closed
     where wf_request_id = p_request_id and status = 'submitted' and dispatched_at is null;
  else
    perform inv.fail('HANDLER_NOT_FOUND', p_handler);
  end case;
end $$;

-- ---------------------------------------------------------------------------
-- Read views (security_invoker: the caller's RLS applies)
-- ---------------------------------------------------------------------------

-- PO with receipt progress: awaiting_approval, released, partially_received, received,
-- rejected, cancelled.
create view inv.purchase_order_summary with (security_invoker = true) as
select po.id, po.tenant_id, po.delivery_node_id, po.supplier_id, po.status, po.total,
       po.currency, po.notes, po.created_at, po.created_by, po.released_at, po.wf_request_id,
       r.ordered_qty, r.received_qty,
       case
         when po.status = 'submitted' then 'awaiting_approval'
         when po.status <> 'released' then po.status
         when r.received_qty = 0 then 'released'
         when r.lines_open > 0 then 'partially_received'
         else 'received'
       end as progress
  from inv.purchase_order po
  cross join lateral (
    select sum(pl.qty) as ordered_qty,
           coalesce(sum(rec.qty), 0) as received_qty,
           count(*) filter (where coalesce(rec.qty, 0) < pl.qty) as lines_open
      from inv.purchase_order_line pl
      left join lateral (select sum(gl.qty) as qty from inv.goods_receipt_line gl
                          where gl.po_line_id = pl.id) rec on true
     where pl.po_id = po.id) r;

-- Transfer with its display state: awaiting_dispatch, in_transit, completed, rejected,
-- cancelled (and 'received' briefly, until the executor completes it).
create view inv.transfer_summary with (security_invoker = true) as
select t.id, t.tenant_id, t.from_node_id, t.to_node_id, t.status, t.wf_request_id,
       t.created_at, t.created_by, t.dispatched_at, t.dispatched_by, t.received_at, t.received_by,
       case
         when t.status <> 'submitted' then t.status
         when t.dispatched_at is null then 'awaiting_dispatch'
         when t.received_at is null then 'in_transit'
         else 'received'
       end as progress
  from inv.transfer t;

grant select on inv.purchase_order_summary, inv.transfer_summary to app_rw;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema inv from public;
grant execute on function
  inv.record_wastage(uuid, jsonb, text),
  inv.start_count(uuid),
  inv.submit_count(uuid, jsonb),
  inv.create_po(uuid, uuid, jsonb, text, text),
  inv.receive(uuid, jsonb, text),
  inv.suggested_order(uuid),
  inv.request_transfer(uuid, uuid, jsonb, text),
  inv.dispatch_transfer(uuid, jsonb, text),
  inv.receive_transfer(uuid, jsonb, text)
  to app_rw;
grant execute on function inv.execute(text, uuid) to wf_executor;

-- migrate:down
drop view inv.transfer_summary;
drop view inv.purchase_order_summary;
drop function inv.execute(text, uuid);
drop function inv.receive_transfer(uuid, jsonb, text);
drop function inv.dispatch_transfer(uuid, jsonb, text);
drop function inv.request_transfer(uuid, uuid, jsonb, text);
drop function inv.suggested_order(uuid);
drop function inv.receive(uuid, jsonb, text);
drop function inv.create_po(uuid, uuid, jsonb, text, text);
drop function inv.submit_count(uuid, jsonb);
drop function inv.start_count(uuid);
drop function inv.record_wastage(uuid, jsonb, text);
drop function inv.submit_adjustment(uuid, text, text, uuid, jsonb);
drop function inv.post(uuid, uuid, text, numeric, numeric, text, uuid, text);
drop function inv.avg_cost(uuid, uuid);
drop function inv.on_hand(uuid, uuid);
drop function inv.check_lines(jsonb, uuid);
drop function inv.require(text, text, uuid);
drop function inv.fail(text, text);
