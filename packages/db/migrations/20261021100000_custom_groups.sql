-- migrate:up
-- Customer-specific access groups (AC-1, ADR 027). A company builds its own group from the
-- product's business domains (kind 'custom'), and may let it carry the request and
-- approval duties of product roles (acts_as): wherever the workflow looks for holders of
-- a role at a place, holders of a custom group carrying that role count too. core.can is
-- unchanged: it already reads each company's own domain_policy rows.
--
-- Who builds them: the Account Owner in the app (core.save_custom_group), or a platform
-- admin through the onboarding file 05 (core.put_custom_group as platform_loader). The
-- product sync leaves custom groups and their rights alone.

alter table core.security_group drop constraint security_group_kind_check;
alter table core.security_group add constraint security_group_kind_check
  check (kind in ('role', 'user_based', 'admin', 'custom'));
alter table core.security_group
  add column acts_as text[] not null default '{}',
  add column archived_at timestamptz,
  add constraint acts_as_custom_only check (kind = 'custom' or acts_as = '{}');

-- The product roles a custom group may carry the duties of: business roles, never admin
-- ones (Account Owner, User Admin), the security roles (Security Admin approves sensitive
-- grants; Auditor reads the access audit), the AI agent or SELF.
create function core.carriable_role(p_tenant uuid, p_code text) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select exists (select 1 from core.security_group g
                  where g.tenant_id = p_tenant and g.code = p_code and g.kind = 'role'
                    and g.code not in ('AI_AGENT', 'SECURITY_ADMIN', 'AUDITOR'));
$$;

-- A group and every live custom group of the same company that carries its duties.
create function core.acting_groups(p_group uuid) returns uuid[]
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select array[p_group] || coalesce(array_agg(c.id), '{}')
    from core.security_group g
    left join core.security_group c on c.tenant_id = g.tenant_id and c.kind = 'custom'
                                   and c.archived_at is null and g.code = any (c.acts_as)
   where g.id = p_group
   group by g.id;
$$;

-- Holders and nearest holders of a group count the custom groups that carry it.
do $$
declare
  v_fn text;
  v_src text;
  v_new text;
begin
  foreach v_fn in array array[
    'core.group_holders(uuid, uuid)',
    'core.site_group_holders(uuid, uuid)',
    'core.nearest_group_node(uuid, uuid, uuid[], boolean)',
    'core.site_group_node(uuid, uuid, uuid[], boolean)'] loop
    v_src := pg_get_functiondef(v_fn::regprocedure);
    v_new := replace(replace(v_src,
      'ra.group_id = p_group', 'ra.group_id = any (core.acting_groups(p_group))'),
      'on ra.group_id = p_group', 'on ra.group_id = any (core.acting_groups(p_group))');
    if v_new = v_src then
      raise exception '% changed; update this migration', v_fn;
    end if;
    execute v_new;
  end loop;
end $$;

-- Sensitive (granting needs approval, ADR 011): product groups as before; a custom group
-- when it carries a sensitive role's duties, includes pay, or includes a right that only
-- sensitive product groups hold at that level.
create or replace function core.is_sensitive_group(p_group uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  with sens as (select array['OUTLET_MANAGER', 'USER_ADMIN', 'ACCOUNT_OWNER', 'HR_ADMIN',
                             'OUTLET_HR'] as codes),
  g as (select * from core.security_group where id = p_group),
  pay as (
    select exists (select 1 from core.domain_policy dp
                     join core.domain d on d.id = dp.domain_id and d.code = 'COMPENSATION'
                    where dp.group_id = p_group) as v),
  -- product groups that are not sensitive, in the same company
  plain as (
    select pg.id from core.security_group pg, g, sens
     where pg.tenant_id = g.tenant_id and pg.kind = 'role' and pg.code <> all (sens.codes)
       and not exists (select 1 from core.domain_policy dp
                         join core.domain d on d.id = dp.domain_id and d.code = 'COMPENSATION'
                        where dp.group_id = pg.id))
  select case
    when g.kind <> 'custom' then
      g.code = any (sens.codes) or (g.kind <> 'user_based' and pay.v)
    else
      pay.v
      or g.acts_as && sens.codes
      or exists (
        select 1 from core.domain_policy dp
         where dp.group_id = p_group
           and not exists (select 1 from core.domain_policy pp
                            where pp.group_id in (select id from plain)
                              and pp.domain_id = dp.domain_id
                              and (dp.access = 'view' or pp.access = 'modify')))
    end
    from g, sens, pay;
$$;

-- Checks and writes one custom group for a company: the shared core of the app path and
-- the loader. Rights are {"DOMAIN": "view" | "modify"}; business domains only.
create function core.put_custom_group(p_tenant uuid, p_code text, p_name text, p_rights jsonb,
                                      p_acts_as text[]) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core
as $$
declare
  v_g core.security_group;
  v_right record;
  v_role text;
begin
  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{2,39}$' then
    raise exception 'INVALID_GROUP' using detail = 'code: capitals, digits and _ (3 to 40)';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'INVALID_GROUP' using detail = 'a name is needed';
  end if;
  if jsonb_typeof(coalesce(p_rights, 'null')) <> 'object' then
    raise exception 'INVALID_GROUP' using detail = 'rights must be an object';
  end if;
  if p_rights = '{}' and coalesce(cardinality(p_acts_as), 0) = 0 then
    raise exception 'INVALID_GROUP' using detail = 'a group needs at least one right or role';
  end if;
  select * into v_g from core.security_group where tenant_id = p_tenant and code = p_code;
  if found and v_g.kind <> 'custom' then
    raise exception 'GROUP_CODE_TAKEN' using detail = p_code;
  end if;
  for v_right in select key, value from jsonb_each_text(p_rights) loop
    if v_right.value not in ('view', 'modify')
       or not exists (select 1 from core.domain d
                       where d.tenant_id = p_tenant and d.code = v_right.key and not d.admin) then
      raise exception 'INVALID_GROUP' using detail = format('right %s:%s', v_right.key, v_right.value);
    end if;
  end loop;
  foreach v_role in array coalesce(p_acts_as, '{}') loop
    if not core.carriable_role(p_tenant, v_role) then
      raise exception 'INVALID_GROUP' using detail = format('role %s', v_role);
    end if;
  end loop;

  insert into core.security_group (tenant_id, code, name, kind, acts_as)
  values (p_tenant, p_code, trim(p_name), 'custom', coalesce(p_acts_as, '{}'))
  on conflict (tenant_id, code) do update
    set name = excluded.name, acts_as = excluded.acts_as, archived_at = null
    where (core.security_group.name, core.security_group.acts_as, core.security_group.archived_at)
          is distinct from (excluded.name, excluded.acts_as, null)
  returning * into v_g;
  if v_g.id is null then
    select * into v_g from core.security_group where tenant_id = p_tenant and code = p_code;
  end if;

  delete from core.domain_policy dp
   where dp.group_id = v_g.id
     and not exists (select 1 from jsonb_each_text(p_rights) r
                       join core.domain d on d.tenant_id = p_tenant and d.code = r.key
                      where d.id = dp.domain_id);
  insert into core.domain_policy (tenant_id, domain_id, group_id, access)
  select p_tenant, d.id, v_g.id, r.value
    from jsonb_each_text(p_rights) r join core.domain d on d.tenant_id = p_tenant and d.code = r.key
  on conflict (domain_id, group_id) do update set access = excluded.access
    where core.domain_policy.access is distinct from excluded.access;
  return v_g.id;
end $$;

create function core.require_group_builder() returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, core
as $$
declare
  v_tenant uuid := core.my_tenant();
begin
  if v_tenant is null
     or not core.can('COMPANY_SETTINGS', 'modify', core.org_root(v_tenant), null, null) then
    raise exception 'NOT_AUTHORISED' using detail = 'COMPANY_SETTINGS modify at the company';
  end if;
  return v_tenant;
end $$;

-- The Account Owner builds or edits one of their company's groups.
create function core.save_custom_group(p_code text, p_name text, p_rights jsonb,
                                       p_acts_as text[] default '{}') returns uuid
language plpgsql security definer
set search_path = pg_catalog, core
as $$
begin
  return core.put_custom_group(core.require_group_builder(), p_code, p_name, p_rights, p_acts_as);
end $$;

-- Removes a group nobody holds or will hold, and no job role uses; its rights go.
create function core.archive_custom_group(p_code text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_tenant uuid := core.require_group_builder();
  v_g core.security_group;
begin
  select * into v_g from core.security_group
   where tenant_id = v_tenant and code = p_code and kind = 'custom' and archived_at is null;
  if not found then
    raise exception 'INVALID_GROUP' using detail = coalesce(p_code, '');
  end if;
  if exists (select 1 from core.role_assignment ra
              where ra.group_id = v_g.id
                and (ra.effective_to is null or ra.effective_to >= current_date))
     or exists (select 1 from hr.job_role_access j
                 where j.tenant_id = v_tenant and j.access_group = p_code) then
    raise exception 'GROUP_IN_USE' using detail = p_code;
  end if;
  delete from core.domain_policy where group_id = v_g.id;
  update core.security_group set archived_at = now() where id = v_g.id;
end $$;

-- A removed group can't be given to anyone.
create function core.no_archived_group() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
begin
  if exists (select 1 from core.security_group g
              where g.id = new.group_id and g.archived_at is not null) then
    raise exception 'INVALID_GROUP' using detail = 'that group has been removed';
  end if;
  return new;
end $$;
create trigger no_archived_group before insert on core.role_assignment
  for each row execute function core.no_archived_group();

-- Defence in depth: a custom group never holds an admin domain, whoever writes the row.
create function core.custom_not_admin() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
begin
  if exists (select 1 from core.security_group g where g.id = new.group_id and g.kind = 'custom')
     and exists (select 1 from core.domain d where d.id = new.domain_id and d.admin) then
    raise exception 'INVALID_GROUP' using detail = 'a custom group holds no admin rights';
  end if;
  return new;
end $$;
create trigger custom_not_admin before insert or update on core.domain_policy
  for each row execute function core.custom_not_admin();

-- The company's custom groups, for the Admin screen (user admins and the owner).
create function core.custom_groups()
returns table (code text, name text, rights jsonb, acts_as text[], sensitive boolean,
               holders int)
language plpgsql stable security definer
set search_path = pg_catalog, core
as $$
declare
  v_tenant uuid := core.my_tenant();
begin
  if v_tenant is null
     or not (core.can('USER_ACCESS', 'view', core.org_root(v_tenant), null, null)
             or exists (select 1 from core.role_assignment ra
                          join core.security_group g on g.id = ra.group_id
                         where ra.user_id = core.current_user_id() and g.code = 'USER_ADMIN'
                           and ra.effective_from <= current_date
                           and (ra.effective_to is null or ra.effective_to >= current_date))) then
    raise exception 'NOT_AUTHORISED' using detail = 'user administration';
  end if;
  return query
  select g.code, g.name,
         coalesce((select jsonb_object_agg(d.code, dp.access order by d.code)
                     from core.domain_policy dp join core.domain d on d.id = dp.domain_id
                    where dp.group_id = g.id), '{}'),
         g.acts_as, core.is_sensitive_group(g.id),
         (select count(distinct ra.user_id)::int from core.role_assignment ra
           where ra.group_id = g.id and ra.effective_from <= current_date
             and (ra.effective_to is null or ra.effective_to >= current_date))
    from core.security_group g
   where g.tenant_id = v_tenant and g.kind = 'custom' and g.archived_at is null
   order by g.name;
end $$;

-- The product roles whose duties the signed-in person carries through custom groups (the
-- bottom nav's profile, presentation only).
create function core.my_acting_roles() returns setof text
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select distinct unnest(g.acts_as)
    from core.role_assignment ra join core.security_group g on g.id = ra.group_id
   where ra.user_id = core.current_user_id() and g.kind = 'custom' and g.archived_at is null
     and ra.effective_from <= current_date
     and (ra.effective_to is null or ra.effective_to >= current_date);
$$;

-- The groups a user admin may give: custom ones too, never a removed one.
do $$
declare
  v_src text := pg_get_functiondef('core.admin_groups()'::regprocedure);
  v_new text := replace(v_src, 'and g.code <> ''AI_AGENT''',
                        'and g.code <> ''AI_AGENT'' and g.archived_at is null');
begin
  if v_new = v_src then raise exception 'core.admin_groups changed; update this migration'; end if;
  execute v_new;
end $$;

revoke execute on function core.carriable_role(uuid, text), core.acting_groups(uuid),
  core.put_custom_group(uuid, text, text, jsonb, text[]), core.require_group_builder(),
  core.save_custom_group(text, text, jsonb, text[]), core.archive_custom_group(text),
  core.custom_groups(), core.my_acting_roles() from public;
grant execute on function core.save_custom_group(text, text, jsonb, text[]),
  core.archive_custom_group(text), core.custom_groups(), core.my_acting_roles() to app_rw;
grant execute on function core.put_custom_group(uuid, text, text, jsonb, text[]) to platform_loader;

-- migrate:down
do $$
begin
  execute replace(pg_get_functiondef('core.admin_groups()'::regprocedure),
                  ' and g.archived_at is null', '');
end $$;
drop function core.my_acting_roles(), core.custom_groups();
drop trigger custom_not_admin on core.domain_policy;
drop function core.custom_not_admin();
drop trigger no_archived_group on core.role_assignment;
drop function core.no_archived_group();
drop function core.archive_custom_group(text), core.save_custom_group(text, text, jsonb, text[]),
  core.require_group_builder(), core.put_custom_group(uuid, text, text, jsonb, text[]);
create or replace function core.is_sensitive_group(p_group uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select g.code in ('OUTLET_MANAGER', 'USER_ADMIN', 'ACCOUNT_OWNER', 'HR_ADMIN', 'OUTLET_HR')
         or (g.kind <> 'user_based'
             and exists (select 1 from core.domain_policy dp
                      join core.domain d on d.id = dp.domain_id and d.code = 'COMPENSATION'
                     where dp.group_id = g.id))
    from core.security_group g where g.id = p_group;
$$;
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'core.group_holders(uuid, uuid)',
    'core.site_group_holders(uuid, uuid)',
    'core.nearest_group_node(uuid, uuid, uuid[], boolean)',
    'core.site_group_node(uuid, uuid, uuid[], boolean)'] loop
    execute replace(pg_get_functiondef(v_fn::regprocedure),
                    'ra.group_id = any (core.acting_groups(p_group))', 'ra.group_id = p_group');
  end loop;
end $$;
drop function core.acting_groups(uuid), core.carriable_role(uuid, text);
-- local only (forward-only in production): custom groups and their grants go
delete from core.domain_policy dp using core.security_group g
 where g.id = dp.group_id and g.kind = 'custom';
delete from core.role_assignment ra using core.security_group g
 where g.id = ra.group_id and g.kind = 'custom';
delete from hr.role_change rc using core.security_group g
 where g.id = rc.group_id and g.kind = 'custom';
delete from core.security_group where kind = 'custom';
alter table core.security_group drop constraint acts_as_custom_only,
  drop column archived_at, drop column acts_as;
alter table core.security_group drop constraint security_group_kind_check;
alter table core.security_group add constraint security_group_kind_check
  check (kind in ('role', 'user_based', 'admin'));
