-- migrate:up
-- A regular compliance job repeats every N months (as before), every week or every 2 weeks on a
-- weekday, or on the nth weekday of each month ("2nd Tuesday", "last Friday") (ADR 116). Its
-- reminder comes 14 days before for a monthly job, 7 for an nth-weekday one, and the day before
-- (3 for every 2 weeks) for a weekly one.

alter table ops.compliance_item
  alter column every_months drop not null,
  drop constraint compliance_item_every_months_check,
  add constraint compliance_item_every_months_check
    check (every_months is null or every_months in (1, 2, 3, 4, 6, 12, 24, 36)),
  add column every_weeks smallint check (every_weeks in (1, 2)),
  add column nth smallint check (nth in (1, 2, 3, 4, -1)),
  add column on_weekday smallint check (on_weekday between 1 and 7),
  add constraint compliance_item_one_rule check (
    (every_months is not null and every_weeks is null and nth is null and on_weekday is null)
    or (every_months is null and every_weeks is not null and nth is null and on_weekday is not null)
    or (every_months is null and every_weeks is null and nth is not null and on_weekday is not null));

-- The nth (or last, -1) ISO weekday of the month p_month falls in.
create function ops.nth_weekday(p_month date, p_nth int, p_dow int) returns date
language sql immutable
set search_path = pg_catalog
as $$
  select case when p_nth > 0
              then first + ((p_dow - extract(isodow from first)::int + 7) % 7) + (p_nth - 1) * 7
              else last - ((extract(isodow from last)::int - p_dow + 7) % 7) end
    from (select date_trunc('month', p_month)::date as first,
                 (date_trunc('month', p_month) + interval '1 month - 1 day')::date as last) m;
$$;

-- When a job is next due once done on p_done_on: months from that day; a weekly one on its
-- weekday after the week (or two) has passed; an nth-weekday one on the next such day after
-- both the day it was done and the day it was due.
create function ops.compliance_next(p_item ops.compliance_item, p_done_on date) returns date
language plpgsql immutable
set search_path = pg_catalog, ops
as $$
declare
  v_base date := greatest(p_done_on, p_item.next_due);
  v_from date;
  v_d date;
begin
  if p_item.every_months is not null then
    return (p_done_on + make_interval(months => p_item.every_months))::date;
  end if;
  if p_item.every_weeks is not null then
    v_from := v_base + (p_item.every_weeks - 1) * 7 + 1;
    return v_from + ((p_item.on_weekday - extract(isodow from v_from)::int + 7) % 7);
  end if;
  v_d := ops.nth_weekday(v_base, p_item.nth, p_item.on_weekday);
  if v_d <= v_base then
    v_d := ops.nth_weekday((date_trunc('month', v_base) + interval '1 month')::date, p_item.nth,
                           p_item.on_weekday);
  end if;
  return v_d;
end $$;

-- How many days ahead its reminder comes.
create function ops.compliance_lead(p_item ops.compliance_item) returns int
language sql immutable
set search_path = pg_catalog
as $$
  select case when p_item.every_weeks = 1 then 1
              when p_item.every_weeks = 2 then 3
              when p_item.nth is not null then 7
              else 14 end;
$$;

select core.patch_function('ops.mark_compliance_done(uuid,date,text[],text)',
  $x$  v_next := (p_done_on + make_interval(months => v_i.every_months))::date;$x$,
  $x$  v_next := ops.compliance_next(v_i, p_done_on);$x$);

select core.patch_function('ops.compliance_tick(timestamp with time zone)',
  $x$       and i.next_due - ops.today_at(i.org_node_id, p_now) <= 14$x$,
  $x$       and i.next_due - ops.today_at(i.org_node_id, p_now) <= ops.compliance_lead(i)$x$);

-- Saving a job with its rule: {"every_months": 6} | {"every_weeks": 1, "on_weekday": 1} |
-- {"nth": 2, "on_weekday": 2}. ops.save_compliance_item does every other check.
create function ops.save_compliance_job(p_id uuid, p_node uuid, p_name text, p_repeat jsonb,
                                        p_next_due date, p_role text, p_needs_proof boolean,
                                        p_doer_role text default null,
                                        p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_months int := (p_repeat ->> 'every_months')::int;
  v_weeks int := (p_repeat ->> 'every_weeks')::int;
  v_nth int := (p_repeat ->> 'nth')::int;
  v_day int := (p_repeat ->> 'on_weekday')::int;
  v_id uuid;
begin
  if jsonb_typeof(p_repeat) is distinct from 'object'
     or num_nonnulls(v_months, v_weeks, v_nth) <> 1
     or (v_months is null) <> (v_day is not null)
     or (v_weeks is not null and v_weeks not in (1, 2))
     or (v_nth is not null and v_nth not in (1, 2, 3, 4, -1))
     or (v_day is not null and v_day not between 1 and 7) then
    perform ops.fail('INVALID_SCHEDULE',
                     'every N months, every week or 2 weeks on a day, or the nth day of each month');
  end if;
  v_id := ops.save_compliance_item(p_id, p_node, p_name, coalesce(v_months, 1), p_next_due, p_role,
                                   p_needs_proof, p_doer_role, p_idempotency_key);
  update ops.compliance_item
     set every_months = v_months, every_weeks = v_weeks, nth = v_nth, on_weekday = v_day
   where id = v_id
     and (every_months, every_weeks, nth, on_weekday)
         is distinct from (v_months, v_weeks, v_nth, v_day);
  return v_id;
end $$;

-- A job's rule as the app reads it, for whoever sees the job.
create function ops.compliance_repeat(p_ids uuid[])
returns table (id uuid, every_months int, every_weeks int, nth int, on_weekday int)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select i.id, i.every_months, i.every_weeks, i.nth, i.on_weekday
    from ops.compliance_item i
   where i.id = any (p_ids) and i.tenant_id = core.my_tenant()
     and (core.can('COMPLIANCE', 'view', i.org_node_id, null)
          or exists (select 1 from ops.task t where t.compliance_item_id = i.id
                        and ops.can_work(t, core.current_user_id())));
$$;

revoke execute on function ops.save_compliance_job(uuid, uuid, text, jsonb, date, text, boolean, text, text),
  ops.compliance_repeat(uuid[]) from public;
grant execute on function ops.save_compliance_job(uuid, uuid, text, jsonb, date, text, boolean, text, text),
  ops.compliance_repeat(uuid[]) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.compliance_repeat(uuid[]);
drop function ops.save_compliance_job(uuid, uuid, text, jsonb, date, text, boolean, text, text);
select core.patch_function('ops.compliance_tick(timestamp with time zone)',
  $x$       and i.next_due - ops.today_at(i.org_node_id, p_now) <= ops.compliance_lead(i)$x$,
  $x$       and i.next_due - ops.today_at(i.org_node_id, p_now) <= 14$x$);
select core.patch_function('ops.mark_compliance_done(uuid,date,text[],text)',
  $x$  v_next := ops.compliance_next(v_i, p_done_on);$x$,
  $x$  v_next := (p_done_on + make_interval(months => v_i.every_months))::date;$x$);
drop function ops.compliance_lead(ops.compliance_item);
drop function ops.compliance_next(ops.compliance_item, date);
drop function ops.nth_weekday(date, int, int);
update ops.compliance_item set every_months = 1, every_weeks = null, nth = null, on_weekday = null
 where every_months is null;
alter table ops.compliance_item
  drop constraint compliance_item_one_rule,
  drop column on_weekday, drop column nth, drop column every_weeks,
  drop constraint compliance_item_every_months_check,
  add constraint compliance_item_every_months_check
    check (every_months in (1, 2, 3, 4, 6, 12, 24, 36)),
  alter column every_months set not null;
