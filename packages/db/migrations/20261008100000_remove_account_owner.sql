-- migrate:up
-- Removing an extra account owner from the Platform console (ADR 013 addendum). The case:
-- a customer created with a first owner whose username was not the one in its 07_users.csv,
-- so the import added the file's owner as a second person. The platform admin removes the
-- extra one, with a reason, in the platform audit (and every row change in audit.log).
--
-- Deleted only if the person never signed in, has no login, and nothing refers to them
-- but their own access and their worker row (any other reference, e.g. a request, a
-- shift or a leave balance, makes the delete fail and it deactivates instead).
-- Otherwise: inactive, and their ACCOUNT_OWNER access revoked. The last owner is never
-- removed.
--
-- Username owners must now be named explicitly: no silent <code>.owner for them.

create function platform.account_owners(p_tenant uuid)
returns table (user_id uuid, username text, display_name text, login_type text, status text,
               has_login boolean, created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  return query
    select distinct u.id, u.username, u.display_name, u.login_type, u.status,
           u.cognito_sub is not null, u.created_at, u.last_sign_in_at
      from core.role_assignment ra
      join core.security_group g on g.id = ra.group_id and g.code = 'ACCOUNT_OWNER'
      join core.app_user u on u.id = ra.user_id and u.kind = 'human'
     where ra.tenant_id = p_tenant
     order by u.created_at;
end $$;

create function platform.remove_account_owner(p_tenant uuid, p_user uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, hr, platform
as $$
declare
  v_user core.app_user;
  v_mode text;
begin
  perform platform.current_admin();
  if nullif(trim(p_reason), '') is null then
    raise exception 'REASON_REQUIRED';
  end if;
  select u.* into v_user from core.app_user u
   where u.id = p_user and u.tenant_id = p_tenant and u.kind = 'human'
     and exists (select 1 from core.role_assignment ra
                   join core.security_group g on g.id = ra.group_id and g.code = 'ACCOUNT_OWNER'
                  where ra.user_id = u.id);
  if not found then
    raise exception 'INVALID_STATE' using detail = 'not an account owner of this customer';
  end if;
  if not exists (select 1 from core.role_assignment ra
                   join core.security_group g on g.id = ra.group_id and g.code = 'ACCOUNT_OWNER'
                   join core.app_user u on u.id = ra.user_id and u.status = 'active'
                  where ra.tenant_id = p_tenant and ra.user_id <> p_user
                    and ra.effective_from <= current_date
                    and (ra.effective_to is null or ra.effective_to >= current_date)) then
    raise exception 'LAST_ACCOUNT_OWNER'
      using detail = 'the organisation must keep at least one active Account Owner';
  end if;

  v_mode := 'deactivated';
  if v_user.last_sign_in_at is null and v_user.cognito_sub is null then
    begin
      delete from core.role_assignment where user_id = p_user;
      delete from hr.worker where owner_user_id = p_user;
      delete from core.app_user where id = p_user;
      v_mode := 'deleted';
    exception when foreign_key_violation then
      -- something refers to them (activity or data): keep the row, deactivate below
      v_mode := 'deactivated';
    end;
  end if;
  if v_mode = 'deactivated' then
    delete from core.role_assignment ra using core.security_group g
     where g.id = ra.group_id and g.code = 'ACCOUNT_OWNER' and ra.user_id = p_user;
    update core.app_user set status = 'inactive' where id = p_user and status <> 'inactive';
  end if;

  perform platform.log('account_owner_removed', p_tenant, trim(p_reason),
                       jsonb_build_object('user', p_user, 'username', v_user.username,
                                          'mode', v_mode));
  return jsonb_build_object(
    'mode', v_mode, 'username', v_user.username,
    -- the server disables this Cognito login and signs it out everywhere
    'login', case when v_mode = 'deactivated' and v_user.cognito_sub is not null
                  then v_user.username end);
end $$;

-- A username owner is named explicitly (their username from the customer's 07_users.csv);
-- only an email owner may still default to <code>.owner.
do $$
declare
  v_src text := pg_get_functiondef('platform.request_create_customer(jsonb)'::regprocedure);
  v_old text := 'v_username := coalesce(nullif(lower(trim(p #>> ''{owner,username}'')), ''''),
                         lower(v_code) || ''.owner'');';
  v_new text := 'v_username := coalesce(nullif(lower(trim(p #>> ''{owner,username}'')), ''''),
                         case when v_login = ''email'' then lower(v_code) || ''.owner'' end);
  if v_username is null then
    raise exception ''INVALID_CUSTOMER'' using detail = ''a username owner needs their username'';
  end if;';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'platform.request_create_customer changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

grant execute on function platform.account_owners(uuid),
  platform.remove_account_owner(uuid, uuid, text) to app_rw;

-- migrate:down
do $$
declare
  v_src text := pg_get_functiondef('platform.request_create_customer(jsonb)'::regprocedure);
begin
  execute replace(v_src,
    'v_username := coalesce(nullif(lower(trim(p #>> ''{owner,username}'')), ''''),
                         case when v_login = ''email'' then lower(v_code) || ''.owner'' end);
  if v_username is null then
    raise exception ''INVALID_CUSTOMER'' using detail = ''a username owner needs their username'';
  end if;',
    'v_username := coalesce(nullif(lower(trim(p #>> ''{owner,username}'')), ''''),
                         lower(v_code) || ''.owner'');');
end $$;
drop function platform.remove_account_owner(uuid, uuid, text);
drop function platform.account_owners(uuid);
