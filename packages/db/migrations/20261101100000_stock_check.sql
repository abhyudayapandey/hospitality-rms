-- migrate:up

-- The stock check (INV-10, INV-11, INV-7, INV-8; ADR 042). The system already knows what
-- should be left of each item; the verifier counts what is there without being shown it
-- (blind), then sees the differences, adds a photo to each, and finishes. A difference
-- posts to the ledger at once as a count_adjust (no approval) and tells the heads of the
-- team that uses the store and the GM. Items counted get a Verified tag with who and when.
-- The old Count (inv.start_count / inv.submit_count) stays for routine counts.
--
-- A check goes open -> review -> finished. In review the counts are locked and only photos
-- can be added, so what was counted can't be bent towards what was expected.

-- Where an item sits in the store, for shelf-ordered count sheets (INV-7).
alter table inv.item_node
  add column shelf text check (shelf is null or length(shelf) between 1 and 60),
  add column shelf_order integer check (shelf_order is null or shelf_order >= 0);

create table inv.stock_check (
  id uuid primary key default core.uuid_v7(),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  mode text not null default 'standard' check (mode in ('standard', 'bar')),
  status text not null default 'open' check (status in ('open', 'review', 'finished')),
  started_at timestamptz not null default now(),
  review_at timestamptz,
  finished_at timestamptz,
  finished_by uuid references core.app_user(id),
  idempotency_key text
);
select core.add_standard_columns('inv.stock_check');
alter table inv.stock_check add constraint stock_check_idem
  unique (tenant_id, created_by, idempotency_key);
create unique index stock_check_one_open on inv.stock_check (delivery_node_id)
  where status <> 'finished';

create table inv.stock_check_line (
  id uuid primary key default core.uuid_v7(),
  check_id uuid not null references inv.stock_check(id),
  item_id uuid not null references inv.item(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  expected_qty numeric(18,6) not null,           -- what should be left, at the start
  unit_cost numeric(14,4) not null default 0,
  counted_qty numeric(18,6) check (counted_qty >= 0),
  full_units numeric(14,3) check (full_units >= 0), -- bar mode: whole bottles ...
  tenths smallint check (tenths between 0 and 9),   -- ... and tenths of the open one
  area text check (area is null or length(area) between 1 and 60),
  counted_by uuid references core.app_user(id),
  counted_at timestamptz,                        -- when it was counted (original time offline)
  device_id text check (device_id is null or length(device_id) <= 80),
  photo_key text,
  outcome text check (outcome in ('match', 'adjusted')),
  unique (check_id, item_id)
);
select core.add_standard_columns('inv.stock_check_line');

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Opens a check of p_node (mode 'standard' or 'bar') with what should be left of every
-- item set up there. An unfinished check of the node is resumed, so several devices share
-- one check.
create function inv.start_stock_check(p_node uuid, p_mode text default 'standard',
                                      p_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_id uuid;
begin
  perform inv.require('STOCK_CHECK', 'modify', p_node);
  if p_mode is null or p_mode not in ('standard', 'bar') then
    perform inv.fail('INVALID_LINES', 'mode must be standard or bar');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('inv.stock_check:' || p_node, 0));
  if p_key is not null then
    select id into v_id from inv.stock_check
     where tenant_id = v_me.tenant_id and created_by = v_me.id and idempotency_key = p_key;
    if found then return v_id; end if;
  end if;
  select id into v_id from inv.stock_check
   where delivery_node_id = p_node and status <> 'finished' order by started_at limit 1;
  if found then return v_id; end if;

  insert into inv.stock_check (tenant_id, delivery_node_id, mode, idempotency_key)
  values (v_me.tenant_id, p_node, p_mode, p_key) returning id into v_id;
  insert into inv.stock_check_line (tenant_id, check_id, item_id, delivery_node_id,
                                    expected_qty, unit_cost)
  select v_me.tenant_id, v_id, n.item_id, p_node, coalesce(s.on_hand, 0), coalesce(s.avg_cost, 0)
    from inv.item_node n
    join inv.item i on i.id = n.item_id and i.archived_at is null
    left join inv.stock_level s on s.item_id = n.item_id and s.delivery_node_id = p_node
   where n.delivery_node_id = p_node and n.archived_at is null;
  return v_id;
end $$;

-- The count sheet: items in shelf order with what has been counted so far. It never says
-- what should be left (the count is blind).
create function inv.stock_check_sheet(p_check uuid)
returns table (item_id uuid, sku text, name text, unit text, category text, shelf text,
               area text, counted_qty numeric, full_units numeric, tenths smallint,
               pack_unit text, pack_size numeric, counted_at timestamptz, photo_key text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_check inv.stock_check;
begin
  select * into v_check from inv.stock_check
   where id = p_check and tenant_id = core.my_tenant();
  if not found then perform inv.fail('NOT_AUTHORISED', 'check not found'); end if;
  perform inv.require('STOCK_CHECK', 'modify', v_check.delivery_node_id);
  return query
    select l.item_id, i.sku, i.name, i.base_uom, i.category, n.shelf,
           l.area, l.counted_qty, l.full_units, l.tenths,
           u.recipe_unit, u.recipe_units_per_stock_unit, l.counted_at, l.photo_key
      from inv.stock_check_line l
      join inv.item i on i.id = l.item_id
      left join inv.item_node n on n.item_id = l.item_id and n.delivery_node_id = l.delivery_node_id
      left join inv.item_unit u on u.item_id = l.item_id
     where l.check_id = p_check
     order by n.shelf_order nulls last, n.shelf nulls last, i.category, i.name;
end $$;

-- Records one item's count (or, in review, its photo). Safe to repeat and to send late:
-- a count older (by its original time) than the one already held is ignored, so an offline
-- device syncing later never overwrites a newer count. p_counted may be null in bar mode,
-- where p_full whole bottles + p_tenths tenths of the open one are used instead.
create function inv.record_check_line(p_check uuid, p_item uuid, p_counted numeric default null,
                                      p_photo_key text default null, p_area text default null,
                                      p_counted_at timestamptz default null,
                                      p_device text default null, p_full numeric default null,
                                      p_tenths integer default null) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_check inv.stock_check;
  v_line inv.stock_check_line;
  v_qty numeric := p_counted;
  v_at timestamptz := coalesce(p_counted_at, now());
begin
  select * into v_check from inv.stock_check
   where id = p_check and tenant_id = v_me.tenant_id for update;
  if not found then perform inv.fail('NOT_AUTHORISED', 'check not found'); end if;
  perform inv.require('STOCK_CHECK', 'modify', v_check.delivery_node_id);
  if v_check.status = 'finished' then perform inv.fail('CHECK_FINISHED', null); end if;
  select * into v_line from inv.stock_check_line where check_id = p_check and item_id = p_item
   for update;
  if not found then perform inv.fail('INVALID_ITEM', 'item is not on this check'); end if;
  if v_at > now() + interval '5 minutes' then
    perform inv.fail('INVALID_TIME', 'a count cannot be from the future');
  end if;

  if p_photo_key is not null
     and p_photo_key !~ format('^stockcheck/%s/%s/[0-9a-f-]{36}\.(jpg|png|webp)$',
                               v_me.tenant_id, v_check.delivery_node_id) then
    perform inv.fail('INVALID_PHOTO', 'photo was not uploaded for this location');
  end if;

  if v_qty is null and p_full is not null then
    if p_tenths is not null and (p_tenths < 0 or p_tenths > 9) then
      perform inv.fail('INVALID_QUANTITY', 'tenths are 0 to 9');
    end if;
    v_qty := p_full + coalesce(p_tenths, 0) / 10.0;
  end if;
  if v_qty is not null and v_qty < 0 then
    perform inv.fail('INVALID_QUANTITY', 'counted quantity must be zero or more');
  end if;

  if v_qty is not null then
    if v_check.status <> 'open' then
      -- counts are locked once the differences have been shown
      if v_qty is distinct from v_line.counted_qty then perform inv.fail('CHECK_LOCKED', null); end if;
    elsif v_line.counted_at is null or v_at >= v_line.counted_at then
      update inv.stock_check_line
         set counted_qty = v_qty, full_units = p_full, tenths = p_tenths,
             area = coalesce(p_area, area), counted_by = v_me.id, counted_at = v_at,
             device_id = coalesce(p_device, device_id)
       where id = v_line.id;
    end if;
  end if;
  if p_photo_key is not null then
    update inv.stock_check_line set photo_key = p_photo_key where id = v_line.id;
  end if;
end $$;

-- Locks the counts and shows the differences (first call), or shows them again. Items
-- not counted have no difference and are left as they are.
create function inv.review_stock_check(p_check uuid)
returns table (item_id uuid, sku text, name text, unit text, area text, expected_qty numeric,
               counted_qty numeric, difference numeric, needs_photo boolean, photo_key text,
               uncounted boolean)
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_check inv.stock_check;
begin
  perform wf.me();
  select * into v_check from inv.stock_check
   where id = p_check and tenant_id = core.my_tenant() for update;
  if not found then perform inv.fail('NOT_AUTHORISED', 'check not found'); end if;
  perform inv.require('STOCK_CHECK', 'modify', v_check.delivery_node_id);
  if v_check.status = 'open' then
    update inv.stock_check set status = 'review', review_at = now() where id = p_check;
  end if;
  return query
    select l.item_id, i.sku, i.name, i.base_uom, l.area, l.expected_qty, l.counted_qty,
           coalesce(l.counted_qty - l.expected_qty, 0),
           coalesce(l.counted_qty <> l.expected_qty, false), l.photo_key, l.counted_qty is null
      from inv.stock_check_line l join inv.item i on i.id = l.item_id
     where l.check_id = p_check
     order by (l.counted_qty is distinct from l.expected_qty) desc, i.name;
end $$;

-- Tells the heads of the team that uses the store, and the outlet's GM, about a check that
-- changed stock. Not the person who did it.
create function inv.notify_stock_check(p_check uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_c inv.stock_check;
  v_store text;
  v_who text;
  v_body text;
  v_team uuid;
  v_user uuid;
begin
  select * into v_c from inv.stock_check where id = p_check;
  select name into v_store from core.hierarchy_node where id = v_c.delivery_node_id;
  select display_name into v_who from core.app_user where id = v_c.finished_by;
  select string_agg(format('%s %s%s %s (₹%s)', i.name,
                           case when l.counted_qty > l.expected_qty then '+' else '' end,
                           trim_scale(round(l.counted_qty - l.expected_qty, 3)), i.base_uom,
                           to_char(abs((l.counted_qty - l.expected_qty) * l.unit_cost),
                                   'FM9999999990.00')),
                    '; ' order by abs((l.counted_qty - l.expected_qty) * l.unit_cost) desc, i.name)
    into v_body
    from inv.stock_check_line l join inv.item i on i.id = l.item_id
   where l.check_id = p_check and l.outcome = 'adjusted';
  v_team := ops.team_of_store(v_c.delivery_node_id);
  -- the department heads of the team, and separately the outlet's GM (ops.leads stops at the
  -- first group that has someone)
  foreach v_user in array coalesce(
      ops.leads(coalesce(v_team, v_c.delivery_node_id), array['DEPARTMENT_HEAD'],
                array[v_c.finished_by]), '{}')
      || coalesce(ops.leads(coalesce(v_team, v_c.delivery_node_id), array['OUTLET_MANAGER'],
                            array[v_c.finished_by]), '{}') loop
    perform ops.notify(v_c.tenant_id, v_user, 'stock_check', 'Stock check at ' || v_store,
                       left(v_body || '. Checked by ' || coalesce(v_who, 'someone') || '.', 1000),
                       '/stock/check');
  end loop;
end $$;
revoke execute on function inv.notify_stock_check(uuid) from public;

-- Posts the differences and tags what was counted verified. Every difference needs its
-- photo (PHOTO_REQUIRED). Returns {adjusted, matched, not_counted}.
create function inv.finish_stock_check(p_check uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_check inv.stock_check;
  v_line record;
  v_missing text;
begin
  select * into v_check from inv.stock_check
   where id = p_check and tenant_id = v_me.tenant_id for update;
  if not found then perform inv.fail('NOT_AUTHORISED', 'check not found'); end if;
  perform inv.require('STOCK_CHECK', 'modify', v_check.delivery_node_id);
  if v_check.status = 'finished' then perform inv.fail('CHECK_FINISHED', null); end if;
  if v_check.status <> 'review' then perform inv.fail('CHECK_NOT_REVIEWED', null); end if;

  select string_agg(i.name, ', ') into v_missing
    from inv.stock_check_line l join inv.item i on i.id = l.item_id
   where l.check_id = p_check and l.counted_qty is not null
     and l.counted_qty <> l.expected_qty and l.photo_key is null;
  if v_missing is not null then
    perform inv.fail('PHOTO_REQUIRED', 'a photo is needed for: ' || v_missing);
  end if;

  for v_line in select * from inv.stock_check_line
                 where check_id = p_check and counted_qty is not null loop
    if v_line.counted_qty = v_line.expected_qty then
      update inv.stock_check_line set outcome = 'match' where id = v_line.id;
    else
      perform inv.post(v_line.item_id, v_line.delivery_node_id, 'count_adjust',
                       v_line.counted_qty - v_line.expected_qty, v_line.unit_cost,
                       'stock_check', p_check);
      update inv.stock_check_line set outcome = 'adjusted' where id = v_line.id;
    end if;
  end loop;
  update inv.stock_check
     set status = 'finished', finished_at = now(), finished_by = v_me.id where id = p_check;
  if exists (select 1 from inv.stock_check_line where check_id = p_check and outcome = 'adjusted') then
    perform inv.notify_stock_check(p_check);
  end if;
  return (select jsonb_build_object(
            'adjusted', count(*) filter (where outcome = 'adjusted'),
            'matched', count(*) filter (where outcome = 'match'),
            'not_counted', count(*) filter (where outcome is null))
            from inv.stock_check_line where check_id = p_check);
end $$;

-- Every item at the store with its Verified / Not verified tag: when its last finished
-- check counted it, and who by. Seen by whoever holds STOCK_CHECK (view or modify) there.
create function inv.stock_check_view(p_node uuid)
returns table (item_id uuid, sku text, name text, unit text, category text, shelf text,
               on_hand numeric, verified_at timestamptz, verified_by text, difference numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  perform inv.require('STOCK_CHECK', 'view', p_node);
  return query
    select i.id, i.sku, i.name, i.base_uom, i.category, n.shelf, inv.on_hand(i.id, p_node),
           v.at, v.who, v.diff
      from inv.item_node n
      join inv.item i on i.id = n.item_id and i.archived_at is null
      left join lateral (
        select c.finished_at as at, u.display_name as who, l.counted_qty - l.expected_qty as diff
          from inv.stock_check_line l
          join inv.stock_check c on c.id = l.check_id and c.status = 'finished'
          left join core.app_user u on u.id = c.finished_by
         where l.item_id = i.id and l.delivery_node_id = p_node and l.counted_qty is not null
         order by c.finished_at desc limit 1) v on true
     where n.delivery_node_id = p_node and n.archived_at is null
     order by n.shelf_order nulls last, i.category, i.name;
end $$;

-- ---------------------------------------------------------------------------
-- RLS registration (rule 1), audit (rule 5), grants
-- ---------------------------------------------------------------------------

insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('inv.stock_check', 'STOCK_CHECK', 'delivery', true),
  ('inv.stock_check_line', 'STOCK_CHECK', 'delivery', true);
select core.apply_domain_rls('inv.stock_check');
select core.apply_domain_rls('inv.stock_check_line');
select audit.enable('inv.stock_check');
select audit.enable('inv.stock_check_line');

revoke execute on function
  inv.start_stock_check(uuid, text, text), inv.stock_check_sheet(uuid),
  inv.record_check_line(uuid, uuid, numeric, text, text, timestamptz, text, numeric, integer),
  inv.review_stock_check(uuid), inv.finish_stock_check(uuid), inv.stock_check_view(uuid)
  from public;
grant execute on function
  inv.start_stock_check(uuid, text, text), inv.stock_check_sheet(uuid),
  inv.record_check_line(uuid, uuid, numeric, text, text, timestamptz, text, numeric, integer),
  inv.review_stock_check(uuid), inv.finish_stock_check(uuid), inv.stock_check_view(uuid)
  to app_rw;

-- migrate:down
drop function inv.stock_check_view(uuid);
drop function inv.finish_stock_check(uuid);
drop function inv.notify_stock_check(uuid);
drop function inv.review_stock_check(uuid);
drop function inv.record_check_line(uuid, uuid, numeric, text, text, timestamptz, text, numeric, integer);
drop function inv.stock_check_sheet(uuid);
drop function inv.start_stock_check(uuid, text, text);
delete from core.domain_table where table_name::text in ('inv.stock_check', 'inv.stock_check_line');
drop table inv.stock_check_line;
drop table inv.stock_check;
alter table inv.item_node drop column shelf_order, drop column shelf;
