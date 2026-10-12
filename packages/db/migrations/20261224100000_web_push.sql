-- migrate:up
-- Web Push (ADR 137): what lands in a person's bell also shows on their phone's lock screen.
-- A phone that turns alerts on saves its push subscription here; the minute job (wf-execute,
-- as wf_executor) sends each new notification to its owner's phones and marks it pushed.
-- Only the browsers' own push services are accepted as endpoints, so a subscription can never
-- point the server at anything else.

create table ops.push_subscription (
  id uuid primary key default core.uuid_v7(),
  owner_user_id uuid not null references core.app_user(id),
  endpoint text not null check (length(endpoint) <= 1000),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  label text check (length(label) <= 80),
  last_ok_at timestamptz,
  failures int not null default 0,
  archived_at timestamptz
);
select core.add_standard_columns('ops.push_subscription');
create unique index push_subscription_endpoint on ops.push_subscription (endpoint)
  where archived_at is null;
create index push_subscription_owner on ops.push_subscription (owner_user_id)
  where archived_at is null;
comment on table ops.push_subscription is 'a phone or browser that shows its owner''s alerts (ADR 137)';

-- Existing notifications count as pushed: the first deploy sends no backlog.
alter table ops.notification add column pushed_at timestamptz default now();
alter table ops.notification alter column pushed_at drop default;
create index notification_unpushed on ops.notification (created_at) where pushed_at is null;

-- The push services browsers use: Chrome and Android (FCM), Safari and iPhone, Firefox, Edge.
create function ops.push_endpoint_ok(p_endpoint text) returns boolean
language sql immutable
set search_path = pg_catalog
as $$
  select p_endpoint ~ ('^https://(fcm\.googleapis\.com|web\.push\.apple\.com'
                       '|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)/')
     and length(p_endpoint) <= 1000
$$;

-- This phone shows my alerts. A phone signed in by someone new moves to them.
create function ops.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text,
                                           p_label text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_user uuid := core.current_user_id();
  v_id uuid;
begin
  if v_user is null or core.my_tenant() is null then
    raise exception 'NOT_AUTHORISED' using detail = 'signed in only';
  end if;
  if nullif(current_setting('app.presented_by', true), '') is not null then
    raise exception 'PRESENTING' using detail = 'showing the app as someone else';
  end if;
  if not ops.push_endpoint_ok(p_endpoint) then
    raise exception 'INVALID_VALUE' using detail = 'not a push service';
  end if;
  update ops.push_subscription set archived_at = now()
   where endpoint = p_endpoint and archived_at is null and owner_user_id <> v_user;
  select id into v_id from ops.push_subscription
   where endpoint = p_endpoint and archived_at is null;
  if found then
    update ops.push_subscription
       set p256dh = p_p256dh, auth = p_auth, label = left(p_label, 80), failures = 0
     where id = v_id;
    return v_id;
  end if;
  insert into ops.push_subscription (tenant_id, owner_user_id, endpoint, p256dh, auth, label)
  values (core.my_tenant(), v_user, p_endpoint, p_p256dh, p_auth, left(p_label, 80))
  returning id into v_id;
  return v_id;
end $$;

-- This phone stops showing my alerts.
create function ops.remove_push_subscription(p_endpoint text) returns void
language sql security definer
set search_path = pg_catalog, core, ops
as $$
  update ops.push_subscription set archived_at = now()
   where endpoint = p_endpoint and archived_at is null
     and owner_user_id = core.current_user_id();
$$;

-- For the sender (wf_executor): the new notifications, once each, with their owner's phones.
-- Older than 15 minutes is too late to be useful: those are marked and not sent.
create function ops.push_due(p_limit int default 200)
returns table (notification_id uuid, subscription_id uuid, endpoint text, p256dh text,
               auth text, kind text, title text, body text, link text)
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
begin
  update ops.notification set pushed_at = now()
   where pushed_at is null and created_at < now() - interval '15 minutes';
  return query
    with n as (
      update ops.notification x set pushed_at = now()
       where x.id in (select y.id from ops.notification y
                       where y.pushed_at is null
                       order by y.created_at
                       limit greatest(1, least(p_limit, 1000))
                       for update skip locked)
      returning x.id, x.owner_user_id, x.kind, x.title, x.body, x.link)
    select n.id, s.id, s.endpoint, s.p256dh, s.auth, n.kind, n.title, n.body, n.link
      from n
      join ops.push_subscription s on s.owner_user_id = n.owner_user_id
                                  and s.archived_at is null
      join core.app_user u on u.id = n.owner_user_id and u.status = 'active'
     where ops.push_endpoint_ok(s.endpoint);
end $$;

-- For the sender: how one push went. Gone (404, 410) or failing 5 times running: archived.
create function ops.push_result(p_subscription uuid, p_ok boolean, p_gone boolean)
returns void
language sql security definer
set search_path = pg_catalog, ops
as $$
  update ops.push_subscription
     set last_ok_at = case when p_ok then now() else last_ok_at end,
         failures = case when p_ok then 0 else failures + 1 end,
         archived_at = case when p_gone or (not p_ok and failures + 1 >= 5) then now() end
   where id = p_subscription and archived_at is null;
$$;

-- RLS (rule 1), audit (rule 5), grants: a person reads only their own phones
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.push_subscription', 'NOTIFICATIONS', 'self', true);
select core.apply_domain_rls('ops.push_subscription');
select audit.enable('ops.push_subscription');
create trigger same_tenant before insert or update on ops.push_subscription
  for each row execute function hr.check_same_tenant();

revoke execute on function ops.push_endpoint_ok(text),
  ops.save_push_subscription(text, text, text, text), ops.remove_push_subscription(text),
  ops.push_due(int), ops.push_result(uuid, boolean, boolean)
  from public;
grant execute on function ops.save_push_subscription(text, text, text, text),
  ops.remove_push_subscription(text) to app_rw;
grant execute on function ops.push_due(int), ops.push_result(uuid, boolean, boolean)
  to wf_executor;

-- migrate:down
drop function ops.push_result(uuid, boolean, boolean);
drop function ops.push_due(int);
drop function ops.remove_push_subscription(text);
drop function ops.save_push_subscription(text, text, text, text);
drop function ops.push_endpoint_ok(text);
drop index ops.notification_unpushed;
alter table ops.notification drop column pushed_at;
delete from core.domain_table where table_name = 'ops.push_subscription'::regclass;
drop table ops.push_subscription;
