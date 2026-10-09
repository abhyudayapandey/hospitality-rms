-- migrate:up
-- Logbook & handover (ADR 089), the Logbook block (ADR 085, domain LOGBOOK).
--
-- An entry is written at a department or the outlet by whoever holds LOGBOOK modify there
-- (staff, supervisors and heads at their department, the outlet's managers):
-- * a handover: to the next shift of a department of the same outlet (whoever is on shift
--   there), a job role there, or a named person. Until someone it is for acknowledges it, it is
--   a To do item (a `handover` task at that place; acknowledging finishes it). The writer and
--   whoever reads the logbook there see who acknowledged it and when, or that nobody has yet.
-- * a log: a note that holds until a time ("valid till"), shown to whoever reads the logbook.
-- Front office, security and restaurant logbooks are this one block. Entries are never deleted
-- or edited; a log can be taken down early (archived).

create table ops.log_entry (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- where it was written
  kind text not null check (kind in ('handover', 'log')),
  body text not null check (length(btrim(body)) between 1 and 2000),
  valid_till timestamptz,
  task_id uuid references ops.task(id),                          -- a handover's To do item
  archived_at timestamptz,
  idempotency_key text,
  check ((kind = 'log') = (valid_till is not null)),
  check (kind = 'log' or task_id is not null)
);
select core.add_standard_columns('ops.log_entry');
create index log_entry_node on ops.log_entry (org_node_id, created_at desc);
alter table ops.log_entry add constraint log_entry_idem
  unique (tenant_id, created_by, idempotency_key);

alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check check (kind in (
  'one_off', 'checklist', 'prep', 'expiry', 'receive', 'licence', 'compliance', 'minibar_refill',
  'minibar_bill', 'sign_off', 'handover'));

-- Write a handover (p_to: {"mode": "on_shift"}, {"mode": "job_role", "role": ...} or
-- {"mode": "person", "user_id": ...} at p_to_place, a department or the outlet itself) or a log
-- (p_valid_till). Returns the entry's id.
create function ops.write_log(p_place uuid, p_kind text, p_body text, p_to_place uuid,
                              p_to jsonb, p_valid_till timestamptz,
                              p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_me core.app_user := wf.me();
  v_id uuid;
  v_outlet uuid := core.nearest(p_place, array['outlet']);
  v_t ops.task;
  v_body text := btrim(coalesce(p_body, ''));
begin
  if p_idempotency_key is not null then
    select e.id into v_id from ops.log_entry e
     where e.tenant_id = v_me.tenant_id and e.created_by = v_me.id
       and e.idempotency_key = p_idempotency_key;
    if v_id is not null then
      return v_id;
    end if;
  end if;
  if not exists (select 1 from core.hierarchy_node n
                  where n.id = p_place and n.tenant_id = v_me.tenant_id and n.type = 'org'
                    and n.kind in ('outlet', 'department') and n.archived_at is null)
     or not core.can('LOGBOOK', 'modify', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'LOGBOOK modify');
  end if;
  if length(v_body) not between 1 and 2000 then
    perform ops.fail('INVALID_VALUE', 'what to hand over or log, up to 2,000 characters');
  end if;
  if p_kind = 'log' then
    if p_valid_till is null or p_valid_till <= now() then
      perform ops.fail('INVALID_VALUE', 'a log holds until a time to come');
    end if;
    insert into ops.log_entry (tenant_id, org_node_id, kind, body, valid_till, idempotency_key)
    values (v_me.tenant_id, p_place, 'log', v_body, p_valid_till, p_idempotency_key)
    returning id into v_id;
    return v_id;
  end if;
  if p_kind is distinct from 'handover' then
    perform ops.fail('INVALID_VALUE', 'a handover or a log');
  end if;
  -- the handover goes to a place of the same outlet
  if not exists (select 1 from core.hierarchy_node n
                  where n.id = p_to_place and n.tenant_id = v_me.tenant_id and n.type = 'org'
                    and n.kind in ('outlet', 'department') and n.archived_at is null
                    and core.nearest(n.id, array['outlet']) = v_outlet) then
    perform ops.fail('INVALID_ASSIGNEE', 'a place of this outlet');
  end if;
  perform ops.check_assign(p_to_place, p_to);
  insert into ops.task (tenant_id, org_node_id, kind, title, description, due_at, assign_mode,
                        job_role_code, assignee_user_id, assigned_by)
  values (v_me.tenant_id, p_to_place, 'handover',
          left(format('Handover from %s: %s', v_me.display_name, v_body), 200), v_body,
          now() + interval '2 hours', p_to ->> 'mode', p_to ->> 'role',
          (p_to ->> 'user_id')::uuid, v_me.id)
  returning * into v_t;
  insert into ops.log_entry (tenant_id, org_node_id, kind, body, task_id, idempotency_key)
  values (v_me.tenant_id, p_place, 'handover', v_body, v_t.id, p_idempotency_key)
  returning id into v_id;
  perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'task_assigned',
                          'Handover from ' || v_me.display_name, left(v_body, 200));
  return v_id;
end $$;

-- Whoever a handover is for acknowledges it: its To do item is done.
create function ops.acknowledge_handover(p_task uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task := ops.task_to_work(p_task);
begin
  if v_t.kind <> 'handover' then
    perform ops.fail('INVALID_STATE', 'not a handover');
  end if;
  update ops.task set status = 'done', completed_by = core.current_user_id(), completed_at = now()
   where id = v_t.id;
end $$;

-- a handover is done by acknowledging it
select core.patch_function('ops.complete_task(uuid, text)',
$x$if v_t.kind in ('minibar_refill', 'minibar_bill', 'sign_off') then$x$,
$x$if v_t.kind in ('minibar_refill', 'minibar_bill', 'sign_off', 'handover') then$x$);

-- Take a log down before its time (whoever may write there).
create function ops.take_down_log(p_entry uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_e ops.log_entry;
begin
  select * into v_e from ops.log_entry
   where id = p_entry and tenant_id = core.my_tenant() and archived_at is null for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such entry');
  end if;
  if not core.can('LOGBOOK', 'modify', v_e.org_node_id, null) then
    perform ops.fail('NOT_AUTHORISED', 'LOGBOOK modify');
  end if;
  if v_e.kind <> 'log' then
    perform ops.fail('INVALID_STATE', 'a handover stays');
  end if;
  update ops.log_entry set archived_at = now() where id = v_e.id;
end $$;

-- The places whose logbook I may read (and whether I may write there), by outlet.
create function ops.logbook_places()
returns table (place_id uuid, place text, kind text, outlet_id uuid, outlet text,
               can_write boolean)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select n.id, n.name, n.kind, o.id, o.name, core.can('LOGBOOK', 'modify', n.id, null)
    from core.hierarchy_node n
    join core.hierarchy_node o on o.id = core.nearest(n.id, array['outlet'])
   where n.tenant_id = core.my_tenant() and n.type = 'org'
     and n.kind in ('outlet', 'department') and n.archived_at is null
     and core.can('LOGBOOK', 'view', n.id, null)
   order by o.name, (n.kind = 'outlet') desc,
            coalesce(array_position(array['kitchen', 'service', 'housekeeping', 'other'],
                                    n.department_type), 9), n.name;
$$;

-- A place's logbook: its logs still holding, and its handovers of the last p_days days, newest
-- first, each with who it is for and who acknowledged it; for whoever reads the logbook there,
-- or wrote the entry.
create function ops.logbook(p_place uuid, p_days int default 2)
returns table (id uuid, kind text, body text, written_at timestamptz, written_by text,
               mine boolean, valid_till timestamptz, to_place text, to_who text,
               acknowledged_at timestamptz, acknowledged_by text, task_id uuid,
               can_take_down boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
#variable_conflict use_column
begin
  if not core.can('LOGBOOK', 'view', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'LOGBOOK view');
  end if;
  return query
    select e.id, e.kind, e.body, e.created_at,
           (select display_name from core.app_user where id = e.created_by),
           e.created_by = core.current_user_id(), e.valid_till,
           (select name from core.hierarchy_node where id = t.org_node_id),
           case t.assign_mode
             when 'person' then (select display_name from core.app_user
                                  where id = t.assignee_user_id)
             when 'job_role' then (select r.name from hr.job_role r
                                    where r.tenant_id = t.tenant_id and r.code = t.job_role_code)
             when 'on_shift' then 'Whoever is on shift'
           end,
           case when t.status = 'done' then t.completed_at end,
           case when t.status = 'done' then (select display_name from core.app_user
                                              where id = t.completed_by) end,
           e.task_id,
           e.kind = 'log' and core.can('LOGBOOK', 'modify', e.org_node_id, null)
      from ops.log_entry e
      left join ops.task t on t.id = e.task_id
     where e.org_node_id = p_place and e.tenant_id = core.my_tenant()
       and e.archived_at is null
       and ((e.kind = 'log' and e.valid_till > now())
            or (e.kind = 'handover' and e.created_at > now() - make_interval(days => p_days)))
     order by e.created_at desc;
end $$;

-- Whom a handover written at p_place may go to: the places of its outlet, and the people who
-- work there with their job roles. For whoever may write there.
create function ops.logbook_targets(p_place uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
declare
  v_outlet uuid := core.nearest(p_place, array['outlet']);
begin
  if v_outlet is null or not core.can('LOGBOOK', 'modify', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'LOGBOOK modify');
  end if;
  return jsonb_build_object(
    'places', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name)
                                         order by (n.kind = 'outlet') desc, n.name)
                          from core.hierarchy_node n
                          join core.hierarchy_node o on o.id = v_outlet
                         where n.tenant_id = o.tenant_id and n.type = 'org'
                           and n.kind in ('outlet', 'department') and n.archived_at is null
                           and n.path operator(extensions.<@) o.path), '[]'),
    'people', coalesce((select jsonb_agg(jsonb_build_object(
                                 'id', u.id, 'name', u.display_name, 'role', w.role_code,
                                 'role_name', r.name, 'place_id', w.org_node_id)
                                 order by u.display_name)
                          from hr.worker w
                          join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
                          join core.hierarchy_node h on h.id = w.org_node_id
                          join core.hierarchy_node o on o.id = v_outlet
                          left join hr.job_role r on r.tenant_id = w.tenant_id
                                                 and r.code = w.role_code
                         where w.status = 'active' and w.tenant_id = o.tenant_id
                           and h.path operator(extensions.<@) o.path), '[]'));
end $$;

-- the handover's page says where it came from
select core.patch_function('ops.task_detail(uuid)',
$x$    'can_work', coalesce(ops.can_work(v_t, v_me), false),$x$,
$x$    'handover_from', (select jsonb_build_object(
               'place', (select name from core.hierarchy_node where id = e.org_node_id),
               'by', (select display_name from core.app_user where id = e.created_by),
               'at', e.created_at)
               from ops.log_entry e where e.task_id = v_t.id),
    'can_work', coalesce(ops.can_work(v_t, v_me), false),$x$);

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.log_entry', 'LOGBOOK', 'org', true);
select core.apply_domain_rls('ops.log_entry');
select audit.enable('ops.log_entry');

revoke execute on function
  ops.write_log(uuid, text, text, uuid, jsonb, timestamptz, text), ops.acknowledge_handover(uuid),
  ops.take_down_log(uuid), ops.logbook_places(), ops.logbook(uuid, int),
  ops.logbook_targets(uuid)
  from public, platform_loader;
grant execute on function
  ops.write_log(uuid, text, text, uuid, jsonb, timestamptz, text), ops.acknowledge_handover(uuid),
  ops.take_down_log(uuid), ops.logbook_places(), ops.logbook(uuid, int),
  ops.logbook_targets(uuid)
  to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
do $$
begin
  execute regexp_replace(pg_get_functiondef('ops.task_detail(uuid)'::regprocedure),
    E'    ''handover_from''.*?(    ''can_work'')', E'\\1', 's');
end $$;
select core.patch_function('ops.complete_task(uuid, text)',
$x$if v_t.kind in ('minibar_refill', 'minibar_bill', 'sign_off', 'handover') then$x$,
$x$if v_t.kind in ('minibar_refill', 'minibar_bill', 'sign_off') then$x$);
drop function ops.logbook_targets(uuid);
drop function ops.logbook(uuid, int);
drop function ops.logbook_places();
drop function ops.take_down_log(uuid);
drop function ops.acknowledge_handover(uuid);
drop function ops.write_log(uuid, text, text, uuid, jsonb, timestamptz, text);
delete from core.domain_table where table_name = 'ops.log_entry'::regclass;
drop table ops.log_entry;
delete from ops.task_handover where task_id in (select id from ops.task where kind = 'handover');
delete from ops.task where kind = 'handover';
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check check (kind in (
  'one_off', 'checklist', 'prep', 'expiry', 'receive', 'licence', 'compliance', 'minibar_refill',
  'minibar_bill', 'sign_off'));
