-- migrate:up
-- Events and in-app notifications (docs/LLD.md sections 5 and 7, ADR 008).
--
-- ops.upsert_event creates or edits an event and replaces its requirement lines (old
-- lines are archived, never deleted). Requirements are stored for the AI layer's
-- EVENT_UPLIFT signal: items with quantities, roles with headcount and a time window.

-- Creates (p_id null) or updates an event at p_node. p_requirements:
--   [{"kind":"item","item_id":..,"qty":..,"notes":..},
--    {"kind":"role","role_code":..,"headcount":..,"starts_at":..,"ends_at":..,"notes":..}]
-- Returns the event id; a repeated p_idempotency_key returns the first result.
create function ops.upsert_event(p_id uuid, p_node uuid, p_name text, p_starts_at timestamptz,
                                 p_ends_at timestamptz, p_covers int, p_notes text default null,
                                 p_requirements jsonb default '[]',
                                 p_status text default 'planned',
                                 p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, hr, ops
as $$
declare
  v_e ops.event;
  v_tenant uuid := core.my_tenant();
  v_reqs jsonb := coalesce(p_requirements, '[]');
begin
  if p_idempotency_key is not null and p_id is null then
    select * into v_e from ops.event
     where tenant_id = v_tenant and created_by = core.current_user_id()
       and idempotency_key = p_idempotency_key;
    if found then
      return v_e.id;
    end if;
  end if;
  if p_id is not null then
    select * into v_e from ops.event where id = p_id and tenant_id = v_tenant for update;
    if not found then
      perform hr.fail('NOT_FOUND', 'event');
    end if;
    perform hr.require('EVENTS', 'modify', v_e.org_node_id);
    if v_e.status = 'cancelled' then
      perform hr.fail('INVALID_STATE', 'the event is cancelled');
    end if;
    if p_node is not null and p_node <> v_e.org_node_id then
      perform hr.fail('INVALID_ACTION', 'events do not move between locations');
    end if;
  else
    perform hr.require('EVENTS', 'modify', p_node);
  end if;

  if coalesce(trim(p_name), '') = '' or p_starts_at is null or p_ends_at is null
     or p_ends_at <= p_starts_at or p_ends_at - p_starts_at > interval '7 days' then
    perform hr.fail('INVALID_DATES', 'an event needs a name and an end after its start');
  end if;
  if p_covers is null or p_covers < 0 or p_status not in ('planned', 'confirmed') then
    perform hr.fail('INVALID_QUANTITY', 'covers must be 0 or more');
  end if;
  if jsonb_typeof(v_reqs) <> 'array' then
    perform hr.fail('INVALID_LINES', 'requirements must be a list');
  end if;
  if exists (select 1 from jsonb_array_elements(v_reqs) r
              where r ->> 'kind' is distinct from 'item' and r ->> 'kind' is distinct from 'role') then
    perform hr.fail('INVALID_LINES', 'each requirement is an item or a role');
  end if;
  if exists (select 1 from jsonb_array_elements(v_reqs) r
              where r ->> 'kind' = 'item'
                and (coalesce((r ->> 'qty')::numeric, 0) <= 0
                     or not exists (select 1 from inv.item i
                                     where i.id = (r ->> 'item_id')::uuid and i.tenant_id = v_tenant
                                       and i.archived_at is null))) then
    perform hr.fail('INVALID_ITEM', 'each item needs a known item and a quantity above 0');
  end if;
  if exists (select 1 from jsonb_array_elements(v_reqs) r
              where r ->> 'kind' = 'role'
                and (coalesce((r ->> 'headcount')::int, 0) < 1
                     or (r ->> 'starts_at')::timestamptz is null
                     or (r ->> 'ends_at')::timestamptz <= (r ->> 'starts_at')::timestamptz
                     or not exists (select 1 from hr.job_role j
                                     where j.code = r ->> 'role_code' and j.tenant_id = v_tenant
                                       and j.archived_at is null))) then
    perform hr.fail('INVALID_LINES', 'each role needs a known role, headcount and a time window');
  end if;
  if (select count(*) from jsonb_array_elements(v_reqs) r where r ->> 'kind' = 'item')
     <> (select count(distinct r ->> 'item_id') from jsonb_array_elements(v_reqs) r
          where r ->> 'kind' = 'item') then
    perform hr.fail('INVALID_LINES', 'an item appears twice');
  end if;

  if p_id is null then
    insert into ops.event (tenant_id, org_node_id, name, starts_at, ends_at, covers, status, notes,
                           idempotency_key)
    values (v_tenant, p_node, trim(p_name), p_starts_at, p_ends_at, p_covers, p_status,
            nullif(trim(p_notes), ''), p_idempotency_key)
    returning * into v_e;
  else
    update ops.event
       set name = trim(p_name), starts_at = p_starts_at, ends_at = p_ends_at, covers = p_covers,
           status = p_status, notes = nullif(trim(p_notes), '')
     where id = p_id
    returning * into v_e;
    update ops.event_requirement set archived_at = now()
     where event_id = p_id and archived_at is null;
  end if;

  insert into ops.event_requirement (tenant_id, event_id, org_node_id, kind, item_id, qty,
                                     role_code, headcount, starts_at, ends_at, notes)
  select v_e.tenant_id, v_e.id, v_e.org_node_id, r ->> 'kind',
         (r ->> 'item_id')::uuid, (r ->> 'qty')::numeric,
         case when r ->> 'kind' = 'role' then r ->> 'role_code' end,
         (r ->> 'headcount')::int,
         case when r ->> 'kind' = 'role' then (r ->> 'starts_at')::timestamptz end,
         case when r ->> 'kind' = 'role' then (r ->> 'ends_at')::timestamptz end,
         nullif(trim(r ->> 'notes'), '')
    from jsonb_array_elements(v_reqs) r;
  return v_e.id;
end $$;

create function ops.cancel_event(p_id uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, hr, ops
as $$
declare
  v_e ops.event;
begin
  select * into v_e from ops.event where id = p_id and tenant_id = core.my_tenant() for update;
  if not found then
    perform hr.fail('NOT_FOUND', 'event');
  end if;
  perform hr.require('EVENTS', 'modify', v_e.org_node_id);
  update ops.event set status = 'cancelled' where id = p_id and status <> 'cancelled';
end $$;

-- Marks the current user's notifications read (all unread when p_ids is null).
create function ops.mark_read(p_ids uuid[] default null) returns int
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_n int;
begin
  update ops.notification set read_at = now()
   where owner_user_id = core.current_user_id() and read_at is null
     and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke execute on function
  ops.upsert_event(uuid, uuid, text, timestamptz, timestamptz, int, text, jsonb, text, text),
  ops.cancel_event(uuid), ops.mark_read(uuid[]) from public;
grant execute on function
  ops.upsert_event(uuid, uuid, text, timestamptz, timestamptz, int, text, jsonb, text, text),
  ops.cancel_event(uuid), ops.mark_read(uuid[]) to app_rw;

-- migrate:down
drop function ops.mark_read(uuid[]);
drop function ops.cancel_event(uuid);
drop function ops.upsert_event(uuid, uuid, text, timestamptz, timestamptz, int, text, jsonb, text, text);
