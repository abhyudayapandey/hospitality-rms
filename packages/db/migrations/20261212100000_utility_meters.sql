-- migrate:up
-- Utilities (ADR 091, 097): the screen lists every meter of a place, even one never read yet,
-- with its last reading and who reads it at what time (the meter round of file 43), so a new
-- meter says "No reading yet" instead of the whole place saying nothing.

create function ops.utility_meters(p_place uuid)
returns table (meter_id uuid, meter text, kind text, unit text, read_by text, read_at text,
               last_read_at timestamptz, last_reading numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, hr
as $$
#variable_conflict use_column
begin
  if not core.can('UTILITIES', 'view', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'UTILITIES view');
  end if;
  return query
    select m.id, m.name, m.kind, m.unit,
           (select string_agg(distinct coalesce(jr.name, c.assign ->> 'role'), ', ')
              from ops.checklist_template c
              left join hr.job_role jr
                on jr.tenant_id = c.tenant_id and jr.code = c.assign ->> 'role'
             where c.tenant_id = m.tenant_id and c.module = 'utilities'
               and c.archived_at is null
               and c.steps @> jsonb_build_array(jsonb_build_object('meter', m.id::text))),
           (select string_agg(distinct t.value, ', ')
              from ops.checklist_template c,
                   jsonb_array_elements_text(c.schedule -> 'times') t
             where c.tenant_id = m.tenant_id and c.module = 'utilities'
               and c.archived_at is null
               and c.steps @> jsonb_build_array(jsonb_build_object('meter', m.id::text))),
           l.read_at, l.value
      from ops.meter m
      left join lateral (
        select r.read_at, r.value from ops.meter_reading r
         where r.meter_id = m.id order by r.read_at desc limit 1) l on true
     where m.org_node_id = p_place and m.archived_at is null
       and m.tenant_id = core.my_tenant()
     order by m.name;
end $$;

revoke execute on function ops.utility_meters(uuid) from public, platform_loader;
grant execute on function ops.utility_meters(uuid) to app_rw;

-- migrate:down
drop function ops.utility_meters(uuid);
