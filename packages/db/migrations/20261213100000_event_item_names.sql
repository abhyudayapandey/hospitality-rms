-- migrate:up
-- An event's supplies by name for everyone who works it (ADR 098): the event page joined
-- inv.item under the viewer's access, so a banquet server, who holds no stock access, saw
-- "Item · 4". The names come from the event: whoever may see the event sees what it needs.

create function ops.event_item_names(p_event uuid)
returns table (item_id uuid, name text, base_uom text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, inv
as $$
#variable_conflict use_column
declare
  v_node uuid;
begin
  select e.org_node_id into v_node from ops.event e
   where e.id = p_event and e.tenant_id = core.my_tenant();
  -- the events' own rule (ADR 016): an event at an outlet is seen from its departments too
  if v_node is null or not ops.can_read_event_node(v_node) then
    perform ops.fail('NOT_AUTHORISED', 'EVENTS view');
  end if;
  return query
    select distinct i.id, i.name, i.base_uom
      from ops.event_requirement q
      join inv.item i on i.id = q.item_id and i.tenant_id = q.tenant_id
     where q.event_id = p_event and q.kind = 'item' and q.archived_at is null;
end $$;

revoke execute on function ops.event_item_names(uuid) from public, platform_loader;
grant execute on function ops.event_item_names(uuid) to app_rw;

-- migrate:down
drop function ops.event_item_names(uuid);
