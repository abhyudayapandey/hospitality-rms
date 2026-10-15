-- migrate:up

-- Push today goes to everyone in food and drink (ADR 150): the people of a kitchen or service
-- department (restaurant, bar, in-room dining, banquets), and at the outlet its managers (and a
-- restaurant's or bar's shift leads). It was the service departments and every outlet-level
-- person: a bar's security guard got it, the kitchen did not.
create or replace function menu.my_push_today()
returns table(outlet_id uuid, outlet text, menu_item_id uuid, dish text, menu text, item text,
              expires_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, menu
as $$
declare
  v_home core.hierarchy_node;
  v_outlet core.hierarchy_node;
begin
  select n.* into v_home from hr.worker w join core.hierarchy_node n on n.id = w.org_node_id
   where w.owner_user_id = core.current_user_id() and w.status = 'active'
   order by w.id limit 1;
  if v_home.id is null then
    return;
  end if;
  select * into v_outlet from core.hierarchy_node
   where id = core.nearest(v_home.id, array['outlet']);
  if v_outlet.id is null then
    return;
  end if;
  if not ((v_home.kind = 'department' and v_home.department_type in ('kitchen', 'service'))
          or (v_home.kind = 'outlet'
              and exists (select 1 from core.role_assignment ra
                            join core.security_group g on g.id = ra.group_id
                           where ra.user_id = core.current_user_id()
                             and ra.tenant_id = v_home.tenant_id
                             and ra.effective_from <= current_date
                             and (ra.effective_to is null or ra.effective_to >= current_date)
                             and (g.code = 'OUTLET_MANAGER'
                                  or g.acts_as && array['OUTLET_MANAGER']
                                  -- a restaurant's or a bar's shift lead (an assistant manager)
                                  or (v_outlet.outlet_format is distinct from 'hotel'
                                      and (g.code = 'SUPERVISOR'
                                           or g.acts_as && array['SUPERVISOR'])))))) then
    return;
  end if;
  return query select v_outlet.id, v_outlet.name, p.* from menu.push_today(v_outlet.id) p;
end $$;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous rule for local work.
create or replace function menu.my_push_today()
returns table(outlet_id uuid, outlet text, menu_item_id uuid, dish text, menu text, item text,
              expires_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, menu
as $$
declare
  v_home core.hierarchy_node;
  v_outlet core.hierarchy_node;
begin
  select n.* into v_home from hr.worker w join core.hierarchy_node n on n.id = w.org_node_id
   where w.owner_user_id = core.current_user_id() and w.status = 'active'
   order by w.id limit 1;
  if v_home.id is null
     or not (v_home.kind = 'outlet'
             or (v_home.kind = 'department' and v_home.department_type = 'service')) then
    return;
  end if;
  select * into v_outlet from core.hierarchy_node
   where id = core.nearest(v_home.id, array['outlet']);
  if v_outlet.id is null then
    return;
  end if;
  return query select v_outlet.id, v_outlet.name, p.* from menu.push_today(v_outlet.id) p;
end $$;
