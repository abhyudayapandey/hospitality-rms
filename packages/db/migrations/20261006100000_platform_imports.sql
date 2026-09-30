-- migrate:up
-- Imports and logins in the Platform Admin console (ADR 013, PRD ADM-3).
--
-- Imports: the console stores an upload under onboarding/<customer>/ and queues a dry run;
-- the worker (platform_loader) runs the loader and writes the report back. Applying is a
-- separate job that needs a successful dry run of the same upload. An upload's key must be
-- under its customer and its file 00 must name that customer; the worker checks the files
-- again before it loads anything.
--
-- Logins: username logins are created by the console (passwords shown once, never
-- stored). The Test<Role>!12 option is refused here for customers that are not test
-- customers. Email logins are invites that the worker sends within the customer pool's
-- daily email allowance (40 of Cognito's ~50 a day, ADR 013); the rest wait for the
-- next day's allowance (platform.job.run_after).

alter table platform.job drop constraint job_kind_check;
alter table platform.job add constraint job_kind_check
  check (kind in ('create_customer', 'import_dry_run', 'import_apply', 'invite_logins'));
alter table platform.job add column run_after timestamptz;
drop index platform.job_queued;
create index job_queued on platform.job (coalesce(run_after, created_at)) where status = 'queued';

-- Every invitation email sent from the customer pool (the daily allowance is pool-wide).
create table platform.invite (
  id uuid primary key default core.uuid_v7(),
  tenant_id uuid not null references core.tenant (id),
  user_id uuid not null references core.app_user (id),
  job_id uuid references platform.job (id),
  sent_at timestamptz not null default now()
);
create index invite_sent_at on platform.invite (sent_at desc);

-- Cognito's default email (no SES) allows about 50 messages a day for the whole pool, and
-- email logins' sign-in codes come out of the same allowance: invitations use at most 40,
-- leaving about 10 a day for codes. Raise it after moving the pool to SES.
create function platform.invite_daily_limit() returns int
language sql immutable
as $$ select 40 $$;

-- ---------------------------------------------------------------------------
-- The worker's jobs
-- ---------------------------------------------------------------------------
create or replace function platform.claim_job() returns setof platform.job
language sql security definer
set search_path = pg_catalog, platform
as $$
  update platform.job
     set status = 'running', claimed_at = now(), attempts = attempts + 1
   where id = (select id from platform.job
                where status = 'queued' and coalesce(run_after, created_at) <= now()
                order by coalesce(run_after, created_at) for update skip locked limit 1)
  returning *;
$$;

-- Puts a running job back in the queue until p_run_after (invites waiting for allowance).
create function platform.defer_job(p_id uuid, p_run_after timestamptz, p_result jsonb)
returns void
language sql security definer
set search_path = pg_catalog, platform
as $$
  update platform.job
     set status = 'queued', run_after = p_run_after, result = p_result
   where id = p_id and status = 'running';
  insert into platform.audit_event (admin_id, action, tenant_id, detail)
  select j.created_by, j.kind || '_batch', j.tenant_id,
         coalesce(p_result, '{}') || jsonb_build_object('job', j.id, 'next', p_run_after)
    from platform.job j where j.id = p_id;
$$;

create function platform.invite_allowance()
returns table (remaining int, next_free_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, platform
as $$
  select greatest(platform.invite_daily_limit() - count(*)::int, 0),
         min(sent_at) + interval '1 day'
    from platform.invite where sent_at > now() - interval '1 day';
$$;

-- The worker sent an invitation: record the login and count the email.
create function platform.record_invite(p_job uuid, p_user uuid, p_sub text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from platform.job where id = p_job and kind = 'invite_logins';
  update core.app_user set cognito_sub = p_sub
   where id = p_user and tenant_id = v_tenant and kind = 'human' and login_type = 'email'
     and (cognito_sub is null or cognito_sub = p_sub);
  if not found then
    raise exception 'INVALID_STATE' using detail = 'not an email login of this customer';
  end if;
  insert into platform.invite (tenant_id, user_id, job_id) values (v_tenant, p_user, p_job);
end $$;

-- ---------------------------------------------------------------------------
-- Console functions: every one needs an active platform admin session
-- ---------------------------------------------------------------------------
create function platform.customer(p_tenant uuid)
returns table (id uuid, code text, name text, country text, status text, is_test boolean,
               user_count int, last_activity timestamptz, created_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  return query select c.* from platform.customers() c where c.id = p_tenant;
end $$;

create function platform.request_import(p_tenant uuid, p_upload jsonb) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_admin uuid := platform.current_admin();
  v_code text;
  v_id uuid;
begin
  select code into v_code from core.tenant where id = p_tenant;
  if v_code is null then
    raise exception 'NOT_FOUND' using detail = 'customer';
  end if;
  if coalesce(p_upload ->> 'key', '') !~ ('^onboarding/' || p_tenant::text
       || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$') then
    raise exception 'INVALID_UPLOAD' using detail = 'the upload is not stored under this customer';
  end if;
  if upper(trim(coalesce(p_upload ->> 'customer_code', ''))) <> v_code then
    raise exception 'CUSTOMER_MISMATCH'
      using detail = format('file 00 names %s, not %s', p_upload ->> 'customer_code', v_code);
  end if;
  insert into platform.job (kind, tenant_id, payload, created_by)
  values ('import_dry_run', p_tenant,
          jsonb_build_object('key', p_upload -> 'key', 'name', p_upload -> 'name',
                             'bytes', p_upload -> 'bytes', 'sha256', p_upload -> 'sha256',
                             'files', p_upload -> 'files', 'code', v_code),
          v_admin)
  returning id into v_id;
  perform platform.log('import_uploaded', p_tenant, null,
                       jsonb_build_object('job', v_id, 'name', p_upload -> 'name',
                                          'bytes', p_upload -> 'bytes',
                                          'sha256', p_upload -> 'sha256',
                                          'files', p_upload -> 'files'));
  return v_id;
end $$;

create function platform.request_import_apply(p_dry_run uuid) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_admin uuid := platform.current_admin();
  v_job platform.job;
  v_id uuid;
begin
  select * into v_job from platform.job where id = p_dry_run and kind = 'import_dry_run';
  if not found or v_job.status <> 'done' or coalesce((v_job.result ->> 'ok')::boolean, false) is false
  then
    raise exception 'INVALID_STATE' using detail = 'apply needs a successful dry run';
  end if;
  insert into platform.job (kind, tenant_id, payload, created_by)
  values ('import_apply', v_job.tenant_id,
          v_job.payload || jsonb_build_object('dry_run', v_job.id), v_admin)
  returning id into v_id;
  perform platform.log('import_apply_requested', v_job.tenant_id, null,
                       jsonb_build_object('job', v_id, 'dry_run', v_job.id,
                                          'sha256', v_job.payload -> 'sha256'));
  return v_id;
end $$;

-- One job for the console, with the dry run an apply came from (no upload contents).
create function platform.job(p_id uuid)
returns table (id uuid, kind text, status text, tenant_id uuid, customer_code text,
               result jsonb, error text, run_after timestamptz, dry_run uuid,
               created_at timestamptz, finished_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  return query
    select j.id, j.kind, j.status, j.tenant_id, coalesce(t.code, j.payload ->> 'code'),
           j.result, j.error, j.run_after, (j.payload ->> 'dry_run')::uuid, j.created_at,
           j.finished_at
      from platform.job j left join core.tenant t on t.id = j.tenant_id
     where j.id = p_id;
end $$;

-- The customer's people and whether each has a login yet (no secrets).
create function platform.login_candidates(p_tenant uuid)
returns table (user_id uuid, username text, display_name text, login_type text, email text,
               job_title text, has_login boolean, invited_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, platform
as $$
begin
  perform platform.current_admin();
  return query
    select u.id, u.username, u.display_name, u.login_type, u.email, jr.name,
           u.cognito_sub is not null,
           (select max(i.sent_at) from platform.invite i where i.user_id = u.id)
      from core.app_user u
      left join hr.worker w on w.owner_user_id = u.id and w.tenant_id = u.tenant_id
      left join hr.job_role jr on jr.tenant_id = u.tenant_id and jr.code = w.role_code
     where u.tenant_id = p_tenant and u.kind = 'human' and u.status = 'active'
     order by u.username;
end $$;

-- Username logins to create now; the Test<Role>!12 option only for test customers.
create function platform.begin_logins(p_tenant uuid, p_test_rule boolean)
returns table (user_id uuid, username text, display_name text, job_title text)
language plpgsql security definer
set search_path = pg_catalog, core, hr, platform
as $$
declare
  v_tenant core.tenant;
  v_count int;
begin
  perform platform.current_admin();
  select * into v_tenant from core.tenant where id = p_tenant;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'customer';
  end if;
  if p_test_rule and not v_tenant.is_test then
    raise exception 'TEST_RULE_NOT_ALLOWED'
      using detail = 'the Test<Role>!12 rule is only for test customers';
  end if;
  if v_tenant.status <> 'active' then
    raise exception 'CUSTOMER_SUSPENDED';
  end if;
  return query
    select c.user_id, c.username, c.display_name, c.job_title
      from platform.login_candidates(p_tenant) c
     where c.login_type = 'username' and not c.has_login;
  get diagnostics v_count = row_count;
  perform platform.log('logins_started', p_tenant, null,
                       jsonb_build_object('test_rule', p_test_rule, 'count', v_count));
end $$;

create function platform.link_customer_login(p_user uuid, p_sub text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_user core.app_user;
begin
  perform platform.current_admin();
  update core.app_user set cognito_sub = p_sub
   where id = p_user and kind = 'human' and status = 'active' and login_type = 'username'
     and (cognito_sub is null or cognito_sub = p_sub)
  returning * into v_user;
  if not found then
    raise exception 'INVALID_STATE' using detail = 'not a username login waiting for one';
  end if;
  perform platform.log('login_created', v_user.tenant_id, null,
                       jsonb_build_object('user', v_user.id, 'username', v_user.username));
end $$;

create function platform.request_invites(p_tenant uuid) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_admin uuid := platform.current_admin();
  v_id uuid;
  v_waiting int;
begin
  if not exists (select 1 from core.tenant where id = p_tenant and status = 'active') then
    raise exception 'CUSTOMER_SUSPENDED';
  end if;
  select id into v_id from platform.job
   where kind = 'invite_logins' and tenant_id = p_tenant and status in ('queued', 'running');
  if found then
    return v_id;
  end if;
  select count(*) into v_waiting from core.app_user
   where tenant_id = p_tenant and kind = 'human' and status = 'active'
     and login_type = 'email' and cognito_sub is null;
  if v_waiting = 0 then
    return null;
  end if;
  insert into platform.job (kind, tenant_id, payload, created_by)
  values ('invite_logins', p_tenant, '{}', v_admin)
  returning id into v_id;
  perform platform.log('invites_requested', p_tenant, null,
                       jsonb_build_object('job', v_id, 'waiting', v_waiting));
  return v_id;
end $$;

create function platform.invite_status(p_tenant uuid)
returns table (waiting int, invited int, sent_last_day int, daily_limit int,
               next_batch_at timestamptz, job_id uuid)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  return query
    select (select count(*)::int from core.app_user u
             where u.tenant_id = p_tenant and u.kind = 'human' and u.status = 'active'
               and u.login_type = 'email' and u.cognito_sub is null),
           (select count(distinct i.user_id)::int from platform.invite i
             where i.tenant_id = p_tenant),
           (select count(*)::int from platform.invite i where i.sent_at > now() - interval '1 day'),
           platform.invite_daily_limit(),
           j.run_after, j.id
      from (select 1) one
      left join platform.job j on j.kind = 'invite_logins' and j.tenant_id = p_tenant
                              and j.status in ('queued', 'running');
end $$;

-- The owner's invitation (create customer) counts against the allowance too.
create or replace function platform.link_owner_login(p_job uuid, p_sub text) returns void
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
  insert into platform.invite (tenant_id, user_id, job_id) values (v_job.tenant_id, v_owner, p_job);
  perform platform.log('owner_login_created', v_job.tenant_id, null);
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema platform from public;
grant execute on function platform.sign_in(text, text), platform.customers(),
  platform.suspend(uuid, text), platform.reactivate(uuid, text),
  platform.request_create_customer(jsonb), platform.jobs(int),
  platform.link_owner_login(uuid, text), platform.audit(int),
  platform.customer(uuid), platform.job(uuid), platform.request_import(uuid, jsonb),
  platform.request_import_apply(uuid), platform.login_candidates(uuid),
  platform.begin_logins(uuid, boolean), platform.link_customer_login(uuid, text),
  platform.request_invites(uuid), platform.invite_status(uuid),
  platform.invite_daily_limit() to app_rw;
grant execute on function platform.claim_job(), platform.finish_job(uuid, uuid, jsonb, text),
  platform.defer_job(uuid, timestamptz, jsonb), platform.invite_allowance(),
  platform.record_invite(uuid, uuid, text), platform.invite_daily_limit() to platform_loader;

-- migrate:down
create or replace function platform.link_owner_login(p_job uuid, p_sub text) returns void
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

drop function platform.invite_status(uuid);
drop function platform.request_invites(uuid);
drop function platform.link_customer_login(uuid, text);
drop function platform.begin_logins(uuid, boolean);
drop function platform.login_candidates(uuid);
drop function platform.job(uuid);
drop function platform.request_import_apply(uuid);
drop function platform.request_import(uuid, jsonb);
drop function platform.customer(uuid);
drop function platform.record_invite(uuid, uuid, text);
drop function platform.invite_allowance();
drop function platform.defer_job(uuid, timestamptz, jsonb);

create or replace function platform.claim_job() returns setof platform.job
language sql security definer
set search_path = pg_catalog, platform
as $$
  update platform.job
     set status = 'running', claimed_at = now(), attempts = attempts + 1
   where id = (select id from platform.job where status = 'queued'
                order by created_at for update skip locked limit 1)
  returning *;
$$;

drop function platform.invite_daily_limit();
drop table platform.invite;
drop index platform.job_queued;
delete from platform.job where kind <> 'create_customer';
alter table platform.job drop column run_after;
alter table platform.job drop constraint job_kind_check;
alter table platform.job add constraint job_kind_check check (kind in ('create_customer'));
create index job_queued on platform.job (created_at) where status = 'queued';
