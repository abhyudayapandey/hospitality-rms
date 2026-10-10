-- migrate:up
-- Checklists, part 1 (ADR 087): a second signature, and the schedules hotels keep.
--
-- * Sign-off: a checklist template may need someone to check it (file 29 `sign_off`): `up`
--   (the role one level up in the same department, else its head), `department_head` or
--   `role:CODE`; `none` (the default) as today. When the doer finishes, the signer gets a To do
--   item (a `sign_off` task); they sign it off, which marks every step checked, or send it back
--   with a note, which reopens the steps for the doer. Whoever did any of it never signs it.
--   Only the onboarding file sets it (ADR 085: configuration is the platform admin's).
-- * Schedules: `monthly` (days of the month, a day past the month's end falls on its last day)
--   and `nth_weekday` (the 1st to 4th Monday, ...). A step may run only on some weekdays
--   (`days`), so one weekly chart has different steps each day; a round with no step that day
--   is not made.
-- * core.patch_function: change part of a function as it stands, failing loudly when the part
--   isn't there (the later migrations of this release use it too).

create function core.patch_function(p_fn regprocedure, p_from text, p_to text) returns void
language plpgsql
as $$
declare
  v_src text := pg_get_functiondef(p_fn);
begin
  if strpos(v_src, p_from) = 0 then
    raise exception '%: the part to change is not there: %', p_fn, left(p_from, 80);
  end if;
  execute replace(v_src, p_from, p_to);
end $$;
revoke all on function core.patch_function(regprocedure, text, text) from public;

-- ---------------------------------------------------------------------------
-- Schedules
-- ---------------------------------------------------------------------------
select core.patch_function('ops.check_schedule(jsonb)',
$x$    when 'every_n_hours' then$x$,
$x$    when 'monthly', 'nth_weekday' then
      if jsonb_typeof(p_schedule -> 'times') is distinct from 'array'
         or jsonb_array_length(p_schedule -> 'times') not between 1 and 24 then
        perform ops.fail('INVALID_SCHEDULE', 'one to 24 times a day');
      end if;
      for v_t in select * from jsonb_array_elements(p_schedule -> 'times') loop
        if coalesce(v_t #>> '{}', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
          perform ops.fail('INVALID_SCHEDULE', 'times are HH:MM');
        end if;
      end loop;
      if p_schedule ->> 'kind' = 'monthly' and (
           jsonb_typeof(p_schedule -> 'days') is distinct from 'array'
           or jsonb_array_length(p_schedule -> 'days') = 0
           or exists (select 1 from jsonb_array_elements(p_schedule -> 'days') d
                       where jsonb_typeof(d) <> 'number'
                          or (d #>> '{}')::numeric <> trunc((d #>> '{}')::numeric)
                          or (d #>> '{}')::numeric not between 1 and 31)) then
        perform ops.fail('INVALID_SCHEDULE', 'days of the month are 1 to 31');
      end if;
      if p_schedule ->> 'kind' = 'nth_weekday' and (
           jsonb_typeof(p_schedule -> 'weekday') is distinct from 'number'
           or (p_schedule ->> 'weekday')::numeric not in (1, 2, 3, 4, 5, 6, 7)
           or jsonb_typeof(p_schedule -> 'nths') is distinct from 'array'
           or jsonb_array_length(p_schedule -> 'nths') = 0
           or exists (select 1 from jsonb_array_elements(p_schedule -> 'nths') d
                       where jsonb_typeof(d) <> 'number' or (d #>> '{}')::numeric not in (1, 2, 3, 4)))
      then
        perform ops.fail('INVALID_SCHEDULE', 'the 1st to 4th of a weekday (1 Monday to 7 Sunday)');
      end if;
    when 'every_n_hours' then$x$);
select core.patch_function('ops.check_schedule(jsonb)',
$x$'daily, weekly or every_n_hours'$x$,
$x$'daily, weekly, monthly, nth_weekday or every_n_hours'$x$);

select core.patch_function('ops.occurrences(jsonb, text, timestamptz, timestamptz)',
$x$    if p_schedule ->> 'kind' in ('daily', 'weekly') then
      if p_schedule ->> 'kind' = 'daily'
         or (p_schedule -> 'weekdays') @> to_jsonb(extract(isodow from v_day)::int) then$x$,
$x$    if p_schedule ->> 'kind' in ('daily', 'weekly', 'monthly', 'nth_weekday') then
      if p_schedule ->> 'kind' = 'daily'
         or (p_schedule ->> 'kind' = 'weekly'
             and (p_schedule -> 'weekdays') @> to_jsonb(extract(isodow from v_day)::int))
         -- a day past the month's end (the 31st in April) falls on its last day
         or (p_schedule ->> 'kind' = 'monthly'
             and exists (select 1 from jsonb_array_elements_text(p_schedule -> 'days') d
                          where least(d::int, extract(day from date_trunc('month', v_day)
                                                               + interval '1 month - 1 day')::int)
                                = extract(day from v_day)::int))
         or (p_schedule ->> 'kind' = 'nth_weekday'
             and extract(isodow from v_day)::int = (p_schedule ->> 'weekday')::int
             and (p_schedule -> 'nths') @> to_jsonb((extract(day from v_day)::int - 1) / 7 + 1))
      then$x$);

-- a step's weekdays (1 Monday to 7 Sunday); none: every day the checklist runs
select core.patch_function('ops.check_steps(jsonb)',
$x$    if v_s ? 'icon' and$x$,
$x$    if v_s ? 'days' and jsonb_typeof(v_s -> 'days') <> 'null' and (
         jsonb_typeof(v_s -> 'days') <> 'array' or jsonb_array_length(v_s -> 'days') = 0
         or exists (select 1 from jsonb_array_elements(v_s -> 'days') d
                     where jsonb_typeof(d) <> 'number' or (d #>> '{}')::numeric not in (1, 2, 3, 4, 5, 6, 7)))
    then
      perform ops.fail('INVALID_STEPS', 'a step''s days are 1 (Monday) to 7 (Sunday)');
    end if;
    if v_s ? 'icon' and$x$);

-- The steps that run on a day: those without days, and those whose days include it.
create function ops.steps_on(p_steps jsonb, p_day date) returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_agg(s.v order by s.ord), '[]')
    from jsonb_array_elements(p_steps) with ordinality s(v, ord)
   where jsonb_typeof(s.v -> 'days') is distinct from 'array'
      or (s.v -> 'days') @> to_jsonb(extract(isodow from p_day)::int);
$$;

select core.patch_function('ops.tasks_tick(timestamptz)',
$x$    loop
      insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode,$x$,
$x$    loop
      -- a round on a day with none of its steps (a weekly chart's quiet day) is not made
      continue when jsonb_array_length(v_tpl.steps) > 0
        and jsonb_array_length(ops.steps_on(v_tpl.steps,
                                            (v_at at time zone ops.tz_of(v_tpl.org_node_id))::date)) = 0;
      insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode,$x$);
select core.patch_function('ops.tasks_tick(timestamptz)',
$x$perform ops.add_steps(v_t, v_tpl.steps);$x$,
$x$perform ops.add_steps(v_t, ops.steps_on(v_tpl.steps,
                                    (v_at at time zone ops.tz_of(v_tpl.org_node_id))::date));$x$);

-- ---------------------------------------------------------------------------
-- Sign-off
-- ---------------------------------------------------------------------------
alter table ops.checklist_template
  add column sign_off text not null default 'none'
    check (sign_off ~ '^(none|up|department_head|role:[A-Z][A-Z0-9_]*)$');

alter table ops.task
  add column signs_off uuid references ops.task(id),
  add column signed_off_by uuid references core.app_user(id),
  add column signed_off_at timestamptz,
  add column sent_back_note text,
  add column sent_back_at timestamptz;
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check check (kind in (
  'one_off', 'checklist', 'prep', 'expiry', 'receive', 'licence', 'compliance', 'minibar_refill',
  'minibar_bill', 'sign_off'));
alter table ops.task add constraint task_sign_off check ((kind = 'sign_off') = (signs_off is not null));
-- one open sign-off per checklist round
create unique index task_open_sign_off on ops.task (signs_off)
  where kind = 'sign_off' and status in ('open', 'in_progress');

alter table ops.task_step
  add column checked_by uuid references core.app_user(id),
  add column checked_at timestamptz;

-- A job role's rung (catalogue.ts LEVELS, DUTY_LEVEL; a test keeps them equal): the highest any
-- of its duties puts it on, 0 (works) to 4 (above the outlet).
create function ops.role_level(p_tenant uuid, p_role text) returns int
language sql stable security definer
set search_path = pg_catalog, hr
as $$
  select coalesce(max(case split_part(a.duty_code, '@', 1)
                        when 'OWNS_COMPANY_ACCOUNT' then 4 when 'RUNS_AREA' then 4
                        when 'RUNS_COMPANY_HR' then 4 when 'APPROVES_ACCESS' then 4
                        when 'AUDITS_COMPANY' then 4
                        when 'RUNS_OUTLET' then 3 when 'RUNS_CENTRAL_KITCHEN' then 3
                        when 'RUNS_DEPARTMENT' then 2
                        when 'LEADS_SHIFT' then 1 when 'KEEPS_MAIN_STORE' then 1
                        when 'KEEPS_DEPARTMENT_STORE' then 1 when 'KEEPS_CENTRAL_KITCHEN_STORE' then 1
                        else 0 end), 0)
    from hr.job_role_access a
   where a.tenant_id = p_tenant and a.job_role_code = p_role;
$$;

-- Who signs a finished checklist round off: by the rule, someone at work there now first; then
-- the head of its department (or the outlet's managers). Never whoever did any of it. Null:
-- nobody there to sign it.
create function ops.sign_off_signer(p_task ops.task, p_rule text) returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops
as $$
declare
  v_did uuid[] := array_remove(array(select distinct s.done_by from ops.task_step s
                                      where s.task_id = p_task.id and s.done_by is not null)
                               || p_task.completed_by, null);
  v_level int;
  v_user uuid;
begin
  if p_rule = 'up' then
    select ops.role_level(w.tenant_id, w.role_code) into v_level
      from hr.worker w
     where w.tenant_id = p_task.tenant_id and w.owner_user_id = p_task.completed_by
       and w.status = 'active'
     order by ops.works_under(w.owner_user_id, p_task.org_node_id) desc
     limit 1;
    select w.owner_user_id into v_user
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
     where w.tenant_id = p_task.tenant_id and w.status = 'active'
       and w.owner_user_id <> all (v_did)
       and ops.works_under(w.owner_user_id, p_task.org_node_id)
       and ops.role_level(w.tenant_id, w.role_code) > coalesce(v_level, 0)
     order by ops.role_level(w.tenant_id, w.role_code), ops.on_duty(w.owner_user_id, now()) desc,
              u.display_name, w.owner_user_id
     limit 1;
  elsif p_rule like 'role:%' then
    select w.owner_user_id into v_user
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
     where w.tenant_id = p_task.tenant_id and w.status = 'active'
       and w.role_code = substr(p_rule, 6)
       and w.owner_user_id <> all (v_did)
       and ops.works_under(w.owner_user_id,
                           coalesce(core.nearest(p_task.org_node_id, array['outlet', 'site']),
                                    p_task.org_node_id))
     order by ops.on_duty(w.owner_user_id, now()) desc, u.display_name, w.owner_user_id
     limit 1;
  end if;
  if v_user is null then
    v_user := (ops.leads(p_task.org_node_id, p_exclude => v_did))[1];
  end if;
  return v_user;
end $$;

-- A checklist round that needs a second signature, finished: its signer gets a To do item.
create function ops.ask_sign_off() returns trigger
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_rule text := (select t.sign_off from ops.checklist_template t where t.id = new.template_id);
  v_signer uuid;
  v_s ops.task;
begin
  if coalesce(v_rule, 'none') = 'none' then
    return null;
  end if;
  v_signer := ops.sign_off_signer(new, v_rule);
  if v_signer is null then
    return null;
  end if;
  insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode,
                        assignee_user_id, assigned_by, signs_off)
  values (new.tenant_id, new.org_node_id, 'sign_off', left('Sign off: ' || new.title, 200),
          now() + interval '2 hours', 'person', v_signer, new.completed_by, new.id)
  returning * into v_s;
  perform ops.notify_task(v_s, array[v_signer], 'task_assigned', v_s.title,
                          (select display_name || ' finished it' from core.app_user
                            where id = new.completed_by));
  return null;
end $$;
create trigger ask_sign_off after update of status on ops.task
  for each row when (new.kind = 'checklist' and new.status = 'done'
                     and old.status is distinct from 'done' and new.template_id is not null)
  execute function ops.ask_sign_off();

-- The round's signer checks it: every step checked by them.
create function ops.sign_off(p_task uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_s ops.task := ops.task_to_work(p_task);
  v_c ops.task;
  v_me uuid := core.current_user_id();
begin
  if v_s.kind <> 'sign_off' then
    perform ops.fail('INVALID_STATE', 'not a sign-off');
  end if;
  select * into v_c from ops.task where id = v_s.signs_off for update;
  if v_c.status <> 'done' then
    perform ops.fail('INVALID_STATE', 'the checklist is not finished');
  end if;
  if v_me = v_c.completed_by
     or exists (select 1 from ops.task_step where task_id = v_c.id and done_by = v_me) then
    perform ops.fail('OWN_WORK', 'someone else signs off your own work');
  end if;
  update ops.task_step set checked_by = v_me, checked_at = now() where task_id = v_c.id;
  update ops.task set signed_off_by = v_me, signed_off_at = now() where id = v_c.id;
  update ops.task set status = 'done', completed_by = v_me, completed_at = now()
   where id = v_s.id;
end $$;

-- ... or sends it back with what to redo: its steps open again, for whoever did it.
create function ops.send_back(p_task uuid, p_note text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_s ops.task := ops.task_to_work(p_task);
  v_c ops.task;
  v_me uuid := core.current_user_id();
  v_note text := nullif(btrim(p_note), '');
begin
  if v_s.kind <> 'sign_off' then
    perform ops.fail('INVALID_STATE', 'not a sign-off');
  end if;
  if v_note is null then
    perform ops.fail('INVALID_VALUE', 'say what to redo');
  end if;
  select * into v_c from ops.task where id = v_s.signs_off for update;
  if v_c.status <> 'done' then
    perform ops.fail('INVALID_STATE', 'the checklist is not finished');
  end if;
  if v_me = v_c.completed_by
     or exists (select 1 from ops.task_step where task_id = v_c.id and done_by = v_me) then
    perform ops.fail('OWN_WORK', 'someone else signs off your own work');
  end if;
  update ops.task_step set done_at = null, done_by = null where task_id = v_c.id;
  update ops.task
     set status = 'in_progress', completed_by = null, completed_at = null,
         sent_back_note = v_note, sent_back_at = now(),
         assignee_user_id = coalesce(assignee_user_id, v_c.completed_by)
   where id = v_c.id
  returning * into v_c;
  update ops.task
     set status = 'done', completed_by = v_me, completed_at = now(),
         description = concat_ws(E'\n\n', description, 'Sent back: ' || v_note)
   where id = v_s.id;
  perform ops.notify_task(v_c, array[v_c.assignee_user_id], 'task_assigned',
                          'Sent back: ' || v_c.title, v_note);
end $$;

grant execute on function ops.sign_off(uuid), ops.send_back(uuid, text) to app_rw;

-- a sign-off is done by signing off or sending back
select core.patch_function('ops.complete_task(uuid, text)',
$x$if v_t.kind in ('minibar_refill', 'minibar_bill') then$x$,
$x$if v_t.kind in ('minibar_refill', 'minibar_bill', 'sign_off') then$x$);

-- the task page: the sign-off asked, who signed it off or sent it back; a sign-off shows the
-- round's steps, each with who did it and who checked it
select core.patch_function('ops.task_detail(uuid)',
$x$    'can_work', coalesce(ops.can_work(v_t, v_me), false),$x$,
$x$    'sign_off_rule', (select t.sign_off from ops.checklist_template t where t.id = v_t.template_id),
    'signed_off_by_name', (select display_name from core.app_user where id = v_t.signed_off_by),
    'completed_by_name', (select display_name from core.app_user where id = v_t.completed_by),
    'sign_off_task', (select jsonb_build_object(
               'id', s.id, 'status', s.status,
               'assignee_name', (select display_name from core.app_user where id = s.assignee_user_id))
               from ops.task s where s.signs_off = v_t.id and s.status <> 'cancelled'
               order by s.created_at desc limit 1),
    'signs_off_title', (select c.title from ops.task c where c.id = v_t.signs_off),
    'signs_off_done_by', (select display_name from core.app_user u
                           join ops.task c on c.completed_by = u.id where c.id = v_t.signs_off),
    'can_work', coalesce(ops.can_work(v_t, v_me), false),$x$);
select core.patch_function('ops.task_detail(uuid)',
$x$               'done_at', s.done_at,
               'done_by_name', (select display_name from core.app_user where id = s.done_by))
               order by s.position)
               from ops.task_step s where s.task_id = v_t.id), '[]'));$x$,
$x$               'done_at', s.done_at,
               'done_by_name', (select display_name from core.app_user where id = s.done_by),
               'checked_at', s.checked_at,
               'checked_by_name', (select display_name from core.app_user where id = s.checked_by))
               order by s.position)
               from ops.task_step s where s.task_id = coalesce(v_t.signs_off, v_t.id)), '[]'));$x$);

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
select core.patch_function('ops.task_detail(uuid)',
$x$               'done_by_name', (select display_name from core.app_user where id = s.done_by),
               'checked_at', s.checked_at,
               'checked_by_name', (select display_name from core.app_user where id = s.checked_by))
               order by s.position)
               from ops.task_step s where s.task_id = coalesce(v_t.signs_off, v_t.id)), '[]'));$x$,
$x$               'done_by_name', (select display_name from core.app_user where id = s.done_by))
               order by s.position)
               from ops.task_step s where s.task_id = v_t.id), '[]'));$x$);
do $$
declare
  v_src text := pg_get_functiondef('ops.task_detail(uuid)'::regprocedure);
begin
  execute regexp_replace(v_src, E'    ''sign_off_rule''.*?(    ''can_work'')', E'\\1', 's');
end $$;
select core.patch_function('ops.complete_task(uuid, text)',
$x$if v_t.kind in ('minibar_refill', 'minibar_bill', 'sign_off') then$x$,
$x$if v_t.kind in ('minibar_refill', 'minibar_bill') then$x$);
drop function ops.send_back(uuid, text);
drop function ops.sign_off(uuid);
drop trigger ask_sign_off on ops.task;
drop function ops.ask_sign_off();
drop function ops.sign_off_signer(ops.task, text);
drop function ops.role_level(uuid, text);
alter table ops.task_step drop column checked_by, drop column checked_at;
update ops.task set status = 'cancelled' where kind = 'sign_off';
delete from ops.task where kind = 'sign_off';
drop index ops.task_open_sign_off;
alter table ops.task drop constraint task_sign_off;
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check check (kind in (
  'one_off', 'checklist', 'prep', 'expiry', 'receive', 'licence', 'compliance', 'minibar_refill',
  'minibar_bill'));
alter table ops.task drop column signs_off, drop column signed_off_by, drop column signed_off_at,
  drop column sent_back_note, drop column sent_back_at;
alter table ops.checklist_template drop column sign_off;
select core.patch_function('ops.tasks_tick(timestamptz)',
$x$perform ops.add_steps(v_t, ops.steps_on(v_tpl.steps,
                                    (v_at at time zone ops.tz_of(v_tpl.org_node_id))::date));$x$,
$x$perform ops.add_steps(v_t, v_tpl.steps);$x$);
select core.patch_function('ops.tasks_tick(timestamptz)',
$x$      -- a round on a day with none of its steps (a weekly chart's quiet day) is not made
      continue when jsonb_array_length(v_tpl.steps) > 0
        and jsonb_array_length(ops.steps_on(v_tpl.steps,
                                            (v_at at time zone ops.tz_of(v_tpl.org_node_id))::date)) = 0;
$x$, '');
drop function ops.steps_on(jsonb, date);
do $$
begin
  execute regexp_replace(pg_get_functiondef('ops.check_schedule(jsonb)'::regprocedure),
    E'    when ''monthly'', ''nth_weekday'' then.*?(    when ''every_n_hours'' then)', E'\\1', 's');
  execute regexp_replace(pg_get_functiondef('ops.check_steps(jsonb)'::regprocedure),
    E'    if v_s \\? ''days''.*?(    if v_s \\? ''icon'')', E'\\1', 's');
end $$;
select core.patch_function('ops.check_schedule(jsonb)',
$x$'daily, weekly, monthly, nth_weekday or every_n_hours'$x$,
$x$'daily, weekly or every_n_hours'$x$);
do $$
begin
  execute regexp_replace(pg_get_functiondef('ops.occurrences(jsonb, text, timestamptz, timestamptz)'::regprocedure),
    E'    if p_schedule ->> ''kind'' in \\(''daily'', ''weekly'', ''monthly'', ''nth_weekday''\\) then.*?      then\n',
    E'    if p_schedule ->> ''kind'' in (''daily'', ''weekly'') then\n      if p_schedule ->> ''kind'' = ''daily''\n         or (p_schedule -> ''weekdays'') @> to_jsonb(extract(isodow from v_day)::int) then\n', 's');
end $$;
drop function core.patch_function(regprocedure, text, text);
