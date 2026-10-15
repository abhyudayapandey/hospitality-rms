-- migrate:up
-- Give rooms lists who is on shift today first (ADR 153). The executive housekeeper gives rooms
-- at the outlet (ops.gives_rooms: ROOMS modify there and TASKS modify at its housekeeping),
-- but ops.on_shift_today asked for TASKS modify at the outlet itself, so her page failed.
-- Whoever gives rooms at an outlet may now ask who is on shift there; nothing else changes.

do $$
declare
  v_src text := pg_get_functiondef('ops.on_shift_today(uuid)'::regprocedure);
  v_old text := '  if not core.can(''TASKS'', ''modify'', p_node, null) then';
  v_new text := '  if not (core.can(''TASKS'', ''modify'', p_node, null) or ops.gives_rooms(p_node)) then';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'ops.on_shift_today changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- migrate:down
do $$
declare
  v_src text := pg_get_functiondef('ops.on_shift_today(uuid)'::regprocedure);
begin
  execute replace(v_src,
    '  if not (core.can(''TASKS'', ''modify'', p_node, null) or ops.gives_rooms(p_node)) then',
    '  if not core.can(''TASKS'', ''modify'', p_node, null) then');
end $$;
