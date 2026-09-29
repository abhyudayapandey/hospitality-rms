-- migrate:up
-- Closes the ADR 003 hole: wf.submit no longer trusts caller-supplied nodes or amount.
-- Each subject type registers a resolver that reads the subject row; wf.submit takes the
-- tenant, org/delivery nodes, TRANSFER from/to nodes, amount and currency from it.
--
-- Also adds two per-step options used by TRANSFER (ADR 006):
--   approveVia: 'module'  approve only through the module RPC that performs the step's
--                         business action in the same transaction (wf.module_approval)
--   irreversible: true    once approved, the request can no longer be rejected or cancelled

-- What a resolver returns for one subject row. tenant_id is null when the row is missing.
create type wf.subject_info as (
  tenant_id uuid,
  org_node_id uuid,
  delivery_node_id uuid,
  from_node_id uuid,
  to_node_id uuid,
  amount numeric,
  currency text,
  submittable boolean
);

-- Schema metadata (like core.domain_table): which function resolves which subject type.
-- A resolver is `(p_subject_id uuid) returns wf.subject_info`, owned by the migrator and
-- registered by the module's migration.
create table core.subject_resolver (
  subject_type text primary key,
  resolver regprocedure not null
);
select core.add_standard_columns('core.subject_resolver', false);
select audit.enable('core.subject_resolver');

create function core.subject_resolver_check() returns trigger
language plpgsql as $$
begin
  if (select prorettype from pg_proc where oid = new.resolver) <> 'wf.subject_info'::regtype
     or (select pronargs from pg_proc where oid = new.resolver) <> 1
     or (select proargtypes[0] from pg_proc where oid = new.resolver) <> 'uuid'::regtype then
    raise exception 'INVALID_RESOLVER'
      using detail = format('%s must be (uuid) returns wf.subject_info', new.resolver);
  end if;
  return new;
end $$;
revoke execute on function core.subject_resolver_check() from public;
create trigger subject_resolver_check before insert or update on core.subject_resolver
  for each row execute function core.subject_resolver_check();

-- The step definition for (tenant, process, step name).
create function wf.step_def(p_tenant uuid, p_process text, p_step text) returns jsonb
language sql stable
set search_path = pg_catalog, wf
as $$
  select s from wf.process_def d, jsonb_array_elements(d.steps) s
   where d.tenant_id = p_tenant and d.process_type = p_process and s ->> 'step' = p_step;
$$;
revoke execute on function wf.step_def(uuid, text, text) from public;

drop function wf.submit(text, text, uuid, jsonb, numeric, text, uuid, uuid, text);

-- Starts a workflow request. Checks (ADR 003, ADR 006):
--  * the process exists for the caller's tenant and the subject type matches
--  * the subject row exists in the caller's tenant, is submittable, and has no other
--    active request; nodes, amount and currency come from that row
--  * bp_policy 'initiate' for a group the caller holds at the subject node (SELF = anyone)
--  * humans: core.can(domain, 'modify'); service users: core.can(domain, 'view')
--  * every non-skipped step routes to an eligible approver other than the initiator,
--    falling back to escalateTo / higher holders (wf.route_step), else NO_APPROVER
create function wf.submit(
  p_process_type text,
  p_subject_type text,
  p_subject_id uuid,
  p_payload jsonb default '{}',
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, wf, extensions
as $$
declare
  v_me core.app_user := wf.me();
  v_def wf.process_def;
  v_req wf.request;
  v_resolver regprocedure;
  v_info wf.subject_info;
  v_payload jsonb;
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

  select resolver into v_resolver from core.subject_resolver where subject_type = p_subject_type;
  if not found then
    perform wf.fail('INVALID_SUBJECT', format('no resolver for %s', p_subject_type));
  end if;
  -- One active request per subject: serialise concurrent submits of the same subject.
  perform pg_advisory_xact_lock(hashtextextended(p_subject_type || ':' || p_subject_id, 0));
  execute format('select * from %s($1)', v_resolver::oid::regproc) into v_info using p_subject_id;
  if v_info.tenant_id is distinct from v_me.tenant_id then
    perform wf.fail('INVALID_SUBJECT', 'subject not found');
  end if;
  if not coalesce(v_info.submittable, false) then
    perform wf.fail('INVALID_SUBJECT', 'subject is not in a submittable state');
  end if;
  if exists (select 1 from wf.request
              where tenant_id = v_me.tenant_id and subject_type = p_subject_type
                and subject_id = p_subject_id
                and state in ('in_approval', 'approved', 'executing')) then
    perform wf.fail('INVALID_STATE', 'subject already has an active request');
  end if;

  v_subject_node := case v_def.hierarchy_type
    when 'org' then v_info.org_node_id else v_info.delivery_node_id end;
  if v_subject_node is null then
    perform wf.fail('INVALID_SUBJECT', 'subject has no node');
  end if;

  -- from/to nodes are server-set; callers cannot supply or override them.
  v_payload := coalesce(p_payload, '{}') - 'from_node_id' - 'to_node_id';
  if v_info.from_node_id is not null or v_info.to_node_id is not null then
    v_payload := v_payload || jsonb_build_object('from_node_id', v_info.from_node_id,
                                                 'to_node_id', v_info.to_node_id);
  end if;

  if not wf.has_bp_policy(v_me.id, v_me.tenant_id, p_process_type, '*', 'initiate', v_subject_node)
     or not core.can(v_def.domain_code,
                     case v_me.kind when 'service' then 'view' else 'modify' end,
                     v_info.org_node_id, v_info.delivery_node_id, v_me.id) then
    perform wf.fail('NOT_AUTHORISED', format('cannot initiate %s', p_process_type));
  end if;

  insert into wf.request (tenant_id, process_type, subject_type, subject_id, domain_code,
                          org_node_id, delivery_node_id, initiator_id, state, payload,
                          amount, currency, idempotency_key)
  values (v_me.tenant_id, p_process_type, p_subject_type, p_subject_id, v_def.domain_code,
          v_info.org_node_id, v_info.delivery_node_id, v_me.id, 'in_approval', v_payload,
          v_info.amount, v_info.currency, p_idempotency_key)
  returning * into v_req;
  perform set_config('app.wf_request', v_req.id::text, true);

  for v_step in select * from jsonb_array_elements(v_def.steps) loop
    v_seq := v_seq + 1;
    v_group := wf.group_id(v_me.tenant_id, v_step ->> 'group');
    v_escalate := wf.group_id(v_me.tenant_id, v_step ->> 'escalateTo');
    if v_group is null or (v_step ? 'escalateTo' and v_escalate is null) then
      perform wf.fail('INVALID_PROCESS_DEF', format('unknown group in step %s', v_step ->> 'step'));
    end if;

    if wf.when_matches(v_step -> 'when', v_req.amount) then
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
-- New here: steps with approveVia 'module' can only be approved through
-- wf.act_as_module (called by the module RPC doing the step's business action); after an
-- irreversible step is approved, reject and cancel are refused (IRREVERSIBLE_STEP).
create or replace function wf.act(p_request_id uuid, p_action text, p_comment text default null)
returns text
language plpgsql security definer
set search_path = pg_catalog, core, wf, extensions
as $$
declare
  v_me core.app_user := wf.me();
  v_req wf.request;
  v_step wf.step_instance;
  v_def wf.process_def;
  v_irreversible text;
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

  if p_action in ('reject', 'cancel') then
    select s.step into v_irreversible from wf.step_instance s
     where s.request_id = v_req.id and s.state = 'approved'
       and coalesce((wf.step_def(v_req.tenant_id, v_req.process_type, s.step) ->> 'irreversible')::boolean, false)
     limit 1;
    if v_irreversible is not null then
      perform wf.fail('IRREVERSIBLE_STEP', format('step %s is already approved', v_irreversible));
    end if;
  end if;

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
    if v_def.on_rejected is not null then
      perform wf.enqueue(v_req.id, v_def.on_rejected);
    end if;
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
  if p_action = 'approve'
     and wf.step_def(v_req.tenant_id, v_req.process_type, v_step.step) ->> 'approveVia' = 'module'
     and current_setting('wf.module_approval', true) is distinct from v_req.id::text then
    perform wf.fail('APPROVE_VIA_MODULE', format('step %s is approved from its module screen', v_step.step));
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

-- For module RPCs only (security definer, owned by the migrator; not granted to app_rw):
-- approves p_step of the request as the current user, allowing approveVia 'module'
-- steps. The flag is cleared again so nothing else in the transaction inherits it.
create function wf.act_as_module(p_request_id uuid, p_step text, p_comment text default null)
returns text
language plpgsql security definer
set search_path = pg_catalog, core, wf, extensions
as $$
declare
  v_state text;
begin
  if not exists (select 1 from wf.step_instance
                  where request_id = p_request_id and step = p_step and state = 'pending') then
    perform wf.fail('INVALID_STATE', format('step %s is not pending', p_step));
  end if;
  perform set_config('wf.module_approval', p_request_id::text, true);
  v_state := wf.act(p_request_id, 'approve', p_comment);
  perform set_config('wf.module_approval', '', true);
  return v_state;
end $$;

-- Pending steps the current user can act on (excluding their own requests), now with
-- the subject and nodes so screens can link to the module page, and the step's
-- approveVia so the inbox knows when to link instead of showing Approve.
drop function wf.my_inbox();
create function wf.my_inbox()
returns table (step_id uuid, request_id uuid, process_type text, step text,
               activated_at timestamptz, amount numeric, payload jsonb,
               subject_type text, subject_id uuid, delivery_node_id uuid, org_node_id uuid,
               approve_via text, initiator_name text)
language sql stable security definer
set search_path = pg_catalog, core, wf, extensions
as $$
  select s.id, r.id, r.process_type, s.step, s.activated_at, r.amount, r.payload,
         r.subject_type, r.subject_id, r.delivery_node_id, r.org_node_id,
         wf.step_def(r.tenant_id, r.process_type, s.step) ->> 'approveVia',
         u.display_name
    from wf.step_instance s
    join wf.request r on r.id = s.request_id
    join core.app_user u on u.id = r.initiator_id
   where s.state = 'pending'
     and r.state = 'in_approval'
     and r.tenant_id = (select tenant_id from core.app_user
                         where id = core.current_user_id() and status = 'active')
     and wf.can_act_on_step(core.current_user_id(), s, r.process_type)
   order by s.activated_at;
$$;

revoke execute on all functions in schema wf from public;
grant execute on function wf.submit(text, text, uuid, jsonb, text) to app_rw;
grant execute on function wf.act(uuid, text, text) to app_rw;
grant execute on function wf.my_inbox() to app_rw;
grant execute on function wf.my_processes() to app_rw;
grant execute on function wf.claim_next(timestamptz) to wf_executor;
grant execute on function wf.complete_outbox(uuid) to wf_executor;
grant execute on function wf.record_failure(uuid, text, timestamptz) to wf_executor;
grant execute on function wf.overdue_steps(timestamptz) to wf_executor;
grant execute on function wf.unroutable_steps(timestamptz) to wf_executor;
grant execute on function wf.escalate_overdue(timestamptz) to wf_executor;

-- migrate:down
-- Dev tooling only (forward-only in production, ADR 001): restores the caller-node
-- wf.submit and the previous wf.act and wf.my_inbox.
drop function wf.my_inbox();
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
revoke execute on function wf.my_inbox() from public;
grant execute on function wf.my_inbox() to app_rw;
drop function if exists wf.act_as_module(uuid, text, text);
drop function wf.submit(text, text, uuid, jsonb, text);
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

grant execute on function wf.submit(text, text, uuid, jsonb, numeric, text, uuid, uuid, text) to app_rw;
create or replace function wf.act(p_request_id uuid, p_action text, p_comment text default null)
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

drop function wf.step_def(uuid, text, text);
drop table core.subject_resolver;
drop function core.subject_resolver_check();
drop type wf.subject_info;
