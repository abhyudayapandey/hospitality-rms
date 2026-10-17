-- migrate:up
-- Someone is told when the back office stops (ADR 170, review H5, M49).
--
-- Each job on the server records when it last ran: the root scripts call platform.job_ran
-- after a unit succeeds (systemd ExecStartPost=+) and when it fails (the notify unit), as the
-- database superuser. /health asks platform.health() as app_rw with no session: yes or no,
-- and which jobs are late. The platform console lists them in words (platform.job_status).
-- No app role may write or read the table itself.

create table platform.job_heartbeat (
  job text primary key,
  label text not null,
  -- late once the last good run is older than this (about twice how often it runs)
  late_after interval not null,
  last_ok_at timestamptz,
  last_failed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
alter table platform.job_heartbeat enable row level security;
revoke all on platform.job_heartbeat from public;

insert into platform.job_heartbeat (job, label, late_after) values
  ('wf-execute', 'Approvals and alerts (every minute)', interval '5 minutes'),
  ('tasks-tick', 'Checklist rounds and reminders (every 5 minutes)', interval '20 minutes'),
  ('attendance-nightly', 'Nightly attendance and reports', interval '26 hours'),
  ('pg-backup', 'Backups', interval '7 hours'),
  ('restore-drill', 'Weekly restore check', interval '8 days'),
  ('os-patch', 'Weekly security updates', interval '8 days'),
  ('platform-worker', 'Platform worker', interval '35 minutes'),
  ('web', 'The app', interval '35 minutes'),
  ('watchdog', 'Disk and service check (every 15 minutes)', interval '35 minutes');

-- The server's root scripts only (no grant: the superuser needs none).
create function platform.job_ran(p_job text, p_ok boolean, p_note text) returns void
language sql security definer
set search_path = pg_catalog, platform
as $$
  update platform.job_heartbeat
     set last_ok_at = case when p_ok then clock_timestamp() else last_ok_at end,
         last_failed_at = case when p_ok then last_failed_at else clock_timestamp() end,
         last_error = case when p_ok then last_error else left(p_note, 2000) end
   where job = p_job;
$$;
revoke all on function platform.job_ran(text, boolean, text) from public;

-- Late: no good run within its limit (since it was listed, if it never ran), or its last
-- run failed.
create function platform.job_late(h platform.job_heartbeat) returns boolean
language sql stable
set search_path = pg_catalog, platform
as $$
  select coalesce(h.last_ok_at, h.created_at) < now() - h.late_after
      or h.last_failed_at > coalesce(h.last_ok_at, '-infinity');
$$;
revoke all on function platform.job_late(platform.job_heartbeat) from public;

-- /health: answers with no session and gives nothing but the job codes.
create function platform.health() returns table (ok boolean, late text[])
language sql stable security definer
set search_path = pg_catalog, platform
as $$
  select count(*) filter (where platform.job_late(h)) = 0,
         coalesce(array_agg(h.job order by h.job) filter (where platform.job_late(h)), '{}')
    from platform.job_heartbeat h;
$$;
revoke all on function platform.health() from public;
grant execute on function platform.health() to app_rw;

-- The console's list (platform admins only).
create function platform.job_status()
returns table (job text, label text, late boolean, last_ok_at timestamptz,
               last_failed_at timestamptz, last_error text)
language plpgsql stable security definer
set search_path = pg_catalog, platform
as $$
begin
  perform platform.current_admin();
  return query
    select h.job, h.label, platform.job_late(h), h.last_ok_at, h.last_failed_at, h.last_error
      from platform.job_heartbeat h
     order by platform.job_late(h) desc, h.label;
end $$;
revoke all on function platform.job_status() from public;
grant execute on function platform.job_status() to app_rw;

-- A job left 'running' by a worker that died (a deploy, out of memory) is taken up again
-- after 30 minutes, three tries in all; after the third it fails, in words.
create or replace function platform.claim_job() returns setof platform.job
language plpgsql security definer
set search_path = pg_catalog, platform
as $$
begin
  update platform.job
     set status = 'failed', finished_at = now(),
         error = 'The worker stopped three times while running this. Start it again.'
   where status = 'running' and claimed_at < now() - interval '30 minutes' and attempts >= 3;

  return query
    update platform.job
       set status = 'running', claimed_at = now(), attempts = attempts + 1
     where id = (select id from platform.job
                  where (status = 'queued' and coalesce(run_after, created_at) <= now())
                     or (status = 'running' and claimed_at < now() - interval '30 minutes')
                  order by coalesce(run_after, created_at) for update skip locked limit 1)
    returning *;
end $$;

-- migrate:down
create or replace function platform.claim_job() returns setof platform.job
language sql security definer
set search_path = pg_catalog, platform
as $$
  update platform.job
     set status = 'running', claimed_at = now(), attempts = attempts + 1
   where id = (select id from platform.job
                where status = 'queued' and coalesce(run_after, created_at) <= now()
                order by coalesce(run_after, created_at) for update skip locked limit 1)
  returning *;
$$;
drop function platform.job_status();
drop function platform.health();
drop function platform.job_late(platform.job_heartbeat);
drop function platform.job_ran(text, boolean, text);
drop table platform.job_heartbeat;
