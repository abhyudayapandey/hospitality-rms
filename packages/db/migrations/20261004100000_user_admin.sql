-- migrate:up
-- User administration (ADR 011, PRD USR-1..4): what the admin screens call. Every action
-- goes through core.check_admin_action (scope, SELF_GRANT, ABOVE_OWN_RANK) and is audited.
--
--   core.admin_users / admin_user / admin_user_access   list, detail and access, in scope
--   core.preview_create_user / preview_grant             what saving would do, now or approval
--   core.update_user                                     name, login, job role, home place
--   core.login_admin_target / link_login                 Cognito actions: checked and audited
--   core.record_sign_in                                  last sign-in time
--   core.suggest_username                                <customer code>.<first>.<initial>
--   core.rate_limit_hit                                  counters in Postgres, not memory
--
-- Logins are unique across all customers: there is one Cognito pool, and its usernames and
-- email aliases are pool-wide (USERNAME_TAKEN / EMAIL_TAKEN).

-- ---------------------------------------------------------------------------
-- Pool-wide uniqueness of human logins
-- ---------------------------------------------------------------------------
do $$
declare
  v_dups text;
begin
  select string_agg(x, ', ') into v_dups from (
    select 'username ' || lower(username) as x from core.app_user
     where kind = 'human' and username is not null group by lower(username) having count(*) > 1
    union all
    select 'email ' || lower(email) from core.app_user
     where kind = 'human' and email is not null group by lower(email) having count(*) > 1) d;
  if v_dups is not null then
    raise exception 'logins used by more than one person across customers: %', v_dups
      using hint = 'rename them before this migration (one Cognito pool, ADR 011)';
  end if;
end $$;
create unique index app_user_username_pool on core.app_user (lower(username))
  where kind = 'human' and username is not null;
create unique index app_user_email_pool on core.app_user (lower(email))
  where kind = 'human' and email is not null;

alter table core.app_user add column last_sign_in_at timestamptz;

-- Login actions an admin took on someone (password reset, login disabled or enabled).
-- Only written by core.login_admin_target; read through core.access_audit.
create table core.login_admin_event (
  id uuid primary key default core.uuid_v7(),
  tenant_id uuid not null references core.tenant (id),
  user_id uuid not null references core.app_user (id),
  action text not null check (action in ('reset_password', 'disable_login', 'enable_login')),
  created_at timestamptz not null default now(),
  created_by uuid default core.current_user_id(),
  updated_at timestamptz not null default now(),
  updated_by uuid default core.current_user_id()
);
create trigger audit after insert or update or delete on core.login_admin_event
  for each row execute function audit.capture();

-- Fixed-window counters for our own entry points (sign-in, password resets).
create table core.rate_limit (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);

-- True while key has had at most p_limit hits in the current p_window_s window.
create function core.rate_limit_hit(p_key text, p_limit int, p_window_s int) returns boolean
language plpgsql security definer
set search_path = pg_catalog, core
as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s);
  v_hits int;
begin
  insert into core.rate_limit as r (key, window_start, hits) values (p_key, v_start, 1)
  on conflict (key, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  if random() < 0.01 then
    delete from core.rate_limit where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_limit;
end $$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
create function core.require_user_admin(p_access text default 'view') returns void
language plpgsql stable security definer
set search_path = pg_catalog, core, wf
as $$
begin
  perform wf.me();
  if not core.can_any('USER_ACCESS', p_access) then
    perform wf.fail('NOT_AUTHORISED', 'USER_ACCESS ' || p_access || ' required');
  end if;
end $$;

-- People whose home is inside the caller's user administration.
create function core.admin_users()
returns table (user_id uuid, display_name text, username text, email text, login_type text,
               status text, job_role_code text, home_node_id uuid, home_node_name text,
               last_sign_in_at timestamptz, admin_rank int)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf
as $$
begin
  perform core.require_user_admin('view');
  return query
    select u.id, u.display_name, u.username, u.email, u.login_type, u.status, w.role_code,
           h.id, h.name, u.last_sign_in_at, core.admin_rank(u.id)
      from core.app_user u
      left join hr.worker w on w.owner_user_id = u.id
      join core.hierarchy_node h on h.id = core.home_node(u.id)
     where u.tenant_id = core.my_tenant() and u.kind = 'human'
       and core.in_user_access_scope(h.id, 'view')
     order by u.display_name, u.id;
end $$;

create function core.admin_user(p_user uuid)
returns table (user_id uuid, display_name text, username text, email text, login_type text,
               status text, job_role_code text, home_node_id uuid, home_node_name text,
               last_sign_in_at timestamptz, admin_rank int)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf
as $$
begin
  perform core.require_user_admin('view');
  if not exists (select 1 from core.app_user where id = p_user and tenant_id = core.my_tenant())
     or not core.in_user_access_scope(core.home_node(p_user), 'view') then
    perform wf.fail('NOT_AUTHORISED', 'the person is outside your user administration');
  end if;
  return query select * from core.admin_users() a where a.user_id = p_user;
end $$;

-- A person's access: current and future assignments, and pending role changes.
create function core.admin_user_access(p_user uuid)
returns table (assignment_id uuid, role_change_id uuid, access_group text, sensitive boolean,
               node_id uuid, node_name text, include_descendants boolean, effective_from date,
               effective_to date, source text, note text, state text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf
as $$
begin
  perform core.admin_user(p_user);
  return query
    select ra.id, null::uuid, g.code, core.is_sensitive_group(g.id), n.id, n.name,
           ra.include_descendants, ra.effective_from, ra.effective_to, ra.source, ra.source_note,
           'active'
      from core.role_assignment ra
      join core.security_group g on g.id = ra.group_id
      join core.hierarchy_node n on n.id = ra.node_id
     where ra.user_id = p_user and (ra.effective_to is null or ra.effective_to >= current_date)
    union all
    select null, rc.id, g.code, core.is_sensitive_group(g.id), n.id, n.name,
           rc.include_descendants, rc.effective_from, rc.effective_to, rc.action, rc.reason,
           'waiting for approval'
      from hr.role_change rc
      join core.security_group g on g.id = rc.group_id
      join core.hierarchy_node n on n.id = rc.node_id
     where rc.target_user_id = p_user and rc.status = 'submitted'
     order by 3, 6;
end $$;

-- What the admin forms offer: places in the caller's scope, groups up to their own rank
-- (never SELF or the AI agent's), and the customer's job roles.
create function core.admin_places()
returns table (id uuid, name text, type text, kind text, code text)
language plpgsql stable security definer
set search_path = pg_catalog, core, wf
as $$
begin
  perform core.require_user_admin('modify');
  return query
    select n.id, n.name, n.type, n.kind, n.code from core.hierarchy_node n
     where n.tenant_id = core.my_tenant() and n.archived_at is null
       and core.in_user_access_scope(n.id, 'modify')
     order by n.type desc, n.path;
end $$;

create function core.admin_groups()
returns table (code text, name text, sensitive boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, wf
as $$
begin
  perform core.require_user_admin('modify');
  return query
    select g.code, g.name, core.is_sensitive_group(g.id) from core.security_group g
     where g.tenant_id = core.my_tenant() and g.kind <> 'user_based' and g.code <> 'AI_AGENT'
       and core.group_rank(g.code) <= core.admin_rank(core.current_user_id())
     order by g.name;
end $$;

create function core.admin_job_roles()
returns table (code text, name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf
as $$
begin
  perform core.require_user_admin('modify');
  return query
    select j.code, j.name from hr.job_role j
     where j.tenant_id = core.my_tenant() and j.archived_at is null order by j.name;
end $$;

-- ---------------------------------------------------------------------------
-- Previews: the same code path as saving, rolled back
-- ---------------------------------------------------------------------------
create function core.grant_applies(p_user uuid, p_group uuid, p_node uuid) returns text
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select case when not core.is_sensitive_group(p_group) then 'now'
              when core.sole_owner_applies(p_user, p_node) then 'sole owner: now'
              else 'approval' end;
$$;

create function core.preview_grant(p_user uuid, p_group_code text, p_node uuid) returns text
language plpgsql stable security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_group uuid := (select id from core.security_group
                    where tenant_id = core.my_tenant() and code = p_group_code);
begin
  perform wf.me();
  if v_group is null then
    perform wf.fail('INVALID_GROUP', p_group_code);
  end if;
  perform core.check_admin_action(p_user, p_node, v_group);
  return core.grant_applies(p_user, v_group, p_node);
end $$;

-- What core.create_user would give this person: it runs create_user and rolls it back, so
-- the preview and the save cannot drift apart (and fail the same way).
create function core.preview_create_user(p_username text, p_display_name text, p_home_node uuid,
                                         p_job_role text, p_login_type text default 'username',
                                         p_email text default null)
returns table (access_group text, node_id uuid, node_code text, place_name text, covers text,
               source text, applies text)
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_res jsonb;
  v_rows jsonb;
begin
  begin
    v_res := core.create_user(p_username, p_display_name, p_home_node, p_job_role, p_login_type,
                              p_email);
    select coalesce(jsonb_agg(x), '[]') into v_rows from (
      select g.code as access_group, n.id as node_id, n.code as node_code, n.name as place_name,
             case when ra.include_descendants then 'this place and everything below'
                  else 'this place only' end as covers,
             ra.source_note as source,
             case when core.is_sensitive_group(g.id) then 'sole owner: now' else 'now' end as applies
        from core.role_assignment ra
        join core.security_group g on g.id = ra.group_id
        join core.hierarchy_node n on n.id = ra.node_id
       where ra.user_id = (v_res ->> 'user_id')::uuid
      union all
      select g.code, n.id, n.code, n.name,
             case when rc.include_descendants then 'this place and everything below'
                  else 'this place only' end,
             rc.reason, 'approval'
        from hr.role_change rc
        join core.security_group g on g.id = rc.group_id
        join core.hierarchy_node n on n.id = rc.node_id
       where rc.target_user_id = (v_res ->> 'user_id')::uuid and rc.status = 'submitted') x;
    raise exception 'preview' using errcode = 'UA001';
  exception when sqlstate 'UA001' then
    null; -- everything create_user did is rolled back; v_rows keeps the answer
  end;
  return query
    select r.access_group, r.node_id, r.node_code, r.place_name, r.covers, r.source, r.applies
      from jsonb_to_recordset(v_rows) as r(access_group text, node_id uuid, node_code text,
                                           place_name text, covers text, source text,
                                           applies text)
     order by 1, 3;
end $$;

-- ---------------------------------------------------------------------------
-- Changes
-- ---------------------------------------------------------------------------
create function core.check_login_free(p_user uuid, p_username text, p_email text) returns void
language plpgsql stable security definer
set search_path = pg_catalog, core, wf
as $$
begin
  if p_username is not null and exists (
       select 1 from core.app_user where kind = 'human' and lower(username) = lower(trim(p_username))
          and id is distinct from p_user) then
    perform wf.fail('USERNAME_TAKEN', p_username);
  end if;
  if nullif(trim(p_email), '') is not null and exists (
       select 1 from core.app_user where kind = 'human' and lower(email) = lower(trim(p_email))
          and id is distinct from p_user) then
    perform wf.fail('EMAIL_TAKEN', p_email);
  end if;
end $$;

-- create_user: logins are checked across all customers.
do $$
declare
  v_src text := pg_get_functiondef('core.create_user(text, text, uuid, text, text, text, text, date)'::regprocedure);
  v_old text := 'if exists (select 1 from core.app_user where tenant_id = v_me.tenant_id
                and username = lower(trim(p_username))) then
    perform wf.fail(''USERNAME_TAKEN'', p_username);
  end if;';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'core.create_user changed; update this migration';
  end if;
  execute replace(v_src, v_old, 'perform core.check_login_free(null, p_username, p_email);');
end $$;

-- Brings a person's job-role access in line with their job role and home: new defaults as
-- in create_user (sensitive ones as ROLE_CHANGE requests), defaults that no longer apply
-- ended (sensitive ones through ROLE_CHANGE). Extra access (file 08, grants) is left alone.
create function core.sync_job_role_access(p_user uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_err text;
  v_ra core.role_assignment;
  v_d record;
  v_group uuid;
  v_applied int := 0;
  v_pending uuid[] := '{}';
begin
  select string_agg(d.error, '; ') into v_err
    from core.derive_job_role_access(p_user) d where d.error is not null;
  if v_err is not null then
    perform wf.fail('JOB_ROLE_SCOPE', v_err);
  end if;

  for v_ra in
    select ra.* from core.role_assignment ra
     where ra.user_id = p_user and ra.source = 'job_role'
       and (ra.effective_to is null or ra.effective_to >= current_date)
       and not exists (select 1 from core.derive_job_role_access(p_user) d
                        join core.security_group g on g.tenant_id = v_me.tenant_id
                                                  and g.code = d.access_group
                       where g.id = ra.group_id and d.node_id = ra.node_id)
  loop
    perform core.check_admin_action(p_user, v_ra.node_id, v_ra.group_id);
    if core.grant_applies(p_user, v_ra.group_id, v_ra.node_id) = 'approval' then
      v_pending := v_pending || hr.request_role_change(
        'end', p_user, null, null, null, null, greatest(current_date - 1, v_ra.effective_from),
        v_ra.id, 'job role changed', null);
    elsif v_ra.effective_from > current_date - 1 then
      delete from core.role_assignment where id = v_ra.id;
    else
      update core.role_assignment set effective_to = current_date - 1 where id = v_ra.id;
    end if;
  end loop;

  for v_d in select * from core.derive_job_role_access(p_user) loop
    v_group := (select id from core.security_group
                 where tenant_id = v_me.tenant_id and code = v_d.access_group);
    continue when exists (select 1 from core.role_assignment
                           where user_id = p_user and group_id = v_group and node_id = v_d.node_id
                             and (effective_to is null or effective_to >= current_date))
               or exists (select 1 from hr.role_change
                           where target_user_id = p_user and group_id = v_group
                             and node_id = v_d.node_id and status = 'submitted');
    perform core.check_admin_action(p_user, v_d.node_id, v_group);
    if core.grant_applies(p_user, v_group, v_d.node_id) = 'approval' then
      v_pending := v_pending || hr.request_role_change(
        'grant', p_user, v_d.access_group, v_d.node_id, v_d.include_descendants, current_date,
        null, null, 'job role default', null);
    else
      delete from core.role_assignment
       where user_id = p_user and group_id = v_group and node_id = v_d.node_id
         and effective_to < current_date and source = 'job_role';
      insert into core.role_assignment (tenant_id, user_id, group_id, node_id,
                                        include_descendants, effective_from, source, source_note)
      values (v_me.tenant_id, p_user, v_group, v_d.node_id, v_d.include_descendants,
              current_date, 'job_role',
              case when core.is_sensitive_group(v_group)
                   then 'sole account owner: no one else can approve' else v_d.source end);
      v_applied := v_applied + 1;
    end if;
  end loop;
  return jsonb_build_object('applied', v_applied, 'pending', to_jsonb(v_pending));
end $$;

-- Changes a person's name, login, job role or home place (null: unchanged).
create function core.update_user(p_user uuid, p_display_name text default null,
                                 p_login_type text default null, p_email text default null,
                                 p_job_role text default null, p_home_node uuid default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_w hr.worker;
begin
  perform core.require_user_admin('modify');
  perform core.check_admin_action(p_user, p_home_node, null);
  if p_login_type is not null and p_login_type not in ('username', 'email') then
    perform wf.fail('INVALID_ACTION', p_login_type);
  end if;
  perform core.check_login_free(p_user, null, p_email);
  update core.app_user
     set display_name = coalesce(nullif(trim(p_display_name), ''), display_name),
         login_type = coalesce(p_login_type, login_type),
         email = coalesce(nullif(lower(trim(p_email)), ''), email)
   where id = p_user
     and (display_name, login_type, coalesce(email, ''))
         is distinct from (coalesce(nullif(trim(p_display_name), ''), display_name),
                           coalesce(p_login_type, login_type),
                           coalesce(nullif(lower(trim(p_email)), ''), email, ''));

  if p_job_role is null and p_home_node is null then
    return jsonb_build_object('applied', 0, 'pending', '[]'::jsonb);
  end if;
  select * into v_w from hr.worker where owner_user_id = p_user;
  if not found then
    perform wf.fail('INVALID_WORKER', 'this person has no job role');
  end if;
  if p_job_role is not null and not exists (select 1 from hr.job_role where tenant_id = v_me.tenant_id
                                               and code = p_job_role and archived_at is null) then
    perform wf.fail('INVALID_JOB_ROLE', p_job_role);
  end if;
  if p_home_node is not null and not exists (select 1 from core.hierarchy_node where id = p_home_node
                                                and tenant_id = v_me.tenant_id and type = 'org') then
    perform wf.fail('NOT_FOUND', 'home place');
  end if;
  update hr.worker set role_code = coalesce(p_job_role, role_code),
                       org_node_id = coalesce(p_home_node, org_node_id)
   where id = v_w.id;
  return core.sync_job_role_access(p_user);
end $$;

-- Checks and records a Cognito action on someone, and returns what Cognito needs. Called
-- by the server before AdminSetUserPassword / AdminDisableUser / AdminEnableUser; for a
-- deactivation, after core.set_user_status (the database cuts the person off first).
create function core.login_admin_target(p_user uuid, p_action text)
returns table (username text, email text, login_type text, cognito_sub text)
language plpgsql security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_u core.app_user;
begin
  perform core.require_user_admin('modify');
  if p_action not in ('reset_password', 'disable_login', 'enable_login') then
    perform wf.fail('INVALID_ACTION', p_action);
  end if;
  perform core.check_admin_action(p_user, null, null);
  select * into v_u from core.app_user where id = p_user;
  if p_action = 'reset_password' and v_u.login_type <> 'username' then
    perform wf.fail('INVALID_ACTION', 'email logins have no password');
  end if;
  insert into core.login_admin_event (tenant_id, user_id, action)
  values (v_u.tenant_id, p_user, p_action);
  return query select v_u.username, v_u.email, v_u.login_type, v_u.cognito_sub;
end $$;

-- Records the Cognito account created for a person (once; the same sub again is a no-op).
create function core.link_login(p_user uuid, p_sub text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_sub text;
begin
  perform core.require_user_admin('modify');
  perform core.check_admin_action(p_user, null, null);
  select cognito_sub into v_sub from core.app_user where id = p_user;
  if v_sub = p_sub then
    return;
  end if;
  if v_sub is not null or exists (select 1 from core.app_user where cognito_sub = p_sub) then
    perform wf.fail('INVALID_STATE', 'this person already has another login');
  end if;
  update core.app_user set cognito_sub = p_sub where id = p_user;
end $$;

create function core.record_sign_in() returns void
language sql security definer
set search_path = pg_catalog, core
as $$
  update core.app_user set last_sign_in_at = now()
   where id = core.current_user_id() and status = 'active';
$$;

-- <customer code>.<first name>.<last initial>, with a number when that is taken anywhere.
create function core.suggest_username(p_display_name text) returns text
language plpgsql stable security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_words text[] := array_remove(regexp_split_to_array(
                      regexp_replace(lower(coalesce(p_display_name, '')), '[^a-z0-9 ]', '', 'g'),
                      '\s+'), '');
  v_base text;
  v_try text;
  v_n int := 1;
begin
  perform core.require_user_admin('modify');
  v_base := lower((select code from core.tenant where id = core.my_tenant()))
            || '.' || coalesce(v_words[1], 'user')
            || case when cardinality(v_words) > 1
                    then '.' || left(v_words[cardinality(v_words)], 1) else '' end;
  v_try := v_base;
  while exists (select 1 from core.app_user where kind = 'human' and lower(username) = v_try) loop
    v_n := v_n + 1;
    v_try := v_base || v_n;
  end loop;
  return v_try;
end $$;

revoke execute on function core.admin_places(), core.admin_groups(), core.admin_job_roles()
  from public;
grant execute on function core.admin_places(), core.admin_groups(), core.admin_job_roles()
  to app_rw;
revoke execute on function core.rate_limit_hit(text, int, int), core.require_user_admin(text),
  core.admin_users(), core.admin_user(uuid), core.admin_user_access(uuid),
  core.grant_applies(uuid, uuid, uuid), core.preview_grant(uuid, text, uuid),
  core.preview_create_user(text, text, uuid, text, text, text),
  core.check_login_free(uuid, text, text), core.sync_job_role_access(uuid),
  core.update_user(uuid, text, text, text, text, uuid), core.login_admin_target(uuid, text),
  core.link_login(uuid, text), core.record_sign_in(), core.suggest_username(text) from public;
grant execute on function core.rate_limit_hit(text, int, int), core.admin_users(),
  core.admin_user(uuid), core.admin_user_access(uuid), core.preview_grant(uuid, text, uuid),
  core.preview_create_user(text, text, uuid, text, text, text),
  core.update_user(uuid, text, text, text, text, uuid), core.login_admin_target(uuid, text),
  core.link_login(uuid, text), core.record_sign_in(), core.suggest_username(text) to app_rw;

-- The access audit gains login actions (password reset, login disabled or enabled) and
-- "user changed"; the sole-owner and top-of-chain notes stay.
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
                            'wf.step_instance', 'core.login_admin_event')
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
                           else 'user reactivated' end
                    when ev.changed_fields && array['display_name', 'username', 'email',
                                                    'login_type'] then 'user changed' end
             when 'core.login_admin_event' then
               case ev.r ->> 'action' when 'reset_password' then 'password reset'
                    when 'disable_login' then 'login disabled'
                    when 'enable_login' then 'login enabled' end
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
             when 'core.login_admin_event' then (ev.r ->> 'user_id')::uuid
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
             when 'core.login_admin_event' then core.home_node((ev.r ->> 'user_id')::uuid)
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

drop function core.suggest_username(text);
drop function core.record_sign_in();
drop function core.link_login(uuid, text);
drop function core.login_admin_target(uuid, text);
drop function core.update_user(uuid, text, text, text, text, uuid);
drop function core.sync_job_role_access(uuid);
do $$
begin
  execute replace(pg_get_functiondef('core.create_user(text, text, uuid, text, text, text, text, date)'::regprocedure),
    'perform core.check_login_free(null, p_username, p_email);',
    'if exists (select 1 from core.app_user where tenant_id = v_me.tenant_id
                and username = lower(trim(p_username))) then
    perform wf.fail(''USERNAME_TAKEN'', p_username);
  end if;');
end $$;
drop function core.check_login_free(uuid, text, text);
drop function core.preview_create_user(text, text, uuid, text, text, text);
drop function core.preview_grant(uuid, text, uuid);
drop function core.grant_applies(uuid, uuid, uuid);
drop function core.admin_job_roles();
drop function core.admin_groups();
drop function core.admin_places();
drop function core.admin_user_access(uuid);
drop function core.admin_user(uuid);
drop function core.admin_users();
drop function core.require_user_admin(text);
drop function core.rate_limit_hit(text, int, int);
drop table core.rate_limit;
drop table core.login_admin_event;
alter table core.app_user drop column last_sign_in_at;
drop index core.app_user_email_pool;
drop index core.app_user_username_pool;
