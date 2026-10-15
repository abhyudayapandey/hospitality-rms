-- migrate:up
-- A licence's renewal task, once done, says the new expiry (QA of the Passport Hotel demo: the
-- bar licence's done task still read "expires 8 Nov 2026", the old licence's day).
--
-- ops.renew_licence keeps the old licence (archived, replaced_by the new one) and the task still
-- points at it. ops.compliance_task now follows replaced_by: `expires_on` and `number` are the
-- licence in force, and `renewed` says the task's licence was renewed.

drop function ops.compliance_task(uuid);
create function ops.compliance_task(p_task uuid)
returns table (licence_id uuid, item_id uuid, name text, place_name text, number text,
               authority text, expires_on date, next_due date, every_months int,
               needs_proof boolean, can_act boolean, can_hand_on boolean, owner_role_name text,
               renewed boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task;
  v_act boolean;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind in ('licence', 'compliance');
  if not found or not ops.sees_task(v_t) then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  v_act := coalesce(v_t.status in ('open', 'in_progress')
                    and (ops.can_work(v_t, core.current_user_id())
                         or core.can('COMPLIANCE', 'modify', v_t.org_node_id, null)), false);
  return query
    with recursive chain as (
      select l.id, l.replaced_by, l.number, l.expires_on, 0 as depth
        from ops.licence l where l.id = v_t.licence_id
      union all
      select nl.id, nl.replaced_by, nl.number, nl.expires_on, c.depth + 1
        from chain c join ops.licence nl on nl.id = c.replaced_by
       where c.depth < 50
    ), now_in_force as (
      select c.number, c.expires_on, c.depth > 0 as renewed
        from chain c order by c.depth desc limit 1
    )
    select l.id, i.id, coalesce(l.name, i.name), n.name, coalesce(f.number, l.number),
           l.authority, coalesce(f.expires_on, l.expires_on),
           i.next_due, i.every_months, coalesce(i.needs_proof, true), v_act,
           ops.may_hand_on(v_t),
           case when i.id is not null then ops.role_name(i.tenant_id, i.owner_role) end,
           coalesce(f.renewed, false)
      from (select 1) one
      left join ops.licence l on l.id = v_t.licence_id
      left join now_in_force f on true
      left join ops.compliance_item i on i.id = v_t.compliance_item_id
      join core.hierarchy_node n on n.id = v_t.org_node_id;
end $$;
revoke execute on function ops.compliance_task(uuid) from public;
grant execute on function ops.compliance_task(uuid) to app_rw;

-- migrate:down
drop function ops.compliance_task(uuid);
create function ops.compliance_task(p_task uuid)
returns table (licence_id uuid, item_id uuid, name text, place_name text, number text,
               authority text, expires_on date, next_due date, every_months int,
               needs_proof boolean, can_act boolean, can_hand_on boolean, owner_role_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task;
  v_act boolean;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind in ('licence', 'compliance');
  if not found or not ops.sees_task(v_t) then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  v_act := coalesce(v_t.status in ('open', 'in_progress')
                    and (ops.can_work(v_t, core.current_user_id())
                         or core.can('COMPLIANCE', 'modify', v_t.org_node_id, null)), false);
  return query
    select l.id, i.id, coalesce(l.name, i.name), n.name, l.number, l.authority, l.expires_on,
           i.next_due, i.every_months, coalesce(i.needs_proof, true), v_act,
           ops.may_hand_on(v_t),
           case when i.id is not null then ops.role_name(i.tenant_id, i.owner_role) end
      from (select 1) one
      left join ops.licence l on l.id = v_t.licence_id
      left join ops.compliance_item i on i.id = v_t.compliance_item_id
      join core.hierarchy_node n on n.id = v_t.org_node_id;
end $$;
revoke execute on function ops.compliance_task(uuid) from public;
grant execute on function ops.compliance_task(uuid) to app_rw;
