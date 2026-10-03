-- migrate:up
-- R-4 (ADR 031) and PO-4 (ADR 032).
--
-- Company settings, kept in core.tenant.settings beside the modules (ADR 026): report
-- targets, the menu engineering popularity threshold, the overtime multiplier and whether
-- an order sent to a supplier shows prices. Anyone in the company reads them; only the
-- Account Owner (COMPANY_SETTINGS modify at the company) changes them; the tenant's audit
-- trigger records every change.
--
-- The league table (rpt.league): the outlets of a company, region or area side by side.
--
-- Sending an order (inv.po_send, inv.record_po_send) and the supplier's phone and email
-- (inv.update_supplier_contact). No server email: the app opens WhatsApp, the mail app or a
-- printable page, and records the send.

-- ---------------------------------------------------------------------------
-- Company settings
-- ---------------------------------------------------------------------------

create function core.settings_defaults() returns jsonb
language sql immutable
as $$
  select jsonb_build_object(
    'targets', jsonb_build_object('food', 30, 'drink', 22, 'labour', 25, 'prime', 60,
                                  'wastage', 2, 'tasks', 90),
    'menu_popular_pct', 70,
    'overtime_multiplier', 1,
    'po_send_prices', false);
$$;

-- Internal: a company's settings, with the defaults for what it has not set.
create function core.settings_of(p_tenant uuid) returns jsonb
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select d || jsonb_build_object('targets', (d -> 'targets') || coalesce(s -> 'targets', '{}'))
           || coalesce(s - 'targets' - 'modules', '{}')
    from core.settings_defaults() d
    left join lateral (select t.settings from core.tenant t where t.id = p_tenant) x(s) on true;
$$;

-- The signed-in person's company's settings (anyone signed in may read them).
create function core.company_settings() returns jsonb
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select case when core.my_tenant() is null then null else core.settings_of(core.my_tenant()) end;
$$;

-- Changes the settings given, keeps the rest. Only the Account Owner, for their own company.
create function core.set_company_settings(p_settings jsonb) returns void
language plpgsql security definer
set search_path = pg_catalog, core
as $$
declare
  v_tenant uuid := core.my_tenant();
  v_key text;
  v_val jsonb;
  v_target text;
  v_new jsonb;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'INVALID_SETTING' using detail = 'an object of settings';
  end if;
  for v_key, v_val in select * from jsonb_each(p_settings) loop
    if v_key = 'targets' then
      if jsonb_typeof(v_val) <> 'object' then
        raise exception 'INVALID_SETTING' using detail = 'targets';
      end if;
      for v_target in select jsonb_object_keys(v_val) loop
        if v_target not in ('food', 'drink', 'labour', 'prime', 'wastage', 'tasks')
           or jsonb_typeof(v_val -> v_target) <> 'number'
           or (v_val ->> v_target)::numeric not between 0 and 100 then
          raise exception 'INVALID_SETTING' using detail = 'targets.' || v_target;
        end if;
      end loop;
    elsif v_key = 'menu_popular_pct' then
      if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric not between 10 and 100 then
        raise exception 'INVALID_SETTING' using detail = v_key;
      end if;
    elsif v_key = 'overtime_multiplier' then
      if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric not between 1 and 3 then
        raise exception 'INVALID_SETTING' using detail = v_key;
      end if;
    elsif v_key = 'po_send_prices' then
      if jsonb_typeof(v_val) <> 'boolean' then
        raise exception 'INVALID_SETTING' using detail = v_key;
      end if;
    else
      raise exception 'INVALID_SETTING' using detail = v_key;
    end if;
  end loop;
  if v_tenant is null
     or not core.can('COMPANY_SETTINGS', 'modify', core.org_root(v_tenant), null, null) then
    raise exception 'NOT_AUTHORISED' using detail = 'COMPANY_SETTINGS modify at the company';
  end if;
  select t.settings
         || (p_settings - 'targets')
         || case when p_settings ? 'targets'
                 then jsonb_build_object('targets',
                        coalesce(t.settings -> 'targets', '{}') || (p_settings -> 'targets'))
                 else '{}' end
    into v_new
    from core.tenant t where t.id = v_tenant;
  update core.tenant set settings = v_new where id = v_tenant and settings is distinct from v_new;
end $$;

revoke execute on function core.settings_defaults(), core.settings_of(uuid),
  core.company_settings(), core.set_company_settings(jsonb) from public;
grant execute on function core.company_settings(), core.set_company_settings(jsonb) to app_rw;

-- ---------------------------------------------------------------------------
-- The overtime multiplier (hourly staff; salaried pay is fixed) and the menu engineering
-- threshold come from the settings
-- ---------------------------------------------------------------------------

do $$
declare
  v_src text := pg_get_functiondef('rpt.calc_labour_people(uuid[],date,date)'::regprocedure);
  v_new text := v_src;
begin
  v_new := replace(v_new,
    'select n.id, n.tenant_id, n.path from core.hierarchy_node n where n.id = any (p_outlets)',
    'select n.id, n.tenant_id, n.path,
           (core.settings_of(n.tenant_id) ->> ''overtime_multiplier'')::numeric as ot_mult
      from core.hierarchy_node n where n.id = any (p_outlets)');
  v_new := replace(v_new,
    'o.tenant_id, s.pay_rate, s.pay_basis',
    'o.tenant_id, o.ot_mult, s.pay_rate, s.pay_basis');
  v_new := replace(v_new,
    'case when w.pay_basis = ''hourly'' then coalesce(ot.hours, 0) * w.pay_rate else 0 end',
    'case when w.pay_basis = ''hourly''
                then (coalesce(ot.hours, 0) + coalesce(ot.overtime, 0) * (w.ot_mult - 1))
                     * w.pay_rate
                else 0 end');
  if v_new = v_src or v_new not like '%ot_mult - 1%' or v_new not like '%o.ot_mult,%' then
    raise exception 'calc_labour_people: anchor not found';
  end if;
  execute v_new;
end $$;

do $$
declare
  v_src text := pg_get_functiondef('rpt.menu_engineering(uuid,date,date)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_src, '0.7 / p.dishes as popular_from',
    '(core.settings_of(core.my_tenant()) ->> ''menu_popular_pct'')::numeric / 100
               / p.dishes as popular_from');
  if v_new = v_src then raise exception 'menu_engineering: anchor not found'; end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- The league table
-- ---------------------------------------------------------------------------

-- Who opens it: at a company, region or area, whoever reads the outlets' sales there
-- (DERIVED_SALES: the Area Manager) or holds REPORTS (the Account Owner), when two or more
-- of its outlets are theirs to open.
do $$
declare
  v_src text := pg_get_functiondef('rpt.can_open(text,uuid)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_src, $a$             else false end$a$, $a$             -- R-4 (ADR 031)
             when 'league' then
               n.type = 'org' and n.kind in ('company', 'region', 'area')
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('DERIVED_SALES', 'view', n.id, null))
               and (select count(*) from core.hierarchy_node o
                     where o.type = 'org' and o.kind = 'outlet' and o.archived_at is null
                       and o.path operator(extensions.<@) n.path
                       and rpt.can_open('outlet_flash', o.id)) >= 2
             else false end$a$);
  if v_new = v_src then raise exception 'can_open: anchor not found'; end if;
  execute v_new;
end $$;

do $$
declare
  v_src text := pg_get_functiondef('rpt.report_places(text)'::regprocedure);
  v_new text := v_src;
begin
  v_new := replace(v_new, $a$  v_ok uuid[];$a$, $a$  v_ok uuid[];
  v_dsales uuid[];$a$);
  v_new := replace(v_new, $a$  else
    raise exception 'INVALID_REPORT' using detail = p_report;$a$, $a$  elsif p_report = 'league' then
    v_dsales := core.visible_nodes('DERIVED_SALES', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('company', 'region', 'area')
       and n.tenant_id = core.my_tenant()
       and (n.id = any (v_all) or n.id = any (v_dsales))
       and (select count(*) from core.hierarchy_node o
             where o.type = 'org' and o.kind = 'outlet' and o.archived_at is null
               and o.path <@ n.path and rpt.can_open('outlet_flash', o.id)) >= 2;
  else
    raise exception 'INVALID_REPORT' using detail = p_report;$a$);
  if v_new = v_src or v_new not like '%v_dsales uuid[]%' or v_new not like '%''league''%' then
    raise exception 'report_places: anchor not found';
  end if;
  execute v_new;
end $$;

-- The league table comes first: it is where an area manager or the owner starts. Like cost
-- of sales, it needs the Menu and sales module.
do $$
declare
  v_src text := pg_get_functiondef('rpt.my_reports()'::regprocedure);
  v_new text := v_src;
begin
  v_new := replace(v_new, $a$values (1, 'outlet_flash')$a$,
                          $a$values (0, 'league'), (1, 'outlet_flash')$a$);
  v_new := replace(v_new, $a$           when 'menu_engineering' then$a$,
    $a$           when 'league' then core.module_on(core.my_tenant(), 'menu_sales')
                              and exists (select 1 from rpt.report_places(v.r))
           when 'menu_engineering' then$a$);
  if v_new = v_src or v_new not like '%(0, ''league'')%' or v_new not like '%when ''league''%' then
    raise exception 'my_reports: anchor not found';
  end if;
  execute v_new;
end $$;

-- Each outlet of the place the person may open Outlet today for, over a period of at most
-- 35 days: sales, food and drink cost by recipe, labour and prime cost (only where the
-- person sees labour cost, and never for fewer than 3 paid people), wastage and tasks done
-- on time. The same figures as Outlet today, added up over the days.
create function rpt.league(p_place uuid, p_from date, p_to date)
returns table (outlet_id uuid, code text, name text, sales numeric, food_pct numeric, drink_pct numeric,
               labour_pct numeric, prime_pct numeric, wastage_pct numeric, tasks_pct numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, menu, rpt
as $$
begin
  perform rpt.require('league', p_place);
  perform core.require_module('menu_sales');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 34
     or p_to > rpt.today(p_place) then
    raise exception 'INVALID_DATE' using detail = 'a period of at most 35 days, to today';
  end if;
  return query
    with o as (
      select n.id, n.code, n.name, rpt.today(n.id) as today, rpt.outlet_stores(n.id) as stores,
             rpt.outlet_team_places(n.id) as places, rpt.can_open('labour_cost', n.id) as labour
        from core.hierarchy_node n
        join core.hierarchy_node p on p.id = p_place
       where n.type = 'org' and n.kind = 'outlet' and n.archived_at is null
         and n.path operator(extensions.<@) p.path
         and rpt.can_open('outlet_flash', n.id)
    ), days as (
      select o.id, d::date as day from o
        cross join generate_series(p_from, least(p_to, o.today), interval '1 day') d
    ), s as (
      select d.id,
             coalesce(sum(x.sales), 0) as sales,
             sum(x.sales) filter (where x.menu = 'Food') as food_sales,
             sum(x.theoretical_cost) filter (where x.menu = 'Food') as food_cost,
             sum(x.sales) filter (where x.menu = 'Bar') as bar_sales,
             sum(x.theoretical_cost) filter (where x.menu = 'Bar') as bar_cost
        from days d cross join lateral rpt.sales_of(d.id, d.day) x
       group by d.id
    ), w as (
      select d.id, sum(x.wastage) as wastage
        from days d join o on o.id = d.id
        cross join lateral rpt.stores_of(o.stores, d.day, o.today) x
       group by d.id
    ), t as (
      select d.id, sum(x.due) as due, sum(x.done_on_time) as on_time
        from days d join o on o.id = d.id
        cross join lateral rpt.tasks_of(o.places, d.day, o.today) x
       group by d.id
    ), l as (
      select o.id, sum(x.hourly_cost + x.salary_cost) as labour
        from o cross join lateral rpt.labour_cost_of(o.id, p_from, least(p_to, o.today)) x
       where o.labour and x.part = 'outlet'
       group by o.id
    ), m as (
      select o.id,
             sum(c.recipe_cost + c.expired + c.transit_loss + c.wastage_other + c.other_use
                 + c.count_loss) as materials
        from o cross join lateral menu.cost_parts(o.id, o.stores, p_from, least(p_to, o.today)) c
       where o.labour
       group by o.id
    )
    select o.id, o.code, o.name, round(coalesce(s.sales, 0), 2),
           round(s.food_cost * 100 / nullif(s.food_sales, 0), 1),
           round(s.bar_cost * 100 / nullif(s.bar_sales, 0), 1),
           round(l.labour * 100 / nullif(s.sales, 0), 1),
           round((m.materials + l.labour) * 100 / nullif(s.sales, 0), 1),
           round(w.wastage * 100 / nullif(s.sales, 0), 1),
           round(t.on_time * 100.0 / nullif(t.due, 0), 1)
      from o
      left join s on s.id = o.id
      left join w on w.id = o.id
      left join t on t.id = o.id
      left join l on l.id = o.id
      left join m on m.id = o.id
     order by o.name;
end $$;

revoke execute on function rpt.league(uuid, date, date) from public;
grant execute on function rpt.league(uuid, date, date) to app_rw;

-- ---------------------------------------------------------------------------
-- PO-4: the supplier's phone, and sending an order
-- ---------------------------------------------------------------------------

-- inv.supplier.contact stays the email; phone is for WhatsApp.
alter table inv.supplier add column phone text;

-- People who run a store's orders (PURCHASE_ORDERS modify at one of the company's stores)
-- keep the supplier's phone and email up to date. Blank clears it. Audited (inv.supplier).
create function inv.update_supplier_contact(p_supplier uuid, p_phone text, p_email text)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_tenant uuid := core.my_tenant();
  v_phone text := nullif(btrim(p_phone), '');
  v_email text := nullif(btrim(p_email), '');
begin
  if not exists (select 1 from inv.supplier s where s.id = p_supplier and s.tenant_id = v_tenant) then
    raise exception 'NOT_FOUND' using detail = 'no such supplier';
  end if;
  if not exists (select 1 from core.hierarchy_node n
                  where n.tenant_id = v_tenant and n.type = 'delivery' and n.holds_stock
                    and n.archived_at is null
                    and core.can('PURCHASE_ORDERS', 'modify', null, n.id)) then
    raise exception 'NOT_AUTHORISED' using detail = 'PURCHASE_ORDERS modify at a store';
  end if;
  if v_phone is not null and (v_phone !~ '^\+?[0-9 ()-]+$'
                              or length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 8 and 15) then
    raise exception 'INVALID_CONTACT' using detail = 'phone';
  end if;
  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'INVALID_CONTACT' using detail = 'email';
  end if;
  update inv.supplier set phone = v_phone, contact = v_email
   where id = p_supplier and (phone, contact) is distinct from (v_phone, v_email);
end $$;

-- Each time an order is sent to its supplier: by whom, when, how.
create table inv.po_send (
  id uuid primary key default core.uuid_v7(),
  po_id uuid not null references inv.purchase_order(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  channel text not null check (channel in ('whatsapp', 'email', 'print')),
  sent_by uuid not null references core.app_user(id),
  sent_at timestamptz not null default now()
);
select core.add_standard_columns('inv.po_send');
create index po_send_po on inv.po_send (po_id, sent_at);
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only, insert_only)
  values ('inv.po_send', 'PURCHASE_ORDERS', 'delivery', true, true);
select core.apply_domain_rls('inv.po_send');
select audit.enable('inv.po_send');

-- Records a send of a released order, for people who run the store's orders.
create function inv.record_po_send(p_po uuid, p_channel text) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_po inv.purchase_order;
  v_id uuid;
begin
  if p_channel is null or p_channel not in ('whatsapp', 'email', 'print') then
    raise exception 'INVALID_CHANNEL' using detail = coalesce(p_channel, '');
  end if;
  select * into v_po from inv.purchase_order po
   where po.id = p_po and po.tenant_id = core.my_tenant();
  if v_po.id is null then
    raise exception 'NOT_FOUND' using detail = 'no such order';
  end if;
  if not core.can('PURCHASE_ORDERS', 'modify', null, v_po.delivery_node_id) then
    raise exception 'NOT_AUTHORISED' using detail = 'PURCHASE_ORDERS modify at the store';
  end if;
  if v_po.status <> 'released' then
    raise exception 'INVALID_STATE' using detail = 'only a released order is sent';
  end if;
  insert into inv.po_send (tenant_id, po_id, delivery_node_id, channel, sent_by)
  values (v_po.tenant_id, v_po.id, v_po.delivery_node_id, p_channel, core.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function inv.update_supplier_contact(uuid, text, text),
  inv.record_po_send(uuid, text) from public;
grant execute on function inv.update_supplier_contact(uuid, text, text),
  inv.record_po_send(uuid, text) to app_rw;

-- migrate:down
drop function inv.record_po_send(uuid, text);
delete from core.domain_table where table_name = 'inv.po_send'::regclass;
drop table inv.po_send;
drop function inv.update_supplier_contact(uuid, text, text);
alter table inv.supplier drop column phone;
drop function rpt.league(uuid, date, date);

CREATE OR REPLACE FUNCTION rpt.my_reports()
 RETURNS TABLE(report text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr'
AS $function$
  select v.r from (values (1, 'outlet_flash'), (2, 'department'), (3, 'cost_of_sales'),
                          (4, 'menu_engineering'), (5, 'stock_position'), (6, 'purchasing'),
                          (7, 'central_kitchen'), (8, 'people'), (9, 'my_week')) v(o, r)
   where case v.r
           when 'my_week' then exists (select 1 from hr.worker w
                                        where w.owner_user_id = core.current_user_id()
                                          and w.status = 'active')
           when 'cost_of_sales' then core.module_on(core.my_tenant(), 'menu_sales')
                                     and exists (select 1 from rpt.report_places(v.r))
           when 'menu_engineering' then core.module_on(core.my_tenant(), 'menu_sales')
                                        and exists (select 1 from rpt.report_places(v.r))
           else exists (select 1 from rpt.report_places(v.r)) end
   order by v.o
$function$

;

CREATE OR REPLACE FUNCTION rpt.report_places(p_report text)
 RETURNS TABLE(id uuid, code text, name text, kind text, preferred integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr', 'extensions'
AS $function$
declare
  v_home core.hierarchy_node;
  v_site core.hierarchy_node;
  v_all uuid[] := core.visible_nodes('REPORTS', 'view');
  v_menu uuid[];
  v_sales uuid[];
  v_orders uuid[];
  v_attendance uuid[];
  v_workers uuid[];
  v_ok uuid[];
begin
  if p_report = 'outlet_flash' then
    v_sales := core.visible_nodes('SALES', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.kind = 'outlet' and n.type = 'org'
       and (n.id = any (v_all)
            or exists (select 1 from core.node_link l
                        where l.org_node_id = n.id
                          and l.delivery_node_id = any (v_sales)));
  elsif p_report = 'department' then
    v_attendance := core.visible_nodes('ATTENDANCE', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('outlet', 'site', 'department')
       and (n.id = any (v_all) or n.id = any (v_attendance))
       and core.is_team_place(n.id);
  elsif p_report = 'cost_of_sales' then
    v_menu := core.visible_nodes('MENU', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('outlet', 'site') and n.tenant_id = core.my_tenant()
       and cardinality(rpt.place_stores(n.id)) > 0
       and (n.id = any (v_all) or rpt.place_stores(n.id) && v_menu);
  elsif p_report = 'menu_engineering' then
    v_menu := core.visible_nodes('MENU', 'view');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind = 'outlet' and n.tenant_id = core.my_tenant()
       and exists (select 1 from menu.menu_outlet mo where mo.org_node_id = n.id
                      and (n.id = any (v_all) or mo.delivery_node_id = any (v_menu)));
  elsif p_report in ('stock_position', 'purchasing') then
    v_menu := core.visible_nodes('MENU', 'view');
    v_orders := core.visible_nodes('PURCHASE_ORDERS', 'modify');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'delivery' and n.holds_stock and n.tenant_id = core.my_tenant()
       and (n.id = any (v_menu)
            or n.id = any (v_orders)
            or exists (select 1 from core.node_link l where l.delivery_node_id = n.id
                          and l.org_node_id = any (v_all)));
  elsif p_report = 'people' then
    v_workers := core.visible_nodes('WORKERS', 'modify');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'org' and n.kind in ('company', 'region', 'area', 'outlet', 'site')
       and n.tenant_id = core.my_tenant()
       and (n.id = any (v_all) or n.id = any (v_workers));
  elsif p_report = 'central_kitchen' then
    v_menu := core.visible_nodes('MENU', 'view');
    v_orders := core.visible_nodes('PURCHASE_ORDERS', 'modify');
    select coalesce(array_agg(n.id), '{}') into v_ok
      from core.hierarchy_node n
     where n.type = 'delivery' and n.holds_stock and n.tenant_id = core.my_tenant()
       and rpt.is_kitchen_store(n.id)
       and (n.id = any (v_menu)
            or n.id = any (v_orders)
            or exists (select 1 from core.node_link l where l.delivery_node_id = n.id
                          and l.org_node_id = any (v_all)));
  else
    raise exception 'INVALID_REPORT' using detail = p_report;
  end if;
  select n.* into v_home from hr.worker w join core.hierarchy_node n on n.id = w.org_node_id
   where w.owner_user_id = core.current_user_id() and w.status = 'active';
  -- the person's outlet or site, for stores: those of their own outlet come first
  select a.* into v_site from core.hierarchy_node a
   where v_home.id is not null and v_home.path <@ a.path and a.kind in ('outlet', 'site')
   order by nlevel(a.path) desc limit 1;
  return query
    select n.id, n.code, n.name, n.kind,
           case when n.type = 'delivery' then
                  case when exists (select 1 from core.node_link l
                                     where l.delivery_node_id = n.id and l.org_node_id = v_home.id)
                       then 0
                       when v_site.id is not null
                            and n.id = any (rpt.place_stores(v_site.id)) then 1
                       else 9 end
                when n.id = v_home.id then 0
                when v_home.id is not null and v_home.path <@ n.path then 1
                when v_home.id is not null and n.path <@ v_home.path then 2
                else 9 end
      from core.hierarchy_node n
     where n.id = any (v_ok) and n.tenant_id = core.my_tenant() and n.archived_at is null
     order by 5, n.name;
end $function$

;

CREATE OR REPLACE FUNCTION rpt.can_open(p_report text, p_place uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'rpt'
AS $function$
  select coalesce((
    select n.tenant_id = core.my_tenant() and n.archived_at is null
           and case p_report
             when 'outlet_flash' then
               n.type = 'org' and n.kind = 'outlet'
               and (core.can('REPORTS', 'view', n.id, null)
                    or exists (select 1 from core.node_link l where l.org_node_id = n.id
                                  and core.can('SALES', 'view', null, l.delivery_node_id)))
             when 'department' then
               n.type = 'org' and core.is_team_place(n.id)
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('ATTENDANCE', 'view', n.id, null))
             when 'cost_of_sales' then
               n.type = 'org' and n.kind in ('outlet', 'site')
               and cardinality(rpt.cost_stores(n.id)) > 0
             when 'menu_engineering' then
               n.type = 'org' and n.kind = 'outlet'
               and exists (select 1 from menu.menu_outlet mo where mo.org_node_id = n.id
                              and (core.can('REPORTS', 'view', n.id, null)
                                   or core.can('MENU', 'view', null, mo.delivery_node_id)))
             when 'stock_position' then
               n.type = 'delivery' and n.holds_stock and rpt.store_cost_access(n.id)
             when 'purchasing' then
               n.type = 'delivery' and n.holds_stock and rpt.store_cost_access(n.id)
             -- R-3 (ADR 030)
             when 'labour_cost' then
               n.type = 'org' and n.kind in ('outlet', 'site')
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('LABOUR_COST', 'view', n.id, null))
             when 'people' then
               n.type = 'org' and n.kind in ('company', 'region', 'area', 'outlet', 'site')
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('WORKERS', 'modify', n.id, null))
             when 'central_kitchen' then
               n.type = 'delivery' and n.holds_stock and rpt.is_kitchen_store(n.id)
               and rpt.store_cost_access(n.id)
             else false end
      from core.hierarchy_node n where n.id = p_place), false)
$function$

;

CREATE OR REPLACE FUNCTION rpt.menu_engineering(p_outlet uuid, p_from date, p_to date)
 RETURNS TABLE(menu text, menu_item_id uuid, code text, name text, category text, sold numeric, revenue numeric, price numeric, cost numeric, margin numeric, mix_pct numeric, avg_margin numeric, popular_from_pct numeric, class text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'inv', 'menu', 'rpt'
AS $function$
declare
  v_stores uuid[];
begin
  perform rpt.require('menu_engineering', p_outlet);
  perform core.require_module('menu_sales');
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATES' using detail = 'the period ends on or after its start';
  end if;
  select coalesce(array_agg(distinct mo.delivery_node_id), '{}') into v_stores
    from menu.menu_outlet mo
   where mo.org_node_id = p_outlet
     and (core.can('REPORTS', 'view', p_outlet, null)
          or core.can('MENU', 'view', null, mo.delivery_node_id));
  return query
    with on_menu as (
      select distinct on (mo.menu_item_id) mo.menu_item_id, mo.delivery_node_id, mo.price
        from menu.menu_outlet mo
       where mo.org_node_id = p_outlet and mo.delivery_node_id = any (v_stores)
         and mo.effective_from <= p_to and (mo.effective_to is null or mo.effective_to >= p_from)
       order by mo.menu_item_id, mo.effective_from desc
    ), sold as (
      select sl.menu_item_id, sl.delivery_node_id, sd.business_date, sum(sl.qty) as qty,
             sum(sl.qty * sl.price) as revenue
        from menu.sales_day sd
        join menu.sales_line sl on sl.sales_day_id = sd.id
       where sd.org_node_id = p_outlet and sd.business_date between p_from and p_to
         and sl.delivery_node_id = any (v_stores)
       group by 1, 2, 3
    ), costed as (
      select s.menu_item_id, s.qty, s.revenue,
             s.qty * inv.recipe_cost((inv.recipe_on(null, s.menu_item_id, s.business_date)).id,
                                     s.delivery_node_id, 'current', s.business_date) as cost
        from sold s
    ), items as (
      select o.menu_item_id, m.menu, m.code, m.name, m.category,
             coalesce(sum(c.qty), 0) as sold, coalesce(sum(c.revenue), 0) as revenue,
             case when sum(c.qty) > 0 then sum(c.revenue) / sum(c.qty) else o.price end as price,
             case when sum(c.qty) > 0 then sum(c.cost) / sum(c.qty)
                  else inv.recipe_cost((inv.recipe_on(null, o.menu_item_id, p_to)).id,
                                       o.delivery_node_id, 'current', p_to) end as cost
        from on_menu o
        join menu.menu_item m on m.id = o.menu_item_id
        left join costed c on c.menu_item_id = o.menu_item_id
       group by o.menu_item_id, o.price, o.delivery_node_id, m.menu, m.code, m.name, m.category
    ), per as (
      select i.*, i.price - i.cost as margin,
             sum(i.sold) over (partition by i.menu) as menu_sold,
             count(*) over (partition by i.menu) as dishes
        from items i
    ), stats as (
      select p.*,
             sum(p.sold * p.margin) over (partition by p.menu)
               / nullif(sum(p.sold) filter (where p.margin is not null)
                          over (partition by p.menu), 0) as avg_margin,
             p.sold / nullif(p.menu_sold, 0) as mix,
             0.7 / p.dishes as popular_from
        from per p
    )
    select s.menu, s.menu_item_id, s.code, s.name, s.category, s.sold, round(s.revenue, 2),
           round(s.price, 2), round(s.cost, 2), round(s.margin, 2), round(s.mix * 100, 1),
           round(s.avg_margin, 2), round(s.popular_from * 100, 1),
           case when s.menu_sold = 0 or s.margin is null or s.avg_margin is null then null
                when s.mix >= s.popular_from and s.margin >= s.avg_margin then 'star'
                when s.mix >= s.popular_from then 'plowhorse'
                when s.margin >= s.avg_margin then 'puzzle'
                else 'dog' end
      from stats s
     order by s.menu, s.margin * s.sold desc nulls last, s.name;
end $function$

;

CREATE OR REPLACE FUNCTION rpt.calc_labour_people(p_outlets uuid[], p_from date, p_to date)
 RETURNS TABLE(tenant_id uuid, outlet_id uuid, group_id uuid, business_date date, people integer, hours numeric, overtime_hours numeric, hourly_cost numeric, salary_cost numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'core', 'hr', 'ops', 'rpt', 'extensions'
AS $function$
  with o as (
    select n.id, n.tenant_id, n.path from core.hierarchy_node n where n.id = any (p_outlets)
  ), w as (
    select w.id, w.org_node_id as group_id, w.joined_on, w.status, o.id as outlet_id,
           o.tenant_id, s.pay_rate, s.pay_basis
      from o
      join core.hierarchy_node h on h.type = 'org' and h.path <@ o.path
      join hr.worker w on w.org_node_id = h.id
      join hr.worker_sensitive s on s.worker_id = w.id and s.pay_rate is not null
     where core.nearest(h.id, array['outlet', 'site']) = o.id
  ), ot as (
    select h.worker_id as id, h.business_date as day, h.hours, h.overtime_hours as overtime
      from rpt.worker_hours(array(select w.id from w), p_from, p_to) h
  ), per as (
    select w.tenant_id, w.outlet_id, w.group_id, d::date as day, w.id,
           coalesce(ot.hours, 0) as hours, coalesce(ot.overtime, 0) as overtime,
           case when w.pay_basis = 'hourly' then coalesce(ot.hours, 0) * w.pay_rate else 0 end
             as hourly_cost,
           case when w.pay_basis = 'monthly' and w.status = 'active'
                     and (w.joined_on is null or w.joined_on <= d::date)
                then w.pay_rate * 12 / 365 else 0 end as salary_cost
      from w
      cross join generate_series(p_from, p_to, interval '1 day') d
      left join ot on ot.id = w.id and ot.day = d::date
  )
  select p.tenant_id, p.outlet_id, p.group_id, p.day,
         count(*) filter (where p.hourly_cost + p.salary_cost > 0)::int,
         sum(p.hours), sum(p.overtime), sum(p.hourly_cost), sum(p.salary_cost)
    from per p
   group by p.tenant_id, p.outlet_id, p.group_id, p.day
$function$

;

update core.tenant set settings = settings - 'targets' - 'menu_popular_pct' - 'overtime_multiplier' - 'po_send_prices';
drop function core.set_company_settings(jsonb);
drop function core.company_settings();
drop function core.settings_of(uuid);
drop function core.settings_defaults();
