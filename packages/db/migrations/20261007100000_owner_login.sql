-- migrate:up
-- A new customer's first account owner may be a username login (ADR 013 addendum): the
-- console takes an optional owner username and login type, so a customer created ahead of
-- its import gets the same owner as its file 07 (the test customers' owners are username
-- logins without email). Email owners get Cognito's invitation; username owners get no
-- email, and their login is created on the customer's Logins page.

create or replace function platform.request_create_customer(p jsonb) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_admin uuid := platform.current_admin();
  v_code text := upper(trim(p ->> 'code'));
  v_login text := coalesce(nullif(trim(p #>> '{owner,login_type}'), ''), 'email');
  v_email text := nullif(lower(trim(p #>> '{owner,email}')), '');
  v_username text;
  v_id uuid;
begin
  if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9-]{1,39}$' then
    raise exception 'INVALID_CUSTOMER_CODE';
  end if;
  v_username := coalesce(nullif(lower(trim(p #>> '{owner,username}')), ''),
                         lower(v_code) || '.owner');
  if nullif(trim(p ->> 'name'), '') is null or nullif(trim(p #>> '{owner,display_name}'), '') is null
     or v_login not in ('email', 'username')
     or v_username !~ '^[a-z0-9][a-z0-9._-]{1,63}$'
     or (v_login = 'email' and (v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
     or (v_login = 'username' and v_email is not null) then
    raise exception 'INVALID_CUSTOMER';
  end if;
  if exists (select 1 from core.tenant where code = v_code)
     or exists (select 1 from platform.job where kind = 'create_customer'
                   and status in ('queued', 'running') and payload ->> 'code' = v_code) then
    raise exception 'CUSTOMER_CODE_TAKEN';
  end if;
  if exists (select 1 from core.app_user where kind = 'human' and lower(username) = v_username)
     or exists (select 1 from platform.job where kind = 'create_customer'
                   and status in ('queued', 'running')
                   and payload #>> '{owner,username}' = v_username) then
    raise exception 'USERNAME_TAKEN';
  end if;
  if v_email is not null
     and exists (select 1 from core.app_user where kind = 'human' and lower(email) = v_email) then
    raise exception 'EMAIL_TAKEN';
  end if;
  insert into platform.job (kind, payload, created_by)
  values ('create_customer',
          p || jsonb_build_object(
            'code', v_code,
            'owner', jsonb_build_object('display_name', trim(p #>> '{owner,display_name}'),
                                        'email', v_email, 'username', v_username,
                                        'login_type', v_login)),
          v_admin)
  returning id into v_id;
  perform platform.log('create_customer_requested', null, null,
                       jsonb_build_object('job', v_id, 'code', v_code,
                                          'is_test', coalesce((p ->> 'is_test')::boolean, false),
                                          'owner_username', v_username,
                                          'owner_login_type', v_login));
  return v_id;
end $$;

-- migrate:down
create or replace function platform.request_create_customer(p jsonb) returns uuid
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
