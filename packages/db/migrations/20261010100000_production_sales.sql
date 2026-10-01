-- migrate:up
-- Production, sales and cost control (Prompt 9b, ADR 015).
--
--   * Ledger quantities keep 6 decimals: a 100 ml pour from a 750 ml bottle is 0.133333 of
--     a bottle. Screens round for display (ADR 014).
--   * New movements: production_out (ingredients used for a batch), production_in (the
--     batch made), sales_depletion (a menu item sold, by its recipe).
--   * Sales may take stock below zero; nothing else may. A sale is never blocked, and the
--     store keepers of the store are told.
--   * Prep batches carry a batch number and an expiry; what is left of each batch is first
--     in, first out from the store's on-hand. A transfer carries the oldest batch's expiry.
--   * PRODUCTION and SALES domains; the variance and cost % reads need MENU view.

-- ---------------------------------------------------------------------------
-- Ledger: precision, movement types, the negative rule for sales, batches
-- ---------------------------------------------------------------------------

alter table inv.stock_ledger alter column qty type numeric(18,6);
alter table inv.stock_level alter column on_hand type numeric(18,6);
alter table inv.stock_count_line alter column system_qty type numeric(18,6);

alter table inv.stock_ledger
  add column batch_no text,
  add column expires_at timestamptz,
  drop constraint stock_ledger_movement_type_check,
  drop constraint stock_ledger_check,
  add constraint stock_ledger_movement_type_check check (movement_type in
    ('receipt', 'consumption', 'wastage', 'transfer_out', 'transfer_in', 'count_adjust',
     'production_out', 'production_in', 'sales_depletion')),
  add constraint stock_ledger_check check (
    (movement_type in ('receipt', 'transfer_in', 'production_in') and qty > 0)
    or (movement_type in ('consumption', 'wastage', 'transfer_out', 'production_out') and qty < 0)
    or movement_type in ('count_adjust', 'sales_depletion'));
alter table inv.stock_level drop constraint if exists stock_level_on_hand_check;
create index stock_ledger_batches on inv.stock_ledger (item_id, delivery_node_id, occurred_at desc)
  where expires_at is not null;

-- Applies a ledger row to the cache. Only sales_depletion may leave stock below zero.
-- Inflows into empty or negative stock take their own cost as the average; outflows are
-- valued at the average, or the standard cost per stock unit when there has never been any.
create or replace function inv.ledger_apply() returns trigger
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_level inv.stock_level;
  v_old numeric;
  v_on_hand numeric;
  v_avg numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.item_id::text || new.delivery_node_id::text, 0));
  select * into v_level from inv.stock_level
   where item_id = new.item_id and delivery_node_id = new.delivery_node_id;
  v_old := coalesce(v_level.on_hand, 0);
  v_on_hand := v_old + new.qty;
  if new.qty < 0 and v_on_hand < 0 and new.movement_type <> 'sales_depletion' then
    raise exception 'INSUFFICIENT_STOCK'
      using detail = format('item %s at node %s: %s on hand, movement %s',
                            new.item_id, new.delivery_node_id, v_old, new.qty);
  end if;

  v_avg := coalesce(v_level.avg_cost, 0);
  if new.movement_type in ('receipt', 'transfer_in', 'production_in') then
    v_avg := case when v_old <= 0 or v_on_hand = 0 then new.unit_cost
                  else (v_old * v_avg + new.qty * new.unit_cost) / v_on_hand end;
  elsif new.unit_cost = 0 then
    new.unit_cost := case when v_avg > 0 then v_avg
                          else coalesce((select standard_unit_cost from inv.item
                                          where id = new.item_id), 0) end;
  end if;

  insert into inv.stock_level (tenant_id, item_id, delivery_node_id, on_hand, avg_cost, value,
                               currency, last_movement_at)
  values (new.tenant_id, new.item_id, new.delivery_node_id, v_on_hand, round(v_avg, 4),
          round(v_on_hand * v_avg, 2), new.currency, new.occurred_at)
  on conflict (item_id, delivery_node_id) do update
     set on_hand = excluded.on_hand, avg_cost = excluded.avg_cost, value = excluded.value,
         last_movement_at = greatest(inv.stock_level.last_movement_at, excluded.last_movement_at);
  return new;
end $$;

-- What is left of each dated batch of an item at a store: the store's on-hand belongs to
-- the newest batches first (first in, first out).
create function inv.batch_rows(p_item uuid, p_store uuid)
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
revoke execute on function inv.batch_rows(uuid, uuid) from public;

-- A transfer of a prep item carries the expiry of the oldest batch left at the sending
-- store; the receiving store's row takes it from the dispatch.
create function inv.ledger_batch_expiry() returns trigger
language plpgsql
set search_path = pg_catalog, inv
as $$
begin
  if new.expires_at is null and new.ref_type = 'transfer'
     and exists (select 1 from inv.item where id = new.item_id and kind = 'prep') then
    if new.movement_type = 'transfer_out' then
      select b.expires_at, b.batch_no into new.expires_at, new.batch_no
        from inv.batch_rows(new.item_id, new.delivery_node_id) b
       where b.remaining > 0 order by b.expires_at limit 1;
    elsif new.movement_type = 'transfer_in' then
      select l.expires_at, l.batch_no into new.expires_at, new.batch_no
        from inv.stock_ledger l
       where l.ref_type = 'transfer' and l.ref_id = new.ref_id and l.item_id = new.item_id
         and l.movement_type = 'transfer_out'
       limit 1;
    end if;
  end if;
  return new;
end $$;
revoke execute on function inv.ledger_batch_expiry() from public;
-- before 'apply' (triggers fire in name order)
create trigger a_batch_expiry before insert on inv.stock_ledger
  for each row execute function inv.ledger_batch_expiry();

-- ---------------------------------------------------------------------------
-- Production
-- ---------------------------------------------------------------------------

create table inv.production (
  id uuid primary key default core.uuid_v7(),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  prep_item_id uuid not null references inv.item(id),
  recipe_id uuid not null references inv.recipe(id),
  qty_made numeric(18,6) not null check (qty_made > 0),
  batch_no text not null,
  made_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unit_cost numeric(14,4) not null default 0,
  idempotency_key text
);
select core.add_standard_columns('inv.production');
alter table inv.production add constraint production_idem unique (tenant_id, created_by, idempotency_key);
alter table inv.production add constraint production_batch unique (tenant_id, delivery_node_id, batch_no);

create table inv.production_line (
  id uuid primary key default core.uuid_v7(),
  production_id uuid not null references inv.production(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  ingredient_item_id uuid not null references inv.item(id),
  planned_qty numeric(18,6) not null,           -- stock units, the recipe scaled to the batch
  actual_qty numeric(18,6) not null check (actual_qty >= 0),
  unit_cost numeric(14,4) not null default 0
);
select core.add_standard_columns('inv.production_line');

-- Records a batch of a prep item made at p_store: the ingredients leave by the recipe in
-- force, scaled to p_qty_made (p_actual: [{ingredient_item_id, qty}] in recipe units replaces
-- a line's planned quantity), and the batch arrives with a batch number and an expiry from
-- its shelf life, at the cost of what it used. One transaction: a short ingredient
-- (INSUFFICIENT_STOCK) posts nothing. Returns the production id.
create function inv.record_production(p_store uuid, p_prep uuid, p_qty_made numeric,
                                      p_actual jsonb default null,
                                      p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_tenant uuid := core.my_tenant();
  v_prep inv.item;
  v_recipe inv.recipe;
  v_id uuid;
  v_batch text;
  v_scale numeric;
  v_line record;
  v_qty numeric;
  v_cost numeric;
  v_total numeric := 0;
  v_tz text;
begin
  if p_idempotency_key is not null then
    select id into v_id from inv.production
     where tenant_id = v_tenant and created_by = core.current_user_id()
       and idempotency_key = p_idempotency_key;
    if v_id is not null then
      return v_id;
    end if;
  end if;
  if v_tenant is null or not core.can('PRODUCTION', 'modify', null, p_store) then
    raise exception 'NOT_AUTHORISED' using detail = format('modify PRODUCTION at %s', p_store);
  end if;
  select * into v_prep from inv.item where id = p_prep and tenant_id = v_tenant and kind = 'prep';
  if v_prep.id is null then
    raise exception 'NOT_FOUND' using detail = 'no such prep item';
  end if;
  if not exists (select 1 from inv.item_node where item_id = p_prep and delivery_node_id = p_store
                    and made_here and archived_at is null) then
    raise exception 'NOT_MADE_HERE' using detail = format('%s is not made at this store', v_prep.sku);
  end if;
  if p_qty_made is null or p_qty_made <= 0 then
    raise exception 'INVALID_QUANTITY' using detail = 'how much the batch made';
  end if;
  v_recipe := inv.recipe_on(p_prep, null, current_date);
  if v_recipe.id is null then
    raise exception 'NOT_FOUND' using detail = 'no recipe in force';
  end if;
  v_scale := p_qty_made / v_recipe.batch_yield;
  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_store), 'UTC');
  v_batch := to_char(now() at time zone v_tz, 'YYYYMMDD') || '-' ||
             (select count(*) + 1 from inv.production
               where delivery_node_id = p_store
                 and (made_at at time zone v_tz)::date = (now() at time zone v_tz)::date);

  insert into inv.production (tenant_id, delivery_node_id, prep_item_id, recipe_id, qty_made,
                              batch_no, expires_at, idempotency_key)
  values (v_tenant, p_store, p_prep, v_recipe.id, p_qty_made, v_batch,
          now() + make_interval(hours => v_prep.shelf_life_hours), p_idempotency_key)
  returning id into v_id;

  for v_line in
    select l.ingredient_item_id, l.qty, l.trim_loss_pct,
           coalesce(u.recipe_units_per_stock_unit, 1) as factor,
           (select (a ->> 'qty')::numeric from jsonb_array_elements(coalesce(p_actual, '[]'))
             a where (a ->> 'ingredient_item_id')::uuid = l.ingredient_item_id) as actual
      from inv.recipe_line l left join inv.item_unit u on u.item_id = l.ingredient_item_id
     where l.recipe_id = v_recipe.id order by l.line_no
  loop
    v_qty := coalesce(v_line.actual, v_line.qty / (1 - v_line.trim_loss_pct / 100) * v_scale)
             / v_line.factor;
    if v_qty < 0 then
      raise exception 'INVALID_QUANTITY' using detail = 'an ingredient quantity is negative';
    end if;
    v_cost := 0;
    if v_qty > 0 then
      insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                    ref_type, ref_id)
      values (v_tenant, v_line.ingredient_item_id, p_store, 'production_out', -v_qty,
              'production', v_id)
      returning unit_cost into v_cost;
    end if;
    insert into inv.production_line (tenant_id, production_id, delivery_node_id,
                                     ingredient_item_id, planned_qty, actual_qty, unit_cost)
    values (v_tenant, v_id, p_store, v_line.ingredient_item_id,
            v_line.qty / (1 - v_line.trim_loss_pct / 100) * v_scale / v_line.factor, v_qty, v_cost);
    v_total := v_total + v_qty * v_cost;
  end loop;

  insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                unit_cost, ref_type, ref_id, batch_no, expires_at)
  select v_tenant, p_prep, p_store, 'production_in', p_qty_made, v_total / p_qty_made,
         'production', v_id, v_batch, p.expires_at
    from inv.production p where p.id = v_id;
  update inv.production set unit_cost = round(v_total / p_qty_made, 4) where id = v_id;
  return v_id;
end $$;

-- Dated batches at a store and what is left of each (stock view at the store).
create function inv.batches(p_store uuid)
returns table (item_id uuid, sku text, name text, unit text, batch_no text,
               made_at timestamptz, expires_at timestamptz, qty numeric, remaining numeric,
               expired boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not core.can('STOCK_LEVELS', 'view', null, p_store) then
    raise exception 'NOT_AUTHORISED' using detail = format('view STOCK_LEVELS at %s', p_store);
  end if;
  return query
    select i.id, i.sku, i.name, i.base_uom, b.batch_no, b.made_at, b.expires_at, b.qty,
           b.remaining, b.expires_at <= now()
      from inv.item_node x
      join inv.item i on i.id = x.item_id and i.kind = 'prep'
      cross join lateral inv.batch_rows(x.item_id, p_store) b
     where x.delivery_node_id = p_store and b.remaining > 0
     order by b.expires_at, i.name;
end $$;

-- ---------------------------------------------------------------------------
-- Sales (manual entry now; the POS import posts through the same function)
-- ---------------------------------------------------------------------------

create table menu.sales_day (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),      -- the outlet
  delivery_node_id uuid not null references core.hierarchy_node(id), -- the outlet's supply point
  business_date date not null,
  source text not null check (source in ('manual', 'pos'))
);
select core.add_standard_columns('menu.sales_day');
alter table menu.sales_day add constraint sales_day_key
  unique (tenant_id, org_node_id, business_date, source);

create table menu.sales_line (
  id uuid primary key default core.uuid_v7(),
  sales_day_id uuid not null references menu.sales_day(id),
  menu_item_id uuid not null references menu.menu_item(id),
  org_node_id uuid not null references core.hierarchy_node(id),
  delivery_node_id uuid not null references core.hierarchy_node(id), -- the store it is sold from
  qty numeric(14,3) not null check (qty >= 0),
  price numeric(14,2) not null,
  currency text not null default 'INR'
);
select core.add_standard_columns('menu.sales_line');
alter table menu.sales_line add constraint sales_line_key unique (sales_day_id, menu_item_id);

create table menu.sales_post (
  id uuid primary key default core.uuid_v7(),
  sales_day_id uuid not null references menu.sales_day(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  lines jsonb not null,
  idempotency_key text
);
select core.add_standard_columns('menu.sales_post');
alter table menu.sales_post add constraint sales_post_idem unique (tenant_id, created_by, idempotency_key);

-- Posts a day's sales at an outlet: p_lines [{menu_item_id, qty}] are the day's totals for
-- those items (an item left out keeps what was posted; 0 removes it). Each change from what
-- was posted depletes the store the item is sold from by its recipe in force that day, as
-- sales_depletion movements, which may go below zero; the store keepers are told when they
-- do. Manual entry and the POS import (p_source 'pos') both post here. Returns the day id.
create function menu.post_sales(p_outlet uuid, p_date date, p_lines jsonb,
                                p_source text default 'manual',
                                p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, menu, ops, extensions
as $$
declare
  v_tenant uuid := core.my_tenant();
  v_outlet core.hierarchy_node;
  v_supply uuid;
  v_day uuid;
  v_line record;
  v_mo menu.menu_outlet;
  v_old numeric;
  v_delta numeric;
  v_recipe inv.recipe;
  v_when timestamptz;
  v_neg record;
  v_user uuid;
begin
  if p_source is null or p_source not in ('manual', 'pos') then
    raise exception 'INVALID_SOURCE' using detail = 'sales come from manual entry or the POS import';
  end if;
  if p_idempotency_key is not null then
    select sales_day_id into v_day from menu.sales_post
     where tenant_id = v_tenant and created_by = core.current_user_id()
       and idempotency_key = p_idempotency_key;
    if v_day is not null then
      return v_day;
    end if;
  end if;
  select * into v_outlet from core.hierarchy_node
   where id = p_outlet and tenant_id = v_tenant and type = 'org';
  if v_outlet.id is null then
    raise exception 'NOT_AUTHORISED' using detail = 'post SALES at this outlet';
  end if;
  if p_date is null or p_date > (now() at time zone coalesce(v_outlet.timezone, 'UTC'))::date then
    raise exception 'INVALID_DATE' using detail = 'sales are posted for today or an earlier day';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'INVALID_LINES' using detail = 'no sales to post';
  end if;
  select nl.delivery_node_id into v_supply from core.node_link nl
   where nl.org_node_id = p_outlet limit 1;
  if v_supply is null then
    raise exception 'INVALID_STORE' using detail = 'the outlet has no supply point';
  end if;

  -- every line is sold here that day, and the poster may post sales at its store
  for v_line in select (l ->> 'menu_item_id')::uuid as item, (l ->> 'qty')::numeric as qty
                  from jsonb_array_elements(p_lines) l loop
    if v_line.qty is null or v_line.qty < 0 then
      raise exception 'INVALID_QUANTITY' using detail = 'quantities are zero or more';
    end if;
    select * into v_mo from menu.menu_outlet
     where menu_item_id = v_line.item and org_node_id = p_outlet
       and effective_from <= p_date and (effective_to is null or effective_to >= p_date);
    if v_mo.id is null then
      raise exception 'INVALID_ITEM' using detail = 'a menu item is not sold here on that day';
    end if;
    if not core.can('SALES', 'modify', null, v_mo.delivery_node_id) then
      raise exception 'NOT_AUTHORISED' using detail = format('modify SALES at %s', v_mo.delivery_node_id);
    end if;
  end loop;

  insert into menu.sales_day (tenant_id, org_node_id, delivery_node_id, business_date, source)
  values (v_tenant, p_outlet, v_supply, p_date, p_source)
  on conflict (tenant_id, org_node_id, business_date, source) do update set source = excluded.source
  returning id into v_day;
  insert into menu.sales_post (tenant_id, sales_day_id, delivery_node_id, lines, idempotency_key)
  values (v_tenant, v_day, v_supply, p_lines, p_idempotency_key);

  for v_line in select (l ->> 'menu_item_id')::uuid as item, (l ->> 'qty')::numeric as qty
                  from jsonb_array_elements(p_lines) l loop
    select * into v_mo from menu.menu_outlet
     where menu_item_id = v_line.item and org_node_id = p_outlet
       and effective_from <= p_date and (effective_to is null or effective_to >= p_date);
    select qty into v_old from menu.sales_line where sales_day_id = v_day and menu_item_id = v_line.item;
    v_delta := v_line.qty - coalesce(v_old, 0);
    insert into menu.sales_line (tenant_id, sales_day_id, menu_item_id, org_node_id,
                                 delivery_node_id, qty, price, currency)
    values (v_tenant, v_day, v_line.item, p_outlet, v_mo.delivery_node_id, v_line.qty, v_mo.price,
            v_mo.currency)
    on conflict (sales_day_id, menu_item_id) do update
       set qty = excluded.qty, price = excluded.price, delivery_node_id = excluded.delivery_node_id;
    continue when v_delta = 0;

    v_recipe := inv.recipe_on(null, v_line.item, p_date);
    -- at the end of that business day in the store's time zone, or now for today
    v_when := least(now(), ((p_date + 1)::timestamp at time zone coalesce(
                (select timezone from core.hierarchy_node where id = v_mo.delivery_node_id),
                v_outlet.timezone, 'UTC')) - interval '1 second');
    -- valued as the menu costing values it: the store's average, else standard cost, and a
    -- prep item without stock through its recipe
    insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                  unit_cost, ref_type, ref_id, occurred_at)
    select v_tenant, l.ingredient_item_id, v_mo.delivery_node_id, 'sales_depletion',
           -(v_delta * l.qty / (1 - l.trim_loss_pct / 100) / coalesce(u.recipe_units_per_stock_unit, 1)),
           coalesce(inv.unit_cost(l.ingredient_item_id, v_mo.delivery_node_id, 'current', p_date)
                    * coalesce(u.recipe_units_per_stock_unit, 1), 0),
           'sales_day', v_day, v_when
      from inv.recipe_line l left join inv.item_unit u on u.item_id = l.ingredient_item_id
     where l.recipe_id = v_recipe.id;
  end loop;

  -- below zero after this posting: tell the store keepers of each store, once per post
  for v_neg in
    select s.delivery_node_id as store, string_agg(i.name, ', ' order by i.name) as names
      from inv.stock_level s join inv.item i on i.id = s.item_id
     where s.on_hand < 0
       and (s.item_id, s.delivery_node_id) in (
             select l.item_id, l.delivery_node_id from inv.stock_ledger l
              where l.ref_type = 'sales_day' and l.ref_id = v_day)
     group by s.delivery_node_id
  loop
    for v_user in
      select distinct ra.user_id from core.role_assignment ra
        join core.security_group g on g.id = ra.group_id and g.code = 'STORE_KEEPER'
        join core.hierarchy_node an on an.id = ra.node_id
        join core.hierarchy_node st on st.id = v_neg.store
        join core.app_user u on u.id = ra.user_id and u.status = 'active'
       where ra.tenant_id = v_tenant
         and (an.id = st.id or (ra.include_descendants and an.path @> st.path))
         and ra.effective_from <= current_date
         and (ra.effective_to is null or ra.effective_to >= current_date)
    loop
      perform ops.notify(v_tenant, v_user, 'negative_stock', 'Stock below zero after sales',
                         format('%s at %s: count them or record the receipt.', v_neg.names,
                                (select name from core.hierarchy_node where id = v_neg.store)),
                         '/stock?node=' || v_neg.store);
    end loop;
  end loop;
  return v_day;
end $$;

-- ---------------------------------------------------------------------------
-- Cost control: variance per store and period; food and beverage cost % per outlet
-- ---------------------------------------------------------------------------

-- Per item at a store, between p_from and p_to (whole days, store time zone): opening,
-- each kind of movement, the expected closing (everything but counts), the counted
-- variance (count adjustments) and its value. Unexplained loss: a loss beyond the item's
-- count tolerance. Counts still awaiting approval are shown as pending.
create function inv.variance(p_store uuid, p_from date, p_to date)
returns table (item_id uuid, sku text, name text, unit text, opening numeric, receipts numeric,
               transfers_in numeric, transfers_out numeric, wastage numeric,
               production_in numeric, production_out numeric, sales_use numeric,
               other_use numeric, expected_closing numeric, variance_qty numeric,
               variance_value numeric, closing numeric, counted boolean, pending_qty numeric,
               unexplained boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  if not core.can('MENU', 'view', null, p_store) then
    raise exception 'NOT_AUTHORISED' using detail = format('view MENU at %s', p_store);
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start';
  end if;
  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_store), 'UTC');
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  return query
    with m as (
      select l.item_id,
             sum(l.qty) filter (where l.occurred_at < v_start) as opening,
             sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'receipt') as receipts,
             sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'transfer_in') as tin,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'transfer_out') as tout,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'wastage') as waste,
             sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'production_in') as pin,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'production_out') as pout,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'sales_depletion') as sales,
             -sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'consumption') as other,
             sum(l.qty) filter (where l.occurred_at >= v_start and l.movement_type = 'count_adjust') as var_qty,
             sum(l.qty * l.unit_cost) filter (where l.occurred_at >= v_start
                                               and l.movement_type = 'count_adjust') as var_value
        from inv.stock_ledger l
       where l.delivery_node_id = p_store and l.occurred_at < v_end
       group by l.item_id
    ), c as (
      select cl.item_id, true as counted,
             sum(case when cl.outcome = 'approval' and a.posted_at is null
                      then cl.counted_qty - cl.system_qty else 0 end) as pending
        from inv.stock_count sc
        join inv.stock_count_line cl on cl.count_id = sc.id
        left join inv.stock_adjustment a on a.id = sc.adjustment_id
       where sc.delivery_node_id = p_store and sc.status = 'submitted'
         and sc.submitted_at >= v_start and sc.submitted_at < v_end
         and cl.counted_qty is not null
       group by cl.item_id
    )
    select i.id, i.sku, i.name, i.base_uom,
           coalesce(m.opening, 0), coalesce(m.receipts, 0), coalesce(m.tin, 0), coalesce(m.tout, 0),
           coalesce(m.waste, 0), coalesce(m.pin, 0), coalesce(m.pout, 0), coalesce(m.sales, 0),
           coalesce(m.other, 0),
           coalesce(m.opening, 0) + coalesce(m.receipts, 0) + coalesce(m.tin, 0) - coalesce(m.tout, 0)
             - coalesce(m.waste, 0) + coalesce(m.pin, 0) - coalesce(m.pout, 0) - coalesce(m.sales, 0)
             - coalesce(m.other, 0),
           coalesce(m.var_qty, 0), round(coalesce(m.var_value, 0), 2),
           coalesce(m.opening, 0) + coalesce(m.receipts, 0) + coalesce(m.tin, 0) - coalesce(m.tout, 0)
             - coalesce(m.waste, 0) + coalesce(m.pin, 0) - coalesce(m.pout, 0) - coalesce(m.sales, 0)
             - coalesce(m.other, 0) + coalesce(m.var_qty, 0),
           coalesce(c.counted, false), coalesce(c.pending, 0),
           coalesce(m.var_qty, 0) < 0
             and abs(m.var_qty) > greatest(
                   coalesce(x.count_tolerance_qty, 0),
                   coalesce(x.count_tolerance_pct, 0) / 100
                     * greatest(coalesce(m.opening, 0) + coalesce(m.receipts, 0) + coalesce(m.tin, 0)
                                + coalesce(m.pin, 0), 0))
      from inv.item_node x
      join inv.item i on i.id = x.item_id
      left join m on m.item_id = x.item_id
      left join c on c.item_id = x.item_id
     where x.delivery_node_id = p_store and x.archived_at is null
     order by i.category, i.name;
end $$;

-- Food and beverage cost % at an outlet for a period: revenue (sales × price before tax),
-- theoretical cost (what the recipes say the sales used) and actual cost (theoretical plus
-- wastage, other use and count variance at the stores it sells from, split between Food and
-- Bar by each store's share of their revenue). Only stores where the caller holds MENU view.
create function menu.cost_report(p_outlet uuid, p_from date, p_to date)
returns table (menu text, revenue numeric, theoretical_cost numeric, theoretical_pct numeric,
               actual_cost numeric, actual_pct numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, menu
as $$
declare
  v_tz text;
  v_start timestamptz;
  v_end timestamptz;
begin
  if not exists (select 1 from menu.menu_outlet mo
                  where mo.org_node_id = p_outlet and mo.tenant_id = core.my_tenant()
                    and core.can('MENU', 'view', null, mo.delivery_node_id)) then
    raise exception 'NOT_AUTHORISED' using detail = format('view MENU at %s', p_outlet);
  end if;
  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_outlet), 'UTC');
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  return query
    with stores as (
      select distinct mo.delivery_node_id as store from menu.menu_outlet mo
       where mo.org_node_id = p_outlet and core.can('MENU', 'view', null, mo.delivery_node_id)
    ), sold as (
      select mi.menu, sl.delivery_node_id as store, sum(sl.qty * sl.price) as revenue, sd.id as day
        from menu.sales_day sd
        join menu.sales_line sl on sl.sales_day_id = sd.id
        join menu.menu_item mi on mi.id = sl.menu_item_id
       where sd.org_node_id = p_outlet and sd.business_date between p_from and p_to
         and sl.delivery_node_id in (select store from stores)
       group by mi.menu, sl.delivery_node_id, sd.id
    ), rev as (
      select s.menu, s.store, sum(s.revenue) as revenue from sold s group by s.menu, s.store
    ), share as (
      select r.menu, r.store, r.revenue,
             r.revenue / nullif(sum(r.revenue) over (partition by r.store), 0) as share
        from rev r
    ), depleted as (
      select l.delivery_node_id as store, sum(-l.qty * l.unit_cost) as cost
        from inv.stock_ledger l
        join menu.sales_day sd on sd.id = l.ref_id and l.ref_type = 'sales_day'
       where sd.org_node_id = p_outlet and sd.business_date between p_from and p_to
         and l.delivery_node_id in (select store from stores)
       group by l.delivery_node_id
    ), losses as (
      select l.delivery_node_id as store,
             sum(-l.qty * l.unit_cost) filter (where l.movement_type in ('wastage', 'consumption', 'count_adjust')) as cost
        from inv.stock_ledger l
       where l.delivery_node_id in (select store from stores)
         and l.occurred_at >= v_start and l.occurred_at < v_end
       group by l.delivery_node_id
    )
    select s.menu, round(sum(s.revenue), 2),
           round(sum(coalesce(d.cost, 0) * s.share), 2),
           round(sum(coalesce(d.cost, 0) * s.share) / nullif(sum(s.revenue), 0) * 100, 1),
           round(sum((coalesce(d.cost, 0) + coalesce(lo.cost, 0)) * s.share), 2),
           round(sum((coalesce(d.cost, 0) + coalesce(lo.cost, 0)) * s.share)
                 / nullif(sum(s.revenue), 0) * 100, 1)
      from share s
      left join depleted d on d.store = s.store
      left join losses lo on lo.store = s.store
     group by s.menu
     order by s.menu;
end $$;

-- ---------------------------------------------------------------------------
-- RLS registration (rule 1), audit (rule 5), grants
-- ---------------------------------------------------------------------------

insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('inv.production', 'PRODUCTION', 'delivery', true),
  ('inv.production_line', 'PRODUCTION', 'delivery', true),
  ('menu.sales_day', 'SALES', 'delivery', true),
  ('menu.sales_line', 'SALES', 'delivery', true),
  ('menu.sales_post', 'SALES', 'delivery', true);

do $$
declare t regclass;
begin
  foreach t in array array['inv.production', 'inv.production_line', 'menu.sales_day',
                           'menu.sales_line', 'menu.sales_post']::regclass[] loop
    perform core.apply_domain_rls(t);
    perform audit.enable(t);
  end loop;
end $$;
grant select, insert, update, delete on menu.sales_day, menu.sales_line, menu.sales_post
  to platform_loader;

revoke execute on function inv.record_production(uuid, uuid, numeric, jsonb, text),
  inv.batches(uuid), menu.post_sales(uuid, date, jsonb, text, text),
  inv.variance(uuid, date, date), menu.cost_report(uuid, date, date) from public;
grant execute on function inv.record_production(uuid, uuid, numeric, jsonb, text),
  inv.batches(uuid), menu.post_sales(uuid, date, jsonb, text, text),
  inv.variance(uuid, date, date), menu.cost_report(uuid, date, date) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function if exists menu.cost_report(uuid, date, date), inv.variance(uuid, date, date),
  menu.post_sales(uuid, date, jsonb, text, text), inv.batches(uuid),
  inv.record_production(uuid, uuid, numeric, jsonb, text);
delete from core.domain_table where table_name::text in
  ('inv.production', 'inv.production_line', 'menu.sales_day', 'menu.sales_line', 'menu.sales_post');
drop table menu.sales_post, menu.sales_line, menu.sales_day, inv.production_line, inv.production;
drop trigger a_batch_expiry on inv.stock_ledger;
drop function inv.ledger_batch_expiry(), inv.batch_rows(uuid, uuid);
alter table inv.stock_ledger disable trigger append_only;
delete from inv.stock_ledger where movement_type in ('production_out', 'production_in', 'sales_depletion');
alter table inv.stock_ledger enable trigger append_only;
drop index inv.stock_ledger_batches;
alter table inv.stock_ledger drop constraint stock_ledger_check,
  drop constraint stock_ledger_movement_type_check, drop column expires_at, drop column batch_no,
  add constraint stock_ledger_movement_type_check check (movement_type in
    ('receipt', 'consumption', 'wastage', 'transfer_out', 'transfer_in', 'count_adjust')),
  add constraint stock_ledger_check check (
    (movement_type in ('receipt', 'transfer_in') and qty > 0)
    or (movement_type in ('consumption', 'wastage', 'transfer_out') and qty < 0)
    or movement_type = 'count_adjust');
alter table inv.stock_level add constraint stock_level_on_hand_check check (on_hand >= 0) not valid;
