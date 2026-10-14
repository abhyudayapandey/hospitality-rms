-- migrate:up
-- A rejected ask reads as rejected everywhere, with who and why (ADR 141, follow-up):
-- - whoever asked, opening it from Given to others, reaches the ask's own page: the head's
--   task row is hidden from them by RLS, so the page finds the ask through ops.task_ask,
--   which hands it only to whoever may follow the ask (inv.may_follow_ask);
-- - where it is now: "Rejected: <reason>"; its story: "Rejected by <head>: <reason>";
-- - the alert to whoever asked: "Rejected: <items>", with the reason.

create function ops.task_ask(p_task uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog, core, ops, inv
as $$
  select t.staff_ask_id from ops.task t
   where t.id = p_task and t.kind = 'ask' and t.tenant_id = core.my_tenant()
     and inv.may_follow_ask(t.staff_ask_id);
$$;
revoke execute on function ops.task_ask(uuid) from public;
grant execute on function ops.task_ask(uuid) to app_rw, platform_loader;

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('inv.staff_ask_now(uuid)'::regprocedure);
  v_new := replace(v_def,
    $o$'closed'::text, 'Not given: ' || coalesce(v_a.closed_reason, '')$o$,
    $n$'closed'::text, 'Rejected: ' || coalesce(v_a.closed_reason, '')$n$);
  if v_new = v_def then raise exception 'staff_ask_now did not change'; end if;
  execute v_new;

  v_def := pg_get_functiondef('inv.staff_ask_story(uuid)'::regprocedure);
  v_new := replace(v_def,
    $o$'Not given: ' || coalesce(v_a.closed_reason, '')$o$,
    $n$'Rejected by ' || coalesce((select display_name from core.app_user
                                     where id = v_a.closed_by), 'the store')
               || ': ' || coalesce(v_a.closed_reason, '')$n$);
  if v_new = v_def then raise exception 'staff_ask_story did not change'; end if;
  execute v_new;

  v_def := pg_get_functiondef('inv.close_staff_ask(uuid,text)'::regprocedure);
  v_new := replace(v_def, $o$'Not given: ' || inv.staff_ask_items_text(p_ask)$o$,
                          $n$'Rejected: ' || inv.staff_ask_items_text(p_ask)$n$);
  if v_new = v_def then raise exception 'close_staff_ask did not change'; end if;
  execute v_new;
end $$;

-- migrate:down
do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('inv.close_staff_ask(uuid,text)'::regprocedure);
  execute replace(v_def, $n$'Rejected: ' || inv.staff_ask_items_text(p_ask)$n$,
                         $o$'Not given: ' || inv.staff_ask_items_text(p_ask)$o$);
  v_def := pg_get_functiondef('inv.staff_ask_story(uuid)'::regprocedure);
  execute replace(v_def,
    $n$'Rejected by ' || coalesce((select display_name from core.app_user
                                     where id = v_a.closed_by), 'the store')
               || ': ' || coalesce(v_a.closed_reason, '')$n$,
    $o$'Not given: ' || coalesce(v_a.closed_reason, '')$o$);
  v_def := pg_get_functiondef('inv.staff_ask_now(uuid)'::regprocedure);
  execute replace(v_def,
    $n$'closed'::text, 'Rejected: ' || coalesce(v_a.closed_reason, '')$n$,
    $o$'closed'::text, 'Not given: ' || coalesce(v_a.closed_reason, '')$o$);
end $$;
drop function ops.task_ask(uuid);
