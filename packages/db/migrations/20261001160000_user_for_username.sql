-- migrate:up
-- Before sign-in: resolves an active user by customer code and username (onboarding
-- file 07). Like core.user_for_cognito_sub, the only thing app_rw may call with no user.
-- Used by the dev login (ADR 004) and later by username sign-in.
create function core.user_for_username(p_customer text, p_username text) returns uuid
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select u.id from core.app_user u join core.tenant t on t.id = u.tenant_id
   where t.code = p_customer and u.username = p_username and u.status = 'active'
     and u.kind = 'human';
$$;
revoke execute on function core.user_for_username(text, text) from public;
grant execute on function core.user_for_username(text, text) to app_rw;

-- migrate:down
drop function core.user_for_username(text, text);
