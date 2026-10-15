-- migrate:up
-- Running low is one rule, in one place (KI-05, extends ADR 141 and ADR 034). An item at a store
-- is running low when either is true:
--   * it is under its par (ADR 141), or
--   * it lasts 3 days or fewer at what the store used over the last 14 days (ADR 034), par or no
--     par. Durable things (glasses, linen; ADR 076) have no days on hand, so only par counts.
-- Each item counts once. Home's counts, the department tiles and the Stock screen's Running low
-- tab all read it through these two functions (apps/web/lib/low-stock.ts mirrors the rule for
-- the words on each line).

-- What went out of a store over the last 14 days: use, sales, transfers out, wastage; not the
-- corrections of a count. Security invoker: the ledger's RLS decides what it sums.
create function inv.recent_use(p_item uuid, p_node uuid) returns numeric
language sql stable security invoker set search_path = '' as $$
  select coalesce(-sum(l.qty), 0)
    from inv.stock_ledger l
   where l.item_id = p_item and l.delivery_node_id = p_node
     and l.qty < 0 and l.movement_type <> 'count_adjust'
     and l.occurred_at > now() - interval '14 days'
$$;

create function inv.running_low(p_on_hand numeric, p_par numeric, p_used numeric,
                                p_durable boolean default false) returns boolean
language sql immutable set search_path = '' as $$
  select (coalesce(p_par, 0) > 0 and coalesce(p_on_hand, 0) < p_par)
      or (not coalesce(p_durable, false) and coalesce(p_used, 0) > 0
          and greatest(coalesce(p_on_hand, 0), 0) * 14 / p_used <= 3)
$$;

grant execute on function inv.recent_use(uuid, uuid), inv.running_low(numeric, numeric, numeric, boolean)
  to app_rw, wf_executor;

-- migrate:down
drop function inv.running_low(numeric, numeric, numeric, boolean);
drop function inv.recent_use(uuid, uuid);
