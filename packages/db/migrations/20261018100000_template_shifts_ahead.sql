-- migrate:up
-- Template shifts are added only for the next seven days (tomorrow to today + 7, in the
-- place's time zone), after the manager has seen how many; drafts in that window can be
-- discarded (ADR 024). Days that have started are never filled from templates.

-- A discarded (cancelled) shift no longer blocks adding its template again.
drop index hr.shift_template_day;
create unique index shift_template_day on hr.shift (template_id, local_date)
  where template_id is not null and status <> 'cancelled';

-- generate_week keeps its behaviour; its ON CONFLICT names the new index predicate.
create or replace function hr.generate_week(p_node uuid, p_week_start date) returns int
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_tz text;
  v_count int;
begin
  perform hr.require('ROSTER', 'modify', p_node);
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    perform hr.fail('INVALID_WEEK', 'weeks start on a Monday');
  end if;
  v_tz := hr.node_tz(p_node);
  insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                        role_code, headcount)
  select t.tenant_id, t.org_node_id, t.id, d.day,
         (d.day + t.start_time) at time zone v_tz,
         (d.day + case when t.end_time > t.start_time then 0 else 1 end + t.end_time) at time zone v_tz,
         t.role_code, t.headcount
    from hr.shift_template t
   cross join lateral (select p_week_start + i as day from generate_series(0, 6) i) d
   where t.org_node_id = p_node and t.archived_at is null
     and extract(isodow from d.day)::int = any (t.weekdays)
  on conflict (template_id, local_date) where template_id is not null and status <> 'cancelled'
  do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- The days template shifts are added for: tomorrow to today + 7, local to the place.
create function hr.template_window(p_node uuid, out from_day date, out to_day date)
language sql stable
set search_path = pg_catalog, core, hr
as $$
  select (now() at time zone hr.node_tz(p_node))::date + 1,
         (now() at time zone hr.node_tz(p_node))::date + 7;
$$;

-- The template shifts in the window that don't exist yet (internal).
create function hr.missing_template_shifts(p_node uuid)
returns table (tenant_id uuid, template_id uuid, day date, start_at timestamptz,
               end_at timestamptz, role_code text, headcount int)
language sql stable
set search_path = pg_catalog, core, hr
as $$
  select t.tenant_id, t.id, d.day,
         (d.day + t.start_time) at time zone hr.node_tz(p_node),
         (d.day + case when t.end_time > t.start_time then 0 else 1 end + t.end_time)
           at time zone hr.node_tz(p_node),
         t.role_code, t.headcount
    from hr.shift_template t
    cross join hr.template_window(p_node) w
    cross join lateral (select w.from_day + i as day
                          from generate_series(0, w.to_day - w.from_day) i) d
   where t.org_node_id = p_node and t.archived_at is null
     and extract(isodow from d.day)::int = any (t.weekdays)
     and not exists (select 1 from hr.shift s
                      where s.template_id = t.id and s.local_date = d.day
                        and s.status <> 'cancelled');
$$;

-- What "Add template shifts" would add, and the drafts already in the window.
create function hr.preview_template_shifts(p_node uuid)
returns table (to_add int, drafts int, from_day date, to_day date)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr
as $$
begin
  perform hr.require('ROSTER', 'modify', p_node);
  return query
  select (select count(*)::int from hr.missing_template_shifts(p_node)),
         (select count(*)::int from hr.shift s
           where s.org_node_id = p_node and s.status = 'draft'
             and s.local_date between w.from_day and w.to_day),
         w.from_day, w.to_day
    from hr.template_window(p_node) w;
end $$;

create function hr.add_template_shifts(p_node uuid) returns int
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_count int;
begin
  perform hr.require('ROSTER', 'modify', p_node);
  insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                        role_code, headcount)
  select m.tenant_id, p_node, m.template_id, m.day, m.start_at, m.end_at, m.role_code,
         m.headcount
    from hr.missing_template_shifts(p_node) m
  on conflict (template_id, local_date) where template_id is not null and status <> 'cancelled'
  do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Discard the unpublished drafts in the window: the shifts are cancelled and anyone
-- assigned is freed. Staff never saw a draft, so no one is notified; published shifts
-- are left alone.
create function hr.discard_drafts(p_node uuid) returns int
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_ids uuid[];
begin
  perform hr.require('ROSTER', 'modify', p_node);
  with c as (
    update hr.shift s set status = 'cancelled'
      from hr.template_window(p_node) w
     where s.org_node_id = p_node and s.status = 'draft'
       and s.local_date between w.from_day and w.to_day
    returning s.id)
  select coalesce(array_agg(id), '{}') into v_ids from c;
  update hr.shift_assignment set status = 'dropped', drop_reason = 'shift_cancelled'
   where shift_id = any (v_ids) and status = 'assigned';
  return cardinality(v_ids);
end $$;

revoke execute on function hr.template_window(uuid), hr.missing_template_shifts(uuid),
  hr.preview_template_shifts(uuid), hr.add_template_shifts(uuid), hr.discard_drafts(uuid)
  from public;
grant execute on function hr.preview_template_shifts(uuid), hr.add_template_shifts(uuid),
  hr.discard_drafts(uuid) to app_rw;

-- migrate:down
drop function hr.discard_drafts(uuid);
drop function hr.add_template_shifts(uuid);
drop function hr.preview_template_shifts(uuid);
drop function hr.missing_template_shifts(uuid);
drop function hr.template_window(uuid);
create or replace function hr.generate_week(p_node uuid, p_week_start date) returns int
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_tz text;
  v_count int;
begin
  perform hr.require('ROSTER', 'modify', p_node);
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    perform hr.fail('INVALID_WEEK', 'weeks start on a Monday');
  end if;
  v_tz := hr.node_tz(p_node);
  insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                        role_code, headcount)
  select t.tenant_id, t.org_node_id, t.id, d.day,
         (d.day + t.start_time) at time zone v_tz,
         (d.day + case when t.end_time > t.start_time then 0 else 1 end + t.end_time) at time zone v_tz,
         t.role_code, t.headcount
    from hr.shift_template t
   cross join lateral (select p_week_start + i as day from generate_series(0, 6) i) d
   where t.org_node_id = p_node and t.archived_at is null
     and extract(isodow from d.day)::int = any (t.weekdays)
  on conflict (template_id, local_date) where template_id is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
drop index hr.shift_template_day;
create unique index shift_template_day on hr.shift (template_id, local_date)
  where template_id is not null;
