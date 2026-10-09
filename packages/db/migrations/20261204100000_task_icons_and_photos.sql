-- migrate:up
-- Icons on task steps and photos on any task, kept 30 days (GM feedback items 5 and 6,
-- ADR 079).
--
-- 1. A checklist step may name an icon, one of the product's pictograms (ops.task_icon_ok;
--    packages/domain/src/task-icons.ts holds the same list and a test keeps them equal). Its
--    copy on a task (ops.task_step.icon) keeps it. A step that names none gets one from its
--    words in the app: the database stores only what someone chose.
-- 2. Any task may carry up to three photos of its own (ops.task_photo), added by whoever may
--    work it while it is to do, and seen by whoever sees the task; any step already takes one
--    (ops.complete_step). They are routine task photos (tasks/routine/<tenant>/<place>/).
-- 3. Routine task photos are kept 30 days: ops.purge_task_photos, in the nightly job, clears
--    the keys of task and step photos older than that (the row stays, marked purged, as
--    selfies do, ADR 045); the bucket's 30-day rule on tasks/routine/ removes the files. A
--    flagged reading's photo, copied to tasks/keep/, and maintenance photos stay 400 days.
--    Bills, compliance documents, stock check proof and selfies are other prefixes and
--    other tables: nothing here touches them.

-- ---------------------------------------------------------------------------
-- 1. Icons
-- ---------------------------------------------------------------------------

create function ops.task_icon_names() returns text[]
language sql immutable as $$
  select array['bottle', 'thermometer', 'mop', 'broom', 'handwash', 'fridge', 'oil', 'trash',
               'towel', 'ice', 'knife', 'extinguisher', 'spray', 'lock', 'bulb', 'bed', 'glass',
               'pot', 'plate', 'leaf', 'box', 'truck', 'wrench', 'fire', 'shield', 'clipboard',
               'camera', 'check', 'people', 'bell', 'cart', 'bill', 'tap', 'pool', 'dumbbell'];
$$;

create function ops.task_icon_ok(p_icon text) returns boolean
language sql immutable as $$
  select p_icon is null or p_icon = any (ops.task_icon_names());
$$;

alter table ops.task_step add column icon text
  constraint task_step_icon check (ops.task_icon_ok(icon));

-- Steps as before, and an optional icon from the product's pictograms.
create or replace function ops.check_steps(p_steps jsonb) returns void
language plpgsql immutable as $$
declare
  v_s jsonb;
begin
  if jsonb_typeof(p_steps) is distinct from 'array' or jsonb_array_length(p_steps) > 30 then
    perform ops.fail('INVALID_STEPS', 'up to 30 steps');
  end if;
  for v_s in select * from jsonb_array_elements(p_steps) loop
    if length(btrim(coalesce(v_s ->> 'label', ''))) not between 1 and 200 then
      perform ops.fail('INVALID_STEPS', 'every step needs a label');
    end if;
    if coalesce(v_s ->> 'kind', '') not in ('tick', 'number', 'text', 'photo') then
      perform ops.fail('INVALID_STEPS', 'tick, number, text or photo');
    end if;
    if jsonb_typeof(v_s -> 'min') not in ('number', 'null') and v_s ? 'min'
       or jsonb_typeof(v_s -> 'max') not in ('number', 'null') and v_s ? 'max' then
      perform ops.fail('INVALID_STEPS', 'the range is numbers');
    end if;
    if (v_s ->> 'min')::numeric > (v_s ->> 'max')::numeric then
      perform ops.fail('INVALID_STEPS', 'the lowest acceptable value is above the highest');
    end if;
    if v_s ? 'icon' and jsonb_typeof(v_s -> 'icon') <> 'null'
       and not ops.task_icon_ok(v_s ->> 'icon') then
      perform ops.fail('INVALID_STEPS', 'an icon from the list');
    end if;
  end loop;
end $$;

-- Copies steps into a task, with their icons.
create or replace function ops.add_steps(p_task ops.task, p_steps jsonb) returns void
language sql security definer
set search_path = pg_catalog, ops
as $$
  insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind, min_value,
                             max_value, unit, photo_required, icon)
  select p_task.tenant_id, p_task.id, p_task.org_node_id, s.ord, btrim(s.v ->> 'label'),
         s.v ->> 'kind', (s.v ->> 'min')::numeric, (s.v ->> 'max')::numeric,
         nullif(btrim(s.v ->> 'unit'), ''), coalesce((s.v ->> 'photo_required')::boolean, false),
         nullif(s.v ->> 'icon', '')
    from jsonb_array_elements(p_steps) with ordinality s(v, ord);
$$;

-- A task's detail carries each step's icon.
do $$
declare
  v_src text := pg_get_functiondef('ops.task_detail(uuid)'::regprocedure);
  v_old text := '''photo_key'', s.photo_key, ''flagged'', s.flagged,';
begin
  if position(v_old in v_src) = 0 then
    raise exception 'ops.task_detail changed; update this migration';
  end if;
  execute replace(v_src, v_old, '''photo_key'', s.photo_key, ''icon'', s.icon, ''flagged'', s.flagged,');
end $$;

-- ---------------------------------------------------------------------------
-- 2. A task's own photos
-- ---------------------------------------------------------------------------

create table ops.task_photo (
  id uuid primary key default core.uuid_v7(),
  task_id uuid not null references ops.task(id),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the task's place
  photo_key text,                                                 -- null once purged
  taken_by uuid not null references core.app_user(id),
  taken_at timestamptz not null default now(),
  purged_at timestamptz,
  check ((photo_key is null) = (purged_at is not null))
);
select core.add_standard_columns('ops.task_photo');
create index task_photo_task on ops.task_photo (task_id, taken_at);
create index task_photo_purge on ops.task_photo (taken_at) where photo_key is not null;

insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only, owner_column)
values ('ops.task_photo', 'TASKS', 'org', true, null);
select core.apply_domain_rls('ops.task_photo');
select audit.enable('ops.task_photo');

-- Adds a photo to a task the caller may work, while it is to do; three at most. The key must
-- be a routine task photo of the task's place and company. Returns the photo's id.
create function ops.add_task_photo(p_task uuid, p_photo_key text) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task := ops.task_to_work(p_task);
  v_id uuid;
begin
  if p_photo_key is null
     or not ops.photo_ok(p_photo_key, v_t.tenant_id, v_t.org_node_id, array['routine']) then
    perform ops.fail('INVALID_PHOTO', 'photo was not uploaded for this place');
  end if;
  if (select count(*) from ops.task_photo where task_id = v_t.id) >= 3 then
    perform ops.fail('TOO_MANY_PHOTOS', 'three photos at most');
  end if;
  insert into ops.task_photo (tenant_id, task_id, org_node_id, photo_key, taken_by)
  values (v_t.tenant_id, v_t.id, v_t.org_node_id, p_photo_key, core.current_user_id())
  returning id into v_id;
  return v_id;
end $$;

-- A task's photos, for whoever sees the task: newest last; a purged one has no key.
create function ops.task_photos(p_task uuid)
returns table (id uuid, photo_key text, taken_by_name text, taken_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
#variable_conflict use_column
declare
  v_t ops.task;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant();
  if not found or not ops.sees_task(v_t) then
    perform ops.fail('NOT_AUTHORISED', 'see this task');
  end if;
  return query
    select p.id, p.photo_key, u.display_name, p.taken_at
      from ops.task_photo p join core.app_user u on u.id = p.taken_by
     where p.task_id = v_t.id
     order by p.taken_at;
end $$;

revoke execute on function ops.add_task_photo(uuid, text), ops.task_photos(uuid) from public;
grant execute on function ops.add_task_photo(uuid, text), ops.task_photos(uuid) to app_rw;

-- ---------------------------------------------------------------------------
-- 3. Kept 30 days
-- ---------------------------------------------------------------------------

-- Clears routine task and step photos taken before p_as_of - 30 days. Flagged readings (kept
-- under tasks/keep/) and maintenance photos are not routine and stay. Returns how many.
create function ops.purge_task_photos(p_as_of timestamptz default now()) returns int
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_cut timestamptz := p_as_of - interval '30 days';
  v_n int;
  v_m int;
begin
  update ops.task_photo set photo_key = null, purged_at = p_as_of
   where photo_key is not null and taken_at < v_cut
     and photo_key like 'tasks/routine/%';
  get diagnostics v_n = row_count;
  update ops.task_step set photo_key = null
   where photo_key like 'tasks/routine/%' and done_at < v_cut;
  get diagnostics v_m = row_count;
  return v_n + v_m;
end $$;
revoke execute on function ops.purge_task_photos(timestamptz) from public;
grant execute on function ops.purge_task_photos(timestamptz) to wf_executor;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.purge_task_photos(timestamptz), ops.task_photos(uuid),
  ops.add_task_photo(uuid, text);
delete from core.domain_table where table_name = 'ops.task_photo'::regclass;
drop table ops.task_photo;
create or replace function ops.add_steps(p_task ops.task, p_steps jsonb) returns void
language sql security definer
set search_path = pg_catalog, ops
as $$
  insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind, min_value,
                             max_value, unit, photo_required)
  select p_task.tenant_id, p_task.id, p_task.org_node_id, s.ord, btrim(s.v ->> 'label'),
         s.v ->> 'kind', (s.v ->> 'min')::numeric, (s.v ->> 'max')::numeric,
         nullif(btrim(s.v ->> 'unit'), ''), coalesce((s.v ->> 'photo_required')::boolean, false)
    from jsonb_array_elements(p_steps) with ordinality s(v, ord);
$$;
create or replace function ops.check_steps(p_steps jsonb) returns void
language plpgsql immutable as $$
declare
  v_s jsonb;
begin
  if jsonb_typeof(p_steps) is distinct from 'array' or jsonb_array_length(p_steps) > 30 then
    perform ops.fail('INVALID_STEPS', 'up to 30 steps');
  end if;
  for v_s in select * from jsonb_array_elements(p_steps) loop
    if length(btrim(coalesce(v_s ->> 'label', ''))) not between 1 and 200 then
      perform ops.fail('INVALID_STEPS', 'every step needs a label');
    end if;
    if coalesce(v_s ->> 'kind', '') not in ('tick', 'number', 'text', 'photo') then
      perform ops.fail('INVALID_STEPS', 'tick, number, text or photo');
    end if;
    if jsonb_typeof(v_s -> 'min') not in ('number', 'null') and v_s ? 'min'
       or jsonb_typeof(v_s -> 'max') not in ('number', 'null') and v_s ? 'max' then
      perform ops.fail('INVALID_STEPS', 'the range is numbers');
    end if;
    if (v_s ->> 'min')::numeric > (v_s ->> 'max')::numeric then
      perform ops.fail('INVALID_STEPS', 'the lowest acceptable value is above the highest');
    end if;
  end loop;
end $$;
do $$
begin
  execute replace(pg_get_functiondef('ops.task_detail(uuid)'::regprocedure),
    '''photo_key'', s.photo_key, ''icon'', s.icon, ''flagged'', s.flagged,',
    '''photo_key'', s.photo_key, ''flagged'', s.flagged,');
end $$;
alter table ops.task_step drop column icon;
drop function ops.task_icon_ok(text), ops.task_icon_names();
