-- migrate:up
-- "Set up login again" is checked like a password reset (ADR 166, review C2). It resolved the
-- person with core.admin_user (USER_ACCESS view) and, when the login already existed, Cognito
-- got a new temporary password before core.link_login refused a view-only admin. The app now
-- asks core.login_admin_target(person, 'create_login') first: USER_ACCESS modify, scope, rank
-- and self rules, and an audit row, before any Cognito call.

alter table core.login_admin_event drop constraint login_admin_event_action_check;
alter table core.login_admin_event add constraint login_admin_event_action_check
  check (action in ('reset_password', 'disable_login', 'enable_login', 'change_own_password',
                    'change_own_password_failed', 'sign_out_everywhere', 'create_login'));

create or replace function core.login_admin_target(p_user uuid, p_action text)
returns table (username text, email text, login_type text, cognito_sub text)
language plpgsql security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_u core.app_user;
begin
  perform core.require_user_admin('modify');
  if p_action not in ('reset_password', 'disable_login', 'enable_login', 'create_login') then
    perform wf.fail('INVALID_ACTION', p_action);
  end if;
  perform core.check_admin_action(p_user, null, null);
  select * into v_u from core.app_user where id = p_user;
  if p_action = 'reset_password' and v_u.login_type <> 'username' then
    perform wf.fail('INVALID_ACTION', 'email logins have no password');
  end if;
  if p_action = 'create_login' and v_u.status <> 'active' then
    perform wf.fail('INVALID_STATE', 'the person is not active');
  end if;
  insert into core.login_admin_event (tenant_id, user_id, action)
  values (v_u.tenant_id, p_user, p_action);
  return query select v_u.username, v_u.email, v_u.login_type, v_u.cognito_sub;
end $$;

-- the access audit says it in words
select core.patch_function('core.access_audit(int)',
  $o$when 'sign_out_everywhere' then 'signed out of all devices' end$o$,
  $n$when 'sign_out_everywhere' then 'signed out of all devices'
                    when 'create_login' then 'login set up' end$n$);

-- migrate:down
select core.patch_function('core.access_audit(int)',
  $o$when 'sign_out_everywhere' then 'signed out of all devices'
                    when 'create_login' then 'login set up' end$o$,
  $n$when 'sign_out_everywhere' then 'signed out of all devices' end$n$);
create or replace function core.login_admin_target(p_user uuid, p_action text)
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
delete from core.login_admin_event where action = 'create_login';
alter table core.login_admin_event drop constraint login_admin_event_action_check;
alter table core.login_admin_event add constraint login_admin_event_action_check
  check (action in ('reset_password', 'disable_login', 'enable_login', 'change_own_password',
                    'change_own_password_failed', 'sign_out_everywhere'));
