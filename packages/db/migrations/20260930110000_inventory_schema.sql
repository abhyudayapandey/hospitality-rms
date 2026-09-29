-- migrate:up
-- Inventory, orders and transfers: tables (docs/LLD.md sections 2 and 5, ADR 006).
-- Business functions are in the next migration. Every table here:
--   * has the standard columns, the audit trigger and generated RLS (rule 1)
--   * is read-only for app_rw (rpc_only): writes go through SECURITY DEFINER RPCs that
--     check core.can() (rule 2) or through the executor (rule 4)
-- Stock only changes by inserting inv.stock_ledger rows (rule 3); a trigger keeps the
-- inv.stock_level cache, rejects negative on-hand and makes the ledger append-only.

-- ---------------------------------------------------------------------------
-- Catalogue registration mode (items, suppliers: rows without a node)
-- ---------------------------------------------------------------------------

alter table core.domain_table
  add column catalog boolean not null default false,
  add constraint domain_table_catalog check (
    not catalog or (domain_code is not null and rpc_only and not tenant_scoped));

-- The current active user's tenant (null when there is none).
create function core.my_tenant() returns uuid
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select tenant_id from core.app_user where id = core.current_user_id() and status = 'active';
$$;

-- Does the current user hold p_access on p_domain at any node (view also through the
-- DERIVED_ domain)? For catalogue rows only; node-bound rows always use core.can().
create function core.can_any(p_domain text, p_access text) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select p_access in ('view', 'modify') and exists (
    select 1 from core.effective_access ea
     where ea.user_id = core.current_user_id()
       and ((ea.domain = p_domain and (ea.access = 'modify' or p_access = 'view'))
            or (p_access = 'view' and ea.domain = 'DERIVED_' || p_domain)));
$$;
grant execute on function core.my_tenant(), core.can_any(text, text) to app_rw, wf_executor;

create or replace function core.apply_domain_rls(p_table regclass) returns void
language plpgsql as $$
declare
  v_dt core.domain_table;
  v_cols text[];
  v_col text;
  v_owner text;
  v_has_wf boolean;
  v_pol record;
  v_view_dom text;          -- SQL for the view domain: a literal code or a column
  v_mod_dom text;           -- SQL for the modify domain
  v_legs text[] := '{}';    -- can() node arguments per leg: '<org>, <delivery>'
  v_labels text[] := '{}';  -- policy name suffix per leg
  v_view_expr text := '';
  v_mod_expr text;
begin
  select * into v_dt from core.domain_table where table_name = p_table;
  if not found then
    raise exception 'DOMAIN_TABLE_NOT_REGISTERED' using detail = p_table::text;
  end if;

  v_owner := coalesce(v_dt.owner_column,
                      case when core.has_column(p_table, 'owner_user_id') then 'owner_user_id' end);
  if v_owner is not null and not core.has_column(p_table, v_owner) then
    raise exception 'OWNER_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_owner);
  end if;
  v_has_wf := core.has_column(p_table, 'wf_request_id');

  -- Catalogue rows (items, suppliers): no node; readable by anyone in the tenant who
  -- holds view on the domain (or its DERIVED_ domain) at some node. Both checks are
  -- scalar subqueries, so they run once per query, not once per row. Writes: RPCs only.
  if v_dt.catalog then
    for v_pol in select polname from pg_policy
                  where polrelid = p_table and polname like 'dom\_%' loop
      execute format('drop policy %I on %s', v_pol.polname, p_table);
    end loop;
    execute format('alter table %s enable row level security', p_table);
    execute format('revoke all on %s from app_rw, wf_executor', p_table);
    execute format(
      'create policy dom_select on %s for select to app_rw using '
      '(tenant_id = (select core.my_tenant()) and (select core.can_any(%L, ''view'')))',
      p_table, v_dt.domain_code);
    execute format('grant select on %s to app_rw', p_table);
    return;
  end if;

  if v_dt.domain_column is not null then
    -- Per-row domain: can() picks org or delivery node by the row's domain tree.
    foreach v_col in array array[v_dt.domain_column, 'org_node_id', 'delivery_node_id'] loop
      if not core.has_column(p_table, v_col) then
        raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_col);
      end if;
    end loop;
    v_view_dom := quote_ident(v_dt.domain_column);
    v_mod_dom := v_view_dom;
    v_legs := array['org_node_id, delivery_node_id'];
    v_labels := array['row'];
  else
    v_view_dom := quote_literal(v_dt.domain_code);
    v_mod_dom := quote_literal(coalesce(v_dt.modify_domain_code, v_dt.domain_code));
    if v_dt.tenant_scoped then
      -- Tenant-wide rows (no node): checked at the tenant's org root, like audit.log.
      if not core.has_column(p_table, 'tenant_id') then
        raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.tenant_id', p_table);
      end if;
      v_legs := array['core.org_root(tenant_id), null'];
      v_labels := array['tenant'];
    else
      v_cols := coalesce(v_dt.node_columns, case v_dt.hierarchy_type
        when 'org' then array['org_node_id']
        when 'delivery' then array['delivery_node_id']
        else array[]::text[] end);
      foreach v_col in array v_cols loop
        if not core.has_column(p_table, v_col) then
          raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_col);
        end if;
        v_legs := v_legs || case v_dt.hierarchy_type
          when 'org' then format('%I, null', v_col)
          when 'delivery' then format('null, %I', v_col)
          else 'null, null' end;
        v_labels := v_labels || v_col;
      end loop;
      if cardinality(v_legs) = 0 then
        if v_owner is null then
          raise exception 'OWNER_COLUMN_MISSING' using detail = p_table::text;
        end if;
        v_legs := array['null, null'];
        v_labels := array['owner'];
      end if;
    end if;
  end if;

  -- Drop previously generated policies so this is idempotent.
  for v_pol in select polname from pg_policy
                where polrelid = p_table and polname like 'dom\_%' loop
    execute format('drop policy %I on %s', v_pol.polname, p_table);
  end loop;

  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from app_rw, wf_executor', p_table);

  for i in 1 .. cardinality(v_legs) loop
    v_view_expr := v_view_expr || case when i > 1 then ' or ' else '' end
      || format('core.can(%s, ''view'', %s, %s)', v_view_dom, v_legs[i], coalesce(quote_ident(v_owner), 'null'));
    v_mod_expr := format('core.can(%s, ''modify'', %s, %s)', v_mod_dom, v_legs[i], coalesce(quote_ident(v_owner), 'null'));
    if not v_dt.rpc_only then
      execute format('create policy %I on %s for insert to app_rw with check (%s)',
                     'dom_insert_' || v_labels[i], p_table, v_mod_expr);
      if not v_dt.insert_only and not v_has_wf then
        execute format('create policy %I on %s for update to app_rw using (%s) with check (%s)',
                       'dom_update_' || v_labels[i], p_table, v_mod_expr, v_mod_expr);
      end if;
    end if;
  end loop;

  execute format('create policy dom_select on %s for select to app_rw using (%s)', p_table, v_view_expr);
  execute format('grant select on %s to app_rw', p_table);
  if not v_dt.rpc_only then
    execute format('grant insert on %s to app_rw', p_table);
    if not v_dt.insert_only and not v_has_wf then
      execute format('grant update on %s to app_rw', p_table);
    end if;
  end if;

  if v_has_wf then
    execute format('create policy dom_exec_select on %s for select to wf_executor using (true)', p_table);
    execute format('create policy dom_exec_update on %s for update to wf_executor using (true) with check (true)', p_table);
    execute format('grant select, update on %s to wf_executor', p_table);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Catalogue and per-node settings
-- ---------------------------------------------------------------------------

create table inv.item (
  id uuid primary key default core.uuid_v7(),
  sku text not null,
  name text not null,
  category text not null,
  base_uom text not null,                      -- kg, l, pcs ... quantities are in this unit
  is_perishable boolean not null default false,
  archived_at timestamptz
);
select core.add_standard_columns('inv.item');
alter table inv.item add constraint item_sku_key unique (tenant_id, sku);

create table inv.supplier (
  id uuid primary key default core.uuid_v7(),
  name text not null,
  lead_time_days int not null default 1 check (lead_time_days >= 0),
  contact text,
  archived_at timestamptz
);
select core.add_standard_columns('inv.supplier');
alter table inv.supplier add constraint supplier_name_key unique (tenant_id, name);

create table inv.item_node (
  id uuid primary key default core.uuid_v7(),
  item_id uuid not null references inv.item(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  par_level numeric(14,3) not null default 0 check (par_level >= 0),
  reorder_qty numeric(14,3) not null default 0 check (reorder_qty >= 0),
  preferred_supplier_id uuid references inv.supplier(id),
  -- count variance within this (absolute, base UOM) posts directly; beyond it needs approval
  count_tolerance_qty numeric(14,3) not null default 0 check (count_tolerance_qty >= 0),
  archived_at timestamptz
);
select core.add_standard_columns('inv.item_node');
alter table inv.item_node add constraint item_node_key unique (tenant_id, item_id, delivery_node_id);

-- Per-node settings. No row = defaults.
create table inv.node_setting (
  id uuid primary key default core.uuid_v7(),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  -- a wastage line worth more than this needs a photo and outlet approval
  wastage_approval_value numeric(14,2) not null default 2000 check (wastage_approval_value >= 0),
  currency text not null default 'INR'
);
select core.add_standard_columns('inv.node_setting');
alter table inv.node_setting add constraint node_setting_key unique (tenant_id, delivery_node_id);

-- ---------------------------------------------------------------------------
-- Ledger and on-hand cache
-- ---------------------------------------------------------------------------

create table inv.stock_ledger (
  id uuid primary key default core.uuid_v7(),
  item_id uuid not null references inv.item(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  movement_type text not null check (movement_type in
    ('receipt', 'consumption', 'wastage', 'transfer_out', 'transfer_in', 'count_adjust')),
  qty numeric(14,3) not null check (qty <> 0),          -- signed, base UOM
  unit_cost numeric(14,4) not null default 0,           -- set by the trigger when omitted
  currency text not null default 'INR',
  reason text,                                          -- wastage reason, transit_loss, ...
  ref_type text not null,                               -- purchase_order, goods_receipt, ...
  ref_id uuid,
  occurred_at timestamptz not null default now(),
  check ((movement_type in ('receipt', 'transfer_in') and qty > 0)
      or (movement_type in ('consumption', 'wastage', 'transfer_out') and qty < 0)
      or movement_type = 'count_adjust')
);
select core.add_standard_columns('inv.stock_ledger');
create index stock_ledger_node_time on inv.stock_ledger (delivery_node_id, occurred_at desc);
create index stock_ledger_item_node_time on inv.stock_ledger (item_id, delivery_node_id, occurred_at desc);
create index stock_ledger_ref on inv.stock_ledger (ref_type, ref_id);

-- Cache of sum(qty) per item and node, kept in the same transaction as each ledger
-- insert (ADR 006: a trigger-maintained table instead of the LLD's materialised view).
create table inv.stock_level (
  id uuid primary key default core.uuid_v7(),
  item_id uuid not null references inv.item(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  on_hand numeric(14,3) not null default 0 check (on_hand >= 0),
  avg_cost numeric(14,4) not null default 0,            -- weighted average
  value numeric(14,2) not null default 0,
  currency text not null default 'INR',
  last_movement_at timestamptz
);
select core.add_standard_columns('inv.stock_level');
alter table inv.stock_level add constraint stock_level_key unique (item_id, delivery_node_id);
create index stock_level_node on inv.stock_level (delivery_node_id);

-- ---------------------------------------------------------------------------
-- Counts, adjustments, wastage (STOCK_ADJUSTMENTS)
-- ---------------------------------------------------------------------------

create table inv.stock_count (
  id uuid primary key default core.uuid_v7(),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  status text not null default 'open' check (status in ('open', 'submitted')),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  adjustment_id uuid,                                   -- lines beyond tolerance, if any
  idempotency_key text
);
select core.add_standard_columns('inv.stock_count');
alter table inv.stock_count add constraint stock_count_idem unique (tenant_id, created_by, idempotency_key);

create table inv.stock_count_line (
  id uuid primary key default core.uuid_v7(),
  count_id uuid not null references inv.stock_count(id),
  item_id uuid not null references inv.item(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  system_qty numeric(14,3) not null,                    -- snapshot at start_count
  counted_qty numeric(14,3) check (counted_qty >= 0),
  unit_cost numeric(14,4) not null default 0,
  outcome text check (outcome in ('no_change', 'posted', 'approval')),
  unique (count_id, item_id)
);
select core.add_standard_columns('inv.stock_count_line');

-- Workflow subject for STOCK_ADJUSTMENT: count variance beyond tolerance, wastage above
-- the value threshold, or supplier excess on a goods receipt.
create table inv.stock_adjustment (
  id uuid primary key default core.uuid_v7(),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  reason text not null check (reason in ('count_variance', 'wastage', 'supplier_excess')),
  source_type text not null,                            -- stock_count, wastage, goods_receipt
  source_id uuid not null,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'posted', 'rejected', 'cancelled')),
  amount numeric(14,2) not null default 0,              -- absolute value of the lines
  currency text not null default 'INR',
  wf_request_id uuid references wf.request(id),
  posted_at timestamptz
);
select core.add_standard_columns('inv.stock_adjustment');

create table inv.stock_adjustment_line (
  id uuid primary key default core.uuid_v7(),
  adjustment_id uuid not null references inv.stock_adjustment(id),
  item_id uuid not null references inv.item(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  movement_type text not null check (movement_type in ('count_adjust', 'wastage', 'receipt')),
  qty numeric(14,3) not null check (qty <> 0),
  unit_cost numeric(14,4) not null default 0,
  reason text,
  photo_key text
);
select core.add_standard_columns('inv.stock_adjustment_line');

create table inv.wastage (
  id uuid primary key default core.uuid_v7(),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  recorded_at timestamptz not null default now(),
  adjustment_id uuid references inv.stock_adjustment(id),   -- lines above the threshold
  idempotency_key text
);
select core.add_standard_columns('inv.wastage');
alter table inv.wastage add constraint wastage_idem unique (tenant_id, created_by, idempotency_key);

create table inv.wastage_line (
  id uuid primary key default core.uuid_v7(),
  wastage_id uuid not null references inv.wastage(id),
  item_id uuid not null references inv.item(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  qty numeric(14,3) not null check (qty > 0),
  reason text not null check (reason in ('expired', 'spoiled', 'prep_error', 'damaged', 'other')),
  unit_cost numeric(14,4) not null default 0,
  value numeric(14,2) not null default 0,
  photo_key text,
  outcome text not null check (outcome in ('posted', 'approval'))
);
select core.add_standard_columns('inv.wastage_line');

-- ---------------------------------------------------------------------------
-- Purchase orders and goods receipts (PURCHASE_ORDERS)
-- ---------------------------------------------------------------------------

-- status only moves through the workflow: draft -> submitted (wf.submit) -> released |
-- rejected | cancelled (executor). Receipt progress is computed from the receipts.
create table inv.purchase_order (
  id uuid primary key default core.uuid_v7(),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  supplier_id uuid not null references inv.supplier(id),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'released', 'rejected', 'cancelled')),
  total numeric(14,2) not null default 0,
  currency text not null default 'INR',
  notes text,
  wf_request_id uuid references wf.request(id),
  released_at timestamptz,
  idempotency_key text
);
select core.add_standard_columns('inv.purchase_order');
alter table inv.purchase_order add constraint purchase_order_idem unique (tenant_id, created_by, idempotency_key);

create table inv.purchase_order_line (
  id uuid primary key default core.uuid_v7(),
  po_id uuid not null references inv.purchase_order(id),
  item_id uuid not null references inv.item(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  qty numeric(14,3) not null check (qty > 0),
  unit_cost numeric(14,4) not null check (unit_cost >= 0),
  unique (po_id, item_id)
);
select core.add_standard_columns('inv.purchase_order_line');

create table inv.goods_receipt (
  id uuid primary key default core.uuid_v7(),
  po_id uuid not null references inv.purchase_order(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  received_at timestamptz not null default now(),
  excess_adjustment_id uuid references inv.stock_adjustment(id),
  idempotency_key text
);
select core.add_standard_columns('inv.goods_receipt');
alter table inv.goods_receipt add constraint goods_receipt_idem unique (tenant_id, created_by, idempotency_key);

create table inv.goods_receipt_line (
  id uuid primary key default core.uuid_v7(),
  receipt_id uuid not null references inv.goods_receipt(id),
  po_line_id uuid not null references inv.purchase_order_line(id),
  item_id uuid not null references inv.item(id),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  qty numeric(14,3) not null check (qty >= 0),           -- posted as receipt (within the cap)
  excess_qty numeric(14,3) not null default 0 check (excess_qty >= 0),  -- to approval
  unit_cost numeric(14,4) not null check (unit_cost >= 0)
);
select core.add_standard_columns('inv.goods_receipt_line');

-- ---------------------------------------------------------------------------
-- Transfers (TRANSFERS, two node legs)
-- ---------------------------------------------------------------------------

-- status: draft -> submitted (wf.submit) -> completed | rejected | cancelled (executor).
-- dispatched_at set = in transit until received_at.
create table inv.transfer (
  id uuid primary key default core.uuid_v7(),
  from_node_id uuid not null references core.hierarchy_node(id),
  to_node_id uuid not null references core.hierarchy_node(id),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'completed', 'rejected', 'cancelled')),
  wf_request_id uuid references wf.request(id),
  dispatched_at timestamptz,
  dispatched_by uuid references core.app_user(id),
  received_at timestamptz,
  received_by uuid references core.app_user(id),
  idempotency_key text,
  check (from_node_id <> to_node_id)
);
select core.add_standard_columns('inv.transfer');
alter table inv.transfer add constraint transfer_idem unique (tenant_id, created_by, idempotency_key);

create table inv.transfer_line (
  id uuid primary key default core.uuid_v7(),
  transfer_id uuid not null references inv.transfer(id),
  item_id uuid not null references inv.item(id),
  from_node_id uuid not null references core.hierarchy_node(id),
  to_node_id uuid not null references core.hierarchy_node(id),
  requested_qty numeric(14,3) not null check (requested_qty > 0),
  dispatched_qty numeric(14,3) check (dispatched_qty >= 0),
  received_qty numeric(14,3) check (received_qty >= 0),
  unit_cost numeric(14,4),                               -- hub average at dispatch
  unique (transfer_id, item_id)
);
select core.add_standard_columns('inv.transfer_line');

-- ---------------------------------------------------------------------------
-- Ledger rules
-- ---------------------------------------------------------------------------

create function inv.ledger_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'LEDGER_APPEND_ONLY'
    using detail = 'inv.stock_ledger rows are never updated or deleted; post a correcting movement';
end $$;
create trigger append_only before update or delete on inv.stock_ledger
  for each row execute function inv.ledger_append_only();
create trigger append_only_truncate before truncate on inv.stock_ledger
  for each statement execute function inv.ledger_append_only();

-- Applies a ledger row to the cache. Serialised per item and node, so concurrent
-- movements cannot both pass the check. Outflows and count adjustments are valued at the
-- current weighted average; receipts and transfers in recompute it.
create function inv.ledger_apply() returns trigger
language plpgsql security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_level inv.stock_level;
  v_on_hand numeric;
  v_avg numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.item_id::text || new.delivery_node_id::text, 0));
  select * into v_level from inv.stock_level
   where item_id = new.item_id and delivery_node_id = new.delivery_node_id;
  v_on_hand := coalesce(v_level.on_hand, 0) + new.qty;
  if v_on_hand < 0 then
    raise exception 'INSUFFICIENT_STOCK'
      using detail = format('item %s at node %s: %s on hand, movement %s',
                            new.item_id, new.delivery_node_id, coalesce(v_level.on_hand, 0), new.qty);
  end if;

  v_avg := coalesce(v_level.avg_cost, 0);
  if new.movement_type in ('receipt', 'transfer_in') then
    v_avg := case when v_on_hand = 0 then new.unit_cost
                  else (coalesce(v_level.on_hand, 0) * v_avg + new.qty * new.unit_cost) / v_on_hand end;
  elsif new.unit_cost = 0 then
    new.unit_cost := v_avg;
  end if;

  insert into inv.stock_level (tenant_id, item_id, delivery_node_id, on_hand, avg_cost, value,
                               currency, last_movement_at)
  values (new.tenant_id, new.item_id, new.delivery_node_id, v_on_hand, round(v_avg, 4),
          round(v_on_hand * v_avg, 2), new.currency, new.occurred_at)
  on conflict (item_id, delivery_node_id) do update
     set on_hand = excluded.on_hand, avg_cost = excluded.avg_cost, value = excluded.value,
         last_movement_at = greatest(inv.stock_level.last_movement_at, excluded.last_movement_at);
  return new;
end $$;
revoke execute on function inv.ledger_apply() from public;
create trigger apply before insert on inv.stock_ledger
  for each row execute function inv.ledger_apply();

-- ---------------------------------------------------------------------------
-- RLS registration (rule 1) and audit (rule 5)
-- ---------------------------------------------------------------------------

insert into core.domain_table (table_name, domain_code, hierarchy_type, catalog, rpc_only) values
  ('inv.item', 'STOCK_LEVELS', 'delivery', true, true),
  ('inv.supplier', 'PURCHASE_ORDERS', 'delivery', true, true);
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only, insert_only) values
  ('inv.item_node', 'STOCK_LEVELS', 'delivery', true, false),
  ('inv.node_setting', 'STOCK_LEVELS', 'delivery', true, false),
  ('inv.stock_ledger', 'STOCK_LEVELS', 'delivery', true, true),
  ('inv.stock_level', 'STOCK_LEVELS', 'delivery', true, false),
  ('inv.stock_count', 'STOCK_ADJUSTMENTS', 'delivery', true, false),
  ('inv.stock_count_line', 'STOCK_ADJUSTMENTS', 'delivery', true, false),
  ('inv.stock_adjustment', 'STOCK_ADJUSTMENTS', 'delivery', true, false),
  ('inv.stock_adjustment_line', 'STOCK_ADJUSTMENTS', 'delivery', true, false),
  ('inv.wastage', 'STOCK_ADJUSTMENTS', 'delivery', true, false),
  ('inv.wastage_line', 'STOCK_ADJUSTMENTS', 'delivery', true, false),
  ('inv.purchase_order', 'PURCHASE_ORDERS', 'delivery', true, false),
  ('inv.purchase_order_line', 'PURCHASE_ORDERS', 'delivery', true, false),
  ('inv.goods_receipt', 'PURCHASE_ORDERS', 'delivery', true, false),
  ('inv.goods_receipt_line', 'PURCHASE_ORDERS', 'delivery', true, false);
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only, node_columns) values
  ('inv.transfer', 'TRANSFERS', 'delivery', true, array['from_node_id', 'to_node_id']),
  ('inv.transfer_line', 'TRANSFERS', 'delivery', true, array['from_node_id', 'to_node_id']);

do $$
declare t regclass;
begin
  for t in select table_name from core.domain_table
            where table_name::text like 'inv.%' loop
    perform core.apply_domain_rls(t);
    -- stock_level changes on every movement: record names only (the ledger has the values)
    perform audit.enable(t, t = 'inv.stock_level'::regclass);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Workflow subject resolvers (ADR 006): wf.submit reads nodes and amount from here
-- ---------------------------------------------------------------------------

create function inv.po_subject(p_id uuid) returns wf.subject_info
language sql stable
set search_path = pg_catalog, inv
as $$
  select tenant_id, null::uuid, delivery_node_id, null::uuid, null::uuid, total, currency,
         status = 'draft' and wf_request_id is null
    from inv.purchase_order where id = p_id;
$$;

create function inv.adjustment_subject(p_id uuid) returns wf.subject_info
language sql stable
set search_path = pg_catalog, inv
as $$
  select tenant_id, null::uuid, delivery_node_id, null::uuid, null::uuid, amount, currency,
         status = 'draft' and wf_request_id is null
    from inv.stock_adjustment where id = p_id;
$$;

-- The request's delivery node is the receiving side (who initiates); from/to for routing.
create function inv.transfer_subject(p_id uuid) returns wf.subject_info
language sql stable
set search_path = pg_catalog, inv
as $$
  select tenant_id, null::uuid, to_node_id, from_node_id, to_node_id, null::numeric, null::text,
         status = 'draft' and wf_request_id is null
    from inv.transfer where id = p_id;
$$;
revoke execute on function inv.po_subject(uuid), inv.adjustment_subject(uuid),
  inv.transfer_subject(uuid) from public;

insert into core.subject_resolver (subject_type, resolver) values
  ('inv.purchase_order', 'inv.po_subject(uuid)'),
  ('inv.stock_adjustment', 'inv.adjustment_subject(uuid)'),
  ('inv.transfer', 'inv.transfer_subject(uuid)');

-- migrate:down
delete from core.subject_resolver
 where subject_type in ('inv.purchase_order', 'inv.stock_adjustment', 'inv.transfer');
drop function inv.po_subject(uuid);
drop function inv.adjustment_subject(uuid);
drop function inv.transfer_subject(uuid);
delete from core.domain_table where table_name::text like 'inv.%';
drop table inv.transfer_line, inv.transfer, inv.goods_receipt_line, inv.goods_receipt,
  inv.purchase_order_line, inv.purchase_order, inv.wastage_line, inv.wastage,
  inv.stock_adjustment_line, inv.stock_adjustment, inv.stock_count_line, inv.stock_count,
  inv.stock_level, inv.stock_ledger, inv.node_setting, inv.item_node, inv.supplier, inv.item;
drop function inv.ledger_apply();
drop function inv.ledger_append_only();
create or replace function core.apply_domain_rls(p_table regclass) returns void
language plpgsql as $$
declare
  v_dt core.domain_table;
  v_cols text[];
  v_col text;
  v_owner text;
  v_has_wf boolean;
  v_pol record;
  v_view_dom text;          -- SQL for the view domain: a literal code or a column
  v_mod_dom text;           -- SQL for the modify domain
  v_legs text[] := '{}';    -- can() node arguments per leg: '<org>, <delivery>'
  v_labels text[] := '{}';  -- policy name suffix per leg
  v_view_expr text := '';
  v_mod_expr text;
begin
  select * into v_dt from core.domain_table where table_name = p_table;
  if not found then
    raise exception 'DOMAIN_TABLE_NOT_REGISTERED' using detail = p_table::text;
  end if;

  v_owner := coalesce(v_dt.owner_column,
                      case when core.has_column(p_table, 'owner_user_id') then 'owner_user_id' end);
  if v_owner is not null and not core.has_column(p_table, v_owner) then
    raise exception 'OWNER_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_owner);
  end if;
  v_has_wf := core.has_column(p_table, 'wf_request_id');

  if v_dt.domain_column is not null then
    -- Per-row domain: can() picks org or delivery node by the row's domain tree.
    foreach v_col in array array[v_dt.domain_column, 'org_node_id', 'delivery_node_id'] loop
      if not core.has_column(p_table, v_col) then
        raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_col);
      end if;
    end loop;
    v_view_dom := quote_ident(v_dt.domain_column);
    v_mod_dom := v_view_dom;
    v_legs := array['org_node_id, delivery_node_id'];
    v_labels := array['row'];
  else
    v_view_dom := quote_literal(v_dt.domain_code);
    v_mod_dom := quote_literal(coalesce(v_dt.modify_domain_code, v_dt.domain_code));
    if v_dt.tenant_scoped then
      -- Tenant-wide rows (no node): checked at the tenant's org root, like audit.log.
      if not core.has_column(p_table, 'tenant_id') then
        raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.tenant_id', p_table);
      end if;
      v_legs := array['core.org_root(tenant_id), null'];
      v_labels := array['tenant'];
    else
      v_cols := coalesce(v_dt.node_columns, case v_dt.hierarchy_type
        when 'org' then array['org_node_id']
        when 'delivery' then array['delivery_node_id']
        else array[]::text[] end);
      foreach v_col in array v_cols loop
        if not core.has_column(p_table, v_col) then
          raise exception 'NODE_COLUMN_MISSING' using detail = format('%s.%s', p_table, v_col);
        end if;
        v_legs := v_legs || case v_dt.hierarchy_type
          when 'org' then format('%I, null', v_col)
          when 'delivery' then format('null, %I', v_col)
          else 'null, null' end;
        v_labels := v_labels || v_col;
      end loop;
      if cardinality(v_legs) = 0 then
        if v_owner is null then
          raise exception 'OWNER_COLUMN_MISSING' using detail = p_table::text;
        end if;
        v_legs := array['null, null'];
        v_labels := array['owner'];
      end if;
    end if;
  end if;

  -- Drop previously generated policies so this is idempotent.
  for v_pol in select polname from pg_policy
                where polrelid = p_table and polname like 'dom\_%' loop
    execute format('drop policy %I on %s', v_pol.polname, p_table);
  end loop;

  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from app_rw, wf_executor', p_table);

  for i in 1 .. cardinality(v_legs) loop
    v_view_expr := v_view_expr || case when i > 1 then ' or ' else '' end
      || format('core.can(%s, ''view'', %s, %s)', v_view_dom, v_legs[i], coalesce(quote_ident(v_owner), 'null'));
    v_mod_expr := format('core.can(%s, ''modify'', %s, %s)', v_mod_dom, v_legs[i], coalesce(quote_ident(v_owner), 'null'));
    if not v_dt.rpc_only then
      execute format('create policy %I on %s for insert to app_rw with check (%s)',
                     'dom_insert_' || v_labels[i], p_table, v_mod_expr);
      if not v_dt.insert_only and not v_has_wf then
        execute format('create policy %I on %s for update to app_rw using (%s) with check (%s)',
                       'dom_update_' || v_labels[i], p_table, v_mod_expr, v_mod_expr);
      end if;
    end if;
  end loop;

  execute format('create policy dom_select on %s for select to app_rw using (%s)', p_table, v_view_expr);
  execute format('grant select on %s to app_rw', p_table);
  if not v_dt.rpc_only then
    execute format('grant insert on %s to app_rw', p_table);
    if not v_dt.insert_only and not v_has_wf then
      execute format('grant update on %s to app_rw', p_table);
    end if;
  end if;

  if v_has_wf then
    execute format('create policy dom_exec_select on %s for select to wf_executor using (true)', p_table);
    execute format('create policy dom_exec_update on %s for update to wf_executor using (true) with check (true)', p_table);
    execute format('grant select, update on %s to wf_executor', p_table);
  end if;
end $$;
drop function core.can_any(text, text);
drop function core.my_tenant();
alter table core.domain_table drop constraint domain_table_catalog, drop column catalog;
