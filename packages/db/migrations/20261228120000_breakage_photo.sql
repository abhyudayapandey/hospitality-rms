-- migrate:up
-- A breakage takes a photo of what broke (ADR 143): from the live camera, stored like a
-- wastage photo (wastage/<tenant>/<store>/...), shown in the breakage log.

alter table inv.breakage add column photo_key text;

drop function inv.record_breakage(uuid, uuid, uuid, numeric, text, text, uuid, text, text);
create function inv.record_breakage(p_place uuid, p_store uuid, p_item uuid, p_qty numeric,
                                    p_reason text, p_broken_by text, p_person uuid,
                                    p_note text, p_idempotency_key text default null,
                                    p_photo_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_me core.app_user := wf.me();
  v_id uuid;
  v_cost numeric;
begin
  if p_idempotency_key is not null then
    select id into v_id from inv.breakage
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if v_id is not null then return v_id; end if;
  end if;
  if not exists (select 1 from core.hierarchy_node
                  where id = p_place and tenant_id = v_me.tenant_id and type = 'org'
                    and kind = 'department' and archived_at is null)
     or not core.can('BREAKAGE', 'modify', p_place, null) then
    perform inv.fail('NOT_AUTHORISED', 'BREAKAGE modify');
  end if;
  if not exists (select 1 from core.hierarchy_node s
                  where s.id = p_store and s.tenant_id = v_me.tenant_id and s.type = 'delivery'
                    and s.holds_stock and s.archived_at is null)
     or core.nearest(ops.team_of_store(p_store), array['outlet'])
        is distinct from core.nearest(p_place, array['outlet']) then
    perform inv.fail('NOT_FOUND', 'that store is not at this outlet');
  end if;
  if not exists (select 1 from inv.item_node x
                  where x.item_id = p_item and x.delivery_node_id = p_store
                    and x.archived_at is null) then
    perform inv.fail('NOT_FOUND', 'that item is not kept there');
  end if;
  if p_qty is null or p_qty <= 0 then
    perform inv.fail('INVALID_QUANTITY', 'more than nothing');
  end if;
  if coalesce(p_reason, '') not in ('dropped', 'washing', 'guest', 'worn_out', 'other') then
    perform inv.fail('INVALID_VALUE', 'dropped, washing, guest, worn out or other');
  end if;
  if coalesce(p_broken_by, '') not in ('staff', 'guest', 'unknown') then
    perform inv.fail('INVALID_VALUE', 'staff, a guest or not known');
  end if;
  if p_person is not null and (p_broken_by <> 'staff' or not exists (
       select 1 from core.app_user u where u.id = p_person and u.tenant_id = v_me.tenant_id)) then
    perform inv.fail('INVALID_VALUE', 'who broke it is someone on the staff');
  end if;
  if p_photo_key is not null and btrim(p_photo_key) <> ''
     and p_photo_key not like 'wastage/' || v_me.tenant_id || '/' || p_store || '/%' then
    perform inv.fail('INVALID_PHOTO', 'a photo taken here');
  end if;
  if inv.on_hand(p_item, p_store) < p_qty then
    perform inv.fail('INSUFFICIENT_STOCK', 'more than the store has');
  end if;
  v_cost := inv.avg_cost(p_item, p_store);
  insert into inv.breakage (tenant_id, org_node_id, delivery_node_id, item_id, qty, reason,
                            broken_by, person_id, note, unit_cost, value, idempotency_key,
                            photo_key)
  values (v_me.tenant_id, p_place, p_store, p_item, p_qty, p_reason, p_broken_by, p_person,
          left(nullif(btrim(p_note), ''), 300), v_cost, round(p_qty * v_cost, 2),
          p_idempotency_key, nullif(btrim(p_photo_key), ''))
  returning id into v_id;
  perform inv.post(p_item, p_store, 'consumption', -p_qty, v_cost, 'breakage', v_id, 'breakage');
  return v_id;
end $$;

drop function inv.breakage_log(uuid, date);
create function inv.breakage_log(p_place uuid, p_month date)
returns table (id uuid, broken_at timestamptz, place text, store text, item_id uuid,
               item text, unit text, qty numeric, reason text, broken_by text, person text,
               note text, value numeric, recorded_by text, photo_key text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt, extensions
as $$
#variable_conflict use_column
declare
  v_tz text := coalesce(ops.tz_of(p_place), 'UTC');
  v_from date := date_trunc('month', p_month)::date;
begin
  if not inv.reads_breakage(p_place) then
    perform inv.fail('NOT_AUTHORISED', 'BREAKAGE view');
  end if;
  return query
    select b.id, b.broken_at, d.name, s.name, i.id, i.name, i.base_uom, b.qty, b.reason,
           b.broken_by, (select u.display_name from core.app_user u where u.id = b.person_id),
           b.note, b.value,
           (select u.display_name from core.app_user u where u.id = b.created_by),
           b.photo_key
      from inv.breakage b
      join core.hierarchy_node d on d.id = b.org_node_id
      join core.hierarchy_node p on p.id = p_place
      join core.hierarchy_node s on s.id = b.delivery_node_id
      join inv.item i on i.id = b.item_id
     where b.tenant_id = core.my_tenant()
       and d.path operator(extensions.<@) p.path
       and rpt.business_date(b.broken_at, v_tz) >= v_from
       and rpt.business_date(b.broken_at, v_tz) < (v_from + interval '1 month')::date
     order by b.broken_at desc;
end $$;

revoke execute on function inv.record_breakage(uuid, uuid, uuid, numeric, text, text, uuid, text, text, text), inv.breakage_log(uuid, date)
  from public, platform_loader;
grant execute on function inv.record_breakage(uuid, uuid, uuid, numeric, text, text, uuid, text, text, text), inv.breakage_log(uuid, date) to app_rw;

-- migrate:down
drop function inv.breakage_log(uuid, date);
create function inv.breakage_log(p_place uuid, p_month date)
returns table (id uuid, broken_at timestamptz, place text, store text, item_id uuid,
               item text, unit text, qty numeric, reason text, broken_by text, person text,
               note text, value numeric, recorded_by text)
language plpgsql stable security definer
set search_path = pg_catalog, core, inv, ops, rpt, extensions
as $$
#variable_conflict use_column
declare
  v_tz text := coalesce(ops.tz_of(p_place), 'UTC');
  v_from date := date_trunc('month', p_month)::date;
begin
  if not inv.reads_breakage(p_place) then
    perform inv.fail('NOT_AUTHORISED', 'BREAKAGE view');
  end if;
  return query
    select b.id, b.broken_at, d.name, s.name, i.id, i.name, i.base_uom, b.qty, b.reason,
           b.broken_by, (select u.display_name from core.app_user u where u.id = b.person_id),
           b.note, b.value,
           (select u.display_name from core.app_user u where u.id = b.created_by)
      from inv.breakage b
      join core.hierarchy_node d on d.id = b.org_node_id
      join core.hierarchy_node p on p.id = p_place
      join core.hierarchy_node s on s.id = b.delivery_node_id
      join inv.item i on i.id = b.item_id
     where b.tenant_id = core.my_tenant()
       and d.path operator(extensions.<@) p.path
       and rpt.business_date(b.broken_at, v_tz) >= v_from
       and rpt.business_date(b.broken_at, v_tz) < (v_from + interval '1 month')::date
     order by b.broken_at desc;
end $$;
drop function inv.record_breakage(uuid, uuid, uuid, numeric, text, text, uuid, text, text, text);
create function inv.record_breakage(p_place uuid, p_store uuid, p_item uuid, p_qty numeric,
                                    p_reason text, p_broken_by text, p_person uuid,
                                    p_note text, p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, inv, ops
as $$
declare
  v_me core.app_user := wf.me();
  v_id uuid;
  v_cost numeric;
begin
  if p_idempotency_key is not null then
    select id into v_id from inv.breakage
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if v_id is not null then return v_id; end if;
  end if;
  if not exists (select 1 from core.hierarchy_node
                  where id = p_place and tenant_id = v_me.tenant_id and type = 'org'
                    and kind = 'department' and archived_at is null)
     or not core.can('BREAKAGE', 'modify', p_place, null) then
    perform inv.fail('NOT_AUTHORISED', 'BREAKAGE modify');
  end if;
  if not exists (select 1 from core.hierarchy_node s
                  where s.id = p_store and s.tenant_id = v_me.tenant_id and s.type = 'delivery'
                    and s.holds_stock and s.archived_at is null)
     or core.nearest(ops.team_of_store(p_store), array['outlet'])
        is distinct from core.nearest(p_place, array['outlet']) then
    perform inv.fail('NOT_FOUND', 'that store is not at this outlet');
  end if;
  if not exists (select 1 from inv.item_node x
                  where x.item_id = p_item and x.delivery_node_id = p_store
                    and x.archived_at is null) then
    perform inv.fail('NOT_FOUND', 'that item is not kept there');
  end if;
  if p_qty is null or p_qty <= 0 then
    perform inv.fail('INVALID_QUANTITY', 'more than nothing');
  end if;
  if coalesce(p_reason, '') not in ('dropped', 'washing', 'guest', 'worn_out', 'other') then
    perform inv.fail('INVALID_VALUE', 'dropped, washing, guest, worn out or other');
  end if;
  if coalesce(p_broken_by, '') not in ('staff', 'guest', 'unknown') then
    perform inv.fail('INVALID_VALUE', 'staff, a guest or not known');
  end if;
  if p_person is not null and (p_broken_by <> 'staff' or not exists (
       select 1 from core.app_user u where u.id = p_person and u.tenant_id = v_me.tenant_id)) then
    perform inv.fail('INVALID_VALUE', 'who broke it is someone on the staff');
  end if;
  if inv.on_hand(p_item, p_store) < p_qty then
    perform inv.fail('INSUFFICIENT_STOCK', 'more than the store has');
  end if;
  v_cost := inv.avg_cost(p_item, p_store);
  insert into inv.breakage (tenant_id, org_node_id, delivery_node_id, item_id, qty, reason,
                            broken_by, person_id, note, unit_cost, value, idempotency_key)
  values (v_me.tenant_id, p_place, p_store, p_item, p_qty, p_reason, p_broken_by, p_person,
          left(nullif(btrim(p_note), ''), 300), v_cost, round(p_qty * v_cost, 2),
          p_idempotency_key)
  returning id into v_id;
  perform inv.post(p_item, p_store, 'consumption', -p_qty, v_cost, 'breakage', v_id, 'breakage');
  return v_id;
end $$;
revoke execute on function inv.record_breakage(uuid, uuid, uuid, numeric, text, text, uuid, text, text), inv.breakage_log(uuid, date)
  from public, platform_loader;
grant execute on function inv.record_breakage(uuid, uuid, uuid, numeric, text, text, uuid, text, text), inv.breakage_log(uuid, date) to app_rw;
alter table inv.breakage drop column photo_key;
