-- migrate:up
-- Demo requests from the website (ADR 141): heysenior.app's "Get a Senior" form. The first
-- write that comes with no session at all, so it has one narrow way in: app_rw may only call
-- platform.add_demo_request, which checks every field and refuses a flood. Reading and
-- closing them is for platform admins, in the console, like every platform table: app_rw has
-- no grants on the table, and each change is in the platform audit.
create table platform.demo_request (
  id uuid primary key default core.uuid_v7(),
  name text not null check (length(name) between 1 and 120),
  phone text not null check (phone ~ '^\+?[0-9 ()-]{10,20}$'),
  email text check (email is null or (length(email) <= 200 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  business text not null check (length(business) between 1 and 200),
  outlet_kind text not null
    check (outlet_kind in ('hotel', 'bar', 'restaurant', 'qsr', 'cloud_kitchen', 'franchise',
                           'several')),
  outlets text not null check (outlets in ('1', '2-5', '6-20', '20+')),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  handled_by uuid references platform.admin (id)
);
create index demo_request_new on platform.demo_request (created_at desc) where handled_at is null;

-- The website's form, through the app's /api/demo-request (which also limits each address).
-- Callable with no session. Blank optional text is stored as null; more than 100 requests in
-- an hour from everyone together is refused as a last guard against a flood.
create function platform.add_demo_request(p_name text, p_phone text, p_email text,
                                          p_business text, p_outlet_kind text, p_outlets text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_id uuid;
begin
  if (select count(*) from platform.demo_request where created_at > now() - interval '1 hour') >= 100 then
    raise exception 'RATE_LIMITED' using detail = 'too many demo requests this hour';
  end if;
  begin
    insert into platform.demo_request (name, phone, email, business, outlet_kind, outlets)
    values (trim(p_name), trim(p_phone), nullif(lower(trim(p_email)), ''), trim(p_business),
            p_outlet_kind, p_outlets)
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'INVALID_DEMO_REQUEST' using detail = 'a demo request field is missing or not valid';
  end;
  return v_id;
end $$;

create function platform.demo_requests()
returns table (id uuid, name text, phone text, email text, business text, outlet_kind text,
               outlets text, created_at timestamptz, handled_at timestamptz,
               handled_by_email text)
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  return query
    select d.id, d.name, d.phone, d.email, d.business, d.outlet_kind, d.outlets, d.created_at,
           d.handled_at, a.email
      from platform.demo_request d left join platform.admin a on a.id = d.handled_by
     order by d.handled_at is not null, d.created_at desc
     limit 200;
end $$;

-- How many are waiting, for the console's home.
create function platform.new_demo_requests() returns integer
language plpgsql stable security definer
set search_path = pg_catalog, core, platform
as $$
begin
  perform platform.current_admin();
  return (select count(*) from platform.demo_request where handled_at is null);
end $$;

-- Someone has called them back: off the "New" list, with who and when.
create function platform.mark_demo_request_handled(p_id uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_admin uuid := platform.current_admin();
begin
  update platform.demo_request set handled_at = now(), handled_by = v_admin
   where id = p_id and handled_at is null;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'no such new demo request';
  end if;
  perform platform.log('demo_request_handled', null, null, jsonb_build_object('request', p_id));
end $$;

revoke execute on function platform.add_demo_request(text, text, text, text, text, text),
  platform.demo_requests(), platform.new_demo_requests(),
  platform.mark_demo_request_handled(uuid) from public;
grant execute on function platform.add_demo_request(text, text, text, text, text, text),
  platform.demo_requests(), platform.new_demo_requests(),
  platform.mark_demo_request_handled(uuid) to app_rw;

-- migrate:down
drop function platform.mark_demo_request_handled(uuid);
drop function platform.new_demo_requests();
drop function platform.demo_requests();
drop function platform.add_demo_request(text, text, text, text, text, text);
drop table platform.demo_request;
