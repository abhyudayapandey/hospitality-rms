-- migrate:up
-- Stock hub, HR's People and Leave, and swaps for management (UX-4, UX-5, SW-4; ADR 035).
--
-- Company settings gain two:
--   swaps_managers_only (default on): only people who change the roster at a shift's place
--     may offer it in a swap (SW-4); frontline staff can still accept one offered to them.
--   count_due_days (default 7): a store's count is due this many days after its last one.
-- HR (anyone holding WORKERS modify, now the outlet manager too) asks for a person to be
-- deactivated through a DEACTIVATION request, approved like a role change (the security
-- admin); the executor makes the login and the worker inactive.
-- hr.team_people and hr.team_leave list a place's people and their leave for Team.

-- ---------------------------------------------------------------------------
-- Company settings (SW-4, UX-4)
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
    'count_due_days', 7);
$$;

do $$
declare
  v_src text := pg_get_functiondef('core.set_company_settings(jsonb)'::regprocedure);
  v_old text := '    elsif v_key = ''po_send_prices'' then
      if jsonb_typeof(v_val) <> ''boolean'' then
        raise exception ''INVALID_SETTING'' using detail = v_key;
      end if;';
  v_new text := '    elsif v_key in (''po_send_prices'', ''swaps_managers_only'') then
      if jsonb_typeof(v_val) <> ''boolean'' then
        raise exception ''INVALID_SETTING'' using detail = v_key;
      end if;
    elsif v_key = ''count_due_days'' then
      if jsonb_typeof(v_val) <> ''number'' or (v_val #>> ''{}'')::numeric not between 1 and 60
         or (v_val #>> ''{}'')::numeric <> trunc((v_val #>> ''{}'')::numeric) then
        raise exception ''INVALID_SETTING'' using detail = v_key;
      end if;';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'core.set_company_settings changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- ---------------------------------------------------------------------------
-- Swaps for management only (SW-4)
-- ---------------------------------------------------------------------------

do $$
declare
  v_src text := pg_get_functiondef('hr.request_swap(uuid, uuid, text)'::regprocedure);
  v_old text := '    perform hr.fail(''NOT_AUTHORISED'', ''cannot swap'');
  end if;';
  v_new text := '    perform hr.fail(''NOT_AUTHORISED'', ''cannot swap'');
  end if;
  -- SW-4: with swaps for management only (the default), only someone who changes the
  -- roster at the shift''s place offers a swap
  if coalesce((core.settings_of(v_w.tenant_id) ->> ''swaps_managers_only'')::boolean, true)
     and not core.can(''ROSTER'', ''modify'', v_a.org_node_id, null) then
    perform hr.fail(''SWAPS_MANAGERS_ONLY'', ''only people who change the roster swap shifts'');
  end if;';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'hr.request_swap changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- ---------------------------------------------------------------------------
-- Deactivation through approval (UX-5)
-- ---------------------------------------------------------------------------

create table hr.deactivation (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),  -- the person's home
  target_user_id uuid not null references core.app_user(id),
  worker_id uuid not null references hr.worker(id),
  reason text not null check (length(reason) between 1 and 500),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'applied', 'rejected', 'cancelled')),
  wf_request_id uuid references wf.request(id),
  applied_at timestamptz
);
select core.add_standard_columns('hr.deactivation');
create unique index deactivation_open on hr.deactivation (target_user_id)
  where status in ('draft', 'submitted');

insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('hr.deactivation', 'WORKERS', 'org', true);
select core.apply_domain_rls('hr.deactivation');
select audit.enable('hr.deactivation', false);
create trigger same_tenant before insert or update on hr.deactivation
  for each row execute function hr.check_same_tenant();

create function hr.deactivation_subject(p_id uuid) returns wf.subject_info
language sql stable
set search_path = pg_catalog, hr, core
as $$
  select tenant_id, org_node_id, null::uuid, null::uuid, null::uuid, null::numeric, null::text,
         status = 'draft' and wf_request_id is null and created_by = core.current_user_id()
    from hr.deactivation where id = p_id;
$$;

-- The person being deactivated does not approve it.
create function hr.deactivation_excluded(p_id uuid) returns uuid[]
language sql stable
set search_path = pg_catalog, hr
as $$
  select array[target_user_id] from hr.deactivation where id = p_id;
$$;

revoke execute on function hr.deactivation_subject(uuid), hr.deactivation_excluded(uuid)
  from public;

insert into core.subject_resolver (subject_type, resolver, excluded_resolver) values
  ('hr.deactivation', 'hr.deactivation_subject(uuid)', 'hr.deactivation_excluded(uuid)');

-- Asks for a person to be deactivated: anyone holding WORKERS modify where the person works
-- (HR, the outlet manager), never for themselves, never across companies, one open request
-- per person. Approved like a role change; the executor makes them inactive.
create function hr.request_deactivation(p_user uuid, p_reason text,
                                        p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_w hr.worker;
  v_id uuid;
  v_request uuid;
begin
  if p_idempotency_key is not null then
    select d.id into v_id from hr.deactivation d join wf.request r on r.id = d.wf_request_id
     where r.initiator_id = v_me.id and r.idempotency_key = p_idempotency_key;
    if found then
      return v_id;
    end if;
  end if;
  select * into v_w from hr.worker where owner_user_id = p_user and tenant_id = v_me.tenant_id;
  -- another company's person, or someone without a worker record: as if absent
  if not found or not core.can('WORKERS', 'modify', v_w.org_node_id, null) then
    perform hr.fail('NOT_AUTHORISED', 'deactivate');
  end if;
  if p_user = v_me.id then
    perform hr.fail('SELF_GRANT', 'you cannot deactivate yourself');
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    perform hr.fail('REASON_REQUIRED', 'say why');
  end if;
  if (select status from core.app_user where id = p_user) <> 'active'
     or exists (select 1 from hr.deactivation
                 where target_user_id = p_user and status in ('draft', 'submitted')) then
    perform hr.fail('INVALID_STATE', 'already inactive or waiting for approval');
  end if;
  insert into hr.deactivation (tenant_id, org_node_id, target_user_id, worker_id, reason)
  values (v_me.tenant_id, v_w.org_node_id, p_user, v_w.id, trim(p_reason))
  returning id into v_id;
  -- the approver sees who and why on Approvals
  v_request := wf.submit('DEACTIVATION', 'hr.deactivation', v_id,
                         jsonb_build_object('person', hr.user_name(p_user),
                                            'reason', trim(p_reason)),
                         p_idempotency_key);
  update hr.deactivation set status = 'submitted', wf_request_id = v_request where id = v_id;
  return v_id;
end $$;

revoke execute on function hr.request_deactivation(uuid, text, text) from public;
grant execute on function hr.request_deactivation(uuid, text, text) to app_rw;

-- The executor's handlers: apply makes the login and the worker inactive (signed out on
-- their next request, ADR 011), reject closes the request; both tell the requester.
do $$
declare
  v_src text := pg_get_functiondef('hr.execute(text, uuid)'::regprocedure);
  v_old text := '  else
    perform hr.fail(''HANDLER_NOT_FOUND'', p_handler);';
  v_new text := '  when ''hr.deactivation.apply'' then
    update hr.deactivation set status = ''applied'', applied_at = now()
     where wf_request_id = p_request_id and status = ''submitted''
     returning target_user_id, worker_id, created_by, tenant_id
          into v_dx_user, v_dx_worker, v_dx_by, v_dx_tenant;
    if found then
      update core.app_user set status = ''inactive'' where id = v_dx_user and status = ''active'';
      update hr.worker set status = ''inactive'' where id = v_dx_worker and status = ''active'';
      perform ops.notify(v_dx_tenant, v_dx_by, ''deactivation_applied'',
        hr.user_name(v_dx_user) || '' is deactivated'', null, ''/team/people'');
    end if;

  when ''hr.deactivation.reject'' then
    update hr.deactivation set status = v_closed
     where wf_request_id = p_request_id and status = ''submitted''
     returning target_user_id, created_by, tenant_id into v_dx_user, v_dx_by, v_dx_tenant;
    if found then
      perform ops.notify(v_dx_tenant, v_dx_by, ''deactivation_'' || v_closed,
        hr.user_name(v_dx_user) || '' stays active'', ''Not approved.'', ''/team/people'');
    end if;

  else
    perform hr.fail(''HANDLER_NOT_FOUND'', p_handler);';
  v_old2 text := '  v_rc hr.role_change;';
  v_new2 text := '  v_rc hr.role_change;
  v_dx_user uuid;
  v_dx_worker uuid;
  v_dx_by uuid;
  v_dx_tenant uuid;';
begin
  if position(v_old in v_src) = 0 or position(v_old2 in v_src) = 0 then
    raise exception 'hr.execute changed; update this migration';
  end if;
  execute replace(replace(v_src, v_old, v_new), v_old2, v_new2);
end $$;

-- ---------------------------------------------------------------------------
-- Team -> People and Leave (UX-5)
-- ---------------------------------------------------------------------------

-- The people working at a place and below, for anyone who sees worker records there
-- (WORKERS view); can_deactivate where they also change them (WORKERS modify).
create function hr.team_people(p_node uuid)
returns table (worker_id uuid, user_id uuid, name text, username text, job_role text,
               place_id uuid, place text, employment_type text, joined_on date,
               status text, waiting boolean, can_deactivate boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
declare
  v_node core.hierarchy_node;
begin
  select * into v_node from core.hierarchy_node
   where id = p_node and tenant_id = core.my_tenant() and type = 'org';
  if not found or not core.can('WORKERS', 'view', p_node, null) then
    perform hr.fail('NOT_AUTHORISED', 'people');
  end if;
  return query
    select w.id, u.id, u.display_name, u.username, coalesce(j.name, w.role_code), n.id, n.name,
           w.employment_type, w.joined_on, u.status,
           exists (select 1 from hr.deactivation d
                    where d.target_user_id = u.id and d.status = 'submitted'),
           u.status = 'active' and u.id <> core.current_user_id()
             and core.can('WORKERS', 'modify', w.org_node_id, null)
             and not exists (select 1 from hr.deactivation d
                              where d.target_user_id = u.id and d.status = 'submitted')
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id
      join core.hierarchy_node n on n.id = w.org_node_id
      left join hr.job_role j on j.tenant_id = w.tenant_id and j.code = w.role_code
     where w.tenant_id = v_node.tenant_id and n.path <@ v_node.path
       and core.can('WORKERS', 'view', w.org_node_id, null)
     order by u.status, n.name, u.display_name;
end $$;

revoke execute on function hr.team_people(uuid) from public;
grant execute on function hr.team_people(uuid) to app_rw;

-- Leave at a place and below over a period (waiting and approved), for anyone who sees
-- leave there (LEAVE view): who is off when.
create function hr.team_leave(p_node uuid, p_from date, p_to date)
returns table (leave_id uuid, worker_id uuid, name text, job_role text, place text,
               leave_type text, from_date date, to_date date, days numeric, status text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
declare
  v_node core.hierarchy_node;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    perform hr.fail('INVALID_DATES', 'up to three months');
  end if;
  select * into v_node from core.hierarchy_node
   where id = p_node and tenant_id = core.my_tenant() and type = 'org';
  if not found or not core.can('LEAVE', 'view', p_node, null) then
    perform hr.fail('NOT_AUTHORISED', 'leave');
  end if;
  return query
    select l.id, w.id, u.display_name, coalesce(j.name, w.role_code), n.name, t.name,
           l.from_date, l.to_date, l.days, l.status
      from hr.leave_request l
      join hr.worker w on w.id = l.worker_id
      join core.app_user u on u.id = w.owner_user_id
      join core.hierarchy_node n on n.id = l.org_node_id
      join hr.leave_type t on t.id = l.leave_type_id
      left join hr.job_role j on j.tenant_id = w.tenant_id and j.code = w.role_code
     where l.tenant_id = v_node.tenant_id and n.path <@ v_node.path
       and l.status in ('submitted', 'approved')
       and l.from_date <= p_to and l.to_date >= p_from
       and core.can('LEAVE', 'view', l.org_node_id, null)
     order by l.from_date, u.display_name;
end $$;

revoke execute on function hr.team_leave(uuid, date, date) from public;
grant execute on function hr.team_leave(uuid, date, date) to app_rw;

-- The place switcher for Team -> People and Leave: team places and outlets where the person
-- sees worker records (team_people) or leave (team_leave).
do $$
declare
  v_src text := pg_get_functiondef('core.screen_places(text)'::regprocedure);
  v_old1 text := '''tasks'', ''tasks_new'', ''checklists'', ''maintenance'', ''report'') then
    raise exception';
  v_new1 text := '''tasks'', ''tasks_new'', ''checklists'', ''maintenance'', ''report'',
      ''team_people'', ''team_leave'') then
    raise exception';
  -- HR and managers open on their whole outlet first
  v_old3 text := '           case when n.id = v_home then 0';
  v_new3 text := '           case when p_screen in (''team_people'', ''team_leave'') and n.id = v_outlet then 0
                when n.id = v_home then 0';
  v_old2 text := '         else
           core.is_team_place(n.id)';
  v_new2 text := '         when p_screen in (''team_people'', ''team_leave'') then
           n.type = ''org'' and (core.is_team_place(n.id) or n.kind in (''outlet'', ''site''))
           and core.can(case p_screen when ''team_people'' then ''WORKERS'' else ''LEAVE'' end,
                        ''view'', n.id, null)
         else
           core.is_team_place(n.id)';
begin
  if position(v_old1 in v_src) = 0 or position(v_old2 in v_src) = 0
     or position(v_old3 in v_src) = 0 then
    raise exception 'core.screen_places changed; update this migration';
  end if;
  execute replace(replace(replace(v_src, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
end $$;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function hr.team_leave(uuid, date, date);
drop function hr.team_people(uuid);
drop function hr.request_deactivation(uuid, text, text);
delete from core.subject_resolver where subject_type = 'hr.deactivation';
drop function hr.deactivation_subject(uuid), hr.deactivation_excluded(uuid);
delete from core.domain_table where table_name = 'hr.deactivation'::regclass;
drop table hr.deactivation;

CREATE OR REPLACE FUNCTION core.settings_defaults()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select jsonb_build_object(
    'targets', jsonb_build_object('food', 30, 'drink', 22, 'labour', 25, 'prime', 60,
                                  'wastage', 2, 'tasks', 90),
    'menu_popular_pct', 70,
    'overtime_multiplier', 1,
    'po_send_prices', false);
$function$

;

CREATE OR REPLACE FUNCTION core.set_company_settings(p_settings jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core'
AS $function$
declare
  v_tenant uuid := core.my_tenant();
  v_key text;
  v_val jsonb;
  v_target text;
  v_new jsonb;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'INVALID_SETTING' using detail = 'an object of settings';
  end if;
  for v_key, v_val in select * from jsonb_each(p_settings) loop
    if v_key = 'targets' then
      if jsonb_typeof(v_val) <> 'object' then
        raise exception 'INVALID_SETTING' using detail = 'targets';
      end if;
      for v_target in select jsonb_object_keys(v_val) loop
        if v_target not in ('food', 'drink', 'labour', 'prime', 'wastage', 'tasks')
           or jsonb_typeof(v_val -> v_target) <> 'number'
           or (v_val ->> v_target)::numeric not between 0 and 100 then
          raise exception 'INVALID_SETTING' using detail = 'targets.' || v_target;
        end if;
      end loop;
    elsif v_key = 'menu_popular_pct' then
      if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric not between 10 and 100 then
        raise exception 'INVALID_SETTING' using detail = v_key;
      end if;
    elsif v_key = 'overtime_multiplier' then
      if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric not between 1 and 3 then
        raise exception 'INVALID_SETTING' using detail = v_key;
      end if;
    elsif v_key = 'po_send_prices' then
      if jsonb_typeof(v_val) <> 'boolean' then
        raise exception 'INVALID_SETTING' using detail = v_key;
      end if;
    else
      raise exception 'INVALID_SETTING' using detail = v_key;
    end if;
  end loop;
  if v_tenant is null
     or not core.can('COMPANY_SETTINGS', 'modify', core.org_root(v_tenant), null, null) then
    raise exception 'NOT_AUTHORISED' using detail = 'COMPANY_SETTINGS modify at the company';
  end if;
  select t.settings
         || (p_settings - 'targets')
         || case when p_settings ? 'targets'
                 then jsonb_build_object('targets',
                        coalesce(t.settings -> 'targets', '{}') || (p_settings -> 'targets'))
                 else '{}' end
    into v_new
    from core.tenant t where t.id = v_tenant;
  update core.tenant set settings = v_new where id = v_tenant and settings is distinct from v_new;
end $function$

;

CREATE OR REPLACE FUNCTION hr.request_swap(p_assignment uuid, p_to_worker uuid, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr'
AS $function$
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
  select * into v_bad from hr.assignment_blocker(p_to_worker, v_s.start_at, v_s.end_at,
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
end $function$

;

CREATE OR REPLACE FUNCTION hr.execute(p_handler text, p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr', 'wf'
AS $function$
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
      perform hr.notify_roster_owner(v_l.org_node_id, v_l.owner_user_id, 'roster_gap',
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
    select * into v_bad from hr.assignment_blocker(v_sw.to_worker_id, v_s.start_at, v_s.end_at,
                                                      v_s.org_node_id, v_s.role_code);
    if v_bad.code is not null then
      perform hr.fail(v_bad.code, v_bad.detail);
    end if;
    update hr.shift_assignment set status = 'swapped', drop_reason = 'swap', swap_id = v_sw.id
     where id = v_a.id;
    insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                     start_at, end_at, swap_id, warnings_accepted)
    values (v_sw.tenant_id, v_s.id, v_sw.to_worker_id, v_sw.to_user_id, v_s.org_node_id,
            v_s.start_at, v_s.end_at, v_sw.id, v_sw.warnings_accepted)
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
end $function$

;

CREATE OR REPLACE FUNCTION core.screen_places(p_screen text)
 RETURNS TABLE(id uuid, code text, name text, kind text, type text, timezone text, preferred integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr', 'inv', 'menu', 'ops'
AS $function$
declare
  v_home uuid := (select w.org_node_id from hr.worker w
                   where w.owner_user_id = core.current_user_id());
  v_outlet uuid := core.nearest(v_home, array['outlet', 'site']);
  v_stores uuid[];
  v_main uuid;
begin
  if p_screen is null or p_screen not in ('stock', 'count', 'wastage', 'orders', 'transfers',
      'variance', 'production', 'sales', 'menu', 'roster', 'exceptions', 'events',
      'tasks', 'tasks_new', 'checklists', 'maintenance', 'report') then
    raise exception 'INVALID_SCREEN' using detail = coalesce(p_screen, 'none');
  end if;
  v_stores := array(select nl.delivery_node_id from core.node_link nl
                     where nl.org_node_id = v_home);
  v_main := (select core.stock_location_of(nl.delivery_node_id) from core.node_link nl
               join core.hierarchy_node d on d.id = nl.delivery_node_id
              where nl.org_node_id = v_outlet and d.kind in ('outlet', 'hub')
              order by d.id limit 1);
  return query
    select n.id, n.code, n.name, n.kind, n.type,
           coalesce(n.timezone, (select t.default_timezone from core.tenant t
                                  where t.id = n.tenant_id)),
           case when n.id = v_home then 0
                when n.id = v_outlet then 1
                when n.id = any (v_stores) then 2
                when n.id = v_main then 3
                -- a manager's home is the outlet, which these screens don't list: open
                -- the departments with something on them before the empty ones
                when p_screen = 'roster' and exists (
                       select 1 from hr.shift s
                        where s.org_node_id = n.id
                          and s.local_date between current_date - 7 and current_date + 7) then 5
                when p_screen = 'exceptions' and exists (
                       select 1 from hr.attendance_exception x
                        where x.org_node_id = n.id and x.status = 'open') then 5
                else 9 end
      from core.hierarchy_node n
     where n.tenant_id = core.my_tenant() and n.archived_at is null
       and case
         when p_screen in ('stock', 'count', 'wastage', 'orders', 'transfers', 'variance',
                           'production') then
           n.type = 'delivery' and n.holds_stock and case p_screen
             when 'stock' then core.can('STOCK_LEVELS', 'view', null, n.id)
             when 'count' then core.can('STOCK_ADJUSTMENTS', 'modify', null, n.id)
             when 'wastage' then core.can('STOCK_ADJUSTMENTS', 'modify', null, n.id)
             when 'orders' then core.can('PURCHASE_ORDERS', 'view', null, n.id)
             when 'transfers' then core.can('TRANSFERS', 'view', null, n.id)
             when 'variance' then core.can('MENU', 'view', null, n.id)
             else exists (select 1 from inv.item_node x
                           where x.delivery_node_id = n.id and x.made_here
                             and x.archived_at is null)
                  and inv.can_produce_at(n.id) end
         when p_screen in ('sales', 'menu') then
           n.type = 'org'
           and exists (select 1 from menu.menu_outlet mo
                        where mo.org_node_id = n.id
                          and (mo.effective_to is null or mo.effective_to >= current_date)
                          and core.can(case p_screen when 'sales' then 'SALES' else 'MENU' end,
                                       case p_screen when 'sales' then 'modify' else 'view' end,
                                       null, mo.delivery_node_id))
         when p_screen = 'events' then
           n.type = 'org' and n.kind in ('outlet', 'site') and ops.can_read_event_node(n.id)
         when p_screen in ('tasks', 'tasks_new', 'checklists', 'maintenance', 'report') then
           n.type = 'org' and (core.is_team_place(n.id) or n.kind in ('outlet', 'site'))
           and case p_screen
             when 'tasks' then core.can('TASKS', 'view', n.id, null)
             when 'tasks_new' then core.can('TASKS', 'modify', n.id, null)
             when 'checklists' then core.can('CHECKLIST_TEMPLATES', 'view', n.id, null)
             when 'maintenance' then core.can('MAINTENANCE', 'view', n.id, null)
             else ops.works_at(n.id) end
         else
           core.is_team_place(n.id)
           and case p_screen
             when 'roster' then core.can('ROSTER', 'view', n.id, null)
             else core.can('ATTENDANCE', 'modify', n.id, null) end
       end
     order by 7, n.name;
end $function$;
