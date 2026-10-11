-- migrate:up
-- Where a problem is (ADR 125): a location a person can point at (a room, the parking, the
-- terrace, the kitchen), not the department they work in. The request still goes to whoever
-- handles maintenance there (ops.maintenance_node). The list is packages/domain's
-- MAINTENANCE_WHERE; a test keeps the two in step.

create function ops.maintenance_where_codes() returns text[]
language sql immutable
as $$
  select array['room', 'common_areas', 'restaurant', 'bar', 'kitchen', 'banquet_hall', 'pool',
               'terrace', 'garden', 'parking', 'store', 'laundry', 'staff_area', 'outside'];
$$;

alter table ops.maintenance_request
  add column location text check (location is null or location = any (ops.maintenance_where_codes()));

-- the locations offered at the outlet of a place: a department's only where the outlet has it,
-- a room where it has rooms, the pool at a hotel
create function ops.maintenance_wheres(p_place uuid) returns setof text
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  with o as (
    select n.id, n.code, n.outlet_format, n.tenant_id
      from core.hierarchy_node n
     where n.id = core.nearest(p_place, array['outlet']) and n.tenant_id = core.my_tenant()
  ),
  dept(code, department) as (
    values ('restaurant', 'RESTAURANT'), ('bar', 'BAR'), ('kitchen', 'KITCHEN'),
           ('banquet_hall', 'BANQUETS'), ('laundry', 'HOUSEKEEPING')
  )
  select w.code
    from o cross join unnest(ops.maintenance_where_codes()) with ordinality w(code, ord)
   where case
           when w.code = 'room' then exists (select 1 from ops.room r
                                              where r.org_node_id = o.id and r.archived_at is null)
           when w.code = 'pool' then o.outlet_format = 'hotel'
           when w.code in (select d.code from dept d) then exists (
             select 1 from core.hierarchy_node d join dept x on x.code = w.code
              where d.parent_id = o.id and d.kind = 'department' and d.archived_at is null
                and d.code = o.code || '-' || x.department)
           else true
         end
   order by w.ord;
$$;

-- raise a request with where it is
create function ops.raise_maintenance(p_place uuid, p_title text, p_description text,
                                      p_photo_key text, p_idempotency_key text, p_location text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_id uuid;
begin
  if p_location is not null
     and p_location not in (select w from ops.maintenance_wheres(p_place) w) then
    perform ops.fail('INVALID_VALUE', 'not a place at this outlet');
  end if;
  v_id := ops.raise_maintenance(p_place, p_title, p_description, p_photo_key, p_idempotency_key);
  update ops.maintenance_request set location = p_location
   where id = v_id and location is null and p_location is not null;
  return v_id;
end $$;

drop function ops.maintenance_requests(uuid);
create function ops.maintenance_requests(p_id uuid default null)
returns table (id uuid, title text, description text, status text, org_node_id uuid,
               handled_by text, place_name text, reported_by_name text, assigned_to uuid,
               assigned_to_name text, photo_key text, done_photo_key text, done_note text,
               created_at timestamptz, done_at timestamptz, place_node_id uuid,
               assigned_at timestamptz, assigned_by_name text, location text)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select r.id, r.title, r.description, r.status, r.org_node_id, h.name, p.name,
         rb.display_name, r.assigned_to, at.display_name, r.photo_key, r.done_photo_key,
         r.done_note, r.created_at, r.done_at, r.place_node_id, r.assigned_at, ab.display_name,
         r.location
    from ops.maintenance_request r
    join core.hierarchy_node h on h.id = r.org_node_id
    join core.hierarchy_node p on p.id = r.place_node_id
    left join core.app_user rb on rb.id = r.reported_by
    left join core.app_user at on at.id = r.assigned_to
    left join core.app_user ab on ab.id = r.assigned_by
   where r.tenant_id = core.my_tenant()
     and (p_id is null or r.id = p_id)
     and (r.reported_by = core.current_user_id() or r.assigned_to = core.current_user_id()
          or core.can('MAINTENANCE', 'view', r.org_node_id, null))
   order by r.status = 'done', r.created_at desc
   limit 100;
$$;

revoke execute on function ops.maintenance_wheres(uuid),
  ops.raise_maintenance(uuid, text, text, text, text, text), ops.maintenance_requests(uuid)
  from public;
grant execute on function ops.maintenance_wheres(uuid),
  ops.raise_maintenance(uuid, text, text, text, text, text), ops.maintenance_requests(uuid),
  ops.maintenance_where_codes() to app_rw;

-- migrate:down
drop function ops.maintenance_requests(uuid);
create function ops.maintenance_requests(p_id uuid default null)
returns table (id uuid, title text, description text, status text, org_node_id uuid,
               handled_by text, place_name text, reported_by_name text, assigned_to uuid,
               assigned_to_name text, photo_key text, done_photo_key text, done_note text,
               created_at timestamptz, done_at timestamptz, place_node_id uuid,
               assigned_at timestamptz, assigned_by_name text)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select r.id, r.title, r.description, r.status, r.org_node_id, h.name, p.name,
         rb.display_name, r.assigned_to, at.display_name, r.photo_key, r.done_photo_key,
         r.done_note, r.created_at, r.done_at, r.place_node_id, r.assigned_at, ab.display_name
    from ops.maintenance_request r
    join core.hierarchy_node h on h.id = r.org_node_id
    join core.hierarchy_node p on p.id = r.place_node_id
    left join core.app_user rb on rb.id = r.reported_by
    left join core.app_user at on at.id = r.assigned_to
    left join core.app_user ab on ab.id = r.assigned_by
   where r.tenant_id = core.my_tenant()
     and (p_id is null or r.id = p_id)
     and (r.reported_by = core.current_user_id() or r.assigned_to = core.current_user_id()
          or core.can('MAINTENANCE', 'view', r.org_node_id, null))
   order by r.status = 'done', r.created_at desc
   limit 100;
$$;
revoke execute on function ops.maintenance_requests(uuid) from public;
grant execute on function ops.maintenance_requests(uuid) to app_rw;
drop function ops.raise_maintenance(uuid, text, text, text, text, text);
drop function ops.maintenance_wheres(uuid);
alter table ops.maintenance_request drop column location;
drop function ops.maintenance_where_codes();
