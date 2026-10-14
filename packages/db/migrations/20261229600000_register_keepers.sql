-- migrate:up
-- A register shows to its own people (ADR 090, 118). Before, anyone who ran a department kept
-- every register at the outlet: the chef and the restaurant manager saw Booking leads and
-- Visitors. Now a register with keepers (file 45's roles, else ops.register_default_roles) is
-- kept by:
-- * its keepers, where they work at the outlet;
-- * the heads (DEPARTMENT_HEAD) of the departments its keepers work in there;
-- * the outlet's managers (OUTLET_MANAGER, AREA_MANAGER, ACCOUNT_OWNER held at the outlet).
-- Group holding is read as core.group_holders does, for the caller alone (it is called per
-- place and register by ops.register_places).
-- A register with no keepers stays with anyone who holds REGISTERS where they work.
-- The access itself is still core.can('REGISTERS', ...) at the place.

create or replace function ops.keeps_register(p_register text, p_place uuid, p_access text)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
declare
  v_tenant uuid := core.my_tenant();
  v_me uuid := core.current_user_id();
  v_outlet uuid := core.nearest(p_place, array['outlet']);
  v_roles jsonb;
  v_keepers text[];
begin
  if ops.register_required(p_register) is null or v_outlet is null
     or not core.can('REGISTERS', p_access, p_place, null)
     or not ops.register_on(v_tenant, p_register, v_outlet) then
    return false;
  end if;
  select t.settings -> 'registers' -> p_register -> 'roles' into v_roles
    from core.tenant t where t.id = v_tenant;
  if v_roles is not null and jsonb_typeof(v_roles) = 'array' then
    v_keepers := array(select jsonb_array_elements_text(v_roles));
  end if;
  if coalesce(cardinality(v_keepers), 0) = 0 then
    -- none named: the register's own default roles, else anyone who holds REGISTERS here
    v_keepers := ops.register_default_roles(p_register);
    if coalesce(cardinality(v_keepers), 0) = 0 then
      return true;
    end if;
  end if;
  return
    -- a keeper, working at this outlet
    exists (select 1 from hr.worker w
              join core.hierarchy_node h on h.id = w.org_node_id
              join core.hierarchy_node o on o.id = v_outlet
             where w.owner_user_id = v_me and w.status = 'active'
               and h.path operator(extensions.<@) o.path
               and w.role_code = any (v_keepers))
    -- the outlet's managers
    or exists (select 1 from core.role_assignment ra
                 join core.security_group g on g.id = ra.group_id
                 join core.hierarchy_node n on n.id = ra.node_id and n.archived_at is null
                 join core.hierarchy_node o on o.id = v_outlet
                where ra.user_id = v_me
                  and g.code in ('OUTLET_MANAGER', 'AREA_MANAGER', 'ACCOUNT_OWNER')
                  and current_date >= ra.effective_from
                  and (ra.effective_to is null or current_date <= ra.effective_to)
                  and (n.id = o.id or (ra.include_descendants
                                       and n.path operator(extensions.@>) o.path)))
    -- the head of a department here where a keeper works
    or exists (select 1 from core.role_assignment ra
                 join core.security_group g on g.id = ra.group_id and g.code = 'DEPARTMENT_HEAD'
                 join core.hierarchy_node n on n.id = ra.node_id and n.archived_at is null
                 join core.hierarchy_node o on o.id = v_outlet
                 join core.hierarchy_node d on d.tenant_id = v_tenant and d.kind = 'department'
                  and d.archived_at is null and d.path operator(extensions.<@) o.path
                  and (d.id = n.id or (ra.include_descendants
                                       and n.path operator(extensions.@>) d.path))
                where ra.user_id = v_me
                  and current_date >= ra.effective_from
                  and (ra.effective_to is null or current_date <= ra.effective_to)
                  and exists (select 1 from hr.worker k
                               where k.org_node_id = d.id and k.status = 'active'
                                 and k.role_code = any (v_keepers)));
end $$;

-- migrate:down
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
