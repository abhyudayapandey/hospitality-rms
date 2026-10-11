-- migrate:up
-- The roster by person offers every shift type of the department to everyone in it, and a
-- custom shift: on a day, from a time to a time (ADR 128). A shift type of another job role
-- (the chief engineer on the technicians' Day) gives the person a shift of their own with its
-- times; a custom one is a shift with no shift type. Every roster rule runs on it, as on any
-- assignment (hr.assign), and a warning asks before going ahead.

-- put a worker on a day's shift with these times, replacing what they had that day here
create function hr.set_custom_shift(p_worker uuid, p_day date, p_start time, p_end time,
                                    p_accept text[] default '{}', p_break int default 0)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker;
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
  v_shift uuid;
begin
  select * into v_w from hr.worker where id = p_worker and tenant_id = core.my_tenant()
     and status = 'active';
  if not found then
    perform hr.fail('INVALID_WORKER', 'worker not found');
  end if;
  perform hr.require('ROSTER', 'modify', v_w.org_node_id);
  if p_start is null or p_end is null or p_start = p_end then
    perform hr.fail('INVALID_VALUE', 'a start and an end');
  end if;
  if coalesce(p_break, 0) < 0 or coalesce(p_break, 0) > 240 then
    perform hr.fail('INVALID_VALUE', 'a break of 0 to 240 minutes');
  end if;
  v_tz := hr.node_tz(v_w.org_node_id);
  v_start := (p_day + p_start) at time zone v_tz;
  v_end := (p_day + case when p_end > p_start then 0 else 1 end + p_end) at time zone v_tz;
  if v_end - v_start > interval '16 hours' then
    perform hr.fail('INVALID_VALUE', 'a shift of 16 hours at most');
  end if;
  -- off whatever they had that day here (the same checks as a tile: not a past day or a
  -- started shift)
  perform hr.set_day_shift(p_worker, p_day, null);
  insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                        role_code, headcount, break_minutes)
  values (v_w.tenant_id, v_w.org_node_id, null, p_day, v_start, v_end, v_w.role_code, 1,
          coalesce(p_break, 0))
  returning id into v_shift;
  return hr.assign(v_shift, v_w.id, p_accept);
end $$;

-- a shift type of another job role gives the person a shift of their own with its times
create function hr.set_day_shift_any(p_worker uuid, p_day date, p_template uuid,
                                     p_accept text[] default '{}') returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker;
  v_t hr.shift_template;
begin
  select * into v_w from hr.worker where id = p_worker and tenant_id = core.my_tenant()
     and status = 'active';
  if not found then
    perform hr.fail('INVALID_WORKER', 'worker not found');
  end if;
  if p_template is not null then
    select * into v_t from hr.shift_template
     where id = p_template and tenant_id = v_w.tenant_id and archived_at is null;
    if found and v_t.role_code <> v_w.role_code then
      if v_t.org_node_id <> v_w.org_node_id then
        perform hr.fail('NOT_AUTHORISED', 'a shift type of another place');
      end if;
      return hr.set_custom_shift(p_worker, p_day, v_t.start_time, v_t.end_time, p_accept,
                                 v_t.break_minutes);
    end if;
  end if;
  return hr.set_day_shift(p_worker, p_day, p_template, p_accept);
end $$;

revoke execute on function hr.set_custom_shift(uuid, date, time, time, text[], int),
  hr.set_day_shift_any(uuid, date, uuid, text[]) from public;
grant execute on function hr.set_custom_shift(uuid, date, time, time, text[], int),
  hr.set_day_shift_any(uuid, date, uuid, text[]) to app_rw;

-- migrate:down
drop function hr.set_day_shift_any(uuid, date, uuid, text[]);
drop function hr.set_custom_shift(uuid, date, time, time, text[], int);
