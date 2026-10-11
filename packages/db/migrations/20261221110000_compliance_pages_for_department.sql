-- migrate:up
-- A licence's or a regular job's own page opens for whoever its Compliance list shows it to
-- (ADR 124): the role named on it and its department's head, read only. Its history said "no
-- such licence" to them while the list showed it (ADR 130).
select core.patch_function('ops.licence_history(uuid)',
$x$  if not found or not (core.can('COMPLIANCE', 'view', v_l.org_node_id, null)$x$,
$x$  if not found or not (core.can('COMPLIANCE', 'view', v_l.org_node_id, null)
                       or ops.department_sees(v_l.org_node_id, array[v_l.renewal_role])$x$);
select core.patch_function('ops.compliance_history(uuid)',
$x$  if not found or not (core.can('COMPLIANCE', 'view', v_i.org_node_id, null)$x$,
$x$  if not found or not (core.can('COMPLIANCE', 'view', v_i.org_node_id, null)
                       or ops.department_sees(v_i.org_node_id, array[v_i.owner_role, v_i.doer_role])$x$);

-- migrate:down
select core.patch_function('ops.compliance_history(uuid)',
$x$  if not found or not (core.can('COMPLIANCE', 'view', v_i.org_node_id, null)
                       or ops.department_sees(v_i.org_node_id, array[v_i.owner_role, v_i.doer_role])$x$,
$x$  if not found or not (core.can('COMPLIANCE', 'view', v_i.org_node_id, null)$x$);
select core.patch_function('ops.licence_history(uuid)',
$x$  if not found or not (core.can('COMPLIANCE', 'view', v_l.org_node_id, null)
                       or ops.department_sees(v_l.org_node_id, array[v_l.renewal_role])$x$,
$x$  if not found or not (core.can('COMPLIANCE', 'view', v_l.org_node_id, null)$x$);
