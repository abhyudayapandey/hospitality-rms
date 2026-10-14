-- migrate:up
-- Two fixes from the walk (ADR 146):
-- 1. Where an ask is now speaks to whoever reads it: "will give it to you" only to whoever asked;
--    the head who gives it reads "give it to Sana Shaikh", anyone else "Calvin Rodrigues will
--    give it to Sana Shaikh".
-- 2. An ask given before the Collect step (ADR 142) has no Collect task: whoever asked may still
--    say it reached the department, from the ask's page.

-- who gives it, in the reader's words
create function inv.ask_giver_words(p_ask uuid) returns text
language sql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
  select case
           when core.current_user_id() = a.asked_by
             then coalesce(h.display_name, 'your head') || ' will give it to you'
           when core.current_user_id() = h.id
             then 'give it to ' || asker.display_name
           else coalesce(h.display_name, 'the head') || ' will give it to ' || asker.display_name
         end
    from inv.staff_ask a
    join core.app_user asker on asker.id = a.asked_by
    left join lateral (select u.id, u.display_name from ops.task k
                         join core.app_user u on u.id = k.assignee_user_id
                        where k.staff_ask_id = a.id and k.kind = 'ask'
                        order by k.created_at limit 1) h on true
   where a.id = p_ask;
$$;
revoke execute on function inv.ask_giver_words(uuid) from public;
grant execute on function inv.ask_giver_words(uuid) to app_rw;

select core.patch_function('inv.staff_ask_now(uuid)',
  $x$then 'At the ' || inv.short_name(t.to_node_id) || ': '
                                || (select display_name from core.app_user u
                                     join ops.task k on k.assignee_user_id = u.id
                                    where k.staff_ask_id = p_ask and k.kind = 'ask'
                                    limit 1) || ' will give it to you'$x$,
  $x$then 'At the ' || inv.short_name(t.to_node_id) || ': '
                                || inv.ask_giver_words(p_ask)$x$);

-- an ask given with no Collect task (before ADR 142): whoever asked may still say it arrived
create or replace function inv.my_collect(p_ask uuid)
 returns table(task_id uuid, department text)
 language sql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv', 'ops'
as $function$
  select t.id, inv.ask_department(p_ask) from ops.task t
   where t.staff_ask_id = p_ask and t.kind = 'collect' and t.status in ('open', 'in_progress')
     and t.tenant_id = core.my_tenant() and t.assignee_user_id = core.current_user_id()
  union all
  select null::uuid, inv.ask_department(p_ask) from inv.staff_ask a
   where a.id = p_ask and a.tenant_id = core.my_tenant() and a.status = 'given'
     and a.collected_at is null and a.asked_by = core.current_user_id()
     and not exists (select 1 from ops.task t where t.staff_ask_id = p_ask and t.kind = 'collect');
$function$;

select core.patch_function('inv.collect_staff_ask(uuid)',
  $x$  if v_a.id is null or v_task.id is null
     or v_me is distinct from coalesce(v_task.assignee_user_id, v_a.asked_by) then$x$,
  $x$  if v_a.id is null
     or (v_task.id is null and (v_a.status <> 'given' or v_a.collected_at is not null
                                or exists (select 1 from ops.task t
                                            where t.staff_ask_id = p_ask and t.kind = 'collect')))
     or v_me is distinct from coalesce(v_task.assignee_user_id, v_a.asked_by) then$x$);
select core.patch_function('inv.collect_staff_ask(uuid)',
  $x$  update ops.task set status = 'done', completed_by = v_me, completed_at = now()
   where id = v_task.id;$x$,
  $x$  if v_task.id is not null then
    update ops.task set status = 'done', completed_by = v_me, completed_at = now()
     where id = v_task.id;
  end if;$x$);

-- migrate:down
select core.patch_function('inv.collect_staff_ask(uuid)',
  $x$  if v_task.id is not null then
    update ops.task set status = 'done', completed_by = v_me, completed_at = now()
     where id = v_task.id;
  end if;$x$,
  $x$  update ops.task set status = 'done', completed_by = v_me, completed_at = now()
   where id = v_task.id;$x$);
select core.patch_function('inv.collect_staff_ask(uuid)',
  $x$  if v_a.id is null
     or (v_task.id is null and (v_a.status <> 'given' or v_a.collected_at is not null
                                or exists (select 1 from ops.task t
                                            where t.staff_ask_id = p_ask and t.kind = 'collect')))
     or v_me is distinct from coalesce(v_task.assignee_user_id, v_a.asked_by) then$x$,
  $x$  if v_a.id is null or v_task.id is null
     or v_me is distinct from coalesce(v_task.assignee_user_id, v_a.asked_by) then$x$);

create or replace function inv.my_collect(p_ask uuid)
 returns table(task_id uuid, department text)
 language sql stable security definer
 set search_path to 'pg_catalog', 'core', 'inv', 'ops'
as $function$
  select t.id, inv.ask_department(p_ask) from ops.task t
   where t.staff_ask_id = p_ask and t.kind = 'collect' and t.status in ('open', 'in_progress')
     and t.tenant_id = core.my_tenant() and t.assignee_user_id = core.current_user_id();
$function$;

select core.patch_function('inv.staff_ask_now(uuid)',
  $x$then 'At the ' || inv.short_name(t.to_node_id) || ': '
                                || inv.ask_giver_words(p_ask)$x$,
  $x$then 'At the ' || inv.short_name(t.to_node_id) || ': '
                                || (select display_name from core.app_user u
                                     join ops.task k on k.assignee_user_id = u.id
                                    where k.staff_ask_id = p_ask and k.kind = 'ask'
                                    limit 1) || ' will give it to you'$x$);
drop function inv.ask_giver_words(uuid);
