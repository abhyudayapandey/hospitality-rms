-- migrate:up
-- The roster by person (ADR 128, corrected by ADR 130): a manager puts anyone on any shift type
-- of the department. Tapping another role's type (the chief engineer on the technicians' Day)
-- makes a shift of that type for that person (copy_of names the type, so its tile is the one
-- lit), never a hand-made shift beside it. A shift made for one person (copy_of, or a custom
-- one) is cancelled when they are moved off it, so moving someone leaves no empty draft behind.

alter table hr.shift
  add column copy_of uuid references hr.shift_template(id),
  add column personal boolean not null default false;
comment on column hr.shift.copy_of is
  'a shift of another role''s shift type, made for one person (ADR 130)';
comment on column hr.shift.personal is
  'made by a tap on the roster (a type, a copied type or a custom shift); cancelled once nobody is on it';

-- a copied type gets its type's breaks and split, like a shift of the type itself
create or replace function hr.shift_type_from_template() returns trigger
language plpgsql
set search_path = pg_catalog, hr
as $$
declare
  v_t hr.shift_template;
  v_tz text;
begin
  if coalesce(new.template_id, new.copy_of) is null then
    return new;
  end if;
  select * into v_t from hr.shift_template where id = coalesce(new.template_id, new.copy_of);
  v_tz := hr.node_tz(new.org_node_id);
  new.shift_type := v_t.shift_type;
  if v_t.shift_type = 'split' then
    new.split_end_at := (new.local_date + v_t.first_end) at time zone v_tz;
    new.split_start_at := (new.local_date + v_t.second_start) at time zone v_tz;
    new.break_minutes := v_t.break_minutes
      + (extract(epoch from v_t.second_start - v_t.first_end) / 60)::int;
  else
    new.break_minutes := v_t.break_minutes;
  end if;
  return new;
end $$;

-- Puts one person on a shift type for a day, or Off (p_template null). Returns the assignment,
-- or null for Off. Every roster rule runs again (hr.assign); p_accept names the warnings the
-- manager saw and accepted (ADR 019).
create or replace function hr.set_day_shift(p_worker uuid, p_day date, p_template uuid,
                                            p_accept text[] default '{}') returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker;
  v_t hr.shift_template;
  v_node uuid;
  v_shift hr.shift;
  v_a record;
  v_tz text;
begin
  select * into v_w from hr.worker where id = p_worker and tenant_id = core.my_tenant()
     and status = 'active';
  if not found then
    perform hr.fail('INVALID_WORKER', 'worker not found');
  end if;
  if p_template is not null then
    select * into v_t from hr.shift_template
     where id = p_template and tenant_id = v_w.tenant_id and archived_at is null;
    if not found then
      perform hr.fail('NOT_FOUND', 'shift type');
    end if;
    v_node := v_t.org_node_id;
  else
    v_node := v_w.org_node_id;
  end if;
  perform hr.require('ROSTER', 'modify', v_node);
  v_tz := hr.node_tz(v_node);
  if p_day < (now() at time zone v_tz)::date then
    perform hr.fail('PAST_DAY', 'a day that has passed');
  end if;

  -- already on this type that day: nothing to do
  select x.id into v_a from hr.shift_assignment x join hr.shift s on s.id = x.shift_id
   where x.worker_id = v_w.id and x.status = 'assigned' and s.org_node_id = v_node
     and s.local_date = p_day and s.status <> 'cancelled'
     and coalesce(s.template_id, s.copy_of) = p_template
   limit 1;
  if found then
    return v_a.id;
  end if;

  -- off whatever they had that day here (not yet started); a shift made just for them goes
  for v_a in
    select x.id, x.start_at, s.id as shift_id, s.personal
      from hr.shift_assignment x join hr.shift s on s.id = x.shift_id
     where x.worker_id = v_w.id and x.status = 'assigned' and s.org_node_id = v_node
       and s.local_date = p_day and s.status <> 'cancelled'
  loop
    if v_a.start_at <= now() then
      perform hr.fail('SHIFT_STARTED', 'the shift has started');
    end if;
    perform hr.unassign(v_a.id);
    if v_a.personal and not exists (select 1 from hr.shift_assignment
                                     where shift_id = v_a.shift_id and status = 'assigned') then
      update hr.shift set status = 'cancelled' where id = v_a.shift_id;
    end if;
  end loop;
  if p_template is null then
    return null;
  end if;

  if v_t.role_code <> v_w.role_code then
    -- another role's type: a shift of that type, theirs alone
    insert into hr.shift (tenant_id, org_node_id, template_id, copy_of, personal, local_date,
                          start_at, end_at, role_code, headcount)
    values (v_t.tenant_id, v_t.org_node_id, null, v_t.id, true, p_day,
            (p_day + v_t.start_time) at time zone v_tz,
            (p_day + case when v_t.end_time > v_t.start_time then 0 else 1 end + v_t.end_time)
              at time zone v_tz,
            v_w.role_code, 1)
    returning * into v_shift;
    return hr.assign(v_shift.id, v_w.id, p_accept);
  end if;

  select * into v_shift from hr.shift
   where template_id = p_template and local_date = p_day and status <> 'cancelled';
  if not found then
    -- made by this tap: it goes again once nobody is on it
    insert into hr.shift (tenant_id, org_node_id, template_id, personal, local_date, start_at,
                          end_at, role_code, headcount)
    values (v_t.tenant_id, v_t.org_node_id, v_t.id, true, p_day,
            (p_day + v_t.start_time) at time zone v_tz,
            (p_day + case when v_t.end_time > v_t.start_time then 0 else 1 end + v_t.end_time)
              at time zone v_tz,
            v_t.role_code, v_t.headcount)
    returning * into v_shift;
  elsif (select count(*) from hr.shift_assignment
          where shift_id = v_shift.id and status = 'assigned') >= v_shift.headcount then
    -- full: the manager chose one more
    update hr.shift set headcount = headcount + 1 where id = v_shift.id;
  end if;
  return hr.assign(v_shift.id, v_w.id, p_accept);
end $$;

-- a custom shift is made for one person too
select core.patch_function('hr.set_custom_shift(uuid, date, time, time, text[], integer)',
$x$  insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                        role_code, headcount, break_minutes)
  values (v_w.tenant_id, v_w.org_node_id, null, p_day, v_start, v_end, v_w.role_code, 1,
          coalesce(p_break, 0))$x$,
$x$  insert into hr.shift (tenant_id, org_node_id, template_id, personal, local_date, start_at,
                        end_at, role_code, headcount, break_minutes)
  values (v_w.tenant_id, v_w.org_node_id, null, true, p_day, v_start, v_end, v_w.role_code, 1,
          coalesce(p_break, 0))$x$);

-- the screen calls hr.set_day_shift for every type now
drop function hr.set_day_shift_any(uuid, date, uuid, text[]);

-- the person's shift that day names its type, a copied one too
select core.patch_function('hr.roster_day(uuid, date)',
$x$          select s.template_id, s.id as shift_id, s.status, s.start_at, s.end_at,
                 (select t.name from hr.shift_template t where t.id = s.template_id) as shift_name$x$,
$x$          select coalesce(s.template_id, s.copy_of) as template_id, s.id as shift_id, s.status,
                 s.start_at, s.end_at,
                 (select t.name from hr.shift_template t
                   where t.id = coalesce(s.template_id, s.copy_of)) as shift_name$x$);

-- repeating a week repeats a copied type too
select core.patch_function('hr.repeat_pattern(uuid, date, date, date)',
$x$      select x.worker_id, s.template_id, u.display_name$x$,
$x$      select x.worker_id, coalesce(s.template_id, s.copy_of) as template_id, u.display_name$x$);
select core.patch_function('hr.repeat_pattern(uuid, date, date, date)',
$x$       where s.org_node_id = p_node and x.status = 'assigned' and s.template_id is not null$x$,
$x$       where s.org_node_id = p_node and x.status = 'assigned'
         and coalesce(s.template_id, s.copy_of) is not null$x$);
select core.patch_function('hr.repeat_pattern(uuid, date, date, date)',
$x$                    and s.template_id = v_src.template_id and s.local_date = v_day) then$x$,
$x$                    and coalesce(s.template_id, s.copy_of) = v_src.template_id
                    and s.local_date = v_day) then$x$);

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
select core.patch_function('hr.repeat_pattern(uuid, date, date, date)',
$x$                    and coalesce(s.template_id, s.copy_of) = v_src.template_id
                    and s.local_date = v_day) then$x$,
$x$                    and s.template_id = v_src.template_id and s.local_date = v_day) then$x$);
select core.patch_function('hr.repeat_pattern(uuid, date, date, date)',
$x$       where s.org_node_id = p_node and x.status = 'assigned'
         and coalesce(s.template_id, s.copy_of) is not null$x$,
$x$       where s.org_node_id = p_node and x.status = 'assigned' and s.template_id is not null$x$);
select core.patch_function('hr.repeat_pattern(uuid, date, date, date)',
$x$      select x.worker_id, coalesce(s.template_id, s.copy_of) as template_id, u.display_name$x$,
$x$      select x.worker_id, s.template_id, u.display_name$x$);
select core.patch_function('hr.roster_day(uuid, date)',
$x$          select coalesce(s.template_id, s.copy_of) as template_id, s.id as shift_id, s.status,
                 s.start_at, s.end_at,
                 (select t.name from hr.shift_template t
                   where t.id = coalesce(s.template_id, s.copy_of)) as shift_name$x$,
$x$          select s.template_id, s.id as shift_id, s.status, s.start_at, s.end_at,
                 (select t.name from hr.shift_template t where t.id = s.template_id) as shift_name$x$);
select core.patch_function('hr.set_custom_shift(uuid, date, time, time, text[], integer)',
$x$  insert into hr.shift (tenant_id, org_node_id, template_id, personal, local_date, start_at,
                        end_at, role_code, headcount, break_minutes)
  values (v_w.tenant_id, v_w.org_node_id, null, true, p_day, v_start, v_end, v_w.role_code, 1,
          coalesce(p_break, 0))$x$,
$x$  insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                        role_code, headcount, break_minutes)
  values (v_w.tenant_id, v_w.org_node_id, null, p_day, v_start, v_end, v_w.role_code, 1,
          coalesce(p_break, 0))$x$);
create or replace function hr.shift_type_from_template() returns trigger
language plpgsql
set search_path = pg_catalog, hr
as $$
declare
  v_t hr.shift_template;
  v_tz text;
begin
  if new.template_id is null then
    return new;
  end if;
  select * into v_t from hr.shift_template where id = new.template_id;
  v_tz := hr.node_tz(new.org_node_id);
  new.shift_type := v_t.shift_type;
  if v_t.shift_type = 'split' then
    new.split_end_at := (new.local_date + v_t.first_end) at time zone v_tz;
    new.split_start_at := (new.local_date + v_t.second_start) at time zone v_tz;
    new.break_minutes := v_t.break_minutes
      + (extract(epoch from v_t.second_start - v_t.first_end) / 60)::int;
  else
    new.break_minutes := v_t.break_minutes;
  end if;
  return new;
end $$;
create or replace function hr.set_day_shift(p_worker uuid, p_day date, p_template uuid,
                                 p_accept text[] default '{}') returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker;
  v_t hr.shift_template;
  v_node uuid;
  v_shift hr.shift;
  v_a hr.shift_assignment;
  v_tz text;
begin
  select * into v_w from hr.worker where id = p_worker and tenant_id = core.my_tenant()
     and status = 'active';
  if not found then
    perform hr.fail('INVALID_WORKER', 'worker not found');
  end if;
  if p_template is not null then
    select * into v_t from hr.shift_template
     where id = p_template and tenant_id = v_w.tenant_id and archived_at is null;
    if not found then
      perform hr.fail('NOT_FOUND', 'shift type');
    end if;
    v_node := v_t.org_node_id;
  else
    v_node := v_w.org_node_id;
  end if;
  perform hr.require('ROSTER', 'modify', v_node);
  v_tz := hr.node_tz(v_node);
  if p_day < (now() at time zone v_tz)::date then
    perform hr.fail('PAST_DAY', 'a day that has passed');
  end if;

  -- off whatever they had that day here (not yet started)
  for v_a in
    select x.* from hr.shift_assignment x join hr.shift s on s.id = x.shift_id
     where x.worker_id = v_w.id and x.status = 'assigned' and s.org_node_id = v_node
       and s.local_date = p_day and s.status <> 'cancelled'
       and (p_template is null or s.template_id is distinct from p_template)
  loop
    if v_a.start_at <= now() then
      perform hr.fail('SHIFT_STARTED', 'the shift has started');
    end if;
    perform hr.unassign(v_a.id);
  end loop;
  if p_template is null then
    return null;
  end if;

  select * into v_shift from hr.shift
   where template_id = p_template and local_date = p_day and status <> 'cancelled';
  if not found then
    insert into hr.shift (tenant_id, org_node_id, template_id, local_date, start_at, end_at,
                          role_code, headcount)
    values (v_t.tenant_id, v_t.org_node_id, v_t.id, p_day, (p_day + v_t.start_time) at time zone v_tz,
            (p_day + case when v_t.end_time > v_t.start_time then 0 else 1 end + v_t.end_time)
              at time zone v_tz,
            v_t.role_code, v_t.headcount)
    returning * into v_shift;
  elsif not exists (select 1 from hr.shift_assignment
                     where shift_id = v_shift.id and worker_id = v_w.id and status = 'assigned')
        and (select count(*) from hr.shift_assignment
              where shift_id = v_shift.id and status = 'assigned') >= v_shift.headcount then
    -- full: the manager chose one more
    update hr.shift set headcount = headcount + 1 where id = v_shift.id;
  end if;
  return hr.assign(v_shift.id, v_w.id, p_accept);
end $$;
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
revoke execute on function hr.set_day_shift_any(uuid, date, uuid, text[]) from public;
grant execute on function hr.set_day_shift_any(uuid, date, uuid, text[]) to app_rw;
alter table hr.shift drop column personal, drop column copy_of;
