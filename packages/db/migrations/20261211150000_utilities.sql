-- migrate:up
-- Utilities (ADR 091), the Utilities block (ADR 085, domain UTILITIES; it needs Checklists).
--
-- * Meters at a place (file 43; the outlet or a department, usually Engineering): electricity,
--   gas, water, diesel or other, with their unit and the job role that reads them each day.
-- * The daily reading is a checklist round (ADR 020) the loader keeps, one per place, role
--   and time: a reading step per meter (`meter` in the step). Saving the step keeps the
--   reading (ops.meter_reading); what was used is this reading less the one before.
-- * The Utilities screen: each meter's readings and use by day, and by month, for whoever holds
--   UTILITIES there (engineering and the outlet's managers; area managers read).

create table ops.meter (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the outlet or a department
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_.-]*$'),
  name text not null check (length(btrim(name)) between 1 and 80),
  kind text not null check (kind in ('electricity', 'gas', 'water', 'diesel', 'other')),
  unit text not null check (length(btrim(unit)) between 1 and 20),
  archived_at timestamptz
);
select core.add_standard_columns('ops.meter');
create unique index meter_code on ops.meter (tenant_id, code);

create table ops.meter_reading (
  id uuid primary key default core.uuid_v7(),
  meter_id uuid not null references ops.meter(id),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the meter's place
  read_at timestamptz not null,
  value numeric(14,3) not null check (value >= 0),
  task_step_id uuid unique references ops.task_step(id)
);
select core.add_standard_columns('ops.meter_reading');
create index meter_reading_meter on ops.meter_reading (meter_id, read_at);

alter table ops.task_step add column meter_id uuid references ops.meter(id);

-- A checklist that is part of another block (the meter readings here, audits later) has no
-- rounds while that block is off.
alter table ops.checklist_template add column module text
  check (module is null or module = any (core.module_codes()));
select core.patch_function('ops.tasks_tick(timestamptz)',
$x$       and core.module_on(c.tenant_id, 'checklists')$x$,
$x$       and core.module_on(c.tenant_id, 'checklists')
       and (c.module is null or core.module_on(c.tenant_id, c.module))$x$);

-- a step may read a meter of its outlet
select core.patch_function('ops.check_steps(jsonb)',
$x$    if v_s ? 'icon' and$x$,
$x$    if v_s ? 'meter' and jsonb_typeof(v_s -> 'meter') <> 'null' and (
         v_s ->> 'kind' <> 'number'
         or (v_s ->> 'meter') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      perform ops.fail('INVALID_STEPS', 'a meter is read by a number step');
    end if;
    if v_s ? 'icon' and$x$);

do $$
declare
  v_src text := pg_get_functiondef('ops.add_steps(ops.task, jsonb)'::regprocedure);
  v_new text;
begin
  v_new := replace(replace(v_src,
    'max_value, unit, photo_required, icon, asks_food, asks_thrown)',
    'max_value, unit, photo_required, icon, asks_food, asks_thrown, meter_id)'),
    E'         coalesce((s.v ->> ''thrown'')::boolean, false)\n    from',
    E'         coalesce((s.v ->> ''thrown'')::boolean, false),\n'
    || E'         (select m.id from ops.meter m\n'
    || E'           where m.id = (s.v ->> ''meter'')::uuid and m.tenant_id = p_task.tenant_id)\n    from');
  if v_new = v_src or strpos(v_new, 'meter_id)') = 0 or strpos(v_new, 'from ops.meter m') = 0 then
    raise exception 'ops.add_steps: the parts to change are not there';
  end if;
  execute v_new;
end $$;

-- saving a meter's step keeps the reading (once: saving again corrects it)
select core.patch_function('ops.complete_step(uuid, uuid, jsonb)',
$x$  if coalesce(v_flagged, false) and not v_s.flagged then$x$,
$x$  if v_s.meter_id is not null then
    if v_num < 0 then
      perform ops.fail('INVALID_VALUE', 'a meter reading is not negative');
    end if;
    insert into ops.meter_reading (tenant_id, meter_id, org_node_id, read_at, value, task_step_id)
    select v_t.tenant_id, m.id, m.org_node_id, now(), v_num, v_s.id
      from ops.meter m where m.id = v_s.meter_id
    on conflict (task_step_id) do update set value = excluded.value, read_at = excluded.read_at;
  end if;
  if coalesce(v_flagged, false) and not v_s.flagged then$x$);

-- The places whose meters I may read about.
create function ops.utility_places()
returns table (place_id uuid, name text, meters int)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select n.id, n.name, count(m.id)::int
    from core.hierarchy_node n
    join ops.meter m on m.org_node_id = n.id and m.archived_at is null
   where n.tenant_id = core.my_tenant() and n.archived_at is null
     and core.can('UTILITIES', 'view', n.id, null)
   group by n.id, n.name
   order by n.name;
$$;

-- Each meter's use by day (the business day where it is, ADR 057) from p_from to p_to: the day's
-- last reading less the last reading before that day. A day without a reading has none.
create function ops.utility_days(p_place uuid, p_from date, p_to date)
returns table (meter_id uuid, meter text, kind text, unit text, day date, reading numeric,
               used numeric)
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
      select r.meter_id, ((r.read_at at time zone v_tz) - interval '4 hours')::date as day,
             r.value, r.read_at
        from ops.meter_reading r
       where r.org_node_id = p_place
         and ((r.read_at at time zone v_tz) - interval '4 hours')::date <= p_to),
    last_of_day as (
      select distinct on (meter_id, day) meter_id, day, value
        from r order by meter_id, day, read_at desc),
    with_before as (
      select l.*, lag(l.value) over (partition by l.meter_id order by l.day) as before
        from last_of_day l)
    select m.id, m.name, m.kind, m.unit, w.day, w.value, w.value - w.before
      from with_before w join ops.meter m on m.id = w.meter_id
     where w.day between p_from and p_to and m.tenant_id = core.my_tenant()
     order by m.name, w.day;
end $$;

-- The same by month, the last 12 months: what each meter used.
create function ops.utility_months(p_place uuid)
returns table (meter_id uuid, meter text, unit text, month date, used numeric)
language sql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
  select d.meter_id, d.meter, d.unit, date_trunc('month', d.day)::date, sum(d.used)
    from ops.utility_days(p_place, (date_trunc('month', rpt.today(p_place))
                                    - interval '11 months')::date, rpt.today(p_place)) d
   group by d.meter_id, d.meter, d.unit, date_trunc('month', d.day)
   order by d.meter, 4;
$$;

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.meter', 'UTILITIES', 'org', true),
  ('ops.meter_reading', 'UTILITIES', 'org', true);
select core.apply_domain_rls('ops.meter');
select core.apply_domain_rls('ops.meter_reading');
select audit.enable('ops.meter');
select audit.enable('ops.meter_reading');

revoke execute on function ops.utility_places(), ops.utility_days(uuid, date, date),
  ops.utility_months(uuid) from public, platform_loader;
grant execute on function ops.utility_places(), ops.utility_days(uuid, date, date),
  ops.utility_months(uuid) to app_rw;
grant select, insert, update on ops.meter to platform_loader;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
revoke select, insert, update on ops.meter from platform_loader;
drop function ops.utility_months(uuid);
drop function ops.utility_days(uuid, date, date);
drop function ops.utility_places();
do $$
begin
  execute regexp_replace(pg_get_functiondef('ops.complete_step(uuid, uuid, jsonb)'::regprocedure),
    E'  if v_s.meter_id is not null then.*?(  if coalesce\\(v_flagged, false\\) and not v_s.flagged then)', E'\\1', 's');
  execute regexp_replace(pg_get_functiondef('ops.check_steps(jsonb)'::regprocedure),
    E'    if v_s \\? ''meter''.*?(    if v_s \\? ''icon'')', E'\\1', 's');
end $$;
create or replace function ops.add_steps(p_task ops.task, p_steps jsonb) returns void
language sql security definer
set search_path = pg_catalog, ops
as $f$
  insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind, min_value,
                             max_value, unit, photo_required, icon, asks_food, asks_thrown)
  select p_task.tenant_id, p_task.id, p_task.org_node_id, s.ord, btrim(s.v ->> 'label'),
         s.v ->> 'kind', (s.v ->> 'min')::numeric, (s.v ->> 'max')::numeric,
         nullif(btrim(s.v ->> 'unit'), ''), coalesce((s.v ->> 'photo_required')::boolean, false),
         nullif(s.v ->> 'icon', ''), coalesce((s.v ->> 'food')::boolean, false),
         coalesce((s.v ->> 'thrown')::boolean, false)
    from jsonb_array_elements(p_steps) with ordinality s(v, ord);
$f$;
alter table ops.task_step drop column meter_id;
select core.patch_function('ops.tasks_tick(timestamptz)',
$x$       and core.module_on(c.tenant_id, 'checklists')
       and (c.module is null or core.module_on(c.tenant_id, c.module))$x$,
$x$       and core.module_on(c.tenant_id, 'checklists')$x$);
alter table ops.checklist_template drop column module;
delete from core.domain_table where table_name in ('ops.meter_reading'::regclass, 'ops.meter'::regclass);
drop table ops.meter_reading;
drop table ops.meter;
