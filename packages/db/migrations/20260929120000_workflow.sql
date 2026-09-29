-- migrate:up
-- Workflow engine (docs/LLD.md section 4, ADR 003).
-- Every status change goes through wf.submit / wf.act (SECURITY DEFINER) and the
-- executor functions. app_rw can only SELECT wf tables (rpc_only registrations).

-- ---------------------------------------------------------------------------
-- Core helpers for approver resolution (group-based, per the LLD). They live next
-- to core.can() so no permission logic moves into TypeScript.
-- ---------------------------------------------------------------------------

-- Active users holding p_group at p_node: an assignment at the node, or at an
-- ancestor in the same tree with include_descendants.
create function core.group_holders(p_group uuid, p_node uuid) returns setof uuid
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  select distinct ra.user_id
    from core.hierarchy_node t
    join core.role_assignment ra on ra.group_id = p_group
    join core.app_user u on u.id = ra.user_id and u.status = 'active'
    join core.hierarchy_node n on n.id = ra.node_id and n.type = t.type and n.archived_at is null
   where t.id = p_node
     and current_date >= ra.effective_from
     and (ra.effective_to is null or current_date <= ra.effective_to)
     and (n.id = t.id or (ra.include_descendants and n.path @> t.path));
$$;
revoke execute on function core.group_holders(uuid, uuid) from public;

-- Nearest node at or above p_start (strictly above when p_strict) in its own tree
-- where someone other than p_exclude holds p_group through an assignment at that node
-- that covers p_start. If none, and p_start is a delivery node, map it to its org node
-- via core.node_link and search the org tree the same way (ADR 003: cross-tree routing).
create function core.nearest_group_node(p_group uuid, p_start uuid, p_exclude uuid,
                                        p_strict boolean default false)
returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, core, extensions
as $$
declare
  v_start core.hierarchy_node;
  v_found uuid;
  v_org uuid;
begin
  select * into v_start from core.hierarchy_node where id = p_start;
  if not found then
    return null;
  end if;

  select a.id into v_found
    from core.hierarchy_node a
   where a.type = v_start.type and a.path @> v_start.path and a.archived_at is null
     and (not p_strict or a.id <> v_start.id)
     and exists (
       select 1 from core.role_assignment ra
         join core.app_user u on u.id = ra.user_id and u.status = 'active'
        where ra.group_id = p_group and ra.node_id = a.id
          and ra.user_id is distinct from p_exclude
          and current_date >= ra.effective_from
          and (ra.effective_to is null or current_date <= ra.effective_to)
          and (a.id = v_start.id or ra.include_descendants))
   order by nlevel(a.path) desc
   limit 1;
  if v_found is not null or v_start.type <> 'delivery' then
    return v_found;
  end if;

  for v_org in select nl.org_node_id from core.node_link nl
                where nl.delivery_node_id = v_start.id order by nl.org_node_id loop
    v_found := core.nearest_group_node(p_group, v_org, p_exclude, p_strict);
    if v_found is not null then
      return v_found;
    end if;
  end loop;
  return null;
end $$;
revoke execute on function core.nearest_group_node(uuid, uuid, uuid, boolean) from public;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Seeded from packages/workflow definitions (pnpm db:seed). One row per tenant.
create table wf.process_def (
  id uuid primary key default core.uuid_v7(),
  process_type text not null,
  subject_type text not null,
  domain_code text not null,
  hierarchy_type text not null check (hierarchy_type in ('org', 'delivery')),
  steps jsonb not null,                 -- [{step, group, scope, when?, escalateTo?}]
  on_approved text not null,
  on_rejected text,
  sla_hours int not null check (sla_hours > 0),
  definition jsonb not null             -- the full code definition, for reference
);
select core.add_standard_columns('wf.process_def');
alter table wf.process_def
  add constraint process_def_type_key unique (tenant_id, process_type),
  add constraint process_def_domain_fk foreign key (tenant_id, domain_code)
    references core.domain (tenant_id, code);

create table wf.request (
  id uuid primary key default core.uuid_v7(),
  process_type text not null,
  subject_type text not null,
  subject_id uuid not null,
  domain_code text not null,            -- always copied from wf.process_def
  org_node_id uuid references core.hierarchy_node(id),
  delivery_node_id uuid references core.hierarchy_node(id),
  initiator_id uuid not null references core.app_user(id),
  state text not null check (state in
    ('in_approval', 'approved', 'executing', 'completed', 'rejected', 'cancelled', 'failed')),
  current_step text,
  payload jsonb not null default '{}',
  amount numeric(14,2),
  currency text,
  idempotency_key text,
  decided_at timestamptz,
  completed_at timestamptz
);
select core.add_standard_columns('wf.request');
alter table wf.request
  add constraint request_domain_fk foreign key (tenant_id, domain_code)
    references core.domain (tenant_id, code),
  add constraint request_idempotency_key unique (tenant_id, initiator_id, idempotency_key),
  add constraint request_process_fk foreign key (tenant_id, process_type)
    references wf.process_def (tenant_id, process_type);
create index request_state on wf.request (state);

create table wf.step_instance (
  id uuid primary key default core.uuid_v7(),
  request_id uuid not null references wf.request(id),
  seq int not null,
  step text not null,
  assignee_group_id uuid not null references core.security_group(id),
  escalate_to_group_id uuid references core.security_group(id),
  scope_node_id uuid references core.hierarchy_node(id),
  state text not null check (state in
    ('waiting', 'pending', 'approved', 'rejected', 'skipped', 'cancelled')),
  activated_at timestamptz,
  acted_at timestamptz,
  actor_id uuid references core.app_user(id),
  comment text,
  escalation_count int not null default 0,
  last_escalated_at timestamptz,
  -- why a step was skipped: its "when" was false, or the person who approved the
  -- previous step is also its approver (covered_by_step_id = that step)
  skip_reason text check (skip_reason in ('condition', 'same_approver')),
  covered_by_step_id uuid references wf.step_instance(id),
  check ((state = 'skipped') = (skip_reason is not null)),
  check ((skip_reason = 'same_approver') = (covered_by_step_id is not null)),
  -- copied from wf.request for RLS
  domain_code text not null,
  org_node_id uuid,
  delivery_node_id uuid,
  initiator_id uuid not null,
  unique (request_id, seq)
);
select core.add_standard_columns('wf.step_instance');
create index step_instance_pending on wf.step_instance (state, activated_at) where state = 'pending';

-- Polled by the executor (wf-execute Lambda; locally packages/workflow scripts/execute.ts).
create table wf.outbox (
  id uuid primary key default core.uuid_v7(),
  request_id uuid not null references wf.request(id),
  handler text not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  processed_at timestamptz,
  -- copied from wf.request for RLS
  domain_code text not null,
  org_node_id uuid,
  delivery_node_id uuid,
  initiator_id uuid not null,
  unique (request_id, handler)
);
select core.add_standard_columns('wf.outbox');
create index outbox_due on wf.outbox (next_attempt_at) where status = 'pending';

-- RLS: generated policies only (rule 1). Reads follow the subject domain; writes only
-- through the RPCs below.
insert into core.domain_table (table_name, domain_code, hierarchy_type, tenant_scoped, rpc_only)
values ('wf.process_def', 'WF_CONFIG', 'org', true, true);
insert into core.domain_table (table_name, domain_column, owner_column, rpc_only) values
  ('wf.request', 'domain_code', 'initiator_id', true),
  ('wf.step_instance', 'domain_code', 'initiator_id', true),
  ('wf.outbox', 'domain_code', 'initiator_id', true);
select core.apply_domain_rls('wf.process_def');
select core.apply_domain_rls('wf.request');
select core.apply_domain_rls('wf.step_instance');
select core.apply_domain_rls('wf.outbox');
select audit.enable('wf.process_def');
select audit.enable('wf.request');
select audit.enable('wf.step_instance');
select audit.enable('wf.outbox');

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

create function wf.fail(p_code text, p_detail text default null) returns void
language plpgsql as $$
begin
  raise exception '%', p_code using detail = coalesce(p_detail, '');
end $$;

-- The active user calling an RPC, or NOT_AUTHORISED.
create function wf.me() returns core.app_user
language plpgsql stable security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_me core.app_user;
begin
  select * into v_me from core.app_user
   where id = core.current_user_id() and status = 'active';
  if not found then
    raise exception 'NOT_AUTHORISED' using detail = 'no active user';
  end if;
  return v_me;
end $$;

create function wf.group_id(p_tenant uuid, p_code text) returns uuid
language sql stable
set search_path = pg_catalog, core
as $$
  select id from core.security_group where tenant_id = p_tenant and code = p_code;
$$;

-- Does p_user hold any group with bp_policy p_action on (process, step) covering p_node?
-- SELF rows match any active human user (self-service processes); service users such
-- as the AI agent only act through groups they are explicitly assigned.
create function wf.has_bp_policy(p_user uuid, p_tenant uuid, p_process text, p_step text,
                                 p_action text, p_node uuid)
returns boolean
language sql stable
set search_path = pg_catalog, core, wf
as $$
  select exists (
    select 1 from core.bp_policy bp
      join core.security_group g on g.id = bp.group_id and g.tenant_id = p_tenant
     where bp.process_type = p_process and bp.step = p_step and bp.action = p_action
       and ((g.code = 'SELF' and exists (select 1 from core.app_user u
                                           where u.id = p_user and u.kind = 'human'))
            or p_user in (select core.group_holders(g.id, p_node))));
$$;

-- Evaluates a step's "when" against the request amount. Unknown keys are an error.
create function wf.when_matches(p_when jsonb, p_amount numeric) returns boolean
language plpgsql immutable as $$
declare
  k text;
begin
  if p_when is null or p_when = '{}'::jsonb then
    return true;
  end if;
  for k in select jsonb_object_keys(p_when) loop
    if k not in ('amount_gt', 'amount_gte') then
      raise exception 'INVALID_PROCESS_DEF' using detail = format('unknown when key %s', k);
    end if;
  end loop;
  return (not p_when ? 'amount_gt' or coalesce(p_amount, 0) > (p_when ->> 'amount_gt')::numeric)
     and (not p_when ? 'amount_gte' or coalesce(p_amount, 0) >= (p_when ->> 'amount_gte')::numeric);
end $$;

-- Routes a step: the group that will act and the scope node (ADR 003).
--  1. the step's group at its scope (subject/from/to node, or nearest_ancestor walk),
--     held by someone other than the initiator
--  2. SoD fallback when only the initiator (or nobody) is eligible there: the step's
--     escalateTo group, walking up from the start node (crossing trees via node_link)
--  3. then the step's own group further up the tree
-- Both outputs are null when nobody exists up the tree (caller raises NO_APPROVER).
create function wf.route_step(p_group uuid, p_escalate uuid, p_scope text,
                              p_request wf.request, out o_group uuid, out o_node uuid)
language plpgsql stable
set search_path = pg_catalog, core, wf
as $$
declare
  v_start uuid;
  v_subject uuid := case (select hierarchy_type from wf.process_def
                           where tenant_id = p_request.tenant_id
                             and process_type = p_request.process_type)
                      when 'org' then p_request.org_node_id else p_request.delivery_node_id end;
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

  -- 1. normal routing
  if p_scope = 'nearest_ancestor' then
    o_node := core.nearest_group_node(p_group, v_start, p_request.initiator_id);
  elsif exists (select 1 from core.group_holders(p_group, v_start) h(uid)
                 where h.uid <> p_request.initiator_id) then
    o_node := v_start;
  end if;
  if o_node is not null then
    o_group := p_group;
    return;
  end if;

  -- 2. escalateTo group, from the start node up
  if p_escalate is not null then
    o_node := core.nearest_group_node(p_escalate, v_start, p_request.initiator_id);
    if o_node is not null then
      o_group := p_escalate;
      return;
    end if;
  end if;

  -- 3. the same group, strictly above the start node
  o_node := core.nearest_group_node(p_group, v_start, p_request.initiator_id, true);
  if o_node is not null then
    o_group := p_group;
  end if;
end $$;

-- Can p_user act on this step? Not the initiator (rule 7), holds the step's group at
-- or above its scope, and bp_policy approve exists for (process, step, group).
create function wf.can_act_on_step(p_user uuid, p_step wf.step_instance, p_process text)
returns boolean
language sql stable
set search_path = pg_catalog, core, wf
as $$
  select p_user <> p_step.initiator_id
     and p_user in (select core.group_holders(p_step.assignee_group_id, p_step.scope_node_id))
     and exists (select 1 from core.bp_policy
                  where process_type = p_process and step = p_step.step
                    and group_id = p_step.assignee_group_id and action = 'approve');
$$;

-- Activates the next waiting step, or finishes approval and queues on_approved.
-- A waiting step whose approver would be the person who just approved the previous
-- step is skipped (skip_reason 'same_approver', covered_by_step_id = that step): one
-- person never approves the same request twice in a row.
create function wf.advance(p_request_id uuid, p_approved_step uuid default null) returns void
language plpgsql
set search_path = pg_catalog, core, wf
as $$
declare
  v_req wf.request;
  v_prev wf.step_instance;
  v_next wf.step_instance;
  v_def wf.process_def;
begin
  select * into v_req from wf.request where id = p_request_id;
  select * into v_prev from wf.step_instance where id = p_approved_step;
  loop
    select * into v_next from wf.step_instance
     where request_id = p_request_id and state = 'waiting' order by seq limit 1;
    exit when not found;
    if v_prev.actor_id is not null
       and wf.can_act_on_step(v_prev.actor_id, v_next, v_req.process_type) then
      update wf.step_instance
         set state = 'skipped', skip_reason = 'same_approver', covered_by_step_id = v_prev.id,
             acted_at = now()
       where id = v_next.id;
      continue;
    end if;
    update wf.step_instance set state = 'pending', activated_at = now() where id = v_next.id;
    update wf.request set current_step = v_next.step where id = p_request_id;
    return;
  end loop;
  select * into v_def from wf.process_def
   where tenant_id = v_req.tenant_id and process_type = v_req.process_type;
  update wf.request set state = 'approved', current_step = null, decided_at = now()
   where id = p_request_id;
  perform wf.enqueue(p_request_id, v_def.on_approved);
end $$;

create function wf.enqueue(p_request_id uuid, p_handler text) returns void
language sql
set search_path = pg_catalog, core, wf
as $$
  insert into wf.outbox (tenant_id, request_id, handler, domain_code, org_node_id,
                         delivery_node_id, initiator_id)
  select tenant_id, id, p_handler, domain_code, org_node_id, delivery_node_id, initiator_id
    from wf.request where id = p_request_id
  on conflict (request_id, handler) do nothing;
$$;

revoke execute on all functions in schema wf from public;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Starts a workflow request. Checks (ADR 003):
--  * the process exists for the caller's tenant and the subject type matches
--  * bp_policy 'initiate' for a group the caller holds at the subject node (SELF = anyone)
--  * humans: core.can(domain, 'modify'); service users: core.can(domain, 'view')
--  * every non-skipped step routes to an eligible approver other than the initiator,
--    falling back to escalateTo / higher holders (wf.route_step), else NO_APPROVER
-- Known hole: nodes are caller-supplied until subject tables exist (ADR 003).
create function wf.submit(
  p_process_type text,
  p_subject_type text,
  p_subject_id uuid,
  p_payload jsonb default '{}',
  p_amount numeric default null,
  p_currency text default null,
  p_org_node_id uuid default null,
  p_delivery_node_id uuid default null,
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, wf, extensions
as $$
declare
  v_me core.app_user := wf.me();
  v_def wf.process_def;
  v_req wf.request;
  v_subject_node uuid;
  v_step jsonb;
  v_seq int := 0;
  v_group uuid;
  v_escalate uuid;
  v_scope uuid;
  v_routed_group uuid;
  v_state text;
  v_skip text;
  v_first boolean := true;
begin
  if p_idempotency_key is not null then
    select * into v_req from wf.request
     where tenant_id = v_me.tenant_id and initiator_id = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then
      return v_req.id;
    end if;
  end if;

  select * into v_def from wf.process_def
   where tenant_id = v_me.tenant_id and process_type = p_process_type;
  if not found then
    perform wf.fail('UNKNOWN_PROCESS', p_process_type);
  end if;
  if v_def.subject_type <> p_subject_type then
    perform wf.fail('INVALID_SUBJECT', format('%s expects %s', p_process_type, v_def.subject_type));
  end if;

  v_subject_node := case v_def.hierarchy_type when 'org' then p_org_node_id else p_delivery_node_id end;
  if v_subject_node is null then
    perform wf.fail('INVALID_SUBJECT', 'missing subject node');
  end if;

  if not wf.has_bp_policy(v_me.id, v_me.tenant_id, p_process_type, '*', 'initiate', v_subject_node)
     or not core.can(v_def.domain_code,
                     case v_me.kind when 'service' then 'view' else 'modify' end,
                     p_org_node_id, p_delivery_node_id, v_me.id) then
    perform wf.fail('NOT_AUTHORISED', format('cannot initiate %s', p_process_type));
  end if;

  insert into wf.request (tenant_id, process_type, subject_type, subject_id, domain_code,
                          org_node_id, delivery_node_id, initiator_id, state, payload,
                          amount, currency, idempotency_key)
  values (v_me.tenant_id, p_process_type, p_subject_type, p_subject_id, v_def.domain_code,
          p_org_node_id, p_delivery_node_id, v_me.id, 'in_approval', coalesce(p_payload, '{}'),
          p_amount, p_currency, p_idempotency_key)
  returning * into v_req;
  perform set_config('app.wf_request', v_req.id::text, true);

  for v_step in select * from jsonb_array_elements(v_def.steps) loop
    v_seq := v_seq + 1;
    v_group := wf.group_id(v_me.tenant_id, v_step ->> 'group');
    v_escalate := wf.group_id(v_me.tenant_id, v_step ->> 'escalateTo');
    if v_group is null or (v_step ? 'escalateTo' and v_escalate is null) then
      perform wf.fail('INVALID_PROCESS_DEF', format('unknown group in step %s', v_step ->> 'step'));
    end if;

    if wf.when_matches(v_step -> 'when', p_amount) then
      select r.o_group, r.o_node into v_routed_group, v_scope
        from wf.route_step(v_group, v_escalate, v_step ->> 'scope', v_req) r;
      if v_scope is null then
        perform wf.fail('NO_APPROVER', format('step %s has no eligible approver', v_step ->> 'step'));
      end if;
      if v_routed_group <> v_group then
        -- routed to the escalateTo group (SoD fallback): it is used up
        v_group := v_routed_group;
        v_escalate := null;
      end if;
      v_state := case when v_first then 'pending' else 'waiting' end;
      v_first := false;
    else
      v_scope := null;
      v_state := 'skipped';
    end if;
    v_skip := case when v_state = 'skipped' then 'condition' end;

    insert into wf.step_instance (tenant_id, request_id, seq, step, assignee_group_id,
                                  escalate_to_group_id, scope_node_id, state, skip_reason,
                                  activated_at, domain_code, org_node_id, delivery_node_id,
                                  initiator_id)
    values (v_me.tenant_id, v_req.id, v_seq, v_step ->> 'step', v_group, v_escalate, v_scope,
            v_state, v_skip, case when v_state = 'pending' then now() end,
            v_req.domain_code, v_req.org_node_id, v_req.delivery_node_id, v_req.initiator_id);
    if v_state = 'pending' then
      update wf.request set current_step = v_step ->> 'step' where id = v_req.id;
    end if;
  end loop;

  if v_first then
    -- every step skipped: approved straight away
    perform wf.advance(v_req.id);
  end if;
  return v_req.id;
end $$;

-- Approve, reject or cancel. Returns the request's new state.
create function wf.act(p_request_id uuid, p_action text, p_comment text default null)
returns text
language plpgsql security definer
set search_path = pg_catalog, core, wf, extensions
as $$
declare
  v_me core.app_user := wf.me();
  v_req wf.request;
  v_step wf.step_instance;
  v_def wf.process_def;
begin
  if p_action not in ('approve', 'reject', 'cancel') then
    perform wf.fail('INVALID_ACTION', p_action);
  end if;

  select * into v_req from wf.request
   where id = p_request_id and tenant_id = v_me.tenant_id for update;
  if not found then
    perform wf.fail('REQUEST_NOT_FOUND', p_request_id::text);
  end if;
  if v_req.state <> 'in_approval' then
    perform wf.fail('INVALID_STATE', v_req.state);
  end if;
  perform set_config('app.wf_request', v_req.id::text, true);
  select * into v_def from wf.process_def
   where tenant_id = v_req.tenant_id and process_type = v_req.process_type;

  if p_action = 'cancel' then
    if v_me.id <> v_req.initiator_id
       and not wf.has_bp_policy(v_me.id, v_me.tenant_id, v_req.process_type, '*', 'cancel',
             case v_def.hierarchy_type when 'org' then v_req.org_node_id else v_req.delivery_node_id end) then
      perform wf.fail('NOT_AUTHORISED', 'cannot cancel');
    end if;
    update wf.step_instance set state = 'cancelled'
     where request_id = v_req.id and state in ('waiting', 'pending');
    update wf.request set state = 'cancelled', current_step = null, decided_at = now()
     where id = v_req.id;
    return 'cancelled';
  end if;

  select * into v_step from wf.step_instance
   where request_id = v_req.id and state = 'pending' order by seq limit 1 for update;
  if not found then
    perform wf.fail('INVALID_STATE', 'no pending step');
  end if;

  -- Rule 7: the initiator can never approve (or reject) their own request.
  if v_me.id = v_req.initiator_id then
    perform wf.fail('SEGREGATION_OF_DUTIES', 'initiator cannot act on own request');
  end if;
  if not wf.can_act_on_step(v_me.id, v_step, v_req.process_type) then
    perform wf.fail('NOT_AUTHORISED', format('not an approver for step %s', v_step.step));
  end if;

  update wf.step_instance
     set state = case p_action when 'approve' then 'approved' else 'rejected' end,
         acted_at = now(), actor_id = v_me.id, comment = p_comment
   where id = v_step.id;

  if p_action = 'reject' then
    update wf.step_instance set state = 'cancelled'
     where request_id = v_req.id and state = 'waiting';
    update wf.request set state = 'rejected', current_step = null, decided_at = now()
     where id = v_req.id;
    if v_def.on_rejected is not null then
      perform wf.enqueue(v_req.id, v_def.on_rejected);
    end if;
    return 'rejected';
  end if;

  perform wf.advance(v_req.id, v_step.id);
  return (select state from wf.request where id = v_req.id);
end $$;

-- Pending steps the current user can act on. Excludes requests they initiated.
create function wf.my_inbox()
returns table (step_id uuid, request_id uuid, process_type text, step text,
               activated_at timestamptz, amount numeric, payload jsonb)
language sql stable security definer
set search_path = pg_catalog, core, wf, extensions
as $$
  select s.id, r.id, r.process_type, s.step, s.activated_at, r.amount, r.payload
    from wf.step_instance s
    join wf.request r on r.id = s.request_id
   where s.state = 'pending'
     and r.state = 'in_approval'
     and r.tenant_id = (select tenant_id from core.app_user
                         where id = core.current_user_id() and status = 'active')
     and wf.can_act_on_step(core.current_user_id(), s, r.process_type)
   order by s.activated_at;
$$;

-- ---------------------------------------------------------------------------
-- Escalation (run hourly by the scheduler as wf_executor)
-- ---------------------------------------------------------------------------

-- Pending steps past their SLA and where they would escalate to (same search as the
-- SoD fallback in wf.route_step): the step's escalateTo group from the current scope
-- up (first escalation only), else the same group strictly above the current scope.
-- Both cross trees via node_link. target_node_id is null when nobody holds it.
create function wf.overdue_steps(p_at timestamptz default now())
returns table (step_id uuid, request_id uuid, process_type text, step text,
               overdue_since timestamptz, target_group_id uuid, target_node_id uuid)
language sql stable security definer
set search_path = pg_catalog, core, wf, extensions
as $$
  select s.id, r.id, r.process_type, s.step,
         s.activated_at + make_interval(hours => d.sla_hours),
         coalesce(s.escalate_to_group_id, s.assignee_group_id),
         case when s.escalate_to_group_id is not null
              then core.nearest_group_node(s.escalate_to_group_id, s.scope_node_id, r.initiator_id)
              else core.nearest_group_node(s.assignee_group_id, s.scope_node_id, r.initiator_id, true)
         end
    from wf.step_instance s
    join wf.request r on r.id = s.request_id and r.state = 'in_approval'
    join wf.process_def d on d.tenant_id = r.tenant_id and d.process_type = r.process_type
   where s.state = 'pending'
     and s.activated_at + make_interval(hours => d.sla_hours) < p_at;
$$;

-- Overdue steps with no one to escalate to. They stay pending with their current
-- approvers; this list is for the admin/health dashboard.
create function wf.unroutable_steps(p_at timestamptz default now())
returns table (step_id uuid, request_id uuid, process_type text, step text,
               overdue_since timestamptz)
language sql stable security definer
set search_path = pg_catalog, core, wf, extensions
as $$
  select step_id, request_id, process_type, step, overdue_since
    from wf.overdue_steps(p_at) where target_node_id is null;
$$;

-- Moves each routable overdue step to its target and restarts its SLA clock.
-- Returns the number of steps escalated.
create function wf.escalate_overdue(p_at timestamptz default now()) returns int
language plpgsql security definer
set search_path = pg_catalog, core, wf, extensions
as $$
declare
  v_row record;
  v_count int := 0;
begin
  for v_row in select * from wf.overdue_steps(p_at) where target_node_id is not null loop
    perform set_config('app.wf_request', v_row.request_id::text, true);
    update wf.step_instance
       set assignee_group_id = v_row.target_group_id,
           scope_node_id = v_row.target_node_id,
           escalate_to_group_id = null,
           escalation_count = escalation_count + 1,
           last_escalated_at = p_at,
           activated_at = p_at
     where id = v_row.step_id and state = 'pending';
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Executor (packages/workflow executor.ts, as wf_executor)
-- ---------------------------------------------------------------------------

-- Claims the next due outbox row, locked until the caller's transaction ends
-- (FOR UPDATE SKIP LOCKED, so concurrent executors never take the same row).
create function wf.claim_next(p_at timestamptz default now())
returns table (outbox_id uuid, request_id uuid, handler text, attempts int,
               process_type text, subject_type text, subject_id uuid, payload jsonb,
               amount numeric, currency text, org_node_id uuid, delivery_node_id uuid,
               initiator_id uuid, tenant_id uuid)
language plpgsql security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_ob wf.outbox;
begin
  select * into v_ob from wf.outbox o
   where o.status = 'pending' and o.next_attempt_at <= p_at
   order by o.next_attempt_at, o.id
   for update skip locked
   limit 1;
  if not found then
    return;
  end if;
  perform set_config('app.wf_request', v_ob.request_id::text, true);
  update wf.request r set state = 'executing'
   where r.id = v_ob.request_id and r.state = 'approved';
  return query
    select v_ob.id, r.id, v_ob.handler, v_ob.attempts, r.process_type, r.subject_type,
           r.subject_id, r.payload, r.amount, r.currency, r.org_node_id,
           r.delivery_node_id, r.initiator_id, r.tenant_id
      from wf.request r where r.id = v_ob.request_id;
end $$;

-- Marks a claimed row done; an approval handler completes its request.
create function wf.complete_outbox(p_outbox_id uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_ob wf.outbox;
begin
  update wf.outbox set status = 'done', processed_at = now(), attempts = attempts + 1
   where id = p_outbox_id and status = 'pending'
  returning * into v_ob;
  if not found then
    raise exception 'INVALID_STATE' using detail = 'outbox row is not pending';
  end if;
  update wf.request set state = 'completed', completed_at = now()
   where id = v_ob.request_id and state = 'executing';
end $$;

-- Records a failed attempt. Retries with backoff (30 s, 2 min); the third failure
-- marks the row and an executing request failed.
create function wf.record_failure(p_outbox_id uuid, p_error text, p_at timestamptz default now())
returns text
language plpgsql security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_ob wf.outbox;
begin
  update wf.outbox
     set attempts = attempts + 1,
         last_error = left(p_error, 2000),
         status = case when attempts + 1 >= 3 then 'failed' else 'pending' end,
         next_attempt_at = p_at + make_interval(secs => 30 * power(4, attempts))
   where id = p_outbox_id and status = 'pending'
  returning * into v_ob;
  if not found then
    raise exception 'INVALID_STATE' using detail = 'outbox row is not pending';
  end if;
  update wf.request
     set state = case when v_ob.status = 'failed' then 'failed' else 'approved' end
   where id = v_ob.request_id and state = 'executing';
  return v_ob.status;
end $$;

-- Syncs one code definition (packages/workflow) into every tenant that has its domain.
create function wf.upsert_process_def(p_def jsonb) returns void
language plpgsql
set search_path = pg_catalog, core, wf
as $$
begin
  insert into wf.process_def (tenant_id, process_type, subject_type, domain_code,
                              hierarchy_type, steps, on_approved, on_rejected, sla_hours,
                              definition)
  select d.tenant_id, p_def ->> 'type', p_def ->> 'subject', p_def ->> 'domain',
         p_def ->> 'hierarchy', p_def -> 'steps', p_def ->> 'onApproved',
         p_def ->> 'onRejected', (p_def ->> 'slaHours')::int, p_def
    from core.domain d
   where d.code = p_def ->> 'domain'
  on conflict (tenant_id, process_type) do update
     set subject_type = excluded.subject_type, domain_code = excluded.domain_code,
         hierarchy_type = excluded.hierarchy_type, steps = excluded.steps,
         on_approved = excluded.on_approved, on_rejected = excluded.on_rejected,
         sla_hours = excluded.sla_hours, definition = excluded.definition
   where wf.process_def.definition is distinct from excluded.definition;
end $$;

revoke execute on all functions in schema wf from public;
grant execute on function wf.submit(text, text, uuid, jsonb, numeric, text, uuid, uuid, text) to app_rw;
grant execute on function wf.act(uuid, text, text) to app_rw;
grant execute on function wf.my_inbox() to app_rw;
grant execute on function wf.claim_next(timestamptz) to wf_executor;
grant execute on function wf.complete_outbox(uuid) to wf_executor;
grant execute on function wf.record_failure(uuid, text, timestamptz) to wf_executor;
grant execute on function wf.overdue_steps(timestamptz) to wf_executor;
grant execute on function wf.unroutable_steps(timestamptz) to wf_executor;
grant execute on function wf.escalate_overdue(timestamptz) to wf_executor;
grant usage on schema wf to app_rw, wf_executor;

-- migrate:down
drop function wf.upsert_process_def(jsonb);
drop function wf.record_failure(uuid, text, timestamptz);
drop function wf.complete_outbox(uuid);
drop function wf.claim_next(timestamptz);
drop function wf.escalate_overdue(timestamptz);
drop function wf.unroutable_steps(timestamptz);
drop function wf.overdue_steps(timestamptz);
drop function wf.my_inbox();
drop function wf.act(uuid, text, text);
drop function wf.submit(text, text, uuid, jsonb, numeric, text, uuid, uuid, text);
drop function wf.enqueue(uuid, text);
drop function wf.advance(uuid, uuid);
drop function wf.can_act_on_step(uuid, wf.step_instance, text);
drop function wf.route_step(uuid, uuid, text, wf.request);
drop function wf.when_matches(jsonb, numeric);
drop function wf.has_bp_policy(uuid, uuid, text, text, text, uuid);
drop function wf.group_id(uuid, text);
drop function wf.me();
drop function wf.fail(text, text);
delete from core.domain_table
 where table_name in ('wf.process_def'::regclass, 'wf.request'::regclass,
                      'wf.step_instance'::regclass, 'wf.outbox'::regclass);
drop table wf.outbox;
drop table wf.step_instance;
drop table wf.request;
drop table wf.process_def;
drop function core.nearest_group_node(uuid, uuid, uuid, boolean);
drop function core.group_holders(uuid, uuid);
