-- migrate:up
-- Flexible structure (ADR 009). Every level below the company is optional: regions,
-- areas, central kitchens, departments (org tree, under outlets and sites) and stores
-- (delivery tree, under supply points and hubs). Code never assumes a level exists;
-- responsibility is found by walking up the tree.
--
--   core.tenant          code, country, currency, default timezone (onboarding file 00)
--   hierarchy_node.code  readable, unique per tenant (TEST-HOTEL-1.0, ...-BAR-STORE)
--   outlet_format        org outlets only: full_hotel, small_hotel, standalone_bar
--   holds_stock          delivery nodes where stock is counted (a store, or a supply point
--                        with no stores); stock rows may only point at these
--   is_main_store        the outlet's Main Store (job-role scope main_store)

alter table core.tenant
  add column code text,
  add column country text,
  add column currency text not null default 'INR',
  add column default_timezone text not null default 'Asia/Kolkata';
create unique index tenant_code on core.tenant (code) where code is not null;

alter table core.hierarchy_node
  add column code text check (code ~ '^[A-Z0-9][A-Z0-9._-]*$'),
  add column outlet_format text check (outlet_format in ('full_hotel', 'small_hotel', 'standalone_bar')),
  add column holds_stock boolean,
  add column is_main_store boolean not null default false;
create unique index hierarchy_node_code on core.hierarchy_node (tenant_id, code) where code is not null;
create unique index hierarchy_node_one_main_store on core.hierarchy_node (parent_id) where is_main_store;

-- Existing delivery nodes that are not the network root hold stock (as before).
update core.hierarchy_node
   set holds_stock = (type = 'delivery' and kind <> 'network');
alter table core.hierarchy_node
  alter column holds_stock set not null,
  add constraint hierarchy_node_kind check (
    (type = 'org' and kind in ('company', 'region', 'area', 'outlet', 'site', 'department'))
    or (type = 'delivery' and kind in ('network', 'hub', 'outlet', 'store'))),
  add constraint hierarchy_node_format check (
    outlet_format is null or (type = 'org' and kind = 'outlet')),
  add constraint hierarchy_node_stock check (
    type = 'delivery' or (not holds_stock and not is_main_store)),
  add constraint hierarchy_node_main_store check (not is_main_store or kind = 'store');

-- Defaults and shape rules:
--   holds_stock, when not given: delivery hubs, supply points and stores hold stock
--   departments sit under an outlet or site; stores under a supply point or hub
create function core.hierarchy_node_shape() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
declare
  v_parent_kind text;
begin
  new.holds_stock := coalesce(new.holds_stock,
                              new.type = 'delivery' and new.kind in ('hub', 'outlet', 'store'));
  if new.kind in ('department', 'store') then
    select kind into v_parent_kind from core.hierarchy_node where id = new.parent_id;
    if (new.kind = 'department' and v_parent_kind is distinct from 'outlet' and v_parent_kind is distinct from 'site')
       or (new.kind = 'store' and v_parent_kind is distinct from 'outlet' and v_parent_kind is distinct from 'hub') then
      raise exception 'INVALID_PARENT'
        using detail = format('a %s cannot sit under a %s', new.kind, coalesce(v_parent_kind, 'root'));
    end if;
  end if;
  return new;
end $$;
revoke execute on function core.hierarchy_node_shape() from public;
-- 'a_same_tenant' (tenant check) runs first, then this, then 'path'
create trigger b_shape before insert or update on core.hierarchy_node
  for each row execute function core.hierarchy_node_shape();

-- ---------------------------------------------------------------------------
-- Stock only lives at holds_stock nodes
-- ---------------------------------------------------------------------------

create function inv.require_stock_location() returns trigger
language plpgsql
set search_path = pg_catalog, core, inv
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_col text;
begin
  foreach v_col in array tg_argv loop
    if v_row ->> v_col is not null
       and not coalesce((select holds_stock from core.hierarchy_node
                          where id = (v_row ->> v_col)::uuid and type = 'delivery'), false) then
      raise exception 'NOT_A_STOCK_LOCATION'
        using detail = format('%s.%s: stock is kept only where holds_stock is set', tg_table_name, v_col);
    end if;
  end loop;
  return new;
end $$;
revoke execute on function inv.require_stock_location() from public;

create trigger stock_location before insert or update of delivery_node_id on inv.item_node
  for each row execute function inv.require_stock_location('delivery_node_id');
create trigger stock_location before insert on inv.stock_ledger
  for each row execute function inv.require_stock_location('delivery_node_id');
create trigger stock_location before insert or update of delivery_node_id on inv.stock_count
  for each row execute function inv.require_stock_location('delivery_node_id');
create trigger stock_location before insert or update of delivery_node_id on inv.stock_adjustment
  for each row execute function inv.require_stock_location('delivery_node_id');
create trigger stock_location before insert or update of delivery_node_id on inv.wastage
  for each row execute function inv.require_stock_location('delivery_node_id');
create trigger stock_location before insert or update of delivery_node_id on inv.purchase_order
  for each row execute function inv.require_stock_location('delivery_node_id');
create trigger stock_location before insert or update of delivery_node_id on inv.goods_receipt
  for each row execute function inv.require_stock_location('delivery_node_id');
create trigger stock_location before insert or update of from_node_id, to_node_id on inv.transfer
  for each row execute function inv.require_stock_location('from_node_id', 'to_node_id');

-- migrate:down
drop trigger stock_location on inv.transfer;
drop trigger stock_location on inv.goods_receipt;
drop trigger stock_location on inv.purchase_order;
drop trigger stock_location on inv.wastage;
drop trigger stock_location on inv.stock_adjustment;
drop trigger stock_location on inv.stock_count;
drop trigger stock_location on inv.stock_ledger;
drop trigger stock_location on inv.item_node;
drop function inv.require_stock_location();
drop trigger b_shape on core.hierarchy_node;
drop function core.hierarchy_node_shape();
alter table core.hierarchy_node
  drop constraint hierarchy_node_kind,
  drop constraint hierarchy_node_format,
  drop constraint hierarchy_node_stock,
  drop constraint hierarchy_node_main_store,
  drop column code, drop column outlet_format, drop column holds_stock, drop column is_main_store;
alter table core.tenant
  drop column code, drop column country, drop column currency, drop column default_timezone;
