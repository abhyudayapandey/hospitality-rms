-- migrate:up
-- The shift handover (ADR 118). A checklist marked as a handover (file 29 `handover`, the
-- library's handover checklists) is read by the next shift: whoever works in its department
-- sees the last one someone else finished, as a card on Home with every step's answer and
-- its note, until they tap "Seen". Booking leads get a register of their own (ADR 090's
-- engine): name, phone, dates, the rate quoted; closed as booked or lost.

alter table ops.checklist_template add column handover boolean not null default false;

-- The note a task is finished with is kept on its own, shown as a card (it was added to the
-- description, where it was easy to miss).
alter table ops.task add column done_note text check (length(done_note) <= 2000);
select core.patch_function('ops.complete_task(uuid, text)',
  $x$         description = case when nullif(btrim(p_note), '') is null then description
                            else concat_ws(E'\n\n', description, 'Note: ' || btrim(p_note)) end$x$,
  $x$         done_note = nullif(btrim(p_note), '')$x$);

-- Booking leads in the registers
alter table ops.register_entry drop constraint register_entry_register_check;
alter table ops.register_entry add constraint register_entry_register_check
  check (register in ('lost_found', 'incidents', 'visitors', 'vehicles', 'staff_movement',
                      'keys', 'fire_equipment', 'leads'));

create or replace function ops.register_required(p_register text) returns text[]
language sql immutable
as $$
  select case p_register
           when 'lost_found' then array['item']
           when 'incidents' then array['what_happened']
           when 'visitors' then array['name']
           when 'vehicles' then array['number']
           when 'staff_movement' then array['person']
           when 'keys' then array['key', 'issued_to']
           when 'fire_equipment' then array['equipment', 'condition']
           when 'leads' then array['name', 'phone']
         end;
$$;

-- A lead closes as booked or lost (the outcome kept, as for lost and found).
select core.patch_function('ops.close_register_entry(uuid, text, text)',
  $x$  update ops.register_entry$x$,
  $x$  if v_e.register = 'leads' and coalesce(p_outcome, '') not in ('Booked', 'Lost') then
    perform ops.fail('INVALID_VALUE', 'booked or lost');
  end if;
  update ops.register_entry$x$);
select core.patch_function('ops.close_register_entry(uuid, text, text)',
  $x$outcome = case when v_e.register = 'lost_found' then p_outcome end,$x$,
  $x$outcome = case when v_e.register in ('lost_found', 'leads') then p_outcome end,$x$);

-- Who has seen a handover: its card leaves their Home.
create table ops.handover_seen (
  id uuid primary key default core.uuid_v7(),
  task_id uuid not null references ops.task(id),
  org_node_id uuid not null references core.hierarchy_node(id),
  user_id uuid not null references core.app_user(id),
  seen_at timestamptz not null default now(),
  unique (task_id, user_id)
);
select core.add_standard_columns('ops.handover_seen');
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.handover_seen', 'TASKS', 'org', true);
select core.apply_domain_rls('ops.handover_seen');
select audit.enable('ops.handover_seen');

-- The handovers for me: per handover checklist of a department I work in (or one under it),
-- its last round, finished by someone else in the last 24 hours, that I have not seen; with
-- each step's answer and the note it was finished with.
create function ops.last_handovers()
returns table (task_id uuid, place text, title text, done_by text, done_at timestamptz,
               note text, steps jsonb)
language sql stable security definer
set search_path = pg_catalog, core, ops, hr, extensions
as $$
  select t.id, n.name, t.title, u.display_name, t.completed_at, t.done_note,
         coalesce((select jsonb_agg(jsonb_build_object(
                             'label', s.label, 'kind', s.kind, 'num', s.value_num,
                             'text', s.value_text, 'unit', s.unit,
                             'done', s.done_at is not null, 'flagged', s.flagged)
                           order by s.position)
                     from ops.task_step s where s.task_id = t.id), '[]')
    from ops.checklist_template ct
    join lateral (select * from ops.task x
                   where x.template_id = ct.id and x.completed_at is not null
                   order by x.completed_at desc limit 1) t on true
    join core.hierarchy_node n on n.id = t.org_node_id
    left join core.app_user u on u.id = t.completed_by
   where ct.tenant_id = core.my_tenant() and ct.handover and ct.archived_at is null
     and t.completed_at > now() - interval '24 hours'
     and t.completed_by is distinct from core.current_user_id()
     and not exists (select 1 from ops.handover_seen h
                      where h.task_id = t.id and h.user_id = core.current_user_id())
     and exists (select 1 from hr.worker w
                   join core.hierarchy_node h on h.id = w.org_node_id
                  where w.owner_user_id = core.current_user_id() and w.status = 'active'
                    and h.path operator(extensions.<@) n.path)
   order by t.completed_at desc;
$$;

-- I have read a handover: its card leaves my Home.
create function ops.see_handover(p_task uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_node uuid;
begin
  select l.task_id into v_node from ops.last_handovers() l where l.task_id = p_task;
  if v_node is null then
    return; -- not mine to see, or seen already
  end if;
  insert into ops.handover_seen (tenant_id, task_id, org_node_id, user_id)
  select t.tenant_id, t.id, t.org_node_id, core.current_user_id()
    from ops.task t where t.id = p_task
  on conflict (task_id, user_id) do nothing;
end $$;

revoke execute on function ops.last_handovers(), ops.see_handover(uuid) from public;
grant execute on function ops.last_handovers(), ops.see_handover(uuid) to app_rw;

-- migrate:down
drop function ops.see_handover(uuid);
drop function ops.last_handovers();
delete from core.domain_table where table_name = 'ops.handover_seen'::regclass;
drop table ops.handover_seen;
delete from ops.register_entry where register = 'leads';
select core.patch_function('ops.close_register_entry(uuid, text, text)',
  $x$outcome = case when v_e.register in ('lost_found', 'leads') then p_outcome end,$x$,
  $x$outcome = case when v_e.register = 'lost_found' then p_outcome end,$x$);
select core.patch_function('ops.close_register_entry(uuid, text, text)',
  $x$  if v_e.register = 'leads' and coalesce(p_outcome, '') not in ('Booked', 'Lost') then
    perform ops.fail('INVALID_VALUE', 'booked or lost');
  end if;
  update ops.register_entry$x$,
  $x$  update ops.register_entry$x$);
create or replace function ops.register_required(p_register text) returns text[]
language sql immutable
as $$
  select case p_register
           when 'lost_found' then array['item']
           when 'incidents' then array['what_happened']
           when 'visitors' then array['name']
           when 'vehicles' then array['number']
           when 'staff_movement' then array['person']
           when 'keys' then array['key', 'issued_to']
           when 'fire_equipment' then array['equipment', 'condition']
         end;
$$;
alter table ops.register_entry drop constraint register_entry_register_check;
alter table ops.register_entry add constraint register_entry_register_check
  check (register in ('lost_found', 'incidents', 'visitors', 'vehicles', 'staff_movement',
                      'keys', 'fire_equipment'));
select core.patch_function('ops.complete_task(uuid, text)',
  $x$         done_note = nullif(btrim(p_note), '')$x$,
  $x$         description = case when nullif(btrim(p_note), '') is null then description
                            else concat_ws(E'\n\n', description, 'Note: ' || btrim(p_note)) end$x$);
alter table ops.task drop column done_note;
alter table ops.checklist_template drop column handover;
