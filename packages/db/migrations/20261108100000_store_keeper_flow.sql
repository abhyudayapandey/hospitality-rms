-- migrate:up

-- The Main Store keeper's day (ADR 051).
--  1. Receiving an order records what arrived and what it actually cost: an amount per line,
--     required for anything received (inv.receive_goods). The amount sets the unit cost on the
--     ledger, so stock value, cost of sales and the purchase price trend use what was paid.
--  2. The order desk's orders (ADR 049), to order, to receive and received, in one list with
--     the store's own (inv.desk_order_list), each saying whether its bill is in.
--  3. Send stock: the Main Store pushes stock to a department's store (inv.send_stock). It
--     leaves the Main Store at once; a "receive" task goes to whoever is on shift in the
--     department now (else its head, who can assign it on); the stock reaches the department's
--     store when that person confirms what arrived (ops.receive_sent). A shortfall is posted
--     as transit loss and the head and the sender are told.

-- ---------------------------------------------------------------------------
-- 1. Receiving at actual amounts
-- ---------------------------------------------------------------------------

-- p_lines: [{item_id, qty, amount}]. Lines with no quantity are skipped; every line received
-- needs its amount (what the bill says for it). The unit cost is amount / quantity.
create function inv.receive_goods(p_po uuid, p_lines jsonb, p_key text default null)
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
  return inv.receive_at(p_po, v_lines, p_key, now());
end $$;
revoke execute on function inv.receive_goods(uuid, jsonb, text) from public;
grant execute on function inv.receive_goods(uuid, jsonb, text) to app_rw;

-- What was received on an order and what it cost (the receipts), for whoever sees or places it.
create function inv.po_received_value(p_po uuid) returns numeric
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select round(sum(gl.qty * gl.unit_cost), 2)
    from inv.goods_receipt_line gl join inv.goods_receipt g on g.id = gl.receipt_id
   where g.po_id = p_po and g.tenant_id = core.my_tenant()
     and (core.can('PURCHASE_ORDERS', 'view', null, g.delivery_node_id) or inv.can_place(p_po));
$$;
revoke execute on function inv.po_received_value(uuid) from public;
grant execute on function inv.po_received_value(uuid) to app_rw;

-- Whether an order that has something received has no bill yet (BIL-1, ADR 050): the "Bill
-- missing" flag. Null for whoever may not see the order.
create function inv.po_bill_missing(p_po uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select exists (select 1 from inv.goods_receipt_line gl join inv.goods_receipt g on g.id = gl.receipt_id
                  where g.po_id = po.id and gl.qty > 0)
         and not exists (select 1 from inv.bill b where b.po_id = po.id and b.archived_at is null)
    from inv.purchase_order po
   where po.id = p_po and po.tenant_id = core.my_tenant()
     and (core.can('PURCHASE_ORDERS', 'view', null, po.delivery_node_id) or inv.can_place(p_po));
$$;
revoke execute on function inv.po_bill_missing(uuid) from public;
grant execute on function inv.po_bill_missing(uuid) to app_rw;

-- ---------------------------------------------------------------------------
-- 2. The order desk's orders in one list
-- ---------------------------------------------------------------------------

-- Every released order the caller is the order desk for (ADR 049): to order, to receive, and
-- received in the last 60 days, with what Orders shows for a row. RLS hides other stores'
-- orders from the desk, so this reads as the definer.
create function inv.desk_order_list()
returns table (po_id uuid, store_id uuid, store text, supplier text, total numeric,
               progress text, created_at timestamptz, expected_on date, items text,
               bill_missing boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
begin
  perform wf.me();
  return query
    select s.id, s.delivery_node_id, core.node_name(s.delivery_node_id), sp.name, s.total,
           s.progress, s.created_at, po.expected_on,
           (select string_agg(i.name, ', ' order by i.name)
              from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
             where pl.po_id = s.id),
           inv.po_bill_missing(s.id)
      from inv.purchase_order_summary s
      join inv.purchase_order po on po.id = s.id
      left join inv.supplier sp on sp.id = s.supplier_id
     where s.tenant_id = core.my_tenant() and s.status = 'released'
       and core.can('PURCHASE_ORDERS', 'modify', null, inv.order_desk(s.delivery_node_id))
       and (s.progress <> 'received' or s.created_at > now() - interval '60 days');
end $$;
revoke execute on function inv.desk_order_list() from public;
grant execute on function inv.desk_order_list() to app_rw;

-- Whether a store is its outlet's Main Store, which supplies the departments (ADR 049, 051):
-- its screens lead with sending and receiving, not with asking for stock.
create function inv.is_main_store(p_node uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce((select is_main_store from core.hierarchy_node
                    where id = p_node and tenant_id = core.my_tenant()), false);
$$;
revoke execute on function inv.is_main_store(uuid) from public;
grant execute on function inv.is_main_store(uuid) to app_rw;

-- ---------------------------------------------------------------------------
-- 3. Send stock
-- ---------------------------------------------------------------------------

alter table inv.transfer drop constraint transfer_kind_check;
alter table inv.transfer add constraint transfer_kind_check
  check (kind in ('transfer', 'rfm', 'send'));

alter table ops.task add column transfer_id uuid references inv.transfer(id);
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check
  check (kind in ('one_off', 'checklist', 'prep', 'expiry', 'receive'));
alter table ops.task add constraint task_receive_check
  check (kind <> 'receive' or (transfer_id is not null and delivery_node_id is not null));
create unique index task_receive_transfer on ops.task (transfer_id) where kind = 'receive';
alter table ops.task_step drop constraint task_step_kind_check;
alter table ops.task_step add constraint task_step_kind_check
  check (kind in ('tick', 'number', 'text', 'photo', 'discard', 'batch', 'receive'));

-- Who in a team is on shift now: a published shift covering now in the team (or below it),
-- someone clocked in first, then the earliest start. Null when nobody is.
create function ops.on_shift_now(p_team uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select a.owner_user_id
    from hr.shift_assignment a
    join hr.shift s on s.id = a.shift_id and s.status = 'published'
    join core.hierarchy_node h on h.id = a.org_node_id
    join core.hierarchy_node n on n.id = p_team
    join core.app_user u on u.id = a.owner_user_id and u.status = 'active'
   where a.status = 'assigned' and a.tenant_id = n.tenant_id
     and a.start_at <= now() and a.end_at > now()
     and h.path operator(extensions.<@) n.path
   order by exists (select 1 from hr.attendance t where t.owner_user_id = a.owner_user_id
                     and t.clock_out_at is null) desc,
            a.start_at, a.owner_user_id
   limit 1;
$$;
revoke execute on function ops.on_shift_now(uuid) from public;

-- Where p_from can send stock: the other stores of its site (outlet or hub) that a team uses.
create function inv.send_destinations(p_from uuid)
returns table (id uuid, name text)
language sql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
  select n.id, n.name
    from core.hierarchy_node n
   where core.can('TRANSFERS', 'modify', null, p_from)
     and n.tenant_id = core.my_tenant() and n.type = 'delivery' and n.holds_stock
     and n.archived_at is null and n.id <> p_from
     and core.stock_site(n.id) = core.stock_site(p_from)
     and ops.team_of_store(n.id) is not null
   order by n.name;
$$;
revoke execute on function inv.send_destinations(uuid) from public;
grant execute on function inv.send_destinations(uuid) to app_rw;

-- The items p_from can send to p_to: set up at both, with what p_from has.
create function inv.send_items(p_from uuid, p_to uuid)
returns table (item_id uuid, name text, base_uom text, on_hand numeric)
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select i.id, i.name, i.base_uom, coalesce(s.on_hand, 0)
    from inv.item_node f
    join inv.item_node t on t.item_id = f.item_id and t.delivery_node_id = p_to
                        and t.archived_at is null
    join inv.item i on i.id = f.item_id and i.archived_at is null
    left join inv.stock_level s on s.item_id = f.item_id and s.delivery_node_id = p_from
   where f.delivery_node_id = p_from and f.archived_at is null
     and exists (select 1 from inv.send_destinations(p_from) d where d.id = p_to)
   order by i.name;
$$;
revoke execute on function inv.send_items(uuid, uuid) from public;
grant execute on function inv.send_items(uuid, uuid) to app_rw;

-- Sends stock from p_from (the caller's store) to p_to. p_lines: [{item_id, qty}]. Returns the
-- transfer. A replay (same key) returns the transfer already sent.
create function inv.send_stock(p_from uuid, p_to uuid, p_lines jsonb, p_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_t inv.transfer;
  v_l record;
  v_cost numeric;
  v_team uuid;
  v_heads uuid[];
  v_to_whom uuid;
  v_task ops.task;
  v_items text;
begin
  if p_key is not null then
    select * into v_t from inv.transfer
     where tenant_id = v_me.tenant_id and created_by = v_me.id and idempotency_key = p_key;
    if found then return v_t.id; end if;
  end if;
  perform inv.require('TRANSFERS', 'modify', p_from);
  if not exists (select 1 from inv.send_destinations(p_from) d where d.id = p_to) then
    perform inv.fail('INVALID_SUBJECT', 'stock can go to another store of this outlet that a team uses');
  end if;
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0 then
    perform inv.fail('INVALID_LINES', 'say what to send');
  end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric)
              where l.qty is null or l.qty <= 0
                 or not exists (select 1 from inv.send_items(p_from, p_to) x
                                 where x.item_id = l.item_id))
     or (select count(*) from jsonb_to_recordset(p_lines) as l(item_id uuid))
        <> (select count(distinct l.item_id) from jsonb_to_recordset(p_lines) as l(item_id uuid)) then
    perform inv.fail('INVALID_LINES', 'each item once, set up at both stores, with a quantity');
  end if;
  v_team := ops.team_of_store(p_to);

  insert into inv.transfer (tenant_id, from_node_id, to_node_id, kind, status, dispatched_at,
                            dispatched_by, idempotency_key)
  values (v_me.tenant_id, p_from, p_to, 'send', 'submitted', now(), v_me.id, p_key)
  returning * into v_t;
  for v_l in select * from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric) loop
    v_cost := inv.avg_cost(v_l.item_id, p_from);
    insert into inv.transfer_line (tenant_id, transfer_id, item_id, from_node_id, to_node_id,
                                   requested_qty, dispatched_qty, unit_cost)
    values (v_me.tenant_id, v_t.id, v_l.item_id, p_from, p_to, v_l.qty, v_l.qty, v_cost);
    perform inv.post_at(v_l.item_id, p_from, 'transfer_out', -v_l.qty, v_cost, 'transfer',
                        v_t.id, now());
  end loop;

  -- the receive task: whoever is on shift in the department now, else its head
  v_heads := ops.leads(v_team, array['DEPARTMENT_HEAD', 'OUTLET_MANAGER'], array[v_me.id]);
  v_to_whom := coalesce(ops.on_shift_now(v_team), v_heads[1]);
  if v_to_whom is null then
    perform inv.fail('NO_APPROVER', 'nobody in that team can receive it');
  end if;
  select string_agg(format('%s %s %s', trim_scale(tl.dispatched_qty), i.base_uom, i.name), ', '
                    order by i.name)
    into v_items
    from inv.transfer_line tl join inv.item i on i.id = tl.item_id where tl.transfer_id = v_t.id;
  insert into ops.task (tenant_id, org_node_id, delivery_node_id, kind, title, description,
                        priority, due_at, status, assign_mode, assignee_user_id, assigned_by,
                        transfer_id)
  values (v_me.tenant_id, v_team, p_to, 'receive',
          left('Receive from ' || core.node_name(p_from) || ': ' || v_items, 200),
          'Sent by ' || v_me.display_name || '. Check what arrived and confirm it.',
          'high', now() + interval '1 hour', 'open', 'person', v_to_whom, v_me.id, v_t.id)
  returning * into v_task;
  insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind)
  values (v_me.tenant_id, v_task.id, v_team, 1, 'Check what arrived and confirm', 'receive');
  perform ops.notify_task(v_task, array[v_to_whom], 'task_assigned', 'New task: ' || v_task.title);
  perform ops.notify_task(v_task, array(select h from unnest(v_heads) h where h <> v_to_whom),
                          'stock_sent', core.node_name(p_from) || ' sent stock to '
                            || core.node_name(p_to),
                          v_items || '. ' || (select display_name from core.app_user
                                               where id = v_to_whom) || ' will receive it.');
  return v_t.id;
end $$;
revoke execute on function inv.send_stock(uuid, uuid, jsonb, text) from public;
grant execute on function inv.send_stock(uuid, uuid, jsonb, text) to app_rw;

-- The lines of a sent transfer, for whoever may see its receive task.
create function ops.sent_lines(p_task uuid)
returns table (item_id uuid, name text, base_uom text, sent numeric, received numeric)
language sql stable security definer
set search_path = pg_catalog, core, ops, inv
as $$
  select tl.item_id, i.name, i.base_uom, tl.dispatched_qty, tl.received_qty
    from ops.task t
    join inv.transfer_line tl on tl.transfer_id = t.transfer_id
    join inv.item i on i.id = tl.item_id
   where t.id = p_task and t.kind = 'receive' and t.tenant_id = core.my_tenant()
     and (t.assignee_user_id = core.current_user_id()
          or core.can('TASKS', 'view', t.org_node_id, null)
          or core.can('TRANSFERS', 'view', null, t.delivery_node_id)
          or core.can('TRANSFERS', 'view', null, tl.from_node_id))
   order by i.name;
$$;
revoke execute on function ops.sent_lines(uuid) from public;
grant execute on function ops.sent_lines(uuid) to app_rw;

-- The person with the receive task confirms what arrived: p_lines [{item_id, qty}], every
-- line sent. The stock goes into the department's store; a shortfall is posted as transit
-- loss and the department head and the sender are told.
create function ops.receive_sent(p_task uuid, p_lines jsonb)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, inv
as $$
declare
  v_t ops.task;
  v_tr inv.transfer;
  v_l inv.transfer_line;
  v_qty numeric;
  v_short text[] := '{}';
  v_name text;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant();
  if found and v_t.kind <> 'receive' then
    perform ops.fail('INVALID_STEP', 'not a delivery to receive');
  end if;
  v_t := ops.task_to_work(p_task);
  select * into v_tr from inv.transfer where id = v_t.transfer_id for update;
  if v_tr.received_at is not null or v_tr.status <> 'submitted' then
    perform ops.fail('INVALID_STATE', 'already received');
  end if;
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array'
     or exists (select 1 from inv.transfer_line tl
                 where tl.transfer_id = v_tr.id
                   and not exists (select 1 from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric)
                                    where l.item_id = tl.item_id and l.qty is not null))
     or exists (select 1 from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric)
                 where l.qty < 0
                    or not exists (select 1 from inv.transfer_line tl
                                    where tl.transfer_id = v_tr.id and tl.item_id = l.item_id
                                      and l.qty <= tl.dispatched_qty)) then
    perform ops.fail('INVALID_QUANTITY', 'enter what arrived for each item, at most what was sent');
  end if;

  for v_l in select * from inv.transfer_line where transfer_id = v_tr.id order by id loop
    v_qty := (select (e ->> 'qty')::numeric from jsonb_array_elements(p_lines) e
               where (e ->> 'item_id')::uuid = v_l.item_id limit 1);
    if v_l.dispatched_qty > 0 then
      perform inv.post_at(v_l.item_id, v_tr.to_node_id, 'transfer_in', v_l.dispatched_qty,
                          v_l.unit_cost, 'transfer', v_tr.id, now());
    end if;
    if v_l.dispatched_qty > v_qty then
      perform inv.post_at(v_l.item_id, v_tr.to_node_id, 'wastage', v_qty - v_l.dispatched_qty,
                          v_l.unit_cost, 'transfer', v_tr.id, now(), 'transit_loss');
      select name into v_name from inv.item where id = v_l.item_id;
      v_short := v_short || format('%s short by %s', v_name, trim_scale(v_l.dispatched_qty - v_qty));
    end if;
    update inv.transfer_line set received_qty = v_qty where id = v_l.id;
  end loop;
  update inv.transfer
     set received_at = now(), received_by = core.current_user_id(), status = 'completed'
   where id = v_tr.id;
  update ops.task_step set done_by = core.current_user_id(), done_at = now()
   where task_id = v_t.id and kind = 'receive';
  perform ops.settle(v_t.id);
  if cardinality(v_short) > 0 then
    perform ops.notify_task(v_t,
      array(select distinct u from unnest(
              ops.leads(v_t.org_node_id, array['DEPARTMENT_HEAD', 'OUTLET_MANAGER'],
                        array[core.current_user_id()]) || v_t.assigned_by) u),
      'stock_short', 'Delivery from ' || core.node_name(v_tr.from_node_id) || ' was short',
      array_to_string(v_short, '; '));
  end if;
  return v_tr.id;
end $$;
revoke execute on function ops.receive_sent(uuid, jsonb) from public;
grant execute on function ops.receive_sent(uuid, jsonb) to app_rw;

-- The department head (or anyone with TASKS modify there) passes a receive task to someone in
-- the team, while it is still to do.
create function ops.reassign_task(p_task uuid, p_user uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind = 'receive' for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  perform hr.require('TASKS', 'modify', v_t.org_node_id);
  if v_t.status not in ('open', 'in_progress') then
    perform ops.fail('INVALID_STATE', 'the task is done');
  end if;
  if p_user is null or not ops.works_under(p_user, v_t.org_node_id) then
    perform ops.fail('INVALID_ASSIGNEE', 'they do not work at this place');
  end if;
  update ops.task
     set assignee_user_id = p_user, assigned_by = core.current_user_id(), assign_mode = 'person'
   where id = v_t.id returning * into v_t;
  perform ops.notify_task(v_t, array[p_user], 'task_assigned', 'New task: ' || v_t.title);
end $$;
revoke execute on function ops.reassign_task(uuid, uuid) from public;
grant execute on function ops.reassign_task(uuid, uuid) to app_rw;

-- task_detail names where a delivery came from.
do $$
declare
  v_def text := pg_get_functiondef('ops.task_detail(uuid)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def, $a$    'can_manage', core.can('TASKS', 'modify', v_t.org_node_id, null),$a$,
                          $a$    'can_manage', core.can('TASKS', 'modify', v_t.org_node_id, null),
    'sent_from', (select core.node_name(tr.from_node_id) from inv.transfer tr
                   where tr.id = v_t.transfer_id),$a$);
  if v_new = v_def then
    raise exception 'ops.task_detail changed';
  end if;
  execute v_new;
end $$;

-- migrate:down
do $$
declare
  v_def text := pg_get_functiondef('ops.task_detail(uuid)'::regprocedure);
begin
  execute replace(v_def, $a$
    'sent_from', (select core.node_name(tr.from_node_id) from inv.transfer tr
                   where tr.id = v_t.transfer_id),$a$, '');
end $$;
drop function ops.reassign_task(uuid, uuid);
drop function ops.receive_sent(uuid, jsonb);
drop function ops.sent_lines(uuid);
drop function inv.send_stock(uuid, uuid, jsonb, text);
drop function inv.send_items(uuid, uuid);
drop function inv.send_destinations(uuid);
drop function ops.on_shift_now(uuid);
delete from ops.task_step where kind = 'receive';
alter table ops.task_step drop constraint task_step_kind_check;
alter table ops.task_step add constraint task_step_kind_check
  check (kind in ('tick', 'number', 'text', 'photo', 'discard', 'batch'));
delete from ops.task where kind = 'receive';
drop index ops.task_receive_transfer;
alter table ops.task drop constraint task_receive_check;
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check
  check (kind in ('one_off', 'checklist', 'prep', 'expiry'));
alter table ops.task drop column transfer_id;
delete from inv.transfer_line where transfer_id in (select id from inv.transfer where kind = 'send');
delete from inv.transfer where kind = 'send';
alter table inv.transfer drop constraint transfer_kind_check;
alter table inv.transfer add constraint transfer_kind_check check (kind in ('transfer', 'rfm'));
drop function inv.is_main_store(uuid);
drop function inv.desk_order_list();
drop function inv.po_bill_missing(uuid);
drop function inv.po_received_value(uuid);
drop function inv.receive_goods(uuid, jsonb, text);
