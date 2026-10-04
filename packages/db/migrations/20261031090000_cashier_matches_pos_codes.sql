-- migrate:up

-- The cashier matches the POS codes (ADR 039, owner feedback 4 Oct): whoever imports at the
-- outlet matches a code nobody has matched yet, from the outlet's dish names
-- (menu.pos_dishes: names and menu only). Changing a code already matched moves its sales
-- and stock use to another dish, so that stays with people who post the outlet's sales
-- (POS_CODE_MATCHED). The morning expiry alert gives the use-by date only.

-- Matches a POS code to a menu item on the outlet's menu. The cashier who imports matches the
-- codes nobody has matched yet; changing a code already matched moves its sales and stock use
-- to another dish, so that stays with people who post the outlet's sales.
create or replace function menu.map_pos_item(p_outlet uuid, p_code text, p_menu_item uuid) returns void
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

create or replace function ops.expiry_alerts(p_now timestamptz default now()) returns int
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

revoke execute on function menu.pos_dishes(uuid) from public, platform_loader;
grant execute on function menu.pos_dishes(uuid) to app_rw;

-- migrate:down

revoke execute on function menu.pos_dishes(uuid) from app_rw;
drop function menu.pos_dishes(uuid);

create or replace function menu.map_pos_item(p_outlet uuid, p_code text, p_menu_item uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, menu
as $$
declare
  v_mo menu.menu_outlet;
begin
  if not exists (select 1 from menu.menu_outlet mo join core.hierarchy_node o on o.id = mo.org_node_id
                  where mo.org_node_id = p_outlet and o.tenant_id = core.my_tenant()
                    and core.can('SALES', 'modify', null, mo.delivery_node_id)) then
    raise exception 'NOT_AUTHORISED' using detail = format('modify SALES at %s', p_outlet);
  end if;
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
  if not core.can('SALES', 'modify', null, v_mo.delivery_node_id) then
    raise exception 'NOT_AUTHORISED' using detail = format('modify SALES at %s', v_mo.delivery_node_id);
  end if;
  insert into menu.pos_item (tenant_id, org_node_id, delivery_node_id, pos_code, menu_item_id)
  values (v_mo.tenant_id, p_outlet, v_mo.delivery_node_id, p_code, p_menu_item)
  on conflict (tenant_id, org_node_id, pos_code) do update
     set menu_item_id = excluded.menu_item_id, delivery_node_id = excluded.delivery_node_id;
end $$;

create or replace function ops.expiry_alerts(p_now timestamptz default now()) returns int
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
                             x.unit, to_char(x.first_expiry at time zone v_tz, 'Dy HH24:MI'),
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
