-- migrate:up

-- Three pieces of pilot readiness in one change:
--   * The POS import by the cashier (SAL-1, SAL-2, ADR 039). The cashier uploads the POS's
--     end-of-day "Sale by item" file; each POS code is matched to a menu item through the
--     outlet's own list (menu.pos_item), never guessed, and the matched lines post as the
--     day's sales with what the POS took (net of discount) and the discount. A new
--     POS_IMPORT domain lets the cashier import without seeing the outlet's sales or costs.
--   * Expiry alerts and dishes to push (INV-12, ADR 040): each morning the team that uses a
--     store hears about the prep about to expire there, with the dishes that use it up, and
--     the outlet's people see "Push today".
--   * Every report row opens (RPT-12, ADR 041): a dish's trend at an outlet and a stock
--     item's trend at a store, by day, week or month.

-- ---------------------------------------------------------------------------
-- Sales lines carry what the POS took
-- ---------------------------------------------------------------------------

-- net: what the POS took for the line after discount (null for typed-in sales, which are
-- valued at the menu price); discount: what was given off.
alter table menu.sales_line
  add column net numeric(14,2) check (net >= 0),
  add column discount numeric(14,2) not null default 0 check (discount >= 0);

-- Revenue is what the POS took where it says so, else quantity at the menu price.
do $$
declare
  v_fn text;
  v_def text;
begin
  foreach v_fn in array array['menu.cost_parts(uuid,uuid[],date,date)',
                              'rpt.calc_sales_day(uuid[],date,date)',
                              'rpt.menu_engineering(uuid,date,date)'] loop
    v_def := pg_get_functiondef(v_fn::regprocedure);
    if (length(v_def) - length(replace(v_def, 'sl.qty * sl.price', ''))) / 17 <> 1 then
      raise exception 'expected one sl.qty * sl.price in %', v_fn;
    end if;
    execute replace(v_def, 'sl.qty * sl.price', 'coalesce(sl.net, sl.qty * sl.price)');
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- POS codes and imports
-- ---------------------------------------------------------------------------

-- An outlet's POS item codes and the menu item each one is (file 23's pos_code, or matched
-- on the import screen by someone who posts the outlet's sales).
create table menu.pos_item (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),      -- the outlet
  delivery_node_id uuid not null references core.hierarchy_node(id), -- the store it is sold from
  pos_code text not null check (pos_code ~ '^[^[:space:][:cntrl:]]{1,40}$'),
  menu_item_id uuid not null references menu.menu_item(id)
);
select core.add_standard_columns('menu.pos_item');
alter table menu.pos_item add constraint pos_item_key unique (tenant_id, org_node_id, pos_code);

-- Each file imported: its lines (merged by POS code), totals, and what did not match.
create table menu.pos_import (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),      -- the outlet
  delivery_node_id uuid not null references core.hierarchy_node(id), -- its supply point
  business_date date not null,
  file_name text not null check (length(file_name) between 1 and 200),
  pos_outlets text[] not null default '{}',
  lines jsonb not null,
  net numeric(14,2) not null,
  discount numeric(14,2) not null,
  posted int not null default 0,
  unmatched jsonb not null default '[]',
  sales_day_id uuid references menu.sales_day(id),
  idempotency_key text
);
select core.add_standard_columns('menu.pos_import');
alter table menu.pos_import add constraint pos_import_idem
  unique (tenant_id, created_by, idempotency_key);
create index pos_import_day on menu.pos_import (org_node_id, business_date, created_at desc);

-- The day's sales at an outlet, from manual entry or the POS import: p_lines
-- [{menu_item_id, qty, net?, discount?}] are the day's totals for those items (an item
-- left out keeps what was posted; 0 removes it). Each change from what was posted depletes
-- the store the item is sold from by its recipe in force that day, as sales_depletion
-- movements, which may go below zero; the store keepers are told when they do. No access
-- check: menu.post_sales and the import check before they call it (not granted to app_rw).
create function menu.sales_apply(p_outlet uuid, p_date date, p_lines jsonb, p_source text,
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

  for v_line in select (l ->> 'menu_item_id')::uuid as item, (l ->> 'qty')::numeric as qty,
                       (l ->> 'net')::numeric as net, (l ->> 'discount')::numeric as discount
                  from jsonb_array_elements(p_lines) l loop
    if v_line.qty is null or v_line.qty < 0 then
      raise exception 'INVALID_QUANTITY' using detail = 'quantities are zero or more';
    end if;
    if v_line.net < 0 or v_line.discount < 0 then
      raise exception 'INVALID_AMOUNT' using detail = 'amounts are zero or more';
    end if;
    if not exists (select 1 from menu.menu_outlet
                    where menu_item_id = v_line.item and org_node_id = p_outlet
                      and effective_from <= p_date
                      and (effective_to is null or effective_to >= p_date)) then
      raise exception 'INVALID_ITEM' using detail = 'a menu item is not sold here on that day';
    end if;
  end loop;

  insert into menu.sales_day (tenant_id, org_node_id, delivery_node_id, business_date, source)
  values (v_tenant, p_outlet, v_supply, p_date, p_source)
  on conflict (tenant_id, org_node_id, business_date, source) do update set source = excluded.source
  returning id into v_day;
  insert into menu.sales_post (tenant_id, sales_day_id, delivery_node_id, lines, idempotency_key)
  values (v_tenant, v_day, v_supply, p_lines, p_idempotency_key);

  for v_line in select (l ->> 'menu_item_id')::uuid as item, (l ->> 'qty')::numeric as qty,
                       (l ->> 'net')::numeric as net,
                       coalesce((l ->> 'discount')::numeric, 0) as discount
                  from jsonb_array_elements(p_lines) l loop
    select * into v_mo from menu.menu_outlet
     where menu_item_id = v_line.item and org_node_id = p_outlet
       and effective_from <= p_date and (effective_to is null or effective_to >= p_date);
    select qty into v_old from menu.sales_line where sales_day_id = v_day and menu_item_id = v_line.item;
    v_delta := v_line.qty - coalesce(v_old, 0);
    insert into menu.sales_line (tenant_id, sales_day_id, menu_item_id, org_node_id,
                                 delivery_node_id, qty, price, currency, net, discount)
    values (v_tenant, v_day, v_line.item, p_outlet, v_mo.delivery_node_id, v_line.qty, v_mo.price,
            v_mo.currency, v_line.net, v_line.discount)
    on conflict (sales_day_id, menu_item_id) do update
       set qty = excluded.qty, price = excluded.price, delivery_node_id = excluded.delivery_node_id,
           net = excluded.net, discount = excluded.discount;
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

-- Typed-in sales (SAL-1): the same as before, for people who post SALES where each item is
-- sold. POS sales come only through the import, and a day the POS import posted is closed
-- to typing in (its sales are what the POS took).
create or replace function menu.post_sales(p_outlet uuid, p_date date, p_lines jsonb,
                                           p_source text default 'manual',
                                           p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, menu, ops, extensions
as $$
declare
  v_tenant uuid := core.my_tenant();
  v_outlet core.hierarchy_node;
  v_line record;
  v_mo menu.menu_outlet;
begin
  if p_source is null or p_source <> 'manual' then
    raise exception 'INVALID_SOURCE' using detail = 'sales are typed in here; POS sales come through the import';
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
  if exists (select 1 from menu.sales_day sd join menu.sales_line sl on sl.sales_day_id = sd.id
              where sd.org_node_id = p_outlet and sd.business_date = p_date
                and sd.source = 'pos' and sl.qty > 0) then
    raise exception 'SALES_FROM_POS' using detail = 'this day''s sales came from the POS import';
  end if;
  return menu.sales_apply(p_outlet, p_date, p_lines, 'manual', p_idempotency_key);
end $$;

-- May the caller import at this outlet's store (POS_IMPORT, or SALES as for typing in)?
create function menu.can_import(p_store uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select core.can('POS_IMPORT', 'modify', null, p_store) or core.can('SALES', 'modify', null, p_store)
$$;

-- An outlet the caller imports at: in their company, with a store on its menu they import for.
create function menu.require_import(p_outlet uuid) returns core.hierarchy_node
language plpgsql stable security definer
set search_path = pg_catalog, core, menu
as $$
declare
  v_outlet core.hierarchy_node;
begin
  select * into v_outlet from core.hierarchy_node
   where id = p_outlet and tenant_id = core.my_tenant() and type = 'org' and archived_at is null;
  if v_outlet.id is null
     or not exists (select 1 from menu.menu_outlet mo
                     where mo.org_node_id = p_outlet and menu.can_import(mo.delivery_node_id)) then
    raise exception 'NOT_AUTHORISED' using detail = format('import POS sales at %s', p_outlet);
  end if;
  return v_outlet;
end $$;

-- What an import did, as the screen shows it.
create function menu.pos_result(p_import menu.pos_import) returns jsonb
language sql stable
set search_path = pg_catalog, menu
as $$
  select jsonb_build_object('import_id', p_import.id, 'posted', p_import.posted,
                            'unmatched', p_import.unmatched, 'net', p_import.net,
                            'discount', p_import.discount, 'business_date', p_import.business_date)
$$;

-- Posts an import's lines: each POS code through the outlet's list to the menu item sold
-- there that day; the day's earlier POS lines that this file leaves out go to 0 (the file is
-- the whole day), and typed-in sales for the day are reversed (the POS replaces them).
create function menu.pos_post(p_import uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, menu
as $$
declare
  v_imp menu.pos_import;
  v_denied boolean;
  v_lines jsonb := '[]';
  v_unmatched jsonb := '[]';
  v_seen uuid[] := '{}';
  v_posted int := 0;
  v_day uuid;
  v_manual jsonb;
begin
  select * into v_imp from menu.pos_import where id = p_import;
  -- each line through the outlet's list to the menu item sold there that day; two codes for
  -- one dish (dine-in and take-away) add up
  with m as (
    select l ->> 'code' as code, l ->> 'description' as description,
           (l ->> 'qty')::numeric as qty, (l ->> 'value')::numeric as value,
           (l ->> 'discount')::numeric as discount, mo.menu_item_id, mo.delivery_node_id
      from jsonb_array_elements(v_imp.lines) l
      left join menu.pos_item p on p.org_node_id = v_imp.org_node_id and p.pos_code = l ->> 'code'
      left join menu.menu_outlet mo
        on mo.menu_item_id = p.menu_item_id and mo.org_node_id = p.org_node_id
       and mo.effective_from <= v_imp.business_date
       and (mo.effective_to is null or mo.effective_to >= v_imp.business_date)
  ), dish as (
    select menu_item_id, sum(qty) as qty, sum(value) as net, sum(discount) as discount
      from m where menu_item_id is not null group by menu_item_id
  )
  select (select count(*) from m where menu_item_id is not null),
         coalesce((select array_agg(menu_item_id) from dish), '{}'),
         coalesce((select jsonb_agg(jsonb_build_object('code', code, 'description', description,
                                                       'qty', qty, 'value', value) order by code)
                     from m where menu_item_id is null), '[]'),
         coalesce((select jsonb_agg(jsonb_build_object('menu_item_id', menu_item_id, 'qty', qty,
                                                       'net', net, 'discount', discount))
                     from dish), '[]'),
         exists (select 1 from m where menu_item_id is not null
                                   and not menu.can_import(delivery_node_id))
    into v_posted, v_seen, v_unmatched, v_lines, v_denied;
  if v_denied then
    raise exception 'NOT_AUTHORISED' using detail = 'import POS sales at every store on the file';
  end if;
  -- the file is the whole day: what an earlier import posted and this one does not goes to 0
  v_lines := v_lines || coalesce((
    select jsonb_agg(jsonb_build_object('menu_item_id', sl.menu_item_id, 'qty', 0, 'net', 0,
                                        'discount', 0))
      from menu.sales_day sd join menu.sales_line sl on sl.sales_day_id = sd.id
     where sd.org_node_id = v_imp.org_node_id and sd.business_date = v_imp.business_date
       and sd.source = 'pos' and sl.qty > 0 and sl.menu_item_id <> all (v_seen)), '[]');
  -- the POS replaces what was typed in for the day
  select jsonb_agg(jsonb_build_object('menu_item_id', sl.menu_item_id, 'qty', 0)) into v_manual
    from menu.sales_day sd join menu.sales_line sl on sl.sales_day_id = sd.id
   where sd.org_node_id = v_imp.org_node_id and sd.business_date = v_imp.business_date
     and sd.source = 'manual' and sl.qty > 0;
  if v_manual is not null then
    perform menu.sales_apply(v_imp.org_node_id, v_imp.business_date, v_manual, 'manual');
  end if;
  if jsonb_array_length(v_lines) > 0 then
    v_day := menu.sales_apply(v_imp.org_node_id, v_imp.business_date, v_lines, 'pos');
  end if;
  update menu.pos_import set posted = v_posted, unmatched = v_unmatched, sales_day_id = v_day
   where id = p_import returning * into v_imp;
  return menu.pos_result(v_imp);
end $$;

-- Imports a day's POS file at an outlet (SAL-2). p_file is the file as the app read it:
-- {file_name, pos_outlets[], period_from, period_to, total_value,
--  lines: [{code, description, qty, value, discount}]}, value being what the POS took after
-- the discount. A file for several days, or for another day, is refused, as is one whose
-- lines do not add up to its total. Returns {import_id, posted, unmatched[], net, discount}.
create function menu.import_pos(p_outlet uuid, p_date date, p_file jsonb,
                                p_idempotency_key text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, menu
as $$
declare
  v_tenant uuid := core.my_tenant();
  v_outlet core.hierarchy_node;
  v_imp menu.pos_import;
  v_supply uuid;
  v_from date;
  v_to date;
  v_bad int;
  v_lines jsonb;
  v_net numeric;
  v_discount numeric;
begin
  if p_idempotency_key is not null then
    select * into v_imp from menu.pos_import
     where tenant_id = v_tenant and created_by = core.current_user_id()
       and idempotency_key = p_idempotency_key;
    if v_imp.id is not null then
      return menu.pos_result(v_imp);
    end if;
  end if;
  v_outlet := menu.require_import(p_outlet);
  perform core.require_module('menu_sales');
  if p_date is null or p_date > (now() at time zone coalesce(v_outlet.timezone, 'UTC'))::date then
    raise exception 'INVALID_DATE' using detail = 'sales are imported for today or an earlier day';
  end if;
  if p_file is null or jsonb_typeof(p_file -> 'lines') <> 'array'
     or jsonb_array_length(p_file -> 'lines') = 0 or jsonb_array_length(p_file -> 'lines') > 5000
     or coalesce(length(p_file ->> 'file_name'), 0) not between 1 and 200 then
    raise exception 'INVALID_LINES' using detail = 'the file has no sales lines';
  end if;
  v_from := (p_file ->> 'period_from')::date;
  v_to := coalesce((p_file ->> 'period_to')::date, v_from);
  if v_from is not null and v_to <> v_from then
    raise exception 'POS_FILE_SPANS_DAYS' using detail = 'export one day at a time from the POS';
  end if;
  if v_from is not null and v_from <> p_date then
    raise exception 'POS_FILE_OTHER_DAY' using detail = format('the file is for %s', v_from);
  end if;
  select count(*) filter (where coalesce(length(l ->> 'code'), 0) not between 1 and 40
                             or (l ->> 'code') ~ '[[:space:][:cntrl:]]'),
         count(*) filter (where (l ->> 'qty')::numeric is null or (l ->> 'qty')::numeric < 0)
    into v_bad, v_net
    from jsonb_array_elements(p_file -> 'lines') l;
  if v_bad > 0 then
    raise exception 'INVALID_LINES' using detail = 'every line has a POS item code';
  end if;
  if v_net > 0 then
    raise exception 'INVALID_QUANTITY' using detail = 'quantities are zero or more';
  end if;
  if exists (select 1 from jsonb_array_elements(p_file -> 'lines') l
              where coalesce((l ->> 'value')::numeric, -1) < 0
                 or coalesce((l ->> 'discount')::numeric, 0) < 0) then
    raise exception 'INVALID_AMOUNT' using detail = 'amounts are zero or more';
  end if;
  -- merged by code: an item sold at two rates is one line
  select jsonb_agg(jsonb_build_object('code', code, 'description', description, 'qty', qty,
                                      'value', value, 'discount', discount) order by code),
         sum(value), sum(discount)
    into v_lines, v_net, v_discount
    from (select l ->> 'code' as code, min(left(l ->> 'description', 200)) as description,
                 sum((l ->> 'qty')::numeric) as qty, round(sum((l ->> 'value')::numeric), 2) as value,
                 round(sum(coalesce((l ->> 'discount')::numeric, 0)), 2) as discount
            from jsonb_array_elements(p_file -> 'lines') l group by 1) m;
  if round(v_net, 2) <> round(coalesce((p_file ->> 'total_value')::numeric, -1), 2) then
    raise exception 'POS_TOTALS_MISMATCH'
      using detail = format('the lines add up to %s, the file''s total is %s', v_net,
                            p_file ->> 'total_value');
  end if;
  select nl.delivery_node_id into v_supply from core.node_link nl
   where nl.org_node_id = p_outlet limit 1;
  insert into menu.pos_import (tenant_id, org_node_id, delivery_node_id, business_date, file_name,
                               pos_outlets, lines, net, discount, idempotency_key)
  values (v_tenant, p_outlet, v_supply, p_date, p_file ->> 'file_name',
          coalesce(array(select left(x, 100) from jsonb_array_elements_text(p_file -> 'pos_outlets') x
                          limit 20), '{}'),
          v_lines, v_net, v_discount, p_idempotency_key)
  returning * into v_imp;
  return menu.pos_post(v_imp.id);
end $$;

-- Posts an import again, after someone matched its codes: a new import of the same lines.
create function menu.repost_pos(p_import uuid) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, menu
as $$
declare
  v_imp menu.pos_import;
begin
  select * into v_imp from menu.pos_import where id = p_import and tenant_id = core.my_tenant();
  if v_imp.id is null then
    raise exception 'NOT_FOUND' using detail = 'no such import';
  end if;
  perform menu.require_import(v_imp.org_node_id);
  insert into menu.pos_import (tenant_id, org_node_id, delivery_node_id, business_date, file_name,
                               pos_outlets, lines, net, discount)
  values (v_imp.tenant_id, v_imp.org_node_id, v_imp.delivery_node_id, v_imp.business_date,
          v_imp.file_name, v_imp.pos_outlets, v_imp.lines, v_imp.net, v_imp.discount)
  returning * into v_imp;
  return menu.pos_post(v_imp.id);
end $$;

-- Matches a POS code to a menu item on the outlet's menu. The cashier who imports matches the
-- codes nobody has matched yet; changing a code already matched moves its sales and stock use
-- to another dish, so that stays with people who post the outlet's sales.
create function menu.map_pos_item(p_outlet uuid, p_code text, p_menu_item uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, menu
as $$
declare
  v_mo menu.menu_outlet;
  v_was menu.pos_item;
begin
  perform menu.require_import(p_outlet);
  if p_code is null or p_code !~ '^[^[:space:][:cntrl:]]{1,40}$' then
    raise exception 'INVALID_CODE' using detail = 'a POS item code, up to 40 characters';
  end if;
  select * into v_mo from menu.menu_outlet
   where org_node_id = p_outlet and menu_item_id = p_menu_item
     and (effective_to is null or effective_to >= current_date)
   order by effective_from limit 1;
  if v_mo.id is null then
    raise exception 'INVALID_ITEM' using detail = 'the menu item is not on this outlet''s menu';
  end if;
  if not menu.can_import(v_mo.delivery_node_id) then
    raise exception 'NOT_AUTHORISED' using detail = format('import POS sales at %s', v_mo.delivery_node_id);
  end if;
  select * into v_was from menu.pos_item
   where tenant_id = v_mo.tenant_id and org_node_id = p_outlet and pos_code = p_code;
  if v_was.id is not null and v_was.menu_item_id <> p_menu_item
     and not core.can('SALES', 'modify', null, v_was.delivery_node_id) then
    raise exception 'POS_CODE_MATCHED' using detail = format('code %s is already matched', p_code);
  end if;
  insert into menu.pos_item (tenant_id, org_node_id, delivery_node_id, pos_code, menu_item_id)
  values (v_mo.tenant_id, p_outlet, v_mo.delivery_node_id, p_code, p_menu_item)
  on conflict (tenant_id, org_node_id, pos_code) do update
     set menu_item_id = excluded.menu_item_id, delivery_node_id = excluded.delivery_node_id;
end $$;

-- The dishes on an outlet's menu that a code can be matched to, for whoever imports there:
-- names and menu only, no prices, costs or sales.
create function menu.pos_dishes(p_outlet uuid)
returns table (menu_item_id uuid, name text, menu text)
language plpgsql stable security definer
set search_path = pg_catalog, core, menu
as $$
begin
  perform menu.require_import(p_outlet);
  return query
    select mi.id, mi.name, mi.menu
      from menu.menu_outlet mo
      join menu.menu_item mi on mi.id = mo.menu_item_id and mi.archived_at is null
     where mo.org_node_id = p_outlet
       and mo.effective_from <= current_date
       and (mo.effective_to is null or mo.effective_to >= current_date)
       and menu.can_import(mo.delivery_node_id)
     order by mi.menu, mi.category, mi.name;
end $$;

-- The latest import of a day at an outlet, for the import screen and the cashier's Home.
create function menu.pos_import_of(p_outlet uuid, p_date date)
returns table (id uuid, file_name text, imported_at timestamptz, imported_by text, net numeric,
               discount numeric, posted int, unmatched jsonb)
language plpgsql stable security definer
set search_path = pg_catalog, core, menu
as $$
begin
  perform menu.require_import(p_outlet);
  return query
    select i.id, i.file_name, i.created_at, u.display_name, i.net, i.discount, i.posted, i.unmatched
      from menu.pos_import i left join core.app_user u on u.id = i.created_by
     where i.org_node_id = p_outlet and i.business_date = p_date
     order by i.created_at desc, i.id desc limit 1;
end $$;

-- Outlets where the caller imports POS sales.
create function menu.pos_places()
returns table (outlet_id uuid, outlet_name text)
language sql stable security definer
set search_path = pg_catalog, core, menu
as $$
  select distinct o.id, o.name
    from menu.menu_outlet mo join core.hierarchy_node o on o.id = mo.org_node_id
   where mo.tenant_id = core.my_tenant() and o.archived_at is null
     and (mo.effective_to is null or mo.effective_to >= current_date)
     and menu.can_import(mo.delivery_node_id)
   order by 2;
$$;

-- The import screen's places (the "Place:" picker, ADR 016): outlets where the caller imports.
do $$
declare
  v_def text := pg_get_functiondef('core.screen_places(text)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def, $a$'team_people', 'team_leave') then
    raise exception 'INVALID_SCREEN'$a$, $a$'team_people', 'team_leave', 'pos_import') then
    raise exception 'INVALID_SCREEN'$a$);
  v_new := replace(v_new, $a$         when p_screen in ('sales', 'menu') then$a$,
    $a$         when p_screen = 'pos_import' then
           n.type = 'org'
           and exists (select 1 from menu.menu_outlet mo
                        where mo.org_node_id = n.id
                          and (mo.effective_to is null or mo.effective_to >= current_date)
                          and menu.can_import(mo.delivery_node_id))
         when p_screen in ('sales', 'menu') then$a$);
  if length(v_new) - length(v_def) < 300 then
    raise exception 'core.screen_places did not take the pos_import screen';
  end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Expiry alerts and dishes to push (INV-12)
-- ---------------------------------------------------------------------------

-- Batches at a store with stock left that expire by the end of tomorrow's business day,
-- not yet expired (those go to the discard flow, TSK-6).
create function inv.expiring_soon(p_store uuid, p_now timestamptz default now())
returns table (item_id uuid, name text, unit text, batch_no text, expires_at timestamptz,
               remaining numeric)
language sql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt
as $$
  select i.id, i.name, i.base_uom, b.batch_no, b.expires_at, b.remaining
    from (select coalesce(ops.tz_of(p_store), 'UTC') as tz) z
    cross join inv.item_node x
    join inv.item i on i.id = x.item_id
    cross join lateral inv.batch_rows(x.item_id, p_store) b
   where x.delivery_node_id = p_store and x.archived_at is null
     and exists (select 1 from inv.stock_ledger l
                  where l.item_id = x.item_id and l.delivery_node_id = p_store
                    and l.expires_at > p_now)
     and b.remaining > 0 and b.expires_at > p_now
     and rpt.business_date(b.expires_at, z.tz) <= rpt.business_date(p_now, z.tz) + 1
$$;

-- Dishes sold from a store whose own recipe that day uses an item (not through another prep:
-- selling a whisky sour uses up sour mix, not the syrup it was made from).
create function menu.dishes_using(p_item uuid, p_store uuid, p_date date)
returns table (menu_item_id uuid, outlet_id uuid, name text, menu text)
language sql stable security definer
set search_path = pg_catalog, inv, menu
as $$
  select distinct m.id, mo.org_node_id, m.name, m.menu
    from menu.menu_outlet mo
    join menu.menu_item m on m.id = mo.menu_item_id
    cross join lateral inv.recipe_on(null, mo.menu_item_id, p_date) r
    join inv.recipe_line l on l.recipe_id = r.id
   where mo.delivery_node_id = p_store and l.ingredient_item_id = p_item
     and mo.effective_from <= p_date and (mo.effective_to is null or mo.effective_to >= p_date)
$$;

-- "Push today" at an outlet: its dishes that use prep expiring by the end of tomorrow at the
-- store they are sold from. For everyone who works at the outlet (ops.works_at: their home
-- is there, or access that covers it); dish and item names only, never recipes or costs.
create function menu.push_today(p_outlet uuid)
returns table (menu_item_id uuid, dish text, menu text, item text, expires_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, menu, ops, rpt
as $$
declare
  v_outlet core.hierarchy_node;
  v_today date;
begin
  select * into v_outlet from core.hierarchy_node
   where id = p_outlet and tenant_id = core.my_tenant() and type = 'org' and kind = 'outlet';
  if v_outlet.id is null or not ops.works_at(p_outlet) then
    raise exception 'NOT_AUTHORISED' using detail = format('Push today at %s', p_outlet);
  end if;
  if not core.module_on(v_outlet.tenant_id, 'menu_sales') then
    return;
  end if;
  v_today := rpt.today(p_outlet);
  return query
    select d.menu_item_id, d.name, d.menu, e.name, min(e.expires_at)
      from (select distinct mo.delivery_node_id as store from menu.menu_outlet mo
             where mo.org_node_id = p_outlet and mo.effective_from <= v_today
               and (mo.effective_to is null or mo.effective_to >= v_today)) s
      cross join lateral inv.expiring_soon(s.store) e
      cross join lateral menu.dishes_using(e.item_id, s.store, v_today) d
     where d.outlet_id = p_outlet
     group by d.menu_item_id, d.name, d.menu, e.name
     order by min(e.expires_at), d.name, e.name;
end $$;

-- Home's "Push today" card: at the caller's home outlet, for its service teams (servers,
-- bartenders, cashiers, hosts) and the people whose home is the outlet itself (its
-- managers). Kitchen teams hear through the morning alert instead.
create function menu.my_push_today()
returns table (outlet_id uuid, outlet text, menu_item_id uuid, dish text, menu text, item text,
               expires_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, menu
as $$
declare
  v_home core.hierarchy_node;
  v_outlet core.hierarchy_node;
begin
  select n.* into v_home from hr.worker w join core.hierarchy_node n on n.id = w.org_node_id
   where w.owner_user_id = core.current_user_id() and w.status = 'active'
   order by w.id limit 1;
  if v_home.id is null
     or not (v_home.kind = 'outlet'
             or (v_home.kind = 'department' and v_home.department_type = 'service')) then
    return;
  end if;
  select * into v_outlet from core.hierarchy_node
   where id = core.nearest(v_home.id, array['outlet']);
  if v_outlet.id is null then
    return;
  end if;
  return query select v_outlet.id, v_outlet.name, p.* from menu.push_today(v_outlet.id) p;
end $$;

-- The morning alert (the tasks job, every 5 minutes): once each business day, from 06:00,
-- the leads of the team that uses each store hear what expires there by the end of
-- tomorrow, and the dishes that use it up. Returns how many notifications went out.
create function ops.expiry_alerts(p_now timestamptz default now()) returns int
language plpgsql security definer
set search_path = pg_catalog, core, inv, menu, ops, rpt
as $$
declare
  v_store core.hierarchy_node;
  v_tz text;
  v_items text;
  v_count int;
  v_first text;
  v_link text;
  v_team uuid;
  v_user uuid;
  v_sent int := 0;
begin
  for v_store in
    select n.* from core.hierarchy_node n
     where n.type = 'delivery' and n.holds_stock and n.archived_at is null
       and core.tenant_active(n.tenant_id) and core.module_on(n.tenant_id, 'menu_sales')
       and exists (select 1 from inv.stock_ledger l
                    where l.delivery_node_id = n.id and l.expires_at > p_now)
     order by n.tenant_id, n.name
  loop
    v_tz := coalesce(ops.tz_of(v_store.id), 'UTC');
    select count(*), min(x.name),
           string_agg(format('%s: %s %s, use by %s%s', x.name, trim_scale(round(x.left_qty, 3)),
                             x.unit, to_char(x.first_expiry at time zone v_tz, 'Dy FMDD Mon'),
                             coalesce(' (' || x.dishes || ')', '')),
                      '. ' order by x.first_expiry, x.name)
      into v_count, v_first, v_items
      from (select e.item_id, e.name, e.unit, sum(e.remaining) as left_qty,
                   min(e.expires_at) as first_expiry,
                   (select string_agg(distinct d.name, ', ')
                      from menu.dishes_using(e.item_id, v_store.id, rpt.business_date(p_now, v_tz)) d) as dishes
              from inv.expiring_soon(v_store.id, p_now) e
             group by e.item_id, e.name, e.unit) x;
    continue when v_count = 0;
    v_team := ops.team_of_store(v_store.id);
    continue when v_team is null;
    v_link := '/stock/expiry?node=' || v_store.id;
    foreach v_user in array ops.leads(v_team) loop
      continue when exists (
        select 1 from ops.notification nt
         where nt.owner_user_id = v_user and nt.kind = 'expiry_soon' and nt.link = v_link
           and nt.created_at >= rpt.day_start(rpt.business_date(p_now, v_tz), v_tz));
      perform ops.notify(v_store.tenant_id, v_user, 'expiry_soon',
                         'Use first today: ' || case when v_count = 1 then v_first
                                                     else v_count || ' items' end,
                         left(v_items || '.', 1000), v_link);
      v_sent := v_sent + 1;
    end loop;
  end loop;
  return v_sent;
end $$;

-- ---------------------------------------------------------------------------
-- Every row opens (RPT-12)
-- ---------------------------------------------------------------------------

-- The periods of a trend: each day, week (from Monday) or month from p_from's to p_to's.
create function rpt.periods(p_grain text, p_from date, p_to date) returns setof date
language plpgsql immutable
set search_path = pg_catalog
as $$
begin
  if p_grain is null or p_grain not in ('day', 'week', 'month') then
    raise exception 'INVALID_GRAIN' using detail = 'by day, week or month';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start, a year at most';
  end if;
  return query
    select g::date from generate_series(date_trunc(p_grain, p_from::timestamp),
                                        date_trunc(p_grain, p_to::timestamp),
                                        ('1 ' || p_grain)::interval) g;
end $$;

-- A dish at an outlet, per period: sold, what it took (net of discount), the discount, the
-- recipe cost (as menu engineering works it out, ADR 028) and the margin. Opens where menu
-- engineering opens, for a dish sold from a store whose menu costs the caller sees.
create function rpt.dish_trend(p_outlet uuid, p_menu_item uuid, p_grain text, p_from date,
                               p_to date)
returns table (period date, sold numeric, sales numeric, discount numeric, cost numeric,
               margin numeric, dish text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, menu, rpt
as $$
declare
  v_stores uuid[];
  v_from date;
begin
  perform rpt.require('menu_engineering', p_outlet);
  perform core.require_module('menu_sales');
  perform rpt.periods(p_grain, p_from, p_to);
  v_from := date_trunc(p_grain, p_from::timestamp)::date;
  select coalesce(array_agg(distinct mo.delivery_node_id), '{}') into v_stores
    from menu.menu_outlet mo
   where mo.org_node_id = p_outlet
     and (core.can('REPORTS', 'view', p_outlet, null)
          or core.can('MENU', 'view', null, mo.delivery_node_id));
  if not exists (select 1 from menu.menu_outlet mo
                  where mo.org_node_id = p_outlet and mo.menu_item_id = p_menu_item
                    and mo.delivery_node_id = any (v_stores)
                    and mo.effective_from <= p_to
                    and (mo.effective_to is null or mo.effective_to >= v_from)) then
    raise exception 'INVALID_ITEM' using detail = 'the dish is not sold here in that period';
  end if;
  return query
    with sold as (
      select sd.business_date, sl.delivery_node_id as store, sum(sl.qty) as qty,
             sum(coalesce(sl.net, sl.qty * sl.price)) as sales, sum(sl.discount) as discount
        from menu.sales_day sd
        join menu.sales_line sl on sl.sales_day_id = sd.id
       where sd.org_node_id = p_outlet and sl.menu_item_id = p_menu_item
         and sd.business_date between v_from and p_to and sl.delivery_node_id = any (v_stores)
       group by 1, 2
    ), costed as (
      select date_trunc(p_grain, s.business_date::timestamp)::date as p, s.qty, s.sales,
             s.discount,
             s.qty * inv.recipe_cost((inv.recipe_on(null, p_menu_item, s.business_date)).id,
                                     s.store, 'current', s.business_date) as cost
        from sold s
    ), per as (
      select p.p, coalesce(sum(c.qty), 0) as qty, round(coalesce(sum(c.sales), 0), 2) as sales,
             round(coalesce(sum(c.discount), 0), 2) as discount,
             round(coalesce(sum(c.cost), 0), 2) as cost
        from rpt.periods(p_grain, p_from, p_to) p(p)
        left join costed c on c.p = p.p
       group by p.p
    )
    select per.p, per.qty, per.sales, per.discount, per.cost, per.sales - per.cost,
           (select m.name from menu.menu_item m where m.id = p_menu_item)
      from per order by per.p;
end $$;

-- A stock item at one store, per period: what came in (received, transferred in, made),
-- the value received from suppliers and the average price paid, what was used (sold, made
-- into prep, used), wasted and sent out, the count differences, and the closing stock.
-- Opens where the stock position opens for that store (ADR 028).
create function rpt.item_trend(p_store uuid, p_item uuid, p_grain text, p_from date, p_to date)
returns table (period date, came_in numeric, received_value numeric, avg_price numeric,
               used numeric, used_value numeric, wasted numeric, wasted_value numeric,
               sent_out numeric, counted numeric, closing numeric, item text, unit text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, rpt, ops
as $$
declare
  v_store core.hierarchy_node;
  v_tz text;
  v_from date;
  v_open numeric;
begin
  perform rpt.require('stock_position', p_store);
  select * into v_store from core.hierarchy_node where id = p_store;
  if not v_store.holds_stock then
    raise exception 'INVALID_STORE' using detail = 'one store at a time';
  end if;
  perform rpt.periods(p_grain, p_from, p_to);
  if not exists (select 1 from inv.item_node x join inv.item i on i.id = x.item_id
                  where x.delivery_node_id = p_store and x.item_id = p_item
                    and i.tenant_id = v_store.tenant_id) then
    raise exception 'INVALID_ITEM' using detail = 'the item is not kept at this store';
  end if;
  v_tz := coalesce(ops.tz_of(p_store), 'UTC');
  v_from := date_trunc(p_grain, p_from::timestamp)::date;
  select coalesce(sum(l.qty), 0) into v_open from inv.stock_ledger l
   where l.item_id = p_item and l.delivery_node_id = p_store
     and l.occurred_at < rpt.day_start(v_from, v_tz);
  return query
    with moves as (
      select date_trunc(p_grain, rpt.business_date(l.occurred_at, v_tz)::timestamp)::date as p,
             l.movement_type as t, l.qty, l.qty * l.unit_cost as v
        from inv.stock_ledger l
       where l.item_id = p_item and l.delivery_node_id = p_store
         and l.occurred_at >= rpt.day_start(v_from, v_tz)
         and l.occurred_at < rpt.day_start(p_to + 1, v_tz)
    ), per as (
      select p.p,
             coalesce(sum(m.qty) filter (where m.t in ('receipt', 'transfer_in', 'production_in')), 0) as came_in,
             coalesce(sum(m.v) filter (where m.t = 'receipt'), 0) as received_value,
             sum(m.v) filter (where m.t = 'receipt')
               / nullif(sum(m.qty) filter (where m.t = 'receipt'), 0) as avg_price,
             -coalesce(sum(m.qty) filter (where m.t in ('sales_depletion', 'production_out', 'consumption')), 0) as used,
             -coalesce(sum(m.v) filter (where m.t in ('sales_depletion', 'production_out', 'consumption')), 0) as used_value,
             -coalesce(sum(m.qty) filter (where m.t = 'wastage'), 0) as wasted,
             -coalesce(sum(m.v) filter (where m.t = 'wastage'), 0) as wasted_value,
             -coalesce(sum(m.qty) filter (where m.t = 'transfer_out'), 0) as sent_out,
             coalesce(sum(m.qty) filter (where m.t = 'count_adjust'), 0) as counted,
             coalesce(sum(m.qty), 0) as net
        from rpt.periods(p_grain, p_from, p_to) p(p)
        left join moves m on m.p = p.p
       group by p.p
    )
    select per.p, round(per.came_in, 3), round(per.received_value, 2), round(per.avg_price, 2),
           round(per.used, 3), round(per.used_value, 2), round(per.wasted, 3),
           round(per.wasted_value, 2), round(per.sent_out, 3), round(per.counted, 3),
           round(v_open + sum(per.net) over (order by per.p), 3), i.name, i.base_uom
      from per cross join inv.item i where i.id = p_item order by per.p;
end $$;

-- ---------------------------------------------------------------------------
-- RLS registration (rule 1), audit (rule 5), grants
-- ---------------------------------------------------------------------------

insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('menu.pos_item', 'SALES', 'delivery', true),
  ('menu.pos_import', 'POS_IMPORT', 'delivery', true);
select core.apply_domain_rls('menu.pos_item');
select core.apply_domain_rls('menu.pos_import');
select audit.enable('menu.pos_item');
select audit.enable('menu.pos_import');

revoke execute on function menu.sales_apply(uuid, date, jsonb, text, text),
  menu.can_import(uuid), menu.require_import(uuid), menu.pos_result(menu.pos_import),
  menu.pos_post(uuid), menu.import_pos(uuid, date, jsonb, text), menu.repost_pos(uuid),
  menu.map_pos_item(uuid, text, uuid), menu.pos_dishes(uuid), menu.pos_import_of(uuid, date), menu.pos_places(),
  inv.expiring_soon(uuid, timestamptz), menu.dishes_using(uuid, uuid, date),
  menu.push_today(uuid), menu.my_push_today(), ops.expiry_alerts(timestamptz),
  rpt.periods(text, date, date),
  rpt.dish_trend(uuid, uuid, text, date, date), rpt.item_trend(uuid, uuid, text, date, date)
  from public, platform_loader;
grant execute on function menu.import_pos(uuid, date, jsonb, text), menu.repost_pos(uuid),
  menu.map_pos_item(uuid, text, uuid), menu.pos_dishes(uuid), menu.pos_import_of(uuid, date), menu.pos_places(),
  menu.push_today(uuid), menu.my_push_today(), rpt.dish_trend(uuid, uuid, text, date, date),
  rpt.item_trend(uuid, uuid, text, date, date) to app_rw;
grant execute on function ops.expiry_alerts(timestamptz) to wf_executor;

-- migrate:down

revoke execute on function ops.expiry_alerts(timestamptz) from wf_executor;
drop function rpt.item_trend(uuid, uuid, text, date, date);
drop function rpt.dish_trend(uuid, uuid, text, date, date);
drop function rpt.periods(text, date, date);
drop function ops.expiry_alerts(timestamptz);
drop function menu.my_push_today();
drop function menu.push_today(uuid);
drop function menu.dishes_using(uuid, uuid, date);
drop function inv.expiring_soon(uuid, timestamptz);
do $$
declare
  v_def text := pg_get_functiondef('core.screen_places(text)'::regprocedure);
begin
  v_def := replace(v_def, $a$'team_people', 'team_leave', 'pos_import') then$a$,
                   $a$'team_people', 'team_leave') then$a$);
  v_def := regexp_replace(v_def, $a$         when p_screen = 'pos_import' then.*?(         when p_screen in \('sales', 'menu'\) then)$a$, '\1', 's');
  execute v_def;
end $$;
drop function menu.pos_places();
drop function menu.pos_import_of(uuid, date);
drop function menu.pos_dishes(uuid);
drop function menu.map_pos_item(uuid, text, uuid);
drop function menu.repost_pos(uuid);
drop function menu.import_pos(uuid, date, jsonb, text);
drop function menu.pos_post(uuid);
drop function menu.pos_result(menu.pos_import);
drop function menu.require_import(uuid);
drop function menu.can_import(uuid);
delete from core.domain_table where table_name in ('menu.pos_item', 'menu.pos_import');
drop table menu.pos_import;
drop table menu.pos_item;

-- typed-in and POS sales through one function again (as 20261010100000_production_sales)
create or replace function menu.post_sales(p_outlet uuid, p_date date, p_lines jsonb,
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
drop function menu.sales_apply(uuid, date, jsonb, text, text);

do $$
declare
  v_fn text;
  v_def text;
begin
  foreach v_fn in array array['menu.cost_parts(uuid,uuid[],date,date)',
                              'rpt.calc_sales_day(uuid[],date,date)',
                              'rpt.menu_engineering(uuid,date,date)'] loop
    v_def := pg_get_functiondef(v_fn::regprocedure);
    execute replace(v_def, 'coalesce(sl.net, sl.qty * sl.price)', 'sl.qty * sl.price');
  end loop;
end $$;

alter table menu.sales_line drop column discount, drop column net;
