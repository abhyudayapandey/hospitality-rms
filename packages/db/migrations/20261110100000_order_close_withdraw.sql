-- migrate:up

-- UX audit 3, the serious findings (ADR 052).
--  1. An order that will never arrive in full is closed by the keeper who receives it ("Rest is
--     not coming", with a reason); the GM and the department are told. A supply request still
--     to be ordered (or awaiting approval) is withdrawn by whoever asked. Neither changes the
--     order's status column: closed_at marks both, and the summary's progress says 'closed' or
--     'withdrawn'.
--  2. A department's order that its outlet's Main Store orders and receives (ADR 049) is
--     received by the Main Store: the department is not given the receive form, and the
--     server refuses it too.
--  3. The order desk sends the order it placed to the supplier (WhatsApp, email, print) and
--     sees the sends.

alter table inv.purchase_order
  add column closed_at timestamptz,
  add column closed_by uuid references core.app_user(id),
  add column close_reason text;
alter table inv.purchase_order add constraint purchase_order_close_check
  check ((closed_at is null) = (closed_by is null)
         and (closed_at is null or length(btrim(coalesce(close_reason, ''))) > 0));

create or replace view inv.purchase_order_summary with (security_invoker = true) as
select po.id, po.tenant_id, po.delivery_node_id, po.supplier_id, po.status, po.total,
       po.currency, po.notes, po.created_at, po.created_by, po.released_at, po.wf_request_id,
       r.ordered_qty, r.received_qty,
       case
         when po.closed_at is not null then
           case when po.ordered_at is null then 'withdrawn' else 'closed' end
         when po.status = 'submitted' then 'awaiting_approval'
         when po.status <> 'released' then po.status
         when po.ordered_at is null then 'to_order'
         when r.received_qty = 0 then 'released'
         when r.lines_open > 0 then 'partially_received'
         else 'received'
       end as progress,
       po.expected_on, po.ordered_at, po.request_po_id, po.closed_at, po.close_reason
  from inv.purchase_order po
  cross join lateral (
    select sum(pl.qty) as ordered_qty,
           coalesce(sum(rec.qty), 0) as received_qty,
           count(*) filter (where coalesce(rec.qty, 0) < pl.qty) as lines_open
      from inv.purchase_order_line pl
      left join lateral (select sum(gl.qty) as qty from inv.goods_receipt_line gl
                          where gl.po_line_id = pl.id) rec on true
     where pl.po_id = po.id) r;

-- Whether the Main Store orders and receives this order for its store (ADR 049): the store
-- is not its own order desk.
create function inv.via_desk(p_po uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select coalesce((select inv.order_desk(po.delivery_node_id) <> po.delivery_node_id
                     from inv.purchase_order po
                    where po.id = p_po and po.tenant_id = core.my_tenant()), false);
$$;
revoke execute on function inv.via_desk(uuid) from public;
grant execute on function inv.via_desk(uuid) to app_rw;

-- The caller follows this order rather than running it: its Main Store places and receives it,
-- and the caller is not that order desk (a department head). Screens show it "on the way".
create function inv.follows_order(p_po uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select inv.via_desk(p_po) and not inv.can_place(p_po);
$$;
revoke execute on function inv.follows_order(uuid) from public;
grant execute on function inv.follows_order(uuid) to app_rw;

-- The same for a store: its orders go through its outlet's Main Store, whose desk the caller
-- is not. Its Orders tab reads "On the way".
create function inv.follows_store(p_node uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select inv.order_desk(p_node) <> p_node
         and not core.can('PURCHASE_ORDERS', 'modify', null, inv.order_desk(p_node));
$$;
revoke execute on function inv.follows_store(uuid) from public;
grant execute on function inv.follows_store(uuid) to app_rw;

-- ---------------------------------------------------------------------------
-- 1. Close an order, withdraw a request
-- ---------------------------------------------------------------------------

-- Who is told an order was closed: the outlet's GMs and the people who asked or use the store.
create function inv.notify_closed(p_po uuid, p_exclude uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_po inv.purchase_order;
  v_store text;
  v_supplier text;
  v_by text;
  v_gm uuid;
begin
  select * into v_po from inv.purchase_order where id = p_po;
  select name into v_store from core.hierarchy_node where id = v_po.delivery_node_id;
  select name into v_supplier from inv.supplier where id = v_po.supplier_id;
  select display_name into v_by from core.app_user where id = v_po.closed_by;
  select id into v_gm from core.security_group
   where tenant_id = v_po.tenant_id and code = 'OUTLET_MANAGER';
  perform ops.notify(v_po.tenant_id, u, 'order', 'Order for ' || v_store || ' closed',
                     format('%s closed it%s: the rest is not coming. %s',
                            coalesce(v_by, 'Someone'),
                            case when v_supplier is null then '' else ' (' || v_supplier || ')' end,
                            v_po.close_reason),
                     '/stock/orders/' || v_po.id || '?node=' || v_po.delivery_node_id)
     from (select core.site_group_holders(v_gm, v_po.delivery_node_id) as u where v_gm is not null
           union select inv.request_people(p_po, p_exclude)) x
    where u is distinct from p_exclude;
end $$;
revoke execute on function inv.notify_closed(uuid, uuid) from public;

-- "Rest is not coming": the keeper who receives the order closes it with a reason. What was
-- received stays; nothing more can be. The GM may too (they hold every access) but the keeper
-- is the one who answers for it; the GM is told.
create function inv.close_order(p_po uuid, p_reason text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_po inv.purchase_order;
begin
  select * into v_po from inv.purchase_order
   where id = p_po and tenant_id = v_me.tenant_id for update;
  if not found or not inv.can_place(p_po) then
    perform inv.fail('NOT_AUTHORISED', 'close this order');
  end if;
  if v_po.closed_at is not null then
    return; -- a double tap
  end if;
  if v_po.status <> 'released' or v_po.ordered_at is null then
    perform inv.fail('INVALID_STATE', 'only an order placed with a supplier is closed');
  end if;
  if not exists (select 1 from inv.purchase_order_line pl
                  where pl.po_id = p_po
                    and coalesce((select sum(gl.qty) from inv.goods_receipt_line gl
                                   where gl.po_line_id = pl.id), 0) < pl.qty) then
    perform inv.fail('INVALID_STATE', 'everything was received');
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    perform inv.fail('REASON_REQUIRED', 'why the rest is not coming');
  end if;
  update inv.purchase_order
     set closed_at = now(), closed_by = v_me.id, close_reason = btrim(p_reason)
   where id = p_po;
  perform inv.notify_closed(p_po, v_me.id);
end $$;
revoke execute on function inv.close_order(uuid, text) from public;
grant execute on function inv.close_order(uuid, text) to app_rw;

-- Withdraw a supply request nobody has ordered yet: whoever asked for it. One awaiting
-- approval leaves its approver's list too (wf.act cancel, the initiator's own right).
create function inv.withdraw_request(p_po uuid, p_reason text default null) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_po inv.purchase_order;
begin
  select * into v_po from inv.purchase_order
   where id = p_po and tenant_id = v_me.tenant_id for update;
  if not found or v_po.created_by is distinct from v_me.id then
    perform inv.fail('NOT_AUTHORISED', 'only whoever asked withdraws a request');
  end if;
  if v_po.closed_at is not null then
    return;
  end if;
  if v_po.ordered_at is not null or v_po.status not in ('submitted', 'released') then
    perform inv.fail('INVALID_STATE', 'it is already ordered');
  end if;
  if v_po.status = 'submitted' and v_po.wf_request_id is not null then
    perform wf.act(v_po.wf_request_id, 'cancel', 'withdrawn');
  end if;
  update inv.purchase_order
     set closed_at = now(), closed_by = v_me.id,
         close_reason = coalesce(nullif(btrim(p_reason), ''), 'withdrawn')
   where id = p_po;
end $$;
revoke execute on function inv.withdraw_request(uuid, text) from public;
grant execute on function inv.withdraw_request(uuid, text) to app_rw;

-- Why an order was closed or withdrawn, and by whom, for whoever sees or places it.
create function inv.po_closed(p_po uuid)
returns table (closed_at timestamptz, closed_by text, reason text)
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select po.closed_at, u.display_name, po.close_reason
    from inv.purchase_order po
    left join core.app_user u on u.id = po.closed_by
   where po.id = p_po and po.tenant_id = core.my_tenant() and po.closed_at is not null
     and (core.can('PURCHASE_ORDERS', 'view', null, po.delivery_node_id) or inv.can_place(p_po));
$$;
revoke execute on function inv.po_closed(uuid) from public;
grant execute on function inv.po_closed(uuid) to app_rw;

-- ---------------------------------------------------------------------------
-- Patches: closed orders leave the desk's lists; receiving refuses them; the desk receives
-- its departments' orders; the desk sends the order to the supplier
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('inv.desk_orders()'::regprocedure);
  v_new := replace(v_def, $a$where po.tenant_id = core.my_tenant() and po.status = 'released'$a$,
                   $a$where po.tenant_id = core.my_tenant() and po.status = 'released'
       and po.closed_at is null$a$);
  if v_new = v_def then raise exception 'inv.desk_orders changed'; end if;
  execute v_new;

  v_def := pg_get_functiondef('inv.desk_order_list()'::regprocedure);
  v_new := replace(v_def, $a$and (s.progress <> 'received' or s.created_at > now() - interval '60 days')$a$,
                   $a$and (s.progress not in ('received', 'closed', 'withdrawn')
            or s.created_at > now() - interval '60 days')$a$);
  if v_new = v_def then raise exception 'inv.desk_order_list changed'; end if;
  execute v_new;

  v_def := pg_get_functiondef('inv.order_for_desk(uuid)'::regprocedure);
  v_new := replace(v_def, $a$case when po.status <> 'released' then po.status$a$,
                   $a$case when po.closed_at is not null
                     then case when po.ordered_at is null then 'withdrawn' else 'closed' end
                when po.status <> 'released' then po.status$a$);
  if v_new = v_def then raise exception 'inv.order_for_desk changed'; end if;
  execute v_new;

  v_def := pg_get_functiondef('inv.receive_goods(uuid, jsonb, text)'::regprocedure);
  v_new := replace(v_def, $a$  return inv.receive_at(p_po, v_lines, p_key, now());$a$,
                   $a$  -- closed: nothing more comes (ADR 052)
  if exists (select 1 from inv.purchase_order where id = p_po and closed_at is not null) then
    perform inv.fail('INVALID_STATE', 'the order is closed');
  end if;
  -- the Main Store receives what it orders for a department (ADR 049, 052)
  if inv.via_desk(p_po) and not inv.can_place(p_po) then
    perform inv.fail('NOT_AUTHORISED', 'the Main Store receives this order');
  end if;
  return inv.receive_at(p_po, v_lines, p_key, now());$a$);
  if v_new = v_def then raise exception 'inv.receive_goods changed'; end if;
  execute v_new;

  v_def := pg_get_functiondef('inv.record_po_send(uuid, text)'::regprocedure);
  v_new := replace(v_def, $a$if not core.can('PURCHASE_ORDERS', 'modify', null, v_po.delivery_node_id) then$a$,
                   $a$if not core.can('PURCHASE_ORDERS', 'modify', null, v_po.delivery_node_id)
     and not inv.can_place(v_po.id) then$a$);
  if v_new = v_def then raise exception 'inv.record_po_send changed'; end if;
  execute v_new;

  v_def := pg_get_functiondef('inv.po_sends(uuid)'::regprocedure);
  v_new := replace(v_def, $a$if v_po.id is null or not core.can('PURCHASE_ORDERS', 'view', null, v_po.delivery_node_id) then$a$,
                   $a$if v_po.id is null or (not core.can('PURCHASE_ORDERS', 'view', null, v_po.delivery_node_id)
                         and not inv.can_place(v_po.id)) then$a$);
  if v_new = v_def then raise exception 'inv.po_sends changed'; end if;
  execute v_new;
end $$;

-- migrate:down
do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('inv.desk_orders()'::regprocedure);
  execute replace(v_def, $a$
       and po.closed_at is null$a$, '');
  v_def := pg_get_functiondef('inv.desk_order_list()'::regprocedure);
  execute replace(v_def, $a$and (s.progress not in ('received', 'closed', 'withdrawn')
            or s.created_at > now() - interval '60 days')$a$,
                  $a$and (s.progress <> 'received' or s.created_at > now() - interval '60 days')$a$);
  v_def := pg_get_functiondef('inv.order_for_desk(uuid)'::regprocedure);
  execute replace(v_def, $a$case when po.closed_at is not null
                     then case when po.ordered_at is null then 'withdrawn' else 'closed' end
                when po.status <> 'released' then po.status$a$,
                  $a$case when po.status <> 'released' then po.status$a$);
  v_def := pg_get_functiondef('inv.receive_goods(uuid, jsonb, text)'::regprocedure);
  execute replace(v_def, $a$  -- closed: nothing more comes (ADR 052)
  if exists (select 1 from inv.purchase_order where id = p_po and closed_at is not null) then
    perform inv.fail('INVALID_STATE', 'the order is closed');
  end if;
  -- the Main Store receives what it orders for a department (ADR 049, 052)
  if inv.via_desk(p_po) and not inv.can_place(p_po) then
    perform inv.fail('NOT_AUTHORISED', 'the Main Store receives this order');
  end if;
$a$, '');
  v_def := pg_get_functiondef('inv.record_po_send(uuid, text)'::regprocedure);
  execute replace(v_def, $a$
     and not inv.can_place(v_po.id) then$a$, ' then');
  v_def := pg_get_functiondef('inv.po_sends(uuid)'::regprocedure);
  execute replace(v_def, $a$(not core.can('PURCHASE_ORDERS', 'view', null, v_po.delivery_node_id)
                         and not inv.can_place(v_po.id)) then$a$,
                  $a$not core.can('PURCHASE_ORDERS', 'view', null, v_po.delivery_node_id) then$a$);
end $$;
drop function inv.po_closed(uuid);
drop function inv.withdraw_request(uuid, text);
drop function inv.close_order(uuid, text);
drop function inv.notify_closed(uuid, uuid);
drop function inv.follows_store(uuid);
drop function inv.follows_order(uuid);
drop function inv.via_desk(uuid);
drop view inv.purchase_order_summary;
create view inv.purchase_order_summary with (security_invoker = true) as
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
grant select on inv.purchase_order_summary to app_rw;
alter table inv.purchase_order drop constraint purchase_order_close_check;
alter table inv.purchase_order
  drop column close_reason,
  drop column closed_by,
  drop column closed_at;
