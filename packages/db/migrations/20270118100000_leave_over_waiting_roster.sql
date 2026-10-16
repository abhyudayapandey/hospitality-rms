-- migrate:up
-- Leave over a roster change waiting for Publish (ADR 164). Approving leave failed in the
-- executor: hr.leave.apply dropped an assignment its manager had taken the person off (coming
-- off, ADR 135), and the check "coming off only while assigned" refused the row. Any writer
-- that takes an assignment off 'assigned' (leave, a swap, a cancelled shift, Publish, Start
-- again) had the same trap, so the table clears the flag itself, whoever writes.
create function hr.assignment_clear_coming_off() returns trigger
language plpgsql
set search_path = pg_catalog, hr
as $$
begin
  if new.status <> 'assigned' then
    new.coming_off := false;
  end if;
  return new;
end $$;
create trigger clear_coming_off before update of status on hr.shift_assignment
  for each row execute function hr.assignment_clear_coming_off();

-- A shift a person is put on while the week waits for Publish ('pending') is dropped by
-- approved leave too: Publish would otherwise put them on a day of leave.
select core.patch_function('hr.leave_shifts(uuid)',
  $x$a.worker_id = l.worker_id and a.status = 'assigned'$x$,
  $x$a.worker_id = l.worker_id and a.status in ('assigned', 'pending')$x$);

-- migrate:down
select core.patch_function('hr.leave_shifts(uuid)',
  $x$a.worker_id = l.worker_id and a.status in ('assigned', 'pending')$x$,
  $x$a.worker_id = l.worker_id and a.status = 'assigned'$x$);
drop trigger if exists clear_coming_off on hr.shift_assignment;
drop function if exists hr.assignment_clear_coming_off();
