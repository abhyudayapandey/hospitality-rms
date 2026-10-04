-- migrate:up

-- An item expires on a date, not at a time of day (ADR 046). A batch's use-by is the date
-- of its expiry time in the business day (04:00 to 04:00), and it is good until that day
-- ends: made at 10:00 with a 24 hour shelf life, it is still good at 03:00 the next night,
-- and expired from 04:00. Before, "expired" meant the exact minute, so a batch showed
-- "Expired" on its own use-by date.
--
-- One place decides: inv.batch_rows returns each batch's expiry as the last instant of its
-- use-by day, and everything that compares it with now() (the lists, the banners, the
-- Stock position, the expiry task, the morning alert) is right without change. The few
-- places that worked out a calendar date from it, or compared the raw ledger value, are
-- patched here. Nothing stored changes, so no backfill.

create function inv.expiry_at(p_at timestamptz, p_tz text) returns timestamptz
language sql immutable
set search_path = pg_catalog
as $$ select rpt.day_start(rpt.business_date(p_at, p_tz) + 1, p_tz) - interval '1 microsecond' $$;

grant execute on function inv.expiry_at(timestamptz, text) to app_rw, wf_executor;

create or replace function inv.batch_rows(p_item uuid, p_store uuid)
returns table (ledger_id uuid, batch_no text, made_at timestamptz, expires_at timestamptz,
               qty numeric, remaining numeric)
language sql stable
set search_path = pg_catalog, inv, ops, rpt
as $$
  with on_hand as (
    select coalesce(sum(l.qty), 0) as q from inv.stock_ledger l
     where l.item_id = p_item and l.delivery_node_id = p_store
  ), inflow as (
    select l.id, l.batch_no, l.occurred_at, l.expires_at, l.qty,
           coalesce(sum(l.qty) over (order by l.occurred_at desc, l.id desc
                                     rows between unbounded preceding and 1 preceding), 0) as newer
      from inv.stock_ledger l
     where l.item_id = p_item and l.delivery_node_id = p_store and l.expires_at is not null
       and l.qty > 0
  )
  select i.id, i.batch_no, i.occurred_at,
         inv.expiry_at(i.expires_at, coalesce(ops.tz_of(p_store), 'UTC')), i.qty,
         greatest(0, least(i.qty, o.q - i.newer))
    from inflow i, on_hand o
   order by i.expires_at;
$$;

-- Replaces one piece of a function's current definition, failing if it is not there.
create function pg_temp.patch(p_sig text, p_old text, p_new text) returns void
language plpgsql as $$
declare
  v_def text := pg_get_functiondef(p_sig::regprocedure);
begin
  if position(p_old in v_def) = 0 then
    raise exception '%: expected text not found: %', p_sig, p_old;
  end if;
  execute replace(v_def, p_old, p_new);
end $$;

-- Which stores have something left that has not expired: by the use-by day.
select pg_temp.patch('inv.expiring_soon(uuid, timestamptz)',
  'and l.expires_at > p_now)', 'and inv.expiry_at(l.expires_at, z.tz) > p_now)');
select pg_temp.patch('ops.expiry_alerts(timestamptz)',
  'and l.expires_at > p_now)',
  'and inv.expiry_at(l.expires_at, coalesce(ops.tz_of(n.id), ''UTC'')) > p_now)');
-- The date shown, and counted, is the use-by day, not the calendar date of the instant.
select pg_temp.patch('ops.expiry_alerts(timestamptz)',
  'to_char(x.first_expiry at time zone v_tz, ''Dy FMDD Mon'')',
  'to_char(rpt.business_date(x.first_expiry, v_tz), ''Dy FMDD Mon'')');
select pg_temp.patch('inv.expiry_list(integer)',
  '(b.expires_at at time zone z.tz)::date <= (now() at time zone z.tz)::date + p_days',
  'rpt.business_date(b.expires_at, z.tz) <= rpt.business_date(now(), z.tz) + p_days');
select pg_temp.patch('rpt.store_items(uuid)',
  '(b.expires_at at time zone coalesce(v_tz, ''UTC''))::date <= (now() at time zone coalesce(v_tz, ''UTC''))::date + 3',
  'rpt.business_date(b.expires_at, coalesce(v_tz, ''UTC'')) <= rpt.business_date(now(), coalesce(v_tz, ''UTC'')) + 3');
select pg_temp.patch('ops.report_expired(uuid, uuid, text)',
  'to_char(v_b.expires_at at time zone ops.tz_of(v_team), ''DD Mon HH24:MI'')',
  'to_char(rpt.business_date(v_b.expires_at, coalesce(ops.tz_of(v_team), ''UTC'')), ''DD Mon'')');

-- migrate:down

create function pg_temp.patch(p_sig text, p_old text, p_new text) returns void
language plpgsql as $$
declare
  v_def text := pg_get_functiondef(p_sig::regprocedure);
begin
  if position(p_old in v_def) = 0 then
    raise exception '%: expected text not found: %', p_sig, p_old;
  end if;
  execute replace(v_def, p_old, p_new);
end $$;

select pg_temp.patch('ops.report_expired(uuid, uuid, text)',
  'to_char(rpt.business_date(v_b.expires_at, coalesce(ops.tz_of(v_team), ''UTC'')), ''DD Mon'')',
  'to_char(v_b.expires_at at time zone ops.tz_of(v_team), ''DD Mon HH24:MI'')');
select pg_temp.patch('rpt.store_items(uuid)',
  'rpt.business_date(b.expires_at, coalesce(v_tz, ''UTC'')) <= rpt.business_date(now(), coalesce(v_tz, ''UTC'')) + 3',
  '(b.expires_at at time zone coalesce(v_tz, ''UTC''))::date <= (now() at time zone coalesce(v_tz, ''UTC''))::date + 3');
select pg_temp.patch('inv.expiry_list(integer)',
  'rpt.business_date(b.expires_at, z.tz) <= rpt.business_date(now(), z.tz) + p_days',
  '(b.expires_at at time zone z.tz)::date <= (now() at time zone z.tz)::date + p_days');
select pg_temp.patch('ops.expiry_alerts(timestamptz)',
  'to_char(rpt.business_date(x.first_expiry, v_tz), ''Dy FMDD Mon'')',
  'to_char(x.first_expiry at time zone v_tz, ''Dy FMDD Mon'')');
select pg_temp.patch('ops.expiry_alerts(timestamptz)',
  'and inv.expiry_at(l.expires_at, coalesce(ops.tz_of(n.id), ''UTC'')) > p_now)',
  'and l.expires_at > p_now)');
select pg_temp.patch('inv.expiring_soon(uuid, timestamptz)',
  'and inv.expiry_at(l.expires_at, z.tz) > p_now)', 'and l.expires_at > p_now)');

create or replace function inv.batch_rows(p_item uuid, p_store uuid)
returns table (ledger_id uuid, batch_no text, made_at timestamptz, expires_at timestamptz,
               qty numeric, remaining numeric)
language sql stable
set search_path = pg_catalog, inv
as $$
  with on_hand as (
    select coalesce(sum(l.qty), 0) as q from inv.stock_ledger l
     where l.item_id = p_item and l.delivery_node_id = p_store
  ), inflow as (
    select l.id, l.batch_no, l.occurred_at, l.expires_at, l.qty,
           coalesce(sum(l.qty) over (order by l.occurred_at desc, l.id desc
                                     rows between unbounded preceding and 1 preceding), 0) as newer
      from inv.stock_ledger l
     where l.item_id = p_item and l.delivery_node_id = p_store and l.expires_at is not null
       and l.qty > 0
  )
  select i.id, i.batch_no, i.occurred_at, i.expires_at, i.qty,
         greatest(0, least(i.qty, o.q - i.newer))
    from inflow i, on_hand o
   order by i.expires_at;
$$;

drop function inv.expiry_at(timestamptz, text);
