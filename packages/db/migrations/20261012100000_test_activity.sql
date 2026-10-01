-- migrate:up
-- Test-only activity (Prompt 10b, ADR 017): the onboarding loader records the test
-- customers' batches of the past week through the real production code, at the time each
-- batch was made.
--
--   * inv.record_production_at: the body of inv.record_production with the batch time as a
--     parameter (batch number, made_at, expiry, ledger times and the recipe in force that
--     day). Not for the app: only its owner and platform_loader run it.
--   * inv.record_production: unchanged for the app; it records at now().
--   * inv.record_test_production: the loader's entry point. It refuses any customer that
--     isn't a test customer (TEST_CUSTOMER_ONLY) and a time in the future, then checks who
--     may produce where like every recording does.

create function inv.record_production_at(p_store uuid, p_prep uuid, p_qty_made numeric,
                                         p_actual jsonb, p_idempotency_key text,
                                         p_at timestamptz)
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
  if v_tenant is null or not inv.can_produce_at(p_store) then
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
  v_recipe := inv.recipe_on(p_prep, null, (p_at at time zone coalesce(
             (select timezone from core.hierarchy_node where id = p_store), 'UTC'))::date);
  if v_recipe.id is null then
    raise exception 'NOT_FOUND' using detail = 'no recipe in force';
  end if;
  v_scale := p_qty_made / v_recipe.batch_yield;
  v_tz := coalesce((select timezone from core.hierarchy_node where id = p_store), 'UTC');
  v_batch := to_char(p_at at time zone v_tz, 'YYYYMMDD') || '-' ||
             (select count(*) + 1 from inv.production
               where delivery_node_id = p_store
                 and (made_at at time zone v_tz)::date = (p_at at time zone v_tz)::date);

  insert into inv.production (tenant_id, delivery_node_id, prep_item_id, recipe_id, qty_made,
                              batch_no, made_at, expires_at, idempotency_key)
  values (v_tenant, p_store, p_prep, v_recipe.id, p_qty_made, v_batch, p_at,
          p_at + make_interval(hours => v_prep.shelf_life_hours), p_idempotency_key)
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
                                    ref_type, ref_id, occurred_at)
      values (v_tenant, v_line.ingredient_item_id, p_store, 'production_out', -v_qty,
              'production', v_id, p_at)
      returning unit_cost into v_cost;
    end if;
    insert into inv.production_line (tenant_id, production_id, delivery_node_id,
                                     ingredient_item_id, planned_qty, actual_qty, unit_cost)
    values (v_tenant, v_id, p_store, v_line.ingredient_item_id,
            v_line.qty / (1 - v_line.trim_loss_pct / 100) * v_scale / v_line.factor, v_qty, v_cost);
    v_total := v_total + v_qty * v_cost;
  end loop;

  insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                unit_cost, ref_type, ref_id, batch_no, expires_at, occurred_at)
  select v_tenant, p_prep, p_store, 'production_in', p_qty_made, v_total / p_qty_made,
         'production', v_id, v_batch, p.expires_at, p_at
    from inv.production p where p.id = v_id;
  update inv.production set unit_cost = round(v_total / p_qty_made, 4) where id = v_id;
  return v_id;
end $$;
revoke execute on function inv.record_production_at(uuid, uuid, numeric, jsonb, text, timestamptz)
  from public;
grant execute on function inv.record_production_at(uuid, uuid, numeric, jsonb, text, timestamptz)
  to platform_loader;

create or replace function inv.record_production(p_store uuid, p_prep uuid, p_qty_made numeric,
                                                 p_actual jsonb default null,
                                                 p_idempotency_key text default null)
returns uuid
language sql security definer
set search_path = pg_catalog, core, inv
as $$
  select inv.record_production_at(p_store, p_prep, p_qty_made, p_actual, p_idempotency_key,
                                  now());
$$;

create function inv.record_test_production(p_store uuid, p_prep uuid, p_qty_made numeric,
                                           p_made_at timestamptz,
                                           p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not coalesce((select t.is_test from core.tenant t where t.id = core.my_tenant()), false) then
    raise exception 'TEST_CUSTOMER_ONLY'
      using detail = 'batches at a past time are recorded for test customers only';
  end if;
  if p_made_at is null or p_made_at > now() then
    raise exception 'INVALID_DATE' using detail = 'a batch is made now or earlier';
  end if;
  return inv.record_production_at(p_store, p_prep, p_qty_made, null, p_idempotency_key,
                                  p_made_at);
end $$;
revoke execute on function inv.record_test_production(uuid, uuid, numeric, timestamptz, text)
  from public;
grant execute on function inv.record_test_production(uuid, uuid, numeric, timestamptz, text)
  to platform_loader;

-- migrate:down
-- Dev tooling only (forward-only in production, ADR 001).
drop function inv.record_test_production(uuid, uuid, numeric, timestamptz, text);
create or replace function inv.record_production(p_store uuid, p_prep uuid, p_qty_made numeric, p_actual jsonb DEFAULT NULL::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv'
AS $$
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
  if v_tenant is null or not inv.can_produce_at(p_store) then
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
drop function inv.record_production_at(uuid, uuid, numeric, jsonb, text, timestamptz);
