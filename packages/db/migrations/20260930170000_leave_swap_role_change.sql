-- migrate:up
-- LEAVE, SHIFT_SWAP and ROLE_CHANGE (docs/LLD.md sections 4 and 5, ADR 008).
--
-- Request functions create the subject and hand it to wf.submit in one transaction.
-- Business rules are checked when a request is made and again at approval, so the
-- approver sees the rule code (shift swaps are approved only through hr.approve_swap).
-- The executor (hr.execute) applies the approved change and re-checks as a safety net;
-- a business-rule failure there is final (wf.record_failure p_final, ADR 008).

-- ---------------------------------------------------------------------------
-- Helpers (not callable by app_rw)
-- ---------------------------------------------------------------------------

-- The current user's active worker row, or INVALID_WORKER.
create function hr.my_worker() returns hr.worker
language plpgsql stable
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker;
begin
  select * into v_w from hr.worker
   where owner_user_id = core.current_user_id() and status = 'active'
     and tenant_id = core.my_tenant();
  if not found then
    perform hr.fail('INVALID_WORKER', 'you are not set up as a worker');
  end if;
  return v_w;
end $$;

-- Days still available: entitled - used - pending (submitted) requests, other than
-- p_exclude. Null for leave types without a balance (unpaid).
create function hr.leave_available(p_worker uuid, p_type uuid, p_year int,
                                   p_exclude uuid default null) returns numeric
language sql stable
set search_path = pg_catalog, hr
as $$
  select case when t.annual_days is null then null else
    coalesce((select b.entitled_days - b.used_days from hr.leave_balance b
               where b.worker_id = p_worker and b.leave_type_id = p_type and b.year = p_year), 0)
    - coalesce((select sum(l.days) from hr.leave_request l
                 where l.worker_id = p_worker and l.leave_type_id = p_type
                   and extract(year from l.from_date) = p_year and l.status = 'submitted'
                   and l.id is distinct from p_exclude), 0)
  end
    from hr.leave_type t where t.id = p_type;
$$;

-- Assigned shifts that approving a leave request would drop (local dates overlap).
create function hr.leave_shifts(p_leave uuid)
returns table (assignment_id uuid, shift_id uuid, local_date date, start_at timestamptz,
               end_at timestamptz, role_code text)
language sql stable
set search_path = pg_catalog, hr
as $$
  select a.id, s.id, s.local_date, s.start_at, s.end_at, s.role_code
    from hr.leave_request l
    join hr.shift_assignment a on a.worker_id = l.worker_id and a.status = 'assigned'
    join hr.shift s on s.id = a.shift_id and s.status <> 'cancelled'
   where l.id = p_leave
     and (a.start_at at time zone hr.node_tz(a.org_node_id))::date <= l.to_date
     and ((a.end_at - interval '1 microsecond') at time zone hr.node_tz(a.org_node_id))::date >= l.from_date
   order by s.start_at;
$$;

-- Notifies every holder of p_group covering p_node (e.g. the outlet's managers).
create function hr.notify_group(p_node uuid, p_group text, p_kind text, p_title text,
                                p_body text default null, p_link text default null) returns void
language sql
set search_path = pg_catalog, core, hr, ops
as $$
  select ops.notify(n.tenant_id, h.uid, p_kind, p_title, p_body, p_link)
    from core.hierarchy_node n
    join core.security_group g on g.tenant_id = n.tenant_id and g.code = p_group
    cross join lateral core.group_holders(g.id, n.id) h(uid)
   where n.id = p_node;
$$;

create function hr.user_name(p_user uuid) returns text
language sql stable
set search_path = pg_catalog, core
as $$
  select display_name from core.app_user where id = p_user;
$$;

revoke execute on function hr.my_worker(), hr.leave_available(uuid, uuid, int, uuid),
  hr.leave_shifts(uuid), hr.notify_group(uuid, text, text, text, text, text),
  hr.user_name(uuid) from public;

-- ---------------------------------------------------------------------------
-- LEAVE
-- ---------------------------------------------------------------------------

-- Requests leave for the current user's worker and submits it. Days are calendar days,
-- inclusive (MVP; ADR 008). Returns the leave request id; a repeat key returns it again.
create function hr.request_leave(p_type uuid, p_from date, p_to date, p_reason text default null,
                                 p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_w hr.worker := hr.my_worker();
  v_id uuid;
  v_days numeric;
  v_avail numeric;
  v_request uuid;
begin
  if p_idempotency_key is not null then
    select l.id into v_id from hr.leave_request l
      join wf.request r on r.id = l.wf_request_id
     where l.worker_id = v_w.id and r.initiator_id = v_w.owner_user_id
       and r.idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
  end if;
  if not core.can('LEAVE', 'modify', v_w.org_node_id, null, v_w.owner_user_id) then
    perform hr.fail('NOT_AUTHORISED', 'cannot request leave');
  end if;
  if not exists (select 1 from hr.leave_type where id = p_type and tenant_id = v_w.tenant_id
                                                and archived_at is null) then
    perform hr.fail('INVALID_LEAVE_TYPE');
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 90 then
    perform hr.fail('INVALID_DATES', 'the end date is before the start, or the range is too long');
  end if;
  if extract(year from p_from) <> extract(year from p_to) then
    perform hr.fail('LEAVE_SPANS_YEAR', 'split leave at the year end');
  end if;
  -- serialise this worker's balance checks
  perform pg_advisory_xact_lock(hashtextextended('hr.worker:' || v_w.id, 0));
  if exists (select 1 from hr.leave_request
              where worker_id = v_w.id and status in ('submitted', 'approved')
                and from_date <= p_to and to_date >= p_from) then
    perform hr.fail('LEAVE_OVERLAP', 'you already have leave on some of these days');
  end if;
  v_days := p_to - p_from + 1;
  v_avail := hr.leave_available(v_w.id, p_type, extract(year from p_from)::int);
  if v_avail is not null and v_avail < v_days then
    perform hr.fail('INSUFFICIENT_LEAVE_BALANCE', format('%s day(s) available', v_avail));
  end if;

  insert into hr.leave_request (tenant_id, worker_id, owner_user_id, org_node_id, leave_type_id,
                                from_date, to_date, days, reason)
  values (v_w.tenant_id, v_w.id, v_w.owner_user_id, v_w.org_node_id, p_type, p_from, p_to,
          v_days, nullif(trim(p_reason), ''))
  returning id into v_id;
  v_request := wf.submit('LEAVE', 'hr.leave_request', v_id, '{}', p_idempotency_key);
  update hr.leave_request set status = 'submitted', wf_request_id = v_request where id = v_id;
  return v_id;
end $$;

-- Balances for the current user (or, with LEAVE view at their node, for p_worker).
create function hr.leave_balances(p_worker uuid default null, p_year int default null)
returns table (leave_type_id uuid, code text, name text, year int, entitled_days numeric,
               used_days numeric, pending_days numeric, available_days numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker;
  v_year int;
begin
  if p_worker is null then
    v_w := hr.my_worker();
  else
    select * into v_w from hr.worker where id = p_worker and tenant_id = core.my_tenant();
    if not found or not core.can('LEAVE', 'view', v_w.org_node_id, null, v_w.owner_user_id) then
      perform hr.fail('NOT_AUTHORISED', 'leave balances');
    end if;
  end if;
  v_year := coalesce(p_year, extract(year from (now() at time zone hr.node_tz(v_w.org_node_id)))::int);
  return query
    select t.id, t.code, t.name, v_year, b.entitled_days, coalesce(b.used_days, 0),
           coalesce((select sum(l.days) from hr.leave_request l
                      where l.worker_id = v_w.id and l.leave_type_id = t.id
                        and extract(year from l.from_date) = v_year and l.status = 'submitted'), 0),
           hr.leave_available(v_w.id, t.id, v_year)
      from hr.leave_type t
      left join hr.leave_balance b on b.leave_type_id = t.id and b.worker_id = v_w.id and b.year = v_year
     where t.tenant_id = v_w.tenant_id and t.archived_at is null
     order by t.annual_days is null, t.name;
end $$;

-- What approving a leave request would drop, for the approval screen. Needs LEAVE view
-- on the request (approvers, HR, the worker).
create function hr.leave_conflicts(p_leave uuid)
returns table (assignment_id uuid, shift_id uuid, local_date date, start_at timestamptz,
               end_at timestamptz, role_code text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_l hr.leave_request;
begin
  select * into v_l from hr.leave_request where id = p_leave and tenant_id = core.my_tenant();
  if not found or not core.can('LEAVE', 'view', v_l.org_node_id, null, v_l.owner_user_id) then
    perform hr.fail('NOT_AUTHORISED', 'leave request');
  end if;
  return query select * from hr.leave_shifts(p_leave);
end $$;

-- ---------------------------------------------------------------------------
-- SHIFT_SWAP: A offers a published shift to B; B accepting submits the request
-- ---------------------------------------------------------------------------

create function hr.request_swap(p_assignment uuid, p_to_worker uuid, p_note text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker := hr.my_worker();
  v_a hr.shift_assignment;
  v_s hr.shift;
  v_to hr.worker;
  v_bad record;
  v_id uuid;
begin
  select * into v_a from hr.shift_assignment
   where id = p_assignment and worker_id = v_w.id and status = 'assigned' for update;
  if not found then
    perform hr.fail('NOT_FOUND', 'your shift');
  end if;
  if not core.can('SHIFT_SWAPS', 'modify', v_a.org_node_id, null, v_w.owner_user_id) then
    perform hr.fail('NOT_AUTHORISED', 'cannot swap');
  end if;
  select * into v_s from hr.shift where id = v_a.shift_id;
  if v_s.status <> 'published' then
    perform hr.fail('INVALID_STATE', 'only published shifts can be swapped');
  end if;
  if v_s.start_at <= now() then
    perform hr.fail('SHIFT_STARTED');
  end if;
  select * into v_to from hr.worker
   where id = p_to_worker and tenant_id = v_w.tenant_id and status = 'active';
  if not found or v_to.id = v_w.id then
    perform hr.fail('INVALID_WORKER', 'pick a colleague');
  end if;

  select id into v_id from hr.shift_swap
   where assignment_id = p_assignment and status in ('proposed', 'submitted');
  if found then
    if (select to_worker_id from hr.shift_swap where id = v_id) = p_to_worker then
      return v_id;
    end if;
    perform hr.fail('INVALID_STATE', 'this shift already has an open swap');
  end if;
  select * into v_bad from hr.assignment_violation(p_to_worker, v_s.start_at, v_s.end_at,
                                                    v_s.org_node_id, v_s.role_code);
  if v_bad.code is not null then
    perform hr.fail(v_bad.code, v_bad.detail);
  end if;

  insert into hr.shift_swap (tenant_id, org_node_id, owner_user_id, assignment_id, shift_id,
                             from_worker_id, to_worker_id, to_user_id, note)
  values (v_w.tenant_id, v_a.org_node_id, v_w.owner_user_id, v_a.id, v_s.id, v_w.id, v_to.id,
          v_to.owner_user_id, nullif(trim(p_note), ''))
  returning id into v_id;
  perform ops.notify(v_w.tenant_id, v_to.owner_user_id, 'swap_offer',
    hr.user_name(v_w.owner_user_id) || ' offered you a shift',
    to_char(v_s.start_at at time zone hr.node_tz(v_s.org_node_id), 'Dy DD Mon HH24:MI'),
    '/roster/swaps');
  return v_id;
end $$;

-- B accepts (submits SHIFT_SWAP with B as initiator) or declines. Returns the new status.
create function hr.respond_swap(p_swap uuid, p_accept boolean) returns text
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_sw hr.shift_swap;
  v_s hr.shift;
  v_bad record;
  v_request uuid;
begin
  select * into v_sw from hr.shift_swap
   where id = p_swap and to_user_id = core.current_user_id() and tenant_id = core.my_tenant()
   for update;
  if not found then
    perform hr.fail('NOT_FOUND', 'swap offer');
  end if;
  if v_sw.status <> 'proposed' then
    if (v_sw.status = 'submitted' and p_accept) or (v_sw.status = 'declined' and not p_accept) then
      return v_sw.status;   -- repeat of the same answer
    end if;
    perform hr.fail('INVALID_STATE', 'this offer is no longer open');
  end if;
  if not p_accept then
    update hr.shift_swap set status = 'declined', responded_at = now() where id = p_swap;
    perform ops.notify(v_sw.tenant_id, v_sw.owner_user_id, 'swap_declined',
      hr.user_name(v_sw.to_user_id) || ' declined your swap', null, '/roster/swaps');
    return 'declined';
  end if;

  select * into v_s from hr.shift where id = v_sw.shift_id;
  if v_s.start_at <= now() then
    perform hr.fail('SHIFT_STARTED');
  end if;
  select * into v_bad from hr.assignment_violation(v_sw.to_worker_id, v_s.start_at, v_s.end_at,
                                                    v_s.org_node_id, v_s.role_code);
  if v_bad.code is not null then
    perform hr.fail(v_bad.code, v_bad.detail);
  end if;
  v_request := wf.submit('SHIFT_SWAP', 'hr.shift_swap', p_swap);
  update hr.shift_swap set status = 'submitted', wf_request_id = v_request, responded_at = now()
   where id = p_swap;
  perform ops.notify(v_sw.tenant_id, v_sw.owner_user_id, 'swap_accepted',
    hr.user_name(v_sw.to_user_id) || ' accepted your swap', 'Waiting for manager approval',
    '/roster/swaps');
  return 'submitted';
end $$;

-- A withdraws an offer B has not answered yet.
create function hr.withdraw_swap(p_swap uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_sw hr.shift_swap;
begin
  select * into v_sw from hr.shift_swap
   where id = p_swap and owner_user_id = core.current_user_id() and tenant_id = core.my_tenant()
   for update;
  if not found then
    perform hr.fail('NOT_FOUND', 'swap');
  end if;
  if v_sw.status = 'withdrawn' then
    return;
  end if;
  if v_sw.status <> 'proposed' then
    perform hr.fail('INVALID_STATE', 'already answered');
  end if;
  update hr.shift_swap set status = 'withdrawn' where id = p_swap;
  perform ops.notify(v_sw.tenant_id, v_sw.to_user_id, 'swap_withdrawn',
    hr.user_name(v_sw.owner_user_id) || ' withdrew a swap offer', null, '/roster/swaps');
end $$;

-- Swaps the current user made or was offered (hr.shift_swap is readable only by its
-- owner and managers; the partner reads through here).
create function hr.my_swaps()
returns table (swap_id uuid, direction text, status text, shift_id uuid, org_node_id uuid,
               start_at timestamptz, end_at timestamptz, role_code text, from_name text,
               to_name text, note text, wf_request_id uuid, created_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select sw.id, case when sw.owner_user_id = core.current_user_id() then 'outgoing' else 'incoming' end,
         sw.status, s.id, s.org_node_id, s.start_at, s.end_at, s.role_code,
         hr.user_name(sw.owner_user_id), hr.user_name(sw.to_user_id), sw.note, sw.wf_request_id,
         sw.created_at
    from hr.shift_swap sw
    join hr.shift s on s.id = sw.shift_id
   where sw.tenant_id = core.my_tenant()
     and core.current_user_id() in (sw.owner_user_id, sw.to_user_id)
   order by sw.created_at desc
   limit 50;
$$;

-- Approves a submitted swap after re-running the rostering rules for B, so a broken rule
-- reaches the approver as its code (REST_RULE, ...). Only way to approve SHIFT_SWAP.
create function hr.approve_swap(p_swap uuid, p_comment text default null) returns text
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_sw hr.shift_swap;
  v_a hr.shift_assignment;
  v_s hr.shift;
  v_bad record;
begin
  perform wf.me();
  select * into v_sw from hr.shift_swap
   where id = p_swap and tenant_id = core.my_tenant() for update;
  if not found then
    perform hr.fail('NOT_FOUND', 'swap');
  end if;
  if v_sw.status <> 'submitted' or v_sw.wf_request_id is null then
    perform hr.fail('INVALID_STATE', 'swap is not waiting for approval');
  end if;
  -- the approver's rights (and rule 7 / excluded parties) are checked by wf.act first
  if not exists (select 1 from wf.step_instance si
                  where si.request_id = v_sw.wf_request_id and si.state = 'pending'
                    and wf.can_act_on_step(core.current_user_id(), si, 'SHIFT_SWAP')) then
    if core.current_user_id() in (v_sw.owner_user_id, v_sw.to_user_id) then
      perform hr.fail('SEGREGATION_OF_DUTIES', 'a party to the swap cannot approve it');
    end if;
    perform hr.fail('NOT_AUTHORISED', 'not an approver for this swap');
  end if;
  select * into v_a from hr.shift_assignment where id = v_sw.assignment_id;
  select * into v_s from hr.shift where id = v_sw.shift_id;
  if v_s.start_at <= now() then
    perform hr.fail('SHIFT_STARTED');
  end if;
  if v_a.status <> 'assigned' then
    perform hr.fail('INVALID_STATE', 'the original assignment has changed');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hr.worker:' || v_sw.to_worker_id, 0));
  select * into v_bad from hr.assignment_violation(v_sw.to_worker_id, v_s.start_at, v_s.end_at,
                                                    v_s.org_node_id, v_s.role_code);
  if v_bad.code is not null then
    perform hr.fail(v_bad.code, v_bad.detail);
  end if;
  return wf.act_as_module(v_sw.wf_request_id, 'outlet_approval', p_comment);
end $$;

-- ---------------------------------------------------------------------------
-- ROLE_CHANGE (database only for the MVP; no UI)
-- ---------------------------------------------------------------------------

-- HR Admin requests a new assignment ('grant') or the end of one ('end'). The subject's
-- org node routes the approval: the assignment node if in the org tree, else its linked
-- org node, else the org root. Returns the hr.role_change id.
create function hr.request_role_change(p_action text, p_target_user uuid, p_group_code text,
                                       p_node uuid, p_include_descendants boolean default true,
                                       p_effective_from date default null,
                                       p_effective_to date default null,
                                       p_assignment uuid default null,
                                       p_reason text default null,
                                       p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_ra core.role_assignment;
  v_group uuid;
  v_node core.hierarchy_node;
  v_org uuid;
  v_id uuid;
  v_request uuid;
begin
  if p_idempotency_key is not null then
    select rc.id into v_id from hr.role_change rc join wf.request r on r.id = rc.wf_request_id
     where r.initiator_id = v_me.id and r.idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
  end if;
  if p_action not in ('grant', 'end') then
    perform hr.fail('INVALID_ACTION', p_action);
  end if;

  if p_action = 'end' then
    select * into v_ra from core.role_assignment where id = p_assignment;
    if not found then
      perform hr.fail('NOT_FOUND', 'assignment');
    end if;
    if v_ra.tenant_id <> v_me.tenant_id then
      perform hr.fail('TENANT_MISMATCH', 'assignment');
    end if;
    if p_effective_to is null or p_effective_to < v_ra.effective_from
       or (v_ra.effective_to is not null and v_ra.effective_to <= p_effective_to) then
      perform hr.fail('INVALID_DATES', 'the end date must fall within the assignment');
    end if;
  end if;

  select id into v_group from core.security_group
   where id = coalesce(v_ra.group_id, (select g.id from core.security_group g
                                        where g.tenant_id = v_me.tenant_id and g.code = p_group_code));
  if v_group is null then
    perform hr.fail('INVALID_GROUP', p_group_code);
  end if;
  select * into v_node from core.hierarchy_node where id = coalesce(v_ra.node_id, p_node);
  if not found then
    perform hr.fail('NOT_FOUND', 'node');
  end if;
  if v_node.tenant_id <> v_me.tenant_id
     or not exists (select 1 from core.app_user
                     where id = coalesce(v_ra.user_id, p_target_user) and tenant_id = v_me.tenant_id) then
    perform hr.fail('TENANT_MISMATCH', 'user or node belongs to another organisation');
  end if;
  v_org := case when v_node.type = 'org' then v_node.id else
    coalesce((select min(nl.org_node_id::text)::uuid from core.node_link nl
               where nl.delivery_node_id = v_node.id), core.org_root(v_me.tenant_id)) end;
  if not core.can('SECURITY_ROLES', 'modify', v_org, null) then
    perform hr.fail('NOT_AUTHORISED', 'SECURITY_ROLES modify required');
  end if;
  if p_action = 'grant' and exists (
       select 1 from core.role_assignment
        where user_id = p_target_user and group_id = v_group and node_id = v_node.id
          and (effective_to is null or effective_to >= coalesce(p_effective_from, current_date))) then
    perform hr.fail('INVALID_STATE', 'the user already holds this role there');
  end if;

  insert into hr.role_change (tenant_id, org_node_id, action, target_user_id, group_id, node_id,
                              include_descendants, effective_from, effective_to, assignment_id,
                              reason)
  values (v_me.tenant_id, v_org, p_action, coalesce(v_ra.user_id, p_target_user), v_group,
          v_node.id, coalesce(v_ra.include_descendants, p_include_descendants),
          coalesce(v_ra.effective_from, p_effective_from, current_date), p_effective_to,
          v_ra.id, nullif(trim(p_reason), ''))
  returning id into v_id;
  v_request := wf.submit('ROLE_CHANGE', 'hr.role_change', v_id, '{}', p_idempotency_key);
  update hr.role_change set status = 'submitted', wf_request_id = v_request where id = v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Executor handlers (wf_executor only). Idempotent per request.
-- ---------------------------------------------------------------------------

create function hr.execute(p_handler text, p_request_id uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_req wf.request;
  v_closed text;
  v_l hr.leave_request;
  v_sw hr.shift_swap;
  v_s hr.shift;
  v_a hr.shift_assignment;
  v_rc hr.role_change;
  v_bad record;
  v_id uuid;
  v_year int;
  v_dropped int;
begin
  -- onApproved handlers run while the request is executing; onRejected handlers run on
  -- rejected or cancelled requests (their state is kept).
  select * into v_req from wf.request where id = p_request_id;
  if not found or v_req.state not in ('executing', 'rejected', 'cancelled') then
    perform hr.fail('INVALID_STATE', 'request is not being executed');
  end if;
  v_closed := case v_req.state when 'cancelled' then 'cancelled' else 'rejected' end;
  -- audit rows written by the handler name the request that authorised them
  perform set_config('app.wf_request', p_request_id::text, true);

  case p_handler
  when 'hr.leave.apply' then
    select * into v_l from hr.leave_request where wf_request_id = p_request_id for update;
    if v_l.status <> 'submitted' then
      return;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('hr.worker:' || v_l.worker_id, 0));
    v_year := extract(year from v_l.from_date)::int;
    if (select annual_days from hr.leave_type where id = v_l.leave_type_id) is not null then
      update hr.leave_balance set used_days = used_days + v_l.days
       where worker_id = v_l.worker_id and leave_type_id = v_l.leave_type_id and year = v_year
         and entitled_days - used_days >= v_l.days;
      if not found then
        perform hr.fail('INSUFFICIENT_LEAVE_BALANCE', 'balance changed since the request');
      end if;
    end if;
    -- approved leave is the block rostering reads; assigned shifts in it are dropped
    with d as (
      update hr.shift_assignment a
         set status = 'dropped', drop_reason = 'leave', leave_request_id = v_l.id
       where a.id in (select assignment_id from hr.leave_shifts(v_l.id))
      returning a.id)
    select count(*) into v_dropped from d;
    update hr.leave_request set status = 'approved', decided_at = now() where id = v_l.id;
    perform ops.notify(v_l.tenant_id, v_l.owner_user_id, 'leave_approved', 'Leave approved',
      to_char(v_l.from_date, 'DD Mon') || ' – ' || to_char(v_l.to_date, 'DD Mon'), '/leave');
    if v_dropped > 0 then
      perform hr.notify_group(v_l.org_node_id, 'OUTLET_MANAGER', 'roster_gap',
        v_dropped || ' shift(s) need cover',
        hr.user_name(v_l.owner_user_id) || ' is on approved leave', '/roster');
    end if;

  when 'hr.leave.reject' then
    select * into v_l from hr.leave_request where wf_request_id = p_request_id for update;
    if v_l.status = 'submitted' then
      update hr.leave_request set status = v_closed, decided_at = now() where id = v_l.id;
      if v_closed = 'rejected' then
        perform ops.notify(v_l.tenant_id, v_l.owner_user_id, 'leave_rejected', 'Leave not approved',
          to_char(v_l.from_date, 'DD Mon') || ' – ' || to_char(v_l.to_date, 'DD Mon'), '/leave');
      end if;
    end if;

  when 'hr.shift_swap.apply' then
    select * into v_sw from hr.shift_swap where wf_request_id = p_request_id for update;
    if v_sw.status <> 'submitted' then
      return;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('hr.worker:' || v_sw.to_worker_id, 0));
    select * into v_s from hr.shift where id = v_sw.shift_id;
    select * into v_a from hr.shift_assignment where id = v_sw.assignment_id for update;
    if v_a.status <> 'assigned' then
      perform hr.fail('INVALID_STATE', 'the original assignment has changed');
    end if;
    -- safety net: rules were checked at approval; a failure here is final (ADR 008)
    select * into v_bad from hr.assignment_violation(v_sw.to_worker_id, v_s.start_at, v_s.end_at,
                                                      v_s.org_node_id, v_s.role_code);
    if v_bad.code is not null then
      perform hr.fail(v_bad.code, v_bad.detail);
    end if;
    update hr.shift_assignment set status = 'swapped', drop_reason = 'swap', swap_id = v_sw.id
     where id = v_a.id;
    insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                     start_at, end_at, swap_id)
    values (v_sw.tenant_id, v_s.id, v_sw.to_worker_id, v_sw.to_user_id, v_s.org_node_id,
            v_s.start_at, v_s.end_at, v_sw.id)
    returning id into v_id;
    update hr.shift_swap set status = 'approved', decided_at = now(), new_assignment_id = v_id
     where id = v_sw.id;
    perform ops.notify(v_sw.tenant_id, u, 'swap_approved', 'Shift swap approved',
      to_char(v_s.start_at at time zone hr.node_tz(v_s.org_node_id), 'Dy DD Mon HH24:MI'),
      '/roster/my')
      from unnest(array[v_sw.owner_user_id, v_sw.to_user_id]) u;

  when 'hr.shift_swap.reject' then
    select * into v_sw from hr.shift_swap where wf_request_id = p_request_id for update;
    if v_sw.status = 'submitted' then
      update hr.shift_swap set status = v_closed, decided_at = now() where id = v_sw.id;
      perform ops.notify(v_sw.tenant_id, u, 'swap_' || v_closed, 'Shift swap not approved',
        null, '/roster/swaps')
        from unnest(array[v_sw.owner_user_id, v_sw.to_user_id]) u;
    end if;

  when 'hr.role_change.apply' then
    select * into v_rc from hr.role_change where wf_request_id = p_request_id for update;
    if v_rc.status <> 'submitted' then
      return;
    end if;
    if v_rc.action = 'grant' then
      -- core.check_same_tenant (trigger) rejects any cross-tenant user, group or node
      insert into core.role_assignment (tenant_id, user_id, group_id, node_id,
                                        include_descendants, effective_from, effective_to)
      values (v_rc.tenant_id, v_rc.target_user_id, v_rc.group_id, v_rc.node_id,
              v_rc.include_descendants, v_rc.effective_from, v_rc.effective_to)
      returning id into v_id;
    else
      update core.role_assignment set effective_to = v_rc.effective_to
       where id = v_rc.assignment_id
         and (effective_to is null or effective_to > v_rc.effective_to)
      returning id into v_id;
    end if;
    -- core.effective_access is a view computed per query, so the new access applies to
    -- the user's next request; there is no cache to refresh.
    update hr.role_change set status = 'applied', applied_assignment_id = v_id where id = v_rc.id;
    perform ops.notify(v_rc.tenant_id, v_rc.target_user_id, 'access_changed',
      'Your access has changed', null, '/');

  when 'hr.role_change.reject' then
    update hr.role_change set status = v_closed
     where wf_request_id = p_request_id and status = 'submitted';

  else
    perform hr.fail('HANDLER_NOT_FOUND', p_handler);
  end case;
end $$;

revoke execute on function hr.request_leave(uuid, date, date, text, text),
  hr.leave_balances(uuid, int), hr.leave_conflicts(uuid),
  hr.request_swap(uuid, uuid, text), hr.respond_swap(uuid, boolean), hr.withdraw_swap(uuid),
  hr.my_swaps(), hr.approve_swap(uuid, text),
  hr.request_role_change(text, uuid, text, uuid, boolean, date, date, uuid, text, text),
  hr.execute(text, uuid) from public;
grant execute on function hr.request_leave(uuid, date, date, text, text),
  hr.leave_balances(uuid, int), hr.leave_conflicts(uuid),
  hr.request_swap(uuid, uuid, text), hr.respond_swap(uuid, boolean), hr.withdraw_swap(uuid),
  hr.my_swaps(), hr.approve_swap(uuid, text),
  hr.request_role_change(text, uuid, text, uuid, boolean, date, date, uuid, text, text)
  to app_rw;
grant execute on function hr.execute(text, uuid) to wf_executor;

-- migrate:down
drop function hr.execute(text, uuid);
drop function hr.request_role_change(text, uuid, text, uuid, boolean, date, date, uuid, text, text);
drop function hr.approve_swap(uuid, text);
drop function hr.my_swaps();
drop function hr.withdraw_swap(uuid);
drop function hr.respond_swap(uuid, boolean);
drop function hr.request_swap(uuid, uuid, text);
drop function hr.leave_conflicts(uuid);
drop function hr.leave_balances(uuid, int);
drop function hr.request_leave(uuid, date, date, text, text);
drop function hr.user_name(uuid);
drop function hr.notify_group(uuid, text, text, text, text, text);
drop function hr.leave_shifts(uuid);
drop function hr.leave_available(uuid, uuid, int, uuid);
drop function hr.my_worker();
