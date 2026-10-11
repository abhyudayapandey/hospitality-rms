-- migrate:up
-- A department asks for stock and follows it to the end (ADR 115).
--
--   * One ask (inv.ask_for_stock) goes to the store that keeps each item: another department's
--     store of the outlet that keeps it (the Bar for lager), else the Main Store.
--   * Every request to the Main Store waits for the GM (TRANSFER step gm_approval, product
--     code); a department head's "unusual" step is for requests between departments only.
--   * Whoever runs the store sends it, or gives it to someone (inv.give_send: a "send" task,
--     done by ops.send_by_task). Short, it asks the Main Store (inv.ask_main_store) or, at the
--     Main Store, orders from a supplier (inv.order_for_request); both are linked to the
--     request they fill (for_transfer_id) and the store is told when the stock arrives.
--   * Receiving is a task for whoever asked (rule 7 kept receipt from them as a workflow step:
--     it went to the GM). The receipt step stays in the definition for requests already open.
--   * Everyone in the chain is told what reaches them; whoever asked sees where it is now
--     (inv.request_now) and its story (inv.request_story).

alter table inv.transfer
  add column for_transfer_id uuid references inv.transfer (id),
  add column note text check (length(note) <= 500);
alter table inv.purchase_order
  add column for_transfer_id uuid references inv.transfer (id);
create index transfer_for on inv.transfer (for_transfer_id) where for_transfer_id is not null;
create index purchase_order_for on inv.purchase_order (for_transfer_id)
  where for_transfer_id is not null;

alter table ops.task_step drop constraint task_step_kind_check;
alter table ops.task_step add constraint task_step_kind_check
  check (kind = any (array['tick', 'number', 'text', 'photo', 'discard', 'batch', 'receive',
                           'send', 'yesno', 'rating']));
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check check (kind in (
  'one_off', 'checklist', 'prep', 'expiry', 'receive', 'licence', 'compliance', 'minibar_refill',
  'minibar_bill', 'sign_off', 'handover', 'discard', 'send'));

-- A store's name without its outlet's: "Bar Store", "Main Store".
create function inv.short_name(p_node uuid) returns text
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select regexp_replace(core.node_name(p_node), '^.*\s[–-]\s', '');
$$;

-- "12 × Test Lager Beer 330ml, 10 × Bath towel": what a request asks for (or sent).
create function inv.transfer_items_text(p_transfer uuid, p_sent boolean default false)
returns text
language sql stable security definer
set search_path = pg_catalog, inv
as $$
  select string_agg(format('%s × %s',
                           trim_scale(case when p_sent then coalesce(tl.dispatched_qty, 0)
                                           else tl.requested_qty end), i.name),
                    ', ' order by i.name)
    from inv.transfer_line tl join inv.item i on i.id = tl.item_id
   where tl.transfer_id = p_transfer
     and (not p_sent or coalesce(tl.dispatched_qty, 0) > 0);
$$;

-- "A", "A or B", "A, B or 2 others".
create function inv.people_words(p_people uuid[]) returns text
language sql stable security definer
set search_path = pg_catalog, core
as $$
  -- whoever holds the outlet's top job first (the GM before the assistant GM), then by name
  with n as (
    select display_name,
           row_number() over (order by (display_name ~* 'assistant|deputy|sous'), display_name) as rn,
           count(*) over () as total
      from core.app_user where id = any (p_people)
  )
  select case
           when max(total) is null then 'nobody'
           when max(total) = 1 then max(display_name)
           when max(total) = 2 then string_agg(display_name, ' or ' order by rn)
           else string_agg(display_name, ', ' order by rn) filter (where rn <= 2)
                  || ' or ' || (max(total) - 2) || case when max(total) = 3 then ' other'
                                                         else ' others' end
         end
    from n;
$$;

-- Who can act on a step of a request now: its group's holders (and the escalation group's when
-- it "also approves"), never whoever raised it unless it is the top of the chain, nor anyone
-- excluded. As wf.can_act_on_step decides it, without the bp_policy check.
create function inv.step_people(p_request uuid, p_step text) returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core, wf
as $$
  select coalesce(array_agg(distinct h order by h), '{}')
    from wf.step_instance s
    join wf.request r on r.id = s.request_id
    cross join lateral (select wf.step_def(r.tenant_id, r.process_type, s.step) as def) d
    cross join lateral (values (s.assignee_group_id),
                               (case when d.def ->> 'alsoEscalateTo' = 'true'
                                     then s.escalate_to_group_id end)) g(gid)
    cross join lateral wf.approver_holders(d.def ->> 'scope', g.gid, s.scope_node_id) h
   where s.request_id = p_request and s.step = p_step and g.gid is not null
     and (h <> r.initiator_id or s.top_of_chain)
     and h <> all (r.excluded_approvers);
$$;

-- The request at the start of a chain: the one whoever asked raised.
create function inv.root_transfer(p_transfer uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, inv
as $$
  with recursive up as (
    select id, for_transfer_id, 0 as depth from inv.transfer where id = p_transfer
    union all
    select t.id, t.for_transfer_id, up.depth + 1
      from inv.transfer t join up on t.id = up.for_transfer_id
     where up.depth < 10
  )
  select id from up order by depth desc limit 1;
$$;

-- Tells people about a request (deduplicated, never the one acting), linking to it.
create function inv.tell(p_transfer uuid, p_people uuid[], p_kind text, p_title text,
                         p_body text default null)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_t inv.transfer;
  v_u uuid;
begin
  select * into v_t from inv.transfer where id = p_transfer;
  for v_u in select distinct u from unnest(p_people) u
              where u is not null and u is distinct from core.current_user_id() loop
    perform ops.notify(v_t.tenant_id, v_u, p_kind, left(p_title, 200), p_body,
                       '/stock/transfers/' || p_transfer);
  end loop;
end $$;

-- Whoever asked at the start of the chain, and whoever raised this request.
create function inv.askers(p_transfer uuid) returns uuid[]
language sql stable security definer
set search_path = pg_catalog, inv
as $$
  select array[(select created_by from inv.transfer where id = inv.root_transfer(p_transfer)),
               (select created_by from inv.transfer where id = p_transfer)];
$$;

-- Which store a department asks for an item: another store of its outlet that keeps it (the one
-- such store), else the Main Store, else any store it may ask that keeps it.
create function inv.stock_source(p_to uuid, p_item uuid) returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_ids uuid[];
  v_main uuid;
begin
  if not (core.can('TRANSFERS', 'view', null, p_to) or core.can('TRANSFERS', 'modify', null, p_to)) then
    perform inv.fail('NOT_AUTHORISED', 'TRANSFERS at ' || p_to);
  end if;
  select coalesce(array_agg(s.id), '{}') into v_ids
    from inv.transfer_sources(p_to) s
   where s.kind = 'store' and s.id <> p_to and not inv.is_main_store(s.id)
     and exists (select 1 from inv.item_node x where x.item_id = p_item
                    and x.delivery_node_id = s.id and x.archived_at is null);
  if cardinality(v_ids) = 1 then
    return v_ids[1];
  end if;
  select s.id into v_main from inv.transfer_sources(p_to) s
   where inv.is_main_store(s.id) and s.id <> p_to limit 1;
  if v_main is not null then
    return v_main;
  end if;
  if cardinality(v_ids) > 0 then
    return v_ids[1];
  end if;
  perform inv.fail('INVALID_SUBJECT', 'no store of this outlet keeps it');
end $$;

-- One ask: a request to each store the items come from. Returns them.
create function inv.ask_for_stock(p_to uuid, p_lines jsonb, p_note text default null,
                                  p_key text default null)
returns uuid[]
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_src record;
  v_ids uuid[] := '{}';
  v_id uuid;
begin
  perform wf.me();
  perform inv.require('TRANSFERS', 'modify', p_to);
  if jsonb_typeof(coalesce(p_lines, 'null')) <> 'array' or jsonb_array_length(p_lines) = 0 then
    perform inv.fail('INVALID_LINES', 'say what you need');
  end if;
  for v_src in
    select s.source, jsonb_agg(jsonb_build_object('item_id', s.item_id, 'qty', s.qty)) as lines
      from (select l.item_id, l.qty, inv.stock_source(p_to, l.item_id) as source
              from jsonb_to_recordset(p_lines) as l(item_id uuid, qty numeric)) s
     group by s.source order by s.source
  loop
    v_id := inv.request_transfer(v_src.source, p_to, v_src.lines,
                                 case when p_key is not null then p_key || ':' || v_src.source end);
    update inv.transfer set note = nullif(btrim(coalesce(p_note, '')), '')
     where id = v_id and note is null;
    v_ids := v_ids || v_id;
  end loop;
  return v_ids;
end $$;

-- The request's people at the store it comes from may act on it (its dispatch step).
create function inv.require_sender(p_transfer uuid) returns inv.transfer
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_t inv.transfer;
begin
  select * into v_t from inv.transfer where id = p_transfer and tenant_id = core.my_tenant();
  if not found or inv.my_transfer_step(p_transfer) is distinct from 'dispatch' then
    perform inv.fail('NOT_AUTHORISED', 'only whoever runs the store sends this');
  end if;
  return v_t;
end $$;

-- Gives the sending to someone of the store's team: a "send" task (one at a time).
create function inv.give_send(p_transfer uuid, p_user uuid) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_t inv.transfer := inv.require_sender(p_transfer);
  v_team uuid := ops.team_of_store(v_t.from_node_id);
  v_task ops.task;
  v_name text;
begin
  if not exists (select 1 from hr.worker w
                   join core.hierarchy_node h on h.id = w.org_node_id
                   join core.hierarchy_node team on team.id = coalesce(v_team, v_t.from_node_id)
                  where w.owner_user_id = p_user and w.status = 'active'
                    and w.tenant_id = v_me.tenant_id
                    and h.path operator(extensions.<@) team.path) then
    perform inv.fail('INVALID_ASSIGNEE', 'someone of the team that runs this store');
  end if;
  update ops.task set status = 'cancelled', cancel_reason = 'given to someone else'
   where transfer_id = p_transfer and kind = 'send' and status in ('open', 'in_progress');
  insert into ops.task (tenant_id, org_node_id, delivery_node_id, kind, title, description,
                        priority, due_at, status, assign_mode, assignee_user_id, assigned_by,
                        transfer_id)
  values (v_me.tenant_id, coalesce(v_team, v_t.from_node_id), v_t.from_node_id, 'send',
          left('Send to ' || inv.short_name(v_t.to_node_id) || ': '
               || inv.transfer_items_text(p_transfer), 200),
          coalesce(v_t.note, 'Take it from the ' || inv.short_name(v_t.from_node_id)
                             || ' to the ' || inv.short_name(v_t.to_node_id) || '.'),
          'high', now() + interval '2 hours', 'open', 'person', p_user, v_me.id, p_transfer)
  returning * into v_task;
  insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind)
  values (v_me.tenant_id, v_task.id, v_task.org_node_id, 1, 'Take it and say what you sent',
          'send');
  perform ops.notify_task(v_task, array[p_user], 'task_assigned', 'New task: ' || v_task.title);
  select display_name into v_name from core.app_user where id = p_user;
  perform inv.tell(p_transfer, inv.askers(p_transfer), 'stock_request',
                   v_name || ' is bringing it from the ' || inv.short_name(v_t.from_node_id),
                   inv.transfer_items_text(p_transfer));
  return v_task.id;
end $$;

-- Whoever runs the store sends it themselves (what was given to someone is withdrawn).
create function inv.send_request(p_transfer uuid, p_lines jsonb default null) returns text
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops, wf
as $$
declare
  v_state text;
begin
  perform inv.require_sender(p_transfer);
  v_state := inv.dispatch_transfer(p_transfer, p_lines, null);
  update ops.task set status = 'cancelled', cancel_reason = 'sent by '
         || (select display_name from core.app_user where id = core.current_user_id())
   where transfer_id = p_transfer and kind = 'send' and status in ('open', 'in_progress');
  return v_state;
end $$;

-- The person given it sends it: as whoever gave it for the workflow (they still must be able
-- to), recorded as sent by the person who took it.
create function ops.send_by_task(p_task uuid, p_lines jsonb default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_t ops.task;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = v_me.tenant_id;
  if found and v_t.kind <> 'send' then
    perform ops.fail('INVALID_STEP', 'not something to send');
  end if;
  v_t := ops.task_to_work(p_task);
  perform set_config('app.user_id', v_t.assigned_by::text, true);
  perform inv.dispatch_transfer(v_t.transfer_id, p_lines, null);
  perform set_config('app.user_id', v_me.id::text, true);
  update inv.transfer set dispatched_by = v_me.id where id = v_t.transfer_id;
  update ops.task_step set done_by = v_me.id, done_at = now()
   where task_id = v_t.id and kind = 'send';
  perform ops.settle(v_t.id);
  return v_t.transfer_id;
end $$;

-- After dispatch with no receipt step (every request from ADR 115 on): whoever asked gets it
-- to receive, and hears it is on the way.
create function inv.after_dispatch(p_transfer uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops, wf
as $$
declare
  v_t inv.transfer;
  v_to uuid;
  v_team uuid;
  v_task ops.task;
  v_items text;
begin
  select * into v_t from inv.transfer where id = p_transfer;
  if exists (select 1 from wf.step_instance where request_id = v_t.wf_request_id
                and step = 'receipt' and state in ('pending', 'waiting')) then
    return;
  end if;
  v_items := inv.transfer_items_text(p_transfer, true);
  v_team := ops.team_of_store(v_t.to_node_id);
  -- whoever asked, while they still work there; else whoever is on shift, else its head
  select u.id into v_to from core.app_user u
   where u.id = v_t.created_by and u.status = 'active';
  v_to := coalesce(v_to, ops.on_shift_now(v_team),
                   (ops.leads(v_team, array['DEPARTMENT_HEAD', 'OUTLET_MANAGER'], '{}'))[1]);
  if v_to is null then
    perform inv.fail('NO_APPROVER', 'nobody at that store can receive it');
  end if;
  insert into ops.task (tenant_id, org_node_id, delivery_node_id, kind, title, description,
                        priority, due_at, status, assign_mode, assignee_user_id, assigned_by,
                        transfer_id)
  values (v_t.tenant_id, coalesce(v_team, v_t.to_node_id), v_t.to_node_id, 'receive',
          left('Receive from the ' || inv.short_name(v_t.from_node_id) || ': ' || v_items, 200),
          'Sent by ' || (select display_name from core.app_user where id = v_t.dispatched_by)
            || '. Check what arrived and confirm it.',
          'high', now() + interval '1 hour', 'open', 'person', v_to,
          coalesce(v_t.dispatched_by, core.current_user_id()), p_transfer)
  returning * into v_task;
  insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind)
  values (v_t.tenant_id, v_task.id, v_task.org_node_id, 1, 'Check what arrived and confirm',
          'receive');
  perform ops.notify_task(v_task, array[v_to], 'task_assigned', 'New task: ' || v_task.title);
  perform inv.tell(p_transfer, inv.askers(p_transfer), 'stock_request',
                   'On the way from the ' || inv.short_name(v_t.from_node_id), v_items);
end $$;

-- After it is received: whoever sent it and runs that store hear it; a request this one filled
-- is back with its store to send on; whoever asked hears where it is.
create function inv.after_receive(p_transfer uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops, wf
as $$
declare
  v_t inv.transfer;
  v_d inv.transfer;
  v_items text;
begin
  select * into v_t from inv.transfer where id = p_transfer;
  v_items := inv.transfer_items_text(p_transfer, true);
  perform inv.tell(p_transfer,
                   array[v_t.dispatched_by]
                     || (select coalesce(array_agg(t.assigned_by), '{}') from ops.task t
                          where t.transfer_id = p_transfer and t.kind = 'send')
                     || inv.step_people(v_t.wf_request_id, 'dispatch')
                     || coalesce((select array_agg(distinct s.actor_id) from wf.step_instance s
                                   where s.request_id = v_t.wf_request_id
                                     and s.step = 'dispatch' and s.actor_id is not null), '{}'),
                   'stock_request', 'Received at the ' || inv.short_name(v_t.to_node_id),
                   v_items);
  if v_t.for_transfer_id is not null then
    select * into v_d from inv.transfer where id = v_t.for_transfer_id;
    if v_d.dispatched_at is null and v_d.status = 'submitted' then
      perform inv.tell(v_d.id, inv.step_people(v_d.wf_request_id, 'dispatch'), 'stock_request',
                       'It has arrived: send it to the ' || inv.short_name(v_d.to_node_id),
                       inv.transfer_items_text(v_d.id));
      perform inv.tell(v_d.id, inv.askers(v_d.id), 'stock_request',
                       'Arrived at the ' || inv.short_name(v_t.to_node_id), v_items);
    end if;
  end if;
end $$;

-- Short at a department's store: ask the Main Store for what is short (or what is given).
create function inv.ask_main_store(p_transfer uuid, p_lines jsonb default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_t inv.transfer := inv.require_sender(p_transfer);
  v_main uuid := inv.order_desk(v_t.from_node_id);
  v_lines jsonb := p_lines;
  v_id uuid;
begin
  if v_main = v_t.from_node_id then
    perform inv.fail('INVALID_SUBJECT', 'this is the Main Store: order it from a supplier');
  end if;
  select id into v_id from inv.transfer
   where for_transfer_id = p_transfer and status in ('draft', 'submitted') and received_at is null;
  if found then
    return v_id;
  end if;
  if v_lines is null then
    select jsonb_agg(jsonb_build_object('item_id', x.item_id, 'qty', x.qty)) into v_lines
      from (select tl.item_id,
                   coalesce(nullif(greatest(tl.requested_qty - coalesce(sl.on_hand, 0), 0), 0),
                            tl.requested_qty) as qty
              from inv.transfer_line tl
              left join inv.stock_level sl on sl.item_id = tl.item_id
                                          and sl.delivery_node_id = v_t.from_node_id
             where tl.transfer_id = p_transfer
               and tl.requested_qty > coalesce(sl.on_hand, 0)) x;
    if v_lines is null then
      select jsonb_agg(jsonb_build_object('item_id', item_id, 'qty', requested_qty)) into v_lines
        from inv.transfer_line where transfer_id = p_transfer;
    end if;
  end if;
  v_id := inv.request_transfer(v_main, v_t.from_node_id, v_lines, null);
  update inv.transfer set for_transfer_id = p_transfer,
                          note = 'For the ' || inv.short_name(v_t.to_node_id) || '''s request'
   where id = v_id;
  perform inv.tell(p_transfer, inv.askers(p_transfer), 'stock_request',
                   'The ' || inv.short_name(v_t.from_node_id) || ' is short: it asked the Main Store',
                   inv.transfer_items_text(v_id));
  return v_id;
end $$;

-- At the Main Store, short: order it from a supplier for this request. The GM approved the
-- request, so the order goes straight to the order desk.
create function inv.order_for_request(p_transfer uuid, p_lines jsonb default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_t inv.transfer := inv.require_sender(p_transfer);
  v_lines jsonb := p_lines;
  v_po inv.purchase_order;
  v_request uuid;
begin
  select * into v_po from inv.purchase_order
   where for_transfer_id = p_transfer and status in ('draft', 'submitted', 'released')
     and not exists (select 1 from inv.goods_receipt g where g.po_id = inv.purchase_order.id);
  if found then
    return v_po.id;
  end if;
  if v_lines is null then
    select jsonb_agg(jsonb_build_object('item_id', x.item_id, 'qty', x.qty)) into v_lines
      from (select tl.item_id,
                   coalesce(nullif(greatest(tl.requested_qty - coalesce(sl.on_hand, 0), 0), 0),
                            tl.requested_qty) as qty
              from inv.transfer_line tl
              left join inv.stock_level sl on sl.item_id = tl.item_id
                                          and sl.delivery_node_id = v_t.from_node_id
             where tl.transfer_id = p_transfer) x;
  end if;
  perform inv.check_lines(v_lines, v_t.from_node_id);
  insert into inv.purchase_order (tenant_id, delivery_node_id, supplier_id, notes, total,
                                  for_transfer_id)
  select v_me.tenant_id, v_t.from_node_id, null,
         'For the ' || inv.short_name(v_t.to_node_id) || '''s request',
         round(sum(l.qty * coalesce(sl.avg_cost, 0)), 2), p_transfer
    from jsonb_to_recordset(v_lines) as l(item_id uuid, qty numeric)
    left join inv.stock_level sl on sl.item_id = l.item_id and sl.delivery_node_id = v_t.from_node_id
  returning * into v_po;
  insert into inv.purchase_order_line (tenant_id, po_id, item_id, delivery_node_id, qty, unit_cost)
  select v_me.tenant_id, v_po.id, l.item_id, v_t.from_node_id, l.qty, coalesce(sl.avg_cost, 0)
    from jsonb_to_recordset(v_lines) as l(item_id uuid, qty numeric)
    left join inv.stock_level sl on sl.item_id = l.item_id and sl.delivery_node_id = v_t.from_node_id;
  v_request := wf.submit('PURCHASE_ORDER', 'inv.purchase_order', v_po.id,
                         jsonb_build_object('unusual', false));
  update inv.purchase_order set status = 'submitted', wf_request_id = v_request
   where id = v_po.id;
  perform inv.tell(p_transfer, inv.askers(p_transfer), 'stock_request',
                   'The Main Store is buying it from a supplier', inv.transfer_items_text(p_transfer));
  return v_po.id;
end $$;

-- Goods in for an order a request waits on: whoever runs the Main Store is told to send it on.
create function inv.after_goods_receipt() returns trigger
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_for uuid;
  v_t inv.transfer;
begin
  select coalesce(po.for_transfer_id, parent.for_transfer_id) into v_for
    from inv.purchase_order po
    left join inv.purchase_order parent on parent.id = po.request_po_id
   where po.id = new.po_id;
  if v_for is null then
    return null;
  end if;
  select * into v_t from inv.transfer where id = v_for;
  if v_t.dispatched_at is null and v_t.status = 'submitted' then
    perform inv.tell(v_for, inv.step_people(v_t.wf_request_id, 'dispatch'), 'stock_request',
                     'It has arrived: send it to the ' || inv.short_name(v_t.to_node_id),
                     inv.transfer_items_text(v_for));
    perform inv.tell(v_for, inv.askers(v_for), 'stock_request',
                     'Arrived at the ' || inv.short_name(v_t.from_node_id),
                     inv.transfer_items_text(v_for));
  end if;
  return null;
end $$;
create trigger request_goods_in after insert on inv.goods_receipt
  for each row execute function inv.after_goods_receipt();

-- A step of a stock request or an order reaches people: they are told. Approved or not by
-- someone: whoever asked is told.
create function inv.after_step() returns trigger
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_r wf.request;
  v_t inv.transfer;
  v_who text;
  v_what text;
begin
  select * into v_r from wf.request where id = new.request_id;
  if v_r.process_type = 'PURCHASE_ORDER' and new.state = 'pending'
     and (tg_op = 'INSERT' or old.state is distinct from 'pending') then
    perform ops.notify(v_r.tenant_id, u, 'stock_request',
                       'To approve: the ' || inv.short_name(po.delivery_node_id) || ' asks to buy '
                         || coalesce((select string_agg(format('%s × %s', trim_scale(pl.qty), i.name),
                                                        ', ' order by i.name)
                                        from inv.purchase_order_line pl
                                        join inv.item i on i.id = pl.item_id
                                       where pl.po_id = po.id), 'supplies'),
                       v_r.payload ->> 'why', '/stock/orders/' || po.id)
      from inv.purchase_order po, unnest(inv.step_people(new.request_id, new.step)) u
     where po.id = v_r.subject_id;
    return null;
  end if;
  if v_r.process_type <> 'TRANSFER' then
    return null;
  end if;
  select * into v_t from inv.transfer where id = v_r.subject_id;
  if not found then
    return null;
  end if;
  v_what := inv.transfer_items_text(v_t.id);
  if new.state = 'pending' and (tg_op = 'INSERT' or old.state is distinct from 'pending') then
    perform inv.tell(v_t.id, inv.step_people(new.request_id, new.step), 'stock_request',
                     case when new.step = 'dispatch'
                          then 'The ' || inv.short_name(v_t.to_node_id) || ' asks for ' || v_what
                          else 'To approve: the ' || inv.short_name(v_t.to_node_id) || ' asks '
                                 || case when inv.is_main_store(v_t.from_node_id)
                                         then 'the Main Store'
                                         else 'the ' || inv.short_name(v_t.from_node_id) end
                                 || ' for ' || v_what end,
                     v_t.note);
  elsif tg_op = 'UPDATE' and new.step in ('approval', 'gm_approval')
        and new.state in ('approved', 'rejected') and old.state is distinct from new.state then
    select display_name into v_who from core.app_user where id = new.actor_id;
    perform inv.tell(v_t.id, inv.askers(v_t.id)
                       || coalesce((select array[d.created_by] || inv.step_people(d.wf_request_id, 'dispatch')
                                      from inv.transfer d where d.id = v_t.for_transfer_id), '{}'),
                     'stock_request',
                     case when new.state = 'approved' then 'Approved by ' || coalesce(v_who, 'the GM')
                          else 'Not approved by ' || coalesce(v_who, 'the GM') end
                       || ': ' || v_what,
                     new.comment);
  end if;
  return null;
end $$;
create trigger request_step_told after insert or update of state on wf.step_instance
  for each row execute function inv.after_step();

-- Who may follow a request: the people of either store, whoever raised it, whoever has (had) a
-- task for it, and anyone who may follow the request it fills.
create function inv.may_follow(p_transfer uuid) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_t inv.transfer;
  v_me uuid := core.current_user_id();
begin
  select * into v_t from inv.transfer where id = p_transfer and tenant_id = core.my_tenant();
  if not found then
    return false;
  end if;
  return v_t.created_by = v_me
      or core.can('TRANSFERS', 'view', null, v_t.to_node_id)
      or core.can('TRANSFERS', 'view', null, v_t.from_node_id)
      or exists (select 1 from ops.task k where k.transfer_id = p_transfer
                    and v_me in (k.assignee_user_id, k.assigned_by))
      or (v_t.for_transfer_id is not null and inv.may_follow(v_t.for_transfer_id));
end $$;

-- Where a request is now, in words (no access check; inv.request_now checks).
create function inv.now_of(p_transfer uuid, p_depth int default 0,
                           out stage text, out words text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, wf
as $$
declare
  v_t inv.transfer;
  v_r wf.request;
  v_step text;
  v_up uuid;
  v_po inv.purchase_order;
  v_task ops.task;
  v_up_words text;
begin
  select * into v_t from inv.transfer where id = p_transfer;
  select * into v_r from wf.request where id = v_t.wf_request_id;
  if v_t.received_at is not null then
    stage := 'received';
    words := 'Received by ' || coalesce((select display_name from core.app_user
                                          where id = v_t.received_by), 'the store');
    return;
  end if;
  if v_t.status in ('rejected', 'cancelled') then
    stage := 'closed';
    words := 'Not sent' || coalesce(': ' || (select s.comment from wf.step_instance s
                                              where s.request_id = v_r.id and s.state = 'rejected'
                                              order by s.acted_at desc limit 1), '');
    return;
  end if;
  if v_t.dispatched_at is not null then
    stage := 'on_the_way';
    words := 'On the way from the ' || inv.short_name(v_t.from_node_id) || ', sent by '
             || coalesce((select display_name from core.app_user where id = v_t.dispatched_by),
                         'the store');
    return;
  end if;
  v_step := v_r.current_step;
  if v_r.state = 'failed' then
    stage := 'stuck';
    words := 'Could not go through: ' || coalesce(v_r.failure_code, 'an error') || '. Ask again.';
    return;
  end if;
  if v_step in ('approval', 'gm_approval') then
    stage := 'waiting_approval';
    words := 'Waiting for ' || inv.people_words(inv.step_people(v_r.id, v_step)) || ' to approve';
    return;
  end if;
  -- with the store it comes from: given to someone, waiting on the Main Store or a supplier
  select * into v_task from ops.task
   where transfer_id = p_transfer and kind = 'send' and status in ('open', 'in_progress')
   order by created_at desc limit 1;
  if found then
    stage := 'being_sent';
    words := (select display_name from core.app_user where id = v_task.assignee_user_id)
             || ' is bringing it from the ' || inv.short_name(v_t.from_node_id);
    return;
  end if;
  select id into v_up from inv.transfer
   where for_transfer_id = p_transfer and status = 'submitted' and received_at is null
   order by created_at desc limit 1;
  if v_up is not null and p_depth < 5 then
    select n.words into v_up_words from inv.now_of(v_up, p_depth + 1) n;
    stage := 'waiting_upstream';
    words := 'The ' || inv.short_name(v_t.from_node_id) || ' asked the Main Store: ' || v_up_words;
    return;
  end if;
  select * into v_po from inv.purchase_order po
   where po.for_transfer_id = p_transfer and po.status in ('submitted', 'released')
     and not exists (select 1 from inv.goods_receipt g where g.po_id = po.id)
   order by po.created_at desc limit 1;
  if found then
    stage := 'being_ordered';
    words := case when v_po.ordered_at is null then 'Being ordered from a supplier'
                  else 'Ordered from ' || coalesce((select name from inv.supplier
                                                     where id = v_po.supplier_id), 'a supplier')
                       || coalesce(', due ' || to_char(v_po.expected_on, 'FMDD Mon'), '') end;
    return;
  end if;
  stage := 'with_store';
  words := 'With the ' || inv.short_name(v_t.from_node_id) || ': '
           || inv.people_words(inv.step_people(v_r.id, 'dispatch'));
end $$;

create function inv.request_now(p_transfer uuid) returns table (stage text, words text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  perform wf.me();
  if not inv.may_follow(p_transfer) then
    perform inv.fail('NOT_AUTHORISED', 'follow this request');
  end if;
  return query select n.stage, n.words from inv.now_of(p_transfer) n;
end $$;

-- A request's story, the requests and orders it waited on included, oldest first.
create function inv.story_of(p_transfer uuid, p_depth int default 0)
returns table (at timestamptz, rank int, words text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, wf
as $$
declare
  v_t inv.transfer;
  v_base int := p_depth * 20;
  v_up uuid;
begin
  select * into v_t from inv.transfer where id = p_transfer;
  return query
    select v_t.created_at, v_base + case when p_depth = 0 then 0 else 20 end,
           case when p_depth = 0
                then 'Asked by ' || (select display_name from core.app_user where id = v_t.created_by)
                     || ' for ' || inv.transfer_items_text(p_transfer)
                else 'The ' || inv.short_name(v_t.to_node_id) || ' asked '
                     || case when inv.is_main_store(v_t.from_node_id) then 'the Main Store'
                             else 'the ' || inv.short_name(v_t.from_node_id) end
                     || ' for ' || inv.transfer_items_text(p_transfer) end;
  return query
    select s.acted_at, v_base + 25,
           case when s.state = 'approved' then 'Approved by ' else 'Not approved by ' end
             || (select display_name from core.app_user where id = s.actor_id)
             || coalesce(': ' || nullif(s.comment, ''), '')
      from wf.step_instance s
     where s.request_id = v_t.wf_request_id and s.step in ('approval', 'gm_approval')
       and s.state in ('approved', 'rejected') and s.actor_id is not null;
  -- what it waited on: a request to the Main Store, an order from a supplier
  for v_up in select id from inv.transfer where for_transfer_id = p_transfer order by created_at loop
    if p_depth < 5 then
      return query select * from inv.story_of(v_up, p_depth + 1);
    end if;
  end loop;
  return query
    select po.created_at, v_base + 30, 'Being ordered from a supplier'
      from inv.purchase_order po where po.for_transfer_id = p_transfer
    union all
    select po.ordered_at, v_base + 32,
           'Ordered from ' || coalesce(su.name, 'a supplier')
             || coalesce(', due ' || to_char(po.expected_on, 'FMDD Mon'), '')
      from inv.purchase_order po
      left join inv.supplier su on su.id = po.supplier_id
     where po.ordered_at is not null
       and (po.for_transfer_id = p_transfer
            or po.request_po_id in (select id from inv.purchase_order where for_transfer_id = p_transfer))
    union all
    select g.received_at, v_base + 34, 'Arrived at the ' || inv.short_name(g.delivery_node_id)
      from inv.goods_receipt g join inv.purchase_order po on po.id = g.po_id
     where po.for_transfer_id = p_transfer
        or po.request_po_id in (select id from inv.purchase_order where for_transfer_id = p_transfer);
  return query
    select k.created_at, v_base + 60 + p_depth,
           'Given to ' || (select display_name from core.app_user where id = k.assignee_user_id)
             || ' to send'
      from ops.task k where k.transfer_id = p_transfer and k.kind = 'send';
  if v_t.dispatched_at is not null then
    return query select v_t.dispatched_at, v_base + 70 + p_depth,
                        'Sent by ' || (select display_name from core.app_user where id = v_t.dispatched_by)
                          || ': ' || inv.transfer_items_text(p_transfer, true);
  end if;
  if v_t.received_at is not null then
    return query select v_t.received_at, v_base + 80 + p_depth,
                        'Received by ' || (select display_name from core.app_user where id = v_t.received_by)
                          || case when p_depth > 0 then ' at the ' || inv.short_name(v_t.to_node_id)
                                  else '' end;
  end if;
end $$;

create function inv.request_story(p_transfer uuid) returns table (at timestamptz, words text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  perform wf.me();
  if not inv.may_follow(p_transfer) then
    perform inv.fail('NOT_AUTHORISED', 'follow this request');
  end if;
  return query select s.at, s.words from inv.story_of(p_transfer) s
                order by s.at, s.rank;
end $$;

-- Every request to the Main Store waits for the GM (gm_approval); between departments, an
-- unusual one waits for the department head as before.
select core.patch_function('inv.request_transfer(uuid,uuid,jsonb,text)',
  $x$jsonb_build_object('unusual',
                           v_rfm and exists (select 1 from inv.unusual_calc(p_to, p_lines)),$x$,
  $x$jsonb_build_object('main_store', inv.is_main_store(p_from), 'unusual',
                           v_rfm and not inv.is_main_store(p_from)
                             and exists (select 1 from inv.unusual_calc(p_to, p_lines)),$x$);

-- Dispatch with no receipt step: whoever asked gets it to receive
select core.patch_function('inv.dispatch_transfer_at(uuid,jsonb,text,timestamp with time zone)',
  $x$  update inv.transfer set dispatched_at = p_at, dispatched_by = v_me.id where id = p_transfer;
  return v_state;$x$,
  $x$  update inv.transfer set dispatched_at = p_at, dispatched_by = v_me.id where id = p_transfer;
  perform inv.after_dispatch(p_transfer);
  return v_state;$x$);
select core.patch_function('inv.receive_transfer_at(uuid,jsonb,text,timestamp with time zone)',
  $x$  update inv.transfer set received_at = p_at, received_by = v_me.id where id = p_transfer;
  return v_state;$x$,
  $x$  update inv.transfer set received_at = p_at, received_by = v_me.id where id = p_transfer;
  perform inv.after_receive(p_transfer);
  return v_state;$x$);
select core.patch_function('ops.receive_sent(uuid,jsonb)',
  $x$      array_to_string(v_short, '; '));
  end if;
  return v_tr.id;$x$,
  $x$      array_to_string(v_short, '; '));
  end if;
  perform inv.after_receive(v_tr.id);
  return v_tr.id;$x$);

revoke execute on function inv.short_name(uuid), inv.transfer_items_text(uuid, boolean),
  inv.people_words(uuid[]), inv.step_people(uuid, text), inv.root_transfer(uuid),
  inv.tell(uuid, uuid[], text, text, text), inv.askers(uuid), inv.require_sender(uuid),
  inv.after_dispatch(uuid), inv.after_receive(uuid), inv.after_goods_receipt(),
  inv.after_step(), inv.may_follow(uuid), inv.now_of(uuid, int), inv.story_of(uuid, int)
  from public;
revoke execute on function inv.stock_source(uuid, uuid), inv.ask_for_stock(uuid, jsonb, text, text),
  inv.give_send(uuid, uuid), inv.send_request(uuid, jsonb), ops.send_by_task(uuid, jsonb),
  inv.ask_main_store(uuid, jsonb), inv.order_for_request(uuid, jsonb),
  inv.request_now(uuid), inv.request_story(uuid)
  from public;
grant execute on function inv.stock_source(uuid, uuid), inv.ask_for_stock(uuid, jsonb, text, text),
  inv.give_send(uuid, uuid), inv.send_request(uuid, jsonb), ops.send_by_task(uuid, jsonb),
  inv.ask_main_store(uuid, jsonb), inv.order_for_request(uuid, jsonb),
  inv.request_now(uuid), inv.request_story(uuid)
  to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
select core.patch_function('ops.receive_sent(uuid,jsonb)',
  $x$  perform inv.after_receive(v_tr.id);
$x$, '');
select core.patch_function('inv.receive_transfer_at(uuid,jsonb,text,timestamp with time zone)',
  $x$  perform inv.after_receive(p_transfer);
$x$, '');
select core.patch_function('inv.dispatch_transfer_at(uuid,jsonb,text,timestamp with time zone)',
  $x$  perform inv.after_dispatch(p_transfer);
$x$, '');
select core.patch_function('inv.request_transfer(uuid,uuid,jsonb,text)',
  $x$jsonb_build_object('main_store', inv.is_main_store(p_from), 'unusual',
                           v_rfm and not inv.is_main_store(p_from)
                             and exists (select 1 from inv.unusual_calc(p_to, p_lines)),$x$,
  $x$jsonb_build_object('unusual',
                           v_rfm and exists (select 1 from inv.unusual_calc(p_to, p_lines)),$x$);
drop trigger request_step_told on wf.step_instance;
drop trigger request_goods_in on inv.goods_receipt;
drop function inv.request_story(uuid);
drop function inv.story_of(uuid, int);
drop function inv.request_now(uuid);
drop function inv.now_of(uuid, int);
drop function inv.may_follow(uuid);
drop function inv.after_step();
drop function inv.after_goods_receipt();
drop function inv.order_for_request(uuid, jsonb);
drop function inv.ask_main_store(uuid, jsonb);
drop function inv.after_receive(uuid);
drop function inv.after_dispatch(uuid);
drop function ops.send_by_task(uuid, jsonb);
drop function inv.send_request(uuid, jsonb);
drop function inv.give_send(uuid, uuid);
drop function inv.require_sender(uuid);
drop function inv.ask_for_stock(uuid, jsonb, text, text);
drop function inv.stock_source(uuid, uuid);
drop function inv.askers(uuid);
drop function inv.tell(uuid, uuid[], text, text, text);
drop function inv.root_transfer(uuid);
drop function inv.step_people(uuid, text);
drop function inv.people_words(uuid[]);
drop function inv.transfer_items_text(uuid, boolean);
drop function inv.short_name(uuid);
delete from ops.task_step where kind = 'send';
delete from ops.task where kind = 'send';
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check check (kind in (
  'one_off', 'checklist', 'prep', 'expiry', 'receive', 'licence', 'compliance', 'minibar_refill',
  'minibar_bill', 'sign_off', 'handover', 'discard'));
alter table ops.task_step drop constraint task_step_kind_check;
alter table ops.task_step add constraint task_step_kind_check
  check (kind = any (array['tick', 'number', 'text', 'photo', 'discard', 'batch', 'receive',
                           'yesno', 'rating']));
drop index inv.purchase_order_for;
drop index inv.transfer_for;
alter table inv.purchase_order drop column for_transfer_id;
alter table inv.transfer drop column note, drop column for_transfer_id;
