-- migrate:up
-- A test customer's past roster (ADR 017, 114). hr.assign refuses a shift that has started, so
-- a demo's past week could only show clock-ins with no shift behind them ("Unrostered" every
-- day). The loader rosters the days file 35 has people clocking in through this function:
-- test customers only, as someone who builds the roster there, the assignment recorded as on
-- any other day. Nothing else may assign a started shift.
create function hr.record_test_assignment(p_shift uuid, p_worker uuid) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_s hr.shift;
  v_w hr.worker;
  v_id uuid;
begin
  if not coalesce((select t.is_test from core.tenant t where t.id = core.my_tenant()), false) then
    raise exception 'NOT_AUTHORISED' using detail = 'test customers only';
  end if;
  select * into v_s from hr.shift where id = p_shift and tenant_id = core.my_tenant();
  select * into v_w from hr.worker where id = p_worker and tenant_id = core.my_tenant();
  if v_s.id is null or v_w.id is null then
    raise exception 'NOT_FOUND' using detail = 'shift or worker';
  end if;
  if not core.can('ROSTER', 'modify', v_s.org_node_id, null) then
    raise exception 'NOT_AUTHORISED' using detail = 'ROSTER modify';
  end if;
  select a.id into v_id from hr.shift_assignment a
   where a.shift_id = p_shift and a.worker_id = p_worker and a.status = 'assigned';
  if v_id is not null then
    return v_id;
  end if;
  insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id, org_node_id,
                                   start_at, end_at)
  values (v_s.tenant_id, v_s.id, v_w.id, v_w.owner_user_id, v_s.org_node_id, v_s.start_at,
          v_s.end_at)
  returning id into v_id;
  return v_id;
end $$;

-- A test customer's past order is placed on its day too (ADR 114), not at the import's time:
-- its release time is when it was ordered, and its approval request with it.
select core.patch_function('inv.record_test_release(uuid,timestamptz)',
  $x$  update inv.purchase_order set status = 'released', released_at = p_at,
         ordered_at = case when supplier_id is not null then p_at end
   where id = p_po;$x$,
  $x$  update inv.purchase_order set status = 'released', released_at = p_at,
         ordered_at = case when supplier_id is not null then p_at end,
         created_at = least(created_at, p_at)
   where id = p_po;
  update wf.request set created_at = least(created_at, p_at) where id = v_po.wf_request_id;$x$);

revoke execute on function hr.record_test_assignment(uuid, uuid) from public, app_rw;
grant execute on function hr.record_test_assignment(uuid, uuid) to platform_loader;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
select core.patch_function('inv.record_test_release(uuid,timestamptz)',
  $x$  update inv.purchase_order set status = 'released', released_at = p_at,
         ordered_at = case when supplier_id is not null then p_at end,
         created_at = least(created_at, p_at)
   where id = p_po;
  update wf.request set created_at = least(created_at, p_at) where id = v_po.wf_request_id;$x$,
  $x$  update inv.purchase_order set status = 'released', released_at = p_at,
         ordered_at = case when supplier_id is not null then p_at end
   where id = p_po;$x$);
drop function hr.record_test_assignment(uuid, uuid);
