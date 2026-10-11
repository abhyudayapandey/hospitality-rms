-- migrate:up
-- Compliance for a department (ADR 124): whoever works in a department sees the licences and
-- regular jobs a role of that department renews, answers for or does, at its outlet, read
-- only: the technician and the chief engineer see the fire NOC, the extinguishers and the
-- water test; the executive housekeeper pest control. The GM and whoever keeps the register
-- (COMPLIANCE) still see everything. Compliance is on Me and Home for them, and its card on
-- Home lists them (ops.compliance_attention reads the same functions).

-- each outlet where the caller works in a department, with the job roles held there
create function ops.my_compliance_roles()
returns table (outlet_id uuid, role_code text)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select distinct core.nearest(d.id, array['outlet', 'site']), o.role_code
    from hr.worker w
    join core.hierarchy_node d on d.id = w.org_node_id and d.kind = 'department'
    join hr.worker o on o.org_node_id = d.id and o.status = 'active'
   where w.owner_user_id = core.current_user_id() and w.status = 'active'
     and w.tenant_id = core.my_tenant();
$$;

-- a role of the caller's department answers for it at that outlet
create function ops.department_sees(p_node uuid, p_roles text[]) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select exists (select 1 from ops.my_compliance_roles() r
                  where r.outlet_id = coalesce(core.nearest(p_node, array['outlet', 'site']), p_node)
                    and r.role_code = any (p_roles));
$$;

select core.patch_function('ops.compliance_items(uuid)',
$x$     and core.can('COMPLIANCE', 'view', i.org_node_id, null)$x$,
$x$     and (core.can('COMPLIANCE', 'view', i.org_node_id, null)
          or ops.department_sees(i.org_node_id, array[i.owner_role, i.doer_role]))$x$);
select core.patch_function('ops.licences(uuid)',
$x$     and core.can('COMPLIANCE', 'view', l.org_node_id, null)$x$,
$x$     and (core.can('COMPLIANCE', 'view', l.org_node_id, null)
          or ops.department_sees(l.org_node_id, array[l.renewal_role]))$x$);
-- the Compliance screen's outlets: where they keep it, or where their department has some
select core.patch_function('core.screen_places(text)',
$x$           and core.can('COMPLIANCE', 'view', n.id, null)$x$,
$x$           and (core.can('COMPLIANCE', 'view', n.id, null)
                or n.id in (select r.outlet_id from ops.my_compliance_roles() r))$x$);

-- whether Me and Home offer Compliance to someone without the register: something of their
-- department's is on it
create function ops.sees_department_compliance() returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select core.module_on(core.my_tenant(), 'compliance')
     and (exists (select 1 from ops.licence l
                   where l.tenant_id = core.my_tenant() and l.archived_at is null
                     and ops.department_sees(l.org_node_id, array[l.renewal_role]))
          or exists (select 1 from ops.compliance_item i
                      where i.tenant_id = core.my_tenant() and i.archived_at is null
                        and ops.department_sees(i.org_node_id,
                                                array[i.owner_role, i.doer_role])));
$$;

revoke execute on function ops.my_compliance_roles(), ops.department_sees(uuid, text[]),
  ops.sees_department_compliance() from public;
grant execute on function ops.sees_department_compliance() to app_rw;

-- migrate:down
select core.patch_function('core.screen_places(text)',
$x$           and (core.can('COMPLIANCE', 'view', n.id, null)
                or n.id in (select r.outlet_id from ops.my_compliance_roles() r))$x$,
$x$           and core.can('COMPLIANCE', 'view', n.id, null)$x$);
select core.patch_function('ops.licences(uuid)',
$x$     and (core.can('COMPLIANCE', 'view', l.org_node_id, null)
          or ops.department_sees(l.org_node_id, array[l.renewal_role]))$x$,
$x$     and core.can('COMPLIANCE', 'view', l.org_node_id, null)$x$);
select core.patch_function('ops.compliance_items(uuid)',
$x$     and (core.can('COMPLIANCE', 'view', i.org_node_id, null)
          or ops.department_sees(i.org_node_id, array[i.owner_role, i.doer_role]))$x$,
$x$     and core.can('COMPLIANCE', 'view', i.org_node_id, null)$x$);
drop function ops.sees_department_compliance();
drop function ops.department_sees(uuid, text[]);
drop function ops.my_compliance_roles();
