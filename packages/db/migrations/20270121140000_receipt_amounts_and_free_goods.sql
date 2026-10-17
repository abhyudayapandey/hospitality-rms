-- migrate:up
-- A receipt keeps the amount typed, and free goods can be received (ADR 168, M14, M15).
--
-- M14: each line's amount became round(amount / qty, 4) a unit and the amount was dropped:
-- Rs 1,000 for 3,000 g became 0.3333 a gram, Rs 999.90, while the bill made in the same tap
-- said Rs 1,000. Now the line keeps the amount typed (goods_receipt_line.amount), receipts are
-- valued from it, and unit costs keep 6 decimals (receipt lines, the ledger, stock levels, transfer lines), so
-- 3,000 x 0.333333 is Rs 1,000.00 too.
-- M15: every received line needed an amount above 0 (AMOUNT_REQUIRED), so free goods were left
-- out or given a made-up price. A line marked free (free: true and a reason) is received at a
-- cost of 0, its reason kept on the line.

alter table inv.goods_receipt_line
  alter column unit_cost type numeric(18,6),
  add column amount numeric(14,2) check (amount >= 0),
  add column free_reason text
    check (free_reason is null or length(btrim(free_reason)) between 1 and 200),
  add constraint goods_receipt_line_free check (free_reason is null or amount = 0);
comment on column inv.goods_receipt_line.amount is
  'the amount typed for the line (all of it, any excess too); null before ADR 168';
alter table inv.stock_ledger alter column unit_cost type numeric(18,6);
alter table inv.transfer_line alter column unit_cost type numeric(18,6);
-- the average cost too, and the stock's value is on hand x that average, as stored, so the
-- items' values add up to the store's
alter table inv.stock_level alter column avg_cost type numeric(18,6);
select core.patch_function('inv.ledger_apply()',
$x$                  else (v_old * v_avg + new.qty * new.unit_cost) / v_on_hand end;$x$,
$x$                  else (v_old * v_avg + new.qty * new.unit_cost) / v_on_hand end;
    v_avg := round(v_avg, 6);$x$);
select core.patch_function('inv.ledger_apply()',
$x$v_on_hand, round(v_avg, 4),$x$, $x$v_on_hand, v_avg,$x$);

-- receive_goods: free lines with a reason; the amount and 6-decimal unit cost go on
select core.patch_function('inv.receive_goods(uuid,jsonb,text)',
$x$  begin
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'item_id', l.item_id, 'qty', l.qty, 'unit_cost', round(l.amount / l.qty, 4),
             'to', l."to", 'expires_on', l.expires_on))), '[]')
      into v_lines
      from jsonb_to_recordset(p_lines)
             as l(item_id uuid, qty numeric, amount numeric, "to" text, expires_on date)
     where coalesce(l.qty, 0) > 0;$x$,
$x$  -- free goods: marked free, with why (ADR 168)
  if exists (select 1 from jsonb_to_recordset(p_lines)
                             as l(qty numeric, free boolean, free_reason text)
              where coalesce(l.qty, 0) > 0 and coalesce(l.free, false)
                and length(btrim(coalesce(l.free_reason, ''))) not between 1 and 200) then
    perform inv.fail('FREE_REASON_REQUIRED', 'say why it came free');
  end if;
  begin
    -- the amount typed stays on the line; the unit cost keeps 6 decimals (ADR 168)
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'item_id', l.item_id, 'qty', l.qty,
             'unit_cost', case when coalesce(l.free, false) then 0
                               else round(l.amount / l.qty, 6) end,
             'amount', case when coalesce(l.free, false) then 0 else round(l.amount, 2) end,
             'free_reason', case when coalesce(l.free, false) then btrim(l.free_reason) end,
             'to', l."to", 'expires_on', l.expires_on))), '[]')
      into v_lines
      from jsonb_to_recordset(p_lines)
             as l(item_id uuid, qty numeric, amount numeric, "to" text, expires_on date,
                  free boolean, free_reason text)
     where coalesce(l.qty, 0) > 0;$x$);
select core.patch_function('inv.receive_goods(uuid,jsonb,text)',
$x$  if exists (select 1 from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric, amount numeric)
              where coalesce(l.qty, 0) > 0 and coalesce(l.amount, 0) <= 0) then$x$,
$x$  if exists (select 1 from jsonb_to_recordset(p_lines)
                             as l(item_id uuid, qty numeric, amount numeric, free boolean)
              where coalesce(l.qty, 0) > 0 and coalesce(l.amount, 0) <= 0
                and not coalesce(l.free, false)) then$x$);

-- receive_at: the line keeps its amount and why it was free
select core.patch_function('inv.receive_at(uuid,jsonb,text,timestamptz)',
$x$                  as l(item_id uuid, qty numeric, unit_cost numeric, "to" text, expires_on date) loop$x$,
$x$                  as l(item_id uuid, qty numeric, unit_cost numeric, "to" text, expires_on date,
                       amount numeric, free_reason text) loop$x$);
select core.patch_function('inv.receive_at(uuid,jsonb,text,timestamptz)',
$x$    insert into inv.goods_receipt_line (tenant_id, receipt_id, po_line_id, item_id,
                                        delivery_node_id, qty, excess_qty, unit_cost, expires_on)
    values (v_me.tenant_id, v_gr.id, v_pol.id, v_line.item_id, v_at, v_accept,
            v_line.qty - v_accept, v_cost, v_line.expires_on);$x$,
$x$    insert into inv.goods_receipt_line (tenant_id, receipt_id, po_line_id, item_id,
                                        delivery_node_id, qty, excess_qty, unit_cost, expires_on,
                                        amount, free_reason)
    values (v_me.tenant_id, v_gr.id, v_pol.id, v_line.item_id, v_at, v_accept,
            v_line.qty - v_accept, v_cost, v_line.expires_on, v_line.amount,
            v_line.free_reason);$x$);

-- what was received is worth what was typed for it, where nothing went over the order
select core.patch_function('inv.po_received_value(uuid)',
$x$  select round(sum(gl.qty * gl.unit_cost), 2)$x$,
$x$  select round(sum(case when gl.amount is not null and gl.excess_qty = 0 then gl.amount
                         else gl.qty * gl.unit_cost end), 2)$x$);

-- stock movements: a receipt is worth what was typed for it
select core.patch_function('rpt.stock_movements(uuid,date,date)',
$x$         coalesce((select round(sum((gl.qty + gl.excess_qty) * gl.unit_cost), 2)$x$,
$x$         coalesce((select round(sum(coalesce(gl.amount,
                                             (gl.qty + gl.excess_qty) * gl.unit_cost)), 2)$x$);
select core.patch_function('rpt.stock_movements(uuid,date,date)',
$x$                             'value', round((gl.qty + gl.excess_qty) * gl.unit_cost, 2))$x$,
$x$                             'value', round(coalesce(gl.amount,
                                                    (gl.qty + gl.excess_qty) * gl.unit_cost), 2))$x$);

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
select core.patch_function('rpt.stock_movements(uuid,date,date)',
$x$                             'value', round(coalesce(gl.amount,
                                                    (gl.qty + gl.excess_qty) * gl.unit_cost), 2))$x$,
$x$                             'value', round((gl.qty + gl.excess_qty) * gl.unit_cost, 2))$x$);
select core.patch_function('rpt.stock_movements(uuid,date,date)',
$x$         coalesce((select round(sum(coalesce(gl.amount,
                                             (gl.qty + gl.excess_qty) * gl.unit_cost)), 2)$x$,
$x$         coalesce((select round(sum((gl.qty + gl.excess_qty) * gl.unit_cost), 2)$x$);
select core.patch_function('inv.po_received_value(uuid)',
$x$  select round(sum(case when gl.amount is not null and gl.excess_qty = 0 then gl.amount
                         else gl.qty * gl.unit_cost end), 2)$x$,
$x$  select round(sum(gl.qty * gl.unit_cost), 2)$x$);
select core.patch_function('inv.receive_at(uuid,jsonb,text,timestamptz)',
$x$    insert into inv.goods_receipt_line (tenant_id, receipt_id, po_line_id, item_id,
                                        delivery_node_id, qty, excess_qty, unit_cost, expires_on,
                                        amount, free_reason)
    values (v_me.tenant_id, v_gr.id, v_pol.id, v_line.item_id, v_at, v_accept,
            v_line.qty - v_accept, v_cost, v_line.expires_on, v_line.amount,
            v_line.free_reason);$x$,
$x$    insert into inv.goods_receipt_line (tenant_id, receipt_id, po_line_id, item_id,
                                        delivery_node_id, qty, excess_qty, unit_cost, expires_on)
    values (v_me.tenant_id, v_gr.id, v_pol.id, v_line.item_id, v_at, v_accept,
            v_line.qty - v_accept, v_cost, v_line.expires_on);$x$);
select core.patch_function('inv.receive_at(uuid,jsonb,text,timestamptz)',
$x$                  as l(item_id uuid, qty numeric, unit_cost numeric, "to" text, expires_on date,
                       amount numeric, free_reason text) loop$x$,
$x$                  as l(item_id uuid, qty numeric, unit_cost numeric, "to" text, expires_on date) loop$x$);
select core.patch_function('inv.receive_goods(uuid,jsonb,text)',
$x$  if exists (select 1 from jsonb_to_recordset(p_lines)
                             as l(item_id uuid, qty numeric, amount numeric, free boolean)
              where coalesce(l.qty, 0) > 0 and coalesce(l.amount, 0) <= 0
                and not coalesce(l.free, false)) then$x$,
$x$  if exists (select 1 from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric, amount numeric)
              where coalesce(l.qty, 0) > 0 and coalesce(l.amount, 0) <= 0) then$x$);
select core.patch_function('inv.receive_goods(uuid,jsonb,text)',
$x$  -- free goods: marked free, with why (ADR 168)
  if exists (select 1 from jsonb_to_recordset(p_lines)
                             as l(qty numeric, free boolean, free_reason text)
              where coalesce(l.qty, 0) > 0 and coalesce(l.free, false)
                and length(btrim(coalesce(l.free_reason, ''))) not between 1 and 200) then
    perform inv.fail('FREE_REASON_REQUIRED', 'say why it came free');
  end if;
  begin
    -- the amount typed stays on the line; the unit cost keeps 6 decimals (ADR 168)
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'item_id', l.item_id, 'qty', l.qty,
             'unit_cost', case when coalesce(l.free, false) then 0
                               else round(l.amount / l.qty, 6) end,
             'amount', case when coalesce(l.free, false) then 0 else round(l.amount, 2) end,
             'free_reason', case when coalesce(l.free, false) then btrim(l.free_reason) end,
             'to', l."to", 'expires_on', l.expires_on))), '[]')
      into v_lines
      from jsonb_to_recordset(p_lines)
             as l(item_id uuid, qty numeric, amount numeric, "to" text, expires_on date,
                  free boolean, free_reason text)
     where coalesce(l.qty, 0) > 0;$x$,
$x$  begin
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'item_id', l.item_id, 'qty', l.qty, 'unit_cost', round(l.amount / l.qty, 4),
             'to', l."to", 'expires_on', l.expires_on))), '[]')
      into v_lines
      from jsonb_to_recordset(p_lines)
             as l(item_id uuid, qty numeric, amount numeric, "to" text, expires_on date)
     where coalesce(l.qty, 0) > 0;$x$);
select core.patch_function('inv.ledger_apply()',
$x$v_on_hand, v_avg,$x$, $x$v_on_hand, round(v_avg, 4),$x$);
select core.patch_function('inv.ledger_apply()',
$x$
    v_avg := round(v_avg, 6);$x$, '');
alter table inv.stock_level alter column avg_cost type numeric(14,4);
alter table inv.transfer_line alter column unit_cost type numeric(14,4);
alter table inv.stock_ledger alter column unit_cost type numeric(14,4);
alter table inv.goods_receipt_line drop constraint goods_receipt_line_free,
  drop column free_reason, drop column amount,
  alter column unit_cost type numeric(14,4);
