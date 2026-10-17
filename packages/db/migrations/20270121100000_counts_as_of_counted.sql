-- migrate:up
-- A count posts the difference from what was there when each line was counted (ADR 168, C3).
--
-- A count (inv.start_count) and a stock check (inv.start_stock_check) snapshot what should be
-- left when they start. Posting "counted - snapshot" at submit counted twice whatever moved in
-- between: a receipt, a sale, a transfer or wastage was already in the stock and again in the
-- difference. Posting "counted - on hand at submit" is wrong too, for goods that move after a
-- shelf was counted. So each line keeps when it was counted (counted_at), and the difference is
-- counted - what was on hand at that moment: the stock now less every movement since
-- (inv.on_hand_at, under the ledger's lock). After posting, stock = what was counted + what
-- moved after it was counted.
--
-- An open count or check older than a day is no longer handed back: starting one closes it
-- ('expired') and starts afresh; submitting, reviewing or finishing it is refused
-- (COUNT_EXPIRED).

-- What was on hand of p_item at p_node at p_at: the stock now less every movement after p_at.
-- Takes the ledger's lock for the item (inv.ledger_apply), so nothing posts in between.
create function inv.on_hand_at(p_item uuid, p_node uuid, p_at timestamptz) returns numeric
language plpgsql
set search_path = pg_catalog, inv
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_item::text || p_node::text, 0));
  return inv.on_hand(p_item, p_node)
         - coalesce((select sum(l.qty) from inv.stock_ledger l
                      where l.item_id = p_item and l.delivery_node_id = p_node
                        and l.occurred_at > p_at), 0);
end $$;
revoke execute on function inv.on_hand_at(uuid, uuid, timestamptz) from public;

-- How long a count or check stays open.
create function inv.count_too_old(p_started timestamptz) returns boolean
language sql stable
as $$ select p_started < now() - interval '24 hours' $$;
grant execute on function inv.count_too_old(timestamptz) to app_rw;

alter table inv.stock_count drop constraint stock_count_status_check,
  add constraint stock_count_status_check check (status in ('open', 'submitted', 'expired'));
alter table inv.stock_count_line add column counted_at timestamptz;
comment on column inv.stock_count_line.system_qty is
  'what should be there: at start_count, then, once counted, what was on hand at counted_at';

alter table inv.stock_check drop constraint stock_check_status_check,
  add constraint stock_check_status_check
    check (status in ('open', 'review', 'finished', 'expired'));
drop index inv.stock_check_one_open;
create unique index stock_check_one_open on inv.stock_check (delivery_node_id)
  where status in ('open', 'review');
comment on column inv.stock_check_line.expected_qty is
  'what should be there: at the start, then, once counted, what was on hand at counted_at';

-- What each counted line of a check should show: on hand when it was counted.
create function inv.check_expected_as_counted(p_check uuid) returns void
language sql
set search_path = pg_catalog, inv
as $$
  -- a phone's clock behind the check's start: as counted when the check started
  update inv.stock_check_line l
     set expected_qty = inv.on_hand_at(l.item_id, l.delivery_node_id,
                                       greatest(l.counted_at, c.started_at))
    from inv.stock_check c
   where c.id = p_check and l.check_id = p_check and l.counted_qty is not null
     and l.counted_at is not null;
$$;
revoke execute on function inv.check_expected_as_counted(uuid) from public;

-- start_count: an old open count closes; a new one starts
select core.patch_function('inv.start_count(uuid)',
$x$  select id into v_id from inv.stock_count
   where delivery_node_id = p_node and status = 'open' order by started_at limit 1;$x$,
$x$  -- an open count older than a day is closed, never handed back (ADR 168)
  update inv.stock_count set status = 'expired'
   where delivery_node_id = p_node and status = 'open' and inv.count_too_old(started_at);
  select id into v_id from inv.stock_count
   where delivery_node_id = p_node and status = 'open' order by started_at, id limit 1;$x$);

-- submit_count: each line's time, the difference from on hand then
select core.patch_function('inv.submit_count(uuid,jsonb)',
$x$  if v_count.status = 'open' then
    if jsonb_typeof(p_lines) is distinct from 'array' then$x$,
$x$  if v_count.status = 'expired'
     or (v_count.status = 'open' and inv.count_too_old(v_count.started_at)) then
    perform inv.fail('COUNT_EXPIRED', 'the count was started over a day ago');
  end if;
  if v_count.status = 'open' then
    if jsonb_typeof(p_lines) is distinct from 'array' then$x$);
select core.patch_function('inv.submit_count(uuid,jsonb)',
$x$    for v_line in select * from jsonb_to_recordset(p_lines) as l(item_id uuid, counted_qty numeric) loop$x$,
$x$    -- when each line was counted: its time (counted_at), or how long ago (ago_ms, from the
    -- phone, which needs no clock of its own), else now; never before the count started
    -- nor after now (ADR 168)
    for v_line in select l.item_id, l.counted_qty,
                         greatest(v_count.started_at, least(now(),
                           coalesce(l.counted_at,
                                    now() - make_interval(secs => greatest(l.ago_ms, 0) / 1000.0),
                                    now()))) as counted_at
                    from jsonb_to_recordset(p_lines)
                      as l(item_id uuid, counted_qty numeric, counted_at timestamptz,
                           ago_ms numeric) loop$x$);
select core.patch_function('inv.submit_count(uuid,jsonb)',
$x$      update inv.stock_count_line set counted_qty = v_line.counted_qty
       where count_id = p_count_id and item_id = v_line.item_id;
      if not found then
        perform inv.fail('INVALID_ITEM', 'item is not on this count');
      end if;
    end loop;
$x$,
$x$      update inv.stock_count_line
         set counted_qty = v_line.counted_qty, counted_at = v_line.counted_at
       where count_id = p_count_id and item_id = v_line.item_id;
      if not found then
        perform inv.fail('INVALID_ITEM', 'item is not on this count');
      end if;
    end loop;
    -- what should be there is what was on hand when each line was counted, not at the start:
    -- what moved in between is in the stock already (ADR 168)
    update inv.stock_count_line cl
       set system_qty = inv.on_hand_at(cl.item_id, cl.delivery_node_id, cl.counted_at)
     where cl.count_id = p_count_id and cl.counted_qty is not null;
$x$);

-- start_stock_check: an old unfinished check closes; a new one starts
select core.patch_function('inv.start_stock_check(uuid,text,text)',
$x$  select id into v_id from inv.stock_check
   where delivery_node_id = p_node and status <> 'finished' order by started_at limit 1;$x$,
$x$  -- an unfinished check older than a day is closed, never handed back (ADR 168)
  update inv.stock_check set status = 'expired'
   where delivery_node_id = p_node and status in ('open', 'review')
     and inv.count_too_old(started_at);
  select id into v_id from inv.stock_check
   where delivery_node_id = p_node and status in ('open', 'review')
   order by started_at, id limit 1;$x$);

-- record_check_line: refused on an old check
select core.patch_function(
  'inv.record_check_line(uuid,uuid,numeric,text,text,timestamptz,text,numeric,integer)',
$x$  if v_check.status = 'finished' then perform inv.fail('CHECK_FINISHED', null); end if;$x$,
$x$  if v_check.status = 'finished' then perform inv.fail('CHECK_FINISHED', null); end if;
  if v_check.status = 'expired' or inv.count_too_old(v_check.started_at) then
    perform inv.fail('COUNT_EXPIRED', 'the check was started over a day ago');
  end if;$x$);

-- review: the differences from what was on hand when each line was counted
select core.patch_function('inv.review_stock_check(uuid)',
$x$  perform inv.require('STOCK_CHECK', 'modify', v_check.delivery_node_id);
  if v_check.status = 'open' then$x$,
$x$  perform inv.require('STOCK_CHECK', 'modify', v_check.delivery_node_id);
  if v_check.status = 'expired' or inv.count_too_old(v_check.started_at) then
    perform inv.fail('COUNT_EXPIRED', 'the check was started over a day ago');
  end if;
  if v_check.status in ('open', 'review') then
    perform inv.check_expected_as_counted(p_check);
  end if;
  if v_check.status = 'open' then$x$);

-- finish: the same, again, under the ledger's lock, then post
select core.patch_function('inv.finish_stock_check(uuid)',
$x$  if v_check.status <> 'review' then perform inv.fail('CHECK_NOT_REVIEWED', null); end if;
$x$,
$x$  if v_check.status = 'expired' or inv.count_too_old(v_check.started_at) then
    perform inv.fail('COUNT_EXPIRED', 'the check was started over a day ago');
  end if;
  if v_check.status <> 'review' then perform inv.fail('CHECK_NOT_REVIEWED', null); end if;
  -- what should be there is what was on hand when each line was counted (ADR 168)
  perform inv.check_expected_as_counted(p_check);
$x$);

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
select core.patch_function('inv.finish_stock_check(uuid)',
$x$  if v_check.status = 'expired' or inv.count_too_old(v_check.started_at) then
    perform inv.fail('COUNT_EXPIRED', 'the check was started over a day ago');
  end if;
  if v_check.status <> 'review' then perform inv.fail('CHECK_NOT_REVIEWED', null); end if;
  -- what should be there is what was on hand when each line was counted (ADR 168)
  perform inv.check_expected_as_counted(p_check);
$x$,
$x$  if v_check.status <> 'review' then perform inv.fail('CHECK_NOT_REVIEWED', null); end if;
$x$);
select core.patch_function('inv.review_stock_check(uuid)',
$x$  if v_check.status = 'expired' or inv.count_too_old(v_check.started_at) then
    perform inv.fail('COUNT_EXPIRED', 'the check was started over a day ago');
  end if;
  if v_check.status in ('open', 'review') then
    perform inv.check_expected_as_counted(p_check);
  end if;
$x$, '');
select core.patch_function(
  'inv.record_check_line(uuid,uuid,numeric,text,text,timestamptz,text,numeric,integer)',
$x$
  if v_check.status = 'expired' or inv.count_too_old(v_check.started_at) then
    perform inv.fail('COUNT_EXPIRED', 'the check was started over a day ago');
  end if;$x$, '');
select core.patch_function('inv.start_stock_check(uuid,text,text)',
$x$  -- an unfinished check older than a day is closed, never handed back (ADR 168)
  update inv.stock_check set status = 'expired'
   where delivery_node_id = p_node and status in ('open', 'review')
     and inv.count_too_old(started_at);
  select id into v_id from inv.stock_check
   where delivery_node_id = p_node and status in ('open', 'review')
   order by started_at, id limit 1;$x$,
$x$  select id into v_id from inv.stock_check
   where delivery_node_id = p_node and status <> 'finished' order by started_at limit 1;$x$);
select core.patch_function('inv.submit_count(uuid,jsonb)',
$x$
    -- what should be there is what was on hand when each line was counted, not at the start:
    -- what moved in between is in the stock already (ADR 168)
    update inv.stock_count_line cl
       set system_qty = inv.on_hand_at(cl.item_id, cl.delivery_node_id, cl.counted_at)
     where cl.count_id = p_count_id and cl.counted_qty is not null;
$x$, '
');
select core.patch_function('inv.submit_count(uuid,jsonb)',
$x$      update inv.stock_count_line
         set counted_qty = v_line.counted_qty, counted_at = v_line.counted_at
       where$x$,
$x$      update inv.stock_count_line set counted_qty = v_line.counted_qty
       where$x$);
select core.patch_function('inv.submit_count(uuid,jsonb)',
$x$    -- when each line was counted: its time (counted_at), or how long ago (ago_ms, from the
    -- phone, which needs no clock of its own), else now; never before the count started
    -- nor after now (ADR 168)
    for v_line in select l.item_id, l.counted_qty,
                         greatest(v_count.started_at, least(now(),
                           coalesce(l.counted_at,
                                    now() - make_interval(secs => greatest(l.ago_ms, 0) / 1000.0),
                                    now()))) as counted_at
                    from jsonb_to_recordset(p_lines)
                      as l(item_id uuid, counted_qty numeric, counted_at timestamptz,
                           ago_ms numeric) loop$x$,
$x$    for v_line in select * from jsonb_to_recordset(p_lines) as l(item_id uuid, counted_qty numeric) loop$x$);
select core.patch_function('inv.submit_count(uuid,jsonb)',
$x$  if v_count.status = 'expired'
     or (v_count.status = 'open' and inv.count_too_old(v_count.started_at)) then
    perform inv.fail('COUNT_EXPIRED', 'the count was started over a day ago');
  end if;
$x$, '');
select core.patch_function('inv.start_count(uuid)',
$x$  -- an open count older than a day is closed, never handed back (ADR 168)
  update inv.stock_count set status = 'expired'
   where delivery_node_id = p_node and status = 'open' and inv.count_too_old(started_at);
  select id into v_id from inv.stock_count
   where delivery_node_id = p_node and status = 'open' order by started_at, id limit 1;$x$,
$x$  select id into v_id from inv.stock_count
   where delivery_node_id = p_node and status = 'open' order by started_at limit 1;$x$);
drop function inv.check_expected_as_counted(uuid);
drop index inv.stock_check_one_open;
create unique index stock_check_one_open on inv.stock_check (delivery_node_id)
  where status <> 'finished';
alter table inv.stock_check drop constraint stock_check_status_check,
  add constraint stock_check_status_check check (status in ('open', 'review', 'finished'));
alter table inv.stock_count_line drop column counted_at;
alter table inv.stock_count drop constraint stock_count_status_check,
  add constraint stock_count_status_check check (status in ('open', 'submitted'));
drop function inv.count_too_old(timestamptz);
drop function inv.on_hand_at(uuid, uuid, timestamptz);
