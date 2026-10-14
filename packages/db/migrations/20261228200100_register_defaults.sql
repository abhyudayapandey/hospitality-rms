-- migrate:up
-- Registers nobody could see (KI-06, ADR 090 and 118). Booking leads (ADR 118) was added to the
-- entries' check and the required fields, but not to ops.register_places, which listed the seven
-- first registers by hand: so no one ever saw it, whatever file 45 said.
--
-- * One list of every register (ops.register_codes, kept equal to registers.ts by a test);
--   ops.register_places reads it.
-- * A register the customer names no roles for (file 45 roles blank) is kept by its default
--   roles (ops.register_default_roles = registers.ts `keptBy`): the leads by the front office.
--   Others with no default stay with anyone who holds REGISTERS where they work. Those who run
--   a department or more (the GM, a head) keep every register, as before.

create function ops.register_codes() returns text[]
language sql immutable
as $$
  select array['lost_found', 'incidents', 'visitors', 'vehicles', 'staff_movement', 'keys',
               'leads', 'fire_equipment'];
$$;

create function ops.register_default_roles(p_register text) returns text[]
language sql immutable
as $$
  select case p_register
           when 'leads' then array['FRONT_OFFICE_MANAGER', 'FRONT_DESK_EXECUTIVE',
                                   'GUEST_RELATIONS_EXECUTIVE', 'RESERVATIONS_EXECUTIVE',
                                   'CONCIERGE', 'NIGHT_AUDITOR', 'BELL_CAPTAIN', 'BELLBOY']
         end;
$$;

create or replace function ops.keeps_register(p_register text, p_place uuid, p_access text)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
declare
  v_outlet uuid := core.nearest(p_place, array['outlet']);
  v_roles jsonb;
begin
  if ops.register_required(p_register) is null or v_outlet is null
     or not core.can('REGISTERS', p_access, p_place, null)
     or not ops.register_on(core.my_tenant(), p_register, v_outlet) then
    return false;
  end if;
  select t.settings -> 'registers' -> p_register -> 'roles' into v_roles
    from core.tenant t where t.id = core.my_tenant();
  if v_roles is null or jsonb_typeof(v_roles) <> 'array' or jsonb_array_length(v_roles) = 0 then
    -- none named: the register's own default roles, else anyone who holds REGISTERS here
    v_roles := to_jsonb(ops.register_default_roles(p_register));
    if v_roles is null or v_roles = 'null'::jsonb then
      return true;
    end if;
  end if;
  return exists (
    select 1 from hr.worker w
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node o on o.id = v_outlet
     where w.owner_user_id = core.current_user_id() and w.status = 'active'
       and h.path operator(extensions.<@) o.path
       and (v_roles ? w.role_code or ops.role_level(w.tenant_id, w.role_code) >= 2));
end $$;

create or replace function ops.register_places()
returns table (place_id uuid, place text, kind text, outlet text, registers text[],
               can_write text[])
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select n.id, n.name, n.kind, o.name,
         array(select r from unnest(ops.register_codes()) r
                where ops.keeps_register(r, n.id, 'view')),
         array(select r from unnest(ops.register_codes()) r
                where ops.keeps_register(r, n.id, 'modify'))
    from core.hierarchy_node n
    join core.hierarchy_node o on o.id = core.nearest(n.id, array['outlet'])
   where n.tenant_id = core.my_tenant() and n.type = 'org'
     and n.kind in ('outlet', 'department') and n.archived_at is null
     and core.can('REGISTERS', 'view', n.id, null)
     and exists (select 1 from unnest(ops.register_codes()) r
                  where ops.keeps_register(r, n.id, 'view'))
   order by o.name, (n.kind = 'outlet') desc, n.name;
$$;

-- migrate:down
create or replace function ops.register_places()
returns table (place_id uuid, place text, kind text, outlet text, registers text[],
               can_write text[])
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select n.id, n.name, n.kind, o.name,
         array(select r from unnest(array['lost_found', 'incidents', 'visitors', 'vehicles',
                                          'staff_movement', 'keys', 'fire_equipment']) r
                where ops.keeps_register(r, n.id, 'view')),
         array(select r from unnest(array['lost_found', 'incidents', 'visitors', 'vehicles',
                                          'staff_movement', 'keys', 'fire_equipment']) r
                where ops.keeps_register(r, n.id, 'modify'))
    from core.hierarchy_node n
    join core.hierarchy_node o on o.id = core.nearest(n.id, array['outlet'])
   where n.tenant_id = core.my_tenant() and n.type = 'org'
     and n.kind in ('outlet', 'department') and n.archived_at is null
     and core.can('REGISTERS', 'view', n.id, null)
     and exists (select 1 from unnest(array['lost_found', 'incidents', 'visitors', 'vehicles',
                                             'staff_movement', 'keys', 'fire_equipment']) r
                  where ops.keeps_register(r, n.id, 'view'))
   order by o.name, (n.kind = 'outlet') desc, n.name;
$$;

create or replace function ops.keeps_register(p_register text, p_place uuid, p_access text)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
declare
  v_outlet uuid := core.nearest(p_place, array['outlet']);
  v_roles jsonb;
begin
  if ops.register_required(p_register) is null or v_outlet is null
     or not core.can('REGISTERS', p_access, p_place, null)
     or not ops.register_on(core.my_tenant(), p_register, v_outlet) then
    return false;
  end if;
  select t.settings -> 'registers' -> p_register -> 'roles' into v_roles
    from core.tenant t where t.id = core.my_tenant();
  if v_roles is null or jsonb_typeof(v_roles) <> 'array' or jsonb_array_length(v_roles) = 0 then
    return true;
  end if;
  return exists (
    select 1 from hr.worker w
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node o on o.id = v_outlet
     where w.owner_user_id = core.current_user_id() and w.status = 'active'
       and h.path operator(extensions.<@) o.path
       and (v_roles ? w.role_code or ops.role_level(w.tenant_id, w.role_code) >= 2));
end $$;

drop function ops.register_default_roles(text);
drop function ops.register_codes();
