-- migrate:up
-- No assumed levels (ADR 009). Settings, geofences and stock sources are found by walking
-- up the tree from where the row sits, so they work whether a person's home is a
-- department or the outlet itself, and whether stock sits in a store or at a supply point.
--
--   core.nearest_ancestor(node, predicate kind)   the node itself or its nearest ancestor
--   hr.geofence_for(node)       the nearest node with a geofence (department -> outlet)
--   inv.wastage_threshold(node) the nearest wastage approval value (store -> supply point)
--   inv.transfer_sources(to)    stock locations only, same supply point first, then hubs
--   core.nodes()                also returns holds_stock, for the supply location picker

create function core.self_and_ancestors(p_node uuid)
returns table (id uuid, depth int)
language sql stable
set search_path = pg_catalog, core, extensions
as $$
  select a.id, nlevel(a.path)
    from core.hierarchy_node n
    join core.hierarchy_node a on a.path @> n.path and a.type = n.type and a.tenant_id = n.tenant_id
   where n.id = p_node
   order by nlevel(a.path) desc;
$$;
revoke execute on function core.self_and_ancestors(uuid) from public;

create function hr.geofence_for(p_node uuid) returns hr.node_setting
language sql stable
set search_path = pg_catalog, core, hr
as $$
  select s.* from core.self_and_ancestors(p_node) a
    join hr.node_setting s on s.org_node_id = a.id
   order by a.depth desc
   limit 1;
$$;
revoke execute on function hr.geofence_for(uuid) from public;

create function inv.wastage_threshold(p_node uuid) returns numeric
language sql stable security definer
set search_path = pg_catalog, core, inv
as $$
  select coalesce(
    (select s.wastage_approval_value from core.self_and_ancestors(p_node) a
       join inv.node_setting s on s.delivery_node_id = a.id
      order by a.depth desc limit 1),
    2000)
   where exists (select 1 from core.hierarchy_node where id = p_node and tenant_id = core.my_tenant());
$$;
revoke execute on function inv.wastage_threshold(uuid) from public;
grant execute on function inv.wastage_threshold(uuid) to app_rw;

-- hr.clock as in 20260930180000, with the geofence found by walking up from the home node.
create or replace function hr.clock(p_action text, p_lat numeric default null, p_lng numeric default null,
                         p_accuracy_m numeric default null, p_client_ts timestamptz default null,
                         p_source text default 'online', p_key text default null)
returns table (attendance_id uuid, clock_in_at timestamptz, clock_out_at timestamptz,
               shift_id uuid, inside boolean, distance_m numeric, flags text[])
language plpgsql security definer
set search_path = pg_catalog, core, hr
as $$
declare
  v_w hr.worker := hr.my_worker();
  v_at timestamptz;
  v_key text := coalesce(nullif(trim(p_key), ''), gen_random_uuid()::text);
  v_set hr.node_setting;
  v_dist numeric;
  v_inside boolean;
  v_att hr.attendance;
  v_shift uuid;
  v_flag text;
begin
  if p_action not in ('in', 'out') or p_source not in ('online', 'offline') then
    perform hr.fail('INVALID_ACTION', p_action || '/' || p_source);
  end if;
  if not core.can('ATTENDANCE', 'modify', v_w.org_node_id, null, v_w.owner_user_id) then
    perform hr.fail('NOT_AUTHORISED', 'cannot clock');
  end if;
  if (p_lat is null) <> (p_lng is null) or p_lat not between -90 and 90
     or p_lng not between -180 and 180 then
    perform hr.fail('INVALID_LOCATION');
  end if;

  -- Replays of the same punch (same device key) return the recorded result.
  select * into v_att from hr.attendance a
   where a.worker_id = v_w.id
     and ((p_action = 'in' and a.in_key = v_key) or (p_action = 'out' and a.out_key = v_key));
  if found then
    return query select v_att.id, v_att.clock_in_at, v_att.clock_out_at, v_att.shift_id,
      case p_action when 'in' then v_att.in_inside else v_att.out_inside end,
      case p_action when 'in' then v_att.in_distance_m else v_att.out_distance_m end,
      array(select e.kind from hr.attendance_exception e
             where e.attendance_id = v_att.id and e.phase = p_action order by e.kind);
    return;
  end if;

  if p_source = 'online' then
    v_at := now();
  elsif p_client_ts is null or p_client_ts > now() + interval '2 minutes'
        or p_client_ts < now() - interval '24 hours' then
    perform hr.fail('INVALID_TIMESTAMP', 'offline punches must be from the last 24 hours');
  else
    v_at := p_client_ts;
  end if;

  v_set := hr.geofence_for(v_w.org_node_id);
  if v_set.latitude is not null and p_lat is not null then
    v_dist := hr.distance_m(v_set.latitude, v_set.longitude, p_lat, p_lng);
    v_inside := v_dist <= v_set.geofence_radius_m;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hr.attendance:' || v_w.id, 0));
  if p_action = 'in' then
    if exists (select 1 from hr.attendance a where a.worker_id = v_w.id and a.clock_out_at is null) then
      perform hr.fail('ALREADY_CLOCKED_IN');
    end if;
    -- the worker's published shift this punch belongs to: from 2 h before start to its end
    select s.id into v_shift
      from hr.shift_assignment a join hr.shift s on s.id = a.shift_id and s.status = 'published'
     where a.worker_id = v_w.id and a.status = 'assigned'
       and v_at between a.start_at - interval '2 hours' and a.end_at
     order by abs(extract(epoch from a.start_at - v_at))
     limit 1;
    insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, shift_id,
                               clock_in_at, in_source, in_key, in_lat, in_lng, in_accuracy_m,
                               in_distance_m, in_inside)
    values (v_w.tenant_id, v_w.id, v_w.owner_user_id, v_w.org_node_id, v_shift, v_at, p_source,
            v_key, p_lat, p_lng, p_accuracy_m, v_dist, v_inside)
    returning * into v_att;
  else
    select * into v_att from hr.attendance a
     where a.worker_id = v_w.id and a.clock_out_at is null for update;
    if not found then
      perform hr.fail('NOT_CLOCKED_IN');
    end if;
    if v_at < v_att.clock_in_at then
      perform hr.fail('INVALID_TIMESTAMP', 'clock-out is before clock-in');
    end if;
    update hr.attendance a
       set clock_out_at = v_at, out_source = p_source, out_received_at = now(), out_key = v_key,
           out_lat = p_lat, out_lng = p_lng, out_accuracy_m = p_accuracy_m,
           out_distance_m = v_dist, out_inside = v_inside
     where a.id = v_att.id
    returning * into v_att;
  end if;

  if v_set.latitude is not null then
    v_flag := hr.flag_geo(v_att, p_action, v_inside, v_dist, v_set.geofence_radius_m);
  end if;
  return query select v_att.id, v_att.clock_in_at, v_att.clock_out_at, v_att.shift_id,
                      v_inside, v_dist, array_remove(array[v_flag], null);
end $$;

-- inv.record_wastage as in 20260930120000, with the threshold found by walking up.
create or replace function inv.record_wastage(p_node uuid, p_lines jsonb,
                                   p_idempotency_key text default null) returns uuid
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
  perform inv.require('STOCK_ADJUSTMENTS', 'modify', p_node);
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
                                  unit_cost, value, photo_key, outcome)
    values (v_me.tenant_id, v_w.id, v_line.item_id, p_node, v_line.qty, v_line.reason, v_cost,
            v_value, v_line.photo_key,
            case when v_value > v_threshold then 'approval' else 'posted' end);
  end loop;

  if jsonb_array_length(v_approval) > 0 then
    update inv.wastage
       set adjustment_id = inv.submit_adjustment(p_node, 'wastage', 'wastage', v_w.id, v_approval)
     where id = v_w.id;
  end if;
  return v_w.id;
end $$;

-- Where p_to can request stock from: the tenant's other stock locations that stock items,
-- stores of the same supply point first, then hubs (central kitchens), then the rest.
create or replace function inv.transfer_sources(p_to uuid)
returns table (id uuid, name text, kind text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
declare
  v_parent uuid;
begin
  perform wf.me();
  perform inv.require('TRANSFERS', 'modify', p_to);
  select h.parent_id into v_parent from core.hierarchy_node h where h.id = p_to;
  return query
    select n.id, n.name, n.kind from core.hierarchy_node n
     where n.tenant_id = core.my_tenant() and n.type = 'delivery' and n.archived_at is null
       and n.holds_stock and n.id <> p_to
       and exists (select 1 from inv.item_node i where i.delivery_node_id = n.id)
     -- stores of the same location first (its sibling stores, or the location itself),
     -- then hubs; sibling outlets are not a preferred source
     order by (n.id = v_parent or (n.kind = 'store' and n.parent_id = v_parent)) desc,
              (n.kind = 'hub') desc, n.name;
end $$;

-- core.nodes as in 20260929150000, plus holds_stock.
drop function core.nodes(text);
create function core.nodes(p_type text default null)
returns table (id uuid, type text, kind text, name text, parent_id uuid, depth int,
               timezone text, derived boolean, holds_stock boolean)
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  with me as (select * from core.me()),
  covered as (
    select n.id, false as derived
      from me
      join core.effective_access ea on ea.user_id = me.id
      join core.hierarchy_node n
        on n.tenant_id = me.tenant_id and n.type = ea.type and n.archived_at is null
       and (n.path = ea.path or (ea.include_descendants and ea.path @> n.path))
     where ea.domain not like 'DERIVED\_%'
    union
    select d.id, true
      from me
      join core.effective_access ea on ea.user_id = me.id and ea.type = 'org'
                                   and ea.domain like 'DERIVED\_%'
      join core.hierarchy_node o
        on o.tenant_id = me.tenant_id and o.type = 'org'
       and (o.path = ea.path or (ea.include_descendants and ea.path @> o.path))
      join core.node_link nl on nl.org_node_id = o.id
      join core.hierarchy_node d on d.id = nl.delivery_node_id and d.archived_at is null
  )
  select n.id, n.type, n.kind, n.name, n.parent_id, nlevel(n.path), n.timezone, bool_and(c.derived),
         n.holds_stock
    from covered c join core.hierarchy_node n on n.id = c.id
   where p_type is null or n.type = p_type
   group by n.id, n.type, n.kind, n.name, n.parent_id, n.path, n.timezone, n.holds_stock
   order by n.type desc, n.path;
$$;
revoke execute on function core.nodes(text) from public;
grant execute on function core.nodes(text) to app_rw;

-- migrate:down
drop function core.nodes(text);
create function core.nodes(p_type text default null)
returns table (id uuid, type text, kind text, name text, parent_id uuid, depth int,
               timezone text, derived boolean)
language sql stable security definer
set search_path = pg_catalog, core, extensions
as $$
  with me as (select * from core.me()),
  covered as (
    select n.id, false as derived
      from me
      join core.effective_access ea on ea.user_id = me.id
      join core.hierarchy_node n
        on n.tenant_id = me.tenant_id and n.type = ea.type and n.archived_at is null
       and (n.path = ea.path or (ea.include_descendants and ea.path @> n.path))
     where ea.domain not like 'DERIVED\_%'
    union
    select d.id, true
      from me
      join core.effective_access ea on ea.user_id = me.id and ea.type = 'org'
                                   and ea.domain like 'DERIVED\_%'
      join core.hierarchy_node o
        on o.tenant_id = me.tenant_id and o.type = 'org'
       and (o.path = ea.path or (ea.include_descendants and ea.path @> o.path))
      join core.node_link nl on nl.org_node_id = o.id
      join core.hierarchy_node d on d.id = nl.delivery_node_id and d.archived_at is null
  )
  select n.id, n.type, n.kind, n.name, n.parent_id, nlevel(n.path), n.timezone, bool_and(c.derived)
    from covered c join core.hierarchy_node n on n.id = c.id
   where p_type is null or n.type = p_type
   group by n.id, n.type, n.kind, n.name, n.parent_id, n.path, n.timezone
   order by n.type desc, n.path;
$$;
revoke execute on function core.nodes(text) from public;
grant execute on function core.nodes(text) to app_rw;

create or replace function inv.transfer_sources(p_to uuid)
returns table (id uuid, name text, kind text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, wf
as $$
begin
  perform wf.me();
  perform inv.require('TRANSFERS', 'modify', p_to);
  return query
    select n.id, n.name, n.kind from core.hierarchy_node n
     where n.tenant_id = core.my_tenant() and n.type = 'delivery' and n.archived_at is null
       and n.id <> p_to and exists (select 1 from inv.item_node i where i.delivery_node_id = n.id)
     order by (n.kind = 'hub') desc, n.name;
end $$;

-- hr.clock and inv.record_wastage: back to exact-node lookups by editing their one line
-- (same bodies otherwise), then the helpers go.
do $$
declare
  v_src text;
begin
  v_src := pg_get_functiondef('hr.clock(text, numeric, numeric, numeric, timestamptz, text, text)'::regprocedure);
  execute replace(v_src, 'v_set := hr.geofence_for(v_w.org_node_id);',
                  'select * into v_set from hr.node_setting where org_node_id = v_w.org_node_id;');
  v_src := pg_get_functiondef('inv.record_wastage(uuid, jsonb, text)'::regprocedure);
  execute replace(v_src, 'v_threshold := inv.wastage_threshold(p_node);',
                  'v_threshold := coalesce((select wastage_approval_value from inv.node_setting where delivery_node_id = p_node), 2000);');
end $$;
drop function inv.wastage_threshold(uuid);
drop function hr.geofence_for(uuid);
drop function core.self_and_ancestors(uuid);
