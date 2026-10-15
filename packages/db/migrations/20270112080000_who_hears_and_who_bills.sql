-- migrate:up
-- Who hears about a task, and who gets a bill (QA of the Passport Hotel demo):
--
-- 1. An overdue task is told to whoever gave it only when they answer for it (ADR 020): they
--    look after its place's tasks, or they handed it on (ops.looks_after, as them). A task the
--    app routes for someone (a minibar bill from a room attendant's check) is not theirs to
--    chase. The hour-later step to the place's heads is unchanged.
-- 2. A minibar bill is routed, not handed on: whoever checked is not recorded as giving it, so
--    it is not on their "Given to others" and they are not told when it is done.
-- 3. Who gets a minibar bill stays as ADR 104 and 148 have it (the owner's call).
-- 4. A test customer's past, replayed by the loader (app.replay), tells nobody now: ops.notify
--    sends nothing while it replays (ops.replaying).

-- 4 -------------------------------------------------------------------------------------------
create function ops.replaying(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce(current_setting('app.replay', true), '') = 'on'
     and coalesce((select t.is_test from core.tenant t where t.id = p_tenant), false);
$$;
revoke execute on function ops.replaying(uuid) from public;

create or replace function ops.notify(p_tenant uuid, p_user uuid, p_kind text, p_title text,
                                      p_body text default null, p_link text default null)
returns void
language sql security definer
set search_path = pg_catalog, ops
as $$
  insert into ops.notification (tenant_id, owner_user_id, kind, title, body, link)
  select p_tenant, p_user, p_kind, p_title, p_body, p_link
   where not ops.replaying(p_tenant);
$$;

-- 1 -------------------------------------------------------------------------------------------
-- Whether p_user answers for a task: ops.looks_after(task, 'modify') as them.
create function ops.answers_for(p_task ops.task, p_user uuid) returns boolean
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_was text := current_setting('app.user_id', true);
  v_ok boolean;
begin
  if p_user is null then
    return false;
  end if;
  perform set_config('app.user_id', p_user::text, true);
  v_ok := ops.looks_after(p_task, 'modify');
  perform set_config('app.user_id', coalesce(v_was, ''), true);
  return coalesce(v_ok, false);
end $$;
revoke execute on function ops.answers_for(ops.task, uuid) from public;

select core.patch_function('ops.tasks_tick(timestamptz)',
$x$    v_to := array_remove(array[v_t.assigned_by], v_t.assignee_user_id);$x$,
$x$    -- whoever gave it, if they answer for it (never someone it was routed for)
    v_to := array_remove(array[case when ops.answers_for(v_t, v_t.assigned_by)
                                    then v_t.assigned_by end], v_t.assignee_user_id);$x$);

-- 2 -------------------------------------------------------------------------------------------
-- A minibar bill is routed, not handed on: whoever checked is not its giver. Who gets the bill
-- is unchanged (ops.minibar_biller, ADR 104, 148).
select core.patch_function('ops.minibar_tasks(uuid)',
$x$            coalesce(v_b.person, v_head), v_me, p_check)
    returning * into v_t;
    if v_t.assignee_user_id is not null then$x$,
$x$            coalesce(v_b.person, v_head), v_me, p_check)
    returning * into v_t;
    -- routed, not handed on by whoever checked (ADR 145)
    update ops.task_handover set by_user = null where task_id = v_t.id;
    if v_t.assignee_user_id is not null then$x$);

-- migrate:down
