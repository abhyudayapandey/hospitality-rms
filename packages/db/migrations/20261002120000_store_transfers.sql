-- migrate:up
-- Store-level transfers (ADR 009 part 2, Prompt 7 item 6).
--
-- A transfer moves stock between two stores of the same outlet (Main Store -> Kitchen
-- Store) or from a hub (central kitchen) to an outlet's store. Its dispatch and receipt
-- steps go to whoever runs the sending and the receiving location: the location's store
-- keeper, else its hub manager, else the outlet manager, else the account owner (the step
-- chains in packages/workflow/src/processes.ts).
--
-- "Runs the location" is looked up from the location upward, but only within its own site:
-- the nearest outlet or hub at or above it (core.stock_site). A hub sits above the outlets
-- it supplies in the delivery tree, so an unbounded walk would hand an outlet's receipt to
-- the central kitchen's store keeper. Beyond the site, the lookup crosses to the org tree
-- through the location's link anchor as before (outlet manager, account owner).
--
-- Dispatch and receipt authorise by step: whoever may act on the step may dispatch or
-- receive, with or without TRANSFERS rights at that place (a fallback approver such as the
-- account owner holds none). Rule 7 still applies (wf.can_act_on_step).

-- The site a delivery place belongs to: the nearest outlet or hub at or above it.
create function core.stock_site(p_node uuid) returns uuid
language sql stable
set search_path = pg_catalog, core, extensions
as $$
  select a.id
    from core.hierarchy_node n
    join core.hierarchy_node a
      on a.tenant_id = n.tenant_id and a.type = 'delivery' and a.path @> n.path
     and a.kind in ('outlet', 'hub')
   where n.id = p_node and n.type = 'delivery'
   order by nlevel(a.path) desc
   limit 1;
$$;

-- core.nearest_group_node, with the delivery walk kept inside the start's site.
create function core.site_group_node(p_group uuid, p_start uuid, p_exclude uuid[],
                                     p_strict boolean default false) returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, core, extensions
as $$
declare
  v_start core.hierarchy_node;
  v_site core.hierarchy_node;
  v_found uuid;
  v_org uuid;
begin
  select * into v_start from core.hierarchy_node where id = p_start;
  if not found or v_start.type <> 'delivery' then
    return core.nearest_group_node(p_group, p_start, p_exclude, p_strict);
  end if;
  select * into v_site from core.hierarchy_node where id = core.stock_site(p_start);

  select a.id into v_found
    from core.hierarchy_node a
   where a.type = 'delivery' and a.path @> v_start.path and a.archived_at is null
     and (v_site.id is null or v_site.path @> a.path)
     and (not p_strict or a.id <> v_start.id)
     and exists (
       select 1 from core.role_assignment ra
         join core.app_user u on u.id = ra.user_id and u.status = 'active'
        where ra.group_id = p_group and ra.node_id = a.id
          and ra.user_id <> all (coalesce(p_exclude, '{}'))
          and current_date >= ra.effective_from
          and (ra.effective_to is null or current_date <= ra.effective_to)
          and (a.id = v_start.id or ra.include_descendants))
   order by nlevel(a.path) desc
   limit 1;
  if v_found is not null then
    return v_found;
  end if;

  for v_org in select nl.org_node_id from core.node_link nl
                where nl.delivery_node_id = core.link_anchor(v_start.id) order by nl.org_node_id loop
    v_found := core.nearest_group_node(p_group, v_org, p_exclude, p_strict);
    if v_found is not null then
      return v_found;
    end if;
  end loop;
  return null;
end $$;

-- core.group_holders, counting only assignments inside the node's site.
create function core.site_group_holders(p_group uuid, p_node uuid) returns setof uuid
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  select distinct ra.user_id
    from core.hierarchy_node t
    left join core.hierarchy_node s on s.id = core.stock_site(t.id)
    join core.role_assignment ra on ra.group_id = p_group
    join core.app_user u on u.id = ra.user_id and u.status = 'active'
    join core.hierarchy_node n on n.id = ra.node_id and n.type = t.type and n.archived_at is null
   where t.id = p_node
     and current_date >= ra.effective_from
     and (ra.effective_to is null or current_date <= ra.effective_to)
     and (n.id = t.id or (ra.include_descendants and n.path @> t.path))
     and (t.type = 'org' or s.id is null or s.path @> n.path);
$$;

-- The two-sided scopes (from_node, to_node) look up the location's own runners.
create function wf.location_scope(p_scope text) returns boolean
language sql immutable
as $$ select p_scope in ('from_node', 'to_node') $$;

create function wf.approver_node(p_scope text, p_group uuid, p_start uuid, p_exclude uuid[],
                                 p_strict boolean default false) returns uuid
language sql stable
set search_path = pg_catalog, core, wf
as $$
  select case when wf.location_scope(p_scope)
              then core.site_group_node(p_group, p_start, p_exclude, p_strict)
              else core.nearest_group_node(p_group, p_start, p_exclude, p_strict) end;
$$;

create function wf.approver_holders(p_scope text, p_group uuid, p_node uuid) returns setof uuid
language sql stable
set search_path = pg_catalog, core, wf
as $$
  select h from core.site_group_holders(p_group, p_node) h where wf.location_scope(p_scope)
  union all
  select h from core.group_holders(p_group, p_node) h where not wf.location_scope(p_scope);
$$;

revoke execute on function core.stock_site(uuid), core.site_group_node(uuid, uuid, uuid[], boolean),
  core.site_group_holders(uuid, uuid), wf.approver_node(text, uuid, uuid, uuid[], boolean),
  wf.approver_holders(text, uuid, uuid) from public;

-- Routing, escalation and who may act use them (same bodies otherwise).
do $$
declare
  v_src text;
  v_decl text := 'v_exclude uuid[] := wf.non_approvers(p_request);';
  v_holders text := 'core.group_holders(p_step.assignee_group_id, p_step.scope_node_id)';
begin
  v_src := pg_get_functiondef('wf.route_chain(uuid, text, text, uuid, uuid, text, uuid, uuid[])'::regprocedure);
  if position('core.group_holders(p_group, p_start)' in v_src) = 0
     or position('core.nearest_group_node(' in v_src) = 0 then
    raise exception 'wf.route_chain changed; update this migration';
  end if;
  v_src := replace(v_src, 'core.group_holders(p_group, p_start)',
                   'wf.approver_holders(p_scope, p_group, p_start)');
  execute replace(v_src, 'core.nearest_group_node(', 'wf.approver_node(p_scope, ');

  v_src := pg_get_functiondef('wf.escalation_target(wf.step_instance, wf.request)'::regprocedure);
  if position(v_decl in v_src) = 0 or position('core.nearest_group_node(' in v_src) = 0 then
    raise exception 'wf.escalation_target changed; update this migration';
  end if;
  v_src := replace(v_src, v_decl, v_decl || E'\n  v_scope text := wf.step_def(p_request.tenant_id, '
                   || 'p_request.process_type, p_step.step) ->> ''scope'';');
  execute replace(v_src, 'core.nearest_group_node(', 'wf.approver_node(v_scope, ');

  v_src := pg_get_functiondef('wf.can_act_on_step(uuid, wf.step_instance, text)'::regprocedure);
  if position(v_holders in v_src) = 0 then
    raise exception 'wf.can_act_on_step changed; update this migration';
  end if;
  execute replace(v_src, v_holders,
    'wf.approver_holders((select wf.step_def(r.tenant_id, p_process, p_step.step) ->> ''scope''
                            from wf.request r where r.id = p_step.request_id),
                         p_step.assignee_group_id, p_step.scope_node_id)');
end $$;

-- Dispatch and receipt: authorised by the step, not by TRANSFERS rights at the place.
create function inv.require_step(p_request uuid, p_step text) returns void
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
begin
  if not exists (select 1 from wf.step_instance s join wf.request r on r.id = s.request_id
                  where s.request_id = p_request and s.step = p_step
                    and wf.can_act_on_step(core.current_user_id(), s, r.process_type)) then
    perform inv.fail('NOT_AUTHORISED', format('you cannot act on the %s step', p_step));
  end if;
end $$;
revoke execute on function inv.require_step(uuid, text) from public;

do $$
declare
  v_src text;
begin
  v_src := pg_get_functiondef('inv.dispatch_transfer(uuid, jsonb, text)'::regprocedure);
  if position('perform inv.require(''TRANSFERS'', ''modify'', v_t.from_node_id);' in v_src) = 0 then
    raise exception 'inv.dispatch_transfer changed; update this migration';
  end if;
  execute replace(v_src, 'perform inv.require(''TRANSFERS'', ''modify'', v_t.from_node_id);',
                  'perform inv.require_step(v_t.wf_request_id, ''dispatch'');');
  v_src := pg_get_functiondef('inv.receive_transfer(uuid, jsonb, text)'::regprocedure);
  if position('perform inv.require(''TRANSFERS'', ''modify'', v_t.to_node_id);' in v_src) = 0 then
    raise exception 'inv.receive_transfer changed; update this migration';
  end if;
  execute replace(v_src, 'perform inv.require(''TRANSFERS'', ''modify'', v_t.to_node_id);',
                  'perform inv.require_step(v_t.wf_request_id, ''receipt'');');
  -- a transfer only from a place transfer_sources offers
  v_src := pg_get_functiondef('inv.request_transfer(uuid, uuid, jsonb, text)'::regprocedure);
  if position('perform inv.check_lines(p_lines, p_to);' in v_src) = 0 then
    raise exception 'inv.request_transfer changed; update this migration';
  end if;
  execute replace(v_src, 'perform inv.check_lines(p_lines, p_to);',
    'if not exists (select 1 from inv.transfer_sources(p_to) s where s.id = p_from) then
    perform inv.fail(''INVALID_SUBJECT'', ''stock can come from another store of this outlet or a central kitchen'');
  end if;
  perform inv.check_lines(p_lines, p_to);');
end $$;

-- Where p_to can request stock from: the other stores of its own site (outlet or hub),
-- then hubs; never another outlet.
create or replace function inv.transfer_sources(p_to uuid)
returns table (id uuid, name text, kind text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_site uuid;
begin
  perform wf.me();
  perform inv.require('TRANSFERS', 'modify', p_to);
  v_site := core.stock_site(p_to);
  return query
    select n.id, n.name, n.kind from core.hierarchy_node n
     where n.tenant_id = core.my_tenant() and n.type = 'delivery' and n.archived_at is null
       and n.holds_stock and n.id <> p_to
       and exists (select 1 from inv.item_node i where i.delivery_node_id = n.id)
       and (core.stock_site(n.id) = v_site or n.kind = 'hub')
     order by (core.stock_site(n.id) = v_site) desc, n.name;
end $$;

-- The transfer step the caller may act on now ('dispatch', 'receipt'), else null: what the
-- transfer screen offers.
create function inv.my_transfer_step(p_transfer uuid) returns text
language sql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
  select s.step
    from inv.transfer t
    join wf.request r on r.id = t.wf_request_id and r.state = 'in_approval'
    join wf.step_instance s on s.request_id = r.id and s.state = 'pending'
   where t.id = p_transfer and t.tenant_id = core.my_tenant()
     and wf.can_act_on_step(core.current_user_id(), s, r.process_type)
   limit 1;
$$;
-- A transfer's lines for whoever may act on its pending step, whatever their TRANSFERS
-- rights (the lines carry no request id for the pending-inbox rule).
create function inv.my_transfer_lines(p_transfer uuid)
returns table (item_id uuid, name text, base_uom text, requested_qty numeric,
               dispatched_qty numeric, received_qty numeric)
language sql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
  select tl.item_id, i.name, i.base_uom, tl.requested_qty, tl.dispatched_qty, tl.received_qty
    from inv.transfer_line tl join inv.item i on i.id = tl.item_id
   where tl.transfer_id = p_transfer and inv.my_transfer_step(p_transfer) is not null
   order by i.name;
$$;
revoke execute on function inv.my_transfer_step(uuid), inv.my_transfer_lines(uuid) from public;
grant execute on function inv.my_transfer_step(uuid), inv.my_transfer_lines(uuid) to app_rw;

-- migrate:down
create or replace function inv.transfer_sources(p_to uuid)
returns table (id uuid, name text, kind text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_parent uuid;
begin
  perform wf.me();
  perform inv.require('TRANSFERS', 'modify', p_to);
  select h.parent_id into v_parent from core.hierarchy_node h where h.id = p_to;
  return query
    select n.id, n.name, n.kind from core.hierarchy_node n
     where n.tenant_id = core.my_tenant() and n.type = 'delivery' and n.archived_at is null
       and n.holds_stock and n.id <> p_to
       and exists (select 1 from inv.item_node i where i.delivery_node_id = n.id)
     -- stores of the same location first (its sibling stores, or the location itself),
     -- then hubs; sibling outlets are not a preferred source
     order by (n.id = v_parent or (n.kind = 'store' and n.parent_id = v_parent)) desc,
              (n.kind = 'hub') desc, n.name;
end $$;

do $$
declare
  v_src text;
begin
  v_src := pg_get_functiondef('inv.request_transfer(uuid, uuid, jsonb, text)'::regprocedure);
  execute replace(v_src,
    'if not exists (select 1 from inv.transfer_sources(p_to) s where s.id = p_from) then
    perform inv.fail(''INVALID_SUBJECT'', ''stock can come from another store of this outlet or a central kitchen'');
  end if;
  perform inv.check_lines(p_lines, p_to);', 'perform inv.check_lines(p_lines, p_to);');
  execute replace(pg_get_functiondef('inv.dispatch_transfer(uuid, jsonb, text)'::regprocedure),
    'perform inv.require_step(v_t.wf_request_id, ''dispatch'');',
    'perform inv.require(''TRANSFERS'', ''modify'', v_t.from_node_id);');
  execute replace(pg_get_functiondef('inv.receive_transfer(uuid, jsonb, text)'::regprocedure),
    'perform inv.require_step(v_t.wf_request_id, ''receipt'');',
    'perform inv.require(''TRANSFERS'', ''modify'', v_t.to_node_id);');

  execute replace(pg_get_functiondef('wf.can_act_on_step(uuid, wf.step_instance, text)'::regprocedure),
    'wf.approver_holders((select wf.step_def(r.tenant_id, p_process, p_step.step) ->> ''scope''
                            from wf.request r where r.id = p_step.request_id),
                         p_step.assignee_group_id, p_step.scope_node_id)',
    'core.group_holders(p_step.assignee_group_id, p_step.scope_node_id)');
  v_src := pg_get_functiondef('wf.escalation_target(wf.step_instance, wf.request)'::regprocedure);
  v_src := replace(v_src, E'\n  v_scope text := wf.step_def(p_request.tenant_id, '
                   || 'p_request.process_type, p_step.step) ->> ''scope'';', '');
  execute replace(v_src, 'wf.approver_node(v_scope, ', 'core.nearest_group_node(');
  v_src := pg_get_functiondef('wf.route_chain(uuid, text, text, uuid, uuid, text, uuid, uuid[])'::regprocedure);
  v_src := replace(v_src, 'wf.approver_holders(p_scope, p_group, p_start)',
                   'core.group_holders(p_group, p_start)');
  execute replace(v_src, 'wf.approver_node(p_scope, ', 'core.nearest_group_node(');
end $$;

drop function inv.my_transfer_lines(uuid);
drop function inv.my_transfer_step(uuid);
drop function inv.require_step(uuid, text);
drop function wf.approver_holders(text, uuid, uuid);
drop function wf.approver_node(text, uuid, uuid, uuid[], boolean);
drop function wf.location_scope(text);
drop function core.site_group_holders(uuid, uuid);
drop function core.site_group_node(uuid, uuid, uuid[], boolean);
drop function core.stock_site(uuid);
