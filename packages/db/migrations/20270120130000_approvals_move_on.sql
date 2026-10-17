-- migrate:up
-- Approvals move on (ADR 167, review H6).
--
-- wf.escalate_overdue was only ever called by tests: a step waited forever for an approver on
-- leave, and for one who had left. wf.approvals_tick runs from the tasks tick every 5 minutes,
-- one customer at a time:
--   1. a step past its SLA goes up its chain, as wf.escalate_overdue does;
--   2. a step nobody can approve any more (every holder deactivated, their access ended, or
--      only the asker left) goes up its chain at once, without waiting for the SLA.
-- A step with nowhere to go stays and is counted (wf.unroutable_steps lists the overdue ones).

-- Whether anyone may still approve this step: an active holder of its group (or of the group it
-- also escalates to) at its place who is not the asker (unless the step is the top of the
-- chain) and not excluded from approving the request.
create function wf.step_has_approver(p_step wf.step_instance, p_request wf.request)
returns boolean
language sql stable security definer
set search_path = pg_catalog, core, wf
as $$
  select exists (
    select 1
      from (select wf.step_def(p_request.tenant_id, p_request.process_type, p_step.step) as def) d,
           lateral (values (p_step.assignee_group_id),
                           (case when d.def ->> 'alsoEscalateTo' = 'true'
                                 then p_step.escalate_to_group_id end)) g(gid),
           lateral wf.approver_holders(d.def ->> 'scope', g.gid, p_step.scope_node_id) h
     where g.gid is not null
       and h <> all (coalesce(p_request.excluded_approvers, '{}'))
       and (h <> p_request.initiator_id or p_step.top_of_chain));
$$;
revoke execute on function wf.step_has_approver(wf.step_instance, wf.request) from public;

create function wf.approvals_tick(p_at timestamptz default now(), p_tenant uuid default null)
returns table (escalated int, rerouted int, unroutable int)
language plpgsql security definer
set search_path = pg_catalog, core, wf, extensions
as $$
declare
  v_row record;
  v_id uuid;
  v_s wf.step_instance;
  v_r wf.request;
  v_group uuid;
  v_node uuid;
  v_escalated int := 0;
  v_rerouted int := 0;
  v_stuck int := 0;
begin
  -- 1. past the SLA: up the chain
  for v_row in
    select o.* from wf.overdue_steps(p_at) o
      join wf.request r on r.id = o.request_id
     where o.target_node_id is not null and (p_tenant is null or r.tenant_id = p_tenant)
     order by o.step_id
  loop
    perform set_config('app.wf_request', v_row.request_id::text, true);
    update wf.step_instance
       set assignee_group_id = v_row.target_group_id,
           scope_node_id = v_row.target_node_id,
           escalate_to_group_id = null,
           escalation_count = escalation_count + 1,
           last_escalated_at = p_at,
           activated_at = p_at
     where id = v_row.step_id and state = 'pending';
    if found then
      v_escalated := v_escalated + 1;
    end if;
  end loop;

  -- 2. nobody left who may approve it: up the chain now
  for v_id in
    select s.id from wf.step_instance s
      join wf.request r on r.id = s.request_id and r.state = 'in_approval'
     where s.state = 'pending' and (p_tenant is null or r.tenant_id = p_tenant)
       and core.tenant_active(r.tenant_id)
     order by s.id
     for update of s skip locked
  loop
    select * into v_s from wf.step_instance where id = v_id;
    select * into v_r from wf.request where id = v_s.request_id;
    continue when wf.step_has_approver(v_s, v_r);
    select t.o_group, t.o_node into v_group, v_node from wf.escalation_target(v_s, v_r) t;
    if v_node is null
       or (v_group = v_s.assignee_group_id and v_node = v_s.scope_node_id) then
      v_stuck := v_stuck + 1;
      continue;
    end if;
    perform set_config('app.wf_request', v_r.id::text, true);
    update wf.step_instance
       set assignee_group_id = v_group,
           scope_node_id = v_node,
           escalate_to_group_id = null,
           escalation_count = escalation_count + 1,
           last_escalated_at = p_at,
           activated_at = p_at
     where id = v_s.id and state = 'pending';
    v_rerouted := v_rerouted + 1;
  end loop;
  return query select v_escalated, v_rerouted, v_stuck;
end $$;
revoke execute on function wf.approvals_tick(timestamptz, uuid) from public;
grant execute on function wf.approvals_tick(timestamptz, uuid) to wf_executor;

-- migrate:down
drop function wf.approvals_tick(timestamptz, uuid);
drop function wf.step_has_approver(wf.step_instance, wf.request);
