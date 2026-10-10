-- migrate:up
-- The roster by person (ADR 082, 097): each person's shift that day comes with its name and
-- times, so a shift added by hand (no shift type) shows as theirs instead of as Off.
select core.patch_function('hr.roster_day(uuid, date)',
$x$               'template_id', a.template_id, 'shift_id', a.shift_id, 'status', a.status)$x$,
$x$               'template_id', a.template_id, 'shift_id', a.shift_id, 'status', a.status,
               'shift_name', a.shift_name,
               'start', to_char(a.start_at at time zone v_tz, 'HH24:MI'),
               'end', to_char(a.end_at at time zone v_tz, 'HH24:MI'))$x$);
select core.patch_function('hr.roster_day(uuid, date)',
$x$          select s.template_id, s.id as shift_id, s.status
            from hr.shift_assignment x join hr.shift s on s.id = x.shift_id$x$,
$x$          select s.template_id, s.id as shift_id, s.status, s.start_at, s.end_at,
                 (select t.name from hr.shift_template t where t.id = s.template_id) as shift_name
            from hr.shift_assignment x join hr.shift s on s.id = x.shift_id$x$);

-- migrate:down
select core.patch_function('hr.roster_day(uuid, date)',
$x$          select s.template_id, s.id as shift_id, s.status, s.start_at, s.end_at,
                 (select t.name from hr.shift_template t where t.id = s.template_id) as shift_name
            from hr.shift_assignment x join hr.shift s on s.id = x.shift_id$x$,
$x$          select s.template_id, s.id as shift_id, s.status
            from hr.shift_assignment x join hr.shift s on s.id = x.shift_id$x$);
select core.patch_function('hr.roster_day(uuid, date)',
$x$               'template_id', a.template_id, 'shift_id', a.shift_id, 'status', a.status,
               'shift_name', a.shift_name,
               'start', to_char(a.start_at at time zone v_tz, 'HH24:MI'),
               'end', to_char(a.end_at at time zone v_tz, 'HH24:MI'))$x$,
$x$               'template_id', a.template_id, 'shift_id', a.shift_id, 'status', a.status)$x$);
