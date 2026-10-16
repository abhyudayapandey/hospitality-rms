-- migrate:up

-- A head never asks their own head (ADR 162): asking the store your team uses goes through the
-- head of your department (inv.ask_heads), so for the head themselves it went up to the GM as a
-- task, never to the store that keeps the item. Whoever leads their own department (DEPARTMENT_HEAD
-- or OUTLET_MANAGER where they work) and may request for a store has no store to ask that way;
-- RFMs' Request opens Request from a store for them (inv.ask_for_stock, routed by the outlet's
-- shape, ADR 115). A head who may not request for any store still asks their own head.
create or replace function inv.my_ask_stores() returns table (id uuid, name text)
language sql stable security definer
set search_path = pg_catalog, core, inv, ops, hr
as $$
  with mine as (
    select h.* from hr.worker w
      join core.hierarchy_node h on h.id = w.org_node_id
     where w.owner_user_id = core.current_user_id() and w.status = 'active'
       and w.tenant_id = core.my_tenant()
       and not (
         exists (
           select 1 from core.security_group g
            where g.tenant_id = w.tenant_id and g.code in ('DEPARTMENT_HEAD', 'OUTLET_MANAGER')
              and core.current_user_id() in (select core.group_holders(g.id, h.id)))
         and exists (
           select 1 from core.screen_places('transfers') p
            where p.type = 'delivery' and core.can('TRANSFERS', 'modify', null, p.id)))
  ), stores as (
    select s.id, team.path as team_path
      from core.hierarchy_node s
      join core.hierarchy_node team on team.id = ops.team_of_store(s.id)
     where s.tenant_id = core.my_tenant() and s.type = 'delivery' and s.archived_at is null
       and s.holds_stock
  ), own as (
    select distinct s.id from stores s, mine h where h.path operator(extensions.<@) s.team_path
  )
  select o.id, inv.short_name(o.id) from own o
  union
  select s.id, inv.short_name(s.id)
    from stores s, mine h
    join core.hierarchy_node outlet
      on outlet.id = core.nearest(h.id, array['outlet', 'site'])
   where h.kind = 'department' and not exists (select 1 from own)
     and s.team_path operator(extensions.<@) outlet.path
   order by 2;
$$;

-- migrate:down

create or replace function inv.my_ask_stores() returns table (id uuid, name text)
language sql stable security definer
set search_path = pg_catalog, core, inv, ops, hr
as $$
  with mine as (
    select h.* from hr.worker w
      join core.hierarchy_node h on h.id = w.org_node_id
     where w.owner_user_id = core.current_user_id() and w.status = 'active'
       and w.tenant_id = core.my_tenant()
  ), stores as (
    select s.id, team.path as team_path
      from core.hierarchy_node s
      join core.hierarchy_node team on team.id = ops.team_of_store(s.id)
     where s.tenant_id = core.my_tenant() and s.type = 'delivery' and s.archived_at is null
       and s.holds_stock
  ), own as (
    select distinct s.id from stores s, mine h where h.path operator(extensions.<@) s.team_path
  )
  select o.id, inv.short_name(o.id) from own o
  union
  select s.id, inv.short_name(s.id)
    from stores s, mine h
    join core.hierarchy_node outlet
      on outlet.id = core.nearest(h.id, array['outlet', 'site'])
   where h.kind = 'department' and not exists (select 1 from own)
     and s.team_path operator(extensions.<@) outlet.path
   order by 2;
$$;
