-- migrate:up
-- Who answers for a regular job and who does it (ADR 073). A calendar job's owner role is
-- accountable: it is checked at the outlet, is told when the job comes due and when it is
-- done, and keeps it on Home. Its optional doer role (at the job's place) gets the To do item
-- and marks it done; none means the accountable role does it, as before. Whoever has a
-- licence or compliance To do item, or keeps Compliance there, may hand it to one person who
-- works at that place (ops.reassign_task, which took only deliveries to receive). The
-- Compliance screen's first tab, Needs action, is counted here.

alter table ops.compliance_item add column doer_role text;

-- The accountable people of a job: its owner role at the job's outlet (or whoever covers it).
create function ops.accountable_people(p_item ops.compliance_item) returns uuid[]
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task;
begin
  v_t.tenant_id := p_item.tenant_id;
  v_t.org_node_id := coalesce(core.nearest(p_item.org_node_id, array['outlet', 'site']),
                              p_item.org_node_id);
  v_t.assign_mode := 'job_role';
  v_t.job_role_code := p_item.owner_role;
  return array(select ops.task_people(v_t));
end $$;

-- The job role's name, for the words of a notice.
create function ops.role_name(p_tenant uuid, p_role text) returns text
language sql stable security definer
set search_path = pg_catalog, hr
as $$
  select coalesce((select r.name from hr.job_role r
                    where r.tenant_id = p_tenant and r.code = p_role), p_role);
$$;

-- ---------------------------------------------------------------------------
-- Saving a job: who answers for it (at the outlet) and who does it (at its place)
-- ---------------------------------------------------------------------------
drop function ops.save_compliance_item(uuid, uuid, text, int, date, text, boolean, text);
create function ops.save_compliance_item(p_id uuid, p_node uuid, p_name text, p_every int,
                                         p_next_due date, p_role text, p_needs_proof boolean,
                                         p_doer_role text default null,
                                         p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_me core.app_user := wf.me();
  v_old ops.compliance_item;
  v_id uuid;
  -- the same role as the accountable one is no separate doer
  v_doer text := nullif(nullif(btrim(coalesce(p_doer_role, '')), ''), p_role);
begin
  perform core.require_module('compliance');
  if p_id is null and p_idempotency_key is not null then
    select id into v_id from ops.compliance_item
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_id; end if;
  end if;
  perform hr.require('COMPLIANCE', 'modify', p_node);
  perform ops.check_compliance_place(p_node);
  if p_id is not null then
    select * into v_old from ops.compliance_item
     where id = p_id and tenant_id = v_me.tenant_id and archived_at is null for update;
    if not found then
      perform ops.fail('NOT_FOUND', 'no such job');
    end if;
    perform hr.require('COMPLIANCE', 'modify', v_old.org_node_id);
  end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then
    perform ops.fail('INVALID_TITLE', 'the job needs a name');
  end if;
  if p_every is null or p_every not in (1, 2, 3, 4, 6, 12, 24, 36) then
    perform ops.fail('INVALID_SCHEDULE', 'every 1, 2, 3, 4, 6, 12, 24 or 36 months');
  end if;
  if p_next_due is null then
    perform ops.fail('INVALID_DATES', 'when it is next due');
  end if;
  perform ops.check_compliance_role(coalesce(core.nearest(p_node, array['outlet', 'site']), p_node),
                                    p_role);
  if v_doer is not null then
    perform ops.check_compliance_role(p_node, v_doer);
  end if;
  if p_id is null then
    insert into ops.compliance_item (tenant_id, org_node_id, name, every_months, next_due,
                                     owner_role, doer_role, needs_proof, idempotency_key)
    values (v_me.tenant_id, p_node, btrim(p_name), p_every, p_next_due, p_role, v_doer,
            coalesce(p_needs_proof, false), p_idempotency_key)
    returning id into v_id;
  else
    update ops.compliance_item
       set org_node_id = p_node, name = btrim(p_name), every_months = p_every,
           next_due = p_next_due, owner_role = p_role, doer_role = v_doer,
           needs_proof = coalesce(p_needs_proof, false)
     where id = p_id returning id into v_id;
    -- an open reminder follows the job's new date and who does it
    update ops.task
       set due_at = (p_next_due + time '10:00') at time zone ops.tz_of(p_node),
           job_role_code = coalesce(v_doer, p_role), org_node_id = p_node, title = btrim(p_name)
     where compliance_item_id = p_id and status in ('open', 'in_progress');
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Marking it done tells the accountable people who did it
-- ---------------------------------------------------------------------------
create or replace function ops.mark_compliance_done(p_id uuid, p_done_on date, p_files text[],
                                                    p_note text) returns date
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_me core.app_user := wf.me();
  v_i ops.compliance_item;
  v_next date;
  v_u uuid;
begin
  perform core.require_module('compliance');
  select * into v_i from ops.compliance_item
   where id = p_id and tenant_id = v_me.tenant_id and archived_at is null for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such job');
  end if;
  if not (core.can('COMPLIANCE', 'modify', v_i.org_node_id, null)
          or exists (select 1 from ops.task t
                      where t.compliance_item_id = p_id and t.status in ('open', 'in_progress')
                        and ops.can_work(t, v_me.id))) then
    perform ops.fail('NOT_AUTHORISED', 'COMPLIANCE modify');
  end if;
  if p_done_on is null or p_done_on > ops.today_at(v_i.org_node_id) then
    perform ops.fail('INVALID_DATES', 'when it was done, not later than today');
  end if;
  if v_i.needs_proof and cardinality(coalesce(p_files, '{}')) = 0 then
    perform ops.fail('DOCUMENT_NEEDED', 'add the report or certificate');
  end if;
  perform ops.check_compliance_files(p_files, v_i.org_node_id);
  insert into ops.compliance_done (tenant_id, org_node_id, item_id, due_on, done_on, files, note)
  values (v_i.tenant_id, v_i.org_node_id, p_id, v_i.next_due, p_done_on,
          coalesce(p_files, '{}'), nullif(btrim(p_note), ''));
  v_next := (p_done_on + make_interval(months => v_i.every_months))::date;
  update ops.compliance_item set next_due = v_next where id = p_id;
  update ops.task set status = 'done', completed_by = v_me.id, completed_at = now()
   where compliance_item_id = p_id and status in ('open', 'in_progress');
  foreach v_u in array ops.accountable_people(v_i) loop
    if v_u <> v_me.id then
      perform ops.notify(v_i.tenant_id, v_u, 'compliance_done', 'Done: ' || v_i.name,
                         'By ' || v_me.display_name || ' on '
                           || to_char(p_done_on, 'FMDD Mon YYYY'),
                         '/compliance/calendar/' || v_i.id);
    end if;
  end loop;
  return v_next;
end $$;

-- ---------------------------------------------------------------------------
-- The reminders: the To do item to who does it; the accountable people are told it is due
-- ---------------------------------------------------------------------------
create or replace function ops.compliance_tick(p_now timestamptz default now())
returns table (created int, noticed int)
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_l record;
  v_i ops.compliance_item;
  v_t ops.task;
  v_created int := 0;
  v_noticed int := 0;
  v_left int;
  v_due timestamptz;
  v_doers uuid[];
  v_u uuid;
begin
  for v_l in
    select l.* from ops.licence l
      join core.hierarchy_node n on n.id = l.org_node_id and n.archived_at is null
     where l.archived_at is null and l.expires_on is not null
       and core.tenant_active(l.tenant_id) and core.module_on(l.tenant_id, 'compliance')
       and l.expires_on - ops.today_at(l.org_node_id, p_now) <= 90
     for update of l skip locked
  loop
    v_left := v_l.expires_on - ops.today_at(v_l.org_node_id, p_now);
    v_due := (v_l.expires_on + time '10:00') at time zone ops.tz_of(v_l.org_node_id);
    select * into v_t from ops.task
     where licence_id = v_l.id and status in ('open', 'in_progress');
    if not found then
      insert into ops.task (tenant_id, org_node_id, kind, title, description, due_at, priority,
                            assign_mode, job_role_code, assigned_by, licence_id)
      values (v_l.tenant_id, v_l.org_node_id, 'licence', 'Renew: ' || v_l.name,
              'Expires ' || to_char(v_l.expires_on, 'FMDD Mon YYYY')
                || coalesce(' · ' || v_l.number, ''),
              v_due, 'high', 'job_role', v_l.renewal_role,
              coalesce(v_l.updated_by, v_l.created_by), v_l.id)
      on conflict do nothing
      returning * into v_t;
      if v_t.id is not null then
        v_created := v_created + 1;
        perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'licence_expiring',
                                'Licence expires in ' || v_left || ' days: ' || v_l.name);
        update ops.licence set noticed = 90 where id = v_l.id;
      end if;
    elsif v_left <= 7 and coalesce(v_l.noticed, 90) > 7
       or v_left <= 30 and coalesce(v_l.noticed, 90) > 30 then
      perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'licence_expiring',
                              case when v_left < 0 then 'Licence expired: '
                                   else 'Licence expires in ' || v_left || ' days: ' end
                                || v_l.name);
      update ops.licence set noticed = case when v_left <= 7 then 7 else 30 end
       where id = v_l.id;
      v_noticed := v_noticed + 1;
    end if;
  end loop;

  for v_i in
    select i.* from ops.compliance_item i
      join core.hierarchy_node n on n.id = i.org_node_id and n.archived_at is null
     where i.archived_at is null
       and core.tenant_active(i.tenant_id) and core.module_on(i.tenant_id, 'compliance')
       and i.next_due - ops.today_at(i.org_node_id, p_now) <= 14
       and not exists (select 1 from ops.task t where t.compliance_item_id = i.id
                                                   and t.status in ('open', 'in_progress'))
  loop
    insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode,
                          job_role_code, assigned_by, compliance_item_id)
    values (v_i.tenant_id, v_i.org_node_id, 'compliance', v_i.name,
            (v_i.next_due + time '10:00') at time zone ops.tz_of(v_i.org_node_id),
            'job_role', coalesce(v_i.doer_role, v_i.owner_role),
            coalesce(v_i.updated_by, v_i.created_by), v_i.id)
    on conflict do nothing
    returning * into v_t;
    if v_t.id is not null then
      v_created := v_created + 1;
      v_doers := array(select ops.task_people(v_t));
      perform ops.notify_task(v_t, v_doers, 'compliance_due',
                              'Due ' || to_char(v_i.next_due, 'FMDD Mon') || ': ' || v_i.name);
      -- done by someone else: those who answer for it hear it is due, and with whom
      if v_i.doer_role is not null then
        foreach v_u in array ops.accountable_people(v_i) loop
          if not (v_u = any (v_doers)) then
            perform ops.notify(v_i.tenant_id, v_u, 'compliance_due',
                               'Due ' || to_char(v_i.next_due, 'FMDD Mon') || ': ' || v_i.name
                                 || ' · with the ' || ops.role_name(v_i.tenant_id, v_i.doer_role),
                               null, '/compliance/calendar/' || v_i.id);
          end if;
        end loop;
      end if;
    end if;
  end loop;
  return query select v_created, v_noticed;
end $$;

-- ---------------------------------------------------------------------------
-- The screen's rows: who answers for it, who does it, and who has it now
-- ---------------------------------------------------------------------------
drop function ops.compliance_items(uuid);
create function ops.compliance_items(p_node uuid)
returns table (id uuid, org_node_id uuid, place_name text, name text, every_months int,
               next_due date, days_left int, owner_role text, owner_role_name text,
               needs_proof boolean, last_done date, last_files text[], open_task uuid,
               doer_role text, doer_role_name text, with_name text, outlet_id uuid)
language sql stable security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  select i.id, i.org_node_id, n.name, i.name, i.every_months, i.next_due,
         (i.next_due - ops.today_at(i.org_node_id))::int, i.owner_role,
         coalesce(r.name, i.owner_role), i.needs_proof, d.done_on, d.files, t.id,
         i.doer_role, case when i.doer_role is not null then coalesce(dr.name, i.doer_role) end,
         u.display_name, coalesce(core.nearest(i.org_node_id, array['outlet', 'site']), i.org_node_id)
    from ops.compliance_item i
    join core.hierarchy_node n on n.id = i.org_node_id
    left join hr.job_role r on r.tenant_id = i.tenant_id and r.code = i.owner_role
    left join hr.job_role dr on dr.tenant_id = i.tenant_id and dr.code = i.doer_role
    left join lateral (select x.done_on, x.files from ops.compliance_done x
                        where x.item_id = i.id order by x.done_on desc, x.created_at desc
                        limit 1) d on true
    left join lateral (select x.id, x.assignee_user_id from ops.task x
                        where x.compliance_item_id = i.id and x.status in ('open', 'in_progress')
                        order by x.due_at limit 1) t on true
    left join core.app_user u on u.id = t.assignee_user_id
   where i.tenant_id = core.my_tenant() and i.archived_at is null
     and core.module_on(i.tenant_id, 'compliance')
     and core.can('COMPLIANCE', 'view', i.org_node_id, null)
     and (p_node is null or n.path operator(extensions.<@)
                            (select p.path from core.hierarchy_node p where p.id = p_node))
   order by i.next_due, n.name, i.name;
$$;

-- The tabs' counts: Needs action is the licences within 90 days and the jobs within 14
-- (Home's card); Licences and Regular jobs are all of each.
drop function ops.compliance_counts(uuid);
create function ops.compliance_counts(p_node uuid)
returns table (licences int, expiring int, items int, overdue int, needs_action int)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select (select count(*)::int from ops.licences(p_node)),
         (select count(*)::int from ops.licences(p_node) where days_left <= 90),
         (select count(*)::int from ops.compliance_items(p_node)),
         (select count(*)::int from ops.compliance_items(p_node) where days_left < 0),
         (select count(*)::int from ops.licences(p_node) where days_left <= 90)
           + (select count(*)::int from ops.compliance_items(p_node) where days_left <= 14);
$$;

-- What a To do item about a licence or a job points at, and whether the caller may hand it on.
drop function ops.compliance_task(uuid);
create function ops.compliance_task(p_task uuid)
returns table (licence_id uuid, item_id uuid, name text, place_name text, number text,
               authority text, expires_on date, next_due date, every_months int,
               needs_proof boolean, can_act boolean, can_hand_on boolean,
               owner_role_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task;
  v_may boolean;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind in ('licence', 'compliance');
  if not found or not (core.can('TASKS', 'view', v_t.org_node_id, null)
                       or ops.can_work(v_t, core.current_user_id())
                       or core.can('COMPLIANCE', 'view', v_t.org_node_id, null)) then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  v_may := coalesce(v_t.status in ('open', 'in_progress')
                    and (ops.can_work(v_t, core.current_user_id())
                         or core.can('COMPLIANCE', 'modify', v_t.org_node_id, null)), false);
  return query
    select l.id, i.id, coalesce(l.name, i.name), n.name, l.number, l.authority, l.expires_on,
           i.next_due, i.every_months, coalesce(i.needs_proof, true), v_may, v_may,
           case when i.id is not null then ops.role_name(i.tenant_id, i.owner_role) end
      from (select 1) one
      left join ops.licence l on l.id = v_t.licence_id
      left join ops.compliance_item i on i.id = v_t.compliance_item_id
      join core.hierarchy_node n on n.id = v_t.org_node_id;
end $$;

-- ---------------------------------------------------------------------------
-- Handing a To do item on
-- ---------------------------------------------------------------------------

-- May the caller hand this task on? A delivery to receive: its department head (TASKS
-- modify, ADR 051). A licence renewal or a regular job: whoever has it, or a keeper there.
-- Never null (ops.can_work is null for someone outside an unassigned task's pool).
create function ops.may_hand_on(p_task ops.task) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select coalesce(case p_task.kind
           when 'receive' then core.can('TASKS', 'modify', p_task.org_node_id, null)
           when 'licence' then ops.can_work(p_task, core.current_user_id())
                               or core.can('COMPLIANCE', 'modify', p_task.org_node_id, null)
           when 'compliance' then ops.can_work(p_task, core.current_user_id())
                                  or core.can('COMPLIANCE', 'modify', p_task.org_node_id, null)
           else false end, false);
$$;

create or replace function ops.reassign_task(p_task uuid, p_user uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant()
     and kind in ('receive', 'licence', 'compliance') for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  if v_t.kind = 'receive' then
    perform hr.require('TASKS', 'modify', v_t.org_node_id);
  else
    perform core.require_module('compliance');
    if not ops.may_hand_on(v_t) then
      perform ops.fail('NOT_AUTHORISED', 'not yours to hand on');
    end if;
  end if;
  if v_t.status not in ('open', 'in_progress') then
    perform ops.fail('INVALID_STATE', 'the task is done');
  end if;
  if p_user is null or not ops.works_under(p_user, v_t.org_node_id) then
    perform ops.fail('INVALID_ASSIGNEE', 'they do not work at this place');
  end if;
  update ops.task
     set assignee_user_id = p_user, assigned_by = core.current_user_id(), assign_mode = 'person'
   where id = v_t.id returning * into v_t;
  perform ops.notify_task(v_t, array[p_user], 'task_assigned', 'New task: ' || v_t.title);
end $$;

-- The people a compliance To do item may be handed to: everyone who works at its place.
create function ops.hand_on_people(p_task uuid)
returns table (user_id uuid, name text, job_role text, place_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind in ('licence', 'compliance');
  if not found or not ops.may_hand_on(v_t) then
    perform ops.fail('NOT_AUTHORISED', 'not yours to hand on');
  end if;
  return query
    select u.id, u.display_name, r.name, h.name
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node n on n.id = v_t.org_node_id and n.tenant_id = w.tenant_id
      left join hr.job_role r on r.tenant_id = w.tenant_id and r.code = w.role_code
     where w.status = 'active' and h.path operator(extensions.<@) n.path
     order by u.display_name;
end $$;

revoke execute on function ops.accountable_people(ops.compliance_item),
  ops.role_name(uuid, text), ops.may_hand_on(ops.task),
  ops.save_compliance_item(uuid, uuid, text, int, date, text, boolean, text, text),
  ops.compliance_items(uuid), ops.compliance_counts(uuid), ops.compliance_task(uuid),
  ops.hand_on_people(uuid) from public;
grant execute on function
  ops.save_compliance_item(uuid, uuid, text, int, date, text, boolean, text, text),
  ops.compliance_items(uuid), ops.compliance_counts(uuid), ops.compliance_task(uuid),
  ops.hand_on_people(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.hand_on_people(uuid);
create or replace function ops.reassign_task(p_task uuid, p_user uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind = 'receive' for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  perform hr.require('TASKS', 'modify', v_t.org_node_id);
  if v_t.status not in ('open', 'in_progress') then
    perform ops.fail('INVALID_STATE', 'the task is done');
  end if;
  if p_user is null or not ops.works_under(p_user, v_t.org_node_id) then
    perform ops.fail('INVALID_ASSIGNEE', 'they do not work at this place');
  end if;
  update ops.task
     set assignee_user_id = p_user, assigned_by = core.current_user_id(), assign_mode = 'person'
   where id = v_t.id returning * into v_t;
  perform ops.notify_task(v_t, array[p_user], 'task_assigned', 'New task: ' || v_t.title);
end $$;
drop function ops.may_hand_on(ops.task);
drop function ops.compliance_task(uuid);
create function ops.compliance_task(p_task uuid)
returns table (licence_id uuid, item_id uuid, name text, place_name text, number text,
               authority text, expires_on date, next_due date, every_months int,
               needs_proof boolean, can_act boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind in ('licence', 'compliance');
  if not found or not (core.can('TASKS', 'view', v_t.org_node_id, null)
                       or ops.can_work(v_t, core.current_user_id())
                       or core.can('COMPLIANCE', 'view', v_t.org_node_id, null)) then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  return query
    select l.id, i.id, coalesce(l.name, i.name), n.name, l.number, l.authority, l.expires_on,
           i.next_due, i.every_months, coalesce(i.needs_proof, true),
           v_t.status in ('open', 'in_progress')
             and (ops.can_work(v_t, core.current_user_id())
                  or core.can('COMPLIANCE', 'modify', v_t.org_node_id, null))
      from (select 1) one
      left join ops.licence l on l.id = v_t.licence_id
      left join ops.compliance_item i on i.id = v_t.compliance_item_id
      join core.hierarchy_node n on n.id = v_t.org_node_id;
end $$;
drop function ops.compliance_counts(uuid);
create function ops.compliance_counts(p_node uuid)
returns table (licences int, expiring int, items int, overdue int)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select (select count(*)::int from ops.licences(p_node)),
         (select count(*)::int from ops.licences(p_node) where days_left <= 90),
         (select count(*)::int from ops.compliance_items(p_node)),
         (select count(*)::int from ops.compliance_items(p_node) where days_left < 0);
$$;
drop function ops.compliance_items(uuid);
create function ops.compliance_items(p_node uuid)
returns table (id uuid, org_node_id uuid, place_name text, name text, every_months int,
               next_due date, days_left int, owner_role text, owner_role_name text,
               needs_proof boolean, last_done date, last_files text[], open_task uuid)
language sql stable security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  select i.id, i.org_node_id, n.name, i.name, i.every_months, i.next_due,
         (i.next_due - ops.today_at(i.org_node_id))::int, i.owner_role,
         coalesce(r.name, i.owner_role), i.needs_proof, d.done_on, d.files,
         (select t.id from ops.task t where t.compliance_item_id = i.id
                                         and t.status in ('open', 'in_progress')
           order by t.due_at limit 1)
    from ops.compliance_item i
    join core.hierarchy_node n on n.id = i.org_node_id
    left join hr.job_role r on r.tenant_id = i.tenant_id and r.code = i.owner_role
    left join lateral (select x.done_on, x.files from ops.compliance_done x
                        where x.item_id = i.id order by x.done_on desc, x.created_at desc
                        limit 1) d on true
   where i.tenant_id = core.my_tenant() and i.archived_at is null
     and core.module_on(i.tenant_id, 'compliance')
     and core.can('COMPLIANCE', 'view', i.org_node_id, null)
     and (p_node is null or n.path operator(extensions.<@)
                            (select p.path from core.hierarchy_node p where p.id = p_node))
   order by i.next_due, n.name, i.name;
$$;
grant execute on function ops.compliance_items(uuid), ops.compliance_counts(uuid),
  ops.compliance_task(uuid) to app_rw;
drop function ops.save_compliance_item(uuid, uuid, text, int, date, text, boolean, text, text);
create function ops.save_compliance_item(p_id uuid, p_node uuid, p_name text, p_every int,
                                         p_next_due date, p_role text, p_needs_proof boolean,
                                         p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_me core.app_user := wf.me();
  v_old ops.compliance_item;
  v_id uuid;
begin
  perform core.require_module('compliance');
  if p_id is null and p_idempotency_key is not null then
    select id into v_id from ops.compliance_item
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_id; end if;
  end if;
  perform hr.require('COMPLIANCE', 'modify', p_node);
  perform ops.check_compliance_place(p_node);
  if p_id is not null then
    select * into v_old from ops.compliance_item
     where id = p_id and tenant_id = v_me.tenant_id and archived_at is null for update;
    if not found then
      perform ops.fail('NOT_FOUND', 'no such job');
    end if;
    perform hr.require('COMPLIANCE', 'modify', v_old.org_node_id);
  end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then
    perform ops.fail('INVALID_TITLE', 'the job needs a name');
  end if;
  if p_every is null or p_every not in (1, 2, 3, 4, 6, 12, 24, 36) then
    perform ops.fail('INVALID_SCHEDULE', 'every 1, 2, 3, 4, 6, 12, 24 or 36 months');
  end if;
  if p_next_due is null then
    perform ops.fail('INVALID_DATES', 'when it is next due');
  end if;
  perform ops.check_compliance_role(p_node, p_role);
  if p_id is null then
    insert into ops.compliance_item (tenant_id, org_node_id, name, every_months, next_due,
                                     owner_role, needs_proof, idempotency_key)
    values (v_me.tenant_id, p_node, btrim(p_name), p_every, p_next_due, p_role,
            coalesce(p_needs_proof, false), p_idempotency_key)
    returning id into v_id;
  else
    update ops.compliance_item
       set org_node_id = p_node, name = btrim(p_name), every_months = p_every,
           next_due = p_next_due, owner_role = p_role,
           needs_proof = coalesce(p_needs_proof, false)
     where id = p_id returning id into v_id;
    update ops.task
       set due_at = (p_next_due + time '10:00') at time zone ops.tz_of(p_node),
           job_role_code = p_role, org_node_id = p_node, title = btrim(p_name)
     where compliance_item_id = p_id and status in ('open', 'in_progress');
  end if;
  return v_id;
end $$;
grant execute on function
  ops.save_compliance_item(uuid, uuid, text, int, date, text, boolean, text) to app_rw;
create or replace function ops.mark_compliance_done(p_id uuid, p_done_on date, p_files text[],
                                         p_note text) returns date
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_me core.app_user := wf.me();
  v_i ops.compliance_item;
  v_next date;
begin
  perform core.require_module('compliance');
  select * into v_i from ops.compliance_item
   where id = p_id and tenant_id = v_me.tenant_id and archived_at is null for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such job');
  end if;
  if not (core.can('COMPLIANCE', 'modify', v_i.org_node_id, null)
          or exists (select 1 from ops.task t
                      where t.compliance_item_id = p_id and t.status in ('open', 'in_progress')
                        and ops.can_work(t, v_me.id))) then
    perform ops.fail('NOT_AUTHORISED', 'COMPLIANCE modify');
  end if;
  if p_done_on is null or p_done_on > ops.today_at(v_i.org_node_id) then
    perform ops.fail('INVALID_DATES', 'when it was done, not later than today');
  end if;
  if v_i.needs_proof and cardinality(coalesce(p_files, '{}')) = 0 then
    perform ops.fail('DOCUMENT_NEEDED', 'add the report or certificate');
  end if;
  perform ops.check_compliance_files(p_files, v_i.org_node_id);
  insert into ops.compliance_done (tenant_id, org_node_id, item_id, due_on, done_on, files, note)
  values (v_i.tenant_id, v_i.org_node_id, p_id, v_i.next_due, p_done_on,
          coalesce(p_files, '{}'), nullif(btrim(p_note), ''));
  v_next := (p_done_on + make_interval(months => v_i.every_months))::date;
  update ops.compliance_item set next_due = v_next where id = p_id;
  update ops.task set status = 'done', completed_by = v_me.id, completed_at = now()
   where compliance_item_id = p_id and status in ('open', 'in_progress');
  return v_next;
end $$;
create or replace function ops.compliance_tick(p_now timestamptz default now())
returns table (created int, noticed int)
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_l record;
  v_i record;
  v_t ops.task;
  v_created int := 0;
  v_noticed int := 0;
  v_left int;
  v_due timestamptz;
begin
  for v_l in
    select l.* from ops.licence l
      join core.hierarchy_node n on n.id = l.org_node_id and n.archived_at is null
     where l.archived_at is null and l.expires_on is not null
       and core.tenant_active(l.tenant_id) and core.module_on(l.tenant_id, 'compliance')
       and l.expires_on - ops.today_at(l.org_node_id, p_now) <= 90
     for update of l skip locked
  loop
    v_left := v_l.expires_on - ops.today_at(v_l.org_node_id, p_now);
    v_due := (v_l.expires_on + time '10:00') at time zone ops.tz_of(v_l.org_node_id);
    select * into v_t from ops.task
     where licence_id = v_l.id and status in ('open', 'in_progress');
    if not found then
      insert into ops.task (tenant_id, org_node_id, kind, title, description, due_at, priority,
                            assign_mode, job_role_code, assigned_by, licence_id)
      values (v_l.tenant_id, v_l.org_node_id, 'licence', 'Renew: ' || v_l.name,
              'Expires ' || to_char(v_l.expires_on, 'FMDD Mon YYYY')
                || coalesce(' · ' || v_l.number, ''),
              v_due, 'high', 'job_role', v_l.renewal_role,
              coalesce(v_l.updated_by, v_l.created_by), v_l.id)
      on conflict do nothing
      returning * into v_t;
      if v_t.id is not null then
        v_created := v_created + 1;
        perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'licence_expiring',
                                'Licence expires in ' || v_left || ' days: ' || v_l.name);
        update ops.licence set noticed = 90 where id = v_l.id;
      end if;
    elsif v_left <= 7 and coalesce(v_l.noticed, 90) > 7
       or v_left <= 30 and coalesce(v_l.noticed, 90) > 30 then
      perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'licence_expiring',
                              case when v_left < 0 then 'Licence expired: '
                                   else 'Licence expires in ' || v_left || ' days: ' end
                                || v_l.name);
      update ops.licence set noticed = case when v_left <= 7 then 7 else 30 end
       where id = v_l.id;
      v_noticed := v_noticed + 1;
    end if;
  end loop;

  for v_i in
    select i.* from ops.compliance_item i
      join core.hierarchy_node n on n.id = i.org_node_id and n.archived_at is null
     where i.archived_at is null
       and core.tenant_active(i.tenant_id) and core.module_on(i.tenant_id, 'compliance')
       and i.next_due - ops.today_at(i.org_node_id, p_now) <= 14
       and not exists (select 1 from ops.task t where t.compliance_item_id = i.id
                                                   and t.status in ('open', 'in_progress'))
  loop
    insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode,
                          job_role_code, assigned_by, compliance_item_id)
    values (v_i.tenant_id, v_i.org_node_id, 'compliance', v_i.name,
            (v_i.next_due + time '10:00') at time zone ops.tz_of(v_i.org_node_id),
            'job_role', v_i.owner_role, coalesce(v_i.updated_by, v_i.created_by), v_i.id)
    on conflict do nothing
    returning * into v_t;
    if v_t.id is not null then
      v_created := v_created + 1;
      perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'compliance_due',
                              'Due ' || to_char(v_i.next_due, 'FMDD Mon') || ': ' || v_i.name);
    end if;
  end loop;
  return query select v_created, v_noticed;
end $$;
drop function ops.role_name(uuid, text);
drop function ops.accountable_people(ops.compliance_item);
alter table ops.compliance_item drop column doer_role;
