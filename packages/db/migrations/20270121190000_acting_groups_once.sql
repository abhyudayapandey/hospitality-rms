-- migrate:up
-- Who approves where and who holds a group, worked out faster. Every customer load checks
-- who approves at every place, and the outlet template test loads Test Company 15 times.
--
-- core.nearest_group_node, core.site_group_node, core.group_holders and
-- core.site_group_holders asked core.acting_groups(p_group) (the group and the customer's own
-- groups that act as it, ADR 027) once for every role assignment they looked at: about 20,000
-- calls for one check of who approves at every place (wf.approval_coverage,
-- wf.people_without_approver), which every customer load runs. The answer is the same for the
-- whole call, so each now asks once. Nothing else changes.

select core.patch_function('core.nearest_group_node(uuid,uuid,uuid[],boolean)',
$x$  v_org uuid;
begin$x$,
$x$  v_org uuid;
  v_groups uuid[] := core.acting_groups(p_group);
begin$x$);
select core.patch_function('core.nearest_group_node(uuid,uuid,uuid[],boolean)',
$x$ra.group_id = any (core.acting_groups(p_group))$x$, $x$ra.group_id = any (v_groups)$x$);

select core.patch_function('core.site_group_node(uuid,uuid,uuid[],boolean)',
$x$  v_org uuid;
begin$x$,
$x$  v_org uuid;
  v_groups uuid[] := core.acting_groups(p_group);
begin$x$);
select core.patch_function('core.site_group_node(uuid,uuid,uuid[],boolean)',
$x$ra.group_id = any (core.acting_groups(p_group))$x$, $x$ra.group_id = any (v_groups)$x$);

-- The walk up the tree (core.nearest, core.self_and_ancestors) and the holders of a group at a
-- place (core.group_holders, core.site_group_holders) were SQL functions with a fixed
-- search_path, which Postgres plans again on every call; deriving access asks them thousands
-- of times a load. As plpgsql their plans are kept. The same queries, the same answers.
create or replace function core.self_and_ancestors(p_node uuid)
returns table (id uuid, depth integer)
language plpgsql stable
set search_path = pg_catalog, core, extensions
as $$
begin
  return query
    select a.id, nlevel(a.path)
      from core.hierarchy_node n
      join core.hierarchy_node a on a.path @> n.path and a.type = n.type and a.tenant_id = n.tenant_id
     where n.id = p_node
     order by nlevel(a.path) desc;
end $$;

create or replace function core.nearest(p_node uuid, p_kinds text[]) returns uuid
language plpgsql stable
set search_path = pg_catalog, core, extensions
as $$
begin
  return (select a.id
            from core.hierarchy_node n
            join core.hierarchy_node a on a.path @> n.path and a.type = n.type
                                      and a.tenant_id = n.tenant_id
           where n.id = p_node and a.kind = any (p_kinds)
           order by nlevel(a.path) desc limit 1);
end $$;

create or replace function core.group_holders(p_group uuid, p_node uuid) returns setof uuid
language plpgsql stable security definer
set search_path = pg_catalog, core, extensions
as $$
declare
  v_groups uuid[] := core.acting_groups(p_group);
begin
  return query
    select distinct ra.user_id
      from core.hierarchy_node t
      join core.role_assignment ra on ra.group_id = any (v_groups)
      join core.app_user u on u.id = ra.user_id and u.status = 'active'
      join core.hierarchy_node n on n.id = ra.node_id and n.type = t.type and n.archived_at is null
     where t.id = p_node
       and current_date >= ra.effective_from
       and (ra.effective_to is null or current_date <= ra.effective_to)
       and (n.id = t.id or (ra.include_descendants and n.path @> t.path));
end $$;

create or replace function core.site_group_holders(p_group uuid, p_node uuid) returns setof uuid
language plpgsql stable security definer
set search_path = pg_catalog, core, extensions
as $$
declare
  v_groups uuid[] := core.acting_groups(p_group);
begin
  return query
    select distinct ra.user_id
      from core.hierarchy_node t
      left join core.hierarchy_node s on s.id = core.stock_site(t.id)
      join core.role_assignment ra on ra.group_id = any (v_groups)
      join core.app_user u on u.id = ra.user_id and u.status = 'active'
      join core.hierarchy_node n on n.id = ra.node_id and n.type = t.type and n.archived_at is null
     where t.id = p_node
       and current_date >= ra.effective_from
       and (ra.effective_to is null or current_date <= ra.effective_to)
       and (n.id = t.id or (ra.include_descendants and n.path @> t.path))
       and (t.type = 'org' or s.id is null or s.path @> n.path);
end $$;

-- Who holds a group at a place is looked up by group and place: an index for it, so the look-up
-- does not read every customer's role assignments.
create index role_assignment_group_node on core.role_assignment (group_id, node_id);

-- migrate:down
drop index core.role_assignment_group_node;
create or replace function core.nearest(p_node uuid, p_kinds text[])
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'core'
AS $function$
  select n.id from core.self_and_ancestors(p_node) a
    join core.hierarchy_node n on n.id = a.id
   where n.kind = any (p_kinds)
   order by a.depth desc limit 1;
$function$
;
create or replace function core.self_and_ancestors(p_node uuid)
 RETURNS TABLE(id uuid, depth integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'core', 'extensions'
AS $function$
  select a.id, nlevel(a.path)
    from core.hierarchy_node n
    join core.hierarchy_node a on a.path @> n.path and a.type = n.type and a.tenant_id = n.tenant_id
   where n.id = p_node
   order by nlevel(a.path) desc;
$function$
;

create or replace function core.group_holders(p_group uuid, p_node uuid) returns setof uuid
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  select distinct ra.user_id
    from core.hierarchy_node t
    join core.role_assignment ra on ra.group_id = any (core.acting_groups(p_group))
    join core.app_user u on u.id = ra.user_id and u.status = 'active'
    join core.hierarchy_node n on n.id = ra.node_id and n.type = t.type and n.archived_at is null
   where t.id = p_node
     and current_date >= ra.effective_from
     and (ra.effective_to is null or current_date <= ra.effective_to)
     and (n.id = t.id or (ra.include_descendants and n.path @> t.path));
$$;
create or replace function core.site_group_holders(p_group uuid, p_node uuid) returns setof uuid
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  select distinct ra.user_id
    from core.hierarchy_node t
    left join core.hierarchy_node s on s.id = core.stock_site(t.id)
    join core.role_assignment ra on ra.group_id = any (core.acting_groups(p_group))
    join core.app_user u on u.id = ra.user_id and u.status = 'active'
    join core.hierarchy_node n on n.id = ra.node_id and n.type = t.type and n.archived_at is null
   where t.id = p_node
     and current_date >= ra.effective_from
     and (ra.effective_to is null or current_date <= ra.effective_to)
     and (n.id = t.id or (ra.include_descendants and n.path @> t.path))
     and (t.type = 'org' or s.id is null or s.path @> n.path);
$$;
select core.patch_function('core.site_group_node(uuid,uuid,uuid[],boolean)',
$x$ra.group_id = any (v_groups)$x$, $x$ra.group_id = any (core.acting_groups(p_group))$x$);
select core.patch_function('core.site_group_node(uuid,uuid,uuid[],boolean)',
$x$
  v_groups uuid[] := core.acting_groups(p_group);$x$, '');
select core.patch_function('core.nearest_group_node(uuid,uuid,uuid[],boolean)',
$x$ra.group_id = any (v_groups)$x$, $x$ra.group_id = any (core.acting_groups(p_group))$x$);
select core.patch_function('core.nearest_group_node(uuid,uuid,uuid[],boolean)',
$x$
  v_groups uuid[] := core.acting_groups(p_group);$x$, '');
