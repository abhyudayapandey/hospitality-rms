-- migrate:up
-- One screen for an order (ADR 163): the order desk places it as soon as its approval is final,
-- without waiting a minute for the executor, and may change how much of each item it orders.
-- An order no one had to approve may be for more than was short; an order someone approved may
-- be for less, never more (MORE_THAN_APPROVED).

create or replace function inv.place_order(p_po uuid, p_groups jsonb, p_idempotency_key text default null)
returns uuid[]
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_po inv.purchase_order;
  v_g record;
  v_n int := 0;
  v_target uuid;
  v_ids uuid[] := '{}';
  v_have int;
  v_given int;
  v_distinct int;
  v_approved boolean;
begin
  select * into v_po from inv.purchase_order
   where id = p_po and tenant_id = v_me.tenant_id for update;
  if not found or not inv.can_place(p_po) then
    perform inv.fail('NOT_AUTHORISED', 'place an order for this request');
  end if;
  -- approved but not yet released (the executor's next minute): the desk need not wait. The
  -- release is the executor's own step (inv.execute 'inv.po.release'), done here at once; the
  -- executor's run then finds it done (ADR 163).
  if v_po.status = 'submitted' and v_po.ordered_at is null and exists (
       select 1 from wf.request r where r.id = v_po.wf_request_id and r.state = 'approved') then
    update inv.purchase_order set status = 'released', released_at = now()
     where wf_request_id = v_po.wf_request_id and status = 'submitted';
    select * into v_po from inv.purchase_order where id = p_po;
  end if;
  if v_po.status <> 'released' or v_po.ordered_at is not null then
    -- placing twice (a double tap) answers with what is already placed
    if v_po.ordered_at is not null then
      return array(select id from inv.purchase_order
                    where id = p_po or request_po_id = p_po order by created_at, id);
    end if;
    perform inv.fail('INVALID_STATE', format('request is %s', v_po.status));
  end if;
  v_approved := exists (select 1 from wf.step_instance s
                         where s.request_id = v_po.wf_request_id and s.state = 'approved'
                           and s.actor_id is not null);
  if jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups) = 0 then
    perform inv.fail('INVALID_LINES', 'nothing to order');
  end if;

  select count(*) into v_have from inv.purchase_order_line where po_id = p_po;
  select count(*), count(distinct x.item_id) into v_given, v_distinct
    from jsonb_array_elements(p_groups) g,
         jsonb_to_recordset(g -> 'lines') as x(item_id uuid);
  if v_given <> v_have or v_distinct <> v_have or exists (
       select 1 from jsonb_array_elements(p_groups) g,
                     jsonb_to_recordset(g -> 'lines') as x(item_id uuid)
        where not exists (select 1 from inv.purchase_order_line pl
                           where pl.po_id = p_po and pl.item_id = x.item_id)) then
    perform inv.fail('INVALID_LINES', 'every item goes in exactly one order');
  end if;

  for v_g in select (g ->> 'supplier_id')::uuid as supplier_id,
                    (g ->> 'expected_on')::date as expected_on, g -> 'lines' as lines
               from jsonb_array_elements(p_groups) g loop
    v_n := v_n + 1;
    if v_g.expected_on is null or v_g.expected_on < current_date then
      perform inv.fail('INVALID_DATE', 'when it will be delivered');
    end if;
    if v_g.supplier_id is not null and not exists (
         select 1 from inv.supplier where id = v_g.supplier_id and tenant_id = v_me.tenant_id
                                      and archived_at is null) then
      perform inv.fail('INVALID_SUPPLIER', 'unknown supplier');
    end if;
    if exists (select 1 from jsonb_to_recordset(v_g.lines) as x(unit_cost numeric)
                where x.unit_cost is not null and x.unit_cost < 0) then
      perform inv.fail('INVALID_QUANTITY', 'a price cannot be negative');
    end if;
    if exists (select 1 from jsonb_to_recordset(v_g.lines) as x(qty numeric)
                where x.qty is not null and x.qty <= 0) then
      perform inv.fail('INVALID_QUANTITY', 'order more than 0');
    end if;
    -- what someone approved is the most that may be ordered; with no one's approval the desk
    -- may order more than was short (ADR 163)
    if v_approved and exists (
         select 1 from jsonb_to_recordset(v_g.lines) as x(item_id uuid, qty numeric)
           join inv.purchase_order_line pl on pl.po_id = p_po and pl.item_id = x.item_id
          where x.qty is not null and x.qty > pl.qty) then
      perform inv.fail('MORE_THAN_APPROVED', 'order no more than was approved');
    end if;
    update inv.purchase_order_line pl set qty = x.qty
      from jsonb_to_recordset(v_g.lines) as x(item_id uuid, qty numeric)
     where pl.po_id = p_po and pl.item_id = x.item_id and x.qty is not null;
    if v_n = 1 then
      v_target := p_po;
    else
      insert into inv.purchase_order (tenant_id, delivery_node_id, status, notes, currency,
                                      released_at, wf_request_id, request_po_id, created_by)
      values (v_po.tenant_id, v_po.delivery_node_id, 'released', v_po.notes, v_po.currency,
              v_po.released_at, v_po.wf_request_id, p_po, v_po.created_by)
      returning id into v_target;
      update inv.purchase_order_line pl set po_id = v_target
       where pl.po_id = p_po
         and pl.item_id in (select x.item_id from jsonb_to_recordset(v_g.lines) as x(item_id uuid));
    end if;
    update inv.purchase_order_line pl set unit_cost = x.unit_cost
      from jsonb_to_recordset(v_g.lines) as x(item_id uuid, unit_cost numeric)
     where pl.po_id = v_target and pl.item_id = x.item_id and x.unit_cost is not null;
    update inv.purchase_order po
       set supplier_id = v_g.supplier_id, expected_on = v_g.expected_on,
           ordered_at = now(), ordered_by = v_me.id,
           total = coalesce((select round(sum(pl.qty * pl.unit_cost), 2)
                               from inv.purchase_order_line pl where pl.po_id = po.id), 0)
     where po.id = v_target;
    v_ids := v_ids || v_target;
  end loop;

  perform inv.notify_ordered(i, v_me.id) from unnest(v_ids) i;
  return v_ids;
end $$;

-- migrate:down
create or replace function inv.place_order(p_po uuid, p_groups jsonb, p_idempotency_key text default null)
returns uuid[]
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_po inv.purchase_order;
  v_g record;
  v_n int := 0;
  v_target uuid;
  v_ids uuid[] := '{}';
  v_have int;
  v_given int;
  v_distinct int;
begin
  select * into v_po from inv.purchase_order
   where id = p_po and tenant_id = v_me.tenant_id for update;
  if not found or not inv.can_place(p_po) then
    perform inv.fail('NOT_AUTHORISED', 'place an order for this request');
  end if;
  if v_po.status <> 'released' or v_po.ordered_at is not null then
    -- placing twice (a double tap) answers with what is already placed
    if v_po.ordered_at is not null then
      return array(select id from inv.purchase_order
                    where id = p_po or request_po_id = p_po order by created_at, id);
    end if;
    perform inv.fail('INVALID_STATE', format('request is %s', v_po.status));
  end if;
  if jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups) = 0 then
    perform inv.fail('INVALID_LINES', 'nothing to order');
  end if;

  select count(*) into v_have from inv.purchase_order_line where po_id = p_po;
  select count(*), count(distinct x.item_id) into v_given, v_distinct
    from jsonb_array_elements(p_groups) g,
         jsonb_to_recordset(g -> 'lines') as x(item_id uuid);
  if v_given <> v_have or v_distinct <> v_have or exists (
       select 1 from jsonb_array_elements(p_groups) g,
                     jsonb_to_recordset(g -> 'lines') as x(item_id uuid)
        where not exists (select 1 from inv.purchase_order_line pl
                           where pl.po_id = p_po and pl.item_id = x.item_id)) then
    perform inv.fail('INVALID_LINES', 'every item goes in exactly one order');
  end if;

  for v_g in select (g ->> 'supplier_id')::uuid as supplier_id,
                    (g ->> 'expected_on')::date as expected_on, g -> 'lines' as lines
               from jsonb_array_elements(p_groups) g loop
    v_n := v_n + 1;
    if v_g.expected_on is null or v_g.expected_on < current_date then
      perform inv.fail('INVALID_DATE', 'when it will be delivered');
    end if;
    if v_g.supplier_id is not null and not exists (
         select 1 from inv.supplier where id = v_g.supplier_id and tenant_id = v_me.tenant_id
                                      and archived_at is null) then
      perform inv.fail('INVALID_SUPPLIER', 'unknown supplier');
    end if;
    if exists (select 1 from jsonb_to_recordset(v_g.lines) as x(unit_cost numeric)
                where x.unit_cost is not null and x.unit_cost < 0) then
      perform inv.fail('INVALID_QUANTITY', 'a price cannot be negative');
    end if;
    if v_n = 1 then
      v_target := p_po;
    else
      insert into inv.purchase_order (tenant_id, delivery_node_id, status, notes, currency,
                                      released_at, wf_request_id, request_po_id, created_by)
      values (v_po.tenant_id, v_po.delivery_node_id, 'released', v_po.notes, v_po.currency,
              v_po.released_at, v_po.wf_request_id, p_po, v_po.created_by)
      returning id into v_target;
      update inv.purchase_order_line pl set po_id = v_target
       where pl.po_id = p_po
         and pl.item_id in (select x.item_id from jsonb_to_recordset(v_g.lines) as x(item_id uuid));
    end if;
    update inv.purchase_order_line pl set unit_cost = x.unit_cost
      from jsonb_to_recordset(v_g.lines) as x(item_id uuid, unit_cost numeric)
     where pl.po_id = v_target and pl.item_id = x.item_id and x.unit_cost is not null;
    update inv.purchase_order po
       set supplier_id = v_g.supplier_id, expected_on = v_g.expected_on,
           ordered_at = now(), ordered_by = v_me.id,
           total = coalesce((select round(sum(pl.qty * pl.unit_cost), 2)
                               from inv.purchase_order_line pl where pl.po_id = po.id), 0)
     where po.id = v_target;
    v_ids := v_ids || v_target;
  end loop;

  perform inv.notify_ordered(i, v_me.id) from unnest(v_ids) i;
  return v_ids;
end $$;
