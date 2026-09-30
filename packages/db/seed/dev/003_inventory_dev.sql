-- DEV SEED ONLY: inventory catalogue, suppliers, par levels and opening stock for the
-- demo tenant. Production items, suppliers and par levels come from the pilot onboarding
-- script (ADR 004, ADR 006). Idempotent: fixed ids, upserts, and opening stock only for
-- item/node pairs that have no ledger rows yet.

-- Suppliers
insert into inv.supplier (id, tenant_id, name, lead_time_days, contact) values
  ('01920000-0000-7000-8000-000000000501', '01920000-0000-7000-8000-000000000001',
   'FreshFarm Produce', 1, 'orders@freshfarm.example'),
  ('01920000-0000-7000-8000-000000000502', '01920000-0000-7000-8000-000000000001',
   'Metro Wholesale Foods', 2, 'sales@metrowholesale.example')
on conflict (id) do update
   set name = excluded.name, lead_time_days = excluded.lead_time_days, contact = excluded.contact;

-- Items: sku, name, category, base UOM, perishable, outlet par, unit cost (INR per base
-- UOM), count tolerance, supplier (1 = FreshFarm, 2 = Metro)
drop table if exists pg_temp.seed_items;
create temp table seed_items (
  n int, sku text, name text, category text, uom text, perishable boolean,
  par numeric, cost numeric, tolerance numeric, supplier int);
insert into seed_items values
  ( 1, 'DRY-RICE-BAS', 'Basmati rice', 'Dry goods', 'kg', false, 50, 95, 1, 2),
  ( 2, 'DRY-ATTA', 'Whole wheat flour (atta)', 'Dry goods', 'kg', false, 40, 42, 1, 2),
  ( 3, 'DRY-MAIDA', 'Refined flour (maida)', 'Dry goods', 'kg', false, 20, 38, 1, 2),
  ( 4, 'DRY-TOOR', 'Toor dal', 'Dry goods', 'kg', false, 20, 150, 0.5, 2),
  ( 5, 'DRY-CHANA', 'Chana dal', 'Dry goods', 'kg', false, 15, 90, 0.5, 2),
  ( 6, 'DRY-SUGAR', 'Sugar', 'Dry goods', 'kg', false, 20, 45, 1, 2),
  ( 7, 'DRY-SALT', 'Iodised salt', 'Dry goods', 'kg', false, 10, 22, 1, 2),
  ( 8, 'OIL-SUN', 'Sunflower oil', 'Oils', 'l', false, 30, 145, 1, 2),
  ( 9, 'OIL-MUSTARD', 'Mustard oil', 'Oils', 'l', false, 10, 175, 0.5, 2),
  (10, 'DAI-GHEE', 'Ghee', 'Dairy', 'kg', false, 8, 620, 0.25, 1),
  (11, 'DAI-BUTTER', 'Butter', 'Dairy', 'kg', true, 6, 520, 0.25, 1),
  (12, 'DAI-PANEER', 'Paneer', 'Dairy', 'kg', true, 10, 380, 0.25, 1),
  (13, 'DAI-MILK', 'Full cream milk', 'Dairy', 'l', true, 30, 66, 1, 1),
  (14, 'DAI-CURD', 'Curd', 'Dairy', 'kg', true, 12, 80, 0.5, 1),
  (15, 'DAI-CREAM', 'Fresh cream', 'Dairy', 'l', true, 5, 240, 0.25, 1),
  (16, 'DAI-CHEESE', 'Processed cheese', 'Dairy', 'kg', true, 4, 480, 0.25, 1),
  (17, 'MEA-CHK-BL', 'Chicken boneless', 'Meat & seafood', 'kg', true, 15, 320, 0.25, 1),
  (18, 'MEA-CHK-CC', 'Chicken curry cut', 'Meat & seafood', 'kg', true, 20, 240, 0.25, 1),
  (19, 'MEA-MUTTON', 'Mutton curry cut', 'Meat & seafood', 'kg', true, 8, 780, 0.25, 1),
  (20, 'SEA-BASA', 'Basa fillet', 'Meat & seafood', 'kg', true, 6, 360, 0.25, 1),
  (21, 'SEA-PRAWN', 'Prawns (medium)', 'Meat & seafood', 'kg', true, 5, 850, 0.25, 1),
  (22, 'EGG-TRAY', 'Eggs', 'Meat & seafood', 'pcs', true, 180, 7, 6, 1),
  (23, 'VEG-ONION', 'Onions', 'Produce', 'kg', true, 40, 35, 1, 1),
  (24, 'VEG-TOMATO', 'Tomatoes', 'Produce', 'kg', true, 30, 40, 1, 1),
  (25, 'VEG-POTATO', 'Potatoes', 'Produce', 'kg', true, 30, 30, 1, 1),
  (26, 'VEG-GARLIC', 'Garlic', 'Produce', 'kg', true, 5, 180, 0.25, 1),
  (27, 'VEG-GINGER', 'Ginger', 'Produce', 'kg', true, 5, 140, 0.25, 1),
  (28, 'VEG-CHILLI', 'Green chillies', 'Produce', 'kg', true, 3, 90, 0.25, 1),
  (29, 'VEG-CORIANDER', 'Coriander leaves', 'Produce', 'kg', true, 2, 120, 0.25, 1),
  (30, 'VEG-LEMON', 'Lemons', 'Produce', 'pcs', true, 60, 4, 5, 1),
  (31, 'VEG-CAPSICUM', 'Green capsicum', 'Produce', 'kg', true, 6, 70, 0.5, 1),
  (32, 'VEG-SPINACH', 'Spinach', 'Produce', 'kg', true, 5, 50, 0.5, 1),
  (33, 'SPI-GARAM', 'Garam masala', 'Spices', 'kg', false, 2, 900, 0.1, 2),
  (34, 'SPI-TURMERIC', 'Turmeric powder', 'Spices', 'kg', false, 2, 320, 0.1, 2),
  (35, 'SPI-CHILLI', 'Kashmiri chilli powder', 'Spices', 'kg', false, 2, 560, 0.1, 2),
  (36, 'SPI-JEERA', 'Cumin seeds', 'Spices', 'kg', false, 2, 480, 0.1, 2),
  (37, 'BEV-WATER', 'Bottled water 1 l', 'Beverages', 'pcs', false, 120, 14, 4, 2),
  (38, 'BEV-COLA', 'Cola can 300 ml', 'Beverages', 'pcs', false, 96, 28, 4, 2),
  (39, 'BEV-TEA', 'Tea leaves', 'Beverages', 'kg', false, 3, 450, 0.1, 2),
  (40, 'BEV-COFFEE', 'Filter coffee powder', 'Beverages', 'kg', false, 3, 700, 0.1, 2),
  (41, 'PKG-BOX-500', 'Takeaway container 500 ml', 'Packaging', 'pcs', false, 300, 6, 10, 2),
  (42, 'PKG-NAPKIN', 'Paper napkins (pack of 100)', 'Packaging', 'pack', false, 20, 55, 1, 2);

insert into inv.item (id, tenant_id, sku, name, category, base_uom, is_perishable)
select ('01920000-0000-7000-8000-' || lpad((400 + n)::text, 12, '0'))::uuid,
       '01920000-0000-7000-8000-000000000001', sku, name, category, uom, perishable
  from seed_items
on conflict (id) do update
   set sku = excluded.sku, name = excluded.name, category = excluded.category,
       base_uom = excluded.base_uom, is_perishable = excluded.is_perishable;

-- Par levels: outlets as listed, the hub holds three times an outlet's par.
insert into inv.item_node (tenant_id, item_id, delivery_node_id, par_level, reorder_qty,
                           preferred_supplier_id, count_tolerance_qty)
select '01920000-0000-7000-8000-000000000001',
       ('01920000-0000-7000-8000-' || lpad((400 + i.n)::text, 12, '0'))::uuid,
       nd.id,
       i.par * nd.factor, round(i.par * nd.factor / 2, 3),
       ('01920000-0000-7000-8000-' || lpad((500 + i.supplier)::text, 12, '0'))::uuid,
       i.tolerance
  from seed_items i
 cross join (values
   ('01920000-0000-7000-8000-000000000202'::uuid, 3),   -- Hub
   ('01920000-0000-7000-8000-000000000203'::uuid, 1),   -- Outlet A
   ('01920000-0000-7000-8000-000000000204'::uuid, 1)    -- Outlet B
 ) as nd(id, factor)
on conflict (tenant_id, item_id, delivery_node_id) do update
   set par_level = excluded.par_level, reorder_qty = excluded.reorder_qty,
       preferred_supplier_id = excluded.preferred_supplier_id,
       count_tolerance_qty = excluded.count_tolerance_qty;

-- Opening stock (receipt rows, ref_type 'opening') where a pair has no movements yet.
-- Deterministic mix: most items between 80% and 120% of par, every 7th item at 35%,
-- so the below-par filter and the suggested order have something to show.
insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                              unit_cost, ref_type, reason)
select '01920000-0000-7000-8000-000000000001', n.item_id, n.delivery_node_id, 'receipt',
       round(n.par_level * case when i.n % 7 = 0 then 0.35
                                else 0.8 + ((i.n * 13) % 5) * 0.1 end,
             case when i.uom in ('pcs', 'pack') then 0 else 3 end),
       i.cost, 'opening', 'opening balance'
  from inv.item_node n
  join seed_items i
    on n.item_id = ('01920000-0000-7000-8000-' || lpad((400 + i.n)::text, 12, '0'))::uuid
 where not exists (select 1 from inv.stock_ledger l
                    where l.item_id = n.item_id and l.delivery_node_id = n.delivery_node_id);

drop table pg_temp.seed_items;
