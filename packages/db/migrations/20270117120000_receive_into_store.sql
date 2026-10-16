-- migrate:up
-- A receive task's button names the store the stock goes into, "Transfer to Bar Store done",
-- not the department, "Bar" (ADR 163). For whoever holds or follows the task only.

create function ops.receive_into(p_task uuid) returns text
language sql stable security definer
set search_path = pg_catalog, core, ops, inv
as $$
  select regexp_replace(n.name, '^.*\s[–-]\s', '')
    from ops.task t
    join inv.transfer tr on tr.id = t.transfer_id
    join core.hierarchy_node n on n.id = tr.to_node_id
   where t.id = p_task and t.tenant_id = core.my_tenant() and t.kind = 'receive'
     and (t.assignee_user_id = core.current_user_id() or ops.sees_task(t));
$$;

revoke execute on function ops.receive_into(uuid) from public;
grant execute on function ops.receive_into(uuid) to app_rw;

-- migrate:down
drop function if exists ops.receive_into(uuid);
