-- migrate:up
-- Approval chains (ADR 009 part 2). A step is routed, in order, to:
--   A. its group at the subject (or the nearest holder, for nearest_ancestor)
--   B. its escalateTo group, nearest holder from the subject up
--   C. its group strictly above the subject
--   D. each group of its `fallback` list, nearest holder first
--   E. ACCOUNT_OWNER, the final approver of every step of every process
-- A..C are the existing rules (SoD fallback, ADR 008), so nothing already routed changes.
-- SLA escalation moves a pending step to the next group of the same chain.
--
-- Also:
--   * a step may depend on a customer setting (`when: {setting: ...}`, default on): the
--     leave HR step is `leave_hr_approval`
--   * delivery places find org approvers through their link anchor (a store under a
--     linked supply point, not only a store with its own link)
--   * pending-inbox visibility: whoever may act on a request's pending step can read the
--     subject row, however they were routed, and never once the step has moved on
--   * a decision summary (label, amount, items or dates) is kept on the step when someone
--     acts, readable by that person afterwards; the subject row itself stays hidden
--   * wf.approval_coverage lists every process, step and place nobody could approve

alter table core.tenant add column settings jsonb not null default '{}'
  check (jsonb_typeof(settings) = 'object');

-- A customer setting that turns a workflow step on or off; unset means on.
create function wf.setting_on(p_tenant uuid, p_key text) returns boolean
language sql stable
set search_path = pg_catalog, core
as $$
  select coalesce((select (t.settings ->> p_key)::boolean from core.tenant t where t.id = p_tenant),
                  true);
$$;

create function wf.when_matches(p_when jsonb, p_amount numeric, p_tenant uuid) returns boolean
language plpgsql stable
set search_path = pg_catalog, wf
as $$
begin
  if p_when ? 'setting' and not wf.setting_on(p_tenant, p_when ->> 'setting') then
    return false;
  end if;
  return wf.when_matches(p_when - 'setting', p_amount);
end $$;

-- Delivery places reach org approvers through their link anchor.
do $$
declare
  v_src text := pg_get_functiondef('core.nearest_group_node(uuid, uuid, uuid[], boolean)'::regprocedure);
  v_old text := 'where nl.delivery_node_id = v_start.id';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'core.nearest_group_node changed; update this migration';
  end if;
  execute replace(v_src, v_old, 'where nl.delivery_node_id = core.link_anchor(v_start.id)');
end $$;

-- A step's approver groups in order: group, escalateTo, fallback..., ACCOUNT_OWNER.
create function wf.chain_groups(p_tenant uuid, p_process text, p_step text) returns uuid[]
language sql stable
set search_path = pg_catalog, core, wf
as $$
  with s as (select wf.step_def(p_tenant, p_process, p_step) as d),
  codes as (
    select d ->> 'group' as code, 0 as ord from s
    union all select d ->> 'escalateTo', 1 from s where d ? 'escalateTo'
    union all select f.code, 1 + f.ord::int
      from s, jsonb_array_elements_text(coalesce(s.d -> 'fallback', '[]')) with ordinality f(code, ord)
    union all select 'ACCOUNT_OWNER', 1000),
  firsts as (select distinct on (code) code, ord from codes order by code, ord)
  select coalesce(array_agg(g.id order by f.ord), '{}')
    from firsts f join core.security_group g on g.tenant_id = p_tenant and g.code = f.code;
$$;

-- Routes one step from p_start for a tenant; p_exclude are people who may not approve.
create function wf.route_chain(p_tenant uuid, p_process text, p_step text, p_group uuid,
                               p_escalate uuid, p_scope text, p_start uuid, p_exclude uuid[],
                               out o_group uuid, out o_node uuid)
language plpgsql stable
set search_path = pg_catalog, core, wf
as $$
declare
  v_g uuid;
begin
  -- A. the step's group
  if p_scope = 'nearest_ancestor' then
    o_node := core.nearest_group_node(p_group, p_start, p_exclude);
  elsif exists (select 1 from core.group_holders(p_group, p_start) h(uid)
                 where h.uid <> all (p_exclude)) then
    o_node := p_start;
  end if;
  if o_node is not null then
    o_group := p_group;
    return;
  end if;
  -- B. escalateTo, from the start up
  if p_escalate is not null then
    o_node := core.nearest_group_node(p_escalate, p_start, p_exclude);
    if o_node is not null then
      o_group := p_escalate;
      return;
    end if;
  end if;
  -- C. the same group strictly above
  o_node := core.nearest_group_node(p_group, p_start, p_exclude, true);
  if o_node is not null then
    o_group := p_group;
    return;
  end if;
  -- D, E. the fallback groups, then ACCOUNT_OWNER
  foreach v_g in array wf.chain_groups(p_tenant, p_process, p_step) loop
    continue when v_g = p_group or v_g is not distinct from p_escalate;
    o_node := core.nearest_group_node(v_g, p_start, p_exclude);
    if o_node is not null then
      o_group := v_g;
      return;
    end if;
  end loop;
end $$;

drop function wf.route_step(uuid, uuid, text, wf.request);
create function wf.route_step(p_group uuid, p_escalate uuid, p_scope text, p_request wf.request,
                              p_step text default null, out o_group uuid, out o_node uuid)
language plpgsql stable
set search_path = pg_catalog, core, wf
as $$
declare
  v_subject uuid := case (select hierarchy_type from wf.process_def
                           where tenant_id = p_request.tenant_id
                             and process_type = p_request.process_type)
                      when 'org' then p_request.org_node_id else p_request.delivery_node_id end;
  v_start uuid;
begin
  v_start := case p_scope
    when 'subject_node' then v_subject
    when 'nearest_ancestor' then v_subject
    when 'from_node' then (p_request.payload ->> 'from_node_id')::uuid
    when 'to_node' then (p_request.payload ->> 'to_node_id')::uuid
  end;
  if v_start is null then
    raise exception 'INVALID_PROCESS_DEF' using detail = format('cannot resolve scope %s', p_scope);
  end if;
  select r.o_group, r.o_node into o_group, o_node
    from wf.route_chain(p_request.tenant_id, p_request.process_type, p_step, p_group, p_escalate,
                        p_scope, v_start, wf.non_approvers(p_request)) r;
end $$;

do $$
declare
  v_src text := pg_get_functiondef('wf.submit(text, text, uuid, jsonb, text)'::regprocedure);
  v_when text := 'wf.when_matches(v_step -> ''when'', v_req.amount)';
  v_route text := 'from wf.route_step(v_group, v_escalate, v_step ->> ''scope'', v_req) r';
begin
  if position(v_when in v_src) = 0 or position(v_route in v_src) = 0 then
    raise exception 'wf.submit changed; update this migration';
  end if;
  v_src := replace(v_src, v_when, 'wf.when_matches(v_step -> ''when'', v_req.amount, v_req.tenant_id)');
  v_src := replace(v_src, v_route,
    'from wf.route_step(v_group, v_escalate, v_step ->> ''scope'', v_req, v_step ->> ''step'') r');
  execute v_src;
end $$;

-- Where an overdue step goes next: the next group of its chain, nearest holder from the
-- step's place; after the last group, the same group strictly above; else nowhere.
create function wf.escalation_target(p_step wf.step_instance, p_request wf.request,
                                     out o_group uuid, out o_node uuid)
language plpgsql stable
set search_path = pg_catalog, core, wf
as $$
declare
  v_chain uuid[] := wf.chain_groups(p_request.tenant_id, p_request.process_type, p_step.step);
  v_pos int := coalesce(array_position(v_chain, p_step.assignee_group_id), 0);
  v_exclude uuid[] := wf.non_approvers(p_request);
begin
  for i in v_pos + 1 .. coalesce(cardinality(v_chain), 0) loop
    continue when v_chain[i] = p_step.assignee_group_id;
    o_node := core.nearest_group_node(v_chain[i], p_step.scope_node_id, v_exclude);
    if o_node is not null then
      o_group := v_chain[i];
      return;
    end if;
  end loop;
  o_group := p_step.assignee_group_id;
  o_node := core.nearest_group_node(p_step.assignee_group_id, p_step.scope_node_id, v_exclude, true);
end $$;

create or replace function wf.overdue_steps(p_at timestamptz default now())
returns table (step_id uuid, request_id uuid, process_type text, step text,
               overdue_since timestamptz, target_group_id uuid, target_node_id uuid)
language sql stable security definer
set search_path = pg_catalog, core, wf, extensions
as $$
  select s.id, r.id, r.process_type, s.step,
         s.activated_at + make_interval(hours => d.sla_hours),
         t.o_group, t.o_node
    from wf.step_instance s
    join wf.request r on r.id = s.request_id and r.state = 'in_approval'
    join wf.process_def d on d.tenant_id = r.tenant_id and d.process_type = r.process_type
   cross join lateral wf.escalation_target(s, r) t
   where s.state = 'pending'
     and s.activated_at + make_interval(hours => d.sla_hours) < p_at;
$$;

-- Every process, step and place where nobody could approve (the loader rejects these).
create function wf.approval_coverage(p_tenant uuid)
returns table (process_type text, step text, node_id uuid, node_code text)
language plpgsql stable security definer
set search_path = pg_catalog, core, wf
as $$
declare
  d wf.process_def;
  s jsonb;
  n record;
  r record;
begin
  for d in select * from wf.process_def pd where pd.tenant_id = p_tenant order by pd.process_type loop
    for s in select * from jsonb_array_elements(d.steps) loop
      continue when s -> 'when' ? 'setting'
                    and not wf.setting_on(p_tenant, s -> 'when' ->> 'setting');
      for n in select h.id, h.code from core.hierarchy_node h
                where h.tenant_id = p_tenant and h.archived_at is null
                  and h.type = d.hierarchy_type
                  and (d.hierarchy_type = 'org' or h.holds_stock)
                order by h.path loop
        select * into r
          from wf.route_chain(p_tenant, d.process_type, s ->> 'step',
                              wf.group_id(p_tenant, s ->> 'group'),
                              wf.group_id(p_tenant, s ->> 'escalateTo'),
                              s ->> 'scope', n.id, '{}');
        if r.o_node is null then
          process_type := d.process_type;
          step := s ->> 'step';
          node_id := n.id;
          node_code := n.code;
          return next;
        end if;
      end loop;
    end loop;
  end loop;
end $$;
revoke execute on function wf.approval_coverage(uuid) from public;

-- ---------------------------------------------------------------------------
-- Decision summaries and pending-inbox visibility
-- ---------------------------------------------------------------------------

alter table core.subject_resolver add column summarizer regprocedure;
alter table wf.step_instance add column decision_summary jsonb;

create function inv.po_summary(p_id uuid) returns jsonb
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select jsonb_build_object(
           'label', 'Purchase order', 'place', n.name, 'supplier', s.name,
           'amount', po.total, 'currency', po.currency,
           'lines', coalesce((select jsonb_agg(jsonb_build_object(
                                'item', i.name, 'qty', l.qty, 'unit', i.base_uom,
                                'unit_cost', l.unit_cost) order by i.name)
                                from inv.purchase_order_line l join inv.item i on i.id = l.item_id
                               where l.po_id = po.id), '[]'))
    from inv.purchase_order po
    join core.hierarchy_node n on n.id = po.delivery_node_id
    left join inv.supplier s on s.id = po.supplier_id
   where po.id = p_id;
$$;

create function inv.adjustment_summary(p_id uuid) returns jsonb
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select jsonb_build_object(
           'label', 'Stock adjustment', 'place', n.name, 'reason', a.reason,
           'amount', a.amount, 'currency', a.currency,
           'lines', coalesce((select jsonb_agg(jsonb_build_object(
                                'item', i.name, 'movement', l.movement_type, 'qty', l.qty,
                                'unit', i.base_uom) order by i.name)
                                from inv.stock_adjustment_line l join inv.item i on i.id = l.item_id
                               where l.adjustment_id = a.id), '[]'))
    from inv.stock_adjustment a join core.hierarchy_node n on n.id = a.delivery_node_id
   where a.id = p_id;
$$;

create function inv.transfer_summary_of(p_id uuid) returns jsonb
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select jsonb_build_object(
           'label', 'Transfer', 'from', f.name, 'to', t.name,
           'lines', coalesce((select jsonb_agg(jsonb_build_object(
                                'item', i.name, 'requested', l.requested_qty,
                                'dispatched', l.dispatched_qty, 'received', l.received_qty,
                                'unit', i.base_uom) order by i.name)
                                from inv.transfer_line l join inv.item i on i.id = l.item_id
                               where l.transfer_id = tr.id), '[]'))
    from inv.transfer tr
    join core.hierarchy_node f on f.id = tr.from_node_id
    join core.hierarchy_node t on t.id = tr.to_node_id
   where tr.id = p_id;
$$;

create function hr.leave_summary(p_id uuid) returns jsonb
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select jsonb_build_object(
           'label', 'Leave', 'person', u.display_name, 'place', n.name, 'type', t.name,
           'from', l.from_date, 'to', l.to_date, 'days', l.days)
    from hr.leave_request l
    join core.app_user u on u.id = l.owner_user_id
    join core.hierarchy_node n on n.id = l.org_node_id
    join hr.leave_type t on t.id = l.leave_type_id
   where l.id = p_id;
$$;

create function hr.swap_summary(p_id uuid) returns jsonb
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select jsonb_build_object(
           'label', 'Shift swap', 'person', a.display_name, 'to', b.display_name,
           'place', n.name, 'starts', s.start_at, 'ends', s.end_at, 'role', s.role_code)
    from hr.shift_swap sw
    join core.app_user a on a.id = sw.owner_user_id
    join core.app_user b on b.id = sw.to_user_id
    join hr.shift s on s.id = sw.shift_id
    join core.hierarchy_node n on n.id = sw.org_node_id
   where sw.id = p_id;
$$;

create function hr.role_change_summary(p_id uuid) returns jsonb
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select jsonb_build_object(
           'label', 'Role change', 'action', rc.action, 'person', u.display_name,
           'access_group', g.code, 'place', n.name, 'from', rc.effective_from,
           'to', rc.effective_to)
    from hr.role_change rc
    join core.app_user u on u.id = rc.target_user_id
    left join core.security_group g on g.id = rc.group_id
    left join core.hierarchy_node n on n.id = rc.node_id
   where rc.id = p_id;
$$;

revoke execute on function inv.po_summary(uuid), inv.adjustment_summary(uuid),
  inv.transfer_summary_of(uuid), hr.leave_summary(uuid), hr.swap_summary(uuid),
  hr.role_change_summary(uuid) from public;

update core.subject_resolver set summarizer = case subject_type
  when 'inv.purchase_order' then 'inv.po_summary(uuid)'::regprocedure
  when 'inv.stock_adjustment' then 'inv.adjustment_summary(uuid)'::regprocedure
  when 'inv.transfer' then 'inv.transfer_summary_of(uuid)'::regprocedure
  when 'hr.leave_request' then 'hr.leave_summary(uuid)'::regprocedure
  when 'hr.shift_swap' then 'hr.swap_summary(uuid)'::regprocedure
  when 'hr.role_change' then 'hr.role_change_summary(uuid)'::regprocedure
end;

-- The summary of a request's subject, from its type's summarizer.
create function wf.subject_summary(p_request uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_req wf.request;
  v_fn regprocedure;
  v_out jsonb;
begin
  select * into v_req from wf.request where id = p_request;
  select summarizer into v_fn from core.subject_resolver where subject_type = v_req.subject_type;
  if v_fn is null then
    return jsonb_build_object('label', v_req.process_type);
  end if;
  execute format('select %s($1)', v_fn::oid::regproc) into v_out using v_req.subject_id;
  return v_out;
end $$;
revoke execute on function wf.subject_summary(uuid) from public;

do $$
declare
  v_src text := pg_get_functiondef('wf.act(uuid, text, text)'::regprocedure);
  v_old text := 'acted_at = now(), actor_id = v_me.id, comment = p_comment';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'wf.act changed; update this migration';
  end if;
  execute replace(v_src, v_old,
    v_old || ', decision_summary = wf.subject_summary(v_req.id)');
end $$;

-- Requests whose pending step the caller may act on (once per query in RLS).
create function wf.my_actionable_requests() returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core, wf
as $$
  select coalesce(array_agg(distinct s.request_id), '{}')
    from wf.step_instance s
    join wf.request r on r.id = s.request_id and r.state = 'in_approval'
   where s.state = 'pending' and r.tenant_id = core.my_tenant()
     and wf.can_act_on_step(core.current_user_id(), s, r.process_type);
$$;

-- What a request is about: while the caller may act on its pending step, the live summary;
-- afterwards, the summary kept on the step they acted on. Nothing for anyone else.
create function wf.request_summary(p_request uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_out jsonb;
begin
  if p_request = any (wf.my_actionable_requests()) then
    return wf.subject_summary(p_request) || jsonb_build_object('decided', false);
  end if;
  select s.decision_summary || jsonb_build_object('decided', true, 'decision', s.state,
                                                  'acted_at', s.acted_at)
    into v_out
    from wf.step_instance s join wf.request r on r.id = s.request_id
   where s.request_id = p_request and s.actor_id = v_me.id and r.tenant_id = v_me.tenant_id
     and s.decision_summary is not null
   order by s.acted_at desc limit 1;
  if v_out is null then
    perform wf.fail('NOT_AUTHORISED', 'not an approver of this request');
  end if;
  return v_out;
end $$;

-- The caller's own decisions, newest first, with what they decided on.
create function wf.my_decisions(p_limit int default 50)
returns table (request_id uuid, process_type text, step text, decision text,
               acted_at timestamptz, summary jsonb)
language sql stable security definer
set search_path = pg_catalog, core, wf
as $$
  select s.request_id, r.process_type, s.step, s.state, s.acted_at, s.decision_summary
    from wf.step_instance s join wf.request r on r.id = s.request_id
   where s.actor_id = core.current_user_id() and r.tenant_id = core.my_tenant()
     and s.state in ('approved', 'rejected')
   order by s.acted_at desc
   limit least(greatest(p_limit, 1), 200);
$$;

revoke execute on function wf.my_actionable_requests(), wf.request_summary(uuid),
  wf.my_decisions(int) from public;
grant execute on function wf.my_actionable_requests() to app_rw, wf_executor;
grant execute on function wf.request_summary(uuid), wf.my_decisions(int) to app_rw;

-- Generated view policies on subject tables (those with wf_request_id) add the pending
-- leg; regenerate them.
do $$
declare
  v_src text := pg_get_functiondef('core.apply_domain_rls(regclass)'::regprocedure);
  v_old text := 'execute format(''create policy dom_select on %s for select to app_rw using (%s)'', p_table, v_view_expr);';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'core.apply_domain_rls changed; update this migration';
  end if;
  execute replace(v_src, v_old,
    'if v_has_wf then
    -- pending-inbox visibility (ADR 009): whoever may act on the pending step reads the row
    v_view_expr := ''('' || v_view_expr || '') or wf_request_id = any ((select wf.my_actionable_requests())::uuid[])'';
  end if;
  ' || v_old);
end $$;

do $$
declare t regclass;
begin
  for t in select table_name from core.domain_table
            where core.has_column(table_name, 'wf_request_id') loop
    perform core.apply_domain_rls(t);
  end loop;
end $$;

-- The swap step is now the manager (department head) step.
do $$
declare
  v_src text := pg_get_functiondef('hr.approve_swap(uuid, text)'::regprocedure);
begin
  if position('''outlet_approval''' in v_src) = 0 then
    raise exception 'hr.approve_swap changed; update this migration';
  end if;
  execute replace(v_src, '''outlet_approval''', '''manager_approval''');
end $$;

-- migrate:down
do $$
begin
  execute replace(pg_get_functiondef('hr.approve_swap(uuid, text)'::regprocedure),
                  '''manager_approval''', '''outlet_approval''');
  execute replace(pg_get_functiondef('core.apply_domain_rls(regclass)'::regprocedure),
    'if v_has_wf then
    -- pending-inbox visibility (ADR 009): whoever may act on the pending step reads the row
    v_view_expr := ''('' || v_view_expr || '') or wf_request_id = any ((select wf.my_actionable_requests())::uuid[])'';
  end if;
  ', '');
end $$;
do $$
declare t regclass;
begin
  for t in select table_name from core.domain_table
            where core.has_column(table_name, 'wf_request_id') loop
    perform core.apply_domain_rls(t);
  end loop;
end $$;
drop function wf.my_decisions(int);
drop function wf.request_summary(uuid);
drop function wf.my_actionable_requests();
do $$
begin
  execute replace(pg_get_functiondef('wf.act(uuid, text, text)'::regprocedure),
    ', decision_summary = wf.subject_summary(v_req.id)', '');
end $$;
drop function wf.subject_summary(uuid);
drop function hr.role_change_summary(uuid);
drop function hr.swap_summary(uuid);
drop function hr.leave_summary(uuid);
drop function inv.transfer_summary_of(uuid);
drop function inv.adjustment_summary(uuid);
drop function inv.po_summary(uuid);
alter table wf.step_instance drop column decision_summary;
alter table core.subject_resolver drop column summarizer;
drop function wf.approval_coverage(uuid);
create or replace function wf.overdue_steps(p_at timestamptz default now())
returns table (step_id uuid, request_id uuid, process_type text, step text,
               overdue_since timestamptz, target_group_id uuid, target_node_id uuid)
language sql stable security definer
set search_path = pg_catalog, core, wf, extensions
as $$
  select s.id, r.id, r.process_type, s.step,
         s.activated_at + make_interval(hours => d.sla_hours),
         coalesce(s.escalate_to_group_id, s.assignee_group_id),
         case when s.escalate_to_group_id is not null
              then core.nearest_group_node(s.escalate_to_group_id, s.scope_node_id, wf.non_approvers(r))
              else core.nearest_group_node(s.assignee_group_id, s.scope_node_id, wf.non_approvers(r), true)
         end
    from wf.step_instance s
    join wf.request r on r.id = s.request_id and r.state = 'in_approval'
    join wf.process_def d on d.tenant_id = r.tenant_id and d.process_type = r.process_type
   where s.state = 'pending'
     and s.activated_at + make_interval(hours => d.sla_hours) < p_at;
$$;
drop function wf.escalation_target(wf.step_instance, wf.request);
do $$
declare
  v_src text := pg_get_functiondef('wf.submit(text, text, uuid, jsonb, text)'::regprocedure);
begin
  v_src := replace(v_src, 'wf.when_matches(v_step -> ''when'', v_req.amount, v_req.tenant_id)',
                   'wf.when_matches(v_step -> ''when'', v_req.amount)');
  v_src := replace(v_src,
    'from wf.route_step(v_group, v_escalate, v_step ->> ''scope'', v_req, v_step ->> ''step'') r',
    'from wf.route_step(v_group, v_escalate, v_step ->> ''scope'', v_req) r');
  execute v_src;
end $$;
drop function wf.route_step(uuid, uuid, text, wf.request, text);
create function wf.route_step(p_group uuid, p_escalate uuid, p_scope text, p_request wf.request,
                              out o_group uuid, out o_node uuid)
language plpgsql stable
set search_path = pg_catalog, core, wf
as $$
declare
  v_start uuid;
  v_subject uuid := case (select hierarchy_type from wf.process_def
                           where tenant_id = p_request.tenant_id
                             and process_type = p_request.process_type)
                      when 'org' then p_request.org_node_id else p_request.delivery_node_id end;
  v_exclude uuid[] := wf.non_approvers(p_request);
begin
  v_start := case p_scope
    when 'subject_node' then v_subject
    when 'nearest_ancestor' then v_subject
    when 'from_node' then (p_request.payload ->> 'from_node_id')::uuid
    when 'to_node' then (p_request.payload ->> 'to_node_id')::uuid
  end;
  if v_start is null then
    raise exception 'INVALID_PROCESS_DEF' using detail = format('cannot resolve scope %s', p_scope);
  end if;
  if p_scope = 'nearest_ancestor' then
    o_node := core.nearest_group_node(p_group, v_start, v_exclude);
  elsif exists (select 1 from core.group_holders(p_group, v_start) h(uid)
                 where h.uid <> all (v_exclude)) then
    o_node := v_start;
  end if;
  if o_node is not null then
    o_group := p_group;
    return;
  end if;
  if p_escalate is not null then
    o_node := core.nearest_group_node(p_escalate, v_start, v_exclude);
    if o_node is not null then
      o_group := p_escalate;
      return;
    end if;
  end if;
  o_node := core.nearest_group_node(p_group, v_start, v_exclude, true);
  if o_node is not null then
    o_group := p_group;
  end if;
end $$;
drop function wf.route_chain(uuid, text, text, uuid, uuid, text, uuid, uuid[]);
drop function wf.chain_groups(uuid, text, text);
do $$
begin
  execute replace(pg_get_functiondef('core.nearest_group_node(uuid, uuid, uuid[], boolean)'::regprocedure),
    'where nl.delivery_node_id = core.link_anchor(v_start.id)', 'where nl.delivery_node_id = v_start.id');
end $$;
drop function wf.when_matches(jsonb, numeric, uuid);
drop function wf.setting_on(uuid, text);
alter table core.tenant drop column settings;
