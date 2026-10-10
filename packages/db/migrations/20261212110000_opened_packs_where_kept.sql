-- migrate:up
-- Opened packs (ADR 093, 097): the screen is offered only at stores that keep something with a
-- shelf life once opened (or still have a pack open), and what may be opened there is read
-- through inv.pack_items, which checks SHELF_LIFE at the store, so a commis who opens packs
-- (duty OPENS_PACKS) needs no stock access to see the list.

create function inv.pack_items(p_store uuid)
returns table (item_id uuid, name text, base_uom text, hours int, on_hand numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
#variable_conflict use_column
begin
  if not core.can('SHELF_LIFE', 'view', null, p_store) then
    perform inv.fail('NOT_AUTHORISED', 'SHELF_LIFE view');
  end if;
  return query
    select i.id, i.name, i.base_uom, i.open_shelf_life_hours, coalesce(s.on_hand, 0)
      from inv.item_node x
      join inv.item i on i.id = x.item_id
      left join inv.stock_level s
        on s.item_id = x.item_id and s.delivery_node_id = x.delivery_node_id
     where x.delivery_node_id = p_store and x.archived_at is null
       and i.archived_at is null and i.open_shelf_life_hours is not null
       and i.tenant_id = core.my_tenant()
     order by i.name;
end $$;

revoke execute on function inv.pack_items(uuid) from public, platform_loader;
grant execute on function inv.pack_items(uuid) to app_rw;

select core.patch_function('core.screen_places(text)',
$x$             when 'opened' then core.can('SHELF_LIFE', 'view', null, n.id)$x$,
$x$             when 'opened' then core.can('SHELF_LIFE', 'view', null, n.id)
               and (exists (select 1 from inv.item_node x
                              join inv.item i on i.id = x.item_id
                             where x.delivery_node_id = n.id and x.archived_at is null
                               and i.archived_at is null
                               and i.open_shelf_life_hours is not null)
                    or exists (select 1 from inv.opened_pack p
                                where p.delivery_node_id = n.id and p.status = 'open'))$x$);

-- migrate:down
select core.patch_function('core.screen_places(text)',
$x$             when 'opened' then core.can('SHELF_LIFE', 'view', null, n.id)
               and (exists (select 1 from inv.item_node x
                              join inv.item i on i.id = x.item_id
                             where x.delivery_node_id = n.id and x.archived_at is null
                               and i.archived_at is null
                               and i.open_shelf_life_hours is not null)
                    or exists (select 1 from inv.opened_pack p
                                where p.delivery_node_id = n.id and p.status = 'open'))$x$,
$x$             when 'opened' then core.can('SHELF_LIFE', 'view', null, n.id)$x$);
drop function inv.pack_items(uuid);
