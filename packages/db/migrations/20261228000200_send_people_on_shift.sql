-- migrate:up
-- "Who brings it?" (ADR 142): whoever is on shift today first, as every person picker does
-- (ADR 110), and never the person giving it, who can send it themselves.
drop function inv.send_people(uuid);
create function inv.send_people(p_transfer uuid)
returns table (id uuid, name text, on_shift boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, hr, wf
as $$
declare
  v_t inv.transfer := inv.require_sender(p_transfer);
  v_team uuid := ops.team_of_store(v_t.from_node_id);
begin
  return query
    select p.id, p.name, ops.is_on_shift(p.id, v_t.from_node_id)
      from (select distinct u.id, u.display_name as name
              from hr.worker w
              join core.app_user u on u.id = w.owner_user_id
              join core.hierarchy_node h on h.id = w.org_node_id
              join core.hierarchy_node team on team.id = coalesce(v_team, v_t.from_node_id)
             where w.status = 'active' and w.tenant_id = v_t.tenant_id
               and u.id <> core.current_user_id()
               and h.path operator(extensions.<@) team.path) p
     order by 3 desc, p.name, p.id;
end $$;
revoke execute on function inv.send_people(uuid) from public;
grant execute on function inv.send_people(uuid) to app_rw;

-- migrate:down
drop function inv.send_people(uuid);
create function inv.send_people(p_transfer uuid)
returns table (id uuid, name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, hr, wf
as $$
declare
  v_t inv.transfer := inv.require_sender(p_transfer);
  v_team uuid := ops.team_of_store(v_t.from_node_id);
begin
  return query
    select distinct on (u.display_name, u.id) u.id, u.display_name
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node team on team.id = coalesce(v_team, v_t.from_node_id)
     where w.status = 'active' and w.tenant_id = v_t.tenant_id
       and h.path operator(extensions.<@) team.path
     order by u.display_name, u.id;
end $$;
revoke execute on function inv.send_people(uuid) from public;
grant execute on function inv.send_people(uuid) to app_rw;
