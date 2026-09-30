-- migrate:up
-- Access groups for flexible structures (ADR 009). The groups, domains and policy matrix
-- are product-wide, defined in code (@outlet-ops/domain access.ts, @outlet-ops/workflow
-- bp-policy.ts) and written into every tenant by the product sync (sync-defs). This
-- migration adds what the database enforces:
--
--   * admin groups (USER_ADMIN, ACCOUNT_OWNER) hold only admin domains (USER_ACCESS,
--     COMPANY_SETTINGS, SECURITY_ROLES, WF_CONFIG): admin rights are not data access
--   * CHEF is retired in favour of STOCK_USER (assignments move)
--   * ROLE_CHANGE is user administration: its subject is under USER_ACCESS
--   * a stock user receives goods against an existing PO (PO view + adjustments modify);
--     creating a PO still needs PURCHASE_ORDERS modify
--   * users get a username and login type (onboarding file 07)
--   * USER_ACCESS gives a minimal directory and the structure tree within its scope

alter table core.domain add column admin boolean not null default false;

alter table core.security_group
  drop constraint security_group_kind_check,
  add constraint security_group_kind_check check (kind in ('role', 'user_based', 'admin'));

-- Admin groups may only be given admin domains.
create function core.check_admin_policy() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
begin
  if (select kind from core.security_group where id = new.group_id) = 'admin'
     and not (select admin from core.domain where id = new.domain_id) then
    raise exception 'ADMIN_NOT_DATA'
      using detail = 'admin groups hold user administration, not business data';
  end if;
  return new;
end $$;
revoke execute on function core.check_admin_policy() from public;
create trigger admin_not_data before insert or update on core.domain_policy
  for each row execute function core.check_admin_policy();

-- ---------------------------------------------------------------------------
-- Retire CHEF: its assignments become STOCK_USER at the same place
-- ---------------------------------------------------------------------------

insert into core.security_group (tenant_id, code, name, kind)
select tenant_id, 'STOCK_USER', 'Stock User', 'role' from core.security_group where code = 'CHEF'
on conflict (tenant_id, code) do nothing;

delete from core.role_assignment ra
 using core.security_group chef, core.security_group su
 where chef.id = ra.group_id and chef.code = 'CHEF'
   and su.tenant_id = chef.tenant_id and su.code = 'STOCK_USER'
   and exists (select 1 from core.role_assignment x
                where x.user_id = ra.user_id and x.group_id = su.id and x.node_id = ra.node_id
                  and x.effective_from = ra.effective_from);
update core.role_assignment ra
   set group_id = su.id
  from core.security_group chef, core.security_group su
 where chef.id = ra.group_id and chef.code = 'CHEF'
   and su.tenant_id = chef.tenant_id and su.code = 'STOCK_USER';
delete from core.domain_policy where group_id in (select id from core.security_group where code = 'CHEF');
delete from core.bp_policy where group_id in (select id from core.security_group where code = 'CHEF');
delete from core.security_group g
 where g.code = 'CHEF'
   and not exists (select 1 from wf.step_instance s
                    where g.id in (s.assignee_group_id, s.escalate_to_group_id));

-- ---------------------------------------------------------------------------
-- ROLE_CHANGE is user administration (USER_ACCESS)
-- ---------------------------------------------------------------------------

update core.domain_table set domain_code = 'USER_ACCESS' where table_name = 'hr.role_change'::regclass;
select core.apply_domain_rls('hr.role_change');

do $$
declare
  v_src text := pg_get_functiondef(
    'hr.request_role_change(text, uuid, text, uuid, boolean, date, date, uuid, text, text)'::regprocedure);
begin
  if position('SECURITY_ROLES' in v_src) = 0 then
    raise exception 'hr.request_role_change no longer checks SECURITY_ROLES; update this migration';
  end if;
  execute replace(v_src, 'SECURITY_ROLES', 'USER_ACCESS');
end $$;

-- ---------------------------------------------------------------------------
-- Receiving against a PO: stock users receive, only PO managers create
-- ---------------------------------------------------------------------------

do $$
declare
  v_src text := pg_get_functiondef('inv.receive(uuid, jsonb, text)'::regprocedure);
  v_old text := 'perform inv.require(''PURCHASE_ORDERS'', ''modify'', v_po.delivery_node_id);';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'inv.receive changed; update this migration';
  end if;
  execute replace(v_src, v_old,
    'perform inv.require(''PURCHASE_ORDERS'', ''view'', v_po.delivery_node_id);
  -- receiving changes stock: whoever may adjust stock at the store (stock users and up)
  perform inv.require(''STOCK_ADJUSTMENTS'', ''modify'', v_po.delivery_node_id);');
end $$;

-- ---------------------------------------------------------------------------
-- Users: username and login type
-- ---------------------------------------------------------------------------

alter table core.app_user
  add column username text check (username ~ '^[a-z0-9][a-z0-9._-]*$'),
  add column email text,
  add column login_type text not null default 'username' check (login_type in ('username', 'email'));
create unique index app_user_username on core.app_user (tenant_id, username) where username is not null;

-- ---------------------------------------------------------------------------
-- USER_ACCESS reads: people and places within the admin's scope, nothing else
-- ---------------------------------------------------------------------------

-- Is p_node (either tree) within the caller's USER_ACCESS scope? Org nodes directly;
-- delivery nodes through the org node they are linked to (node_link), or below it.
create function core.in_user_access_scope(p_node uuid, p_access text default 'view')
returns boolean
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  select case n.type
    when 'org' then core.can('USER_ACCESS', p_access, n.id, null)
    else exists (
      select 1 from core.node_link nl
        join core.hierarchy_node d on d.id = nl.delivery_node_id
       where d.path @> n.path and core.can('USER_ACCESS', p_access, nl.org_node_id, null))
  end
    from core.hierarchy_node n
   where n.id = p_node and n.tenant_id = core.my_tenant();
$$;

-- Users whose home is within scope: name, username, job role, home, status only.
create function core.user_directory()
returns table (user_id uuid, display_name text, username text, status text,
               job_role_code text, job_title text, home_node_id uuid, home_node_code text,
               home_node_name text)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select u.id, u.display_name, u.username, u.status, w.role_code, j.name, n.id, n.code, n.name
    from core.app_user u
    join hr.worker w on w.owner_user_id = u.id
    join core.hierarchy_node n on n.id = w.org_node_id
    left join hr.job_role j on j.tenant_id = w.tenant_id and j.code = w.role_code
   where u.tenant_id = core.my_tenant()
     and core.in_user_access_scope(w.org_node_id)
   order by n.path, u.display_name;
$$;

-- The structure within scope, both trees.
create function core.structure_tree()
returns table (node_id uuid, type text, kind text, code text, name text, parent_id uuid,
               depth int, outlet_format text, holds_stock boolean, is_main_store boolean,
               timezone text)
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  select n.id, n.type, n.kind, n.code, n.name, n.parent_id, nlevel(n.path), n.outlet_format,
         n.holds_stock, n.is_main_store, n.timezone
    from core.hierarchy_node n
   where n.tenant_id = core.my_tenant() and n.archived_at is null
     and core.in_user_access_scope(n.id)
   order by n.type desc, n.path;
$$;

revoke execute on function core.in_user_access_scope(uuid, text), core.user_directory(),
  core.structure_tree() from public;
grant execute on function core.in_user_access_scope(uuid, text), core.user_directory(),
  core.structure_tree() to app_rw;

-- migrate:down
drop function core.structure_tree();
drop function core.user_directory();
drop function core.in_user_access_scope(uuid, text);
drop index core.app_user_username;
alter table core.app_user drop column username, drop column email, drop column login_type;
do $$
declare
  v_src text := pg_get_functiondef('inv.receive(uuid, jsonb, text)'::regprocedure);
begin
  execute replace(replace(v_src,
    'perform inv.require(''PURCHASE_ORDERS'', ''view'', v_po.delivery_node_id);', ''),
    E'-- receiving changes stock: whoever may adjust stock at the store (stock users and up)\n  perform inv.require(''STOCK_ADJUSTMENTS'', ''modify'', v_po.delivery_node_id);',
    'perform inv.require(''PURCHASE_ORDERS'', ''modify'', v_po.delivery_node_id);');
end $$;
do $$
declare
  v_src text := pg_get_functiondef(
    'hr.request_role_change(text, uuid, text, uuid, boolean, date, date, uuid, text, text)'::regprocedure);
begin
  execute replace(v_src, 'USER_ACCESS', 'SECURITY_ROLES');
end $$;
update core.domain_table set domain_code = 'SECURITY_ROLES' where table_name = 'hr.role_change'::regclass;
select core.apply_domain_rls('hr.role_change');
drop trigger admin_not_data on core.domain_policy;
drop function core.check_admin_policy();
delete from core.domain_policy where group_id in (select id from core.security_group where kind = 'admin');
delete from core.bp_policy where group_id in (select id from core.security_group where kind = 'admin');
update core.security_group set kind = 'role' where kind = 'admin';
alter table core.security_group
  drop constraint security_group_kind_check,
  add constraint security_group_kind_check check (kind in ('role', 'user_based'));
alter table core.domain drop column admin;
