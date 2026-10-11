-- migrate:up
-- Every meter reading with its time (ADR 124): a meter is read twice a day at a hotel, so the
-- Utilities screen lists readings, not days. Each says when it was due (its round's due time)
-- and whether it was taken more than 30 minutes before or after that, shown in red.

create function ops.utility_readings(p_place uuid, p_from date, p_to date)
returns table (meter_id uuid, read_at timestamptz, day date, read_time text, value numeric,
               used numeric, due_time text, off_time boolean, read_by text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
#variable_conflict use_column
declare
  v_tz text := ops.tz_of(p_place);
begin
  if not core.can('UTILITIES', 'view', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'UTILITIES view');
  end if;
  if p_to < p_from or p_to - p_from > 400 then
    perform ops.fail('INVALID_VALUE', 'up to 400 days');
  end if;
  return query
    with r as (
      select r.meter_id, r.read_at, ((r.read_at at time zone v_tz) - interval '4 hours')::date as day,
             r.value, lag(r.value) over (partition by r.meter_id order by r.read_at) as before,
             t.due_at, u.display_name
        from ops.meter_reading r
        join ops.meter m on m.id = r.meter_id and m.tenant_id = core.my_tenant()
        left join ops.task_step s on s.id = r.task_step_id
        left join ops.task t on t.id = s.task_id
        left join core.app_user u on u.id = r.created_by
       where r.org_node_id = p_place
         and ((r.read_at at time zone v_tz) - interval '4 hours')::date <= p_to)
    select r.meter_id, r.read_at, r.day, to_char(r.read_at at time zone v_tz, 'HH24:MI'), r.value,
           r.value - r.before, to_char(r.due_at at time zone v_tz, 'HH24:MI'),
           coalesce(abs(extract(epoch from r.read_at - r.due_at)) > 30 * 60, false),
           r.display_name
      from r
     where r.day between p_from and p_to
     order by r.meter_id, r.read_at desc;
end $$;

revoke execute on function ops.utility_readings(uuid, date, date) from public;
grant execute on function ops.utility_readings(uuid, date, date) to app_rw;

-- migrate:down
drop function ops.utility_readings(uuid, date, date);
