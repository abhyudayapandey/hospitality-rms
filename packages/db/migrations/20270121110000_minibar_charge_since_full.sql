-- migrate:up
-- A minibar charges only what a guest used since the room was last full (ADR 168, C4).
--
-- A check charged (par - left) x price. A room not yet refilled after its last check, or refilled
-- short because the store ran out, was charged again for what was missing already. Now:
--   * what should be in the room is what its last check left plus what that check's refill put
--     back (never more than par); a room never checked is full;
--   * used (charged) = what should be there - what is left, never less than nothing;
--   * the refill puts back what the room lacks of its par (fill_qty = par - left), so a short
--     refill is made up at the next one, and charged to nobody;
--   * a room whose last refill is still open is not checked again (MINIBAR_NOT_REFILLED): its
--     count would mix two guests' use, and the refill task is the one to finish first.

alter table ops.minibar_check_line add column fill_qty numeric(14,3);
update ops.minibar_check_line set fill_qty = used_qty;
alter table ops.minibar_check_line alter column fill_qty set not null,
  add constraint minibar_fill_qty check (fill_qty >= 0);
comment on column ops.minibar_check_line.fill_qty is
  'what the refill puts back: par less what was left (used_qty is what the guest is charged)';

-- What the refill puts back, in words: "1 Lager Beer, 2 Tonic Water".
create function ops.minibar_fill_words(p_check uuid) returns text
language sql stable security definer
set search_path = pg_catalog, inv, ops
as $$
  select string_agg(trim_scale(l.fill_qty) || ' ' || i.name, ', ' order by l.id)
    from ops.minibar_check_line l join inv.item i on i.id = l.item_id
   where l.check_id = p_check and l.fill_qty > 0;
$$;
revoke execute on function ops.minibar_fill_words(uuid) from public;

-- What should be in a room of an item at p_at: what its last check before then left plus what
-- that check's refill put back, at most par; full (par) if never checked. p_except: a check
-- to leave out (the one being made).
create function ops.minibar_should_have(p_room uuid, p_item uuid, p_par numeric,
                                        p_at timestamptz, p_except uuid default null)
returns numeric
language sql stable
set search_path = pg_catalog, ops
as $$
  select coalesce(
    (select least(p_par, pl.left_qty + pl.refilled_qty)
       from ops.minibar_check_line pl
       join ops.minibar_check pc on pc.id = pl.check_id
      where pc.room_id = p_room and pc.id is distinct from p_except and pc.checked_at <= p_at
        and pl.item_id = p_item
      order by pc.checked_at desc, pc.id desc limit 1),
    p_par);
$$;
revoke execute on function ops.minibar_should_have(uuid, uuid, numeric, timestamptz, uuid)
  from public;

-- Whether a room's last refill is still open.
create function ops.minibar_refill_open(p_room uuid) returns boolean
language sql stable
set search_path = pg_catalog, ops
as $$
  select exists (select 1 from ops.task t
                   join ops.minibar_check pc on pc.id = t.minibar_check_id
                  where pc.room_id = p_room and t.kind = 'minibar_refill'
                    and t.status in ('open', 'in_progress'));
$$;
revoke execute on function ops.minibar_refill_open(uuid) from public;

-- For the check form: what should be in the room of each item now, so "All there" and the
-- charge it previews are what the check will charge; and whether its refill is still open.
create function ops.minibar_expected(p_room uuid)
returns table (item_id uuid, expected numeric, refill_open boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_room ops.room := ops.minibar_room_row(p_room);
begin
  if v_room.id is null or not core.can('MINIBAR', 'view', v_room.org_node_id, null, null) then
    raise exception 'NOT_AUTHORISED' using detail = format('room %s', p_room);
  end if;
  return query
    select l.item_id, ops.minibar_should_have(v_room.id, l.item_id, l.par, now()),
           ops.minibar_refill_open(v_room.id)
      from ops.minibar_set_line l
     where l.set_id = v_room.minibar_set_id
     order by l.position;
end $$;
revoke execute on function ops.minibar_expected(uuid) from public;
grant execute on function ops.minibar_expected(uuid) to app_rw;

-- the check: never while the last refill is open; used against what should be there
select core.patch_function('ops.check_minibar(uuid,jsonb,text)',
$x$  v_used numeric;
$x$,
$x$  v_used numeric;
  v_expected numeric;
$x$);
select core.patch_function('ops.check_minibar(uuid,jsonb,text)',
$x$  insert into ops.minibar_check (tenant_id, org_node_id, room_id, store_id, checked_at,$x$,
$x$  -- one check of a room at a time; never while its last refill is open (ADR 168)
  perform pg_advisory_xact_lock(hashtextextended('ops.minibar_room:' || v_room.id, 0));
  if ops.minibar_refill_open(v_room.id) then
    raise exception 'MINIBAR_NOT_REFILLED' using detail = format('room %s', v_room.number);
  end if;

  insert into ops.minibar_check (tenant_id, org_node_id, room_id, store_id, checked_at,$x$);
select core.patch_function('ops.check_minibar(uuid,jsonb,text)',
$x$    v_used := greatest(v_line.par - v_line."left", 0);
    insert into ops.minibar_check_line (tenant_id, org_node_id, check_id, item_id, par,
                                        left_qty, used_qty, refilled_qty, price, unit_cost)
    values (v_room.tenant_id, v_room.org_node_id, v_id, v_line.item_id, v_line.par,
            v_line."left", v_used, 0, v_line.price,$x$,
$x$    -- what should be there: what the last check left plus what its refill put back, at most
    -- par; full if never checked. The guest used what is missing of that (ADR 168).
    v_expected := ops.minibar_should_have(v_room.id, v_line.item_id, v_line.par, v_at, v_id);
    v_used := greatest(v_expected - v_line."left", 0);
    insert into ops.minibar_check_line (tenant_id, org_node_id, check_id, item_id, par,
                                        left_qty, used_qty, fill_qty, refilled_qty, price,
                                        unit_cost)
    values (v_room.tenant_id, v_room.org_node_id, v_id, v_line.item_id, v_line.par,
            v_line."left", v_used, greatest(v_line.par - v_line."left", 0), 0, v_line.price,$x$);

-- the tasks: a refill for what the room lacks, a bill for what was used
select core.patch_function('ops.minibar_tasks(uuid)',
$x$  v_used := ops.minibar_used_words(p_check);
  if v_used is null then
    return;
  end if;$x$,
$x$  v_used := ops.minibar_used_words(p_check);
  -- nothing to put back: no refill, and nothing was used either
  if ops.minibar_fill_words(p_check) is null then
    return;
  end if;$x$);
select core.patch_function('ops.minibar_tasks(uuid)',
$x$          'From ' || core.node_name(v_c.store_id) || ': ' || v_used || '.',$x$,
$x$          'From ' || core.node_name(v_c.store_id) || ': ' || ops.minibar_fill_words(p_check)
          || '.',$x$);

-- the refill puts back what the room lacks
select core.patch_function('ops.minibar_refill_at(uuid,timestamptz)',
$x$              where check_id = p_check and used_qty > refilled_qty loop
    v_refill := least(v_l.used_qty - v_l.refilled_qty,
                      greatest(inv.on_hand(v_l.item_id, v_c.store_id), 0));
    v_short := v_short or v_refill < v_l.used_qty - v_l.refilled_qty;$x$,
$x$              where check_id = p_check and fill_qty > refilled_qty loop
    v_refill := least(v_l.fill_qty - v_l.refilled_qty,
                      greatest(inv.on_hand(v_l.item_id, v_c.store_id), 0));
    v_short := v_short or v_refill < v_l.fill_qty - v_l.refilled_qty;$x$);

-- a refill task lists what to put back; a bill task what was used
select core.patch_function('ops.minibar_task_check(uuid)',
$x$                                        'item', i.name, 'qty', l.used_qty,$x$,
$x$                                        'item', i.name,
                                        'qty', case when v_t.kind = 'minibar_refill'
                                                    then l.fill_qty else l.used_qty end,$x$);
select core.patch_function('ops.minibar_task_check(uuid)',
$x$                      where l.check_id = c.id and l.used_qty > 0), '[]'::jsonb),$x$,
$x$                      where l.check_id = c.id
                        and case when v_t.kind = 'minibar_refill' then l.fill_qty
                                 else l.used_qty end > 0), '[]'::jsonb),$x$);
select core.patch_function('ops.minibar_task_check(uuid)',
$x$l.refilled_qty < l.used_qty$x$, $x$l.refilled_qty < l.fill_qty$x$);

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
select core.patch_function('ops.minibar_task_check(uuid)',
$x$l.refilled_qty < l.fill_qty$x$, $x$l.refilled_qty < l.used_qty$x$);
select core.patch_function('ops.minibar_task_check(uuid)',
$x$                      where l.check_id = c.id
                        and case when v_t.kind = 'minibar_refill' then l.fill_qty
                                 else l.used_qty end > 0), '[]'::jsonb),$x$,
$x$                      where l.check_id = c.id and l.used_qty > 0), '[]'::jsonb),$x$);
select core.patch_function('ops.minibar_task_check(uuid)',
$x$                                        'item', i.name,
                                        'qty', case when v_t.kind = 'minibar_refill'
                                                    then l.fill_qty else l.used_qty end,$x$,
$x$                                        'item', i.name, 'qty', l.used_qty,$x$);
select core.patch_function('ops.minibar_refill_at(uuid,timestamptz)',
$x$              where check_id = p_check and fill_qty > refilled_qty loop
    v_refill := least(v_l.fill_qty - v_l.refilled_qty,
                      greatest(inv.on_hand(v_l.item_id, v_c.store_id), 0));
    v_short := v_short or v_refill < v_l.fill_qty - v_l.refilled_qty;$x$,
$x$              where check_id = p_check and used_qty > refilled_qty loop
    v_refill := least(v_l.used_qty - v_l.refilled_qty,
                      greatest(inv.on_hand(v_l.item_id, v_c.store_id), 0));
    v_short := v_short or v_refill < v_l.used_qty - v_l.refilled_qty;$x$);
select core.patch_function('ops.minibar_tasks(uuid)',
$x$          'From ' || core.node_name(v_c.store_id) || ': ' || ops.minibar_fill_words(p_check)
          || '.',$x$,
$x$          'From ' || core.node_name(v_c.store_id) || ': ' || v_used || '.',$x$);
select core.patch_function('ops.minibar_tasks(uuid)',
$x$  -- nothing to put back: no refill, and nothing was used either
  if ops.minibar_fill_words(p_check) is null then
    return;
  end if;$x$,
$x$  if v_used is null then
    return;
  end if;$x$);
select core.patch_function('ops.check_minibar(uuid,jsonb,text)',
$x$    -- what should be there: what the last check left plus what its refill put back, at most
    -- par; full if never checked. The guest used what is missing of that (ADR 168).
    v_expected := ops.minibar_should_have(v_room.id, v_line.item_id, v_line.par, v_at, v_id);
    v_used := greatest(v_expected - v_line."left", 0);
    insert into ops.minibar_check_line (tenant_id, org_node_id, check_id, item_id, par,
                                        left_qty, used_qty, fill_qty, refilled_qty, price,
                                        unit_cost)
    values (v_room.tenant_id, v_room.org_node_id, v_id, v_line.item_id, v_line.par,
            v_line."left", v_used, greatest(v_line.par - v_line."left", 0), 0, v_line.price,$x$,
$x$    v_used := greatest(v_line.par - v_line."left", 0);
    insert into ops.minibar_check_line (tenant_id, org_node_id, check_id, item_id, par,
                                        left_qty, used_qty, refilled_qty, price, unit_cost)
    values (v_room.tenant_id, v_room.org_node_id, v_id, v_line.item_id, v_line.par,
            v_line."left", v_used, 0, v_line.price,$x$);
select core.patch_function('ops.check_minibar(uuid,jsonb,text)',
$x$  -- one check of a room at a time; never while its last refill is open (ADR 168)
  perform pg_advisory_xact_lock(hashtextextended('ops.minibar_room:' || v_room.id, 0));
  if ops.minibar_refill_open(v_room.id) then
    raise exception 'MINIBAR_NOT_REFILLED' using detail = format('room %s', v_room.number);
  end if;

$x$, '');
select core.patch_function('ops.check_minibar(uuid,jsonb,text)',
$x$  v_expected numeric;
$x$, '');
drop function ops.minibar_expected(uuid);
drop function ops.minibar_refill_open(uuid);
drop function ops.minibar_should_have(uuid, uuid, numeric, timestamptz, uuid);
drop function ops.minibar_fill_words(uuid);
alter table ops.minibar_check_line drop column fill_qty;
