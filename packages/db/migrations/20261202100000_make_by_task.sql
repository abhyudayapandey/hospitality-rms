-- migrate:up
-- Make by task, FSSAI batch labels and the GM's first round of fixes (ADR 076).
--
--   * Making is given, not chosen: the lead of the team that makes things at a store (task
--     access over it) gives a prep task to someone; that person sees it in Tasks with its
--     ingredients and method and records the batch there. Only the lead records a batch
--     straight from Make; everyone else sees on Make only what they were given.
--   * A batch carries what FSSAI asks of its label: batch number, made and use-by, veg or
--     non-veg, allergens and who made it; a prep item may say how many portions a batch
--     makes. Whoever records batches at a store sees the store's batches (a commis saw none).
--   * Durable things (linen, uniforms, equipment) are not stock that moves: they stay out of
--     "not moved in 30 days" and days on hand.
--   * A request for something that is "not on the menu" needs approval only at a store of a
--     kitchen or service department: housekeeping's water and soap are never on a menu
--     (they waited for the GM's approval, and the bar never saw them).
--   * A count far above what a store ever holds is refused (10,000 for an item kept to 200).
--   * Briefings have breakfast and late night as well as lunch and dinner.

alter table inv.item
  add column durable boolean not null default false,
  add column food_type text check (food_type in ('veg', 'non_veg', 'egg')),
  add column allergens text[] not null default '{}',
  add column batch_portions numeric(10,1) check (batch_portions > 0);

-- ---------------------------------------------------------------------------
-- Make by task
-- ---------------------------------------------------------------------------

-- Whether the caller leads the making at a store: task access over the team that makes
-- things there, or, at a store no team makes things for, recording production there.
create function inv.leads_making(p_store uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
  select case when ops.team_of_store(p_store) is null then inv.can_produce_at(p_store)
              else coalesce(core.can('TASKS', 'modify', ops.team_of_store(p_store), null), false)
                   and inv.can_produce_at(p_store) end;
$$;

-- The prep items the caller may make at a store (whoever records production there, as
-- inv.record_production_at decides): all of them for its lead; for anyone else only those
-- they have an open prep task for there.
create or replace function inv.made_here(p_store uuid)
returns table (item_id uuid, sku text, name text, unit text, batch_yield numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_lead boolean := inv.leads_making(p_store);
begin
  if not inv.can_produce_at(p_store) then
    raise exception 'NOT_AUTHORISED' using detail = format('modify PRODUCTION at %s', p_store);
  end if;
  return query
    select i.id, i.sku, i.name, i.base_uom, (inv.recipe_on(i.id, null, current_date)).batch_yield
      from inv.item_node x join inv.item i on i.id = x.item_id and i.kind = 'prep'
     where x.delivery_node_id = p_store and x.made_here and x.archived_at is null
       and (v_lead or exists (select 1 from ops.task t
                               where t.kind = 'prep' and t.delivery_node_id = p_store
                                 and t.item_id = i.id
                                 and ops.can_work(t, core.current_user_id())))
     order by i.name;
end $$;

-- What the caller was given to make at a store: open prep tasks there they may work on
-- (their own, their job role's, their shift's), soonest due first. Make lists them for
-- everyone; each opens its task, where the batch is recorded.
create function inv.my_make_tasks(p_store uuid)
returns table (task_id uuid, item_id uuid, name text, unit text, target_qty numeric,
               due_at timestamptz, overdue boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
begin
  if not inv.can_produce_at(p_store) then
    raise exception 'NOT_AUTHORISED' using detail = format('modify PRODUCTION at %s', p_store);
  end if;
  return query
    select t.id, i.id, i.name, i.base_uom, t.target_qty, t.due_at, t.due_at < now()
      from ops.task t join inv.item i on i.id = t.item_id
     where t.tenant_id = core.my_tenant() and t.kind = 'prep' and t.delivery_node_id = p_store
       and t.status = 'open' and ops.can_work(t, core.current_user_id())
     order by t.due_at, i.name;
end $$;

-- What a prep task asks for, for whoever sees the task (ADR 074): its ingredients scaled from
-- the recipe's batch to the task's quantity (trim loss included, as Make takes them) and the
-- method, and the batches made for it so far (each with its label). The person given it
-- makes it from this, then records the batch on the task.
create function ops.prep_task_recipe(p_task uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_t ops.task;
  v_recipe inv.recipe;
  v_scale numeric;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant();
  if v_t.id is null or not ops.sees_task(v_t) then
    raise exception 'NOT_AUTHORISED' using detail = 'that task';
  end if;
  if v_t.kind <> 'prep' or v_t.item_id is null then
    return null;
  end if;
  v_recipe := inv.recipe_on(v_t.item_id, null, current_date);
  v_scale := case when v_recipe.batch_yield > 0 and v_t.target_qty is not null
                  then v_t.target_qty / v_recipe.batch_yield else 1 end;
  return jsonb_build_object(
    'batch_yield', v_recipe.batch_yield,
    'ingredients', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', i.name,
               'qty', round(l.qty / (1 - l.trim_loss_pct / 100) * v_scale, 3),
               'unit', l.unit) order by l.line_no)
        from inv.recipe_line l join inv.item i on i.id = l.ingredient_item_id
       where l.recipe_id = v_recipe.id), '[]'),
    'method', coalesce((
      select jsonb_agg(jsonb_build_object('step', s.step, 'instruction', s.instruction,
                                          'minutes', s.minutes) order by s.step)
        from inv.prep_procedure s where s.prep_item_id = v_t.item_id), '[]'),
    -- what was made for it so far, each with its label
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object('production_id', p.id, 'batch_no', p.batch_no,
                                          'qty', p.qty_made) order by p.made_at)
        from inv.production p where p.task_id = v_t.id), '[]'));
end $$;

-- A batch straight from Make: the lead only. Everyone else records it from the task.
create or replace function inv.record_production(p_store uuid, p_prep uuid, p_qty_made numeric,
                                                 p_actual jsonb default null,
                                                 p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if core.my_tenant() is not null and inv.can_produce_at(p_store)
     and not inv.leads_making(p_store) then
    raise exception 'MAKE_BY_TASK' using detail = 'record the batch from the task you were given';
  end if;
  return inv.record_production_at(p_store, p_prep, p_qty_made, p_actual, p_idempotency_key, now());
end $$;

-- As before (ADR 020), recording through the task itself, which is how someone who was
-- given it makes it.
create or replace function ops.record_task_batch(p_task uuid, p_qty numeric,
                                                 p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, inv
as $$
declare
  v_t ops.task := ops.task_to_work(p_task);
  v_step ops.task_step;
  v_id uuid;
  v_made numeric;
begin
  select * into v_step from ops.task_step where task_id = v_t.id and kind = 'batch' for update;
  if v_step.id is null then
    perform ops.fail('INVALID_STEP', 'this task has no batch to make');
  end if;
  v_id := inv.record_production_at(v_t.delivery_node_id, v_t.item_id, p_qty, null,
                                   p_idempotency_key, now());
  update inv.production set task_id = v_t.id where id = v_id and task_id is null;
  v_made := (select coalesce(sum(qty_made), 0) from inv.production where task_id = v_t.id);
  if v_t.kind = 'expiry' or v_made >= v_t.target_qty then
    update ops.task_step
       set ref_id = v_id, value_num = v_made, done_by = core.current_user_id(), done_at = now()
     where id = v_step.id;
  else
    update ops.task_step set ref_id = v_id, value_num = v_made where id = v_step.id;
  end if;
  perform ops.settle(v_t.id);
  return v_id;
end $$;

-- The batches held at a store, newest first, with their FSSAI label: for stock viewers and
-- for whoever records production there.
drop function inv.batches(uuid);
create function inv.batches(p_store uuid)
returns table (item_id uuid, sku text, name text, unit text, batch_no text,
               made_at timestamptz, expires_at timestamptz, qty numeric, remaining numeric,
               expired boolean, production_id uuid, made_by text, food_type text,
               allergens text[], batch_portions numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not (core.can('STOCK_LEVELS', 'view', null, p_store) or inv.can_produce_at(p_store)) then
    raise exception 'NOT_AUTHORISED' using detail = format('view STOCK_LEVELS at %s', p_store);
  end if;
  return query
    select i.id, i.sku, i.name, i.base_uom, b.batch_no, b.made_at, b.expires_at, b.qty,
           b.remaining, b.expires_at <= now(), p.id,
           (select u.display_name from core.app_user u where u.id = p.created_by),
           i.food_type, i.allergens, i.batch_portions
      from inv.item_node x
      join inv.item i on i.id = x.item_id and i.kind = 'prep'
      cross join lateral inv.batch_rows(x.item_id, p_store) b
      left join inv.production p on p.delivery_node_id = p_store and p.prep_item_id = i.id
                                and p.batch_no = b.batch_no
     where x.delivery_node_id = p_store and b.remaining > 0
     order by b.made_at desc nulls last, i.name;
end $$;

-- One batch's label (FSSAI): what it is, its batch number, made and use-by, veg or non-veg,
-- allergens, who made it and how much. For whoever sees the store's batches, and whoever
-- worked on the task it was made for.
create function inv.batch_label(p_production uuid)
returns table (production_id uuid, name text, batch_no text, made_at timestamptz,
               expires_at timestamptz, qty numeric, unit text, food_type text,
               allergens text[], batch_portions numeric, made_by text, store text, tz text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_p inv.production;
begin
  select * into v_p from inv.production where id = p_production and tenant_id = core.my_tenant();
  if v_p.id is null
     or not (core.can('STOCK_LEVELS', 'view', null, v_p.delivery_node_id)
             or inv.can_produce_at(v_p.delivery_node_id)
             or v_p.created_by = core.current_user_id()) then
    raise exception 'NOT_AUTHORISED' using detail = 'that batch';
  end if;
  return query
    select v_p.id, i.name, v_p.batch_no, v_p.made_at, v_p.expires_at, v_p.qty_made, i.base_uom,
           i.food_type, i.allergens,
           case when i.batch_portions is not null and r.batch_yield > 0
                then round(i.batch_portions * v_p.qty_made / r.batch_yield, 1) end,
           (select u.display_name from core.app_user u where u.id = v_p.created_by),
           (select s.name from core.hierarchy_node s where s.id = v_p.delivery_node_id),
           ops.tz_of(v_p.delivery_node_id)
      from inv.item i
      left join inv.recipe r on r.id = v_p.recipe_id
     where i.id = v_p.prep_item_id;
end $$;

-- ---------------------------------------------------------------------------
-- Requests for material: "not on the menu" only at a store that serves a menu
-- ---------------------------------------------------------------------------

do $$
declare
  v_src text := pg_get_functiondef('inv.unusual_calc(uuid, jsonb)'::regprocedure);
  v_old text := 'where not exists (select 1 from menu where menu.item_id = l.item_id)
        or (u.weekly';
  -- a store serves a menu when the department that uses it is a kitchen or a service one
  -- (or no department is set for it)
  v_new text := 'where (coalesce((select d.department_type in (''kitchen'', ''service'')
                                    from core.hierarchy_node d
                                   where d.id = ops.team_of_store(p_node)
                                     and d.department_type is not null), true)
            and not exists (select 1 from menu where menu.item_id = l.item_id))
        or (u.weekly';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'inv.unusual_calc changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- ---------------------------------------------------------------------------
-- Durable things stay out of what moves
-- ---------------------------------------------------------------------------

do $$
declare
  v_src text := pg_get_functiondef('rpt.store_items(uuid)'::regprocedure);
  v_days text := 'case when v_basis >= 7 and u.qty > 0
                then round';
  v_dead text := 'coalesce(s.on_hand, 0) > 0 and (m.at is null or m.at < now() - interval ''30 days''),';
begin
  if position(v_days in v_src) = 0 or position(v_dead in v_src) = 0 then
    raise exception 'rpt.store_items changed; update this migration';
  end if;
  v_src := replace(v_src, v_days, 'case when v_basis >= 7 and u.qty > 0 and not i.durable
                then round');
  v_src := replace(v_src, v_dead, 'not i.durable and ' || v_dead);
  execute v_src;
end $$;

-- ---------------------------------------------------------------------------
-- Counts far above what a store holds are refused
-- ---------------------------------------------------------------------------

-- What a store usually holds of an item at most: its par, what it should have now, and the
-- largest delivery or transfer into it in the last 90 days. Null with none of these.
create function inv.count_usual(p_item uuid, p_store uuid, p_expected numeric) returns numeric
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select nullif(greatest(
           coalesce((select x.par_level from inv.item_node x
                      where x.item_id = p_item and x.delivery_node_id = p_store), 0),
           coalesce(p_expected, 0),
           coalesce((select max(l.qty) from inv.stock_ledger l
                      where l.item_id = p_item and l.delivery_node_id = p_store
                        and l.movement_type in ('receipt', 'transfer_in', 'production_in')
                        and l.occurred_at >= now() - interval '90 days'), 0)), 0);
$$;

-- A count over five times that is refused: a slip of the finger, not stock.
create function inv.count_limit(p_item uuid, p_store uuid, p_expected numeric) returns numeric
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select ceil(5 * inv.count_usual(p_item, p_store, p_expected));
$$;

do $$
declare
  v_src text := pg_get_functiondef(
    'inv.record_check_line(uuid, uuid, numeric, text, text, timestamptz, text, numeric, integer)'::regprocedure);
  v_old text := '  if v_qty is not null and v_qty < 0 then
    perform inv.fail(''INVALID_QUANTITY'', ''counted quantity must be zero or more'');
  end if;';
  v_new text := v_old || '
  if v_qty is not null
     and v_qty > inv.count_limit(p_item, v_check.delivery_node_id, v_line.expected_qty) then
    perform inv.fail(''COUNT_TOO_HIGH'', format(''usually up to %s'',
      trim_scale(round(inv.count_usual(p_item, v_check.delivery_node_id, v_line.expected_qty), 2))));
  end if;';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'inv.record_check_line changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

-- The count sheet, with each line's limit (the count stays blind: five times the most the
-- store usually holds says nothing of what is there).
drop function inv.stock_check_sheet(uuid);
create function inv.stock_check_sheet(p_check uuid)
returns table (item_id uuid, sku text, name text, unit text, category text, shelf text,
               area text, counted_qty numeric, full_units numeric, tenths smallint,
               pack_unit text, pack_size numeric, counted_at timestamptz, photo_key text,
               count_limit numeric)
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
           u.recipe_unit, u.recipe_units_per_stock_unit, l.counted_at, l.photo_key,
           inv.count_limit(l.item_id, l.delivery_node_id, l.expected_qty)
      from inv.stock_check_line l
      join inv.item i on i.id = l.item_id
      left join inv.item_node n on n.item_id = l.item_id and n.delivery_node_id = l.delivery_node_id
      left join inv.item_unit u on u.item_id = l.item_id
     where l.check_id = p_check
     order by n.shelf_order nulls last, n.shelf nulls last, i.category, i.name;
end $$;

-- ---------------------------------------------------------------------------
-- Briefings: breakfast and late night too
-- ---------------------------------------------------------------------------

alter table ops.briefing drop constraint briefing_part_check;
alter table ops.briefing add constraint briefing_part_check
  check (part in ('day', 'breakfast', 'lunch', 'dinner', 'late_night'));

-- The part of the business day it is now: breakfast from the 04:00 cut until 11:00, lunch
-- until 16:00, dinner until 23:00, then late night until the next cut.
create or replace function ops.briefing_part_now(p_outlet uuid, p_at timestamptz default now())
returns text
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select case when t >= time '04:00' and t < time '11:00' then 'breakfast'
              when t >= time '11:00' and t < time '16:00' then 'lunch'
              when t >= time '16:00' and t < time '23:00' then 'dinner'
              else 'late_night' end
    from (select (p_at at time zone ops.tz_of(p_outlet))::time as t) x;
$$;

do $$
declare
  f text;
  v_src text;
begin
  foreach f in array array['ops.save_briefing(uuid, text, text, uuid[], text)',
                           'ops.briefing_at(uuid)'] loop
    v_src := pg_get_functiondef(f::regprocedure);
    if position('(''day'', ''lunch'', ''dinner'')' in v_src) = 0
       and position('array[''day'', ''lunch'', ''dinner'']' in v_src) = 0 then
      raise exception '% changed; update this migration', f;
    end if;
    v_src := replace(v_src, '(''day'', ''lunch'', ''dinner'')',
                     '(''day'', ''breakfast'', ''lunch'', ''dinner'', ''late_night'')');
    v_src := replace(v_src, 'array[''day'', ''lunch'', ''dinner'']',
                     'array[''day'', ''breakfast'', ''lunch'', ''dinner'', ''late_night'']');
    execute v_src;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- A department in two places: its store duties reach every store it is linked to
-- ---------------------------------------------------------------------------

-- A department may use more than one store (a hotel's bar runs the rooftop bar and the lobby
-- Mini Bar). "Their department's store" was one of them, picked at random; now a
-- department_store grant is given at each store linked to the department, in code order.
-- With one store linked, nothing changes.
do $$
declare
  v_src text := pg_get_functiondef('core.derive_job_role_access_at(uuid, text, uuid)'::regprocedure);
  v_old text := '      when g.scope = ''department_store'' then
        select nl.delivery_node_id into v_node
          from core.node_link nl
          join core.hierarchy_node o on o.id = nl.org_node_id and o.kind = ''department''
          join core.hierarchy_node d on d.id = nl.delivery_node_id and d.kind = ''store''
         where nl.org_node_id = p_home limit 1;
        if v_node is null then';
  v_new text := '      when g.scope = ''department_store'' then
        for v_node in
          select nl.delivery_node_id
            from core.node_link nl
            join core.hierarchy_node o on o.id = nl.org_node_id and o.kind = ''department''
            join core.hierarchy_node d on d.id = nl.delivery_node_id and d.kind = ''store''
           where nl.org_node_id = p_home
           order by d.code
        loop
          access_group := g.access_group;
          node_id := v_node;
          include_descendants := g.include_descendants;
          source := v_source;
          error := null;
          return next;
        end loop;
        if found then
          continue;
        end if;
        v_node := null;
        if v_node is null then';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'core.derive_job_role_access_at changed; update this migration';
  end if;
  execute replace(v_src, v_old, v_new);
end $$;

revoke execute on function inv.leads_making(uuid), inv.my_make_tasks(uuid),
  ops.prep_task_recipe(uuid), inv.count_usual(uuid, uuid, numeric),
  inv.count_limit(uuid, uuid, numeric), inv.batches(uuid), inv.batch_label(uuid),
  inv.stock_check_sheet(uuid) from public;
grant execute on function inv.leads_making(uuid), inv.my_make_tasks(uuid),
  ops.prep_task_recipe(uuid), inv.batches(uuid), inv.batch_label(uuid),
  inv.stock_check_sheet(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
do $$
declare
  v_src text := pg_get_functiondef('core.derive_job_role_access_at(uuid, text, uuid)'::regprocedure);
begin
  execute regexp_replace(v_src,
    '        for v_node in\n.*?\n        v_node := null;\n',
    '        select nl.delivery_node_id into v_node
          from core.node_link nl
          join core.hierarchy_node o on o.id = nl.org_node_id and o.kind = ''department''
          join core.hierarchy_node d on d.id = nl.delivery_node_id and d.kind = ''store''
         where nl.org_node_id = p_home limit 1;
');
end $$;
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
create or replace function inv.made_here(p_store uuid)
returns table (item_id uuid, sku text, name text, unit text, batch_yield numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
begin
  if not core.can('PRODUCTION', 'modify', null, p_store) then
    raise exception 'NOT_AUTHORISED' using detail = format('modify PRODUCTION at %s', p_store);
  end if;
  return query
    select i.id, i.sku, i.name, i.base_uom, (inv.recipe_on(i.id, null, current_date)).batch_yield
      from inv.item_node x join inv.item i on i.id = x.item_id and i.kind = 'prep'
     where x.delivery_node_id = p_store and x.made_here and x.archived_at is null
     order by i.name;
end $$;
create or replace function ops.record_task_batch(p_task uuid, p_qty numeric, p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, inv
as $$
declare
  v_t ops.task := ops.task_to_work(p_task);
  v_step ops.task_step;
  v_id uuid;
  v_made numeric;
begin
  select * into v_step from ops.task_step where task_id = v_t.id and kind = 'batch' for update;
  if v_step.id is null then
    perform ops.fail('INVALID_STEP', 'this task has no batch to make');
  end if;
  v_id := inv.record_production(v_t.delivery_node_id, v_t.item_id, p_qty, null, p_idempotency_key);
  update inv.production set task_id = v_t.id where id = v_id and task_id is null;
  v_made := (select coalesce(sum(qty_made), 0) from inv.production where task_id = v_t.id);
  if v_t.kind = 'expiry' or v_made >= v_t.target_qty then
    update ops.task_step
       set ref_id = v_id, value_num = v_made, done_by = core.current_user_id(), done_at = now()
     where id = v_step.id;
  else
    update ops.task_step set ref_id = v_id, value_num = v_made where id = v_step.id;
  end if;
  perform ops.settle(v_t.id);
  return v_id;
end $$;
drop function inv.batch_label(uuid);
drop function inv.my_make_tasks(uuid);
drop function ops.prep_task_recipe(uuid);
drop function inv.batches(uuid);
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
do $$
declare
  v_src text;
begin
  v_src := pg_get_functiondef('inv.unusual_calc(uuid, jsonb)'::regprocedure);
  execute regexp_replace(v_src, 'where \(coalesce\(.*\), true\)\s+and not exists \(select 1 from menu where menu.item_id = l.item_id\)\)',
                         'where not exists (select 1 from menu where menu.item_id = l.item_id)');
  v_src := pg_get_functiondef('rpt.store_items(uuid)'::regprocedure);
  v_src := replace(v_src, ' and not i.durable', '');
  v_src := replace(v_src, 'not i.durable and ', '');
  execute v_src;
  v_src := pg_get_functiondef(
    'inv.record_check_line(uuid, uuid, numeric, text, text, timestamptz, text, numeric, integer)'::regprocedure);
  execute regexp_replace(v_src, '\n  if v_qty is not null\n     and v_qty > inv.count_limit.*?\n  end if;', '');
end $$;
drop function inv.stock_check_sheet(uuid);
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
drop function inv.count_limit(uuid, uuid, numeric), inv.count_usual(uuid, uuid, numeric),
  inv.leads_making(uuid);
create or replace function ops.briefing_part_now(p_outlet uuid, p_at timestamptz default now())
returns text
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select case when (p_at at time zone ops.tz_of(p_outlet))::time >= time '04:00'
               and (p_at at time zone ops.tz_of(p_outlet))::time < time '16:00'
              then 'lunch' else 'dinner' end;
$$;
do $$
declare
  f text;
  v_src text;
begin
  foreach f in array array['ops.save_briefing(uuid, text, text, uuid[], text)',
                           'ops.briefing_at(uuid)'] loop
    v_src := pg_get_functiondef(f::regprocedure);
    v_src := replace(v_src, '(''day'', ''breakfast'', ''lunch'', ''dinner'', ''late_night'')',
                     '(''day'', ''lunch'', ''dinner'')');
    v_src := replace(v_src, 'array[''day'', ''breakfast'', ''lunch'', ''dinner'', ''late_night'']',
                     'array[''day'', ''lunch'', ''dinner'']');
    execute v_src;
  end loop;
end $$;
delete from ops.briefing where part in ('breakfast', 'late_night');
alter table ops.briefing drop constraint briefing_part_check;
alter table ops.briefing add constraint briefing_part_check check (part in ('day', 'lunch', 'dinner'));
revoke execute on function inv.batches(uuid), inv.stock_check_sheet(uuid) from public;
grant execute on function inv.batches(uuid), inv.stock_check_sheet(uuid) to app_rw;
alter table inv.item drop column durable, drop column food_type, drop column allergens,
  drop column batch_portions;
