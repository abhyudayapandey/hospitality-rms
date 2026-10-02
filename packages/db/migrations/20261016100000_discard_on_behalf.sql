-- migrate:up
-- An over-limit discard of an expired batch is submitted in the lead's name (ADR 020), but
-- the commis threw the batch away. Record them on the request and in the audit log
-- (ADR 021).

-- The person a system action was done for: set (with actor_kind 'system') while the system
-- writes in someone else's name. Null for everything else.
alter table audit.log add column for_user_id uuid;

create or replace function audit.capture() returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changed text[];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);

  select array_agg(k order by k) into v_changed
    from (select jsonb_object_keys(coalesce(v_new, '{}')) as k
          union
          select jsonb_object_keys(coalesce(v_old, '{}'))) keys
   where (v_old -> k) is distinct from (v_new -> k);

  if tg_nargs > 0 and tg_argv[0] = 'names_only' then
    v_old := null;
    v_new := null;
  end if;

  insert into audit.log (tenant_id, actor_id, actor_kind, table_name, row_id, op,
                         before, after, changed_fields, granting_node_id, request_id,
                         for_user_id)
  values (coalesce((v_row ->> 'tenant_id')::uuid,
                   case when tg_table_schema = 'core' and tg_table_name = 'tenant'
                        then (v_row ->> 'id')::uuid end),
          core.current_user_id(),
          coalesce(nullif(current_setting('app.actor_kind', true), ''), 'human'),
          tg_table_schema || '.' || tg_table_name,
          (v_row ->> 'id')::uuid,
          tg_op,
          v_old, v_new, v_changed,
          nullif(current_setting('app.granting_node', true), '')::uuid,
          nullif(current_setting('app.wf_request', true), '')::uuid,
          nullif(current_setting('app.for_user', true), '')::uuid);
  return coalesce(new, old);
end $$;

-- p_payload goes on the workflow request (wf.submit keeps it as given, less the nodes).
create function inv.submit_adjustment(p_node uuid, p_reason text, p_source_type text,
                                      p_source_id uuid, p_lines jsonb, p_payload jsonb)
returns uuid
language plpgsql
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_adj inv.stock_adjustment;
  v_request uuid;
begin
  insert into inv.stock_adjustment (tenant_id, delivery_node_id, reason, source_type, source_id,
                                    amount)
  select core.my_tenant(), p_node, p_reason, p_source_type, p_source_id,
         round(sum(abs((l ->> 'qty')::numeric) * (l ->> 'unit_cost')::numeric), 2)
    from jsonb_array_elements(p_lines) l
  returning * into v_adj;
  insert into inv.stock_adjustment_line (tenant_id, adjustment_id, item_id, delivery_node_id,
                                         movement_type, qty, unit_cost, reason, photo_key)
  select v_adj.tenant_id, v_adj.id, (l ->> 'item_id')::uuid, p_node, l ->> 'movement_type',
         (l ->> 'qty')::numeric, (l ->> 'unit_cost')::numeric, l ->> 'reason', l ->> 'photo_key'
    from jsonb_array_elements(p_lines) l;
  v_request := wf.submit('STOCK_ADJUSTMENT', 'inv.stock_adjustment', v_adj.id, coalesce(p_payload, '{}'));
  update inv.stock_adjustment set status = 'submitted', wf_request_id = v_request
   where id = v_adj.id;
  return v_adj.id;
end $$;
revoke execute on function inv.submit_adjustment(uuid, text, text, uuid, jsonb, jsonb) from public;

create or replace function inv.submit_adjustment(p_node uuid, p_reason text, p_source_type text,
                                                 p_source_id uuid, p_lines jsonb) returns uuid
language sql
set search_path = pg_catalog, core, inv, wf
as $$
  select inv.submit_adjustment(p_node, p_reason, p_source_type, p_source_id, p_lines, '{}');
$$;

-- As in 20261015100000, plus: a request submitted for someone else carries who recorded the
-- wastage (recorded_by, recorded_by_name, task_id), and its audit rows say the system sent
-- it in the submitter's name for them.
create or replace function inv.post_wastage(p_node uuid, p_lines jsonb, p_idempotency_key text,
                                 p_task uuid, p_submitter uuid) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_w inv.wastage;
  v_threshold numeric;
  v_line record;
  v_cost numeric;
  v_value numeric;
  v_approval jsonb := '[]';
  v_photo_re text;
  v_payload jsonb := '{}';
  v_kind text;
begin
  if p_idempotency_key is not null then
    select * into v_w from inv.wastage
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_w.id; end if;
  end if;
  perform inv.check_lines(p_lines, p_node);
  v_threshold := inv.wastage_threshold(p_node);
  v_photo_re := format('^wastage/%s/%s/[0-9a-f-]{36}\.(jpg|png|webp)$', v_me.tenant_id, p_node);

  insert into inv.wastage (tenant_id, delivery_node_id, idempotency_key)
  values (v_me.tenant_id, p_node, p_idempotency_key) returning * into v_w;

  for v_line in select * from jsonb_to_recordset(p_lines)
                  as l(item_id uuid, qty numeric, reason text, photo_key text) loop
    if v_line.qty is null or v_line.qty <= 0 then
      perform inv.fail('INVALID_QUANTITY', 'wastage quantity must be positive');
    end if;
    if v_line.reason is null
       or v_line.reason not in ('expired', 'spoiled', 'prep_error', 'damaged', 'other') then
      perform inv.fail('INVALID_LINES', 'unknown wastage reason');
    end if;
    if v_line.photo_key is not null and v_line.photo_key !~ v_photo_re then
      perform inv.fail('INVALID_PHOTO', 'photo was not uploaded for this location');
    end if;
    if inv.on_hand(v_line.item_id, p_node) < v_line.qty then
      perform inv.fail('INSUFFICIENT_STOCK', format('item %s', v_line.item_id));
    end if;
    v_cost := inv.avg_cost(v_line.item_id, p_node);
    v_value := round(v_line.qty * v_cost, 2);

    if v_value > v_threshold then
      if v_line.photo_key is null then
        perform inv.fail('PHOTO_REQUIRED', format('wastage worth %s needs a photo', v_value));
      end if;
      v_approval := v_approval || jsonb_build_object(
        'item_id', v_line.item_id, 'movement_type', 'wastage', 'qty', -v_line.qty,
        'unit_cost', v_cost, 'reason', v_line.reason, 'photo_key', v_line.photo_key);
    else
      perform inv.post(v_line.item_id, p_node, 'wastage', -v_line.qty, v_cost, 'wastage',
                       v_w.id, v_line.reason);
    end if;
    insert into inv.wastage_line (tenant_id, wastage_id, item_id, delivery_node_id, qty, reason,
                                  unit_cost, value, photo_key, outcome, task_id)
    values (v_me.tenant_id, v_w.id, v_line.item_id, p_node, v_line.qty, v_line.reason, v_cost,
            v_value, v_line.photo_key,
            case when v_value > v_threshold then 'approval' else 'posted' end, p_task);
  end loop;

  if jsonb_array_length(v_approval) > 0 then
    if p_submitter is not null and p_submitter <> v_me.id then
      -- The request is from the submitter (the lead who decided the batch goes), sent by
      -- the system for the person who threw it away: the request says so, and every
      -- audit row it writes has actor = the lead, kind 'system', for_user_id = them.
      v_payload := jsonb_build_object('recorded_by', v_me.id,
                                      'recorded_by_name', v_me.display_name,
                                      'task_id', p_task);
      v_kind := current_setting('app.actor_kind', true);
      perform set_config('app.user_id', p_submitter::text, true);
      perform set_config('app.actor_kind', 'system', true);
      perform set_config('app.for_user', v_me.id::text, true);
    end if;
    update inv.wastage
       set adjustment_id = inv.submit_adjustment(p_node, 'wastage', 'wastage', v_w.id, v_approval,
                                                 v_payload)
     where id = v_w.id;
    perform set_config('app.user_id', v_me.id::text, true);
    perform set_config('app.actor_kind', coalesce(v_kind, ''), true);
    perform set_config('app.for_user', '', true);
  end if;
  return v_w.id;
end $$;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
create or replace function inv.post_wastage(p_node uuid, p_lines jsonb, p_idempotency_key text,
                                 p_task uuid, p_submitter uuid) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_w inv.wastage;
  v_threshold numeric;
  v_line record;
  v_cost numeric;
  v_value numeric;
  v_approval jsonb := '[]';
  v_photo_re text;
begin
  if p_idempotency_key is not null then
    select * into v_w from inv.wastage
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_w.id; end if;
  end if;
  perform inv.check_lines(p_lines, p_node);
  v_threshold := inv.wastage_threshold(p_node);
  v_photo_re := format('^wastage/%s/%s/[0-9a-f-]{36}\.(jpg|png|webp)$', v_me.tenant_id, p_node);

  insert into inv.wastage (tenant_id, delivery_node_id, idempotency_key)
  values (v_me.tenant_id, p_node, p_idempotency_key) returning * into v_w;

  for v_line in select * from jsonb_to_recordset(p_lines)
                  as l(item_id uuid, qty numeric, reason text, photo_key text) loop
    if v_line.qty is null or v_line.qty <= 0 then
      perform inv.fail('INVALID_QUANTITY', 'wastage quantity must be positive');
    end if;
    if v_line.reason is null
       or v_line.reason not in ('expired', 'spoiled', 'prep_error', 'damaged', 'other') then
      perform inv.fail('INVALID_LINES', 'unknown wastage reason');
    end if;
    if v_line.photo_key is not null and v_line.photo_key !~ v_photo_re then
      perform inv.fail('INVALID_PHOTO', 'photo was not uploaded for this location');
    end if;
    if inv.on_hand(v_line.item_id, p_node) < v_line.qty then
      perform inv.fail('INSUFFICIENT_STOCK', format('item %s', v_line.item_id));
    end if;
    v_cost := inv.avg_cost(v_line.item_id, p_node);
    v_value := round(v_line.qty * v_cost, 2);

    if v_value > v_threshold then
      if v_line.photo_key is null then
        perform inv.fail('PHOTO_REQUIRED', format('wastage worth %s needs a photo', v_value));
      end if;
      v_approval := v_approval || jsonb_build_object(
        'item_id', v_line.item_id, 'movement_type', 'wastage', 'qty', -v_line.qty,
        'unit_cost', v_cost, 'reason', v_line.reason, 'photo_key', v_line.photo_key);
    else
      perform inv.post(v_line.item_id, p_node, 'wastage', -v_line.qty, v_cost, 'wastage',
                       v_w.id, v_line.reason);
    end if;
    insert into inv.wastage_line (tenant_id, wastage_id, item_id, delivery_node_id, qty, reason,
                                  unit_cost, value, photo_key, outcome, task_id)
    values (v_me.tenant_id, v_w.id, v_line.item_id, p_node, v_line.qty, v_line.reason, v_cost,
            v_value, v_line.photo_key,
            case when v_value > v_threshold then 'approval' else 'posted' end, p_task);
  end loop;

  if jsonb_array_length(v_approval) > 0 then
    -- the request is from the submitter (the lead who decided the batch goes)
    if p_submitter is not null and p_submitter <> v_me.id then
      perform set_config('app.user_id', p_submitter::text, true);
    end if;
    update inv.wastage
       set adjustment_id = inv.submit_adjustment(p_node, 'wastage', 'wastage', v_w.id, v_approval)
     where id = v_w.id;
    perform set_config('app.user_id', v_me.id::text, true);
  end if;
  return v_w.id;
end $$;

create or replace function inv.submit_adjustment(p_node uuid, p_reason text, p_source_type text,
                                                 p_source_id uuid, p_lines jsonb) returns uuid
language plpgsql
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_adj inv.stock_adjustment;
  v_request uuid;
begin
  insert into inv.stock_adjustment (tenant_id, delivery_node_id, reason, source_type, source_id,
                                    amount)
  select core.my_tenant(), p_node, p_reason, p_source_type, p_source_id,
         round(sum(abs((l ->> 'qty')::numeric) * (l ->> 'unit_cost')::numeric), 2)
    from jsonb_array_elements(p_lines) l
  returning * into v_adj;
  insert into inv.stock_adjustment_line (tenant_id, adjustment_id, item_id, delivery_node_id,
                                         movement_type, qty, unit_cost, reason, photo_key)
  select v_adj.tenant_id, v_adj.id, (l ->> 'item_id')::uuid, p_node, l ->> 'movement_type',
         (l ->> 'qty')::numeric, (l ->> 'unit_cost')::numeric, l ->> 'reason', l ->> 'photo_key'
    from jsonb_array_elements(p_lines) l;
  v_request := wf.submit('STOCK_ADJUSTMENT', 'inv.stock_adjustment', v_adj.id);
  update inv.stock_adjustment set status = 'submitted', wf_request_id = v_request
   where id = v_adj.id;
  return v_adj.id;
end $$;
drop function inv.submit_adjustment(uuid, text, text, uuid, jsonb, jsonb);
create or replace function audit.capture() returns trigger
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changed text[];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);

  select array_agg(k order by k) into v_changed
    from (select jsonb_object_keys(coalesce(v_new, '{}')) as k
          union
          select jsonb_object_keys(coalesce(v_old, '{}'))) keys
   where (v_old -> k) is distinct from (v_new -> k);

  if tg_nargs > 0 and tg_argv[0] = 'names_only' then
    v_old := null;
    v_new := null;
  end if;

  insert into audit.log (tenant_id, actor_id, actor_kind, table_name, row_id, op,
                         before, after, changed_fields, granting_node_id, request_id)
  values (coalesce((v_row ->> 'tenant_id')::uuid,
                   case when tg_table_schema = 'core' and tg_table_name = 'tenant'
                        then (v_row ->> 'id')::uuid end),
          core.current_user_id(),
          coalesce(nullif(current_setting('app.actor_kind', true), ''), 'human'),
          tg_table_schema || '.' || tg_table_name,
          (v_row ->> 'id')::uuid,
          tg_op,
          v_old, v_new, v_changed,
          nullif(current_setting('app.granting_node', true), '')::uuid,
          nullif(current_setting('app.wf_request', true), '')::uuid);
  return coalesce(new, old);
end $$;

alter table audit.log drop column for_user_id;
