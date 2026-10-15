-- migrate:up
-- The auditor reads the access audit (ADR 153): the Auditor holds AUDIT at the company's root
-- (duty AUDITS_COMPANY), which already lets them read audit.log, but core.access_audit asked
-- for USER_ACCESS, which manages people. AUDIT at the root now opens it too, for the whole
-- company, read-only; USER_ACCESS holders keep reading it within their own scope.

do $$
declare
  v_src text := pg_get_functiondef('core.access_audit(int)'::regprocedure);
  v_gate_old text := '  if not core.can_any(''USER_ACCESS'', ''view'') then';
  v_gate_new text := '  if not (core.can_any(''USER_ACCESS'', ''view'')
          or core.can(''AUDIT'', ''view'', core.org_root(), null)) then';
  v_scope_old text := '     and core.in_user_access_scope(x.node_id, ''view'')';
  v_scope_new text := '     and (core.in_user_access_scope(x.node_id, ''view'')
          or core.can(''AUDIT'', ''view'', core.org_root(), null))';
begin
  if position(v_gate_old in v_src) = 0 or position(v_scope_old in v_src) = 0 then
    raise exception 'core.access_audit changed; update this migration';
  end if;
  execute replace(replace(v_src, v_gate_old, v_gate_new), v_scope_old, v_scope_new);
end $$;

-- migrate:down
do $$
declare
  v_src text := pg_get_functiondef('core.access_audit(int)'::regprocedure);
begin
  execute replace(replace(v_src,
    '  if not (core.can_any(''USER_ACCESS'', ''view'')
          or core.can(''AUDIT'', ''view'', core.org_root(), null)) then',
    '  if not core.can_any(''USER_ACCESS'', ''view'') then'),
    '     and (core.in_user_access_scope(x.node_id, ''view'')
          or core.can(''AUDIT'', ''view'', core.org_root(), null))',
    '     and core.in_user_access_scope(x.node_id, ''view'')');
end $$;
