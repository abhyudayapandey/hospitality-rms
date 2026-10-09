-- migrate:up
-- Receiving: into the store or straight to the department that asked, with an optional expiry
-- date per line (GM feedback item 14, ADR 080).
--
-- An order the Main Store places for a department (inv.via_desk, ADR 049) was received into
-- the department's store directly, so the Main Store's ledger never saw it. Now the keeper
-- says, line by line, where it goes:
--   * into the store: a receipt at the Main Store, which keeps it and sends it on later;
--   * to the department: a receipt at the Main Store and, in the same transaction, a direct
--     issue (an inv.transfer of kind 'issue', out of the Main Store and into the department's
--     store at once). Ledger inserts only (rule 3): never an UPDATE.
-- The default for each line comes from the item (inv.item.receive_to, file 10's optional
-- `receive_to`, the store by default); the form shows it and the keeper may change it.
-- A line that says nothing (the loader's past test orders, an older app) is posted as before,
-- at the order's own store. An order the store placed for itself goes into that store.
-- Each line may carry an expiry date: the receipt is a dated batch (ADR 040, 046), and an
-- issued line takes its date with it.

alter table inv.item add column receive_to text not null default 'store'
  constraint item_receive_to check (receive_to in ('store', 'department'));

alter table inv.transfer drop constraint transfer_kind_check,
  add constraint transfer_kind_check check (kind in ('transfer', 'rfm', 'send', 'issue'));

alter table inv.goods_receipt_line
  add column expires_on date,
  add column issued_to uuid references core.hierarchy_node(id),
  add column issue_id uuid references inv.transfer(id);

-- p_lines: [{item_id, qty, unit_cost?, to?: 'store' | 'department', expires_on?: date}].
create or replace function inv.receive_at(p_po uuid, p_lines jsonb, p_idempotency_key text,
                                          p_at timestamptz)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf, ops, rpt
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
  v_desk uuid;
  v_via boolean;
  v_at uuid;          -- where this line is received
  v_issue inv.transfer;
  v_tz text;
  v_exp timestamptz;
  v_batch text;
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
  if not inv.can_place(v_po.id) then
    perform inv.require('PURCHASE_ORDERS', 'view', v_po.delivery_node_id);
    perform inv.require('STOCK_ADJUSTMENTS', 'modify', v_po.delivery_node_id);
  end if;
  if v_po.status <> 'released' or v_po.ordered_at is null then
    perform inv.fail('INVALID_STATE', format('purchase order is %s', v_po.status));
  end if;
  perform inv.check_lines(p_lines, v_po.delivery_node_id);
  if exists (select 1 from jsonb_to_recordset(p_lines) as l("to" text)
              where l."to" is not null and l."to" not in ('store', 'department')) then
    perform inv.fail('INVALID_LINES', 'each line goes into the store or to the department');
  end if;
  v_desk := inv.order_desk(v_po.delivery_node_id);
  v_via := v_desk <> v_po.delivery_node_id;
  if not v_via and exists (select 1 from jsonb_to_recordset(p_lines) as l("to" text)
                            where l."to" = 'department') then
    perform inv.fail('INVALID_LINES', 'no department asked for this order');
  end if;
  v_tz := ops.tz_of(v_po.delivery_node_id);
  if exists (select 1 from jsonb_to_recordset(p_lines) as l(expires_on date)
              where l.expires_on < rpt.business_date(p_at, v_tz)) then
    perform inv.fail('EXPIRY_PASSED', 'the expiry date has passed');
  end if;

  insert into inv.goods_receipt (tenant_id, po_id, delivery_node_id, received_at, idempotency_key)
  values (v_me.tenant_id, p_po, v_po.delivery_node_id, p_at, p_idempotency_key) returning * into v_gr;

  for v_line in select * from jsonb_to_recordset(p_lines)
                  as l(item_id uuid, qty numeric, unit_cost numeric, "to" text, expires_on date) loop
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
    -- said: the Main Store receives it (and issues it on, for the department); unsaid: as before
    v_at := case when v_line."to" is null then v_po.delivery_node_id else v_desk end;
    if v_line."to" = 'store' and v_at <> v_po.delivery_node_id
       and not exists (select 1 from inv.item_node x where x.item_id = v_line.item_id
                          and x.delivery_node_id = v_at and x.archived_at is null) then
      perform inv.fail('INVALID_ITEM', 'the Main Store does not keep this item');
    end if;
    v_exp := case when v_line.expires_on is not null
                  then rpt.day_start(v_line.expires_on, v_tz) + interval '12 hours' end;
    v_batch := case when v_exp is not null
                    then 'Received ' || to_char(rpt.business_date(p_at, v_tz), 'YYYY-MM-DD') end;
    insert into inv.goods_receipt_line (tenant_id, receipt_id, po_line_id, item_id,
                                        delivery_node_id, qty, excess_qty, unit_cost, expires_on)
    values (v_me.tenant_id, v_gr.id, v_pol.id, v_line.item_id, v_at, v_accept,
            v_line.qty - v_accept, v_cost, v_line.expires_on);
    if v_accept > 0 then
      insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                    unit_cost, ref_type, ref_id, occurred_at, batch_no, expires_at)
      values (v_me.tenant_id, v_line.item_id, v_at, 'receipt', v_accept, coalesce(v_cost, 0),
              'goods_receipt', v_gr.id, p_at, v_batch, v_exp);
      if v_line."to" = 'department' then
        -- the direct issue: out of the Main Store and into the department's store at once
        if v_issue.id is null then
          insert into inv.transfer (tenant_id, from_node_id, to_node_id, kind, status,
                                    dispatched_at, dispatched_by, received_at, received_by)
          values (v_me.tenant_id, v_desk, v_po.delivery_node_id, 'issue', 'completed', p_at,
                  v_me.id, p_at, v_me.id)
          returning * into v_issue;
        end if;
        insert into inv.transfer_line (tenant_id, transfer_id, item_id, from_node_id, to_node_id,
                                       requested_qty, dispatched_qty, received_qty, unit_cost)
        values (v_me.tenant_id, v_issue.id, v_line.item_id, v_desk, v_po.delivery_node_id,
                v_accept, v_accept, v_accept, coalesce(v_cost, 0));
        insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                      unit_cost, ref_type, ref_id, occurred_at, batch_no, expires_at)
        values (v_me.tenant_id, v_line.item_id, v_desk, 'transfer_out', -v_accept,
                coalesce(v_cost, 0), 'transfer', v_issue.id, p_at, v_batch, v_exp),
               (v_me.tenant_id, v_line.item_id, v_po.delivery_node_id, 'transfer_in', v_accept,
                coalesce(v_cost, 0), 'transfer', v_issue.id, p_at, v_batch, v_exp);
        update inv.goods_receipt_line set issued_to = v_po.delivery_node_id, issue_id = v_issue.id
         where receipt_id = v_gr.id and po_line_id = v_pol.id;
      end if;
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
  perform inv.notify_received(p_po, v_me.id);
  return v_gr.id;
end $$;

-- The app's receiving: amounts per line (ADR 051), and where each line goes and its expiry
-- (ADR 080). p_lines: [{item_id, qty, amount, to?, expires_on?}].
create or replace function inv.receive_goods(p_po uuid, p_lines jsonb, p_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_lines jsonb;
begin
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' then
    perform inv.fail('INVALID_LINES', 'lines must be an array');
  end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric, amount numeric)
              where l.qty < 0 or l.amount < 0) then
    perform inv.fail('INVALID_QUANTITY', 'quantities and amounts are zero or more');
  end if;
  begin
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'item_id', l.item_id, 'qty', l.qty, 'unit_cost', round(l.amount / l.qty, 4),
             'to', l."to", 'expires_on', l.expires_on))), '[]')
      into v_lines
      from jsonb_to_recordset(p_lines)
             as l(item_id uuid, qty numeric, amount numeric, "to" text, expires_on date)
     where coalesce(l.qty, 0) > 0;
  exception when invalid_datetime_format or datetime_field_overflow then
    perform inv.fail('EXPIRY_PASSED', 'an expiry is a date');
  end;
  if jsonb_array_length(v_lines) = 0 then
    perform inv.fail('INVALID_LINES', 'enter what arrived');
  end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric, amount numeric)
              where coalesce(l.qty, 0) > 0 and coalesce(l.amount, 0) <= 0) then
    perform inv.fail('AMOUNT_REQUIRED', 'every item received needs its amount');
  end if;
  -- closed: nothing more comes (ADR 052)
  if exists (select 1 from inv.purchase_order where id = p_po and closed_at is not null) then
    perform inv.fail('INVALID_STATE', 'the order is closed');
  end if;
  -- the Main Store receives what it orders for a department (ADR 049, 052)
  if inv.via_desk(p_po) and not inv.can_place(p_po) then
    perform inv.fail('NOT_AUTHORISED', 'the Main Store receives this order');
  end if;
  return inv.receive_at(p_po, v_lines, p_key, now());
end $$;

-- What the receive form needs per line: where it goes by default (the item's receive_to,
-- only when a department asked), whether the Main Store keeps the item, and the department.
create function inv.receive_defaults(p_po uuid)
returns table (item_id uuid, receive_to text, desk_keeps boolean, department text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_po inv.purchase_order;
  v_desk uuid;
begin
  select * into v_po from inv.purchase_order where id = p_po and tenant_id = core.my_tenant();
  if not found or not (inv.can_place(p_po)
                       or core.can('PURCHASE_ORDERS', 'view', null, v_po.delivery_node_id)) then
    perform inv.fail('NOT_AUTHORISED', 'purchase order not found');
  end if;
  v_desk := inv.order_desk(v_po.delivery_node_id);
  return query
    select l.item_id,
           case when v_desk = v_po.delivery_node_id then 'store' else i.receive_to end,
           exists (select 1 from inv.item_node x where x.item_id = l.item_id
                     and x.delivery_node_id = v_desk and x.archived_at is null),
           case when v_desk <> v_po.delivery_node_id then core.node_name(v_po.delivery_node_id) end
      from inv.purchase_order_line l join inv.item i on i.id = l.item_id
     where l.po_id = p_po;
end $$;
revoke execute on function inv.receive_defaults(uuid) from public;
grant execute on function inv.receive_defaults(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function inv.receive_defaults(uuid);
create or replace function inv.receive_goods(p_po uuid, p_lines jsonb, p_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_lines jsonb;
begin
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' then
    perform inv.fail('INVALID_LINES', 'lines must be an array');
  end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric, amount numeric)
              where l.qty < 0 or l.amount < 0) then
    perform inv.fail('INVALID_QUANTITY', 'quantities and amounts are zero or more');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', l.item_id, 'qty', l.qty, 'unit_cost', round(l.amount / l.qty, 4))), '[]')
    into v_lines
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric, amount numeric)
   where coalesce(l.qty, 0) > 0;
  if jsonb_array_length(v_lines) = 0 then
    perform inv.fail('INVALID_LINES', 'enter what arrived');
  end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric, amount numeric)
              where coalesce(l.qty, 0) > 0 and coalesce(l.amount, 0) <= 0) then
    perform inv.fail('AMOUNT_REQUIRED', 'every item received needs its amount');
  end if;
  if exists (select 1 from inv.purchase_order where id = p_po and closed_at is not null) then
    perform inv.fail('INVALID_STATE', 'the order is closed');
  end if;
  if inv.via_desk(p_po) and not inv.can_place(p_po) then
    perform inv.fail('NOT_AUTHORISED', 'the Main Store receives this order');
  end if;
  return inv.receive_at(p_po, v_lines, p_key, now());
end $$;
create or replace function inv.receive_at(p_po uuid, p_lines jsonb, p_idempotency_key text,
                                          p_at timestamptz)
returns uuid
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
  if not inv.can_place(v_po.id) then
    perform inv.require('PURCHASE_ORDERS', 'view', v_po.delivery_node_id);
    perform inv.require('STOCK_ADJUSTMENTS', 'modify', v_po.delivery_node_id);
  end if;
  if v_po.status <> 'released' or v_po.ordered_at is null then
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
  perform inv.notify_received(p_po, v_me.id);
  return v_gr.id;
end $$;
delete from inv.stock_ledger where ref_type = 'transfer'
   and ref_id in (select id from inv.transfer where kind = 'issue');
delete from inv.transfer_line where transfer_id in (select id from inv.transfer where kind = 'issue');
alter table inv.goods_receipt_line drop column issue_id, drop column issued_to, drop column expires_on;
delete from inv.transfer where kind = 'issue';
alter table inv.transfer drop constraint transfer_kind_check,
  add constraint transfer_kind_check check (kind in ('transfer', 'rfm', 'send'));
alter table inv.item drop constraint item_receive_to, drop column receive_to;
