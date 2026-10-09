-- migrate:up

-- ADR 083: asking another store for stock lists what that store keeps. From the Main Store,
-- what it may give (inv.sendable_items, as before); from any other store, the items both
-- stores keep (a store asks only for what it uses). No source, nothing. Each line says what
-- the asking store has and its par there (ADR 053); never what the other store has, which
-- the asker may not see.
drop function inv.request_items(uuid, uuid);
create function inv.request_items(p_to uuid, p_from uuid)
returns table (item_id uuid, name text, base_uom text, on_hand numeric, avg_cost numeric,
               item_group text, par_level numeric)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
begin
  perform wf.me();
  perform inv.require('TRANSFERS', 'modify', p_to);
  if p_from is null
     or not exists (select 1 from inv.transfer_sources(p_to) src where src.id = p_from) then
    return;
  end if;
  return query
    select i.id, i.name, i.base_uom, coalesce(s.on_hand, 0), coalesce(s.avg_cost, 0),
           inv.item_group(i.id, p_to), coalesce(t.par_level, 0)
      from inv.item i
      left join inv.item_node t on t.item_id = i.id and t.delivery_node_id = p_to
                               and t.archived_at is null
      left join inv.stock_level s on s.item_id = i.id and s.delivery_node_id = p_to
     where i.tenant_id = core.my_tenant() and i.archived_at is null
       and case when inv.is_main_store(p_from)
                then exists (select 1 from inv.sendable_items(p_from, p_to) x
                              where x.item_id = i.id)
                else t.item_id is not null
                     and exists (select 1 from inv.item_node f
                                  where f.item_id = i.id and f.delivery_node_id = p_from
                                    and f.archived_at is null)
           end
     order by inv.own_group(inv.item_group(i.id, p_to), p_to) desc, i.name;
end $$;
revoke execute on function inv.request_items(uuid, uuid) from public;
grant execute on function inv.request_items(uuid, uuid) to app_rw;

-- migrate:down
drop function inv.request_items(uuid, uuid);
create function inv.request_items(p_to uuid, p_from uuid)
returns table (item_id uuid, name text, base_uom text, on_hand numeric, avg_cost numeric,
               item_group text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
begin
  perform wf.me();
  perform inv.require('TRANSFERS', 'modify', p_to);
  return query
    select i.id, i.name, i.base_uom, coalesce(s.on_hand, 0), coalesce(s.avg_cost, 0),
           inv.item_group(i.id, p_to)
      from inv.item i
      left join inv.stock_level s on s.item_id = i.id and s.delivery_node_id = p_to
     where i.tenant_id = core.my_tenant() and i.archived_at is null
       and (exists (select 1 from inv.item_node n where n.item_id = i.id
                     and n.delivery_node_id = p_to and n.archived_at is null)
            or (p_from is not null and inv.is_main_store(p_from)
                and exists (select 1 from inv.transfer_sources(p_to) src where src.id = p_from)
                and exists (select 1 from inv.sendable_items(p_from, p_to) x
                             where x.item_id = i.id)))
     order by inv.own_group(inv.item_group(i.id, p_to), p_to) desc, i.name;
end $$;
revoke execute on function inv.request_items(uuid, uuid) from public;
grant execute on function inv.request_items(uuid, uuid) to app_rw;
