-- migrate:up
-- The Platform Admin console (ADR 012, PRD ADM-1..4): platform admins, customer status,
-- the job queue the platform worker serves, and the platform audit.
--
-- Platform admins live outside every customer (no tenant_id). A platform request runs with
-- app.platform_admin_id set; core.current_user_id() is then null, so core.can() and every
-- RLS policy deny, even if app.user_id is also set. Platform functions return customer
-- metadata only.
--
-- A suspended customer's people cannot sign in and their sessions end on the next request
-- (core.me, the sign-in lookups and wf.me return nothing for them). Their logins stay as
-- they are, so reactivating is one step.
--
-- core.tenant.is_test is set when a customer is created and never changes (trigger); the
-- audit trigger records it. Only test customers may use the Test<Role>!12 password rule.
--
-- platform_loader (created with the other roles, ADR 012) runs the loader and
-- createCustomer: DML on customer tables, no DDL, owns nothing.

-- ---------------------------------------------------------------------------
-- Platform sessions see no customer data
-- ---------------------------------------------------------------------------
create or replace function core.current_user_id() returns uuid
language sql stable parallel safe
as $$
  select case when nullif(current_setting('app.platform_admin_id', true), '') is null
              then nullif(current_setting('app.user_id', true), '')::uuid end;
$$;

-- ---------------------------------------------------------------------------
-- Customer status and the test flag
-- ---------------------------------------------------------------------------
alter table core.tenant
  add column status text not null default 'active' check (status in ('active', 'suspended')),
  add column is_test boolean not null default false;

create function core.tenant_is_test_fixed() returns trigger
language plpgsql
as $$
begin
  if new.is_test is distinct from old.is_test then
    raise exception 'IS_TEST_IMMUTABLE' using detail = 'is_test is set when a customer is created';
  end if;
  return new;
end $$;
create trigger is_test_fixed before update on core.tenant
  for each row execute function core.tenant_is_test_fixed();

create function core.tenant_active(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$ select exists (select 1 from core.tenant where id = p_tenant and status = 'active') $$;

do $$
declare
  v_src text;
begin
  v_src := pg_get_functiondef('core.me()'::regprocedure);
  if position('where u.id = core.current_user_id() and u.status = ''active''' in v_src) = 0 then
    raise exception 'core.me changed; update this migration';
  end if;
  execute replace(v_src, 'where u.id = core.current_user_id() and u.status = ''active''',
    'where u.id = core.current_user_id() and u.status = ''active''
     and core.tenant_active(u.tenant_id)');

  v_src := pg_get_functiondef('core.user_for_cognito_sub(text)'::regprocedure);
  if position('where cognito_sub = p_sub and status = ''active''' in v_src) = 0 then
    raise exception 'core.user_for_cognito_sub changed; update this migration';
  end if;
  execute replace(v_src, 'where cognito_sub = p_sub and status = ''active''',
    'where cognito_sub = p_sub and status = ''active'' and core.tenant_active(tenant_id)');

  v_src := pg_get_functiondef('core.user_for_username(text, text)'::regprocedure);
  if position('and u.kind = ''human''' in v_src) = 0 then
    raise exception 'core.user_for_username changed; update this migration';
  end if;
  execute replace(v_src, 'and u.kind = ''human''',
    'and u.kind = ''human'' and t.status = ''active''');

  v_src := pg_get_functiondef('wf.me()'::regprocedure);
  if position('where id = core.current_user_id() and status = ''active'';' in v_src) = 0 then
    raise exception 'wf.me changed; update this migration';
  end if;
  execute replace(v_src, 'where id = core.current_user_id() and status = ''active'';',
    'where id = core.current_user_id() and status = ''active''
     and core.tenant_active(tenant_id);');
end $$;

-- ---------------------------------------------------------------------------
-- Platform schema
-- ---------------------------------------------------------------------------
create schema platform;

create table platform.admin (
  id uuid primary key default core.uuid_v7(),
  cognito_sub text not null unique,
  email text not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz
);

-- Work the platform worker does as platform_loader: creating customers now, imports later.
create table platform.job (
  id uuid primary key default core.uuid_v7(),
  kind text not null check (kind in ('create_customer')),
  tenant_id uuid references core.tenant (id),
  payload jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  result jsonb,
  error text,
  attempts int not null default 0,
  created_by uuid references platform.admin (id),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);
create index job_queued on platform.job (created_at) where status = 'queued';

create table platform.audit_event (
  id uuid primary key default core.uuid_v7(),
  at timestamptz not null default now(),
  admin_id uuid references platform.admin (id),
  action text not null,
  tenant_id uuid references core.tenant (id),
  reason text,
  detail jsonb not null default '{}'
);
create index audit_event_at on platform.audit_event (at desc);

create function platform.append_only() returns trigger
language plpgsql
as $$
begin
  raise exception 'PLATFORM_AUDIT_APPEND_ONLY';
end $$;
create trigger append_only before update or delete on platform.audit_event
  for each row execute function platform.append_only();
create trigger append_only_truncate before truncate on platform.audit_event
  for each statement execute function platform.append_only();

-- ---------------------------------------------------------------------------
-- Platform functions: every one needs an active platform admin session
-- ---------------------------------------------------------------------------
create function platform.current_admin() returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, platform
as $$
declare
  v_id uuid := nullif(current_setting('app.platform_admin_id', true), '')::uuid;
begin
  if v_id is null or not exists (select 1 from platform.admin where id = v_id and status = 'active') then
    raise exception 'NOT_AUTHORISED' using detail = 'platform admin session required';
  end if;
  return v_id;
end $$;

create function platform.log(p_action text, p_tenant uuid, p_reason text,
                             p_detail jsonb default '{}') returns void
language sql security definer
set search_path = pg_catalog, platform
as $$
  insert into platform.audit_event (admin_id, action, tenant_id, reason, detail)
  values (nullif(current_setting('app.platform_admin_id', true), '')::uuid, p_action, p_tenant,
          p_reason, coalesce(p_detail, '{}'));
$$;

-- Before a platform session exists: the server calls this only for a verified ID token of
-- the platform pool whose cognito:groups includes platform-admins (ADR 012).
create function platform.sign_in(p_sub text, p_email text) returns uuid
language plpgsql security definer
set search_path = pg_catalog, platform
as $$
declare
  v_id uuid;
  v_status text;
begin
  insert into platform.admin (cognito_sub, email, last_sign_in_at)
  values (p_sub, lower(trim(p_email)), now())
  on conflict (cognito_sub) do update
     set email = excluded.email, last_sign_in_at = now()
  returning id, status into v_id, v_status;
  if v_status <> 'active' then
    raise exception 'NOT_AUTHORISED' using detail = 'platform admin disabled';
  end if;
  perform set_config('app.platform_admin_id', v_id::text, true);
  perform platform.log('sign_in', null, null);
  return v_id;
end $$;

-- ADM-4: customers with status, user count and last activity (latest sign-in).
create function platform.customers()
returns table (id uuid, code text, name text, country text, status text, is_test boolean,
               user_count int, last_activity timestamptz, created_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  return query
    select t.id, t.code, t.name, t.country, t.status, t.is_test,
           (select count(*)::int from core.app_user u
             where u.tenant_id = t.id and u.kind = 'human' and u.status = 'active'),
           (select max(u.last_sign_in_at) from core.app_user u where u.tenant_id = t.id),
           t.created_at
      from core.tenant t
     order by t.name;
end $$;

create function platform.set_status(p_tenant uuid, p_status text, p_reason text) returns text
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  if nullif(trim(p_reason), '') is null then
    raise exception 'REASON_REQUIRED';
  end if;
  if not exists (select 1 from core.tenant where id = p_tenant) then
    raise exception 'NOT_FOUND' using detail = 'customer';
  end if;
  update core.tenant set status = p_status where id = p_tenant and status <> p_status;
  perform platform.log(case p_status when 'suspended' then 'suspend' else 'reactivate' end,
                       p_tenant, trim(p_reason));
  return p_status;
end $$;

create function platform.suspend(p_tenant uuid, p_reason text) returns text
language sql security definer
set search_path = pg_catalog, platform
as $$ select platform.set_status(p_tenant, 'suspended', p_reason) $$;

create function platform.reactivate(p_tenant uuid, p_reason text) returns text
language sql security definer
set search_path = pg_catalog, platform
as $$ select platform.set_status(p_tenant, 'active', p_reason) $$;

-- ADM-2: queues a new customer with its first account owner; the worker creates it.
create function platform.request_create_customer(p jsonb) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_admin uuid := platform.current_admin();
  v_code text := upper(trim(p ->> 'code'));
  v_email text := lower(trim(p #>> '{owner,email}'));
  v_id uuid;
begin
  if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9-]{1,39}$' then
    raise exception 'INVALID_CUSTOMER_CODE';
  end if;
  if nullif(trim(p ->> 'name'), '') is null or nullif(trim(p #>> '{owner,display_name}'), '') is null
     or v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'INVALID_CUSTOMER';
  end if;
  if exists (select 1 from core.tenant where code = v_code)
     or exists (select 1 from platform.job where kind = 'create_customer'
                   and status in ('queued', 'running') and payload ->> 'code' = v_code) then
    raise exception 'CUSTOMER_CODE_TAKEN';
  end if;
  if exists (select 1 from core.app_user where kind = 'human' and lower(email) = v_email) then
    raise exception 'EMAIL_TAKEN';
  end if;
  insert into platform.job (kind, payload, created_by)
  values ('create_customer', p || jsonb_build_object('code', v_code), v_admin)
  returning id into v_id;
  perform platform.log('create_customer_requested', null, null,
                       jsonb_build_object('job', v_id, 'code', v_code,
                                          'is_test', coalesce((p ->> 'is_test')::boolean, false)));
  return v_id;
end $$;

create function platform.jobs(p_limit int default 50)
returns table (id uuid, kind text, status text, customer_code text, tenant_id uuid,
               result jsonb, error text, created_at timestamptz, finished_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, platform
as $$
begin
  perform platform.current_admin();
  return query
    select j.id, j.kind, j.status, j.payload ->> 'code', j.tenant_id, j.result, j.error,
           j.created_at, j.finished_at
      from platform.job j order by j.created_at desc limit least(greatest(p_limit, 1), 200);
end $$;

-- After the worker created the customer, the server creates the owner's Cognito login
-- (email invite) and records it here.
create function platform.link_owner_login(p_job uuid, p_sub text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_job platform.job;
  v_owner uuid;
begin
  perform platform.current_admin();
  select * into v_job from platform.job where id = p_job and status = 'done';
  if not found then
    raise exception 'INVALID_STATE' using detail = 'the customer is not created yet';
  end if;
  v_owner := (v_job.result ->> 'owner_user_id')::uuid;
  update core.app_user set cognito_sub = p_sub
   where id = v_owner and (cognito_sub is null or cognito_sub = p_sub);
  if not found then
    raise exception 'INVALID_STATE' using detail = 'the owner already has another login';
  end if;
  perform platform.log('owner_login_created', v_job.tenant_id, null);
end $$;

create function platform.audit(p_limit int default 100)
returns table (at timestamptz, admin_email text, action text, tenant_id uuid,
               customer_code text, reason text, detail jsonb)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  return query
    select e.at, a.email, e.action, e.tenant_id, t.code, e.reason, e.detail
      from platform.audit_event e
      left join platform.admin a on a.id = e.admin_id
      left join core.tenant t on t.id = e.tenant_id
     order by e.at desc limit least(greatest(p_limit, 1), 500);
end $$;

-- The worker (platform_loader) claims the oldest queued job and reports its outcome.
create function platform.claim_job() returns setof platform.job
language sql security definer
set search_path = pg_catalog, platform
as $$
  update platform.job
     set status = 'running', claimed_at = now(), attempts = attempts + 1
   where id = (select id from platform.job where status = 'queued'
                order by created_at for update skip locked limit 1)
  returning *;
$$;

create function platform.finish_job(p_id uuid, p_tenant uuid, p_result jsonb, p_error text)
returns void
language sql security definer
set search_path = pg_catalog, platform
as $$
  update platform.job
     set status = case when p_error is null then 'done' else 'failed' end,
         tenant_id = coalesce(p_tenant, tenant_id), result = p_result, error = p_error,
         finished_at = now()
   where id = p_id and status = 'running';
  insert into platform.audit_event (admin_id, action, tenant_id, reason, detail)
  select j.created_by, j.kind || case when p_error is null then '_done' else '_failed' end,
         coalesce(p_tenant, j.tenant_id), p_error, jsonb_build_object('job', j.id)
    from platform.job j where j.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on schema platform from public;
revoke execute on all functions in schema platform from public;
grant usage on schema platform to app_rw, platform_loader;
grant execute on function platform.sign_in(text, text), platform.customers(),
  platform.suspend(uuid, text), platform.reactivate(uuid, text),
  platform.request_create_customer(jsonb), platform.jobs(int),
  platform.link_owner_login(uuid, text), platform.audit(int) to app_rw;
grant execute on function platform.claim_job(), platform.finish_job(uuid, uuid, jsonb, text)
  to platform_loader;
revoke execute on function core.tenant_active(uuid) from public;
grant execute on function core.tenant_active(uuid) to app_rw, wf_executor, platform_loader;

-- platform_loader: data in the customer schemas, nothing else.
grant usage on schema core, hr, inv, ops, wf, ai, audit, extensions to platform_loader;
grant select, insert, update, delete on all tables in schema core, hr, inv, ops, wf, ai
  to platform_loader;
grant usage, select on all sequences in schema core, hr, inv, ops, wf, ai to platform_loader;
grant execute on all functions in schema core, hr, inv, ops, wf, ai to platform_loader;
alter default privileges for role migrator in schema core, hr, inv, ops, wf, ai
  grant select, insert, update, delete on tables to platform_loader;
alter default privileges for role migrator in schema core, hr, inv, ops, wf, ai
  grant usage, select on sequences to platform_loader;
alter default privileges for role migrator in schema core, hr, inv, ops, wf, ai
  grant execute on functions to platform_loader;

-- migrate:down
alter default privileges for role migrator in schema core, hr, inv, ops, wf, ai
  revoke execute on functions from platform_loader;
alter default privileges for role migrator in schema core, hr, inv, ops, wf, ai
  revoke usage, select on sequences from platform_loader;
alter default privileges for role migrator in schema core, hr, inv, ops, wf, ai
  revoke select, insert, update, delete on tables from platform_loader;
revoke execute on all functions in schema core, hr, inv, ops, wf, ai from platform_loader;
revoke usage, select on all sequences in schema core, hr, inv, ops, wf, ai from platform_loader;
revoke select, insert, update, delete on all tables in schema core, hr, inv, ops, wf, ai
  from platform_loader;
revoke usage on schema core, hr, inv, ops, wf, ai, audit, extensions from platform_loader;

drop schema platform cascade;

do $$
begin
  execute replace(pg_get_functiondef('wf.me()'::regprocedure),
    'where id = core.current_user_id() and status = ''active''
     and core.tenant_active(tenant_id);',
    'where id = core.current_user_id() and status = ''active'';');
  execute replace(pg_get_functiondef('core.user_for_username(text, text)'::regprocedure),
    'and u.kind = ''human'' and t.status = ''active''', 'and u.kind = ''human''');
  execute replace(pg_get_functiondef('core.user_for_cognito_sub(text)'::regprocedure),
    'where cognito_sub = p_sub and status = ''active'' and core.tenant_active(tenant_id)',
    'where cognito_sub = p_sub and status = ''active''');
  execute replace(pg_get_functiondef('core.me()'::regprocedure),
    'where u.id = core.current_user_id() and u.status = ''active''
     and core.tenant_active(u.tenant_id)',
    'where u.id = core.current_user_id() and u.status = ''active''');
end $$;
drop function core.tenant_active(uuid);
drop trigger is_test_fixed on core.tenant;
drop function core.tenant_is_test_fixed();
alter table core.tenant drop column is_test, drop column status;

create or replace function core.current_user_id() returns uuid
language sql stable parallel safe
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$$;
