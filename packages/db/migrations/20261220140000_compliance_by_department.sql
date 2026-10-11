-- migrate:up
-- Compliance for a department (ADR 124): a person sees, read only, the licences and regular
-- jobs their own job role renews, answers for or does at their outlet; the head of a
-- department (who manages its tasks) those of every role in it: the chief engineer the fire
-- NOC, the extinguishers and the water test; the executive housekeeper pest control. The GM and whoever keeps the register
-- (COMPLIANCE) still see everything. Compliance is on Me and Home for them, and its card on
-- Home lists them (ops.compliance_attention reads the same functions).

-- each outlet where the caller works, with the job roles whose compliance they see there:
-- their own; and, for whoever manages the department (its head), every role held in it
create function ops.my_compliance_roles()
returns table (outlet_id uuid, role_code text)
language sql stable security definer
set search_path = pg_catalog, core, hr
as $$
  select distinct core.nearest(w.org_node_id, array['outlet', 'site']), w.role_code
    from hr.worker w
   where w.owner_user_id = core.current_user_id() and w.status = 'active'
     and w.tenant_id = core.my_tenant()
  union
  select distinct core.nearest(d.id, array['outlet', 'site']), o.role_code
    from hr.worker w
    join core.hierarchy_node d on d.id = w.org_node_id and d.kind = 'department'
    join hr.worker o on o.org_node_id = d.id and o.status = 'active'
   where w.owner_user_id = core.current_user_id() and w.status = 'active'
     and w.tenant_id = core.my_tenant()
     and core.can('TASKS', 'modify', d.id, null);
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
-- something of the caller's (or their department's) is on the register at this outlet
create function ops.department_compliance_at(p_outlet uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select exists (select 1 from ops.licence l
                  where l.tenant_id = core.my_tenant() and l.archived_at is null
                    and core.nearest(l.org_node_id, array['outlet', 'site']) = p_outlet
                    and ops.department_sees(l.org_node_id, array[l.renewal_role]))
      or exists (select 1 from ops.compliance_item i
                  where i.tenant_id = core.my_tenant() and i.archived_at is null
                    and core.nearest(i.org_node_id, array['outlet', 'site']) = p_outlet
                    and ops.department_sees(i.org_node_id, array[i.owner_role, i.doer_role]));
$$;

-- the Compliance screen's outlets: where they keep it, or where their department has some
select core.patch_function('core.screen_places(text)',
$x$           and core.can('COMPLIANCE', 'view', n.id, null)$x$,
$x$           and (core.can('COMPLIANCE', 'view', n.id, null)
                or ops.department_compliance_at(n.id))$x$);

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

-- Home's card: a row seen only as the department's (not as the register's keeper) is still the
-- person's own when its To do item is theirs (they may act on it)
create function ops.mine_to_do(p_task uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select coalesce((select ops.can_work(t, core.current_user_id())
                          and not core.can('COMPLIANCE', 'view', t.org_node_id, null)
                     from ops.task t where t.id = p_task), false);
$$;
revoke execute on function ops.mine_to_do(uuid) from public;
select core.patch_function('ops.compliance_attention()',
$x$           l.days_left, false as own
      from ops.licences(null) l where l.days_left <= 90$x$,
$x$           l.days_left, ops.mine_to_do(l.open_task) as own
      from ops.licences(null) l where l.days_left <= 90$x$);
select core.patch_function('ops.compliance_attention()',
$x$    select 'job', i.id, i.open_task, i.place_name, i.name, i.days_left, false
      from ops.compliance_items(null) i where i.days_left <= 14$x$,
$x$    select 'job', i.id, i.open_task, i.place_name, i.name, i.days_left,
           ops.mine_to_do(i.open_task)
      from ops.compliance_items(null) i where i.days_left <= 14$x$);

revoke execute on function ops.my_compliance_roles(), ops.department_sees(uuid, text[]),
  ops.department_compliance_at(uuid), ops.sees_department_compliance() from public;
grant execute on function ops.sees_department_compliance() to app_rw;

-- migrate:down
select core.patch_function('ops.compliance_attention()',
$x$           l.days_left, ops.mine_to_do(l.open_task) as own
      from ops.licences(null) l where l.days_left <= 90$x$,
$x$           l.days_left, false as own
      from ops.licences(null) l where l.days_left <= 90$x$);
select core.patch_function('ops.compliance_attention()',
$x$    select 'job', i.id, i.open_task, i.place_name, i.name, i.days_left,
           ops.mine_to_do(i.open_task)
      from ops.compliance_items(null) i where i.days_left <= 14$x$,
$x$    select 'job', i.id, i.open_task, i.place_name, i.name, i.days_left, false
      from ops.compliance_items(null) i where i.days_left <= 14$x$);
drop function ops.mine_to_do(uuid);
select core.patch_function('core.screen_places(text)',
$x$           and (core.can('COMPLIANCE', 'view', n.id, null)
                or ops.department_compliance_at(n.id))$x$,
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
drop function ops.department_compliance_at(uuid);
drop function ops.department_sees(uuid, text[]);
drop function ops.my_compliance_roles();
