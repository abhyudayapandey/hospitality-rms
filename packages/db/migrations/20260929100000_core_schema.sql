-- migrate:up
-- Core hierarchy and security tables (docs/LLD.md section 2, "core"), with the
-- AWS overrides from CLAUDE.md and the changes recorded in ADR 002.

-- ---------------------------------------------------------------------------
-- Primitives
-- ---------------------------------------------------------------------------

-- UUID v7 (time-ordered). PG16 has no built-in; PG18's uuidv7() can replace this.
create function core.uuid_v7() returns uuid
language sql volatile parallel safe as $$
  select encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              placing substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
              from 1 for 6),
      52, 1), 53, 1), 'hex')::uuid;
$$;

-- AWS override: replaces Supabase auth.uid(). Set per transaction by withUser().
create function core.current_user_id() returns uuid
language sql stable parallel safe as $$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$$;

-- Maintains updated_at / updated_by.
create function core.touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := core.current_user_id();
  return new;
end $$;

-- Adds the standard columns (CLAUDE.md conventions) and the touch trigger.
create function core.add_standard_columns(p_table regclass, p_with_tenant boolean default true)
returns void language plpgsql as $$
begin
  if p_with_tenant then
    execute format('alter table %s add column tenant_id uuid not null references core.tenant(id)', p_table);
  end if;
  execute format($f$
    alter table %s
      add column created_at timestamptz not null default now(),
      add column created_by uuid default core.current_user_id(),
      add column updated_at timestamptz not null default now(),
      add column updated_by uuid default core.current_user_id()$f$, p_table);
  execute format('create trigger touch before update on %s for each row execute function core.touch()', p_table);
end $$;
revoke execute on function core.add_standard_columns(regclass, boolean) from public;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table core.tenant (
  id uuid primary key default core.uuid_v7(),
  name text not null
);
select core.add_standard_columns('core.tenant', p_with_tenant => false);

create table core.hierarchy_node (
  id uuid primary key default core.uuid_v7(),
  type text not null check (type in ('org', 'delivery')),
  kind text not null,            -- company, region, area, outlet, dept | network, cwh, ck, hub, outlet, store
  name text not null,
  parent_id uuid references core.hierarchy_node(id),
  path ltree not null,           -- maintained by core.hierarchy_node_path()
  timezone text,                 -- IANA zone, set on outlet nodes
  archived_at timestamptz,
  unique (type, path)
);
select core.add_standard_columns('core.hierarchy_node');
create index hierarchy_node_path_gist on core.hierarchy_node using gist (path);
create index hierarchy_node_parent on core.hierarchy_node (parent_id);

-- Path = parent path + a label derived from the node id. Re-parenting rewrites
-- the whole subtree. Parents must be in the same tree and not create a cycle.
create function core.hierarchy_node_path() returns trigger
language plpgsql as $$
declare
  v_parent core.hierarchy_node;
  v_label ltree := text2ltree('n' || replace(new.id::text, '-', ''));
  v_old_path ltree;
begin
  if new.parent_id is null then
    new.path := v_label;
  else
    select * into v_parent from core.hierarchy_node where id = new.parent_id;
    if v_parent.type is distinct from new.type then
      raise exception 'INVALID_PARENT' using detail = 'parent must be in the same hierarchy tree';
    end if;
    if tg_op = 'UPDATE' and v_parent.path <@ old.path then
      raise exception 'INVALID_PARENT' using detail = 'a node cannot move under its own subtree';
    end if;
    new.path := v_parent.path || v_label;
  end if;

  if tg_op = 'UPDATE' and new.path is distinct from old.path then
    v_old_path := old.path;
    update core.hierarchy_node
       set path = new.path || subpath(path, nlevel(v_old_path))
     where path <@ v_old_path and id <> new.id;
  end if;
  return new;
end $$;

create trigger path before insert or update of parent_id, type on core.hierarchy_node
  for each row execute function core.hierarchy_node_path();

-- Links an org outlet to its delivery outlet (derived cross-hierarchy access).
create table core.node_link (
  org_node_id uuid not null references core.hierarchy_node(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  primary key (org_node_id, delivery_node_id)
);
select core.add_standard_columns('core.node_link');
create index node_link_delivery on core.node_link (delivery_node_id);

create function core.node_link_check() returns trigger
language plpgsql as $$
begin
  if (select type from core.hierarchy_node where id = new.org_node_id) <> 'org'
     or (select type from core.hierarchy_node where id = new.delivery_node_id) <> 'delivery' then
    raise exception 'INVALID_NODE_LINK' using detail = 'node_link joins an org node to a delivery node';
  end if;
  return new;
end $$;
create trigger check_types before insert or update on core.node_link
  for each row execute function core.node_link_check();

-- AWS override: no auth.users. cognito_sub maps the Cognito identity when auth lands.
create table core.app_user (
  id uuid primary key default core.uuid_v7(),
  kind text not null check (kind in ('human', 'service')),
  display_name text not null,
  phone text,
  cognito_sub text unique,
  status text not null default 'active' check (status in ('active', 'inactive'))
);
select core.add_standard_columns('core.app_user');

create table core.security_group (
  id uuid primary key default core.uuid_v7(),
  code text not null,
  name text not null,
  kind text not null check (kind in ('role', 'user_based'))
);
select core.add_standard_columns('core.security_group');
alter table core.security_group add constraint security_group_code_key unique (tenant_id, code);

create table core.role_assignment (
  id uuid primary key default core.uuid_v7(),
  user_id uuid not null references core.app_user(id),
  group_id uuid not null references core.security_group(id),
  node_id uuid not null references core.hierarchy_node(id),
  include_descendants boolean not null default true,   -- ADR 002
  effective_from date not null default current_date,
  effective_to date,
  check (effective_to is null or effective_to >= effective_from),
  unique (user_id, group_id, node_id, effective_from)
);
select core.add_standard_columns('core.role_assignment');
create index role_assignment_user on core.role_assignment (user_id);

create table core.domain (
  id uuid primary key default core.uuid_v7(),
  code text not null,                                   -- STOCK_LEVELS, LEAVE ...
  hierarchy_type text not null check (hierarchy_type in ('org', 'delivery', 'self'))
);
select core.add_standard_columns('core.domain');
alter table core.domain add constraint domain_code_key unique (tenant_id, code);

-- Which table belongs to which domain; read by core.apply_domain_rls(). ADR 002 adds
-- modify_domain_id, insert_only and node_columns.
create table core.domain_table (
  table_name regclass primary key,
  domain_id uuid not null references core.domain(id),
  modify_domain_id uuid references core.domain(id),     -- writes checked here if set
  insert_only boolean not null default false,           -- e.g. inv.stock_ledger
  node_columns text[]                                   -- default by tree; >1 = multi-leg
);
select core.add_standard_columns('core.domain_table');

create table core.domain_policy (
  domain_id uuid not null references core.domain(id),
  group_id uuid not null references core.security_group(id),
  access text not null check (access in ('view', 'modify')),
  primary key (domain_id, group_id)
);
select core.add_standard_columns('core.domain_policy');

create table core.bp_policy (
  process_type text not null,
  step text not null,
  group_id uuid not null references core.security_group(id),
  action text not null check (action in ('initiate', 'approve', 'cancel', 'view')),
  condition jsonb,                                      -- e.g. {"amount_gt": 50000}
  primary key (process_type, step, group_id, action)
);
select core.add_standard_columns('core.bp_policy');

-- migrate:down
drop table core.bp_policy;
drop table core.domain_policy;
drop table core.domain_table;
drop table core.domain;
drop table core.role_assignment;
drop table core.security_group;
drop table core.app_user;
drop table core.node_link;
drop function core.node_link_check();
drop table core.hierarchy_node;
drop function core.hierarchy_node_path();
drop table core.tenant;
drop function core.add_standard_columns(regclass, boolean);
drop function core.touch();
drop function core.current_user_id();
drop function core.uuid_v7();
