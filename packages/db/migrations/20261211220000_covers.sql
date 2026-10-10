-- migrate:up
-- Covers and average spend per cover (ADR 096), part of Menu and sales (ADR 085).
--
-- * Whoever enters the outlet's sales (SALES modify at one of its menu stores: the GM, the cost
--   controller) gives each business day's covers per meal period (breakfast, lunch, dinner).
--   Whoever opens the outlet's day (the outlet flash, ADR 023) reads them; the Account Owner's
--   reports stay read-only.
-- * Once the day's sales are in (the POS import or entered sales), the average spend per cover
--   is the day's sales on the outlet flash divided by its covers; it is shown to the same people
--   and equals what is behind it (reports-reconcile.db.test.ts).

create table ops.covers (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the outlet
  day date not null,
  period text not null check (period in ('breakfast', 'lunch', 'dinner')),
  covers int not null check (covers between 0 and 20000)
);
select core.add_standard_columns('ops.covers');
create unique index covers_day on ops.covers (org_node_id, day, period);

-- Whoever enters the outlet's sales gives its covers.
create function ops.can_give_covers(p_outlet uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, core, menu
as $$
  select core.module_on(core.my_tenant(), 'menu_sales')
         and exists (select 1 from menu.menu_outlet mo
                      where mo.org_node_id = p_outlet and mo.tenant_id = core.my_tenant()
                        and core.can('SALES', 'modify', null, mo.delivery_node_id));
$$;

create function ops.set_covers(p_outlet uuid, p_day date, p_period text, p_covers int)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, rpt
as $$
begin
  if not exists (select 1 from core.hierarchy_node
                  where id = p_outlet and tenant_id = core.my_tenant() and kind = 'outlet')
     or not ops.can_give_covers(p_outlet) then
    perform ops.fail('NOT_AUTHORISED', 'the outlet''s sales');
  end if;
  if p_period is null or p_period not in ('breakfast', 'lunch', 'dinner') then
    perform ops.fail('INVALID_VALUE', 'breakfast, lunch or dinner');
  end if;
  if p_covers is null or p_covers < 0 or p_covers > 20000 then
    perform ops.fail('INVALID_VALUE', '0 to 20000 covers');
  end if;
  if p_day is null or p_day > rpt.today(p_outlet) or p_day < rpt.today(p_outlet) - 31 then
    perform ops.fail('INVALID_VALUE', 'today or the month before');
  end if;
  insert into ops.covers (tenant_id, org_node_id, day, period, covers)
  values (core.my_tenant(), p_outlet, p_day, p_period, p_covers)
  on conflict (org_node_id, day, period) do update set covers = excluded.covers;
end $$;

-- A day's covers by period, the day's sales on the outlet flash, the spend per cover, and
-- whether I may give them.
create function ops.covers_day(p_outlet uuid, p_day date)
returns table (period text, covers int, total_covers int, sales numeric, per_cover numeric,
               can_edit boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
#variable_conflict use_column
declare
  v_sales numeric;
  v_total int;
  v_edit boolean;
begin
  if not core.module_on(core.my_tenant(), 'menu_sales')
     or not rpt.can_open('outlet_flash', p_outlet) then
    perform ops.fail('NOT_AUTHORISED', 'the outlet''s sales');
  end if;
  v_edit := ops.can_give_covers(p_outlet);
  select coalesce(sum(s.sales), 0) into v_sales from rpt.sales_of(p_outlet, p_day) s;
  select sum(c.covers)::int into v_total from ops.covers c
   where c.org_node_id = p_outlet and c.day = p_day;
  return query
    select m.period, c.covers, v_total, v_sales,
           round(v_sales / nullif(v_total, 0), 2), v_edit
      from (values ('breakfast', 1), ('lunch', 2), ('dinner', 3)) m(period, ord)
      left join ops.covers c on c.org_node_id = p_outlet and c.day = p_day
                            and c.period = m.period
     order by m.ord;
end $$;

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.covers', 'DERIVED_SALES', 'org', true);
select core.apply_domain_rls('ops.covers');
select audit.enable('ops.covers');

revoke execute on function ops.can_give_covers(uuid), ops.set_covers(uuid, date, text, int),
  ops.covers_day(uuid, date)
  from public, platform_loader;
grant execute on function ops.set_covers(uuid, date, text, int), ops.covers_day(uuid, date)
  to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.covers_day(uuid, date);
drop function ops.set_covers(uuid, date, text, int);
drop function ops.can_give_covers(uuid);
delete from core.domain_table where table_name = 'ops.covers'::regclass;
drop table ops.covers;
