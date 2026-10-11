-- migrate:up
-- Fire extinguishers in Compliance (ADR 127): each one a licence of kind FIRE_EXTINGUISHER with
-- where it hangs (location) and what it is (equipment_type: CO2, ABC powder, ...), so its
-- refill or expiry date is on the Compliance card like any licence, amber then red, and its
-- renewal role gets the To do item. Location and type are open to any licence (a lift's
-- certificate, a boiler's), and a renewal keeps them.

create function ops.extinguisher_types() returns text[]
language sql immutable
as $$
  select array['CO2', 'ABC powder', 'Foam', 'Water', 'Wet chemical', 'Clean agent'];
$$;

alter table ops.licence
  add column location text check (location is null or length(btrim(location)) between 1 and 80),
  add column equipment_type text,
  add constraint licence_extinguisher_type check (
    kind <> 'FIRE_EXTINGUISHER' or equipment_type is null
    or equipment_type = any (ops.extinguisher_types()));

-- a renewal (ops.renew_licence) makes a new row and points the old one at it: it keeps where
-- the thing is and what it is
create function ops.licence_keep_place() returns trigger
language plpgsql security definer
set search_path = pg_catalog, ops
as $$
begin
  update ops.licence n
     set location = coalesce(n.location, new.location),
         equipment_type = coalesce(n.equipment_type, new.equipment_type)
   where n.id = new.replaced_by;
  return new;
end $$;
create trigger licence_keep_place after update of replaced_by on ops.licence
  for each row when (new.replaced_by is not null and old.replaced_by is null)
  execute function ops.licence_keep_place();

create function ops.save_licence(p_id uuid, p_node uuid, p_kind text, p_name text, p_number text,
                                 p_authority text, p_issued date, p_expires date, p_role text,
                                 p_files text[], p_idempotency_key text, p_location text,
                                 p_type text) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_id uuid;
begin
  if coalesce(p_kind, '') = 'FIRE_EXTINGUISHER' and nullif(btrim(p_type), '') is not null
     and btrim(p_type) <> all (ops.extinguisher_types()) then
    perform ops.fail('INVALID_VALUE', 'not a kind of fire extinguisher');
  end if;
  v_id := ops.save_licence(p_id, p_node, p_kind, p_name, p_number, p_authority, p_issued,
                           p_expires, p_role, p_files, p_idempotency_key);
  update ops.licence
     set location = nullif(btrim(p_location), ''), equipment_type = nullif(btrim(p_type), '')
   where id = v_id
     and (location, equipment_type) is distinct from
         (nullif(btrim(p_location), ''), nullif(btrim(p_type), ''));
  return v_id;
end $$;

drop function ops.licences(uuid);
create function ops.licences(p_node uuid)
returns table (id uuid, org_node_id uuid, place_name text, kind text, name text, number text,
               authority text, issued_on date, expires_on date, days_left int,
               renewal_role text, renewal_role_name text, files text[], renewed_from date,
               open_task uuid, location text, equipment_type text)
language sql stable security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  select l.id, l.org_node_id, n.name, l.kind, l.name, l.number, l.authority, l.issued_on,
         l.expires_on, (l.expires_on - ops.today_at(l.org_node_id))::int, l.renewal_role,
         coalesce(r.name, l.renewal_role), l.files,
         (select p.expires_on from ops.licence p where p.replaced_by = l.id),
         (select t.id from ops.task t where t.licence_id = l.id
                                         and t.status in ('open', 'in_progress')),
         l.location, l.equipment_type
    from ops.licence l
    join core.hierarchy_node n on n.id = l.org_node_id
    left join hr.job_role r on r.tenant_id = l.tenant_id and r.code = l.renewal_role
   where l.tenant_id = core.my_tenant() and l.archived_at is null
     and core.module_on(l.tenant_id, 'compliance')
     and core.can('COMPLIANCE', 'view', l.org_node_id, null)
     and (p_node is null or n.path operator(extensions.<@)
                            (select p.path from core.hierarchy_node p where p.id = p_node))
   order by l.expires_on nulls last, n.name, l.name;
$$;

revoke execute on function ops.licences(uuid), ops.licence_keep_place(),
  ops.save_licence(uuid, uuid, text, text, text, text, date, date, text, text[], text, text, text)
  from public;
grant execute on function ops.licences(uuid), ops.extinguisher_types(),
  ops.save_licence(uuid, uuid, text, text, text, text, date, date, text, text[], text, text, text)
  to app_rw;

-- migrate:down
drop function ops.licences(uuid);
create function ops.licences(p_node uuid)
returns table (id uuid, org_node_id uuid, place_name text, kind text, name text, number text,
               authority text, issued_on date, expires_on date, days_left int,
               renewal_role text, renewal_role_name text, files text[], renewed_from date,
               open_task uuid)
language sql stable security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  select l.id, l.org_node_id, n.name, l.kind, l.name, l.number, l.authority, l.issued_on,
         l.expires_on, (l.expires_on - ops.today_at(l.org_node_id))::int, l.renewal_role,
         coalesce(r.name, l.renewal_role), l.files,
         (select p.expires_on from ops.licence p where p.replaced_by = l.id),
         (select t.id from ops.task t where t.licence_id = l.id
                                         and t.status in ('open', 'in_progress'))
    from ops.licence l
    join core.hierarchy_node n on n.id = l.org_node_id
    left join hr.job_role r on r.tenant_id = l.tenant_id and r.code = l.renewal_role
   where l.tenant_id = core.my_tenant() and l.archived_at is null
     and core.module_on(l.tenant_id, 'compliance')
     and core.can('COMPLIANCE', 'view', l.org_node_id, null)
     and (p_node is null or n.path operator(extensions.<@)
                            (select p.path from core.hierarchy_node p where p.id = p_node))
   order by l.expires_on nulls last, n.name, l.name;
$$;
revoke execute on function ops.licences(uuid) from public;
grant execute on function ops.licences(uuid) to app_rw;
drop function ops.save_licence(uuid, uuid, text, text, text, text, date, date, text, text[], text,
                               text, text);
drop trigger licence_keep_place on ops.licence;
drop function ops.licence_keep_place();
alter table ops.licence drop constraint licence_extinguisher_type, drop column equipment_type,
  drop column location;
drop function ops.extinguisher_types();
