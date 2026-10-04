-- migrate:up

-- Department heads are responsible for orders (PO-5) and for requests for material
-- (TR-3), ADR 043.
--
--   * No approval for menu ingredients in usual quantities. The department head approves
--     anything off the menu (an item in no recipe of the outlet) or more than a company
--     setting (usual_qty_factor, default 1.5) times what the store used in a week, over the
--     last four weeks. With no use in those four weeks yet, a menu item is usual.
--   * The GM can approve too (the department head may be away) and is told of every order,
--     but is not the one responsible. The area manager step above the value threshold stays.
--   * A request for material (RFM) is a transfer into a department's store; it follows the
--     same rule, and the store keeper issues it.
--
-- The engine learns two small things: a step may be conditioned on a flag in the request's
-- payload ("when": {"payload_true": "unusual"}), and a step's escalation group may act at
-- once ("alsoEscalateTo"), not only after the SLA or when the first group cannot.

-- ---------------------------------------------------------------------------
-- The company setting
-- ---------------------------------------------------------------------------

create or replace function core.settings_defaults() returns jsonb
language sql immutable
as $$
  select jsonb_build_object(
    'targets', jsonb_build_object('food', 30, 'drink', 22, 'labour', 25, 'prime', 60,
                                  'wastage', 2, 'tasks', 90),
    'menu_popular_pct', 70,
    'overtime_multiplier', 1,
    'po_send_prices', false,
    'swaps_managers_only', true,
    'count_due_days', 7,
    'usual_qty_factor', 1.5);
$$;

do $$
declare
  v_src text := pg_get_functiondef('core.set_company_settings(jsonb)'::regprocedure);
  v_old text := '    elsif v_key = ''count_due_days'' then';
  v_new text := '    elsif v_key = ''usual_qty_factor'' then
      if jsonb_typeof(v_val) <> ''number'' or (v_val #>> ''{}'')::numeric not between 1 and 10 then
        raise exception ''INVALID_SETTING'' using detail = v_key;
      end if;
    elsif v_key = ''count_due_days'' then';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'core.set_company_settings changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- ---------------------------------------------------------------------------
-- Engine: payload conditions and an escalation group that may act at once
-- ---------------------------------------------------------------------------

-- "payload_true": the key of a flag in the request's payload that must be true.
create function wf.when_matches(p_when jsonb, p_amount numeric, p_tenant uuid, p_payload jsonb)
returns boolean
language plpgsql stable
set search_path = pg_catalog, wf
as $$
begin
  if p_when ? 'payload_true'
     and coalesce(p_payload ->> (p_when ->> 'payload_true'), 'false') <> 'true' then
    return false;
  end if;
  return wf.when_matches(p_when - 'payload_true', p_amount, p_tenant);
end $$;

do $$
declare
  v_src text := pg_get_functiondef('wf.submit(text, text, uuid, jsonb, text)'::regprocedure);
  v_old text := 'wf.when_matches(v_step -> ''when'', v_req.amount, v_req.tenant_id)';
  v_new text := 'wf.when_matches(v_step -> ''when'', v_req.amount, v_req.tenant_id, v_req.payload)';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'wf.submit changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- A step whose definition says "alsoEscalateTo" can be acted on by the holders of its
-- escalation group too (the GM, when the department head is away), never by the initiator.
create or replace function wf.can_act_on_step(p_user uuid, p_step wf.step_instance, p_process text)
returns boolean
language sql stable
set search_path = pg_catalog, core, wf
as $$
  select (p_user <> p_step.initiator_id or p_step.top_of_chain)
     and p_user <> all (coalesce((select r.excluded_approvers from wf.request r
                                   where r.id = p_step.request_id), '{}'))
     and exists (
       select 1
         from (select wf.step_def(r.tenant_id, p_process, p_step.step) as def
                 from wf.request r where r.id = p_step.request_id) d,
              lateral (values (p_step.assignee_group_id),
                              (case when d.def ->> 'alsoEscalateTo' = 'true'
                                    then p_step.escalate_to_group_id end)) g(gid)
        where g.gid is not null
          and p_user in (select wf.approver_holders(d.def ->> 'scope', g.gid, p_step.scope_node_id))
          and exists (select 1 from core.bp_policy
                       where process_type = p_process and step = p_step.step
                         and group_id = g.gid and action = 'approve'));
$$;

-- ---------------------------------------------------------------------------
-- What is usual
-- ---------------------------------------------------------------------------

alter table inv.transfer
  add column kind text not null default 'transfer' check (kind in ('transfer', 'rfm'));

-- The items that are on the menu at a store's outlet: ingredients of the dishes sold from
-- its stores, ingredients of prep recipes (also those of prep made at its stores), and the
-- prep items themselves. Internal: the caller has checked access.
create function inv.on_menu_items(p_node uuid) returns setof uuid
language sql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
  with recursive stores as (
    select n.id from core.hierarchy_node n
     where n.type = 'delivery' and n.archived_at is null
       and (n.id = p_node
            or n.parent_id = (select parent_id from core.hierarchy_node where id = p_node)
            or n.id = (select parent_id from core.hierarchy_node where id = p_node))
  ), dishes as (
    select distinct mo.menu_item_id
      from menu.menu_outlet mo join stores s on s.id = mo.delivery_node_id
     where mo.effective_from <= current_date
       and (mo.effective_to is null or mo.effective_to >= current_date)
  ), items(item_id) as (
    select l.ingredient_item_id
      from dishes d
      cross join lateral inv.recipe_on(null, d.menu_item_id, current_date) r
      join inv.recipe_line l on l.recipe_id = r.id
    union
    select n.item_id from inv.item_node n join stores s on s.id = n.delivery_node_id
     where n.made_here and n.archived_at is null
    union
    select l.ingredient_item_id
      from items i
      cross join lateral inv.recipe_on(i.item_id, null, current_date) r
      join inv.recipe_line l on l.recipe_id = r.id
  )
  select distinct item_id from items;
$$;
revoke execute on function inv.on_menu_items(uuid) from public;

-- Lines that are unusual at p_node: off the menu, or more than usual_qty_factor times the
-- weekly use (what left the store in the last 28 days, divided by four). An item with no use
-- in those 28 days has no usual quantity yet and is not flagged for quantity.
-- p_lines: [{item_id, qty}]. Internal: the caller has checked access.
create function inv.unusual_calc(p_node uuid, p_lines jsonb)
returns table (item_id uuid, reason text, qty numeric, weekly_avg numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_factor numeric;
begin
  v_factor := coalesce(nullif(core.settings_of(
                (select tenant_id from core.hierarchy_node where id = p_node)) ->> 'usual_qty_factor',
                '')::numeric, 1.5);
  return query
    with l as (
      select x.item_id, x.qty from jsonb_to_recordset(p_lines) as x(item_id uuid, qty numeric)
    ), menu as (select m as item_id from inv.on_menu_items(p_node) m),
    use as (
      select s.item_id, -sum(s.qty) / 4 as weekly
        from inv.stock_ledger s
       where s.delivery_node_id = p_node and s.occurred_at >= now() - interval '28 days'
         and s.movement_type in ('sales_depletion', 'consumption', 'production_out', 'wastage',
                                 'transfer_out')
         and s.item_id in (select l.item_id from l)
       group by s.item_id
    )
    select l.item_id,
           case when not exists (select 1 from menu where menu.item_id = l.item_id)
                then 'off_menu' else 'over_usual' end,
           l.qty, round(coalesce(u.weekly, 0), 3)
      from l left join use u on u.item_id = l.item_id
     where not exists (select 1 from menu where menu.item_id = l.item_id)
        or (u.weekly is not null and u.weekly > 0 and l.qty > v_factor * u.weekly);
end $$;
revoke execute on function inv.unusual_calc(uuid, jsonb) from public;

-- The same for the order and request screens, to say before sending whether the department
-- head will have to approve. Needs access to the store's stock, orders or transfers.
create function inv.unusual_lines(p_node uuid, p_lines jsonb)
returns table (item_id uuid, reason text, qty numeric, weekly_avg numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
begin
  perform wf.me();
  if p_node is null
     or not exists (select 1 from core.hierarchy_node where id = p_node and type = 'delivery'
                       and tenant_id = core.my_tenant())
     or not (core.can('STOCK_LEVELS', 'view', null, p_node)
             or core.can('PURCHASE_ORDERS', 'view', null, p_node)
             or core.can('TRANSFERS', 'view', null, p_node)) then
    perform inv.fail('NOT_AUTHORISED', 'view stock at ' || coalesce(p_node::text, 'nowhere'));
  end if;
  perform inv.check_lines(p_lines, p_node);
  return query select * from inv.unusual_calc(p_node, p_lines);
end $$;

-- ---------------------------------------------------------------------------
-- Orders: unusual ones go to the department head; the GM is told of every one
-- ---------------------------------------------------------------------------

-- One notification per order to the outlet's GMs (outlet managers of the store's site),
-- except the person who made it.
create function inv.notify_order(p_po uuid, p_exclude uuid) returns void
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
                     format('To %s, ₹%s, made by %s. %s', coalesce(v_supplier, 'a supplier'),
                            to_char(v_po.total, 'FM9999999990.00'), coalesce(v_by, 'someone'),
                            case when v_unusual
                                 then 'Off the menu or more than usual: the department head approves.'
                                 else 'Menu items in usual quantities: no approval needed.' end),
                     '/stock/orders')
     from core.site_group_holders(v_group, v_po.delivery_node_id) h
    where v_group is not null and h is distinct from p_exclude;
end $$;
revoke execute on function inv.notify_order(uuid, uuid) from public;

do $$
declare
  v_src text := pg_get_functiondef('inv.create_po(uuid, uuid, jsonb, text, text)'::regprocedure);
  v_old text := E'  v_request := wf.submit(''PURCHASE_ORDER'', ''inv.purchase_order'', v_po.id);\n  update inv.purchase_order set status = ''submitted'', wf_request_id = v_request\n   where id = v_po.id;\n';
  v_new text := E'  -- PO-5: off the menu or more than usual goes to the department head\n  v_request := wf.submit(''PURCHASE_ORDER'', ''inv.purchase_order'', v_po.id,\n                         jsonb_build_object(''unusual'',\n                           exists (select 1 from inv.unusual_calc(p_node, p_lines))));\n  update inv.purchase_order set status = ''submitted'', wf_request_id = v_request\n   where id = v_po.id;\n  perform inv.notify_order(v_po.id, v_me.id);\n';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'inv.create_po changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- ---------------------------------------------------------------------------
-- Requests for material: a transfer into a department's store
-- ---------------------------------------------------------------------------

do $$
declare
  v_src text := pg_get_functiondef('inv.request_transfer(uuid, uuid, jsonb, text)'::regprocedure);
  v_old1 text := E'  insert into inv.transfer (tenant_id, from_node_id, to_node_id, idempotency_key)\n  values (v_me.tenant_id, p_from, p_to, p_idempotency_key) returning * into v_t;';
  v_new1 text := E'  -- TR-3: a request into a department''s store is a request for material (RFM)\n  v_rfm := exists (select 1 from core.node_link nl\n                     join core.hierarchy_node o on o.id = nl.org_node_id and o.kind = ''department''\n                    where nl.delivery_node_id = p_to);\n  insert into inv.transfer (tenant_id, from_node_id, to_node_id, idempotency_key, kind)\n  values (v_me.tenant_id, p_from, p_to, p_idempotency_key,\n          case when v_rfm then ''rfm'' else ''transfer'' end) returning * into v_t;';
  v_old2 text := E'  v_request := wf.submit(''TRANSFER'', ''inv.transfer'', v_t.id);';
  v_new2 text := E'  v_request := wf.submit(''TRANSFER'', ''inv.transfer'', v_t.id,\n                         jsonb_build_object(''unusual'',\n                           v_rfm and exists (select 1 from inv.unusual_calc(p_to, p_lines))));';
begin
  if position(v_old1 in v_src) = 0 or position(v_old2 in v_src) = 0 then
    raise exception 'inv.request_transfer changed; update this migration';
  end if;
  v_src := replace(replace(v_src, v_old1, v_new1), v_old2, v_new2);
  v_src := replace(v_src, E'  v_request uuid;\nbegin', E'  v_request uuid;\n  v_rfm boolean;\nbegin');
  execute v_src;
end $$;

revoke execute on function wf.when_matches(jsonb, numeric, uuid, jsonb) from public;
revoke execute on function inv.unusual_lines(uuid, jsonb) from public;
grant execute on function inv.unusual_lines(uuid, jsonb) to app_rw;

-- migrate:down
-- restores the previous definitions from the migrations before this one
do $$
declare
  v_src text := pg_get_functiondef('inv.request_transfer(uuid, uuid, jsonb, text)'::regprocedure);
begin
  v_src := regexp_replace(v_src, E'  -- TR-3:.*?returning \\* into v_t;',
    E'  insert into inv.transfer (tenant_id, from_node_id, to_node_id, idempotency_key)\n  values (v_me.tenant_id, p_from, p_to, p_idempotency_key) returning * into v_t;', 's');
  v_src := regexp_replace(v_src,
    E'wf\\.submit\\(''TRANSFER'', ''inv\\.transfer'', v_t\\.id,.*?\\(p_to, p_lines\\)\\)\\)\\);',
    E'wf.submit(''TRANSFER'', ''inv.transfer'', v_t.id);', 's');
  v_src := replace(v_src, E'  v_rfm boolean;\n', '');
  execute v_src;
end $$;
do $$
declare
  v_src text := pg_get_functiondef('inv.create_po(uuid, uuid, jsonb, text, text)'::regprocedure);
begin
  v_src := regexp_replace(v_src,
    E'  -- PO-5:.*?\\(p_node, p_lines\\)\\)\\);',
    E'  v_request := wf.submit(''PURCHASE_ORDER'', ''inv.purchase_order'', v_po.id);', 's');
  v_src := replace(v_src, E'  perform inv.notify_order(v_po.id, v_me.id);\n', '');
  execute v_src;
end $$;
drop function inv.notify_order(uuid, uuid);
drop function inv.unusual_lines(uuid, jsonb);
drop function inv.unusual_calc(uuid, jsonb);
drop function inv.on_menu_items(uuid);
alter table inv.transfer drop column kind;
create or replace function wf.can_act_on_step(p_user uuid, p_step wf.step_instance, p_process text)
returns boolean
language sql stable
set search_path = pg_catalog, core, wf
as $$
  select (p_user <> p_step.initiator_id or p_step.top_of_chain)
     and p_user <> all (coalesce((select r.excluded_approvers from wf.request r
                                   where r.id = p_step.request_id), '{}'))
     and p_user in (select wf.approver_holders((select wf.step_def(r.tenant_id, p_process, p_step.step) ->> 'scope'
                            from wf.request r where r.id = p_step.request_id),
                         p_step.assignee_group_id, p_step.scope_node_id))
     and exists (select 1 from core.bp_policy
                  where process_type = p_process and step = p_step.step
                    and group_id = p_step.assignee_group_id and action = 'approve');
$$;
do $$
declare
  v_src text := pg_get_functiondef('wf.submit(text, text, uuid, jsonb, text)'::regprocedure);
begin
  execute replace(v_src, 'wf.when_matches(v_step -> ''when'', v_req.amount, v_req.tenant_id, v_req.payload)',
                  'wf.when_matches(v_step -> ''when'', v_req.amount, v_req.tenant_id)');
end $$;
drop function wf.when_matches(jsonb, numeric, uuid, jsonb);
do $$
declare
  v_src text := pg_get_functiondef('core.set_company_settings(jsonb)'::regprocedure);
begin
  execute regexp_replace(v_src,
    E'    elsif v_key = ''usual_qty_factor'' then.*?    elsif v_key = ''count_due_days'' then',
    E'    elsif v_key = ''count_due_days'' then', 's');
end $$;
create or replace function core.settings_defaults() returns jsonb
language sql immutable
as $$
  select jsonb_build_object(
    'targets', jsonb_build_object('food', 30, 'drink', 22, 'labour', 25, 'prime', 60,
                                  'wastage', 2, 'tasks', 90),
    'menu_popular_pct', 70,
    'overtime_multiplier', 1,
    'po_send_prices', false,
    'swaps_managers_only', true,
    'count_due_days', 7);
$$;
