-- migrate:up
-- RFMs History: one row per chain (ADR 164). A head who gave a staff ask by asking the Main
-- Store, whose keeper bought what was short, saw the same request three times: the ask, the
-- request made for it and the order made for that. A request made for an ask now shows in the
-- ask's row, and an order made for a request (or a supply request) in that chain's row, when
-- the person took part in the chain. Whoever made, placed or received the order keeps a row
-- for it: the Main Store's keeper sees the request they sent and the order they bought, two
-- pieces of work. Approving an order is part of the chain, not a row of its own.

create or replace function inv.my_material_history(p_limit int default 50)
returns table (kind text, id uuid, page_id uuid, node uuid, created_at timestamptz,
               asked_by text, mine boolean, store text, items text, stage text, words text,
               progress text, for_ask text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf, ops
as $$
declare
  v_me uuid := core.current_user_id();
  v_tenant uuid := core.my_tenant();
  v_n int := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  perform wf.me();
  return query
  with asks as (
    select a.id, a.delivery_node_id, a.created_at, a.asked_by
      from inv.staff_ask a
     where a.tenant_id = v_tenant
       and (a.asked_by = v_me or a.given_by = v_me or a.closed_by = v_me
            or a.collected_by = v_me
            or exists (select 1 from ops.task k
                        where k.staff_ask_id = a.id
                          and (k.assignee_user_id = v_me or k.completed_by = v_me))
            or v_me = any (inv.ask_heads(a.id)))
     order by a.created_at desc
     limit v_n
  ), transfers as (
    select r.id, r.subject_id, r.delivery_node_id, r.created_at, r.initiator_id,
           (select f.for_ask_id from inv.transfer f
             where f.id = inv.root_transfer(t.id)) as chain_ask
      from wf.request r
      join inv.transfer t on t.id = r.subject_id
     where r.tenant_id = v_tenant and r.subject_type = 'inv.transfer'
       and (r.initiator_id = v_me or t.dispatched_by = v_me or t.received_by = v_me
            or exists (select 1 from wf.step_instance s
                        where s.request_id = r.id and s.actor_id = v_me)
            or exists (select 1 from ops.task k
                        where k.transfer_id = t.id
                          and (k.assignee_user_id = v_me or k.completed_by = v_me)))
     order by r.created_at desc
     limit v_n
  ), orders as (
    select r.id, r.subject_id, r.delivery_node_id, r.created_at, r.initiator_id,
           p.for_transfer_id, p.request_po_id,
           (select f.for_ask_id from inv.transfer f
             where f.id = inv.root_transfer(p.for_transfer_id)) as chain_ask,
           -- made, placed, closed or received it: the buying is their own work
           (r.initiator_id = v_me or p.ordered_by = v_me or p.closed_by = v_me
            or exists (select 1 from inv.goods_receipt g
                        where g.po_id = p.id and g.created_by = v_me)) as maker
      from wf.request r
      join inv.purchase_order p on p.id = r.subject_id
     where r.tenant_id = v_tenant and r.subject_type = 'inv.purchase_order'
       and (r.initiator_id = v_me or p.ordered_by = v_me or p.closed_by = v_me
            or exists (select 1 from wf.step_instance s
                        where s.request_id = r.id and s.actor_id = v_me)
            or exists (select 1 from inv.goods_receipt g
                        where g.po_id = p.id and g.created_by = v_me))
     order by r.created_at desc
     limit v_n
  )
  select x.* from (
    select 'ask'::text, a.id, a.id, a.delivery_node_id, a.created_at, u.display_name,
           a.asked_by = v_me, inv.short_name(a.delivery_node_id),
           inv.staff_ask_items_text(a.id), n.stage, n.words, null::text, null::text
      from asks a
      join core.app_user u on u.id = a.asked_by
      cross join lateral inv.staff_ask_now(a.id) n
    union all
    select 'request', t.id, t.subject_id, t.delivery_node_id, t.created_at, u.display_name,
           t.initiator_id = v_me, null,
           (select string_agg(trim(trailing '.' from trim(trailing '0' from
                                tl.requested_qty::text)) || ' × ' || i.name,
                              ', ' order by i.name)
              from inv.transfer_line tl join inv.item i on i.id = tl.item_id
             where tl.transfer_id = t.subject_id),
           n.stage, n.words, null,
           (select f.asked_by || coalesce(': ' || f.note, '')
              from inv.request_for_ask(t.subject_id) f)
      from transfers t
      join core.app_user u on u.id = t.initiator_id
      cross join lateral inv.request_now(t.subject_id) n
     -- made for an ask they took part in: that ask's row says it all
     where t.chain_ask is null or t.chain_ask not in (select a2.id from asks a2)
    union all
    select 'supply', o.id, o.subject_id, o.delivery_node_id, o.created_at, u.display_name,
           o.initiator_id = v_me, null,
           (select string_agg(i.name, ', ' order by i.name)
              from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
             where pl.po_id = o.subject_id),
           null, null, s.progress, null
      from orders o
      join core.app_user u on u.id = o.initiator_id
      join inv.purchase_order_summary s on s.id = o.subject_id
     -- bought for a chain they took part in (an ask, a request, a supply request), and not
     -- their own buying (approving it is part of their chain): the chain's row says it all
     where o.maker
        or not coalesce(
             o.chain_ask in (select a2.id from asks a2)
             or o.for_transfer_id in (select t2.subject_id from transfers t2)
             or inv.root_transfer(o.for_transfer_id) in (select t2.subject_id from transfers t2)
             or o.request_po_id in (select o2.subject_id from orders o2), false)
  ) x
  order by 5 desc
  limit v_n;
end $$;


-- migrate:down
create or replace function inv.my_material_history(p_limit int default 50)
returns table (kind text, id uuid, page_id uuid, node uuid, created_at timestamptz,
               asked_by text, mine boolean, store text, items text, stage text, words text,
               progress text, for_ask text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf, ops
as $$
declare
  v_me uuid := core.current_user_id();
  v_tenant uuid := core.my_tenant();
  v_n int := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  perform wf.me();
  return query
  with asks as (
    select a.id, a.delivery_node_id, a.created_at, a.asked_by
      from inv.staff_ask a
     where a.tenant_id = v_tenant
       and (a.asked_by = v_me or a.given_by = v_me or a.closed_by = v_me
            or a.collected_by = v_me
            or exists (select 1 from ops.task k
                        where k.staff_ask_id = a.id
                          and (k.assignee_user_id = v_me or k.completed_by = v_me))
            or v_me = any (inv.ask_heads(a.id)))
     order by a.created_at desc
     limit v_n
  ), transfers as (
    select r.id, r.subject_id, r.delivery_node_id, r.created_at, r.initiator_id
      from wf.request r
      join inv.transfer t on t.id = r.subject_id
     where r.tenant_id = v_tenant and r.subject_type = 'inv.transfer'
       and (r.initiator_id = v_me or t.dispatched_by = v_me or t.received_by = v_me
            or exists (select 1 from wf.step_instance s
                        where s.request_id = r.id and s.actor_id = v_me)
            or exists (select 1 from ops.task k
                        where k.transfer_id = t.id
                          and (k.assignee_user_id = v_me or k.completed_by = v_me)))
     order by r.created_at desc
     limit v_n
  ), orders as (
    select r.id, r.subject_id, r.delivery_node_id, r.created_at, r.initiator_id
      from wf.request r
      join inv.purchase_order p on p.id = r.subject_id
     where r.tenant_id = v_tenant and r.subject_type = 'inv.purchase_order'
       and (r.initiator_id = v_me or p.ordered_by = v_me or p.closed_by = v_me
            or exists (select 1 from wf.step_instance s
                        where s.request_id = r.id and s.actor_id = v_me)
            or exists (select 1 from inv.goods_receipt g
                        where g.po_id = p.id and g.created_by = v_me))
     order by r.created_at desc
     limit v_n
  )
  select x.* from (
    select 'ask'::text, a.id, a.id, a.delivery_node_id, a.created_at, u.display_name,
           a.asked_by = v_me, inv.short_name(a.delivery_node_id),
           inv.staff_ask_items_text(a.id), n.stage, n.words, null::text, null::text
      from asks a
      join core.app_user u on u.id = a.asked_by
      cross join lateral inv.staff_ask_now(a.id) n
    union all
    select 'request', t.id, t.subject_id, t.delivery_node_id, t.created_at, u.display_name,
           t.initiator_id = v_me, null,
           (select string_agg(trim(trailing '.' from trim(trailing '0' from
                                tl.requested_qty::text)) || ' × ' || i.name,
                              ', ' order by i.name)
              from inv.transfer_line tl join inv.item i on i.id = tl.item_id
             where tl.transfer_id = t.subject_id),
           n.stage, n.words, null,
           (select f.asked_by || coalesce(': ' || f.note, '')
              from inv.request_for_ask(t.subject_id) f)
      from transfers t
      join core.app_user u on u.id = t.initiator_id
      cross join lateral inv.request_now(t.subject_id) n
    union all
    select 'supply', o.id, o.subject_id, o.delivery_node_id, o.created_at, u.display_name,
           o.initiator_id = v_me, null,
           (select string_agg(i.name, ', ' order by i.name)
              from inv.purchase_order_line pl join inv.item i on i.id = pl.item_id
             where pl.po_id = o.subject_id),
           null, null, s.progress, null
      from orders o
      join core.app_user u on u.id = o.initiator_id
      join inv.purchase_order_summary s on s.id = o.subject_id
  ) x
  order by 5 desc
  limit v_n;
end $$;

