-- migrate:up
-- Compliance first on Home (ADR 069 addendum): what can close an outlet is shown above
-- everything else, row by row. The rows are the Expiring tab (licences within 90 days or
-- expired) and the calendar jobs due within 14 days (the overdue ones are the Overdue tab),
-- over what the caller sees; and, for someone who doesn't keep Compliance, the renewals and
-- jobs whose reminder is with them (ops.can_work), each opening its To do item.
create function ops.compliance_attention()
returns table (kind text, id uuid, task_id uuid, place_name text, name text, days_left int,
               own boolean)
language sql stable security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  with seen as (
    select 'licence'::text as kind, l.id, l.open_task as task_id, l.place_name, l.name,
           l.days_left, false as own
      from ops.licences(null) l where l.days_left <= 90
    union all
    select 'job', i.id, i.open_task, i.place_name, i.name, i.days_left, false
      from ops.compliance_items(null) i where i.days_left <= 14
  ),
  mine as (
    select case t.kind when 'licence' then 'licence' else 'job' end as kind,
           coalesce(t.licence_id, t.compliance_item_id) as id, t.id as task_id, n.name,
           coalesce(l.name, i.name) as name,
           coalesce(l.expires_on, i.next_due) - ops.today_at(t.org_node_id) as days_left,
           true as own
      from ops.task t
      join core.hierarchy_node n on n.id = t.org_node_id
      left join ops.licence l on l.id = t.licence_id
      left join ops.compliance_item i on i.id = t.compliance_item_id
     where t.tenant_id = core.my_tenant() and t.kind in ('licence', 'compliance')
       and t.status in ('open', 'in_progress')
       and core.module_on(t.tenant_id, 'compliance')
       and ops.can_work(t, core.current_user_id())
       and coalesce(t.licence_id, t.compliance_item_id) not in (select s.id from seen s)
  )
  select * from (select * from seen union all select * from mine) x
   order by (x.days_left < 0) desc, x.days_left, x.place_name, x.name;
$$;

revoke execute on function ops.compliance_attention() from public;
grant execute on function ops.compliance_attention() to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.compliance_attention();
