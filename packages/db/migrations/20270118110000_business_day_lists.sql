-- migrate:up
-- Task lists by the business day (ADR 164). Team tasks, its late counts and Home's department
-- tiles took a task's calendar day: a Lock-up due at 00:00 on the 17th fell on the 17th,
-- though the night it closes is the 16th's (the day starts at 04:00 in the outlet's time
-- zone, ADR 046, 148). Each list now keeps the tasks due inside its business days' window,
-- as rpt.days_window does, and the completion table's week starts on Monday at 04:00.
select core.patch_function('ops.team_tasks(uuid, date, date)',
  $x$and (t.due_at at time zone v_tz)::date between p_from and p_to$x$,
  $x$and t.due_at >= (p_from + time '04:00') at time zone v_tz
       and t.due_at < (p_to + 1 + time '04:00') at time zone v_tz$x$);
select core.patch_function('ops.late_count(uuid, date, date)',
  $x$and (t.due_at at time zone v_tz)::date between p_from and p_to$x$,
  $x$and t.due_at >= (p_from + time '04:00') at time zone v_tz
       and t.due_at < (p_to + 1 + time '04:00') at time zone v_tz$x$);
select core.patch_function('ops.late_counts(uuid[], date, date)',
  $x$and (l.due_at at time zone p.tz)::date between p_from and p_to$x$,
  $x$and l.due_at >= (p_from + time '04:00') at time zone p.tz
       and l.due_at < (p_to + 1 + time '04:00') at time zone p.tz$x$);
select core.patch_function('ops.completion(uuid, date)',
  $x$and t.due_at >= (p_week_start::timestamp at time zone v_tz)
         and t.due_at < ((p_week_start + 7)::timestamp at time zone v_tz)$x$,
  $x$and t.due_at >= (p_week_start + time '04:00') at time zone v_tz
         and t.due_at < (p_week_start + 7 + time '04:00') at time zone v_tz$x$);

-- migrate:down
select core.patch_function('ops.team_tasks(uuid, date, date)',
  $x$and t.due_at >= (p_from + time '04:00') at time zone v_tz
       and t.due_at < (p_to + 1 + time '04:00') at time zone v_tz$x$,
  $x$and (t.due_at at time zone v_tz)::date between p_from and p_to$x$);
select core.patch_function('ops.late_count(uuid, date, date)',
  $x$and t.due_at >= (p_from + time '04:00') at time zone v_tz
       and t.due_at < (p_to + 1 + time '04:00') at time zone v_tz$x$,
  $x$and (t.due_at at time zone v_tz)::date between p_from and p_to$x$);
select core.patch_function('ops.late_counts(uuid[], date, date)',
  $x$and l.due_at >= (p_from + time '04:00') at time zone p.tz
       and l.due_at < (p_to + 1 + time '04:00') at time zone p.tz$x$,
  $x$and (l.due_at at time zone p.tz)::date between p_from and p_to$x$);
select core.patch_function('ops.completion(uuid, date)',
  $x$and t.due_at >= (p_week_start + time '04:00') at time zone v_tz
         and t.due_at < (p_week_start + 7 + time '04:00') at time zone v_tz$x$,
  $x$and t.due_at >= (p_week_start::timestamp at time zone v_tz)
         and t.due_at < ((p_week_start + 7)::timestamp at time zone v_tz)$x$);
