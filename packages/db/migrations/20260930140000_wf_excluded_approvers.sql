-- migrate:up
-- Workflow engine changes for the workforce module (ADR 008).
--
-- 1. Excluded approvers. Besides the initiator (rule 7), a subject can name more people
--    who must not approve its request: both parties of a shift swap, the person whose
--    role a ROLE_CHANGE edits. A subject type registers an optional excluded_resolver
--    `(uuid) returns uuid[]`; wf.submit stores the list on wf.request, and routing,
--    escalation and wf.can_act_on_step skip those users exactly like the initiator
--    (normal routing, then escalateTo, then the same group higher up the tree).
-- 2. Business-rule failures are final. The executor passes p_final to
--    wf.record_failure for business-rule codes: no retries, the request ends failed and
--    wf.request.failure_code records the code.
-- 3. core.can_any also counts SELF policies, so self-service users can read the
--    catalogues they need to file a request (leave types).
-- 4. The owner-only RLS leg checks owner = current user before calling core.can(),
--    so other people's rows are rejected without a function call.

-- ---------------------------------------------------------------------------
-- 1. Excluded approvers
-- ---------------------------------------------------------------------------

alter table core.subject_resolver add column excluded_resolver regprocedure;

create or replace function core.subject_resolver_check() returns trigger
language plpgsql as $$
begin
  if (select prorettype from pg_proc where oid = new.resolver) <> 'wf.subject_info'::regtype
     or (select pronargs from pg_proc where oid = new.resolver) <> 1
     or (select proargtypes[0] from pg_proc where oid = new.resolver) <> 'uuid'::regtype then
    raise exception 'INVALID_RESOLVER'
      using detail = format('%s must be (uuid) returns wf.subject_info', new.resolver);
  end if;
  if new.excluded_resolver is not null
     and ((select prorettype from pg_proc where oid = new.excluded_resolver) <> 'uuid[]'::regtype
          or (select pronargs from pg_proc where oid = new.excluded_resolver) <> 1
          or (select proargtypes[0] from pg_proc where oid = new.excluded_resolver) <> 'uuid'::regtype) then
    raise exception 'INVALID_RESOLVER'
      using detail = format('%s must be (uuid) returns uuid[]', new.excluded_resolver);
  end if;
  return new;
end $$;

alter table wf.request
  add column excluded_approvers uuid[] not null default '{}',
  add column failure_code text;

-- The array form of core.nearest_group_node: skips every user in p_exclude.
create function core.nearest_group_node(p_group uuid, p_start uuid, p_exclude uuid[],
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
          and ra.user_id <> all (coalesce(p_exclude, '{}'))
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
revoke execute on function core.nearest_group_node(uuid, uuid, uuid[], boolean) from public;

-- The single-user form keeps its signature and delegates.
create or replace function core.nearest_group_node(p_group uuid, p_start uuid, p_exclude uuid,
                                                   p_strict boolean default false)
returns uuid
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  select core.nearest_group_node(p_group, p_start, array_remove(array[p_exclude], null), p_strict);
$$;

-- Everyone who must not act on a request: the initiator plus the subject's exclusions.
create function wf.non_approvers(p_request wf.request) returns uuid[]
language sql immutable as $$
  select array[p_request.initiator_id] || coalesce(p_request.excluded_approvers, '{}');
$$;
revoke execute on function wf.non_approvers(wf.request) from public;

create or replace function wf.route_step(p_group uuid, p_escalate uuid, p_scope text,
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

  -- 1. normal routing
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

  -- 2. escalateTo group, from the start node up
  if p_escalate is not null then
    o_node := core.nearest_group_node(p_escalate, v_start, v_exclude);
    if o_node is not null then
      o_group := p_escalate;
      return;
    end if;
  end if;

  -- 3. the same group, strictly above the start node
  o_node := core.nearest_group_node(p_group, v_start, v_exclude, true);
  if o_node is not null then
    o_group := p_group;
  end if;
end $$;

create or replace function wf.can_act_on_step(p_user uuid, p_step wf.step_instance, p_process text)
returns boolean
language sql stable
set search_path = pg_catalog, core, wf
as $$
  select p_user <> p_step.initiator_id
     and p_user <> all (coalesce((select r.excluded_approvers from wf.request r
                                   where r.id = p_step.request_id), '{}'))
     and p_user in (select core.group_holders(p_step.assignee_group_id, p_step.scope_node_id))
     and exists (select 1 from core.bp_policy
                  where process_type = p_process and step = p_step.step
                    and group_id = p_step.assignee_group_id and action = 'approve');
$$;

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

-- wf.submit as in 20260930100000, plus the subject's excluded approvers.
create or replace function wf.submit(
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
  v_excluder regprocedure;
  v_excluded uuid[];
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

  select resolver, excluded_resolver into v_resolver, v_excluder
    from core.subject_resolver where subject_type = p_subject_type;
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
  if v_excluder is not null then
    execute format('select %s($1)', v_excluder::oid::regproc) into v_excluded using p_subject_id;
  end if;
  v_excluded := coalesce(array(select distinct x from unnest(v_excluded) x
                                where x is not null and x <> v_me.id order by x), '{}');

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
                          amount, currency, idempotency_key, excluded_approvers)
  values (v_me.tenant_id, p_process_type, p_subject_type, p_subject_id, v_def.domain_code,
          v_info.org_node_id, v_info.delivery_node_id, v_me.id, 'in_approval', v_payload,
          v_info.amount, v_info.currency, p_idempotency_key, v_excluded)
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

-- ---------------------------------------------------------------------------
-- 2. Final (non-retryable) failures
-- ---------------------------------------------------------------------------

drop function wf.record_failure(uuid, text, timestamptz);
-- p_final: a business-rule failure (the executor decides by error code). The row fails
-- at once and the request records the code; otherwise retried up to 3 attempts.
create function wf.record_failure(p_outbox_id uuid, p_error text, p_at timestamptz default now(),
                                  p_final boolean default false)
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
         status = case when p_final or attempts + 1 >= 3 then 'failed' else 'pending' end,
         next_attempt_at = p_at + make_interval(secs => 30 * power(4, attempts))
   where id = p_outbox_id and status = 'pending'
  returning * into v_ob;
  if not found then
    raise exception 'INVALID_STATE' using detail = 'outbox row is not pending';
  end if;
  update wf.request
     set state = case when v_ob.status = 'failed' then 'failed' else 'approved' end,
         failure_code = case when v_ob.status = 'failed'
                             then coalesce(substring(p_error from '^([A-Z][A-Z0-9_]+)'), 'HANDLER_ERROR')
                        end
   where id = v_ob.request_id and state = 'executing';
  return v_ob.status;
end $$;
revoke execute on function wf.record_failure(uuid, text, timestamptz, boolean) from public;
grant execute on function wf.record_failure(uuid, text, timestamptz, boolean) to wf_executor;

-- ---------------------------------------------------------------------------
-- 3. Catalogues readable through SELF
-- ---------------------------------------------------------------------------

create or replace function core.can_any(p_domain text, p_access text) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select p_access in ('view', 'modify') and (
    exists (
      select 1 from core.effective_access ea
       where ea.user_id = core.current_user_id()
         and ((ea.domain = p_domain and (ea.access = 'modify' or p_access = 'view'))
              or (p_access = 'view' and ea.domain = 'DERIVED_' || p_domain)))
    -- self-service: the SELF group's policy on the domain, for an active human user
    or exists (
      select 1 from core.app_user u
        join core.security_group g on g.tenant_id = u.tenant_id and g.code = 'SELF'
        join core.domain_policy dp on dp.group_id = g.id
        join core.domain d on d.id = dp.domain_id and d.code = p_domain
       where u.id = core.current_user_id() and u.status = 'active' and u.kind = 'human'
         and (dp.access = 'modify' or p_access = 'view')));
$$;

-- ---------------------------------------------------------------------------
-- 4. Owner-only RLS leg: cheap reject for other people's rows
-- ---------------------------------------------------------------------------

create or replace function core.rls_leg(p_label text, p_dom text, p_access text, p_legs text,
                                        p_owner text, p_domain_column text) returns text
language plpgsql immutable as $$
declare
  v_expr text;
  v_self text;
begin
  v_self := case when p_owner is not null then
    format('(%1$I = core.current_user_id() and core.can(%2$s, %3$L, null, null, %1$I))',
           p_owner, p_dom, p_access) end;
  case p_label
  when 'owner' then
    return v_self;
  when 'tenant' then
    return format('core.can(%s, %L, %s, %s)', p_dom, p_access, p_legs,
                  coalesce(quote_ident(p_owner), 'null'));
  when 'row' then
    v_expr := format(
      '((%1$I || '':'' || org_node_id::text) = any ((select core.visible_domain_nodes(%2$L))::text[])'
      ' or (%1$I || '':'' || delivery_node_id::text) = any ((select core.visible_domain_nodes(%2$L))::text[]))',
      p_domain_column, p_access);
  else
    v_expr := format('%I = any ((select core.visible_nodes(%s, %L))::uuid[])',
                     p_label, p_dom, p_access);
  end case;
  return case when v_self is null then v_expr else '(' || v_expr || ' or ' || v_self || ')' end;
end $$;

select core.apply_domain_rls(table_name) from core.domain_table order by table_name::text;

-- migrate:down
create or replace function core.rls_leg(p_label text, p_dom text, p_access text, p_legs text,
                                        p_owner text, p_domain_column text) returns text
language plpgsql immutable as $$
declare
  v_expr text;
  v_self text;
begin
  v_self := case when p_owner is not null then
    format('(%1$I = core.current_user_id() and core.can(%2$s, %3$L, null, null, %1$I))',
           p_owner, p_dom, p_access) end;
  case p_label
  when 'owner' then
    return format('core.can(%s, %L, null, null, %s)', p_dom, p_access, quote_ident(p_owner));
  when 'tenant' then
    return format('core.can(%s, %L, %s, %s)', p_dom, p_access, p_legs,
                  coalesce(quote_ident(p_owner), 'null'));
  when 'row' then
    v_expr := format(
      '((%1$I || '':'' || org_node_id::text) = any ((select core.visible_domain_nodes(%2$L))::text[])'
      ' or (%1$I || '':'' || delivery_node_id::text) = any ((select core.visible_domain_nodes(%2$L))::text[]))',
      p_domain_column, p_access);
  else
    v_expr := format('%I = any ((select core.visible_nodes(%s, %L))::uuid[])',
                     p_label, p_dom, p_access);
  end case;
  return case when v_self is null then v_expr else '(' || v_expr || ' or ' || v_self || ')' end;
end $$;
select core.apply_domain_rls(table_name) from core.domain_table order by table_name::text;

create or replace function core.can_any(p_domain text, p_access text) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select p_access in ('view', 'modify') and exists (
    select 1 from core.effective_access ea
     where ea.user_id = core.current_user_id()
       and ((ea.domain = p_domain and (ea.access = 'modify' or p_access = 'view'))
            or (p_access = 'view' and ea.domain = 'DERIVED_' || p_domain)));
$$;

drop function wf.record_failure(uuid, text, timestamptz, boolean);
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
revoke execute on function wf.record_failure(uuid, text, timestamptz) from public;
grant execute on function wf.record_failure(uuid, text, timestamptz) to wf_executor;

-- wf.submit, route_step, can_act_on_step and overdue_steps: the single-initiator forms.
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
              then core.nearest_group_node(s.escalate_to_group_id, s.scope_node_id, r.initiator_id)
              else core.nearest_group_node(s.assignee_group_id, s.scope_node_id, r.initiator_id, true)
         end
    from wf.step_instance s
    join wf.request r on r.id = s.request_id and r.state = 'in_approval'
    join wf.process_def d on d.tenant_id = r.tenant_id and d.process_type = r.process_type
   where s.state = 'pending'
     and s.activated_at + make_interval(hours => d.sla_hours) < p_at;
$$;

create or replace function wf.can_act_on_step(p_user uuid, p_step wf.step_instance, p_process text)
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

create or replace function wf.route_step(p_group uuid, p_escalate uuid, p_scope text,
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
  if p_escalate is not null then
    o_node := core.nearest_group_node(p_escalate, v_start, p_request.initiator_id);
    if o_node is not null then
      o_group := p_escalate;
      return;
    end if;
  end if;
  o_node := core.nearest_group_node(p_group, v_start, p_request.initiator_id, true);
  if o_node is not null then
    o_group := p_group;
  end if;
end $$;

-- wf.submit as in 20260930100000.
CREATE OR REPLACE FUNCTION wf.submit(p_process_type text, p_subject_type text, p_subject_id uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'wf', 'extensions'
AS $function$
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
end $function$;

drop function wf.non_approvers(wf.request);

create or replace function core.nearest_group_node(p_group uuid, p_start uuid, p_exclude uuid,
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
drop function core.nearest_group_node(uuid, uuid, uuid[], boolean);

alter table wf.request drop column excluded_approvers, drop column failure_code;
alter table core.subject_resolver drop column excluded_resolver;
