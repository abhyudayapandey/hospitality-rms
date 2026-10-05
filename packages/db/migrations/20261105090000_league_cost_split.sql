-- migrate:up

-- Outlets side by side: materials split into food, drinks and losses, each a share of the
-- outlet's total cost (materials + people), so food + drinks + losses + people = 100
-- (ADR 047). materials_pct stays, as the sum of the three.
do $$
declare
  v text := pg_get_functiondef('rpt.league(uuid,date,date)'::regprocedure);
begin
  if position('labour_pct numeric, materials_pct numeric' in v) = 0
     or position('round(m.materials * 100 / nullif(m.materials + l.labour, 0), 1),' in v) = 0
     or position(' + c.count_loss) as materials' in v) = 0 then
    raise exception 'rpt.league is not the source this migration was written against';
  end if;
  v := replace(v, 'labour_pct numeric, materials_pct numeric',
                  'labour_pct numeric, materials_pct numeric, food_share numeric, drink_share numeric, losses_share numeric');
  v := replace(v, ' + c.count_loss) as materials',
                  ' + c.count_loss) as materials,' || chr(10)
    || '             sum(c.recipe_cost) filter (where c.menu = ''Food'') as food,' || chr(10)
    || '             sum(c.recipe_cost) filter (where c.menu = ''Bar'') as drinks');
  v := replace(v, 'round(m.materials * 100 / nullif(m.materials + l.labour, 0), 1),',
                  'round(m.materials * 100 / nullif(m.materials + l.labour, 0), 1),' || chr(10)
    || '           round(m.food * 100 / nullif(m.materials + l.labour, 0), 1),' || chr(10)
    || '           round(m.drinks * 100 / nullif(m.materials + l.labour, 0), 1),' || chr(10)
    || '           round((m.materials - coalesce(m.food, 0) - coalesce(m.drinks, 0)) * 100'
    || ' / nullif(m.materials + l.labour, 0), 1),');
  drop function rpt.league(uuid, date, date);
  execute v;
end $$;
revoke execute on function rpt.league(uuid, date, date) from public;
grant execute on function rpt.league(uuid, date, date) to app_rw;

-- migrate:down

do $$
declare
  v text := pg_get_functiondef('rpt.league(uuid,date,date)'::regprocedure);
begin
  v := replace(v, ', food_share numeric, drink_share numeric, losses_share numeric', '');
  v := replace(v, ' + c.count_loss) as materials,' || chr(10)
    || '             sum(c.recipe_cost) filter (where c.menu = ''Food'') as food,' || chr(10)
    || '             sum(c.recipe_cost) filter (where c.menu = ''Bar'') as drinks',
                  ' + c.count_loss) as materials');
  v := replace(v, chr(10) || '           round(m.food * 100 / nullif(m.materials + l.labour, 0), 1),' || chr(10)
    || '           round(m.drinks * 100 / nullif(m.materials + l.labour, 0), 1),' || chr(10)
    || '           round((m.materials - coalesce(m.food, 0) - coalesce(m.drinks, 0)) * 100'
    || ' / nullif(m.materials + l.labour, 0), 1),', '');
  drop function rpt.league(uuid, date, date);
  execute v;
end $$;
revoke execute on function rpt.league(uuid, date, date) from public;
grant execute on function rpt.league(uuid, date, date) to app_rw;
