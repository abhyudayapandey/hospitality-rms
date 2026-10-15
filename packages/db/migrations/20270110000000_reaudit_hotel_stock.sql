-- migrate:up
-- The re-audit's hotel and stock fixes (ADR 160).
--
-- * Report a problem's Where offers only the places the outlet has: parking at a hotel; a
--   terrace or a garden at a hotel, or where one of the outlet's floor sections is called that.
-- * One rule for "past its use-by": a dated batch is past it once its use-by business day
--   (04:00 to 04:00 in the store's time zone, ops.tz_of) is over (inv.past_use_by). Expired,
--   Push today and a store's batches all read it, so a batch is never on Push and Expired at
--   once, and never on neither.
-- * The test data's orders carry no "Test data PO-1" note: an order is known by its number.

-- Replaces one piece of a function's current definition, failing if it is not there.
create or replace function pg_temp.patch(p_sig text, p_old text, p_new text) returns void
language plpgsql as $$
declare
  v_def text := pg_get_functiondef(p_sig::regprocedure);
begin
  if position(p_old in v_def) = 0 then
    raise exception '%: expected text not found: %', p_sig, p_old;
  end if;
  execute replace(v_def, p_old, p_new);
end $$;

-- where a problem is ----------------------------------------------------------------------

create or replace function ops.maintenance_wheres(p_place uuid) returns setof text
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  with o as (
    select n.id, n.code, n.outlet_format, n.tenant_id
      from core.hierarchy_node n
     where n.id = core.nearest(p_place, array['outlet']) and n.tenant_id = core.my_tenant()
  ),
  dept(code, department) as (
    values ('restaurant', 'RESTAURANT'), ('bar', 'BAR'), ('kitchen', 'KITCHEN'),
           ('banquet_hall', 'BANQUETS'), ('laundry', 'HOUSEKEEPING')
  ),
  -- the outlet's floor sections, by name ("Terrace", "Garden tables")
  sections as (
    select lower(s.name) as name
      from o
      join core.hierarchy_node d on d.parent_id = o.id and d.archived_at is null
      join ops.service_section s on s.org_node_id = d.id and s.archived_at is null
  )
  select w.code
    from o cross join unnest(ops.maintenance_where_codes()) with ordinality w(code, ord)
   where case
           when w.code = 'room' then exists (select 1 from ops.room r
                                              where r.org_node_id = o.id and r.archived_at is null)
           when w.code in ('pool', 'parking') then o.outlet_format = 'hotel'
           when w.code in ('terrace', 'garden') then
             o.outlet_format = 'hotel'
             or exists (select 1 from sections s where s.name like '%' || w.code || '%')
           when w.code in (select d.code from dept d) then exists (
             select 1 from core.hierarchy_node d join dept x on x.code = w.code
              where d.parent_id = o.id and d.kind = 'department' and d.archived_at is null
                and d.code = o.code || '-' || x.department)
           else true
         end
   order by w.ord;
$$;

-- past its use-by ---------------------------------------------------------------------------

-- A dated batch is past its use-by once the business day it is good for is over. The batch's
-- expiry is already that day's end (inv.expiry_at); the rule reads the day, so an instant
-- anywhere in the use-by day gives the same answer.
create function inv.past_use_by(p_expires timestamptz, p_tz text,
                                p_now timestamptz default now()) returns boolean
language sql stable
set search_path = pg_catalog
as $$
  select rpt.business_date(p_expires, coalesce(p_tz, 'UTC'))
           < rpt.business_date(p_now, coalesce(p_tz, 'UTC'))
$$;
revoke execute on function inv.past_use_by(timestamptz, text, timestamptz) from public;
grant execute on function inv.past_use_by(timestamptz, text, timestamptz) to app_rw, wf_executor;

-- Expired (Stock → Expired, Home's banner): a batch past its use-by
select pg_temp.patch('inv.expiry_list(integer)',
  'b.expires_at, b.remaining, b.expires_at <= now(), null::uuid',
  'b.expires_at, b.remaining, inv.past_use_by(b.expires_at, z.tz), null::uuid');
select pg_temp.patch('inv.expiry_list(integer)',
  'and (b.expires_at <= now()
              or rpt.business_date(b.expires_at, z.tz)',
  'and (inv.past_use_by(b.expires_at, z.tz)
              or rpt.business_date(b.expires_at, z.tz)');

-- Push today: only what is still good today
select pg_temp.patch('inv.expiring_soon(uuid, timestamptz)',
  'and b.remaining > 0 and b.expires_at > p_now',
  'and b.remaining > 0 and not inv.past_use_by(b.expires_at, z.tz, p_now)');

-- a store's batches (Make, an item's page)
select pg_temp.patch('inv.batches(uuid)',
  'b.remaining, b.expires_at <= now(), p.id,',
  'b.remaining, inv.past_use_by(b.expires_at, ops.tz_of(p_store)), p.id,');

-- the test data's orders: known by their number --------------------------------------------

update inv.purchase_order set notes = null
 where notes ~ '^Test data PO-[0-9]+$' and idempotency_key like 'test-data po %';

drop function pg_temp.patch(text, text, text);

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous rules for local work.
create or replace function pg_temp.patch(p_sig text, p_old text, p_new text) returns void
language plpgsql as $$
declare
  v_def text := pg_get_functiondef(p_sig::regprocedure);
begin
  if position(p_old in v_def) = 0 then
    raise exception '%: expected text not found: %', p_sig, p_old;
  end if;
  execute replace(v_def, p_old, p_new);
end $$;
select pg_temp.patch('inv.batches(uuid)',
  'b.remaining, inv.past_use_by(b.expires_at, ops.tz_of(p_store)), p.id,',
  'b.remaining, b.expires_at <= now(), p.id,');
select pg_temp.patch('inv.expiring_soon(uuid, timestamptz)',
  'and b.remaining > 0 and not inv.past_use_by(b.expires_at, z.tz, p_now)',
  'and b.remaining > 0 and b.expires_at > p_now');
select pg_temp.patch('inv.expiry_list(integer)',
  'b.expires_at, b.remaining, inv.past_use_by(b.expires_at, z.tz), null::uuid',
  'b.expires_at, b.remaining, b.expires_at <= now(), null::uuid');
select pg_temp.patch('inv.expiry_list(integer)',
  'and (inv.past_use_by(b.expires_at, z.tz)
              or rpt.business_date(b.expires_at, z.tz)',
  'and (b.expires_at <= now()
              or rpt.business_date(b.expires_at, z.tz)');
drop function inv.past_use_by(timestamptz, text, timestamptz);

drop function pg_temp.patch(text, text, text);
