-- migrate:up

-- Offline wastage keeps the time it happened (INV-8, ADR 043). A phone with no signal in
-- the cold room queues the entry; when it syncs, the ledger rows carry the original time
-- (up to 24 hours old), so the day's figures and the business day stay right.
--
-- inv.post reads an optional transaction-local "app.occurred_at"; only inv.record_wastage_at
-- sets it, and clears it again before returning.
create or replace function inv.post(p_item uuid, p_node uuid, p_type text, p_qty numeric,
                                    p_unit_cost numeric, p_ref_type text, p_ref_id uuid,
                                    p_reason text default null) returns void
language sql
set search_path = pg_catalog, core, inv
as $$
  insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                unit_cost, reason, ref_type, ref_id, occurred_at)
  select tenant_id, p_item, p_node, p_type, p_qty, coalesce(p_unit_cost, 0), p_reason,
         p_ref_type, p_ref_id,
         coalesce(nullif(current_setting('app.occurred_at', true), '')::timestamptz, now())
    from core.hierarchy_node where id = p_node;
$$;

-- Same as inv.record_wastage, for an entry made at p_at (at most 24 hours ago and not in
-- the future). A repeat with the same key returns the first result.
create function inv.record_wastage_at(p_node uuid, p_lines jsonb, p_idempotency_key text,
                                      p_at timestamptz) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_id uuid;
begin
  if p_at is null or p_at > now() + interval '5 minutes' or p_at < now() - interval '24 hours' then
    perform inv.fail('INVALID_TIME', 'wastage can be saved up to 24 hours late');
  end if;
  perform set_config('app.occurred_at', p_at::text, true);
  v_id := inv.record_wastage(p_node, p_lines, p_idempotency_key);
  perform set_config('app.occurred_at', '', true);
  update inv.wastage set recorded_at = p_at where id = v_id and recorded_at > p_at;
  return v_id;
end $$;
revoke execute on function inv.record_wastage_at(uuid, jsonb, text, timestamptz) from public;
grant execute on function inv.record_wastage_at(uuid, jsonb, text, timestamptz) to app_rw;

-- migrate:down
drop function inv.record_wastage_at(uuid, jsonb, text, timestamptz);
create or replace function inv.post(p_item uuid, p_node uuid, p_type text, p_qty numeric,
                                    p_unit_cost numeric, p_ref_type text, p_ref_id uuid,
                                    p_reason text default null) returns void
language sql
set search_path = pg_catalog, core, inv
as $$
  insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                unit_cost, reason, ref_type, ref_id)
  select tenant_id, p_item, p_node, p_type, p_qty, coalesce(p_unit_cost, 0), p_reason,
         p_ref_type, p_ref_id
    from core.hierarchy_node where id = p_node;
$$;
