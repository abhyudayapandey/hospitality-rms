-- migrate:up
-- "A newer version" of a library checklist (ADR 068). A copy remembers the library checklist
-- and version it came from (ADR 062); the checklist screen compares it with the product's
-- library and, when the library is newer, offers its steps. Using them replaces the copy's
-- steps only: its name, schedule and who it goes to stay the outlet's. Who may edit the
-- checklist may do this; nothing else changes a copy.

drop function ops.checklists(uuid);
create function ops.checklists(p_node uuid)
returns table (id uuid, org_node_id uuid, place_name text, name text, schedule jsonb,
               assign jsonb, steps jsonb, archived_at timestamptz, library_code text,
               library_version int)
language sql stable security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  select t.id, t.org_node_id, n.name, t.name, t.schedule, t.assign, t.steps, t.archived_at,
         t.library_code, t.library_version
    from ops.checklist_template t
    join core.hierarchy_node n on n.id = t.org_node_id
    join core.hierarchy_node p on p.id = p_node and p.tenant_id = t.tenant_id
   where t.tenant_id = core.my_tenant()
     and n.path operator(extensions.<@) p.path
     and core.can('CHECKLIST_TEMPLATES', 'view', t.org_node_id, null)
   order by t.archived_at is not null, n.name, t.name;
$$;
revoke execute on function ops.checklists(uuid) from public;
grant execute on function ops.checklists(uuid) to app_rw;

-- Uses a newer library version's steps on a copy. p_steps are the product library's own (the
-- server reads them from code); the copy must come from that library checklist, and the
-- version must be newer than the one it has.
create function ops.use_library_version(p_id uuid, p_code text, p_version int, p_steps jsonb)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_me core.app_user := wf.me();
  v_t ops.checklist_template;
begin
  select * into v_t from ops.checklist_template
   where id = p_id and tenant_id = v_me.tenant_id for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such checklist');
  end if;
  perform hr.require('CHECKLIST_TEMPLATES', 'modify', v_t.org_node_id);
  if v_t.library_code is distinct from p_code or p_version is null
     or p_version <= v_t.library_version then
    perform ops.fail('INVALID_STATE', 'not a newer version of this checklist');
  end if;
  perform ops.check_steps(p_steps);
  if jsonb_array_length(p_steps) = 0 then
    perform ops.fail('INVALID_STEPS', 'a checklist needs a step');
  end if;
  update ops.checklist_template
     set steps = p_steps, library_version = p_version
   where id = p_id;
end $$;
revoke execute on function ops.use_library_version(uuid, text, int, jsonb) from public;
grant execute on function ops.use_library_version(uuid, text, int, jsonb) to app_rw;

-- migrate:down
drop function ops.use_library_version(uuid, text, int, jsonb);
drop function ops.checklists(uuid);
create function ops.checklists(p_node uuid)
returns table (id uuid, org_node_id uuid, place_name text, name text, schedule jsonb,
               assign jsonb, steps jsonb, archived_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  select t.id, t.org_node_id, n.name, t.name, t.schedule, t.assign, t.steps, t.archived_at
    from ops.checklist_template t
    join core.hierarchy_node n on n.id = t.org_node_id
    join core.hierarchy_node p on p.id = p_node and p.tenant_id = t.tenant_id
   where t.tenant_id = core.my_tenant()
     and n.path operator(extensions.<@) p.path
     and core.can('CHECKLIST_TEMPLATES', 'view', t.org_node_id, null)
   order by t.archived_at is not null, n.name, t.name;
$$;
revoke execute on function ops.checklists(uuid) from public;
grant execute on function ops.checklists(uuid) to app_rw;
