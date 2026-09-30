-- migrate:up
-- Derived stock follows the link down (ADR 009). A DERIVED_<domain> grant on an org node
-- gave view on the delivery node linked to it; with stores under supply points it must
-- also reach the stores. A delivery node belongs to its link anchor: the nearest node at
-- or above it that has a node_link. So a hotel's supply point link covers its stores,
-- except a store linked to a department of its own (the Kitchen Store belongs to the
-- Kitchen, not to whoever can see the Bar), and a hub's link does not pull in the outlets
-- under it (a central kitchen grant does not see the outlets it supplies).

create function core.link_anchor(p_delivery uuid) returns uuid
language sql stable
set search_path = pg_catalog, core, extensions
as $$
  select a.id
    from core.hierarchy_node n
    join core.hierarchy_node a
      on a.tenant_id = n.tenant_id and a.type = 'delivery' and a.path @> n.path
   where n.id = p_delivery
     and exists (select 1 from core.node_link nl where nl.delivery_node_id = a.id)
   order by nlevel(a.path) desc
   limit 1;
$$;
revoke execute on function core.link_anchor(uuid) from public;

do $$
declare
  v_src text := pg_get_functiondef('core.can(text, text, uuid, uuid, uuid)'::regprocedure);
  v_old text := 'where nl.delivery_node_id = p_delivery';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'core.can changed; update this migration';
  end if;
  execute replace(v_src, v_old, 'where nl.delivery_node_id = core.link_anchor(p_delivery)');
end $$;

-- USER_ACCESS on the delivery tree follows the same rule: a place belongs to its anchor.
create or replace function core.in_user_access_scope(p_node uuid, p_access text default 'view')
returns boolean
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  select case n.type
    when 'org' then core.can('USER_ACCESS', p_access, n.id, null)
    else exists (
      select 1 from core.node_link nl
       where nl.delivery_node_id = core.link_anchor(n.id)
         and core.can('USER_ACCESS', p_access, nl.org_node_id, null))
  end
    from core.hierarchy_node n
   where n.id = p_node and n.tenant_id = core.my_tenant();
$$;

drop function core.nodes(text);
create function core.nodes(p_type text default null)
returns table (id uuid, type text, kind text, name text, parent_id uuid, depth int,
               timezone text, derived boolean, holds_stock boolean)
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  with me as (select * from core.me()),
  anchors as (
    -- delivery nodes linked to an org node the user holds a DERIVED_ grant over
    select distinct nl.delivery_node_id as id
      from me
      join core.effective_access ea on ea.user_id = me.id and ea.type = 'org'
                                   and ea.domain like 'DERIVED\_%'
      join core.hierarchy_node o
        on o.tenant_id = me.tenant_id and o.type = 'org'
       and (o.path = ea.path or (ea.include_descendants and ea.path @> o.path))
      join core.node_link nl on nl.org_node_id = o.id
  ),
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
      from anchors an
      join core.hierarchy_node a on a.id = an.id
      join core.hierarchy_node d
        on d.tenant_id = a.tenant_id and d.type = 'delivery' and a.path @> d.path
       and d.archived_at is null
     where core.link_anchor(d.id) = a.id
  )
  select n.id, n.type, n.kind, n.name, n.parent_id, nlevel(n.path), n.timezone, bool_and(c.derived),
         n.holds_stock
    from covered c join core.hierarchy_node n on n.id = c.id
   where p_type is null or n.type = p_type
   group by n.id, n.type, n.kind, n.name, n.parent_id, n.path, n.timezone, n.holds_stock
   order by n.type desc, n.path;
$$;
revoke execute on function core.nodes(text) from public;
grant execute on function core.nodes(text) to app_rw;

-- migrate:down
drop function core.nodes(text);
create function core.nodes(p_type text default null)
returns table (id uuid, type text, kind text, name text, parent_id uuid, depth int,
               timezone text, derived boolean, holds_stock boolean)
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
  select n.id, n.type, n.kind, n.name, n.parent_id, nlevel(n.path), n.timezone, bool_and(c.derived),
         n.holds_stock
    from covered c join core.hierarchy_node n on n.id = c.id
   where p_type is null or n.type = p_type
   group by n.id, n.type, n.kind, n.name, n.parent_id, n.path, n.timezone, n.holds_stock
   order by n.type desc, n.path;
$$;
revoke execute on function core.nodes(text) from public;
grant execute on function core.nodes(text) to app_rw;
create or replace function core.in_user_access_scope(p_node uuid, p_access text default 'view')
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
do $$
begin
  execute replace(pg_get_functiondef('core.can(text, text, uuid, uuid, uuid)'::regprocedure),
    'where nl.delivery_node_id = core.link_anchor(p_delivery)',
    'where nl.delivery_node_id = p_delivery');
end $$;
drop function core.link_anchor(uuid);
