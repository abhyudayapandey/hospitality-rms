-- migrate:up

-- Vendor bills (BIL-1 to BIL-3, ADR 050). A bill is one to five photos or PDFs with the
-- supplier, bill number, date and amount. Every bill sits at a store (a delivery node), like
-- the orders it pays for:
--   goods    a bill for an order: at the order's store, attached by whoever may receive it
--            (the store's keepers, or the Main Store's keeper for a supply request)
--   service  linen washing, pest control, repairs: no stock, recorded at a store the person
--            keeps (the Main Store for the outlet's own services, the Housekeeping Store for
--            linen), with what it was for
-- Access is the new BILLS domain (delivery tree): the GM and store keepers add (modify), the
-- cost controller and the hub manager read (view). Bills are never deleted; a wrong one is
-- archived with a reason. Kept 7 years (money data, NFR Data retention).

create table inv.bill (
  id uuid primary key default core.uuid_v7(),
  delivery_node_id uuid not null references core.hierarchy_node(id),
  kind text not null check (kind in ('goods', 'service')),
  po_id uuid references inv.purchase_order(id),
  supplier_id uuid references inv.supplier(id),
  supplier_name text check (supplier_name is null or length(supplier_name) between 1 and 120),
  bill_no text check (bill_no is null or length(bill_no) between 1 and 60),
  bill_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'INR',
  description text check (description is null or length(description) between 1 and 300),
  files text[] not null check (cardinality(files) between 1 and 5),
  archived_at timestamptz,
  archived_by uuid references core.app_user(id),
  archive_reason text check (archive_reason is null or length(archive_reason) between 1 and 300),
  idempotency_key text,
  check ((kind = 'goods') = (po_id is not null)),
  check (supplier_id is not null or supplier_name is not null),
  check (kind = 'goods' or description is not null)
);
select core.add_standard_columns('inv.bill');
alter table inv.bill add constraint bill_idem unique (tenant_id, created_by, idempotency_key);
create index bill_node_date on inv.bill (delivery_node_id, bill_date desc);
create index bill_po on inv.bill (po_id) where po_id is not null;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Whether the caller may see a bill: BILLS view at its store, or, for a goods bill, whoever
-- sees or places its order (the store's people and the order desk).
create function inv.can_see_bill(p_bill uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select exists (
    select 1 from inv.bill b
     where b.id = p_bill and b.tenant_id = core.my_tenant()
       and (core.can('BILLS', 'view', null, b.delivery_node_id)
            or (b.po_id is not null
                and (core.can('PURCHASE_ORDERS', 'view', null, b.delivery_node_id)
                     or inv.can_place(b.po_id)))));
$$;
revoke execute on function inv.can_see_bill(uuid) from public;
grant execute on function inv.can_see_bill(uuid) to app_rw;

-- The store a new bill goes to, or NOT_AUTHORISED. For an order (p_po): the order's store,
-- for anyone who may add bills there or receive it (the order desk, ADR 049); the order must
-- have been ordered. Otherwise p_node, where the caller needs BILLS modify.
create function inv.bill_place(p_node uuid, p_po uuid default null) returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, core, inv
as $$
declare
  v_po inv.purchase_order;
begin
  if p_po is null then
    perform inv.require('BILLS', 'modify', p_node);
    if not coalesce((select holds_stock from core.hierarchy_node where id = p_node), false) then
      perform inv.fail('NOT_A_STOCK_LOCATION', p_node::text);
    end if;
    return p_node;
  end if;
  select * into v_po from inv.purchase_order where id = p_po and tenant_id = core.my_tenant();
  if not found
     or not (core.can('BILLS', 'modify', null, v_po.delivery_node_id)
             or core.can('PURCHASE_ORDERS', 'modify', null, v_po.delivery_node_id)
             or inv.can_place(p_po)) then
    perform inv.fail('NOT_AUTHORISED', 'bill for order ' || p_po);
  end if;
  if v_po.status <> 'released' or v_po.ordered_at is null then
    perform inv.fail('INVALID_STATE', 'the order has not been placed');
  end if;
  return v_po.delivery_node_id;
end $$;
revoke execute on function inv.bill_place(uuid, uuid) from public;
grant execute on function inv.bill_place(uuid, uuid) to app_rw;

-- Records a bill. For an order (p_po) the supplier defaults to the order's; a service bill
-- needs a supplier from the list or a name, and what it was for. p_files are the uploaded
-- keys, bills/<tenant>/<store>/<uuid>.<jpg|png|webp|pdf>. A replay (same key) returns the
-- bill already recorded.
create function inv.add_bill(p_node uuid, p_po uuid, p_supplier uuid, p_supplier_name text,
                             p_bill_no text, p_bill_date date, p_amount numeric,
                             p_description text, p_files text[], p_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_node uuid;
  v_id uuid;
  v_supplier uuid := p_supplier;
  v_name text := nullif(trim(p_supplier_name), '');
  v_desc text := nullif(trim(p_description), '');
  v_file text;
begin
  if p_key is not null then
    select id into v_id from inv.bill
     where tenant_id = v_me.tenant_id and created_by = v_me.id and idempotency_key = p_key;
    if found then return v_id; end if;
  end if;
  v_node := inv.bill_place(p_node, p_po);

  if p_po is not null and v_supplier is null then
    select supplier_id into v_supplier from inv.purchase_order where id = p_po;
  end if;
  if v_supplier is not null then
    if not exists (select 1 from inv.supplier where id = v_supplier
                    and tenant_id = v_me.tenant_id and archived_at is null) then
      perform inv.fail('INVALID_SUPPLIER', v_supplier::text);
    end if;
    v_name := null;
  elsif v_name is null or length(v_name) > 120 then
    perform inv.fail('INVALID_SUPPLIER', 'name the supplier');
  end if;
  if p_po is null and (v_desc is null or length(v_desc) > 300) then
    perform inv.fail('INVALID_BILL', 'say what the bill is for');
  end if;
  if p_bill_date is null or p_bill_date > current_date + 1
     or p_bill_date < current_date - interval '400 days' then
    perform inv.fail('INVALID_BILL', 'bill date');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 1e12 then
    perform inv.fail('INVALID_BILL', 'amount');
  end if;
  if length(trim(p_bill_no)) > 60 then
    perform inv.fail('INVALID_BILL', 'bill number');
  end if;
  if p_files is null or cardinality(p_files) not between 1 and 5
     or cardinality(p_files) <> (select count(distinct f) from unnest(p_files) f) then
    perform inv.fail('INVALID_FILE', 'one to five files');
  end if;
  foreach v_file in array p_files loop
    if v_file !~ format('^bills/%s/%s/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$', v_me.tenant_id, v_node) then
      perform inv.fail('INVALID_FILE', v_file);
    end if;
  end loop;

  insert into inv.bill (tenant_id, delivery_node_id, kind, po_id, supplier_id, supplier_name,
                        bill_no, bill_date, amount, description, files, idempotency_key)
  values (v_me.tenant_id, v_node, case when p_po is null then 'service' else 'goods' end, p_po,
          v_supplier, v_name, nullif(trim(p_bill_no), ''), p_bill_date, round(p_amount, 2),
          v_desc, p_files, p_key)
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function inv.add_bill(uuid, uuid, uuid, text, text, date, numeric, text, text[], text) from public;
grant execute on function inv.add_bill(uuid, uuid, uuid, text, text, date, numeric, text, text[], text) to app_rw;

-- Archives a wrong bill (a bill is never deleted): whoever added it, or BILLS modify at its
-- store, with a reason.
create function inv.archive_bill(p_bill uuid, p_reason text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_b inv.bill;
begin
  select * into v_b from inv.bill where id = p_bill and tenant_id = v_me.tenant_id for update;
  if not found
     or not (v_b.created_by = v_me.id or core.can('BILLS', 'modify', null, v_b.delivery_node_id)) then
    perform inv.fail('NOT_AUTHORISED', 'archive bill');
  end if;
  if v_b.archived_at is not null then
    perform inv.fail('INVALID_STATE', 'already archived');
  end if;
  if nullif(trim(p_reason), '') is null or length(trim(p_reason)) > 300 then
    perform inv.fail('INVALID_BILL', 'give a reason');
  end if;
  update inv.bill set archived_at = now(), archived_by = v_me.id, archive_reason = trim(p_reason)
   where id = p_bill;
end $$;
revoke execute on function inv.archive_bill(uuid, text) from public;
grant execute on function inv.archive_bill(uuid, text) to app_rw;

-- One bill with its files, for whoever may see it (inv.can_see_bill); none otherwise.
create function inv.bill_detail(p_bill uuid)
returns table (id uuid, store_id uuid, store text, kind text, po_id uuid, supplier text,
               bill_no text, bill_date date, amount numeric, currency text, description text,
               files text[], added_by text, added_at timestamptz, archived_at timestamptz,
               archive_reason text, can_archive boolean)
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select b.id, b.delivery_node_id, core.node_name(b.delivery_node_id), b.kind, b.po_id,
         coalesce(s.name, b.supplier_name), b.bill_no, b.bill_date, b.amount, b.currency,
         b.description, b.files, u.display_name, b.created_at, b.archived_at, b.archive_reason,
         b.archived_at is null
           and (b.created_by = core.current_user_id()
                or core.can('BILLS', 'modify', null, b.delivery_node_id))
    from inv.bill b
    left join inv.supplier s on s.id = b.supplier_id
    left join core.app_user u on u.id = b.created_by
   where b.id = p_bill and inv.can_see_bill(p_bill);
$$;
revoke execute on function inv.bill_detail(uuid) from public;
grant execute on function inv.bill_detail(uuid) to app_rw;

-- The bills of one order (not archived), for whoever sees or places it.
create function inv.po_bills(p_po uuid)
returns table (id uuid, bill_no text, bill_date date, amount numeric, files integer,
               added_by text, added_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select b.id, b.bill_no, b.bill_date, b.amount, cardinality(b.files), u.display_name, b.created_at
    from inv.bill b
    left join core.app_user u on u.id = b.created_by
   where b.po_id = p_po and b.tenant_id = core.my_tenant() and b.archived_at is null
     and inv.can_see_bill(b.id)
   order by b.created_at;
$$;
revoke execute on function inv.po_bills(uuid) from public;
grant execute on function inv.po_bills(uuid) to app_rw;

-- The Bills screen's places: stores where the caller holds BILLS (view).
do $$
declare
  v_def text := pg_get_functiondef('core.screen_places(text)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def, $a$'team_people', 'team_leave', 'pos_import', 'check') then$a$,
                          $a$'team_people', 'team_leave', 'pos_import', 'check', 'bills') then$a$);
  v_new := replace(v_new, $a$                           'production', 'check') then$a$,
                          $a$                           'production', 'check', 'bills') then$a$);
  v_new := replace(v_new, $a$             when 'check' then core.can('STOCK_CHECK', 'view', null, n.id)$a$,
                          $a$             when 'check' then core.can('STOCK_CHECK', 'view', null, n.id)
             when 'bills' then core.can('BILLS', 'view', null, n.id)$a$);
  if length(v_new) - length(v_def) < 70 then
    raise exception 'core.screen_places did not take the bills screen';
  end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- RLS registration (rule 1), audit (rule 5)
-- ---------------------------------------------------------------------------
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('inv.bill', 'BILLS', 'delivery', true);
select core.apply_domain_rls('inv.bill');
select audit.enable('inv.bill');

-- migrate:down
do $$
declare
  v_def text := pg_get_functiondef('core.screen_places(text)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def, $a$, 'check', 'bills') then$a$, $a$, 'check') then$a$);
  v_new := replace(v_new, E'             when ''bills'' then core.can(''BILLS'', ''view'', null, n.id)\n', '');
  execute v_new;
end $$;
drop function inv.po_bills(uuid);
drop function inv.bill_detail(uuid);
drop function inv.archive_bill(uuid, text);
drop function inv.add_bill(uuid, uuid, uuid, text, text, date, numeric, text, text[], text);
drop function inv.bill_place(uuid, uuid);
drop function inv.can_see_bill(uuid);
delete from core.domain_table where table_name::text = 'inv.bill';
drop table inv.bill;
