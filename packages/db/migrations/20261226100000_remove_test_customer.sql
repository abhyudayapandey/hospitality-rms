-- migrate:up
-- Remove a test customer (ADR 139): a platform admin empties a TEST customer, as Start again
-- does (ADR 130), and takes it off the console's list. Nobody can sign in to it again. The
-- customer's row stays, marked removed, with the console's own records (jobs, files, audit),
-- so its history is kept; its code is not used again. Refused for a real customer and unless
-- the customer's name is typed to confirm.

alter table core.tenant add column removed_at timestamptz;

create or replace function core.tenant_active(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select exists (select 1 from core.tenant
                  where id = p_tenant and status = 'active' and removed_at is null)
$$;

create function platform.remove_test_customer(p_tenant uuid, p_confirm text) returns int
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_n int;
begin
  -- the same checks and the same emptying as Start again (an admin, a test customer, its name)
  v_n := platform.reset_test_customer(p_tenant, p_confirm);
  update core.tenant set removed_at = now() where id = p_tenant;
  perform platform.log('customer_removed', p_tenant, 'removed', jsonb_build_object('rows', v_n));
  return v_n;
end $$;
revoke execute on function platform.remove_test_customer(uuid, text) from public;
grant execute on function platform.remove_test_customer(uuid, text) to app_rw;

-- the list leaves removed customers out
create or replace function platform.customers()
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
     where t.removed_at is null
     order by t.name;
end $$;

-- a removed customer stays removed and is not paused or resumed (a migration that changes
-- every customer's settings still may); Start again refuses it below
create function core.tenant_not_removed() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
begin
  if old.removed_at is not null and new.removed_at is not distinct from old.removed_at
     and new.status is distinct from old.status then
    raise exception 'CUSTOMER_REMOVED' using detail = 'that customer was removed';
  end if;
  if old.removed_at is not null and new.removed_at is null then
    raise exception 'CUSTOMER_REMOVED' using detail = 'a removed customer stays removed';
  end if;
  return new;
end $$;
create trigger tenant_not_removed before update on core.tenant
  for each row execute function core.tenant_not_removed();

do $$
declare
  v_def text := pg_get_functiondef('platform.reset_test_customer(uuid,text)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def,
    $o$  if not v_t.is_test then$o$,
    $n$  if v_t.removed_at is not null then
    raise exception 'CUSTOMER_REMOVED' using detail = 'that customer was removed';
  end if;
  if not v_t.is_test then$n$);
  if v_new = v_def then
    raise exception 'platform.reset_test_customer changed; update this migration';
  end if;
  execute v_new;
end $$;

-- migrate:down
do $$
declare
  v_def text := pg_get_functiondef('platform.reset_test_customer(uuid,text)'::regprocedure);
begin
  execute replace(v_def,
    $n$  if v_t.removed_at is not null then
    raise exception 'CUSTOMER_REMOVED' using detail = 'that customer was removed';
  end if;
  if not v_t.is_test then$n$,
    $o$  if not v_t.is_test then$o$);
end $$;
drop trigger tenant_not_removed on core.tenant;
drop function core.tenant_not_removed();
create or replace function platform.customers()
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
drop function platform.remove_test_customer(uuid, text);
create or replace function core.tenant_active(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$ select exists (select 1 from core.tenant where id = p_tenant and status = 'active') $$;
alter table core.tenant drop column removed_at;
