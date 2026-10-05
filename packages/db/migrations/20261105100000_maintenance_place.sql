-- migrate:up

-- The Maintenance screen groups repairs by the department they were reported in (ADR 048):
-- the function now also returns that place, where the problem is (place_node_id), beside the
-- node that handles it (org_node_id, the outlet's Engineering).
drop function ops.maintenance_requests(uuid);

create function ops.maintenance_requests(p_id uuid default null)
returns table (id uuid, title text, description text, status text, org_node_id uuid,
               handled_by text, place_name text, reported_by_name text, assigned_to uuid,
               assigned_to_name text, photo_key text, done_photo_key text, done_note text,
               created_at timestamptz, done_at timestamptz, place_node_id uuid)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select r.id, r.title, r.description, r.status, r.org_node_id, h.name, p.name,
         rb.display_name, r.assigned_to, at.display_name, r.photo_key, r.done_photo_key,
         r.done_note, r.created_at, r.done_at, r.place_node_id
    from ops.maintenance_request r
    join core.hierarchy_node h on h.id = r.org_node_id
    join core.hierarchy_node p on p.id = r.place_node_id
    left join core.app_user rb on rb.id = r.reported_by
    left join core.app_user at on at.id = r.assigned_to
   where r.tenant_id = core.my_tenant()
     and (p_id is null or r.id = p_id)
     and (r.reported_by = core.current_user_id() or r.assigned_to = core.current_user_id()
          or core.can('MAINTENANCE', 'view', r.org_node_id, null))
   order by r.status = 'done', r.created_at desc
   limit 100;
$$;

revoke execute on function ops.maintenance_requests(uuid) from public;
grant execute on function ops.maintenance_requests(uuid) to app_rw;

-- migrate:down

drop function ops.maintenance_requests(uuid);

create function ops.maintenance_requests(p_id uuid default null)
returns table (id uuid, title text, description text, status text, org_node_id uuid,
               handled_by text, place_name text, reported_by_name text, assigned_to uuid,
               assigned_to_name text, photo_key text, done_photo_key text, done_note text,
               created_at timestamptz, done_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select r.id, r.title, r.description, r.status, r.org_node_id, h.name, p.name,
         rb.display_name, r.assigned_to, at.display_name, r.photo_key, r.done_photo_key,
         r.done_note, r.created_at, r.done_at
    from ops.maintenance_request r
    join core.hierarchy_node h on h.id = r.org_node_id
    join core.hierarchy_node p on p.id = r.place_node_id
    left join core.app_user rb on rb.id = r.reported_by
    left join core.app_user at on at.id = r.assigned_to
   where r.tenant_id = core.my_tenant()
     and (p_id is null or r.id = p_id)
     and (r.reported_by = core.current_user_id() or r.assigned_to = core.current_user_id()
          or core.can('MAINTENANCE', 'view', r.org_node_id, null))
   order by r.status = 'done', r.created_at desc
   limit 100;
$$;

revoke execute on function ops.maintenance_requests(uuid) from public;
grant execute on function ops.maintenance_requests(uuid) to app_rw;
