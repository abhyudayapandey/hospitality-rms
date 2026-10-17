-- migrate:up
-- Onboarding uploads are kept in the database (ADR 169). The console used to store them only
-- in the photo bucket's onboarding/ prefix, which expires after 30 days, so an apply asked
-- for late failed, and "Add an outlet" (ADR 062) could not find the files of an import
-- applied more than 30 days ago. Uploads are small (25 MB at most, usually a few hundred
-- KB of text) and rare, so they are simply kept. The web app writes them through
-- keep_upload (platform admins, the key under its own customer); the worker reads them;
-- nobody else can see them.
create table platform.upload (
  key text primary key check (key ~ '^onboarding/[0-9a-f-]{36}/[0-9a-f-]{36}\.json$'),
  tenant_id uuid not null references core.tenant (id),
  files jsonb not null check (jsonb_typeof(files) = 'object'),
  -- dish photos (ADR 078): file name -> base64
  photos jsonb check (photos is null or jsonb_typeof(photos) = 'object'),
  created_by uuid references platform.admin (id),
  created_at timestamptz not null default now()
);
create index upload_tenant on platform.upload (tenant_id, created_at desc);
revoke all on platform.upload from public;

create function platform.keep_upload(p_key text, p_tenant uuid, p_files jsonb, p_photos jsonb)
returns void
language plpgsql security definer
set search_path = pg_catalog, platform
as $$
declare
  v_admin uuid := platform.current_admin();
begin
  if p_key is null or p_key not like 'onboarding/' || p_tenant::text || '/%' then
    raise exception 'bad upload key';
  end if;
  insert into platform.upload (key, tenant_id, files, photos, created_by)
  values (p_key, p_tenant, p_files, p_photos, v_admin);
end $$;
revoke execute on function platform.keep_upload(text, uuid, jsonb, jsonb) from public;
grant execute on function platform.keep_upload(text, uuid, jsonb, jsonb) to app_rw;

-- The worker's read: null when the upload was made before uploads were kept here.
create function platform.kept_upload(p_key text)
returns table (files jsonb, photos jsonb)
language sql stable security definer
set search_path = pg_catalog, platform
as $$ select u.files, u.photos from platform.upload u where u.key = p_key $$;
revoke execute on function platform.kept_upload(text) from public;
grant execute on function platform.kept_upload(text) to platform_loader;

-- current_files now also returns the applied upload's files when they are kept here.
drop function platform.current_files(uuid);
create function platform.current_files(p_tenant uuid)
returns table (upload_key text, files jsonb, created_with jsonb)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_key text;
begin
  perform platform.current_admin();
  select j.payload ->> 'key' into v_key from platform.job j
   where j.tenant_id = p_tenant and j.kind = 'import_apply' and j.status = 'done'
   order by j.finished_at desc nulls last limit 1;
  return query
    select v_key,
           (select u.files from platform.upload u where u.key = v_key),
           (select j.payload from platform.job j
             where j.tenant_id = p_tenant and j.kind = 'create_customer' and j.status = 'done'
             order by j.created_at desc limit 1);
end $$;
revoke execute on function platform.current_files(uuid) from public;
grant execute on function platform.current_files(uuid) to app_rw;

-- migrate:down
drop function platform.current_files(uuid);
create function platform.current_files(p_tenant uuid)
returns table (upload_key text, created_with jsonb)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  return query
    select (select j.payload ->> 'key' from platform.job j
             where j.tenant_id = p_tenant and j.kind = 'import_apply' and j.status = 'done'
             order by j.finished_at desc nulls last limit 1),
           (select j.payload from platform.job j
             where j.tenant_id = p_tenant and j.kind = 'create_customer' and j.status = 'done'
             order by j.created_at desc limit 1);
end $$;
revoke execute on function platform.current_files(uuid) from public;
grant execute on function platform.current_files(uuid) to app_rw;
drop function platform.kept_upload(text);
drop function platform.keep_upload(text, uuid, jsonb, jsonb);
drop table platform.upload;
