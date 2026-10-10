-- migrate:up
-- Excise (ADR 096), the Excise block (ADR 085, domain EXCISE, delivery tree; it needs Stock).
--
-- * File 10 marks the items under excise (`excise`: liquor, wine, beer).
-- * The daily bar register of a store: for each excise item, what it held at the start of the
--   business day (ADR 057), what came in (received, from another store), went out (sold, sent
--   on, used, wasted), any count correction, and what it held at the end. Worked out from the
--   stock ledger (rule 3), so it always agrees with the stock.
-- * The monthly FLR: the same by month.
-- * Transport permits: the permit number for liquor that arrived, its day and a note (FOC
--   bottles say so in the note), kept at the store.
-- * For whoever holds EXCISE at the store: its keeper, the outlet's managers (the GM and the
--   Bar Manager), and the cost controller reads.

alter table inv.item add column excise boolean not null default false;

create table inv.excise_permit (
  id uuid primary key default core.uuid_v7(),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  permit_no text not null check (length(btrim(permit_no)) between 1 and 40),
  received_on date not null,
  note text check (length(note) <= 300)
);
select core.add_standard_columns('inv.excise_permit');
create unique index excise_permit_no on inv.excise_permit (delivery_node_id, lower(permit_no));

-- A store's excise movements between two times, item by item.
create function inv.excise_between(p_store uuid, p_from timestamptz, p_to timestamptz)
returns table (item_id uuid, item text, unit text, opening numeric, received numeric,
               sold numeric, sent numeric, used numeric, wasted numeric, adjusted numeric,
               closing numeric)
language sql stable security definer
set search_path = pg_catalog, inv
as $$
  select i.id, i.name, i.base_uom,
         coalesce(sum(l.qty) filter (where l.occurred_at < p_from), 0),
         coalesce(sum(l.qty) filter (where l.occurred_at >= p_from
                                       and l.movement_type in ('receipt', 'transfer_in')), 0),
         coalesce(-sum(l.qty) filter (where l.occurred_at >= p_from
                                        and l.movement_type = 'sales_depletion'), 0),
         coalesce(-sum(l.qty) filter (where l.occurred_at >= p_from
                                        and l.movement_type = 'transfer_out'), 0),
         coalesce(-sum(l.qty) filter (where l.occurred_at >= p_from
                                        and l.movement_type in ('consumption', 'production_out',
                                                                'production_in')), 0),
         coalesce(-sum(l.qty) filter (where l.occurred_at >= p_from
                                        and l.movement_type = 'wastage'), 0),
         coalesce(sum(l.qty) filter (where l.occurred_at >= p_from
                                       and l.movement_type = 'count_adjust'), 0),
         coalesce(sum(l.qty), 0)
    from inv.item i
    join inv.item_node x on x.item_id = i.id and x.delivery_node_id = p_store
    left join inv.stock_ledger l on l.item_id = i.id and l.delivery_node_id = p_store
                                and l.occurred_at < p_to
   where i.excise
   group by i.id, i.name, i.base_uom
   order by i.name;
$$;

-- The daily bar register: a business day (from 04:00 where the store is).
create function inv.excise_register(p_store uuid, p_day date)
returns table (item_id uuid, item text, unit text, opening numeric, received numeric,
               sold numeric, sent numeric, used numeric, wasted numeric, adjusted numeric,
               closing numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_tz text := coalesce(ops.tz_of(p_store), 'UTC');
begin
  if not core.can('EXCISE', 'view', null, p_store) then
    perform inv.fail('NOT_AUTHORISED', 'EXCISE view');
  end if;
  return query
    select * from inv.excise_between(p_store,
                                     (p_day + time '04:00') at time zone v_tz,
                                     (p_day + 1 + time '04:00') at time zone v_tz);
end $$;

-- The FLR: a month, from the first business day to the last.
create function inv.excise_month(p_store uuid, p_month date)
returns table (item_id uuid, item text, unit text, opening numeric, received numeric,
               sold numeric, sent numeric, used numeric, wasted numeric, adjusted numeric,
               closing numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_tz text := coalesce(ops.tz_of(p_store), 'UTC');
  v_from date := date_trunc('month', p_month)::date;
begin
  if not core.can('EXCISE', 'view', null, p_store) then
    perform inv.fail('NOT_AUTHORISED', 'EXCISE view');
  end if;
  return query
    select * from inv.excise_between(p_store,
                                     (v_from + time '04:00') at time zone v_tz,
                                     ((v_from + interval '1 month')::date + time '04:00')
                                       at time zone v_tz);
end $$;

-- The stores whose register I keep or read: they keep excise items.
create function inv.excise_stores()
returns table (store_id uuid, name text, can_edit boolean, today date)
language sql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
  select n.id, n.name, core.can('EXCISE', 'modify', null, n.id),
         (((now() at time zone coalesce(ops.tz_of(n.id), 'UTC')) - interval '4 hours'))::date
    from core.hierarchy_node n
   where n.tenant_id = core.my_tenant() and n.type = 'delivery' and n.holds_stock
     and n.archived_at is null
     and core.can('EXCISE', 'view', null, n.id)
     and exists (select 1 from inv.item_node x join inv.item i on i.id = x.item_id
                  where x.delivery_node_id = n.id and x.archived_at is null and i.excise)
   order by n.name;
$$;

create function inv.add_excise_permit(p_store uuid, p_permit_no text, p_received_on date,
                                      p_note text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from core.hierarchy_node
                  where id = p_store and tenant_id = core.my_tenant() and type = 'delivery'
                    and archived_at is null)
     or not core.can('EXCISE', 'modify', null, p_store) then
    perform inv.fail('NOT_AUTHORISED', 'EXCISE modify');
  end if;
  if nullif(btrim(p_permit_no), '') is null or p_received_on is null
     or p_received_on > current_date + 1 then
    perform inv.fail('INVALID_VALUE', 'the permit number and the day it came');
  end if;
  insert into inv.excise_permit (tenant_id, delivery_node_id, permit_no, received_on, note)
  values (core.my_tenant(), p_store, btrim(p_permit_no), p_received_on,
          left(nullif(btrim(p_note), ''), 300))
  returning id into v_id;
  return v_id;
exception when unique_violation then
  perform inv.fail('INVALID_VALUE', 'that permit is already kept here');
  return null;
end $$;

create function inv.excise_permits(p_store uuid, p_days int default 90)
returns table (id uuid, permit_no text, received_on date, note text, added_by text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
#variable_conflict use_column
begin
  if not core.can('EXCISE', 'view', null, p_store) then
    perform inv.fail('NOT_AUTHORISED', 'EXCISE view');
  end if;
  return query
    select p.id, p.permit_no, p.received_on, p.note,
           (select u.display_name from core.app_user u where u.id = p.created_by)
      from inv.excise_permit p
     where p.delivery_node_id = p_store and p.tenant_id = core.my_tenant()
       and p.received_on > current_date - p_days
     order by p.received_on desc, p.created_at desc;
end $$;

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('inv.excise_permit', 'EXCISE', 'delivery', true);
select core.apply_domain_rls('inv.excise_permit');
select audit.enable('inv.excise_permit');

revoke execute on function inv.excise_between(uuid, timestamptz, timestamptz),
  inv.excise_register(uuid, date), inv.excise_month(uuid, date), inv.excise_stores(),
  inv.add_excise_permit(uuid, text, date, text), inv.excise_permits(uuid, int)
  from public, platform_loader;
grant execute on function inv.excise_register(uuid, date), inv.excise_month(uuid, date),
  inv.excise_stores(), inv.add_excise_permit(uuid, text, date, text),
  inv.excise_permits(uuid, int)
  to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function inv.excise_permits(uuid, int);
drop function inv.add_excise_permit(uuid, text, date, text);
drop function inv.excise_stores();
drop function inv.excise_month(uuid, date);
drop function inv.excise_register(uuid, date);
drop function inv.excise_between(uuid, timestamptz, timestamptz);
delete from core.domain_table where table_name = 'inv.excise_permit'::regclass;
drop table inv.excise_permit;
alter table inv.item drop column excise;
