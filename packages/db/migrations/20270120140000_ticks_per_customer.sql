-- migrate:up
-- One customer's trouble stops only that customer's tick (ADR 167, review H10).
--
-- The tasks tick ran ops.tasks_tick, ops.expiry_alerts and ops.compliance_tick for every
-- customer in one transaction: one bad template rolled back everybody's rounds, reminders and
-- alerts, every 5 minutes, and held its row locks for the whole run. Each now takes p_tenant
-- (null = every customer, as before, for tests and one-off runs), and the tick
-- (packages/workflow/src/ticks.ts) runs each job for each customer in its own transaction,
-- logging and skipping one that fails. ops.tick_tenants lists the customers to run, for the
-- executor, which may not read core.tenant.

create function ops.tick_tenants() returns table (tenant_id uuid, code text)
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select t.id, t.code from core.tenant t
   where t.status = 'active' and t.removed_at is null
   order by t.code, t.id;
$$;
revoke execute on function ops.tick_tenants() from public;
grant execute on function ops.tick_tenants() to wf_executor;

-- today's par where it goes by the day (ADR 092), for one customer
select core.patch_function('inv.apply_par_by_day(timestamptz)',
  $x$inv.apply_par_by_day(p_now timestamp with time zone DEFAULT now())$x$,
  $x$inv.apply_par_by_day(p_now timestamp with time zone DEFAULT now(), p_tenant uuid DEFAULT NULL::uuid)$x$);
select core.patch_function('inv.apply_par_by_day(timestamptz, uuid)',
  $x$   where n.par_by_day is not null and n.archived_at is null$x$,
  $x$   where n.par_by_day is not null and n.archived_at is null
     and (p_tenant is null or n.tenant_id = p_tenant)$x$);
drop function inv.apply_par_by_day(timestamptz);

select core.patch_function('ops.tasks_tick(timestamptz)',
  $x$ops.tasks_tick(p_now timestamp with time zone DEFAULT now())$x$,
  $x$ops.tasks_tick(p_now timestamp with time zone DEFAULT now(), p_tenant uuid DEFAULT NULL::uuid)$x$);
drop function ops.tasks_tick(timestamptz);
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
  $x$perform inv.apply_par_by_day(p_now);$x$,
  $x$perform inv.apply_par_by_day(p_now, p_tenant);$x$);
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
  $x$     where c.archived_at is null and core.tenant_active(c.tenant_id)$x$,
  $x$     where c.archived_at is null and core.tenant_active(c.tenant_id)
       and (p_tenant is null or c.tenant_id = p_tenant)$x$);
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
  $x$where t.status = 'open' and t.assign_mode = 'job_role'$x$,
  $x$where t.status = 'open' and t.assign_mode = 'job_role'
                and (p_tenant is null or t.tenant_id = p_tenant)$x$);
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
  $x$where status in ('open', 'in_progress') and reminded_at is null$x$,
  $x$where status in ('open', 'in_progress') and reminded_at is null
                and (p_tenant is null or tenant_id = p_tenant)$x$);
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
  $x$where status in ('open', 'in_progress') and escalated_at is null and due_at <= p_now$x$,
  $x$where status in ('open', 'in_progress') and escalated_at is null and due_at <= p_now
                and (p_tenant is null or tenant_id = p_tenant)$x$);
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
  $x$where status in ('open', 'in_progress') and escalated_head_at is null$x$,
  $x$where status in ('open', 'in_progress') and escalated_head_at is null
                and (p_tenant is null or tenant_id = p_tenant)$x$);

select core.patch_function('ops.expiry_alerts(timestamptz)',
  $x$ops.expiry_alerts(p_now timestamp with time zone DEFAULT now())$x$,
  $x$ops.expiry_alerts(p_now timestamp with time zone DEFAULT now(), p_tenant uuid DEFAULT NULL::uuid)$x$);
drop function ops.expiry_alerts(timestamptz);
select core.patch_function('ops.expiry_alerts(timestamptz, uuid)',
  $x$     where n.type = 'delivery' and n.holds_stock and n.archived_at is null$x$,
  $x$     where n.type = 'delivery' and n.holds_stock and n.archived_at is null
       and (p_tenant is null or n.tenant_id = p_tenant)$x$);

select core.patch_function('ops.compliance_tick(timestamptz)',
  $x$ops.compliance_tick(p_now timestamp with time zone DEFAULT now())$x$,
  $x$ops.compliance_tick(p_now timestamp with time zone DEFAULT now(), p_tenant uuid DEFAULT NULL::uuid)$x$);
drop function ops.compliance_tick(timestamptz);
select core.patch_function('ops.compliance_tick(timestamptz, uuid)',
  $x$     where l.archived_at is null and l.expires_on is not null$x$,
  $x$     where l.archived_at is null and l.expires_on is not null
       and (p_tenant is null or l.tenant_id = p_tenant)$x$);
select core.patch_function('ops.compliance_tick(timestamptz, uuid)',
  $x$     where i.archived_at is null
$x$,
  $x$     where i.archived_at is null and (p_tenant is null or i.tenant_id = p_tenant)
$x$);

revoke execute on function inv.apply_par_by_day(timestamptz, uuid),
  ops.tasks_tick(timestamptz, uuid), ops.expiry_alerts(timestamptz, uuid),
  ops.compliance_tick(timestamptz, uuid) from public;
grant execute on function ops.tasks_tick(timestamptz, uuid), ops.expiry_alerts(timestamptz, uuid),
  ops.compliance_tick(timestamptz, uuid) to wf_executor;

-- migrate:down
select core.patch_function('ops.compliance_tick(timestamptz, uuid)',
  $x$     where i.archived_at is null and (p_tenant is null or i.tenant_id = p_tenant)
$x$,
  $x$     where i.archived_at is null
$x$);
select core.patch_function('ops.compliance_tick(timestamptz, uuid)',
  $x$     where l.archived_at is null and l.expires_on is not null
       and (p_tenant is null or l.tenant_id = p_tenant)$x$,
  $x$     where l.archived_at is null and l.expires_on is not null$x$);
select core.patch_function('ops.compliance_tick(timestamptz, uuid)',
  $x$ops.compliance_tick(p_now timestamp with time zone DEFAULT now(), p_tenant uuid DEFAULT NULL::uuid)$x$,
  $x$ops.compliance_tick(p_now timestamp with time zone DEFAULT now())$x$);
drop function ops.compliance_tick(timestamptz, uuid);

select core.patch_function('ops.expiry_alerts(timestamptz, uuid)',
  $x$     where n.type = 'delivery' and n.holds_stock and n.archived_at is null
       and (p_tenant is null or n.tenant_id = p_tenant)$x$,
  $x$     where n.type = 'delivery' and n.holds_stock and n.archived_at is null$x$);
select core.patch_function('ops.expiry_alerts(timestamptz, uuid)',
  $x$ops.expiry_alerts(p_now timestamp with time zone DEFAULT now(), p_tenant uuid DEFAULT NULL::uuid)$x$,
  $x$ops.expiry_alerts(p_now timestamp with time zone DEFAULT now())$x$);
drop function ops.expiry_alerts(timestamptz, uuid);

select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
  $x$
                and (p_tenant is null or tenant_id = p_tenant)$x$, '');
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
  $x$
                and (p_tenant is null or t.tenant_id = p_tenant)$x$, '');
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
  $x$
       and (p_tenant is null or c.tenant_id = p_tenant)$x$, '');
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
  $x$perform inv.apply_par_by_day(p_now, p_tenant);$x$,
  $x$perform inv.apply_par_by_day(p_now);$x$);
select core.patch_function('ops.tasks_tick(timestamptz, uuid)',
  $x$ops.tasks_tick(p_now timestamp with time zone DEFAULT now(), p_tenant uuid DEFAULT NULL::uuid)$x$,
  $x$ops.tasks_tick(p_now timestamp with time zone DEFAULT now())$x$);
drop function ops.tasks_tick(timestamptz, uuid);

select core.patch_function('inv.apply_par_by_day(timestamptz, uuid)',
  $x$
     and (p_tenant is null or n.tenant_id = p_tenant)$x$, '');
select core.patch_function('inv.apply_par_by_day(timestamptz, uuid)',
  $x$inv.apply_par_by_day(p_now timestamp with time zone DEFAULT now(), p_tenant uuid DEFAULT NULL::uuid)$x$,
  $x$inv.apply_par_by_day(p_now timestamp with time zone DEFAULT now())$x$);
drop function inv.apply_par_by_day(timestamptz, uuid);

revoke execute on function inv.apply_par_by_day(timestamptz), ops.tasks_tick(timestamptz),
  ops.expiry_alerts(timestamptz), ops.compliance_tick(timestamptz) from public;
grant execute on function ops.tasks_tick(timestamptz), ops.expiry_alerts(timestamptz),
  ops.compliance_tick(timestamptz) to wf_executor;
drop function ops.tick_tenants();
