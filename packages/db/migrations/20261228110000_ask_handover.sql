-- migrate:up
-- Asks that follow through (ADR 142).
-- 1. Whoever asked follows every request made for their ask (inv.may_follow), and hears about
--    it with a link to their ask (inv.tell), never to a page they may not open.
-- 2. A request made for an ask carries the ask: who asked and why, on its page and the GM's
--    card (inv.request_for_ask), and first in its story (inv.request_story).
-- 3. Handover: when the head gives what was asked, whoever asked gets a task, "Collect from
--    <store>", whose one button says the stock went to the department ("Transfer to Bar done",
--    inv.collect_staff_ask). It is due by the end of their shift (else in 2 hours); overdue,
--    the head is told as for any task. No stock moves: the store is the department's own.
-- 4. Whoever asked never gets "Give it to someone" on the head's ask (ops.looks_after).

alter table inv.staff_ask add column collected_at timestamptz,
                          add column collected_by uuid references core.app_user (id);

alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check check (kind = any (array['one_off', 'checklist',
  'prep', 'expiry', 'receive', 'licence', 'compliance', 'minibar_refill', 'minibar_bill',
  'sign_off', 'handover', 'discard', 'send', 'ask', 'collect']));
alter table ops.task drop constraint task_ask;
alter table ops.task add constraint task_ask
  check ((kind in ('ask', 'collect')) = (staff_ask_id is not null));

-- 1. following and hearing
select core.patch_function('inv.may_follow(uuid)',
  $x$      or (v_t.for_transfer_id is not null and inv.may_follow(v_t.for_transfer_id));$x$,
  $x$      or (v_t.for_transfer_id is not null and inv.may_follow(v_t.for_transfer_id))
      or exists (select 1 from inv.staff_ask a
                  where a.id = (select r.for_ask_id from inv.transfer r
                                 where r.id = inv.root_transfer(p_transfer))
                    and a.asked_by = v_me);$x$);

select core.patch_function('inv.tell(uuid,uuid[],text,text,text)',
  $x$  v_u uuid;
begin
  select * into v_t from inv.transfer where id = p_transfer;$x$,
  $x$  v_u uuid;
  v_ask inv.staff_ask;
begin
  select * into v_t from inv.transfer where id = p_transfer;
  select a.* into v_ask from inv.staff_ask a
   where a.id = (select r.for_ask_id from inv.transfer r where r.id = inv.root_transfer(p_transfer));$x$);
select core.patch_function('inv.tell(uuid,uuid[],text,text,text)',
  $x$                       '/stock/transfers/' || p_transfer);$x$,
  $x$                       case when v_u = v_ask.asked_by then '/stock/asks/' || v_ask.id
                            else '/stock/transfers/' || p_transfer end);$x$);

-- 2. the ask behind a request
create function inv.request_for_ask(p_transfer uuid)
returns table (ask_id uuid, asked_by text, note text, items text, asked_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  perform wf.me();
  -- nothing for anyone who may not follow it, so a list never fails on one row
  if p_transfer is null
     or not (inv.may_follow(p_transfer) or inv.my_transfer_step(p_transfer) is not null) then
    return;
  end if;
  return query
    select a.id, u.display_name, a.note, inv.staff_ask_items_text(a.id), a.created_at
      from inv.staff_ask a join core.app_user u on u.id = a.asked_by
     where a.id = (select r.for_ask_id from inv.transfer r
                    where r.id = inv.root_transfer(p_transfer));
end $$;
revoke execute on function inv.request_for_ask(uuid) from public;
grant execute on function inv.request_for_ask(uuid) to app_rw, platform_loader;

select core.patch_function('inv.request_story(uuid)',
  $x$  return query select s.at, s.words from inv.story_of(p_transfer) s
                order by s.at, s.rank;$x$,
  $x$  return query select x.at, x.words from (
      select a.asked_at as at, -1 as rank,
             'Asked by ' || a.asked_by || ' for ' || a.items
               || coalesce(': ' || a.note, '') as words
        from inv.request_for_ask(p_transfer) a
      union all
      select s.at, s.rank, s.words from inv.story_of(p_transfer) s) x
    order by x.at, x.rank;$x$);

-- 3. handover
create function inv.ask_department(p_ask uuid) returns text
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select inv.short_name(org_node_id) from inv.staff_ask where id = p_ask;
$$;
revoke execute on function inv.ask_department(uuid) from public;

select core.patch_function('inv.give_staff_ask(uuid,text)',
  $x$  perform inv.ask_tell(p_ask, array[v_a.asked_by],$x$,
  $x$  -- whoever asked takes it to the department, and says so
  insert into ops.task (tenant_id, org_node_id, delivery_node_id, kind, title, description,
                        priority, due_at, status, assign_mode, assignee_user_id, assigned_by,
                        staff_ask_id)
  values (v_a.tenant_id, v_a.org_node_id, v_a.delivery_node_id, 'collect',
          left('Collect from the ' || inv.short_name(v_a.delivery_node_id) || ': '
               || inv.staff_ask_items_text(p_ask), 200),
          'Take it to the ' || inv.ask_department(p_ask) || ', then tap Transfer to '
            || inv.ask_department(p_ask) || ' done.',
          'normal',
          coalesce((select max(s.end_at) from hr.shift_assignment sa
                      join hr.shift s on s.id = sa.shift_id
                     where sa.owner_user_id = v_a.asked_by and sa.status = 'assigned'
                       and now() between s.start_at and s.end_at),
                   now() + interval '2 hours'),
          'open', 'person', v_a.asked_by, v_me, p_ask);
  perform inv.ask_tell(p_ask, array[v_a.asked_by],$x$);

create function inv.collect_staff_ask(p_ask uuid) returns text
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_me uuid := core.current_user_id();
  v_a inv.staff_ask;
  v_task ops.task;
begin
  perform wf.me();
  select * into v_a from inv.staff_ask where id = p_ask and tenant_id = core.my_tenant();
  select * into v_task from ops.task
   where staff_ask_id = p_ask and kind = 'collect' and status in ('open', 'in_progress');
  if v_a.id is null or v_task.id is null
     or v_me is distinct from coalesce(v_task.assignee_user_id, v_a.asked_by) then
    perform inv.fail('NOT_AUTHORISED', 'collect this');
  end if;
  update inv.staff_ask set collected_at = now(), collected_by = v_me where id = p_ask;
  update ops.task set status = 'done', completed_by = v_me, completed_at = now()
   where id = v_task.id;
  return 'collected';
end $$;
revoke execute on function inv.collect_staff_ask(uuid) from public;
grant execute on function inv.collect_staff_ask(uuid) to app_rw, platform_loader;

-- the open collect task the caller may finish, for the ask's page
create function inv.my_collect(p_ask uuid) returns table (task_id uuid, department text)
language sql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
  select t.id, inv.ask_department(p_ask) from ops.task t
   where t.staff_ask_id = p_ask and t.kind = 'collect' and t.status in ('open', 'in_progress')
     and t.tenant_id = core.my_tenant() and t.assignee_user_id = core.current_user_id();
$$;
revoke execute on function inv.my_collect(uuid) from public;
grant execute on function inv.my_collect(uuid) to app_rw, platform_loader;

select core.patch_function('inv.staff_ask_now(uuid)',
  $x$    return query select 'given'::text,
      'Given by ' || (select display_name from core.app_user where id = v_a.given_by);$x$,
  $x$    if v_a.collected_at is not null then
      return query select 'given'::text,
        'Taken to the ' || inv.ask_department(p_ask) || ' by '
          || (select display_name from core.app_user where id = v_a.collected_by);
    else
      return query select 'to_collect'::text,
        'Given by ' || (select display_name from core.app_user where id = v_a.given_by)
          || '. Take it to the ' || inv.ask_department(p_ask) || '.';
    end if;$x$);

select core.patch_function('inv.staff_ask_story(uuid)',
  $x$       where v_a.given_at is not null$x$,
  $x$       where v_a.given_at is not null
      union all
      select v_a.collected_at, 1001,
             'Taken to the ' || inv.ask_department(p_ask) || ' by '
               || (select display_name from core.app_user where id = v_a.collected_by)
       where v_a.collected_at is not null$x$);

-- the collect task opens the ask, like the head's
select core.patch_function('ops.task_ask(uuid)',
  $x$t.kind = 'ask'$x$, $x$t.kind in ('ask', 'collect')$x$);

-- 4. whoever asked does not hand on the head's ask: asking is not handing on
select core.patch_function('ops.looks_after(ops.task,text)',
  $x$                 where x.task_id = p_task.id and x.by_user = v_me and x.to_user <> v_me) then$x$,
  $x$                 where x.task_id = p_task.id and x.by_user = v_me and x.to_user <> v_me
                   and p_task.kind <> 'ask') then$x$);

-- migrate:down
select core.patch_function('ops.looks_after(ops.task,text)',
  $x$                 where x.task_id = p_task.id and x.by_user = v_me and x.to_user <> v_me
                   and p_task.kind <> 'ask') then$x$,
  $x$                 where x.task_id = p_task.id and x.by_user = v_me and x.to_user <> v_me) then$x$);
select core.patch_function('ops.task_ask(uuid)',
  $x$t.kind in ('ask', 'collect')$x$, $x$t.kind = 'ask'$x$);
select core.patch_function('inv.staff_ask_story(uuid)',
  $x$       where v_a.given_at is not null
      union all
      select v_a.collected_at, 1001,
             'Taken to the ' || inv.ask_department(p_ask) || ' by '
               || (select display_name from core.app_user where id = v_a.collected_by)
       where v_a.collected_at is not null$x$,
  $x$       where v_a.given_at is not null$x$);
select core.patch_function('inv.staff_ask_now(uuid)',
  $x$    if v_a.collected_at is not null then
      return query select 'given'::text,
        'Taken to the ' || inv.ask_department(p_ask) || ' by '
          || (select display_name from core.app_user where id = v_a.collected_by);
    else
      return query select 'to_collect'::text,
        'Given by ' || (select display_name from core.app_user where id = v_a.given_by)
          || '. Take it to the ' || inv.ask_department(p_ask) || '.';
    end if;$x$,
  $x$    return query select 'given'::text,
      'Given by ' || (select display_name from core.app_user where id = v_a.given_by);$x$);
drop function inv.my_collect(uuid);
drop function inv.collect_staff_ask(uuid);
do $$
declare
  v_def text := pg_get_functiondef('inv.give_staff_ask(uuid,text)'::regprocedure);
  v_from int := position('  -- whoever asked takes it to the department' in v_def);
  v_to int := position('  perform inv.ask_tell(p_ask, array[v_a.asked_by],' in v_def);
begin
  execute substr(v_def, 1, v_from - 1) || substr(v_def, v_to);
end $$;
drop function inv.ask_department(uuid);
select core.patch_function('inv.request_story(uuid)',
  $x$  return query select x.at, x.words from (
      select a.asked_at as at, -1 as rank,
             'Asked by ' || a.asked_by || ' for ' || a.items
               || coalesce(': ' || a.note, '') as words
        from inv.request_for_ask(p_transfer) a
      union all
      select s.at, s.rank, s.words from inv.story_of(p_transfer) s) x
    order by x.at, x.rank;$x$,
  $x$  return query select s.at, s.words from inv.story_of(p_transfer) s
                order by s.at, s.rank;$x$);
drop function inv.request_for_ask(uuid);
select core.patch_function('inv.tell(uuid,uuid[],text,text,text)',
  $x$                       case when v_u = v_ask.asked_by then '/stock/asks/' || v_ask.id
                            else '/stock/transfers/' || p_transfer end);$x$,
  $x$                       '/stock/transfers/' || p_transfer);$x$);
select core.patch_function('inv.tell(uuid,uuid[],text,text,text)',
  $x$  v_u uuid;
  v_ask inv.staff_ask;
begin
  select * into v_t from inv.transfer where id = p_transfer;
  select a.* into v_ask from inv.staff_ask a
   where a.id = (select r.for_ask_id from inv.transfer r where r.id = inv.root_transfer(p_transfer));$x$,
  $x$  v_u uuid;
begin
  select * into v_t from inv.transfer where id = p_transfer;$x$);
select core.patch_function('inv.may_follow(uuid)',
  $x$      or (v_t.for_transfer_id is not null and inv.may_follow(v_t.for_transfer_id))
      or exists (select 1 from inv.staff_ask a
                  where a.id = (select r.for_ask_id from inv.transfer r
                                 where r.id = inv.root_transfer(p_transfer))
                    and a.asked_by = v_me);$x$,
  $x$      or (v_t.for_transfer_id is not null and inv.may_follow(v_t.for_transfer_id));$x$);
delete from ops.task where kind = 'collect';
alter table ops.task drop constraint task_ask;
alter table ops.task add constraint task_ask check ((kind = 'ask') = (staff_ask_id is not null));
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check check (kind = any (array['one_off', 'checklist',
  'prep', 'expiry', 'receive', 'licence', 'compliance', 'minibar_refill', 'minibar_bill',
  'sign_off', 'handover', 'discard', 'send', 'ask']));
alter table inv.staff_ask drop column collected_by, drop column collected_at;
