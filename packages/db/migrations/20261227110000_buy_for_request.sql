-- migrate:up
-- The Main Store buys for the stores that ask it (ADR 141). A store short of something the
-- Main Store doesn't keep (limes, mint, ice) still asks the Main Store (inv.source_for); when its
-- keeper buys what is short (inv.order_for_request), the Main Store now starts keeping the item
-- (par 0, the asking store's usual supplier), so the order, its receipt and the send that follows
-- all work. Before, the order was refused (INVALID_ITEM) and the request was stuck.

do $$
declare
  v_def text := pg_get_functiondef('inv.order_for_request(uuid,jsonb)'::regprocedure);
  v_new text := replace(v_def,
    $o$  perform inv.check_lines(v_lines, v_t.from_node_id);$o$,
    $n$  -- what the Main Store doesn't keep yet, it keeps from now on, to buy it for the store
  insert into inv.item_node (tenant_id, item_id, delivery_node_id, par_level,
                             preferred_supplier_id)
  select v_me.tenant_id, l.item_id, v_t.from_node_id, 0, x.preferred_supplier_id
    from jsonb_to_recordset(v_lines) as l(item_id uuid, qty numeric)
    join inv.item i on i.id = l.item_id and i.tenant_id = v_me.tenant_id
    left join inv.item_node x on x.item_id = l.item_id and x.delivery_node_id = v_t.to_node_id
  on conflict (tenant_id, item_id, delivery_node_id)
    do update set archived_at = null where inv.item_node.archived_at is not null;
  perform inv.check_lines(v_lines, v_t.from_node_id);$n$);
begin
  if v_new = v_def then
    raise exception 'order_for_request did not change as expected';
  end if;
  execute v_new;
end $$;

-- migrate:down
do $$
declare
  v_def text := pg_get_functiondef('inv.order_for_request(uuid,jsonb)'::regprocedure);
  v_from int := position('  -- what the Main Store doesn''t keep yet' in v_def);
  v_to int := position('  perform inv.check_lines(v_lines, v_t.from_node_id);' in v_def);
begin
  execute substr(v_def, 1, v_from - 1) || substr(v_def, v_to);
end $$;
