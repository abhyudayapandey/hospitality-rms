-- migrate:up
-- A send task closes when its request is no longer waiting to be sent (ADR 168, M20).
--
-- Only giving it to someone else (inv.give_send) and sending it from the request
-- (inv.send_request) cancelled open send tasks. Sent from the transfer page
-- (inv.dispatch_transfer), rejected, withdrawn or closed, the runner's task stayed open and
-- could never be done. Now a trigger on the transfer cancels them whenever it leaves "to send":
-- sent, or no longer submitted. The task whose own button sends it (ops.send_by_task) is done
-- by it, not cancelled: that function names it in ops.sending_task for the trigger to skip.

create function inv.close_send_tasks() returns trigger
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_by text := (select display_name from core.app_user where id = core.current_user_id());
  v_skip uuid := nullif(current_setting('ops.sending_task', true), '')::uuid;
begin
  update ops.task
     set status = 'cancelled',
         cancel_reason = case
           when new.dispatched_at is not null then 'sent by ' || coalesce(v_by, 'the store')
           when new.status = 'rejected' then 'rejected'
           when new.status = 'cancelled' then 'withdrawn'
           else 'closed' end
   where transfer_id = new.id and kind = 'send' and status in ('open', 'in_progress')
     and id is distinct from v_skip;
  return null;
end $$;
revoke execute on function inv.close_send_tasks() from public;

create trigger close_send_tasks after update of status, dispatched_at on inv.transfer
  for each row
  when ((old.dispatched_at is null and new.dispatched_at is not null)
        or (old.status = 'submitted' and new.status <> 'submitted'))
  execute function inv.close_send_tasks();

-- the task that sends it is done by its own button, not cancelled by the trigger
select core.patch_function('ops.send_by_task(uuid,jsonb)',
$x$  perform set_config('app.user_id', v_t.assigned_by::text, true);
  perform inv.dispatch_transfer(v_t.transfer_id, p_lines, null);$x$,
$x$  perform set_config('app.user_id', v_t.assigned_by::text, true);
  perform set_config('ops.sending_task', v_t.id::text, true);
  perform inv.dispatch_transfer(v_t.transfer_id, p_lines, null);
  perform set_config('ops.sending_task', '', true);$x$);

-- Tasks left open by the old way: closed now.
update ops.task k
   set status = 'cancelled',
       cancel_reason = case when t.dispatched_at is not null then 'sent' else 'closed' end
  from inv.transfer t
 where k.transfer_id = t.id and k.kind = 'send' and k.status in ('open', 'in_progress')
   and (t.dispatched_at is not null or t.status <> 'submitted');

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
select core.patch_function('ops.send_by_task(uuid,jsonb)',
$x$  perform set_config('ops.sending_task', v_t.id::text, true);
  perform inv.dispatch_transfer(v_t.transfer_id, p_lines, null);
  perform set_config('ops.sending_task', '', true);$x$,
$x$  perform inv.dispatch_transfer(v_t.transfer_id, p_lines, null);$x$);
drop trigger close_send_tasks on inv.transfer;
drop function inv.close_send_tasks();
