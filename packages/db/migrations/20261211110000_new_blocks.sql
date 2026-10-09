-- migrate:up
-- The blocks of the building-blocks plan's PRs 2 to 4 (ADR 085, docs/plans/building-blocks.md),
-- registered together; their tables come in the migrations after this one. The same codes as
-- packages/domain/src/modules.ts and access.ts; the guard tests keep them equal.
--
--   Stock & buying   breakage, shelf_life (each needs stock)
--   Kitchen & bar    excise (needs stock; for outlets that serve alcohol)
--   People           training
--   Daily work       logbook, registers, utilities and audits (each needs checklists)
--   Hotel            rooms, linen (needs stock)
--
-- Each is on by default, like every block but Compliance: a customer whose plan has the bundle
-- has them, and a platform admin switches off what isn't sold. Nothing that is on goes off.

create or replace function core.module_codes() returns text[]
language sql immutable
as $$
  select array['stock', 'buying', 'breakage', 'shelf_life', 'recipes', 'production',
               'prep_lists', 'menu_sales', 'excise',
               'roster', 'clock_in', 'pay', 'leave', 'swaps', 'training',
               'checklists', 'maintenance', 'briefing', 'logbook', 'registers', 'utilities',
               'audits', 'minibars', 'rooms', 'linen', 'events', 'compliance'];
$$;

create or replace function core.module_bundle(p_code text) returns text
language sql immutable
as $$
  select case p_code
           when 'stock' then 'stock_buying'
           when 'buying' then 'stock_buying'
           when 'breakage' then 'stock_buying'
           when 'shelf_life' then 'stock_buying'
           when 'recipes' then 'kitchen_bar'
           when 'production' then 'kitchen_bar'
           when 'prep_lists' then 'kitchen_bar'
           when 'menu_sales' then 'kitchen_bar'
           when 'excise' then 'kitchen_bar'
           when 'roster' then 'people'
           when 'clock_in' then 'people'
           when 'pay' then 'people'
           when 'leave' then 'people'
           when 'swaps' then 'people'
           when 'training' then 'people'
           when 'checklists' then 'daily_work'
           when 'maintenance' then 'daily_work'
           when 'briefing' then 'daily_work'
           when 'logbook' then 'daily_work'
           when 'registers' then 'daily_work'
           when 'utilities' then 'daily_work'
           when 'audits' then 'daily_work'
           when 'minibars' then 'hotel'
           when 'rooms' then 'hotel'
           when 'linen' then 'hotel'
           when 'events' then 'events_compliance'
           when 'compliance' then 'events_compliance'
         end;
$$;

create or replace function core.module_needs(p_code text) returns text[]
language sql immutable
as $$
  select case p_code
           when 'buying' then array['stock']
           when 'breakage' then array['stock']
           when 'shelf_life' then array['stock']
           when 'recipes' then array['stock']
           when 'production' then array['recipes']
           when 'prep_lists' then array['production']
           when 'menu_sales' then array['recipes']
           when 'excise' then array['stock']
           when 'clock_in' then array['roster']
           when 'pay' then array['roster']
           when 'swaps' then array['roster']
           when 'utilities' then array['checklists']
           when 'audits' then array['checklists']
           when 'minibars' then array['stock']
           when 'linen' then array['stock']
           else '{}'::text[]
         end;
$$;

create or replace function core.domain_module(p_domain text) returns text
language sql immutable
as $$
  select case p_domain
           when 'STOCK_LEVELS' then 'stock'
           when 'STOCK_ADJUSTMENTS' then 'stock'
           when 'STOCK_CHECK' then 'stock'
           when 'TRANSFERS' then 'stock'
           when 'DERIVED_STOCK_LEVELS' then 'stock'
           when 'DERIVED_STOCK_ADJUSTMENTS' then 'stock'
           when 'DERIVED_TRANSFERS' then 'stock'
           when 'PURCHASE_ORDERS' then 'buying'
           when 'BILLS' then 'buying'
           when 'DERIVED_PURCHASE_ORDERS' then 'buying'
           when 'BREAKAGE' then 'breakage'
           when 'SHELF_LIFE' then 'shelf_life'
           when 'RECIPES' then 'recipes'
           when 'RECIPES_TEAM' then 'recipes'
           when 'PRODUCTION' then 'production'
           when 'PRODUCTION_TEAM' then 'production'
           when 'DERIVED_PRODUCTION' then 'production'
           when 'MENU' then 'menu_sales'
           when 'DERIVED_MENU' then 'menu_sales'
           when 'SALES' then 'menu_sales'
           when 'DERIVED_SALES' then 'menu_sales'
           when 'POS_IMPORT' then 'menu_sales'
           when 'EXCISE' then 'excise'
           when 'ROSTER' then 'roster'
           when 'ATTENDANCE' then 'clock_in'
           when 'ATTENDANCE_SELFIES' then 'clock_in'
           when 'COMPENSATION' then 'pay'
           when 'LABOUR_COST' then 'pay'
           when 'LEAVE' then 'leave'
           when 'SHIFT_SWAPS' then 'swaps'
           when 'TRAINING' then 'training'
           when 'CHECKLIST_TEMPLATES' then 'checklists'
           when 'MAINTENANCE' then 'maintenance'
           when 'BRIEFING' then 'briefing'
           when 'LOGBOOK' then 'logbook'
           when 'REGISTERS' then 'registers'
           when 'UTILITIES' then 'utilities'
           when 'AUDITS' then 'audits'
           when 'MINIBAR' then 'minibars'
           when 'ROOMS' then 'rooms'
           when 'LINEN' then 'linen'
           when 'EVENTS' then 'events'
           when 'COMPLIANCE' then 'compliance'
         end;
$$;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous registry for local work.
create or replace function core.module_codes() returns text[]
language sql immutable
as $$
  select array['stock', 'buying', 'recipes', 'production', 'prep_lists', 'menu_sales',
               'roster', 'clock_in', 'pay', 'leave', 'swaps',
               'checklists', 'maintenance', 'briefing', 'minibars', 'events', 'compliance'];
$$;
create or replace function core.module_bundle(p_code text) returns text
language sql immutable
as $$
  select case p_code
           when 'stock' then 'stock_buying'
           when 'buying' then 'stock_buying'
           when 'recipes' then 'kitchen_bar'
           when 'production' then 'kitchen_bar'
           when 'prep_lists' then 'kitchen_bar'
           when 'menu_sales' then 'kitchen_bar'
           when 'roster' then 'people'
           when 'clock_in' then 'people'
           when 'pay' then 'people'
           when 'leave' then 'people'
           when 'swaps' then 'people'
           when 'checklists' then 'daily_work'
           when 'maintenance' then 'daily_work'
           when 'briefing' then 'daily_work'
           when 'minibars' then 'hotel'
           when 'events' then 'events_compliance'
           when 'compliance' then 'events_compliance'
         end;
$$;
create or replace function core.module_needs(p_code text) returns text[]
language sql immutable
as $$
  select case p_code
           when 'buying' then array['stock']
           when 'recipes' then array['stock']
           when 'production' then array['recipes']
           when 'prep_lists' then array['production']
           when 'menu_sales' then array['recipes']
           when 'clock_in' then array['roster']
           when 'pay' then array['roster']
           when 'swaps' then array['roster']
           when 'minibars' then array['stock']
           else '{}'::text[]
         end;
$$;
select core.patch_function('core.domain_module(text)',
$x$           when 'BREAKAGE' then 'breakage'
           when 'SHELF_LIFE' then 'shelf_life'
$x$, '');
do $$
begin
  execute regexp_replace(pg_get_functiondef('core.domain_module(text)'::regprocedure),
    E'           when ''(EXCISE|TRAINING|LOGBOOK|REGISTERS|UTILITIES|AUDITS|ROOMS|LINEN)'' then ''[a-z_]+''\n',
    '', 'g');
end $$;
