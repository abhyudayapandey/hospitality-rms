-- migrate:up
-- A reading out of range tells the lead in plain words (QA of the Passport Hotel demo).
--
-- The alert read "pH is 8 pH": the unit was said again when it is the reading's own name. It now
-- leaves the unit out then ("pH is 8"), and figures lose their trailing zeros ("7.4", not
-- "7.400"; "Acceptable: 7.2 to 7.8").

select core.patch_function('ops.complete_step(uuid, uuid, jsonb)',
$x$                            format('%s: %s is %s%s', v_t.title, v_s.label, v_num,
                                   coalesce(' ' || v_s.unit, '')),$x$,
$x$                            format('%s: %s is %s%s', v_t.title, v_s.label, trim_scale(v_num),
                                   case when lower(btrim(v_s.unit)) = lower(btrim(v_s.label))
                                        then '' else coalesce(' ' || v_s.unit, '') end),$x$);
select core.patch_function('ops.complete_step(uuid, uuid, jsonb)',
$x$                                   coalesce(v_s.min_value::text, '…'),
                                   coalesce(v_s.max_value::text, '…'),
                                   btrim(p_value ->> 'action')));$x$,
$x$                                   coalesce(trim_scale(v_s.min_value)::text, '…'),
                                   coalesce(trim_scale(v_s.max_value)::text, '…'),
                                   btrim(p_value ->> 'action')));$x$);

-- migrate:down
select core.patch_function('ops.complete_step(uuid, uuid, jsonb)',
$x$                                   coalesce(trim_scale(v_s.min_value)::text, '…'),
                                   coalesce(trim_scale(v_s.max_value)::text, '…'),
                                   btrim(p_value ->> 'action')));$x$,
$x$                                   coalesce(v_s.min_value::text, '…'),
                                   coalesce(v_s.max_value::text, '…'),
                                   btrim(p_value ->> 'action')));$x$);
select core.patch_function('ops.complete_step(uuid, uuid, jsonb)',
$x$                            format('%s: %s is %s%s', v_t.title, v_s.label, trim_scale(v_num),
                                   case when lower(btrim(v_s.unit)) = lower(btrim(v_s.label))
                                        then '' else coalesce(' ' || v_s.unit, '') end),$x$,
$x$                            format('%s: %s is %s%s', v_t.title, v_s.label, v_num,
                                   coalesce(' ' || v_s.unit, '')),$x$);
