-- migrate:up
-- User administration and its guardrails (ADR 009 part 2). The Platform Admin console and
-- the admin screens (next prompt) call these; the app never writes access directly.
--
--   (a) admin rights are not data access: admin groups hold admin domains only
--       (ADMIN_NOT_DATA, 20261001120000), so granting or holding them shows no data
--   (b) an admin acts only on places and people inside their USER_ACCESS scope, never on
--       themselves (SELF_GRANT), and never above their own admin rank (ABOVE_OWN_RANK):
--       ACCOUNT_OWNER 3, USER_ADMIN 2, everyone else 1. So a User Admin can't grant
--       ACCOUNT_OWNER nor touch an Account Owner; granting USER_ADMIN is sensitive (c)
--   (c) sensitive grants (OUTLET_MANAGER, USER_ADMIN, ACCOUNT_OWNER, HR_ADMIN, OUTLET_HR,
--       and any group with COMPENSATION access) go through ROLE_CHANGE: SECURITY_ADMIN,
--       then ACCOUNT_OWNER. Everyday grants apply at once. A sole Account Owner, with no
--       one else who could approve, applies their own sensitive grants directly (noted)
--   (d) the last active ACCOUNT_OWNER can't be removed, ended or deactivated
--   (e) every admin action is audited (role_assignment, app_user, hr.worker, role_change
--       and workflow steps all carry audit.capture); core.access_audit shows the access
--       events, never business rows, within the caller's scope

create function core.group_rank(p_code text) returns int
language sql immutable
as $$
  select case p_code when 'ACCOUNT_OWNER' then 3 when 'USER_ADMIN' then 2 else 1 end;
$$;

-- A person's admin rank from the groups they hold today.
create function core.admin_rank(p_user uuid) returns int
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce(max(core.group_rank(g.code)), 1)
    from core.role_assignment ra
    join core.security_group g on g.id = ra.group_id
   where ra.user_id = p_user and ra.effective_from <= current_date
     and (ra.effective_to is null or ra.effective_to >= current_date);
$$;

create function core.is_sensitive_group(p_group uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select g.code in ('OUTLET_MANAGER', 'USER_ADMIN', 'ACCOUNT_OWNER', 'HR_ADMIN', 'OUTLET_HR')
         or (g.kind <> 'user_based' -- SELF: one's own pay only
             and exists (select 1 from core.domain_policy dp
                      join core.domain d on d.id = dp.domain_id and d.code = 'COMPENSATION'
                     where dp.group_id = g.id))
    from core.security_group g where g.id = p_group;
$$;

-- Where a person belongs for user administration: their worker's home, else the company.
create function core.home_node(p_user uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select coalesce((select w.org_node_id from hr.worker w where w.owner_user_id = p_user),
                  (select core.org_root(u.tenant_id) from core.app_user u where u.id = p_user));
$$;

-- The org node that routes approvals for a place: itself, or its link anchor's org node.
create function core.approval_org_node(p_node uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select case when n.type = 'org' then n.id else
    coalesce((select min(nl.org_node_id::text)::uuid from core.node_link nl
               where nl.delivery_node_id = core.link_anchor(n.id)),
             core.org_root(n.tenant_id)) end
    from core.hierarchy_node n where n.id = p_node;
$$;

-- (b) The checks every admin action makes, as the current user.
create function core.check_admin_action(p_target uuid, p_node uuid, p_group uuid)
returns void
language plpgsql stable security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_rank int := core.admin_rank(v_me.id);
begin
  if p_target = v_me.id then
    perform wf.fail('SELF_GRANT', 'you cannot change your own access');
  end if;
  if not exists (select 1 from core.app_user where id = p_target and tenant_id = v_me.tenant_id)
     or (p_node is not null and not exists (select 1 from core.hierarchy_node
                                             where id = p_node and tenant_id = v_me.tenant_id))
     or (p_group is not null and not exists (select 1 from core.security_group
                                              where id = p_group and tenant_id = v_me.tenant_id)) then
    perform wf.fail('TENANT_MISMATCH', 'user, place or group belongs to another organisation');
  end if;
  if p_node is not null and not core.in_user_access_scope(p_node, 'modify') then
    perform wf.fail('NOT_AUTHORISED', 'the place is outside your user administration');
  end if;
  if not core.in_user_access_scope(core.home_node(p_target), 'modify') then
    perform wf.fail('NOT_AUTHORISED', 'the person is outside your user administration');
  end if;
  if core.admin_rank(p_target) > v_rank
     or (p_group is not null
         and core.group_rank((select code from core.security_group where id = p_group)) > v_rank) then
    perform wf.fail('ABOVE_OWN_RANK', 'beyond your own administration rights');
  end if;
end $$;

-- True when a sensitive change by the caller could be approved by nobody else, and the
-- caller is an Account Owner: the sole-owner case (c).
create function core.sole_owner_applies(p_target uuid, p_node uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, wf
as $$
  select core.admin_rank(core.current_user_id()) = 3
     and (select r.o_node from wf.route_chain(
            core.my_tenant(), 'ROLE_CHANGE', 'security_approval',
            wf.group_id(core.my_tenant(), 'SECURITY_ADMIN'), null, 'nearest_ancestor',
            core.approval_org_node(p_node), array[core.current_user_id(), p_target]) r) is null;
$$;

-- hr.request_role_change uses the same checks; delivery places route through their anchor.
do $$
declare
  v_src text := pg_get_functiondef('hr.request_role_change(text, uuid, text, uuid, boolean, date, date, uuid, text, text)'::regprocedure);
  v_old_check text := 'if not core.can(''USER_ACCESS'', ''modify'', v_org, null) then
    perform hr.fail(''NOT_AUTHORISED'', ''USER_ACCESS modify required'');
  end if;';
  v_old_org text := 'where nl.delivery_node_id = v_node.id), core.org_root(v_me.tenant_id)) end;';
begin
  if position(v_old_check in v_src) = 0 or position(v_old_org in v_src) = 0 then
    raise exception 'hr.request_role_change changed; update this migration';
  end if;
  v_src := replace(v_src, v_old_check,
    'perform core.check_admin_action(coalesce(v_ra.user_id, p_target_user), v_node.id, v_group);');
  v_src := replace(v_src, v_old_org,
    'where nl.delivery_node_id = core.link_anchor(v_node.id)), core.org_root(v_me.tenant_id)) end;');
  execute v_src;
end $$;

-- Grants a group at a place. Everyday groups apply now; sensitive ones become a ROLE_CHANGE
-- request (or apply now for a sole Account Owner). Returns {status, assignment_id |
-- role_change_id}.
create function core.grant_access(p_user uuid, p_group_code text, p_node uuid,
                                  p_include_descendants boolean default true,
                                  p_effective_from date default null,
                                  p_effective_to date default null,
                                  p_reason text default null,
                                  p_idempotency_key text default null) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_group uuid := (select id from core.security_group
                    where tenant_id = v_me.tenant_id and code = p_group_code);
  v_id uuid;
  v_from date := coalesce(p_effective_from, current_date);
begin
  if v_group is null or p_group_code = 'AI_AGENT' then
    perform wf.fail('INVALID_GROUP', p_group_code);
  end if;
  perform core.check_admin_action(p_user, p_node, v_group);
  if p_effective_to is not null and p_effective_to < v_from then
    perform wf.fail('INVALID_DATES', 'the end date is before the start');
  end if;
  -- already held there (a retry): report it
  select id into v_id from core.role_assignment
   where user_id = p_user and group_id = v_group and node_id = p_node
     and (effective_to is null or effective_to >= v_from);
  if found then
    return jsonb_build_object('status', 'applied', 'assignment_id', v_id);
  end if;

  if core.is_sensitive_group(v_group) and not core.sole_owner_applies(p_user, p_node) then
    v_id := hr.request_role_change('grant', p_user, p_group_code, p_node, p_include_descendants,
                                   v_from, p_effective_to, null, p_reason, p_idempotency_key);
    return jsonb_build_object('status', 'pending', 'role_change_id', v_id);
  end if;
  insert into core.role_assignment (tenant_id, user_id, group_id, node_id, include_descendants,
                                    effective_from, effective_to, source_note)
  values (v_me.tenant_id, p_user, v_group, p_node, p_include_descendants, v_from, p_effective_to,
          case when core.is_sensitive_group(v_group)
               then 'sole account owner: no one else can approve'
               else nullif(trim(p_reason), '') end)
  returning id into v_id;
  return jsonb_build_object('status', 'applied', 'assignment_id', v_id);
end $$;

-- Ends an assignment now (from tomorrow on it no longer applies; one that has not started
-- is removed). Sensitive ones go through ROLE_CHANGE, as for grants.
create function core.revoke_access(p_assignment uuid, p_reason text default null,
                                   p_idempotency_key text default null) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_ra core.role_assignment;
  v_end date;
  v_id uuid;
begin
  perform wf.me();
  select * into v_ra from core.role_assignment where id = p_assignment;
  if not found or v_ra.tenant_id <> core.my_tenant() then
    perform wf.fail('NOT_FOUND', 'assignment');
  end if;
  perform core.check_admin_action(v_ra.user_id, v_ra.node_id, v_ra.group_id);
  v_end := greatest(current_date - 1, v_ra.effective_from);
  if v_ra.effective_to is not null and v_ra.effective_to <= v_end then
    return jsonb_build_object('status', 'applied', 'assignment_id', v_ra.id);
  end if;
  if core.is_sensitive_group(v_ra.group_id)
     and not core.sole_owner_applies(v_ra.user_id, v_ra.node_id) then
    v_id := hr.request_role_change('end', null, null, null, true, null, v_end, v_ra.id,
                                   p_reason, p_idempotency_key);
    return jsonb_build_object('status', 'pending', 'role_change_id', v_id);
  end if;
  if v_ra.effective_from > current_date - 1 then
    delete from core.role_assignment where id = v_ra.id; -- never started (audited)
  else
    update core.role_assignment set effective_to = v_end where id = v_ra.id;
  end if;
  return jsonb_build_object('status', 'applied', 'assignment_id', v_ra.id);
end $$;

-- Creates a person (core.app_user + hr.worker) with their job role's default access.
-- Sensitive defaults become ROLE_CHANGE requests, like any sensitive grant.
create function core.create_user(p_username text, p_display_name text, p_home_node uuid,
                                 p_job_role text, p_login_type text default 'username',
                                 p_email text default null,
                                 p_employment_type text default 'full_time',
                                 p_joined_on date default null) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_user uuid;
  v_d record;
  v_group uuid;
  v_err text;
  v_applied int := 0;
  v_pending uuid[] := '{}';
begin
  if not exists (select 1 from core.hierarchy_node where id = p_home_node
                    and tenant_id = v_me.tenant_id and type = 'org') then
    perform wf.fail('NOT_FOUND', 'home place');
  end if;
  if not core.in_user_access_scope(p_home_node, 'modify') then
    perform wf.fail('NOT_AUTHORISED', 'the place is outside your user administration');
  end if;
  if not exists (select 1 from hr.job_role where tenant_id = v_me.tenant_id and code = p_job_role
                    and archived_at is null) then
    perform wf.fail('INVALID_JOB_ROLE', p_job_role);
  end if;
  if exists (select 1 from core.app_user where tenant_id = v_me.tenant_id
                and username = lower(trim(p_username))) then
    perform wf.fail('USERNAME_TAKEN', p_username);
  end if;

  insert into core.app_user (tenant_id, kind, display_name, username, email, login_type)
  values (v_me.tenant_id, 'human', trim(p_display_name), lower(trim(p_username)),
          nullif(trim(p_email), ''), p_login_type)
  returning id into v_user;
  insert into hr.worker (tenant_id, owner_user_id, org_node_id, role_code, employment_type,
                         joined_on)
  values (v_me.tenant_id, v_user, p_home_node, p_job_role, p_employment_type,
          coalesce(p_joined_on, current_date));

  select string_agg(d.error, '; ') into v_err
    from core.derive_job_role_access(v_user) d where d.error is not null;
  if v_err is not null then
    perform wf.fail('JOB_ROLE_SCOPE', v_err);
  end if;
  for v_d in select * from core.derive_job_role_access(v_user) loop
    v_group := (select id from core.security_group
                 where tenant_id = v_me.tenant_id and code = v_d.access_group);
    perform core.check_admin_action(v_user, v_d.node_id, v_group);
    if core.is_sensitive_group(v_group) and not core.sole_owner_applies(v_user, v_d.node_id) then
      v_pending := v_pending || hr.request_role_change(
        'grant', v_user, v_d.access_group, v_d.node_id, v_d.include_descendants,
        coalesce(p_joined_on, current_date), null, null, 'job role default', null);
    else
      insert into core.role_assignment (tenant_id, user_id, group_id, node_id,
                                        include_descendants, effective_from, source,
                                        source_note)
      select v_me.tenant_id, v_user, v_group, v_d.node_id, v_d.include_descendants,
             coalesce(p_joined_on, current_date), 'job_role', v_d.source
       where not exists (select 1 from core.role_assignment
                          where user_id = v_user and group_id = v_group and node_id = v_d.node_id);
      v_applied := v_applied + 1;
    end if;
  end loop;
  return jsonb_build_object('user_id', v_user, 'applied', v_applied, 'pending', to_jsonb(v_pending));
end $$;

-- Deactivates (or reactivates) a person: an inactive user has no access at all.
create function core.set_user_status(p_user uuid, p_status text, p_reason text default null)
returns text
language plpgsql security definer
set search_path = pg_catalog, core, wf
as $$
begin
  perform wf.me();
  if p_status not in ('active', 'inactive') then
    perform wf.fail('INVALID_STATE', p_status);
  end if;
  perform core.check_admin_action(p_user, null, null);
  update core.app_user set status = p_status where id = p_user and status <> p_status;
  return p_status;
end $$;

-- (d) The last active Account Owner stays.
create function core.guard_account_owner() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
declare
  v_tenant uuid := old.tenant_id;
  v_was boolean;
begin
  if tg_table_name = 'role_assignment' then
    v_was := (select code from core.security_group where id = old.group_id) = 'ACCOUNT_OWNER'
             and old.effective_from <= current_date
             and (old.effective_to is null or old.effective_to >= current_date);
  else
    v_was := old.status = 'active' and new.status <> 'active'
             and exists (select 1 from core.role_assignment ra
                           join core.security_group g on g.id = ra.group_id
                          where ra.user_id = old.id and g.code = 'ACCOUNT_OWNER'
                            and ra.effective_from <= current_date
                            and (ra.effective_to is null or ra.effective_to >= current_date));
  end if;
  if v_was and not exists (
       select 1 from core.role_assignment ra
         join core.security_group g on g.id = ra.group_id and g.code = 'ACCOUNT_OWNER'
         join core.app_user u on u.id = ra.user_id and u.status = 'active'
        where ra.tenant_id = v_tenant and ra.effective_from <= current_date
          and (ra.effective_to is null or ra.effective_to >= current_date)) then
    raise exception 'LAST_ACCOUNT_OWNER'
      using detail = 'the organisation must keep at least one active Account Owner';
  end if;
  return null;
end $$;

create trigger last_account_owner after update or delete on core.role_assignment
  for each row execute function core.guard_account_owner();
create trigger last_account_owner after update of status on core.app_user
  for each row execute function core.guard_account_owner();

-- (e) Access events (grants, removals, people created or deactivated, role changes and
-- their approvals) within the caller's USER_ACCESS scope, newest first. Never business rows.
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

revoke execute on function core.group_rank(text), core.admin_rank(uuid),
  core.is_sensitive_group(uuid), core.home_node(uuid), core.approval_org_node(uuid),
  core.check_admin_action(uuid, uuid, uuid), core.sole_owner_applies(uuid, uuid),
  core.grant_access(uuid, text, uuid, boolean, date, date, text, text),
  core.revoke_access(uuid, text, text),
  core.create_user(text, text, uuid, text, text, text, text, date),
  core.set_user_status(uuid, text, text), core.access_audit(int) from public;
grant execute on function core.grant_access(uuid, text, uuid, boolean, date, date, text, text),
  core.revoke_access(uuid, text, text),
  core.create_user(text, text, uuid, text, text, text, text, date),
  core.set_user_status(uuid, text, text), core.access_audit(int) to app_rw;

-- migrate:down
drop function core.access_audit(int);
drop trigger last_account_owner on core.app_user;
drop trigger last_account_owner on core.role_assignment;
drop function core.guard_account_owner();
drop function core.set_user_status(uuid, text, text);
drop function core.create_user(text, text, uuid, text, text, text, text, date);
drop function core.revoke_access(uuid, text, text);
drop function core.grant_access(uuid, text, uuid, boolean, date, date, text, text);
do $$
declare
  v_src text := pg_get_functiondef('hr.request_role_change(text, uuid, text, uuid, boolean, date, date, uuid, text, text)'::regprocedure);
begin
  v_src := replace(v_src,
    'perform core.check_admin_action(coalesce(v_ra.user_id, p_target_user), v_node.id, v_group);',
    'if not core.can(''USER_ACCESS'', ''modify'', v_org, null) then
    perform hr.fail(''NOT_AUTHORISED'', ''USER_ACCESS modify required'');
  end if;');
  v_src := replace(v_src,
    'where nl.delivery_node_id = core.link_anchor(v_node.id)), core.org_root(v_me.tenant_id)) end;',
    'where nl.delivery_node_id = v_node.id), core.org_root(v_me.tenant_id)) end;');
  execute v_src;
end $$;
drop function core.sole_owner_applies(uuid, uuid);
drop function core.check_admin_action(uuid, uuid, uuid);
drop function core.approval_org_node(uuid);
drop function core.home_node(uuid);
drop function core.is_sensitive_group(uuid);
drop function core.admin_rank(uuid);
drop function core.group_rank(text);
