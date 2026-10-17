-- migrate:up
-- New passwords for a test customer's logins (ADR 166, review M5). The repository is public
-- and its docs gave the Test<Role> rule, so anyone could sign in to a demo company in
-- production, its presenter too. The rule is gone; a platform admin gives every username login
-- of a test customer a new random one-time password from the Logins page, printed on the
-- login sheet. This says who gets one, ends their sessions in the app and writes the audit;
-- the console sets the passwords in Cognito. Test customers only.
create function platform.begin_new_passwords(p_tenant uuid)
returns table (user_id uuid, username text, display_name text)
language plpgsql security definer
set search_path = pg_catalog, core, platform
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
  if not v_tenant.is_test then
    raise exception 'TEST_CUSTOMER_ONLY';
  end if;
  if v_tenant.status <> 'active' then
    raise exception 'CUSTOMER_SUSPENDED';
  end if;
  -- whoever is signed in with the old password is signed out of the app at once
  update core.app_user u set sessions_valid_from = now()
   where u.tenant_id = p_tenant and u.kind = 'human' and u.status = 'active'
     and u.login_type = 'username' and u.cognito_sub is not null;
  get diagnostics v_count = row_count;
  perform platform.log('passwords_reset', p_tenant, null, jsonb_build_object('count', v_count));
  return query
    select u.id, u.username, u.display_name from core.app_user u
     where u.tenant_id = p_tenant and u.kind = 'human' and u.status = 'active'
       and u.login_type = 'username' and u.cognito_sub is not null
     order by u.username;
end $$;
revoke execute on function platform.begin_new_passwords(uuid) from public;
grant execute on function platform.begin_new_passwords(uuid) to app_rw;

-- the old option is refused for every customer now, test customers too
select core.patch_function('platform.begin_logins(uuid, boolean)',
  $o$if p_test_rule and not v_tenant.is_test then$o$,
  $n$if p_test_rule then$n$);
select core.patch_function('platform.begin_logins(uuid, boolean)',
  $o$'the Test<Role>!12 rule is only for test customers'$o$,
  $n$'pattern passwords are no longer given (ADR 166)'$n$);

-- migrate:down
select core.patch_function('platform.begin_logins(uuid, boolean)',
  $o$'pattern passwords are no longer given (ADR 166)'$o$,
  $n$'the Test<Role>!12 rule is only for test customers'$n$);
select core.patch_function('platform.begin_logins(uuid, boolean)',
  $o$if p_test_rule then$o$,
  $n$if p_test_rule and not v_tenant.is_test then$n$);
drop function platform.begin_new_passwords(uuid);
