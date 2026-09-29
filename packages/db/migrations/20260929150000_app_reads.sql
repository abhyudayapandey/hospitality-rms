-- migrate:up
-- Read functions for the web app (ADR 004). SECURITY DEFINER with a pinned search_path,
-- executable by app_rw only. They answer for the current user (app.user_id) within
-- their tenant; access decisions stay in SQL (CLAUDE.md rule 2).

-- The current active user, or no row.
create function core.me()
returns table (id uuid, tenant_id uuid, kind text, display_name text)
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select u.id, u.tenant_id, u.kind, u.display_name
    from core.app_user u
   where u.id = core.current_user_id() and u.status = 'active';
$$;

-- Every domain in which the user has any grant, with the strongest access:
-- hierarchy assignments, the SELF group, and derived (DERIVED_<domain>) views.
-- The web app uses this to decide which screens to show; RLS and the RPCs still
-- enforce every read and write.
create function core.my_domains()
returns table (domain text, access text)
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  with me as (select * from core.me()),
  grants as (
    select ea.domain, ea.access from core.effective_access ea, me where ea.user_id = me.id
    union all
    select d.code, dp.access
      from me
      join core.security_group g on g.tenant_id = me.tenant_id and g.code = 'SELF'
      join core.domain_policy dp on dp.group_id = g.id
      join core.domain d on d.id = dp.domain_id
    union all
    select substr(ea.domain, 9), 'view'
      from core.effective_access ea, me
     where ea.user_id = me.id and ea.domain like 'DERIVED\_%'
  )
  select g.domain, case when bool_or(g.access = 'modify') then 'modify' else 'view' end
    from grants g
    join core.domain d on d.code = g.domain and d.tenant_id = (select tenant_id from me)
   group by g.domain
   order by g.domain;
$$;

-- Nodes the user works in, for the node switcher: nodes covered by an assignment
-- (respecting include_descendants), plus delivery nodes linked to covered org nodes
-- where the user holds a DERIVED_ domain (flagged derived).
create function core.nodes(p_type text default null)
returns table (id uuid, type text, kind text, name text, parent_id uuid, depth int,
               timezone text, derived boolean)
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  with me as (select * from core.me()),
  covered as (
    select n.id, false as derived
      from me
      join core.effective_access ea on ea.user_id = me.id
      join core.hierarchy_node n
        on n.tenant_id = me.tenant_id and n.type = ea.type and n.archived_at is null
       and (n.path = ea.path or (ea.include_descendants and ea.path @> n.path))
     where ea.domain not like 'DERIVED\_%'
    union
    select d.id, true
      from me
      join core.effective_access ea on ea.user_id = me.id and ea.type = 'org'
                                   and ea.domain like 'DERIVED\_%'
      join core.hierarchy_node o
        on o.tenant_id = me.tenant_id and o.type = 'org'
       and (o.path = ea.path or (ea.include_descendants and ea.path @> o.path))
      join core.node_link nl on nl.org_node_id = o.id
      join core.hierarchy_node d on d.id = nl.delivery_node_id and d.archived_at is null
  )
  select n.id, n.type, n.kind, n.name, n.parent_id, nlevel(n.path), n.timezone, bool_and(c.derived)
    from covered c join core.hierarchy_node n on n.id = c.id
   where p_type is null or n.type = p_type
   group by n.id, n.type, n.kind, n.name, n.parent_id, n.path, n.timezone
   order by n.type desc, n.path;
$$;

-- Maps a verified Cognito identity to its active app user (called after the ID token
-- is verified; no app.user_id is set yet).
create function core.user_for_cognito_sub(p_sub text) returns uuid
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select id from core.app_user where cognito_sub = p_sub and status = 'active';
$$;

-- Processes the user may initiate (bp_policy 'initiate'; SELF counts for humans only).
create function wf.my_processes()
returns table (process_type text, subject_type text, domain_code text, hierarchy_type text)
language sql stable security definer
set search_path = pg_catalog, core, wf
as $$
  with me as (select * from core.me())
  select d.process_type, d.subject_type, d.domain_code, d.hierarchy_type
    from wf.process_def d, me
   where d.tenant_id = me.tenant_id
     and exists (
       select 1 from core.bp_policy bp
         join core.security_group g on g.id = bp.group_id and g.tenant_id = me.tenant_id
        where bp.process_type = d.process_type and bp.step = '*' and bp.action = 'initiate'
          and ((g.code = 'SELF' and me.kind = 'human')
               or exists (select 1 from core.role_assignment ra
                           where ra.user_id = me.id and ra.group_id = g.id
                             and current_date >= ra.effective_from
                             and (ra.effective_to is null or current_date <= ra.effective_to))))
   order by d.process_type;
$$;

-- Read-only admin lists (edits come through ROLE_CHANGE later). Require SECURITY_ROLES
-- view at the tenant's org root.
create function core.admin_role_assignments()
returns table (user_name text, user_kind text, group_code text, node_type text,
               node_name text, include_descendants boolean, effective_from date,
               effective_to date)
language plpgsql stable security definer
set search_path = pg_catalog, core
as $$
begin
  if not core.can('SECURITY_ROLES', 'view', core.org_root(), null) then
    raise exception 'NOT_AUTHORISED' using detail = 'SECURITY_ROLES view required';
  end if;
  return query
    select u.display_name, u.kind, g.code, n.type, n.name, ra.include_descendants,
           ra.effective_from, ra.effective_to
      from core.role_assignment ra
      join core.app_user u on u.id = ra.user_id
      join core.security_group g on g.id = ra.group_id
      join core.hierarchy_node n on n.id = ra.node_id
     where ra.tenant_id = (select tenant_id from core.me())
     order by u.display_name, g.code, n.type, n.name;
end $$;

create function core.admin_domain_policies()
returns table (domain_code text, hierarchy_type text, group_code text, access text)
language plpgsql stable security definer
set search_path = pg_catalog, core
as $$
begin
  if not core.can('SECURITY_ROLES', 'view', core.org_root(), null) then
    raise exception 'NOT_AUTHORISED' using detail = 'SECURITY_ROLES view required';
  end if;
  return query
    select d.code, d.hierarchy_type, g.code, dp.access
      from core.domain_policy dp
      join core.domain d on d.id = dp.domain_id
      join core.security_group g on g.id = dp.group_id
     where dp.tenant_id = (select tenant_id from core.me())
     order by d.code, g.code;
end $$;

revoke execute on function core.me(), core.my_domains(), core.nodes(text),
  core.user_for_cognito_sub(text), wf.my_processes(), core.admin_role_assignments(),
  core.admin_domain_policies() from public;
grant execute on function core.me(), core.my_domains(), core.nodes(text),
  core.user_for_cognito_sub(text), wf.my_processes(), core.admin_role_assignments(),
  core.admin_domain_policies() to app_rw;

-- migrate:down
drop function core.admin_domain_policies();
drop function core.admin_role_assignments();
drop function wf.my_processes();
drop function core.user_for_cognito_sub(text);
drop function core.nodes(text);
drop function core.my_domains();
drop function core.me();
