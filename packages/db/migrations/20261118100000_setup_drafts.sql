-- migrate:up
-- The set-up wizard (ADR 064): a new customer is set up on seven screens in the Platform Admin
-- console and saved as a draft at every Next, so it can be left and resumed. A draft is our
-- record of the choices only: nothing exists in any customer until Go live, which creates the
-- customer and dry runs and applies the files made from the draft through the usual jobs.
-- Platform admins only, like every platform table: app_rw has no grants on it, and each change
-- is in the platform audit.
create table platform.setup_draft (
  id uuid primary key default core.uuid_v7(),
  name text not null check (length(trim(name)) between 1 and 200),
  choices jsonb not null default '{}',
  step text not null default 'company'
    check (step in ('company', 'outlets', 'departments', 'roles', 'people', 'stock', 'review')),
  tenant_id uuid references core.tenant (id),
  create_job uuid references platform.job (id),
  dry_run_job uuid references platform.job (id),
  apply_job uuid references platform.job (id),
  created_by uuid not null references platform.admin (id),
  created_at timestamptz not null default now(),
  updated_by uuid not null references platform.admin (id),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index setup_draft_open on platform.setup_draft (updated_at desc) where archived_at is null;

-- Saves a draft (a new one when p_id is null); returns its id. Choices of a draft that has
-- gone live can't change: a later change is an import (or Step 6's Admin). A save after a dry
-- run clears it, so what is applied is always what was last checked.
create function platform.save_setup_draft(p_id uuid, p_name text, p_choices jsonb, p_step text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_admin uuid := platform.current_admin();
  v_id uuid;
begin
  if p_choices is null or jsonb_typeof(p_choices) <> 'object' then
    raise exception 'INVALID_SETUP' using detail = 'choices must be an object';
  end if;
  if p_id is null then
    insert into platform.setup_draft (name, choices, step, created_by, updated_by)
    values (trim(p_name), p_choices, p_step, v_admin, v_admin)
    returning id into v_id;
    perform platform.log('setup_draft_started', null, null,
                         jsonb_build_object('draft', v_id, 'name', trim(p_name)));
    return v_id;
  end if;
  update platform.setup_draft
     set name = trim(p_name), choices = p_choices, step = p_step,
         dry_run_job = case when choices = p_choices then dry_run_job end,
         updated_by = v_admin, updated_at = now()
   where id = p_id and archived_at is null and apply_job is null
  returning id into v_id;
  if v_id is null then
    raise exception 'INVALID_STATE' using detail = 'the set-up is closed or already live';
  end if;
  return v_id;
end $$;

-- Records a Go live job on the draft (create, dry run, apply), and the customer once created.
create function platform.set_setup_job(p_id uuid, p_kind text, p_job uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_admin uuid := platform.current_admin();
  v_job platform.job;
begin
  select * into v_job from platform.job where id = p_job;
  if v_job.id is null then
    raise exception 'NOT_FOUND' using detail = 'no such job';
  end if;
  if p_kind = 'create' and v_job.kind = 'create_customer' then
    update platform.setup_draft set create_job = p_job, updated_by = v_admin, updated_at = now()
     where id = p_id and archived_at is null and create_job is null;
  elsif p_kind = 'dry_run' and v_job.kind = 'import_dry_run' then
    update platform.setup_draft set dry_run_job = p_job, tenant_id = v_job.tenant_id,
           updated_by = v_admin, updated_at = now()
     where id = p_id and archived_at is null and apply_job is null;
  elsif p_kind = 'apply' and v_job.kind = 'import_apply' then
    update platform.setup_draft set apply_job = p_job, updated_by = v_admin, updated_at = now()
     where id = p_id and archived_at is null and dry_run_job = (v_job.payload ->> 'dry_run')::uuid;
  else
    raise exception 'INVALID_SETUP' using detail = 'the job is not of that kind';
  end if;
  if not found then
    raise exception 'INVALID_STATE' using detail = 'the set-up is not at that point';
  end if;
  perform platform.log('setup_draft_' || p_kind, v_job.tenant_id, null,
                       jsonb_build_object('draft', p_id, 'job', p_job));
end $$;

create function platform.setup_drafts()
returns table (id uuid, name text, step text, tenant_id uuid, live boolean,
               created_by_email text, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  return query
    select d.id, d.name, d.step, d.tenant_id, d.apply_job is not null, a.email, d.created_at,
           d.updated_at
      from platform.setup_draft d join platform.admin a on a.id = d.created_by
     where d.archived_at is null
     order by d.updated_at desc;
end $$;

create function platform.setup_draft(p_id uuid)
returns table (id uuid, name text, choices jsonb, step text, tenant_id uuid,
               create_job uuid, dry_run_job uuid, apply_job uuid, updated_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  return query
    select d.id, d.name, d.choices, d.step, d.tenant_id, d.create_job, d.dry_run_job,
           d.apply_job, d.updated_at
      from platform.setup_draft d
     where d.id = p_id and d.archived_at is null;
end $$;

-- Throws a draft away (kept, archived); a customer it created stays as it is.
create function platform.archive_setup_draft(p_id uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_admin uuid := platform.current_admin();
  v_tenant uuid;
begin
  update platform.setup_draft set archived_at = now(), updated_by = v_admin, updated_at = now()
   where id = p_id and archived_at is null
  returning tenant_id into v_tenant;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'no such set-up';
  end if;
  perform platform.log('setup_draft_archived', v_tenant, null, jsonb_build_object('draft', p_id));
end $$;

revoke execute on function platform.save_setup_draft(uuid, text, jsonb, text),
  platform.set_setup_job(uuid, text, uuid), platform.setup_drafts(),
  platform.setup_draft(uuid), platform.archive_setup_draft(uuid) from public;
grant execute on function platform.save_setup_draft(uuid, text, jsonb, text),
  platform.set_setup_job(uuid, text, uuid), platform.setup_drafts(),
  platform.setup_draft(uuid), platform.archive_setup_draft(uuid) to app_rw;

-- migrate:down
drop function platform.archive_setup_draft(uuid);
drop function platform.setup_draft(uuid);
drop function platform.setup_drafts();
drop function platform.set_setup_job(uuid, text, uuid);
drop function platform.save_setup_draft(uuid, text, jsonb, text);
drop table platform.setup_draft;
