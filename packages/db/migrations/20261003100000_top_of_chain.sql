-- migrate:up
-- Top of chain (ADR 010).
--
-- An account owner's own request can reach a step that nobody but them could approve: the
-- sole owner's leave, their purchase order at the outlet they run. Rather than require a
-- second owner, such a step is approved at once and recorded as "top of chain: no higher
-- approver", visible in the request's history and in the access audit. It applies only
-- when the requester holds ACCOUNT_OWNER; anyone else still gets NO_APPROVER.
--
-- A step approved through its module (transfer dispatch and receipt) cannot be approved
-- without doing the work, so it stays pending for the owner themselves to act on:
-- rule 7 steps aside for that one step, flagged top_of_chain.
--
-- Also:
--   * the access audit gets a note: the sole-owner marker on grants that applied without
--     approval, and top-of-chain approvals of every process
--   * core.is_sole_account_owner() for the admin screen's notice
--   * wf.people_without_approver lists every person who could start a request that
--     nobody else could approve; the loader reports them as warnings

alter table wf.step_instance add column top_of_chain boolean not null default false;

-- p_user is an active account owner today.
create function core.is_account_owner(p_user uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select exists (
    select 1 from core.role_assignment ra
      join core.security_group g on g.id = ra.group_id and g.code = 'ACCOUNT_OWNER'
      join core.app_user u on u.id = ra.user_id and u.status = 'active'
     where ra.user_id = p_user
       and current_date >= ra.effective_from
       and (ra.effective_to is null or current_date <= ra.effective_to));
$$;

-- The caller is their customer's only active account owner.
create function core.is_sole_account_owner() returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select core.is_account_owner(core.current_user_id())
     and not exists (
       select 1 from core.role_assignment ra
         join core.security_group g on g.id = ra.group_id and g.code = 'ACCOUNT_OWNER'
         join core.app_user u on u.id = ra.user_id and u.status = 'active'
        where ra.tenant_id = core.my_tenant() and ra.user_id <> core.current_user_id()
          and current_date >= ra.effective_from
          and (ra.effective_to is null or current_date <= ra.effective_to));
$$;

revoke execute on function core.is_account_owner(uuid), core.is_sole_account_owner() from public;
grant execute on function core.is_sole_account_owner() to app_rw;

do $$
declare
  v_src text := pg_get_functiondef('wf.submit(text, text, uuid, jsonb, text)'::regprocedure);
  v_parts text[] := array[
    'v_first boolean := true;',
    'v_seq := v_seq + 1;',
    'perform wf.fail(''NO_APPROVER'', format(''step %s has no eligible approver'', v_step ->> ''step''));',
    'v_state := case when v_first then ''pending'' else ''waiting'' end;
      v_first := false;',
    'if v_state = ''pending'' then
      update wf.request set current_step'];
  v_p text;
begin
  foreach v_p in array v_parts loop
    if position(v_p in v_src) = 0 then
      raise exception 'wf.submit changed; update this migration (%)', v_p;
    end if;
  end loop;
  v_src := replace(v_src, 'v_first boolean := true;', 'v_first boolean := true;
  v_top boolean;');
  v_src := replace(v_src, 'v_seq := v_seq + 1;', 'v_seq := v_seq + 1;
    v_top := false;');
  v_src := replace(v_src,
    'perform wf.fail(''NO_APPROVER'', format(''step %s has no eligible approver'', v_step ->> ''step''));',
    '-- top of chain (ADR 010): only the requesting account owner could approve
        if not core.is_account_owner(v_me.id) then
          perform wf.fail(''NO_APPROVER'', format(''step %s has no eligible approver'', v_step ->> ''step''));
        end if;
        v_top := true;
        v_routed_group := wf.group_id(v_me.tenant_id, ''ACCOUNT_OWNER'');
        v_scope := core.org_root(v_me.tenant_id);');
  v_src := replace(v_src,
    'v_state := case when v_first then ''pending'' else ''waiting'' end;
      v_first := false;',
    'if v_top and v_step ->> ''approveVia'' is distinct from ''module'' then
        v_state := ''approved'';
      else
        v_state := case when v_first then ''pending'' else ''waiting'' end;
        v_first := false;
      end if;');
  v_src := replace(v_src,
    'if v_state = ''pending'' then
      update wf.request set current_step',
    'if v_top then
      update wf.step_instance
         set top_of_chain = true, comment = ''top of chain: no higher approver'',
             actor_id = case when v_state = ''approved'' then v_me.id end,
             acted_at = case when v_state = ''approved'' then now() end,
             decision_summary = case when v_state = ''approved''
                                     then wf.subject_summary(v_req.id) end
       where request_id = v_req.id and seq = v_seq;
    end if;
    if v_state = ''pending'' then
      update wf.request set current_step');
  execute v_src;

  -- a step done through its module is never skipped as same_approver: skipping a transfer
  -- receipt would leave the goods in transit forever (found here: the owner, or an outlet
  -- manager running both stores, may act on dispatch and receipt alike)
  v_src := pg_get_functiondef('wf.advance(uuid, uuid)'::regprocedure);
  if position('and wf.can_act_on_step(v_prev.actor_id, v_next, v_req.process_type) then' in v_src) = 0 then
    raise exception 'wf.advance changed; update this migration';
  end if;
  execute replace(v_src, 'and wf.can_act_on_step(v_prev.actor_id, v_next, v_req.process_type) then',
    'and wf.can_act_on_step(v_prev.actor_id, v_next, v_req.process_type)
       and wf.step_def(v_req.tenant_id, v_req.process_type, v_next.step) ->> ''approveVia''
           is distinct from ''module'' then');

  -- a top-of-chain module step is the owner's own to act on
  v_src := pg_get_functiondef('wf.act(uuid, text, text)'::regprocedure);
  if position('if v_me.id = v_req.initiator_id then' in v_src) = 0 then
    raise exception 'wf.act changed; update this migration';
  end if;
  execute replace(v_src, 'if v_me.id = v_req.initiator_id then',
                  'if v_me.id = v_req.initiator_id and not v_step.top_of_chain then');
  v_src := pg_get_functiondef('wf.can_act_on_step(uuid, wf.step_instance, text)'::regprocedure);
  if position('select p_user <> p_step.initiator_id' in v_src) = 0 then
    raise exception 'wf.can_act_on_step changed; update this migration';
  end if;
  execute replace(v_src, 'select p_user <> p_step.initiator_id',
                  'select (p_user <> p_step.initiator_id or p_step.top_of_chain)');
end $$;

-- Everyone who could start a request of some process at some place, where some step of it
-- would have nobody but them to approve. Account owners would be approved at the top of
-- the chain; anyone else would get NO_APPROVER. The sending side of a transfer depends on
-- where it comes from and is not checked.
create function wf.people_without_approver(p_tenant uuid)
returns table (username text, display_name text, process_type text, step text,
               node_code text, account_owner boolean)
language sql stable security definer
set search_path = pg_catalog, core, wf, hr, extensions
as $$
  with humans as (
    select u.id, u.username, u.display_name from core.app_user u
     where u.tenant_id = p_tenant and u.kind = 'human' and u.status = 'active'),
  initiators as (
    select bp.process_type, g.id as group_id, g.code
      from core.bp_policy bp join core.security_group g on g.id = bp.group_id
     where g.tenant_id = p_tenant and bp.action = 'initiate' and bp.step = '*'),
  candidates as (
    -- SELF: requests about oneself, at one's home
    select h.id, i.process_type, w.org_node_id as node_id
      from humans h
      join hr.worker w on w.owner_user_id = h.id and w.status = 'active'
      join initiators i on i.code = 'SELF'
      join wf.process_def d on d.tenant_id = p_tenant and d.process_type = i.process_type
                           and d.hierarchy_type = 'org'
    union
    -- a group: every place it covers (stock places only, for delivery processes)
    select h.id, i.process_type, n.id
      from humans h
      join core.role_assignment ra on ra.user_id = h.id
       and current_date >= ra.effective_from
       and (ra.effective_to is null or current_date <= ra.effective_to)
      join initiators i on i.group_id = ra.group_id
      join wf.process_def d on d.tenant_id = p_tenant and d.process_type = i.process_type
      join core.hierarchy_node a on a.id = ra.node_id
      join core.hierarchy_node n on n.tenant_id = a.tenant_id and n.type = a.type
       and n.archived_at is null
       and (n.id = a.id or (ra.include_descendants and a.path @> n.path))
     where n.type = d.hierarchy_type and (n.type = 'org' or n.holds_stock))
  select distinct h.username, h.display_name, c.process_type, s ->> 'step', n.code,
         core.is_account_owner(h.id)
    from candidates c
    join humans h on h.id = c.id
    join core.hierarchy_node n on n.id = c.node_id
    join wf.process_def d on d.tenant_id = p_tenant and d.process_type = c.process_type
    cross join lateral jsonb_array_elements(d.steps) s
    cross join lateral wf.route_chain(p_tenant, d.process_type, s ->> 'step',
                                      wf.group_id(p_tenant, s ->> 'group'),
                                      wf.group_id(p_tenant, s ->> 'escalateTo'),
                                      s ->> 'scope', c.node_id, array[c.id]) r
   where s ->> 'scope' <> 'from_node'
     and not (s -> 'when' ? 'setting' and not wf.setting_on(p_tenant, s -> 'when' ->> 'setting'))
     and r.o_node is null
   order by 1, 3, 4, 5;
$$;
revoke execute on function wf.people_without_approver(uuid) from public;

-- The access audit, with a note: the sole-owner marker on grants, and approvals at the top
-- of the chain (any process).
drop function core.access_audit(int);
create function core.access_audit(p_limit int default 100)
returns table (occurred_at timestamptz, actor text, action text, person text,
               access_group text, place text, request_id uuid, note text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf, audit
as $$
begin
  if not core.can_any('USER_ACCESS', 'view') then
    perform wf.fail('NOT_AUTHORISED', 'USER_ACCESS view required');
  end if;
  return query
  with ev as (
    select l.occurred_at, l.actor_id, l.table_name, l.op, l.changed_fields, l.request_id,
           coalesce(l.after, l.before) as r, l.after
      from audit.log l
     where l.tenant_id = core.my_tenant()
       and l.table_name in ('core.role_assignment', 'core.app_user', 'hr.role_change',
                            'wf.step_instance')
     order by l.occurred_at desc
     limit 5000),
  x as (
    select ev.occurred_at, ev.actor_id, ev.request_id,
           case ev.table_name
             when 'core.role_assignment' then
               case when ev.op = 'INSERT' then 'granted'
                    when ev.op = 'DELETE' then 'removed'
                    when 'effective_to' = any (ev.changed_fields) then 'ended'
                    when ev.changed_fields && array['group_id', 'node_id', 'effective_from',
                                                    'include_descendants'] then 'changed' end
             when 'core.app_user' then
               case when ev.op = 'INSERT' then 'user created'
                    when 'status' = any (ev.changed_fields) then
                      case ev.after ->> 'status' when 'inactive' then 'user deactivated'
                           else 'user reactivated' end end
             when 'hr.role_change' then
               case when ev.op = 'INSERT' then 'role change requested'
                    when 'status' = any (ev.changed_fields)
                         and ev.after ->> 'status' in ('applied', 'rejected', 'cancelled')
                      then 'role change ' || (ev.after ->> 'status') end
             when 'wf.step_instance' then
               case when (ev.after ->> 'top_of_chain')::boolean
                         and ev.after ->> 'state' = 'approved'
                         and ev.changed_fields && array['state', 'top_of_chain']
                      then 'approved at the top of the chain'
                    when ev.r ->> 'domain_code' = 'USER_ACCESS' and 'state' = any (ev.changed_fields)
                         and ev.after ->> 'state' in ('approved', 'rejected')
                      then 'role change ' || (ev.after ->> 'state') || ' by approver' end
           end as action,
           case ev.table_name
             when 'core.role_assignment' then (ev.r ->> 'user_id')::uuid
             when 'core.app_user' then (ev.r ->> 'id')::uuid
             when 'hr.role_change' then (ev.r ->> 'target_user_id')::uuid
             else coalesce((select rc.target_user_id from hr.role_change rc
                             where rc.wf_request_id = (ev.r ->> 'request_id')::uuid),
                           (ev.r ->> 'initiator_id')::uuid) end as person_id,
           case ev.table_name
             when 'core.role_assignment' then (ev.r ->> 'group_id')::uuid
             when 'hr.role_change' then (ev.r ->> 'group_id')::uuid
             when 'wf.step_instance' then (select rc.group_id from hr.role_change rc
                    where rc.wf_request_id = (ev.r ->> 'request_id')::uuid) end as group_id,
           case ev.table_name
             when 'core.role_assignment' then (ev.r ->> 'node_id')::uuid
             when 'hr.role_change' then (ev.r ->> 'node_id')::uuid
             when 'wf.step_instance' then coalesce((ev.r ->> 'org_node_id')::uuid,
                                                   (ev.r ->> 'delivery_node_id')::uuid)
             else core.home_node((ev.r ->> 'id')::uuid) end as node_id,
           case ev.table_name
             when 'core.role_assignment' then
               case when ev.op = 'INSERT' then ev.r ->> 'source_note' end
             when 'wf.step_instance' then
               case when (ev.after ->> 'top_of_chain')::boolean
                      then 'top of chain: no higher approver ('
                           || (select rq.process_type from wf.request rq
                                where rq.id = (ev.r ->> 'request_id')::uuid)
                           || ' ' || (ev.r ->> 'step') || ')' end
           end as note
      from ev)
  select x.occurred_at, coalesce(a.display_name, 'Platform'), x.action, p.display_name, g.code,
         n.name, x.request_id, x.note
    from x
    left join core.app_user a on a.id = x.actor_id
    left join core.app_user p on p.id = x.person_id
    left join core.security_group g on g.id = x.group_id
    left join core.hierarchy_node n on n.id = x.node_id
   where x.action is not null and x.node_id is not null
     and core.in_user_access_scope(x.node_id, 'view')
   order by x.occurred_at desc
   limit least(greatest(p_limit, 1), 500);
end $$;
revoke execute on function core.access_audit(int) from public;
grant execute on function core.access_audit(int) to app_rw;

-- migrate:down
drop function core.access_audit(int);
create function core.access_audit(p_limit int default 100)
returns table (occurred_at timestamptz, actor text, action text, person text,
               access_group text, place text, request_id uuid)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf, audit
as $$
begin
  if not core.can_any('USER_ACCESS', 'view') then
    perform wf.fail('NOT_AUTHORISED', 'USER_ACCESS view required');
  end if;
  return query
  with ev as (
    select l.occurred_at, l.actor_id, l.table_name, l.op, l.changed_fields, l.request_id,
           coalesce(l.after, l.before) as r, l.after
      from audit.log l
     where l.tenant_id = core.my_tenant()
       and l.table_name in ('core.role_assignment', 'core.app_user', 'hr.role_change',
                            'wf.step_instance')
     order by l.occurred_at desc
     limit 5000),
  x as (
    select ev.occurred_at, ev.actor_id, ev.request_id,
           case ev.table_name
             when 'core.role_assignment' then
               case when ev.op = 'INSERT' then 'granted'
                    when ev.op = 'DELETE' then 'removed'
                    when 'effective_to' = any (ev.changed_fields) then 'ended'
                    when ev.changed_fields && array['group_id', 'node_id', 'effective_from',
                                                    'include_descendants'] then 'changed' end
             when 'core.app_user' then
               case when ev.op = 'INSERT' then 'user created'
                    when 'status' = any (ev.changed_fields) then
                      case ev.after ->> 'status' when 'inactive' then 'user deactivated'
                           else 'user reactivated' end end
             when 'hr.role_change' then
               case when ev.op = 'INSERT' then 'role change requested'
                    when 'status' = any (ev.changed_fields)
                         and ev.after ->> 'status' in ('applied', 'rejected', 'cancelled')
                      then 'role change ' || (ev.after ->> 'status') end
             when 'wf.step_instance' then
               case when ev.r ->> 'domain_code' = 'USER_ACCESS' and 'state' = any (ev.changed_fields)
                         and ev.after ->> 'state' in ('approved', 'rejected')
                      then 'role change ' || (ev.after ->> 'state') || ' by approver' end
           end as action,
           case ev.table_name
             when 'core.role_assignment' then (ev.r ->> 'user_id')::uuid
             when 'core.app_user' then (ev.r ->> 'id')::uuid
             when 'hr.role_change' then (ev.r ->> 'target_user_id')::uuid
             else (select rc.target_user_id from hr.role_change rc
                    where rc.wf_request_id = (ev.r ->> 'request_id')::uuid) end as person_id,
           case ev.table_name
             when 'core.role_assignment' then (ev.r ->> 'group_id')::uuid
             when 'hr.role_change' then (ev.r ->> 'group_id')::uuid
             when 'wf.step_instance' then (select rc.group_id from hr.role_change rc
                    where rc.wf_request_id = (ev.r ->> 'request_id')::uuid) end as group_id,
           case ev.table_name
             when 'core.role_assignment' then (ev.r ->> 'node_id')::uuid
             when 'hr.role_change' then (ev.r ->> 'node_id')::uuid
             when 'wf.step_instance' then (ev.r ->> 'org_node_id')::uuid
             else core.home_node((ev.r ->> 'id')::uuid) end as node_id
      from ev)
  select x.occurred_at, coalesce(a.display_name, 'Platform'), x.action, p.display_name, g.code,
         n.name, x.request_id
    from x
    left join core.app_user a on a.id = x.actor_id
    left join core.app_user p on p.id = x.person_id
    left join core.security_group g on g.id = x.group_id
    left join core.hierarchy_node n on n.id = x.node_id
   where x.action is not null and x.node_id is not null
     and core.in_user_access_scope(x.node_id, 'view')
   order by x.occurred_at desc
   limit least(greatest(p_limit, 1), 500);
end $$;
revoke execute on function core.access_audit(int) from public;
grant execute on function core.access_audit(int) to app_rw;

drop function wf.people_without_approver(uuid);

do $$
declare
  v_src text;
begin
  execute replace(pg_get_functiondef('wf.can_act_on_step(uuid, wf.step_instance, text)'::regprocedure),
    'select (p_user <> p_step.initiator_id or p_step.top_of_chain)',
    'select p_user <> p_step.initiator_id');
  execute replace(pg_get_functiondef('wf.advance(uuid, uuid)'::regprocedure),
    'and wf.can_act_on_step(v_prev.actor_id, v_next, v_req.process_type)
       and wf.step_def(v_req.tenant_id, v_req.process_type, v_next.step) ->> ''approveVia''
           is distinct from ''module'' then',
    'and wf.can_act_on_step(v_prev.actor_id, v_next, v_req.process_type) then');
  execute replace(pg_get_functiondef('wf.act(uuid, text, text)'::regprocedure),
    'if v_me.id = v_req.initiator_id and not v_step.top_of_chain then',
    'if v_me.id = v_req.initiator_id then');
  v_src := pg_get_functiondef('wf.submit(text, text, uuid, jsonb, text)'::regprocedure);
  v_src := replace(v_src, 'if v_top then
      update wf.step_instance
         set top_of_chain = true, comment = ''top of chain: no higher approver'',
             actor_id = case when v_state = ''approved'' then v_me.id end,
             acted_at = case when v_state = ''approved'' then now() end,
             decision_summary = case when v_state = ''approved''
                                     then wf.subject_summary(v_req.id) end
       where request_id = v_req.id and seq = v_seq;
    end if;
    ', '');
  v_src := replace(v_src,
    'if v_top and v_step ->> ''approveVia'' is distinct from ''module'' then
        v_state := ''approved'';
      else
        v_state := case when v_first then ''pending'' else ''waiting'' end;
        v_first := false;
      end if;',
    'v_state := case when v_first then ''pending'' else ''waiting'' end;
      v_first := false;');
  v_src := replace(v_src,
    '-- top of chain (ADR 010): only the requesting account owner could approve
        if not core.is_account_owner(v_me.id) then
          perform wf.fail(''NO_APPROVER'', format(''step %s has no eligible approver'', v_step ->> ''step''));
        end if;
        v_top := true;
        v_routed_group := wf.group_id(v_me.tenant_id, ''ACCOUNT_OWNER'');
        v_scope := core.org_root(v_me.tenant_id);',
    'perform wf.fail(''NO_APPROVER'', format(''step %s has no eligible approver'', v_step ->> ''step''));');
  v_src := replace(v_src, 'v_seq := v_seq + 1;
    v_top := false;', 'v_seq := v_seq + 1;');
  v_src := replace(v_src, 'v_first boolean := true;
  v_top boolean;', 'v_first boolean := true;');
  execute v_src;
end $$;

drop function core.is_sole_account_owner();
drop function core.is_account_owner(uuid);
alter table wf.step_instance drop column top_of_chain;
