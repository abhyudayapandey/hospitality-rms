-- migrate:up
-- Show as someone else, for demos (ADR 071). A demo presenter is a person in a test customer
-- (core.tenant.is_test) marked demo_presenter (file 07). Signed in as themselves, they pick
-- anyone active in their own company and see the app as that person: every request then
-- runs as that person (app.user_id), so it sees exactly what they would. Nothing of it
-- exists for a real customer: the flag can only be set in a test customer.
--
-- The database holds the line, not the screen:
--   * core.begin_show_as(target), called as the presenter, checks the presenter and the
--     target and opens a row in core.show_as_log;
--   * every request that shows as someone calls core.presented_by(presenter) as that person
--     first; it refuses unless the presenter is still a presenter in the same test company
--     and has an open row for this person, and sets app.presented_by;
--   * every audit row written while showing as someone carries presented_by;
--   * while showing as someone, nothing touches their login: changing a password, signing
--     out everywhere, linking or resetting a login are refused (PRESENTING).

alter table core.app_user add column demo_presenter boolean not null default false;

create function core.demo_presenter_test_only() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
begin
  if new.demo_presenter and not coalesce(
       (select t.is_test from core.tenant t where t.id = new.tenant_id), false) then
    raise exception 'NOT_A_TEST_CUSTOMER'
      using detail = 'only a test customer may have a demo presenter';
  end if;
  return new;
end $$;
create trigger app_user_demo_presenter_test_only
  before insert or update of demo_presenter on core.app_user
  for each row when (new.demo_presenter) execute function core.demo_presenter_test_only();

-- Each time a presenter starts and stops showing as someone.
create table core.show_as_log (
  id uuid primary key default core.uuid_v7(),
  tenant_id uuid not null references core.tenant(id),
  presenter_id uuid not null references core.app_user(id),
  target_id uuid not null references core.app_user(id),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default core.current_user_id(),
  updated_at timestamptz not null default now(),
  updated_by uuid default core.current_user_id()
);
create unique index show_as_log_open on core.show_as_log (presenter_id) where ended_at is null;
alter table core.show_as_log enable row level security;
revoke all on core.show_as_log from public, app_rw, wf_executor, platform_loader;
select audit.enable('core.show_as_log');

-- Every audit row says who was showing the app as the actor, when someone was.
alter table audit.log add column presented_by uuid;

create or replace function audit.capture() returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changed text[];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);

  select array_agg(k order by k) into v_changed
    from (select jsonb_object_keys(coalesce(v_new, '{}')) as k
          union
          select jsonb_object_keys(coalesce(v_old, '{}'))) keys
   where (v_old -> k) is distinct from (v_new -> k);

  if tg_nargs > 0 and tg_argv[0] = 'names_only' then
    v_old := null;
    v_new := null;
  end if;

  insert into audit.log (tenant_id, actor_id, actor_kind, table_name, row_id, op,
                         before, after, changed_fields, granting_node_id, request_id,
                         for_user_id, presented_by)
  values (coalesce((v_row ->> 'tenant_id')::uuid,
                   case when tg_table_schema = 'core' and tg_table_name = 'tenant'
                        then (v_row ->> 'id')::uuid end),
          core.current_user_id(),
          coalesce(nullif(current_setting('app.actor_kind', true), ''), 'human'),
          tg_table_schema || '.' || tg_table_name,
          (v_row ->> 'id')::uuid,
          tg_op,
          v_old, v_new, v_changed,
          nullif(current_setting('app.granting_node', true), '')::uuid,
          nullif(current_setting('app.wf_request', true), '')::uuid,
          nullif(current_setting('app.for_user', true), '')::uuid,
          nullif(current_setting('app.presented_by', true), '')::uuid);
  return coalesce(new, old);
end $$;

-- Who is showing the app as the caller in this request; null when nobody is.
create function core.presenting() returns uuid
language sql stable
set search_path = pg_catalog
as $$
  select nullif(current_setting('app.presented_by', true), '')::uuid;
$$;

-- Whether a person is a presenter: active, flagged, in an active test customer.
create function core.is_presenter(p_user uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select exists (
    select 1 from core.app_user u join core.tenant t on t.id = u.tenant_id
     where u.id = p_user and u.demo_presenter and u.status = 'active' and u.kind = 'human'
       and t.is_test and t.status = 'active');
$$;

-- Whether the caller is a presenter (and not showing as anyone): Me's "Show as" tile.
create function core.am_presenter() returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select core.presenting() is null and core.is_presenter(core.current_user_id());
$$;

-- Someone a presenter may show as: active, a person (not a service user), not themselves,
-- in the presenter's own company.
create function core.can_show_as(p_presenter uuid, p_target uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select core.is_presenter(p_presenter) and p_target <> p_presenter
     and exists (select 1 from core.app_user t join core.app_user p on p.id = p_presenter
                  where t.id = p_target and t.tenant_id = p.tenant_id
                    and t.status = 'active' and t.kind = 'human');
$$;

-- The people a presenter may show as, with their job title and where they work.
create function core.show_as_people()
returns table (id uuid, name text, job_title text, place text, outlet text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr
as $$
begin
  if not core.am_presenter() then
    raise exception 'NOT_AUTHORISED' using detail = 'not a demo presenter';
  end if;
  return query
    select u.id, u.display_name, jr.name, h.name, o.name
      from core.app_user u
      left join lateral (select w.* from hr.worker w
                          where w.owner_user_id = u.id and w.status = 'active'
                          order by w.id limit 1) w on true
      left join hr.job_role jr on jr.tenant_id = u.tenant_id and jr.code = w.role_code
      left join core.hierarchy_node h on h.id = w.org_node_id
      left join core.hierarchy_node o on o.id = core.nearest(w.org_node_id, array['outlet', 'site'])
     where u.tenant_id = core.my_tenant() and u.id <> core.current_user_id()
       and core.can_show_as(core.current_user_id(), u.id)
     order by o.name nulls first, (h.kind = 'outlet') desc,
              coalesce(array_position(array['kitchen', 'service', 'housekeeping', 'other'],
                                      h.department_type), 9),
              h.name nulls first, jr.name, u.display_name;
end $$;

-- Called as the presenter: starts showing as p_target (ending any earlier one).
create function core.begin_show_as(p_target uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core
as $$
declare
  v_me uuid := core.current_user_id();
begin
  if core.presenting() is not null or not core.can_show_as(v_me, p_target) then
    raise exception 'NOT_AUTHORISED' using detail = format('show as %s', p_target);
  end if;
  update core.show_as_log set ended_at = now() where presenter_id = v_me and ended_at is null;
  insert into core.show_as_log (tenant_id, presenter_id, target_id)
  values (core.my_tenant(), v_me, p_target);
end $$;

-- Called as the presenter: back to themselves.
create function core.end_show_as() returns void
language plpgsql security definer
set search_path = pg_catalog, core
as $$
begin
  if core.presenting() is not null then
    raise exception 'NOT_AUTHORISED' using detail = 'still showing as someone';
  end if;
  update core.show_as_log set ended_at = now()
   where presenter_id = core.current_user_id() and ended_at is null;
end $$;

-- Called first in every request that shows as someone, as that person (app.user_id is the
-- person shown): checks the presenter may and has begun to, and marks the request.
create function core.presented_by(p_presenter uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core
as $$
declare
  v_target uuid := core.current_user_id();
begin
  if v_target is null or core.presenting() is not null
     or not core.can_show_as(p_presenter, v_target)
     or not exists (select 1 from core.show_as_log l
                     where l.presenter_id = p_presenter and l.target_id = v_target
                       and l.ended_at is null) then
    raise exception 'NOT_AUTHORISED' using detail = format('presented by %s', p_presenter);
  end if;
  perform set_config('app.presented_by', p_presenter::text, true);
end $$;

-- Whether the caller (the presenter) has an open "show as" for p_target: the server checks
-- this once per request before showing as them.
create function core.showing_as(p_target uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select core.presenting() is null and core.can_show_as(core.current_user_id(), p_target)
     and exists (select 1 from core.show_as_log l
                  where l.presenter_id = core.current_user_id() and l.target_id = p_target
                    and l.ended_at is null);
$$;

-- Nothing touches a login while showing as its person: the own-login and login-admin
-- functions all record a core.login_admin_event, and linking or ending sessions update
-- core.app_user.
create function core.refuse_while_presenting() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
begin
  -- read directly: this runs as whoever made the change (the loader too)
  if nullif(current_setting('app.presented_by', true), '') is not null then
    raise exception 'PRESENTING' using detail = 'showing the app as someone else';
  end if;
  return new;
end $$;
create trigger login_admin_event_not_presenting
  before insert on core.login_admin_event
  for each row execute function core.refuse_while_presenting();
create trigger app_user_login_not_presenting
  before update of cognito_sub, sessions_valid_from, username, email, login_type
  on core.app_user
  for each row execute function core.refuse_while_presenting();

revoke execute on function core.demo_presenter_test_only(), core.presenting(),
  core.is_presenter(uuid), core.am_presenter(), core.can_show_as(uuid, uuid),
  core.show_as_people(), core.begin_show_as(uuid), core.end_show_as(),
  core.presented_by(uuid), core.showing_as(uuid), core.refuse_while_presenting()
  from public, platform_loader;
grant execute on function core.presenting(), core.am_presenter(), core.show_as_people(),
  core.begin_show_as(uuid), core.end_show_as(), core.presented_by(uuid),
  core.showing_as(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop trigger app_user_login_not_presenting on core.app_user;
drop trigger login_admin_event_not_presenting on core.login_admin_event;
drop function core.refuse_while_presenting();
drop function core.showing_as(uuid);
drop function core.presented_by(uuid);
drop function core.end_show_as();
drop function core.begin_show_as(uuid);
drop function core.show_as_people();
drop function core.can_show_as(uuid, uuid);
drop function core.am_presenter();
drop function core.is_presenter(uuid);
drop function core.presenting();
create or replace function audit.capture() returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changed text[];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);

  select array_agg(k order by k) into v_changed
    from (select jsonb_object_keys(coalesce(v_new, '{}')) as k
          union
          select jsonb_object_keys(coalesce(v_old, '{}'))) keys
   where (v_old -> k) is distinct from (v_new -> k);

  if tg_nargs > 0 and tg_argv[0] = 'names_only' then
    v_old := null;
    v_new := null;
  end if;

  insert into audit.log (tenant_id, actor_id, actor_kind, table_name, row_id, op,
                         before, after, changed_fields, granting_node_id, request_id,
                         for_user_id)
  values (coalesce((v_row ->> 'tenant_id')::uuid,
                   case when tg_table_schema = 'core' and tg_table_name = 'tenant'
                        then (v_row ->> 'id')::uuid end),
          core.current_user_id(),
          coalesce(nullif(current_setting('app.actor_kind', true), ''), 'human'),
          tg_table_schema || '.' || tg_table_name,
          (v_row ->> 'id')::uuid,
          tg_op,
          v_old, v_new, v_changed,
          nullif(current_setting('app.granting_node', true), '')::uuid,
          nullif(current_setting('app.wf_request', true), '')::uuid,
          nullif(current_setting('app.for_user', true), '')::uuid);
  return coalesce(new, old);
end $$;
alter table audit.log drop column presented_by;
drop table core.show_as_log;
drop trigger app_user_demo_presenter_test_only on core.app_user;
drop function core.demo_presenter_test_only();
alter table core.app_user drop column demo_presenter;
