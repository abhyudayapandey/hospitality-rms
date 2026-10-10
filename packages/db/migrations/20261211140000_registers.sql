-- migrate:up
-- Registers (ADR 090), the Registers block (ADR 085, domain REGISTERS). One engine, a register
-- per kind (packages/domain/src/registers.ts; the required fields here, kept equal by a test):
-- lost and found, incidents, visitors, vehicles, staff in and out, keys, fire equipment.
--
-- * A customer switches each register on or off and may name the job roles that keep it
--   (file 45, core.tenant.settings.registers = {"<code>": {"on": bool, "roles": [...]}}). By
--   default lost and found and incidents are on at every outlet, the rest at hotels, kept by
--   anyone who holds REGISTERS at the place.
-- * An entry is written at a department or the outlet by whoever holds REGISTERS modify there
--   and keeps that register (one of its roles, or someone who runs a department or more). It
--   is never edited or deleted; an open one is closed (returned, left, back in) with an
--   outcome and a note. Fire equipment checks are closed when written.

create table ops.register_entry (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  register text not null check (register in ('lost_found', 'incidents', 'visitors', 'vehicles',
                                             'staff_movement', 'keys', 'fire_equipment')),
  fields jsonb not null check (jsonb_typeof(fields) = 'object'),
  status text not null default 'open' check (status in ('open', 'closed')),
  outcome text check (length(outcome) <= 100),
  close_note text check (length(close_note) <= 500),
  closed_at timestamptz,
  closed_by uuid references core.app_user(id),
  idempotency_key text,
  check ((status = 'closed') = (closed_at is not null))
);
select core.add_standard_columns('ops.register_entry');
create index register_entry_place on ops.register_entry (org_node_id, register, created_at desc);
alter table ops.register_entry add constraint register_entry_idem
  unique (tenant_id, created_by, idempotency_key);

-- The fields a register's entry must have (registers.ts `required`); null: no such register.
create function ops.register_required(p_register text) returns text[]
language sql immutable
as $$
  select case p_register
           when 'lost_found' then array['item']
           when 'incidents' then array['what_happened']
           when 'visitors' then array['name']
           when 'vehicles' then array['number']
           when 'staff_movement' then array['person']
           when 'keys' then array['key', 'issued_to']
           when 'fire_equipment' then array['equipment', 'condition']
         end;
$$;

-- Whether a register's entries stay open until closed (all but fire equipment checks).
create function ops.register_closes(p_register text) returns boolean
language sql immutable
as $$
  select p_register <> 'fire_equipment';
$$;

-- On at an outlet: as the customer set it (file 45), else lost and found and incidents
-- everywhere and the rest at hotels.
create function ops.register_on(p_tenant uuid, p_register text, p_outlet uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce(
    (select (t.settings -> 'registers' -> p_register ->> 'on')::boolean
       from core.tenant t where t.id = p_tenant),
    p_register in ('lost_found', 'incidents')
      or exists (select 1 from core.hierarchy_node o
                  where o.id = p_outlet and o.outlet_format = 'hotel'));
$$;

-- Whether I keep a register at a place: REGISTERS there, the register on at its outlet, and
-- one of the roles the customer named for it (if it named any) or I run a department or more.
create function ops.keeps_register(p_register text, p_place uuid, p_access text)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
declare
  v_outlet uuid := core.nearest(p_place, array['outlet']);
  v_roles jsonb;
begin
  if ops.register_required(p_register) is null or v_outlet is null
     or not core.can('REGISTERS', p_access, p_place, null)
     or not ops.register_on(core.my_tenant(), p_register, v_outlet) then
    return false;
  end if;
  select t.settings -> 'registers' -> p_register -> 'roles' into v_roles
    from core.tenant t where t.id = core.my_tenant();
  if v_roles is null or jsonb_typeof(v_roles) <> 'array' or jsonb_array_length(v_roles) = 0 then
    return true;
  end if;
  return exists (
    select 1 from hr.worker w
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node o on o.id = v_outlet
     where w.owner_user_id = core.current_user_id() and w.status = 'active'
       and h.path operator(extensions.<@) o.path
       and (v_roles ? w.role_code or ops.role_level(w.tenant_id, w.role_code) >= 2));
end $$;

-- Write an entry. Returns its id.
create function ops.add_register_entry(p_place uuid, p_register text, p_fields jsonb,
                                       p_idempotency_key text default null)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_id uuid;
  v_fields jsonb;
  v_key text;
begin
  if p_idempotency_key is not null then
    select e.id into v_id from ops.register_entry e
     where e.tenant_id = core.my_tenant() and e.created_by = core.current_user_id()
       and e.idempotency_key = p_idempotency_key;
    if v_id is not null then
      return v_id;
    end if;
  end if;
  if not exists (select 1 from core.hierarchy_node n
                  where n.id = p_place and n.tenant_id = core.my_tenant() and n.type = 'org'
                    and n.kind in ('outlet', 'department') and n.archived_at is null)
     or not ops.keeps_register(p_register, p_place, 'modify') then
    perform ops.fail('NOT_AUTHORISED', 'REGISTERS modify');
  end if;
  if jsonb_typeof(p_fields) is distinct from 'object' then
    perform ops.fail('INVALID_VALUE', 'the entry''s fields');
  end if;
  -- text values only, trimmed, empty ones left out
  select coalesce(jsonb_object_agg(k, left(btrim(v), 500)), '{}') into v_fields
    from jsonb_each_text(p_fields) f(k, v)
   where jsonb_typeof(p_fields -> k) = 'string' and length(btrim(v)) > 0
     and k ~ '^[a-z_]{1,40}$';
  foreach v_key in array ops.register_required(p_register) loop
    if not v_fields ? v_key then
      perform ops.fail('INVALID_VALUE', format('%s is needed', v_key));
    end if;
  end loop;
  insert into ops.register_entry (tenant_id, org_node_id, register, fields, status, closed_at,
                                  closed_by, idempotency_key)
  values (core.my_tenant(), p_place, p_register, v_fields,
          case when ops.register_closes(p_register) then 'open' else 'closed' end,
          case when ops.register_closes(p_register) then null else now() end,
          case when ops.register_closes(p_register) then null else core.current_user_id() end,
          p_idempotency_key)
  returning id into v_id;
  return v_id;
end $$;

-- Close an open entry: lost and found says how (returned, the police, disposed of).
create function ops.close_register_entry(p_entry uuid, p_outcome text, p_note text)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_e ops.register_entry;
begin
  select * into v_e from ops.register_entry
   where id = p_entry and tenant_id = core.my_tenant() for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such entry');
  end if;
  if not ops.keeps_register(v_e.register, v_e.org_node_id, 'modify') then
    perform ops.fail('NOT_AUTHORISED', 'REGISTERS modify');
  end if;
  if v_e.status <> 'open' then
    perform ops.fail('INVALID_STATE', 'already closed');
  end if;
  if v_e.register = 'lost_found' and coalesce(p_outcome, '') not in
       ('Returned to the owner', 'Handed to the police', 'Disposed of') then
    perform ops.fail('INVALID_VALUE', 'returned, handed to the police or disposed of');
  end if;
  if v_e.register = 'lost_found' and p_outcome = 'Returned to the owner'
     and nullif(btrim(p_note), '') is null then
    perform ops.fail('INVALID_VALUE', 'to whom, and their ID');
  end if;
  update ops.register_entry
     set status = 'closed', closed_at = now(), closed_by = core.current_user_id(),
         outcome = case when v_e.register = 'lost_found' then p_outcome end,
         close_note = left(nullif(btrim(p_note), ''), 500)
   where id = v_e.id;
end $$;

-- The places whose registers I keep or read, with the registers on there.
create function ops.register_places()
returns table (place_id uuid, place text, kind text, outlet text, registers text[],
               can_write text[])
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select n.id, n.name, n.kind, o.name,
         array(select r from unnest(array['lost_found', 'incidents', 'visitors', 'vehicles',
                                          'staff_movement', 'keys', 'fire_equipment']) r
                where ops.keeps_register(r, n.id, 'view')),
         array(select r from unnest(array['lost_found', 'incidents', 'visitors', 'vehicles',
                                          'staff_movement', 'keys', 'fire_equipment']) r
                where ops.keeps_register(r, n.id, 'modify'))
    from core.hierarchy_node n
    join core.hierarchy_node o on o.id = core.nearest(n.id, array['outlet'])
   where n.tenant_id = core.my_tenant() and n.type = 'org'
     and n.kind in ('outlet', 'department') and n.archived_at is null
     and core.can('REGISTERS', 'view', n.id, null)
     and exists (select 1 from unnest(array['lost_found', 'incidents', 'visitors', 'vehicles',
                                             'staff_movement', 'keys', 'fire_equipment']) r
                  where ops.keeps_register(r, n.id, 'view'))
   order by o.name, (n.kind = 'outlet') desc, n.name;
$$;

-- A register's entries at a place: the open ones, then the last p_days days' closed ones.
create function ops.register_entries(p_place uuid, p_register text, p_days int default 30)
returns table (id uuid, fields jsonb, status text, outcome text, close_note text,
               written_at timestamptz, written_by text, closed_at timestamptz,
               closed_by text, can_close boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
#variable_conflict use_column
begin
  if not ops.keeps_register(p_register, p_place, 'view') then
    perform ops.fail('NOT_AUTHORISED', 'REGISTERS view');
  end if;
  return query
    select e.id, e.fields, e.status, e.outcome, e.close_note, e.created_at,
           (select u.display_name from core.app_user u where u.id = e.created_by),
           e.closed_at,
           (select u.display_name from core.app_user u where u.id = e.closed_by),
           e.status = 'open' and ops.keeps_register(e.register, e.org_node_id, 'modify')
      from ops.register_entry e
     where e.org_node_id = p_place and e.register = p_register
       and e.tenant_id = core.my_tenant()
       and (e.status = 'open' or e.created_at > now() - make_interval(days => p_days))
     order by e.status = 'open' desc, e.created_at desc;
end $$;

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.register_entry', 'REGISTERS', 'org', true);
select core.apply_domain_rls('ops.register_entry');
select audit.enable('ops.register_entry');

revoke execute on function ops.register_required(text), ops.register_closes(text),
  ops.register_on(uuid, text, uuid), ops.keeps_register(text, uuid, text),
  ops.add_register_entry(uuid, text, jsonb, text), ops.close_register_entry(uuid, text, text),
  ops.register_places(), ops.register_entries(uuid, text, int)
  from public, platform_loader;
grant execute on function ops.add_register_entry(uuid, text, jsonb, text),
  ops.close_register_entry(uuid, text, text), ops.register_places(),
  ops.register_entries(uuid, text, int) to app_rw;
grant execute on function ops.register_required(text) to platform_loader;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.register_entries(uuid, text, int);
drop function ops.register_places();
drop function ops.close_register_entry(uuid, text, text);
drop function ops.add_register_entry(uuid, text, jsonb, text);
drop function ops.keeps_register(text, uuid, text);
drop function ops.register_on(uuid, text, uuid);
drop function ops.register_closes(text);
drop function ops.register_required(text);
delete from core.domain_table where table_name = 'ops.register_entry'::regclass;
drop table ops.register_entry;
