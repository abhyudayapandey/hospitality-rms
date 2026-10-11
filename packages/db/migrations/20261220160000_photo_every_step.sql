-- migrate:up
-- A photo on every step of every task, for everyone (ADR 127): a step is not done without one,
-- a round over rooms takes one per room per step, and a task with no steps takes one before it
-- is done. The app takes them with the live camera only, never from the gallery. A sign-off,
-- a handover read and the minibar's refill and bill keep their own flows. The loader's replay of
-- a test customer's past tasks (file 30, app.replay) is the one exception: it has no camera.

create function ops.photo_waived(p_tenant uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce(current_setting('app.replay', true), '') = 'on'
     and coalesce((select t.is_test from core.tenant t where t.id = p_tenant), false);
$$;

select core.patch_function('ops.complete_step(uuid, uuid, jsonb)',
$x$  if (v_s.photo_required or v_s.kind = 'photo') and v_photo is null then
    perform ops.fail('PHOTO_REQUIRED', 'this step needs a photo');
  end if;$x$,
$x$  if v_photo is null and not ops.photo_waived(v_t.tenant_id) then
    perform ops.fail('PHOTO_REQUIRED', 'take a photo of this step');
  end if;$x$);

select core.patch_function('ops.complete_task(uuid, text)',
$x$  if exists (select 1 from ops.task_step where task_id = v_t.id and done_at is null) then
    perform ops.fail('STEPS_INCOMPLETE', 'every step needs doing first');
  end if;$x$,
$x$  if exists (select 1 from ops.task_step where task_id = v_t.id and done_at is null) then
    perform ops.fail('STEPS_INCOMPLETE', 'every step needs doing first');
  end if;
  -- a task with no steps: a photo of it done
  if not exists (select 1 from ops.task_step where task_id = v_t.id)
     and not exists (select 1 from ops.task_photo where task_id = v_t.id)
     and not ops.photo_waived(v_t.tenant_id) then
    perform ops.fail('PHOTO_REQUIRED', 'take a photo of the job done');
  end if;$x$);

revoke execute on function ops.photo_waived(uuid) from public;

-- migrate:down
select core.patch_function('ops.complete_task(uuid, text)',
$x$
  -- a task with no steps: a photo of it done
  if not exists (select 1 from ops.task_step where task_id = v_t.id)
     and not exists (select 1 from ops.task_photo where task_id = v_t.id)
     and not ops.photo_waived(v_t.tenant_id) then
    perform ops.fail('PHOTO_REQUIRED', 'take a photo of the job done');
  end if;$x$,
$x$$x$);
select core.patch_function('ops.complete_step(uuid, uuid, jsonb)',
$x$  if v_photo is null and not ops.photo_waived(v_t.tenant_id) then
    perform ops.fail('PHOTO_REQUIRED', 'take a photo of this step');
  end if;$x$,
$x$  if (v_s.photo_required or v_s.kind = 'photo') and v_photo is null then
    perform ops.fail('PHOTO_REQUIRED', 'this step needs a photo');
  end if;$x$);
drop function ops.photo_waived(uuid);
