-- migrate:up
-- Supply requests (ADR 049). The person who needs supplies only says what and how much. The
-- main store's keeper places the order: a supplier (optional) and a delivery date, the
-- request splitting into one order per supplier when the items come from several. The
-- department hears when it is ordered and when it is received.

alter table inv.purchase_order
  alter column supplier_id drop not null,
  add column expected_on date,
  add column ordered_at timestamptz,
  add column ordered_by uuid references core.app_user(id),
  add column request_po_id uuid references inv.purchase_order(id);

-- everything released before this was ordered when it was released
update inv.purchase_order set ordered_at = coalesce(released_at, created_at)
 where status = 'released';

-- released but not ordered yet: 'to_order'
create or replace view inv.purchase_order_summary with (security_invoker = true) as
select po.id, po.tenant_id, po.delivery_node_id, po.supplier_id, po.status, po.total,
       po.currency, po.notes, po.created_at, po.created_by, po.released_at, po.wf_request_id,
       r.ordered_qty, r.received_qty,
       case
         when po.status = 'submitted' then 'awaiting_approval'
         when po.status <> 'released' then po.status
         when po.ordered_at is null then 'to_order'
         when r.received_qty = 0 then 'released'
         when r.lines_open > 0 then 'partially_received'
         else 'received'
       end as progress,
       po.expected_on, po.ordered_at, po.request_po_id
  from inv.purchase_order po
  cross join lateral (
    select sum(pl.qty) as ordered_qty,
           coalesce(sum(rec.qty), 0) as received_qty,
           count(*) filter (where coalesce(rec.qty, 0) < pl.qty) as lines_open
      from inv.purchase_order_line pl
      left join lateral (select sum(gl.qty) as qty from inv.goods_receipt_line gl
                          where gl.po_line_id = pl.id) rec on true
     where pl.po_id = po.id) r;

-- ---------------------------------------------------------------------------
-- Who places the order: the keeper of the outlet's Main Store, else of the store itself
-- ---------------------------------------------------------------------------

create function inv.order_desk(p_node uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce(
    (select m.id from core.hierarchy_node n
       join core.hierarchy_node m on m.tenant_id = n.tenant_id
                                 and m.parent_id is not distinct from n.parent_id
                                 and m.is_main_store and m.archived_at is null
      where n.id = p_node),
    p_node);
$$;
revoke execute on function inv.order_desk(uuid) from public;

create function inv.can_place(p_po uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select exists (
    select 1 from inv.purchase_order po
     where po.id = p_po and po.tenant_id = core.my_tenant()
       and core.can('PURCHASE_ORDERS', 'modify', null, inv.order_desk(po.delivery_node_id)));
$$;
revoke execute on function inv.can_place(uuid) from public;

-- The people who asked and the people who use the store: the one who raised the request, the
-- store's keepers and the head of the department that uses the store.
create function inv.request_people(p_po uuid, p_exclude uuid) returns setof uuid
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_po inv.purchase_order;
  v_keeper uuid;
  v_head uuid;
begin
  select * into v_po from inv.purchase_order where id = coalesce(
    (select request_po_id from inv.purchase_order where id = p_po), p_po);
  select id into v_keeper from core.security_group where tenant_id = v_po.tenant_id and code = 'STORE_KEEPER';
  select id into v_head from core.security_group where tenant_id = v_po.tenant_id and code = 'DEPARTMENT_HEAD';
  return query
    select distinct u from (
      select v_po.created_by as u
      union select core.site_group_holders(v_keeper, v_po.delivery_node_id)
      union select core.site_group_holders(v_head, nl.org_node_id)
              from core.node_link nl where nl.delivery_node_id = v_po.delivery_node_id
    ) x where u is not null and u is distinct from p_exclude;
end $$;
revoke execute on function inv.request_people(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- Notices
-- ---------------------------------------------------------------------------

-- the order desk's keepers: a request is waiting to be ordered (their "task")
create function inv.notify_desk(p_po uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_po inv.purchase_order;
  v_store text;
  v_by text;
  v_desk uuid;
  v_group uuid;
begin
  select * into v_po from inv.purchase_order where id = p_po;
  v_desk := inv.order_desk(v_po.delivery_node_id);
  select name into v_store from core.hierarchy_node where id = v_po.delivery_node_id;
  select display_name into v_by from core.app_user where id = v_po.created_by;
  select id into v_group from core.security_group where tenant_id = v_po.tenant_id and code = 'STORE_KEEPER';
  perform ops.notify(v_po.tenant_id, h, 'order', 'Place an order for ' || v_store,
                     'Asked for by ' || coalesce(v_by, 'someone') || '. Pick a supplier and say when it will be delivered.',
                     '/stock/orders/' || v_po.id || '?node=' || v_desk)
     from core.site_group_holders(v_group, v_desk) h
    where v_group is not null and h is distinct from v_po.created_by;
end $$;
revoke execute on function inv.notify_desk(uuid) from public;

-- The GM is told of every request; the order is not shown with money or a supplier when
-- neither is known yet.
create or replace function inv.notify_order(p_po uuid, p_exclude uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_po inv.purchase_order;
  v_store text;
  v_supplier text;
  v_by text;
  v_group uuid;
  v_unusual boolean;
begin
  select * into v_po from inv.purchase_order where id = p_po;
  select name into v_store from core.hierarchy_node where id = v_po.delivery_node_id;
  select name into v_supplier from inv.supplier where id = v_po.supplier_id;
  select display_name into v_by from core.app_user where id = v_po.created_by;
  select coalesce((q.payload ->> 'unusual')::boolean, false) into v_unusual
    from wf.request q where q.id = v_po.wf_request_id;
  select id into v_group from core.security_group
   where tenant_id = v_po.tenant_id and code = 'OUTLET_MANAGER';
  perform ops.notify(v_po.tenant_id, h, 'order', 'Order for ' || v_store,
                     format('%s made by %s. %s',
                            case when v_supplier is null then 'Supplies requested,'
                                 else format('To %s, ₹%s,', v_supplier, to_char(v_po.total, 'FM9999999990.00')) end,
                            coalesce(v_by, 'someone'),
                            case when v_unusual
                                 then 'Off the menu or more than usual: the department head approves.'
                                 else 'Menu items in usual quantities: no approval needed.' end),
                     '/stock/orders')
     from core.site_group_holders(v_group, v_po.delivery_node_id) h
    where v_group is not null and h is distinct from p_exclude;
end $$;

-- the department: accepted and ordered
create function inv.notify_ordered(p_po uuid, p_exclude uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_po inv.purchase_order;
  v_supplier text;
begin
  select * into v_po from inv.purchase_order where id = p_po;
  select name into v_supplier from inv.supplier where id = v_po.supplier_id;
  perform ops.notify(v_po.tenant_id, u, 'order', 'Your supply request was ordered',
                     format('Accepted and ordered%s. Due on %s.',
                            case when v_supplier is null then '' else ' from ' || v_supplier end,
                            to_char(v_po.expected_on, 'DD Mon')),
                     '/stock/orders/' || v_po.id || '?node=' || v_po.delivery_node_id)
     from inv.request_people(p_po, p_exclude) u;
end $$;
revoke execute on function inv.notify_ordered(uuid, uuid) from public;

-- the department: received, in full or in part
create function inv.notify_received(p_po uuid, p_exclude uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_po inv.purchase_order;
  v_open int;
begin
  select * into v_po from inv.purchase_order where id = p_po;
  select count(*) into v_open from inv.purchase_order_line pl
   where pl.po_id = p_po
     and coalesce((select sum(gl.qty) from inv.goods_receipt_line gl where gl.po_line_id = pl.id), 0) < pl.qty;
  perform ops.notify(v_po.tenant_id, u, 'order',
                     case when v_open = 0 then 'Your supplies were received'
                          else 'Part of your supplies was received' end,
                     case when v_open = 0 then 'The supply request is complete: the materials are in.'
                          else format('%s item(s) are still to come.', v_open) end,
                     '/stock/orders/' || v_po.id || '?node=' || v_po.delivery_node_id)
     from inv.request_people(p_po, p_exclude) u;
end $$;
revoke execute on function inv.notify_received(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- Raise a request: items and quantities, no supplier, no price
-- ---------------------------------------------------------------------------

create function inv.request_supplies(p_node uuid, p_lines jsonb, p_notes text default null,
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
  if exists (select 1 from jsonb_to_recordset(p_lines) as l(qty numeric)
              where l.qty is null or l.qty <= 0) then
    perform inv.fail('INVALID_QUANTITY', 'every line needs a positive quantity');
  end if;

  -- the last price paid, only to size the request; the keeper sets the real one
  insert into inv.purchase_order (tenant_id, delivery_node_id, supplier_id, notes, total,
                                  idempotency_key)
  select v_me.tenant_id, p_node, null, p_notes,
         round(sum(l.qty * coalesce(sl.avg_cost, 0)), 2), p_idempotency_key
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric)
    left join inv.item_node n on n.item_id = l.item_id and n.delivery_node_id = p_node
    left join inv.stock_level sl on sl.item_id = l.item_id and sl.delivery_node_id = p_node
  returning * into v_po;
  insert into inv.purchase_order_line (tenant_id, po_id, item_id, delivery_node_id, qty, unit_cost)
  select v_me.tenant_id, v_po.id, l.item_id, p_node, l.qty,
         coalesce(sl.avg_cost, 0)
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric)
    left join inv.item_node n on n.item_id = l.item_id and n.delivery_node_id = p_node
    left join inv.stock_level sl on sl.item_id = l.item_id and sl.delivery_node_id = p_node;

  -- off the menu or more than usual goes to the department head (ADR 044); no value rule
  v_request := wf.submit('PURCHASE_ORDER', 'inv.purchase_order', v_po.id,
                         jsonb_build_object('unusual',
                           exists (select 1 from inv.unusual_calc(p_node, p_lines)),
                           'why', inv.unusual_why(p_node, p_lines)));
  update inv.purchase_order set status = 'submitted', wf_request_id = v_request
   where id = v_po.id;
  perform inv.notify_order(v_po.id, v_me.id);
  return v_po.id;
end $$;

-- ---------------------------------------------------------------------------
-- Place the order. p_groups: [{supplier_id?, expected_on, lines: [{item_id, unit_cost?}]}],
-- every line of the request in exactly one group; a group is one order, so a request with
-- items from several suppliers splits, the first group keeping the request's own order.
-- ---------------------------------------------------------------------------

create function inv.place_order(p_po uuid, p_groups jsonb, p_idempotency_key text default null)
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

-- ---------------------------------------------------------------------------
-- The order desk's work, and a request seen by the desk (RLS shows each keeper only
-- their own store's orders; the desk places and receives for the other stores)
-- ---------------------------------------------------------------------------

create function inv.desk_orders()
returns table (po_id uuid, store_id uuid, store text, requested_by text, requested_at timestamptz,
               supplier text, expected_on date, stage text, items text, unusual boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
begin
  perform wf.me();
  return query
    select po.id, po.delivery_node_id, core.node_name(po.delivery_node_id),
           (select u.display_name from core.app_user u where u.id = po.created_by),
           po.created_at, s.name, po.expected_on,
           case when po.ordered_at is null then 'to_order' else 'to_receive' end,
           (select string_agg(i.name, ', ' order by i.name)
              from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
             where pl.po_id = po.id),
           coalesce((select (q.payload ->> 'unusual')::boolean from wf.request q
                      where q.id = po.wf_request_id), false)
      from inv.purchase_order po
      left join inv.supplier s on s.id = po.supplier_id
     where po.tenant_id = core.my_tenant() and po.status = 'released'
       and core.can('PURCHASE_ORDERS', 'modify', null, inv.order_desk(po.delivery_node_id))
       and (po.ordered_at is null
            or exists (select 1 from inv.purchase_order_line pl
                        where pl.po_id = po.id
                          and coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                         where gl.po_line_id = pl.id), 0) < pl.qty))
     order by (po.ordered_at is null) desc, po.expected_on nulls first, po.created_at;
end $$;

-- one order for the desk keeper who cannot see the store's rows
create function inv.order_for_desk(p_po uuid)
returns table (id uuid, store_id uuid, store text, supplier_id uuid, supplier text,
               requested_by text, created_at timestamptz, expected_on date, status text,
               progress text, notes text, total numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
begin
  perform wf.me();
  if not inv.can_place(p_po) then
    return;
  end if;
  return query
    select po.id, po.delivery_node_id, core.node_name(po.delivery_node_id), po.supplier_id, s.name,
           (select u.display_name from core.app_user u where u.id = po.created_by),
           po.created_at, po.expected_on, po.status,
           case when po.status <> 'released' then po.status
                when po.ordered_at is null then 'to_order'
                when not exists (select 1 from inv.goods_receipt g where g.po_id = po.id) then 'released'
                when exists (select 1 from inv.purchase_order_line pl
                              where pl.po_id = po.id
                                and coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                               where gl.po_line_id = pl.id), 0) < pl.qty)
                     then 'partially_received'
                else 'received' end,
           po.notes, po.total
      from inv.purchase_order po left join inv.supplier s on s.id = po.supplier_id
     where po.id = p_po;
end $$;

create function inv.order_lines_for_desk(p_po uuid)
returns table (item_id uuid, name text, base_uom text, qty numeric, unit_cost numeric,
               received numeric, on_hand numeric, preferred_supplier_id uuid)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
begin
  perform wf.me();
  if not inv.can_place(p_po) then
    return;
  end if;
  return query
    select pl.item_id, i.name, i.base_uom, pl.qty, pl.unit_cost,
           coalesce((select sum(gl.qty) from inv.goods_receipt_line gl where gl.po_line_id = pl.id), 0),
           coalesce(sl.on_hand, 0), inode.preferred_supplier_id
      from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
      left join inv.item_node inode on inode.item_id = pl.item_id and inode.delivery_node_id = pl.delivery_node_id
      left join inv.stock_level sl on sl.item_id = pl.item_id and sl.delivery_node_id = pl.delivery_node_id
     where pl.po_id = p_po order by i.name;
end $$;

-- ---------------------------------------------------------------------------
-- Released orders: ordered at once when they already name a supplier (a keeper's own
-- order); a request waits for the order desk, which is told
-- ---------------------------------------------------------------------------

do $$
declare
  v_src text := pg_get_functiondef('inv.execute(text, uuid)'::regprocedure);
  v_old text := E'    update inv.purchase_order set status = ''released'', released_at = now()\n     where wf_request_id = p_request_id and status = ''submitted'';\n';
  v_new text := E'    update inv.purchase_order set status = ''released'', released_at = now(),\n           ordered_at = case when supplier_id is not null then now() end\n     where wf_request_id = p_request_id and status = ''submitted'';\n    perform inv.notify_desk(po.id) from inv.purchase_order po\n     where po.wf_request_id = p_request_id and po.status = ''released'' and po.ordered_at is null;\n';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'inv.execute changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- Receiving: the order desk may receive for the store (ADR 049); only ordered requests can be
-- received; the department is told
do $$
declare
  v_src text := pg_get_functiondef('inv.receive_at(uuid, jsonb, text, timestamptz)'::regprocedure);
  v_old text := E'  perform inv.require(''PURCHASE_ORDERS'', ''view'', v_po.delivery_node_id);\n  -- receiving changes stock: whoever may adjust stock at the store (stock users and up,\n  -- 20261001120000_access_groups)\n  perform inv.require(''STOCK_ADJUSTMENTS'', ''modify'', v_po.delivery_node_id);\n  if v_po.status <> ''released'' then';
  v_new text := E'  if not inv.can_place(v_po.id) then\n    perform inv.require(''PURCHASE_ORDERS'', ''view'', v_po.delivery_node_id);\n    perform inv.require(''STOCK_ADJUSTMENTS'', ''modify'', v_po.delivery_node_id);\n  end if;\n  if v_po.status <> ''released'' or v_po.ordered_at is null then';
  v_end_old text := E'  return v_gr.id;\nend $function$';
  v_end_new text := E'  perform inv.notify_received(p_po, v_me.id);\n  return v_gr.id;\nend $function$';
begin
  if position(v_old in v_src) = 0 or position(v_end_old in v_src) = 0 then
    raise exception 'inv.receive_at changed; update this migration';
  end if;
  execute replace(replace(v_src, v_old, v_new), v_end_old, v_end_new);
end $$;

-- the test data's past orders name their supplier, so they are ordered when released
do $$
declare
  v_src text := pg_get_functiondef('inv.record_test_release(uuid, timestamptz)'::regprocedure);
  v_old text := E'  update inv.purchase_order set status = ''released'', released_at = p_at where id = p_po;\n';
  v_new text := E'  update inv.purchase_order set status = ''released'', released_at = p_at,\n         ordered_at = case when supplier_id is not null then p_at end\n   where id = p_po;\n';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'inv.record_test_release changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

revoke execute on all functions in schema inv from public;
grant execute on function
  inv.request_supplies(uuid, jsonb, text, text),
  inv.place_order(uuid, jsonb, text),
  inv.desk_orders(),
  inv.order_for_desk(uuid),
  inv.order_lines_for_desk(uuid)
  to app_rw;

-- migrate:down
do $$
declare
  v_src text := pg_get_functiondef('inv.record_test_release(uuid, timestamptz)'::regprocedure);
  v_new text := E'  update inv.purchase_order set status = ''released'', released_at = p_at where id = p_po;\n';
  v_old text := E'  update inv.purchase_order set status = ''released'', released_at = p_at,\n         ordered_at = case when supplier_id is not null then p_at end\n   where id = p_po;\n';
begin
  execute replace(v_src, v_old, v_new);
end $$;
-- never used on deployed data: put the schema back (requests without a supplier cannot be
-- kept, so the down only works while there are none)
drop function inv.order_lines_for_desk(uuid);
drop function inv.order_for_desk(uuid);
drop function inv.desk_orders();
drop function inv.place_order(uuid, jsonb, text);
drop function inv.request_supplies(uuid, jsonb, text, text);
drop function inv.notify_received(uuid, uuid);
drop function inv.notify_ordered(uuid, uuid);
drop function inv.notify_desk(uuid);
drop function inv.request_people(uuid, uuid);
drop function inv.can_place(uuid);
drop function inv.order_desk(uuid);
do $$
declare
  v_src text := pg_get_functiondef('inv.execute(text, uuid)'::regprocedure);
  v_new text := E'    update inv.purchase_order set status = ''released'', released_at = now()\n     where wf_request_id = p_request_id and status = ''submitted'';\n';
  v_old text := E'    update inv.purchase_order set status = ''released'', released_at = now(),\n           ordered_at = case when supplier_id is not null then now() end\n     where wf_request_id = p_request_id and status = ''submitted'';\n    perform inv.notify_desk(po.id) from inv.purchase_order po\n     where po.wf_request_id = p_request_id and po.status = ''released'' and po.ordered_at is null;\n';
begin
  execute replace(v_src, v_old, v_new);
end $$;
do $$
declare
  v_src text := pg_get_functiondef('inv.receive_at(uuid, jsonb, text, timestamptz)'::regprocedure);
  v_new text := E'  perform inv.require(''PURCHASE_ORDERS'', ''view'', v_po.delivery_node_id);\n  -- receiving changes stock: whoever may adjust stock at the store (stock users and up,\n  -- 20261001120000_access_groups)\n  perform inv.require(''STOCK_ADJUSTMENTS'', ''modify'', v_po.delivery_node_id);\n  if v_po.status <> ''released'' then';
  v_old text := E'  if not inv.can_place(v_po.id) then\n    perform inv.require(''PURCHASE_ORDERS'', ''view'', v_po.delivery_node_id);\n    perform inv.require(''STOCK_ADJUSTMENTS'', ''modify'', v_po.delivery_node_id);\n  end if;\n  if v_po.status <> ''released'' or v_po.ordered_at is null then';
  v_end_new text := E'  return v_gr.id;\nend $function$';
  v_end_old text := E'  perform inv.notify_received(p_po, v_me.id);\n  return v_gr.id;\nend $function$';
begin
  execute replace(replace(v_src, v_old, v_new), v_end_old, v_end_new);
end $$;
drop view inv.purchase_order_summary;
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
alter table inv.purchase_order
  drop column request_po_id, drop column ordered_by, drop column ordered_at,
  drop column expected_on, alter column supplier_id set not null;
grant select on inv.purchase_order_summary to app_rw;
