-- migrate:up
-- Requests say what matters to decide them, and a "no" reads as a no (ADR 141).
--
-- 1. inv.request_levels: for each line of a request between two stores, what the giving store
--    has, and what the asking store already has with its par. The GM approving a request, the
--    keeper sending it and anyone who follows it see it (inv.may_follow, or whoever holds the
--    request's step). A frontline person's ask (ADR 115) says the par of the store as well.
-- 2. A head who can't give what was asked closes the ask (inv.close_staff_ask): the head's task
--    is still done (it is dealt with), but the lists say "Not given" and the reason, never
--    "Done" (ops.not_given_reason in ops.my_tasks and ops.my_handed_on). Whoever asked is told
--    by the ask itself ("Ready for you", "Not given: ..."), so the head's task no longer also
--    sends them "Done: ..." (ops.task_handover_log).

create function inv.request_levels(p_transfer uuid)
returns table (item_id uuid, name text, base_uom text, asked numeric,
               from_name text, from_on_hand numeric,
               to_name text, to_on_hand numeric, to_par numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_t inv.transfer;
begin
  perform wf.me();
  select * into v_t from inv.transfer where id = p_transfer and tenant_id = core.my_tenant();
  if not found or not (inv.may_follow(p_transfer) or inv.my_transfer_step(p_transfer) is not null)
  then
    perform inv.fail('NOT_AUTHORISED', 'follow this request');
  end if;
  return query
    select tl.item_id, i.name, i.base_uom, tl.requested_qty,
           inv.short_name(v_t.from_node_id), coalesce(fs.on_hand, 0),
           inv.short_name(v_t.to_node_id), coalesce(ts.on_hand, 0), tn.par_level
      from inv.transfer_line tl
      join inv.item i on i.id = tl.item_id
      left join inv.stock_level fs on fs.item_id = tl.item_id
                                  and fs.delivery_node_id = v_t.from_node_id
      left join inv.stock_level ts on ts.item_id = tl.item_id
                                  and ts.delivery_node_id = v_t.to_node_id
      left join inv.item_node tn on tn.item_id = tl.item_id
                                and tn.delivery_node_id = v_t.to_node_id
                                and tn.archived_at is null
     where tl.transfer_id = p_transfer
     order by i.name;
end $$;
revoke execute on function inv.request_levels(uuid) from public;
grant execute on function inv.request_levels(uuid) to app_rw, platform_loader;

-- the ask's lines also carry the store's par
do $$
declare
  v_def text := pg_get_functiondef('inv.staff_ask_detail(uuid)'::regprocedure);
  v_new text := replace(v_def,
    $o$'at_store', coalesce(sl.on_hand, 0))$o$,
    $n$'at_store', coalesce(sl.on_hand, 0),
                                                'par', x.par_level)$n$);
begin
  v_new := replace(v_new,
    $o$                                          and sl.delivery_node_id = a.delivery_node_id$o$,
    $n$                                          and sl.delivery_node_id = a.delivery_node_id
              left join inv.item_node x on x.item_id = l.item_id
                                       and x.delivery_node_id = a.delivery_node_id
                                       and x.archived_at is null$n$);
  if v_new = v_def or v_new not like '%x.par_level%' or v_new not like '%left join inv.item_node x%' then
    raise exception 'staff_ask_detail did not change as expected';
  end if;
  execute v_new;
end $$;

-- whether everything an ask waited on has come in
create function inv.ask_arrived(p_ask uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select exists (select 1 from inv.transfer t where t.for_ask_id = p_ask)
     and not exists (select 1 from inv.transfer t cross join lateral inv.now_of(t.id) n
                      where t.for_ask_id = p_ask and n.stage <> 'received');
$$;
revoke execute on function inv.ask_arrived(uuid) from public;

-- an ask the head asked on reads "arrived" once everything it waited on came in, and only
-- then may the head give it (the page offers "It arrived: give it")
do $$
declare
  v_def text := pg_get_functiondef('inv.staff_ask_now(uuid)'::regprocedure);
  v_new text := replace(v_def,
    $o$    return query select 'asked_on'::text, v_words;$o$,
    $n$    return query
      select case when inv.ask_arrived(p_ask) then 'arrived' else 'asked_on' end, v_words;$n$);
begin
  if v_new = v_def then
    raise exception 'staff_ask_now did not change as expected';
  end if;
  execute v_new;
end $$;

-- why a head's ask task was not given, when it wasn't
create function ops.not_given_reason(p_task ops.task) returns text
language sql stable security definer
set search_path = pg_catalog, core, ops, inv
as $$
  select a.closed_reason from inv.staff_ask a
   where p_task.kind = 'ask' and a.id = p_task.staff_ask_id and a.status = 'closed';
$$;
revoke execute on function ops.not_given_reason(ops.task) from public;

drop function ops.my_tasks();
create function ops.my_tasks()
 RETURNS TABLE(id uuid, kind text, title text, org_node_id uuid, place_name text, due_at timestamp with time zone, priority text, status text, assign_mode text, taken boolean, steps_total integer, steps_done integer, overdue boolean, covering text, assigned_at timestamp with time zone, assigned_by_name text, completed_at timestamp with time zone, done_by_name text, not_given_reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'ops'
AS $function$
  select t.id, t.kind, t.title, t.org_node_id, n.name, t.due_at, t.priority, t.status,
         t.assign_mode, t.assignee_user_id is not null,
         (select count(*)::int from ops.task_step s where s.task_id = t.id),
         (select count(*)::int from ops.task_step s where s.task_id = t.id and s.done_at is not null),
         t.status in ('open', 'in_progress') and t.due_at < now(),
         case when t.assign_mode = 'job_role'
                   and ops.covers(core.current_user_id(), t.job_role_code, t.org_node_id)
              then (select j.name from hr.job_role j
                     where j.tenant_id = t.tenant_id and j.code = t.job_role_code) end,
         t.assigned_at,
         (select u.display_name from core.app_user u
           where u.id = t.assigned_by and u.id <> core.current_user_id()),
         case when t.status = 'done' then t.completed_at end,
         -- who did it, when it was someone else (null: you)
         case when t.status = 'done' then
           (select u.display_name from core.app_user u
             where u.id = coalesce(t.completed_by, t.assignee_user_id)
               and u.id <> core.current_user_id()) end,
         ops.not_given_reason(t)
    from ops.task t
    join core.hierarchy_node n on n.id = t.org_node_id
   where t.tenant_id = core.my_tenant()
     and ((t.status in ('open', 'in_progress')
           and (t.assignee_user_id = core.current_user_id()
                or (t.assignee_user_id is null and ops.in_pool(t, core.current_user_id()))))
          or (ops.done_lately(t)
              and (t.assignee_user_id = core.current_user_id()
                   or t.completed_by = core.current_user_id()
                   or (t.assign_mode in ('job_role', 'on_shift')
                       and ops.in_pool(t, core.current_user_id())))))
   order by t.status in ('done'), t.due_at, t.priority = 'high' desc;
$function$;

drop function ops.my_handed_on();
create function ops.my_handed_on()
 RETURNS TABLE(id uuid, kind text, title text, place_name text, due_at timestamp with time zone, status text, assignee_name text, assigned_at timestamp with time zone, overdue boolean, completed_at timestamp with time zone, done_by_name text, not_given_reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'ops'
AS $function$
  select t.id, t.kind, t.title, n.name, t.due_at, t.status, u.display_name, t.assigned_at,
         t.status in ('open', 'in_progress') and t.due_at < now(),
         case when t.status = 'done' then t.completed_at end,
         case when t.status = 'done' then
           (select d.display_name from core.app_user d
             where d.id = coalesce(t.completed_by, t.assignee_user_id)) end,
         ops.not_given_reason(t)
    from ops.task t
    join core.hierarchy_node n on n.id = t.org_node_id
    left join core.app_user u on u.id = t.assignee_user_id
   where t.tenant_id = core.my_tenant()
     and (t.status in ('open', 'in_progress') or ops.done_lately(t))
     and t.assignee_user_id is distinct from core.current_user_id()
     and exists (select 1 from ops.task_handover h
                  where h.task_id = t.id and h.by_user = core.current_user_id()
                    and h.to_user <> h.by_user)
   order by t.status = 'done', t.due_at, t.title;
$function$;

revoke execute on function ops.my_tasks(), ops.my_handed_on() from public;
grant execute on function ops.my_tasks(), ops.my_handed_on() to app_rw, platform_loader;

-- the asker hears from the ask itself, not "Done: ..." from the head's task
do $$
declare
  v_def text := pg_get_functiondef('ops.task_handover_log()'::regprocedure);
  v_new text := replace(v_def,
    $o$  if tg_op = 'UPDATE' and new.status = 'done' and old.status is distinct from 'done' then$o$,
    $n$  if tg_op = 'UPDATE' and new.status = 'done' and old.status is distinct from 'done'
     and new.kind <> 'ask' then$n$);
begin
  if v_new = v_def then
    raise exception 'task_handover_log did not change as expected';
  end if;
  execute v_new;
end $$;

-- migrate:down
do $$
declare
  v_def text := pg_get_functiondef('ops.task_handover_log()'::regprocedure);
begin
  execute replace(v_def,
    $n$  if tg_op = 'UPDATE' and new.status = 'done' and old.status is distinct from 'done'
     and new.kind <> 'ask' then$n$,
    $o$  if tg_op = 'UPDATE' and new.status = 'done' and old.status is distinct from 'done' then$o$);
end $$;

drop function ops.my_tasks();
create function ops.my_tasks()
 RETURNS TABLE(id uuid, kind text, title text, org_node_id uuid, place_name text, due_at timestamp with time zone, priority text, status text, assign_mode text, taken boolean, steps_total integer, steps_done integer, overdue boolean, covering text, assigned_at timestamp with time zone, assigned_by_name text, completed_at timestamp with time zone, done_by_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'ops'
AS $function$
  select t.id, t.kind, t.title, t.org_node_id, n.name, t.due_at, t.priority, t.status,
         t.assign_mode, t.assignee_user_id is not null,
         (select count(*)::int from ops.task_step s where s.task_id = t.id),
         (select count(*)::int from ops.task_step s where s.task_id = t.id and s.done_at is not null),
         t.status in ('open', 'in_progress') and t.due_at < now(),
         case when t.assign_mode = 'job_role'
                   and ops.covers(core.current_user_id(), t.job_role_code, t.org_node_id)
              then (select j.name from hr.job_role j
                     where j.tenant_id = t.tenant_id and j.code = t.job_role_code) end,
         t.assigned_at,
         (select u.display_name from core.app_user u
           where u.id = t.assigned_by and u.id <> core.current_user_id()),
         case when t.status = 'done' then t.completed_at end,
         -- who did it, when it was someone else (null: you)
         case when t.status = 'done' then
           (select u.display_name from core.app_user u
             where u.id = coalesce(t.completed_by, t.assignee_user_id)
               and u.id <> core.current_user_id()) end
    from ops.task t
    join core.hierarchy_node n on n.id = t.org_node_id
   where t.tenant_id = core.my_tenant()
     and ((t.status in ('open', 'in_progress')
           and (t.assignee_user_id = core.current_user_id()
                or (t.assignee_user_id is null and ops.in_pool(t, core.current_user_id()))))
          or (ops.done_lately(t)
              and (t.assignee_user_id = core.current_user_id()
                   or t.completed_by = core.current_user_id()
                   or (t.assign_mode in ('job_role', 'on_shift')
                       and ops.in_pool(t, core.current_user_id())))))
   order by t.status in ('done'), t.due_at, t.priority = 'high' desc;
$function$;

drop function ops.my_handed_on();
create function ops.my_handed_on()
 RETURNS TABLE(id uuid, kind text, title text, place_name text, due_at timestamp with time zone, status text, assignee_name text, assigned_at timestamp with time zone, overdue boolean, completed_at timestamp with time zone, done_by_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'ops'
AS $function$
  select t.id, t.kind, t.title, n.name, t.due_at, t.status, u.display_name, t.assigned_at,
         t.status in ('open', 'in_progress') and t.due_at < now(),
         case when t.status = 'done' then t.completed_at end,
         case when t.status = 'done' then
           (select d.display_name from core.app_user d
             where d.id = coalesce(t.completed_by, t.assignee_user_id)) end
    from ops.task t
    join core.hierarchy_node n on n.id = t.org_node_id
    left join core.app_user u on u.id = t.assignee_user_id
   where t.tenant_id = core.my_tenant()
     and (t.status in ('open', 'in_progress') or ops.done_lately(t))
     and t.assignee_user_id is distinct from core.current_user_id()
     and exists (select 1 from ops.task_handover h
                  where h.task_id = t.id and h.by_user = core.current_user_id()
                    and h.to_user <> h.by_user)
   order by t.status = 'done', t.due_at, t.title;
$function$;

revoke execute on function ops.my_tasks(), ops.my_handed_on() from public;
grant execute on function ops.my_tasks(), ops.my_handed_on() to app_rw, platform_loader;
drop function ops.not_given_reason(ops.task);

do $$
declare
  v_def text := pg_get_functiondef('inv.staff_ask_detail(uuid)'::regprocedure);
  v_new text := replace(v_def,
    $n$'at_store', coalesce(sl.on_hand, 0),
                                                'par', x.par_level)$n$,
    $o$'at_store', coalesce(sl.on_hand, 0))$o$);
begin
  execute replace(v_new,
    $n$
              left join inv.item_node x on x.item_id = l.item_id
                                       and x.delivery_node_id = a.delivery_node_id
                                       and x.archived_at is null$n$, '');
end $$;

do $$
declare
  v_def text := pg_get_functiondef('inv.staff_ask_now(uuid)'::regprocedure);
begin
  execute replace(v_def,
    $n$    return query
      select case when inv.ask_arrived(p_ask) then 'arrived' else 'asked_on' end, v_words;$n$,
    $o$    return query select 'asked_on'::text, v_words;$o$);
end $$;
drop function inv.ask_arrived(uuid);

drop function inv.request_levels(uuid);
