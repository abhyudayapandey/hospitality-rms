-- migrate:up

-- Nowhere to ask (ADR 149). A floor team with no store of its own (the Solo Bar's servers) had
-- RFMs open on "Your team has no store to ask": they couldn't ask the bar for limes or straws.
-- Now someone in a department with no store asks the stores of their outlet; the ask goes to
-- that store's head as any other ask (inv.ask_heads). People who sit at the outlet or above (the
-- GM, the account owner) are unchanged: they request from a store on Stock.
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

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
create or replace function inv.my_ask_stores() returns table (id uuid, name text)
language sql stable security definer
set search_path = pg_catalog, core, inv, ops, hr
as $$
  select distinct s.id, inv.short_name(s.id)
    from core.hierarchy_node s
    join hr.worker w on w.owner_user_id = core.current_user_id() and w.status = 'active'
                    and w.tenant_id = s.tenant_id
    join core.hierarchy_node h on h.id = w.org_node_id
    join core.hierarchy_node team on team.id = ops.team_of_store(s.id)
   where s.tenant_id = core.my_tenant() and s.type = 'delivery' and s.archived_at is null
     and s.holds_stock and h.path operator(extensions.<@) team.path
   order by 2;
$$;
