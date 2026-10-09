-- migrate:up
-- Shelf life & labels and Breakage (ADR 093), two blocks of Stock (ADR 085).
--
-- Shelf life & labels (domain SHELF_LIFE, delivery tree):
-- * File 10 gives an item its shelf life once opened (`open_shelf_life_hours`), how it is kept
--   (`storage`: dry, chilled, frozen), veg or non-veg and its allergens (as file 19's prep items).
-- * Opening a pack records it (inv.open_pack): how much, when, its use-by (opened + the hours),
--   and prints a day-dot label. The stock stays in the store; an opened pack is used up
--   (inv.finish_pack) or thrown away as expired wastage (inv.throw_pack, the usual wastage
--   rules: a photo and approval above the store's limit, the GM for the GM's items).
-- * Open packs are in Expiring and Expired with the dated batches (inv.expiry_list), for those
--   who hold SHELF_LIFE at the store, while the block is on.
--
-- Breakage (domain BREAKAGE, org tree):
-- * An entry: the department where it broke, the store it leaves, the item (crockery, cutlery,
--   glassware, linen: durable items), how many, why, who broke it (staff, and who; a guest;
--   not known), a note and its worth at the store's average cost. It leaves the store through
--   the ledger (`consumption`, reason `breakage`), so the store's count and costs follow.
-- * Written by whoever holds BREAKAGE modify at the department. Every department head at the
--   outlet reads the whole outlet's log, as do the outlet's managers; a monthly total for the
--   last 12 months.

-- ---------------------------------------------------------------------------
-- Shelf life & labels
-- ---------------------------------------------------------------------------
alter table inv.item
  add column open_shelf_life_hours int check (open_shelf_life_hours between 1 and 8760),
  add column storage text check (storage in ('dry', 'chilled', 'frozen'));

create table inv.opened_pack (
  id uuid primary key default core.uuid_v7(),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  item_id uuid not null references inv.item(id),
  qty numeric(18,6) not null check (qty > 0),
  opened_at timestamptz not null default now(),
  use_by timestamptz not null,
  status text not null default 'open' check (status in ('open', 'used', 'thrown')),
  closed_at timestamptz,
  closed_by uuid references core.app_user(id),
  wastage_id uuid references inv.wastage(id),
  idempotency_key text,
  check ((status = 'open') = (closed_at is null)),
  check (use_by > opened_at)
);
select core.add_standard_columns('inv.opened_pack');
create index opened_pack_open on inv.opened_pack (delivery_node_id, use_by) where status = 'open';
alter table inv.opened_pack add constraint opened_pack_idem
  unique (tenant_id, created_by, idempotency_key);

-- Open a pack at a store. Returns its id (for the label).
create function inv.open_pack(p_store uuid, p_item uuid, p_qty numeric,
                              p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_me core.app_user := wf.me();
  v_item inv.item;
  v_id uuid;
begin
  if p_idempotency_key is not null then
    select id into v_id from inv.opened_pack
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if v_id is not null then return v_id; end if;
  end if;
  if not exists (select 1 from core.hierarchy_node
                  where id = p_store and tenant_id = v_me.tenant_id and type = 'delivery'
                    and archived_at is null)
     or not core.can('SHELF_LIFE', 'modify', null, p_store) then
    perform inv.fail('NOT_AUTHORISED', 'SHELF_LIFE modify');
  end if;
  select i.* into v_item from inv.item i
    join inv.item_node x on x.item_id = i.id and x.delivery_node_id = p_store
                        and x.archived_at is null
   where i.id = p_item and i.tenant_id = v_me.tenant_id and i.archived_at is null;
  if v_item.id is null then
    perform inv.fail('NOT_FOUND', 'that item is not kept here');
  end if;
  if v_item.open_shelf_life_hours is null then
    perform inv.fail('INVALID_VALUE', 'this item has no shelf life once opened');
  end if;
  if p_qty is null or p_qty <= 0 then
    perform inv.fail('INVALID_QUANTITY', 'more than nothing');
  end if;
  if p_qty > inv.on_hand(p_item, p_store) then
    perform inv.fail('INSUFFICIENT_STOCK', 'more than the store has');
  end if;
  insert into inv.opened_pack (tenant_id, delivery_node_id, item_id, qty, opened_at, use_by,
                               idempotency_key)
  values (v_me.tenant_id, p_store, p_item, p_qty, now(),
          now() + make_interval(hours => v_item.open_shelf_life_hours), p_idempotency_key)
  returning id into v_id;
  return v_id;
end $$;

-- An open pack I may close (SHELF_LIFE modify at its store), locked.
create function inv.pack_to_close(p_pack uuid) returns inv.opened_pack
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_p inv.opened_pack;
begin
  select * into v_p from inv.opened_pack
   where id = p_pack and tenant_id = core.my_tenant() for update;
  if not found then
    perform inv.fail('NOT_FOUND', 'no such pack');
  end if;
  if not core.can('SHELF_LIFE', 'modify', null, v_p.delivery_node_id) then
    perform inv.fail('NOT_AUTHORISED', 'SHELF_LIFE modify');
  end if;
  if v_p.status <> 'open' then
    perform inv.fail('INVALID_STATE', 'already used up or thrown away');
  end if;
  return v_p;
end $$;

-- Used up: nothing leaves the store (what was used went out with sales or use).
create function inv.finish_pack(p_pack uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_p inv.opened_pack := inv.pack_to_close(p_pack);
begin
  update inv.opened_pack
     set status = 'used', closed_at = now(), closed_by = core.current_user_id()
   where id = v_p.id;
end $$;

-- Thrown away: what was left (no more than the store has) is expired wastage, by the usual
-- rules (inv.record_wastage checks who may, the limit, the photo and the GM's items).
create function inv.throw_pack(p_pack uuid, p_qty numeric default null,
                               p_photo_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_p inv.opened_pack := inv.pack_to_close(p_pack);
  v_qty numeric := least(coalesce(p_qty, v_p.qty), inv.on_hand(v_p.item_id, v_p.delivery_node_id));
  v_w uuid;
begin
  if v_qty <= 0 then
    perform inv.fail('INSUFFICIENT_STOCK', 'the store has none of it');
  end if;
  v_w := inv.record_wastage(v_p.delivery_node_id,
                            jsonb_build_array(jsonb_build_object(
                              'item_id', v_p.item_id, 'qty', v_qty, 'reason', 'expired',
                              'photo_key', p_photo_key)),
                            'pack:' || v_p.id);
  update inv.opened_pack
     set status = 'thrown', closed_at = now(), closed_by = core.current_user_id(),
         wastage_id = v_w
   where id = v_p.id;
  return v_w;
end $$;

-- The open packs at a store, soonest use-by first.
create function inv.open_packs(p_store uuid)
returns table (id uuid, item_id uuid, name text, unit text, qty numeric, opened_at timestamptz,
               use_by timestamptz, opened_by text, expired boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
#variable_conflict use_column
begin
  if not core.can('SHELF_LIFE', 'view', null, p_store) then
    perform inv.fail('NOT_AUTHORISED', 'SHELF_LIFE view');
  end if;
  return query
    select p.id, i.id, i.name, i.base_uom, p.qty, p.opened_at, p.use_by,
           (select u.display_name from core.app_user u where u.id = p.created_by),
           p.use_by <= now()
      from inv.opened_pack p join inv.item i on i.id = p.item_id
     where p.delivery_node_id = p_store and p.status = 'open'
       and p.tenant_id = core.my_tenant()
     order by p.use_by, i.name;
end $$;

-- A pack's label: what it is, veg or non-veg, allergens, how it is kept, opened and use-by,
-- who opened it. For whoever holds SHELF_LIFE at the store.
create function inv.pack_label(p_pack uuid)
returns table (id uuid, name text, qty numeric, unit text, food_type text, allergens text[],
               storage text, opened_at timestamptz, use_by timestamptz, opened_by text,
               store text, tz text, status text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
#variable_conflict use_column
declare
  v_p inv.opened_pack;
begin
  select * into v_p from inv.opened_pack where id = p_pack and tenant_id = core.my_tenant();
  if v_p.id is null or not core.can('SHELF_LIFE', 'view', null, v_p.delivery_node_id) then
    perform inv.fail('NOT_AUTHORISED', 'that pack');
  end if;
  return query
    select v_p.id, i.name, v_p.qty, i.base_uom, i.food_type, i.allergens, i.storage,
           v_p.opened_at, v_p.use_by,
           (select u.display_name from core.app_user u where u.id = v_p.created_by),
           (select s.name from core.hierarchy_node s where s.id = v_p.delivery_node_id),
           coalesce(ops.tz_of(v_p.delivery_node_id), 'UTC'), v_p.status
      from inv.item i where i.id = v_p.item_id;
end $$;

-- Expiring and Expired (INV-12) now hold open packs too: `pack_id` names one; its batch_no
-- is null and made_at is when it was opened.
drop function inv.expiry_list(int);
create function inv.expiry_list(p_days int)
returns table (store_id uuid, store text, item_id uuid, sku text, name text, unit text,
               batch_no text, made_at timestamptz, expires_at timestamptz, remaining numeric,
               expired boolean, pack_id uuid)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
begin
  if p_days is null or p_days < 0 or p_days > 14 then
    raise exception 'INVALID_DAYS' using detail = 'look ahead 0 to 14 days';
  end if;
  return query
    select * from (
      select n.id, n.name, i.id, i.sku, i.name, i.base_uom, b.batch_no, b.made_at,
             b.expires_at, b.remaining, b.expires_at <= now(), null::uuid
        from core.hierarchy_node n
        cross join lateral (select coalesce(ops.tz_of(n.id), 'UTC') as tz) z
        join inv.item_node x on x.delivery_node_id = n.id and x.archived_at is null
        join inv.item i on i.id = x.item_id
        cross join lateral inv.batch_rows(x.item_id, n.id) b
       where n.id = any (core.visible_nodes('STOCK_LEVELS', 'view'))
         and n.tenant_id = core.my_tenant() and n.type = 'delivery' and n.holds_stock
         and n.archived_at is null
         and exists (select 1 from inv.stock_ledger l
                      where l.item_id = x.item_id and l.delivery_node_id = n.id
                        and l.expires_at is not null)
         and b.remaining > 0
         and (b.expires_at <= now()
              or rpt.business_date(b.expires_at, z.tz) <= rpt.business_date(now(), z.tz) + p_days)
      union all
      select n.id, n.name, i.id, i.sku, i.name, i.base_uom, null, p.opened_at, p.use_by,
             p.qty, p.use_by <= now(), p.id
        from inv.opened_pack p
        join core.hierarchy_node n on n.id = p.delivery_node_id
        cross join lateral (select coalesce(ops.tz_of(n.id), 'UTC') as tz) z
        join inv.item i on i.id = p.item_id
       where p.status = 'open' and p.tenant_id = core.my_tenant()
         and n.id = any (core.visible_nodes('SHELF_LIFE', 'view'))
         and (p.use_by <= now()
              or rpt.business_date(p.use_by, z.tz) <= rpt.business_date(now(), z.tz) + p_days)
    ) e
    order by 9, 5, 2;
end $$;

-- The Opened packs screen lists the stores where the caller holds SHELF_LIFE.
select core.patch_function('core.screen_places(text)',
$x$'check', 'bills', 'compliance') then$x$,
$x$'check', 'bills', 'compliance', 'opened') then$x$);
select core.patch_function('core.screen_places(text)',
$x$'production', 'check', 'bills') then$x$,
$x$'production', 'check', 'bills', 'opened') then$x$);
select core.patch_function('core.screen_places(text)',
$x$             when 'bills' then core.can('BILLS', 'view', null, n.id)$x$,
$x$             when 'bills' then core.can('BILLS', 'view', null, n.id)
             when 'opened' then core.can('SHELF_LIFE', 'view', null, n.id)$x$);

-- ---------------------------------------------------------------------------
-- Breakage
-- ---------------------------------------------------------------------------
create table inv.breakage (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),        -- where it broke
  delivery_node_id uuid not null references core.hierarchy_node(id),   -- the store it leaves
  item_id uuid not null references inv.item(id),
  qty numeric(14,3) not null check (qty > 0),
  reason text not null check (reason in ('dropped', 'washing', 'guest', 'worn_out', 'other')),
  broken_by text not null check (broken_by in ('staff', 'guest', 'unknown')),
  person_id uuid references core.app_user(id),
  note text check (length(note) <= 300),
  unit_cost numeric(14,4) not null,
  value numeric(14,2) not null,
  currency text not null default 'INR',
  broken_at timestamptz not null default now(),
  idempotency_key text,
  check (person_id is null or broken_by = 'staff')
);
select core.add_standard_columns('inv.breakage');
create index breakage_place on inv.breakage (org_node_id, broken_at desc);
alter table inv.breakage add constraint breakage_idem
  unique (tenant_id, created_by, idempotency_key);

-- Record a breakage at a department, from a store of its outlet. Returns its id.
create function inv.record_breakage(p_place uuid, p_store uuid, p_item uuid, p_qty numeric,
                                    p_reason text, p_broken_by text, p_person uuid,
                                    p_note text, p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_me core.app_user := wf.me();
  v_id uuid;
  v_cost numeric;
begin
  if p_idempotency_key is not null then
    select id into v_id from inv.breakage
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if v_id is not null then return v_id; end if;
  end if;
  if not exists (select 1 from core.hierarchy_node
                  where id = p_place and tenant_id = v_me.tenant_id and type = 'org'
                    and kind = 'department' and archived_at is null)
     or not core.can('BREAKAGE', 'modify', p_place, null) then
    perform inv.fail('NOT_AUTHORISED', 'BREAKAGE modify');
  end if;
  if not exists (select 1 from core.hierarchy_node s
                  where s.id = p_store and s.tenant_id = v_me.tenant_id and s.type = 'delivery'
                    and s.holds_stock and s.archived_at is null)
     or core.nearest(ops.team_of_store(p_store), array['outlet'])
        is distinct from core.nearest(p_place, array['outlet']) then
    perform inv.fail('NOT_FOUND', 'that store is not at this outlet');
  end if;
  if not exists (select 1 from inv.item_node x
                  where x.item_id = p_item and x.delivery_node_id = p_store
                    and x.archived_at is null) then
    perform inv.fail('NOT_FOUND', 'that item is not kept there');
  end if;
  if p_qty is null or p_qty <= 0 then
    perform inv.fail('INVALID_QUANTITY', 'more than nothing');
  end if;
  if coalesce(p_reason, '') not in ('dropped', 'washing', 'guest', 'worn_out', 'other') then
    perform inv.fail('INVALID_VALUE', 'dropped, washing, guest, worn out or other');
  end if;
  if coalesce(p_broken_by, '') not in ('staff', 'guest', 'unknown') then
    perform inv.fail('INVALID_VALUE', 'staff, a guest or not known');
  end if;
  if p_person is not null and (p_broken_by <> 'staff' or not exists (
       select 1 from core.app_user u where u.id = p_person and u.tenant_id = v_me.tenant_id)) then
    perform inv.fail('INVALID_VALUE', 'who broke it is someone on the staff');
  end if;
  if inv.on_hand(p_item, p_store) < p_qty then
    perform inv.fail('INSUFFICIENT_STOCK', 'more than the store has');
  end if;
  v_cost := inv.avg_cost(p_item, p_store);
  insert into inv.breakage (tenant_id, org_node_id, delivery_node_id, item_id, qty, reason,
                            broken_by, person_id, note, unit_cost, value, idempotency_key)
  values (v_me.tenant_id, p_place, p_store, p_item, p_qty, p_reason, p_broken_by, p_person,
          left(nullif(btrim(p_note), ''), 300), v_cost, round(p_qty * v_cost, 2),
          p_idempotency_key)
  returning id into v_id;
  perform inv.post(p_item, p_store, 'consumption', -p_qty, v_cost, 'breakage', v_id, 'breakage');
  return v_id;
end $$;

-- What may be recorded broken from a store: what it keeps and has, durable things first. For
-- whoever records breakage at a department of the store's outlet.
create function inv.breakage_items(p_store uuid)
returns table (item_id uuid, name text, unit text, durable boolean, on_hand numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, extensions
as $$
#variable_conflict use_column
begin
  if not exists (
       select 1 from core.hierarchy_node d
         join core.hierarchy_node o on o.id = core.nearest(ops.team_of_store(p_store),
                                                           array['outlet'])
        where d.tenant_id = core.my_tenant() and d.kind = 'department'
          and d.archived_at is null and d.path operator(extensions.<@) o.path
          and core.can('BREAKAGE', 'modify', d.id, null)) then
    perform inv.fail('NOT_AUTHORISED', 'BREAKAGE modify');
  end if;
  return query
    select i.id, i.name, i.base_uom, i.durable, inv.on_hand(i.id, p_store)
      from inv.item_node x join inv.item i on i.id = x.item_id
     where x.delivery_node_id = p_store and x.archived_at is null and i.archived_at is null
       and inv.on_hand(i.id, p_store) > 0
     order by i.durable desc, i.category, i.name;
end $$;

-- Whether I read a place's breakage: BREAKAGE view there, or, at an outlet, I head a
-- department of it (a role of level 2 or more there, ADR 087) and hold BREAKAGE there.
create function inv.reads_breakage(p_place uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
  select core.can('BREAKAGE', 'view', p_place, null)
      or exists (
        select 1 from core.hierarchy_node o
          join core.hierarchy_node d on d.path operator(extensions.<@) o.path
                                    and d.kind = 'department' and d.archived_at is null
          join hr.worker w on w.org_node_id = d.id and w.status = 'active'
                          and w.owner_user_id = core.current_user_id()
         where o.id = p_place and o.kind = 'outlet' and o.tenant_id = core.my_tenant()
           and ops.role_level(w.tenant_id, w.role_code) >= 2
           and core.can('BREAKAGE', 'view', d.id, null));
$$;

-- The places whose breakage I record or read: departments (with their outlet's stores it may
-- come from, and the people who work there, for who broke it) and outlets.
create function inv.breakage_places()
returns table (place_id uuid, name text, kind text, outlet_id uuid, outlet text,
               can_record boolean, stores jsonb, people jsonb)
language sql stable security definer
set search_path = pg_catalog, core, inv, ops, hr, extensions
as $$
  select n.id, n.name, n.kind, o.id, o.name,
         n.kind = 'department' and core.can('BREAKAGE', 'modify', n.id, null),
         coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)
                                    order by ops.team_of_store(s.id) = n.id desc, s.name)
                     from core.hierarchy_node s
                    where s.tenant_id = n.tenant_id and s.type = 'delivery' and s.holds_stock
                      and s.archived_at is null and n.kind = 'department'
                      and core.nearest(ops.team_of_store(s.id), array['outlet']) = o.id),
                  '[]'),
         coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.display_name)
                                    order by u.display_name)
                     from hr.worker w
                     join core.hierarchy_node h on h.id = w.org_node_id
                     join core.app_user u on u.id = w.owner_user_id
                    where n.kind = 'department' and w.status = 'active'
                      and h.path operator(extensions.<@) n.path),
                  '[]')
    from core.hierarchy_node n
    join core.hierarchy_node o on o.id = core.nearest(n.id, array['outlet'])
   where n.tenant_id = core.my_tenant() and n.type = 'org' and n.archived_at is null
     and n.kind in ('outlet', 'department')
     and inv.reads_breakage(n.id)
   order by o.name, (n.kind = 'outlet') desc, n.name;
$$;

-- A place's breakage in a month (the outlet's business days), newest first.
create function inv.breakage_log(p_place uuid, p_month date)
returns table (id uuid, broken_at timestamptz, place text, store text, item_id uuid,
               item text, unit text, qty numeric, reason text, broken_by text, person text,
               note text, value numeric, recorded_by text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt, extensions
as $$
#variable_conflict use_column
declare
  v_tz text := coalesce(ops.tz_of(p_place), 'UTC');
  v_from date := date_trunc('month', p_month)::date;
begin
  if not inv.reads_breakage(p_place) then
    perform inv.fail('NOT_AUTHORISED', 'BREAKAGE view');
  end if;
  return query
    select b.id, b.broken_at, d.name, s.name, i.id, i.name, i.base_uom, b.qty, b.reason,
           b.broken_by, (select u.display_name from core.app_user u where u.id = b.person_id),
           b.note, b.value,
           (select u.display_name from core.app_user u where u.id = b.created_by)
      from inv.breakage b
      join core.hierarchy_node d on d.id = b.org_node_id
      join core.hierarchy_node p on p.id = p_place
      join core.hierarchy_node s on s.id = b.delivery_node_id
      join inv.item i on i.id = b.item_id
     where b.tenant_id = core.my_tenant()
       and d.path operator(extensions.<@) p.path
       and rpt.business_date(b.broken_at, v_tz) >= v_from
       and rpt.business_date(b.broken_at, v_tz) < (v_from + interval '1 month')::date
     order by b.broken_at desc;
end $$;

-- A place's breakage by month, the last 12: how many entries and what they were worth.
create function inv.breakage_months(p_place uuid)
returns table (month date, entries int, value numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt, extensions
as $$
#variable_conflict use_column
declare
  v_tz text := coalesce(ops.tz_of(p_place), 'UTC');
  v_from date := (date_trunc('month', rpt.business_date(now(), v_tz)) - interval '11 months')::date;
begin
  if not inv.reads_breakage(p_place) then
    perform inv.fail('NOT_AUTHORISED', 'BREAKAGE view');
  end if;
  return query
    select date_trunc('month', rpt.business_date(b.broken_at, v_tz))::date, count(*)::int,
           sum(b.value)
      from inv.breakage b
      join core.hierarchy_node d on d.id = b.org_node_id
      join core.hierarchy_node p on p.id = p_place
     where b.tenant_id = core.my_tenant()
       and d.path operator(extensions.<@) p.path
       and rpt.business_date(b.broken_at, v_tz) >= v_from
     group by 1
     order by 1 desc;
end $$;

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('inv.opened_pack', 'SHELF_LIFE', 'delivery', true),
  ('inv.breakage', 'BREAKAGE', 'org', true);
select core.apply_domain_rls('inv.opened_pack');
select core.apply_domain_rls('inv.breakage');
select audit.enable('inv.opened_pack');
select audit.enable('inv.breakage');

revoke execute on function inv.open_pack(uuid, uuid, numeric, text),
  inv.pack_to_close(uuid), inv.finish_pack(uuid), inv.throw_pack(uuid, numeric, text),
  inv.open_packs(uuid), inv.pack_label(uuid), inv.expiry_list(int),
  inv.record_breakage(uuid, uuid, uuid, numeric, text, text, uuid, text, text),
  inv.breakage_items(uuid), inv.reads_breakage(uuid), inv.breakage_places(),
  inv.breakage_log(uuid, date), inv.breakage_months(uuid)
  from public, platform_loader;
grant execute on function inv.open_pack(uuid, uuid, numeric, text), inv.finish_pack(uuid),
  inv.throw_pack(uuid, numeric, text), inv.open_packs(uuid), inv.pack_label(uuid),
  inv.expiry_list(int),
  inv.record_breakage(uuid, uuid, uuid, numeric, text, text, uuid, text, text),
  inv.breakage_items(uuid), inv.breakage_places(), inv.breakage_log(uuid, date),
  inv.breakage_months(uuid)
  to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function inv.breakage_months(uuid);
drop function inv.breakage_log(uuid, date);
drop function inv.breakage_places();
drop function inv.reads_breakage(uuid);
drop function inv.breakage_items(uuid);
drop function inv.record_breakage(uuid, uuid, uuid, numeric, text, text, uuid, text, text);
delete from core.domain_table
 where table_name in ('inv.breakage'::regclass, 'inv.opened_pack'::regclass);
drop table inv.breakage;

drop function inv.expiry_list(int);
create function inv.expiry_list(p_days int)
returns table (store_id uuid, store text, item_id uuid, sku text, name text, unit text,
               batch_no text, made_at timestamptz, expires_at timestamptz, remaining numeric,
               expired boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
begin
  if p_days is null or p_days < 0 or p_days > 14 then
    raise exception 'INVALID_DAYS' using detail = 'look ahead 0 to 14 days';
  end if;
  return query
    select n.id, n.name, i.id, i.sku, i.name, i.base_uom, b.batch_no, b.made_at,
           b.expires_at, b.remaining, b.expires_at <= now()
      from core.hierarchy_node n
      cross join lateral (select coalesce(ops.tz_of(n.id), 'UTC') as tz) z
      join inv.item_node x on x.delivery_node_id = n.id and x.archived_at is null
      join inv.item i on i.id = x.item_id
      cross join lateral inv.batch_rows(x.item_id, n.id) b
     where n.id = any (core.visible_nodes('STOCK_LEVELS', 'view'))
       and n.tenant_id = core.my_tenant() and n.type = 'delivery' and n.holds_stock
       and n.archived_at is null
       and exists (select 1 from inv.stock_ledger l
                    where l.item_id = x.item_id and l.delivery_node_id = n.id
                      and l.expires_at is not null)
       and b.remaining > 0
       and (b.expires_at <= now()
            or rpt.business_date(b.expires_at, z.tz) <= rpt.business_date(now(), z.tz) + p_days)
     order by b.expires_at, i.name, n.name;
end $$;
revoke execute on function inv.expiry_list(int) from public;
grant execute on function inv.expiry_list(int) to app_rw;

select core.patch_function('core.screen_places(text)',
$x$             when 'bills' then core.can('BILLS', 'view', null, n.id)
             when 'opened' then core.can('SHELF_LIFE', 'view', null, n.id)$x$,
$x$             when 'bills' then core.can('BILLS', 'view', null, n.id)$x$);
select core.patch_function('core.screen_places(text)',
$x$'production', 'check', 'bills', 'opened') then$x$,
$x$'production', 'check', 'bills') then$x$);
select core.patch_function('core.screen_places(text)',
$x$'check', 'bills', 'compliance', 'opened') then$x$,
$x$'check', 'bills', 'compliance') then$x$);
drop function inv.pack_label(uuid);
drop function inv.open_packs(uuid);
drop function inv.throw_pack(uuid, numeric, text);
drop function inv.finish_pack(uuid);
drop function inv.pack_to_close(uuid);
drop function inv.open_pack(uuid, uuid, numeric, text);
drop table inv.opened_pack;
alter table inv.item drop column storage, drop column open_shelf_life_hours;
