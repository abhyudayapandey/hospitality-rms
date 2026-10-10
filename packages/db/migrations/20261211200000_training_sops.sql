-- migrate:up
-- Training & SOPs (ADR 095), the Training block (ADR 085, domain TRAINING, org tree).
--
-- * The SOP library (file 46): a standard operating procedure at a place (the outlet or a
--   department), for some job roles (none listed: everyone there), with its text. A handbook
--   may need "I've read this", which is kept per person and version: a new version asks again.
--   Me → SOPs lists the ones for me and opens them.
-- * Training sessions at a place: a title, when, who trains; each person's attendance and, for
--   a test, their score. Whoever holds TRAINING modify there (HR, the department head, the
--   outlet's managers) keeps them, and sees who has read each SOP that needs it.
-- * Induction for a new joiner is a checklist (ADR 020) given to them; nothing new here.

create table ops.sop (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_.-]*$'),
  title text not null check (length(btrim(title)) between 1 and 120),
  body text not null check (length(body) between 1 and 20000),
  roles text[] not null default '{}',
  needs_ack boolean not null default false,
  version int not null default 1 check (version >= 1),
  archived_at timestamptz
);
select core.add_standard_columns('ops.sop');
create unique index sop_code on ops.sop (tenant_id, code);

create table ops.sop_ack (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the SOP's place
  sop_id uuid not null references ops.sop(id),
  user_id uuid not null references core.app_user(id),
  version int not null,
  acked_at timestamptz not null default now(),
  unique (sop_id, user_id, version)
);
select core.add_standard_columns('ops.sop_ack');

create table ops.training_session (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  title text not null check (length(btrim(title)) between 1 and 120),
  starts_at timestamptz not null,
  trainer text check (length(trainer) <= 80),
  is_test boolean not null default false,
  note text check (length(note) <= 500)
);
select core.add_standard_columns('ops.training_session');
create index training_session_place on ops.training_session (org_node_id, starts_at desc);

create table ops.training_attendance (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the session's place
  session_id uuid not null references ops.training_session(id),
  person_id uuid not null references core.app_user(id),
  attended boolean not null,
  score numeric(5,1) check (score between 0 and 100),
  unique (session_id, person_id)
);
select core.add_standard_columns('ops.training_attendance');

-- A version bump when what an SOP says changes, so "I've read this" is asked again. The
-- loader writes body and title; this keeps the version honest whoever writes them.
create function ops.sop_version() returns trigger
language plpgsql
as $$
begin
  if (new.body, new.title) is distinct from (old.body, old.title) then
    new.version := old.version + 1;
  end if;
  return new;
end $$;
create trigger sop_version before update on ops.sop
  for each row execute function ops.sop_version();

-- Whether an SOP is for me: I work at its place or below it, in one of its roles (none: all).
create function ops.sop_is_mine(p_sop ops.sop) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, extensions
as $$
  select exists (
    select 1 from hr.worker w
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node p on p.id = p_sop.org_node_id
     where w.owner_user_id = core.current_user_id() and w.status = 'active'
       and h.path operator(extensions.<@) p.path
       and (cardinality(p_sop.roles) = 0 or w.role_code = any (p_sop.roles)));
$$;

-- My SOPs: the ones for me while Training is on, with whether I have read this version.
create function ops.my_sops()
returns table (id uuid, title text, place text, needs_ack boolean, version int, acked boolean)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select s.id, s.title, n.name, s.needs_ack, s.version,
         exists (select 1 from ops.sop_ack a
                  where a.sop_id = s.id and a.user_id = core.current_user_id()
                    and a.version = s.version)
    from ops.sop s join core.hierarchy_node n on n.id = s.org_node_id
   where s.tenant_id = core.my_tenant() and s.archived_at is null
     and core.module_on(s.tenant_id, 'training')
     and ops.sop_is_mine(s)
   order by (s.needs_ack and not exists (select 1 from ops.sop_ack a
                                          where a.sop_id = s.id
                                            and a.user_id = core.current_user_id()
                                            and a.version = s.version)) desc,
            s.title;
$$;

-- One SOP: for me, or for whoever keeps training at its place.
create function ops.sop_page(p_sop uuid)
returns table (id uuid, title text, body text, place text, needs_ack boolean, version int,
               acked_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
#variable_conflict use_column
declare
  v_s ops.sop;
begin
  select * into v_s from ops.sop
   where id = p_sop and tenant_id = core.my_tenant() and archived_at is null;
  if v_s.id is null or not core.module_on(v_s.tenant_id, 'training')
     or not (ops.sop_is_mine(v_s) or core.can('TRAINING', 'view', v_s.org_node_id, null)) then
    perform ops.fail('NOT_AUTHORISED', 'that SOP');
  end if;
  return query
    select v_s.id, v_s.title, v_s.body,
           (select n.name from core.hierarchy_node n where n.id = v_s.org_node_id),
           v_s.needs_ack, v_s.version,
           (select a.acked_at from ops.sop_ack a
             where a.sop_id = v_s.id and a.user_id = core.current_user_id()
               and a.version = v_s.version);
end $$;

-- "I've read this", for an SOP that is mine and needs it.
create function ops.ack_sop(p_sop uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_s ops.sop;
begin
  select * into v_s from ops.sop
   where id = p_sop and tenant_id = core.my_tenant() and archived_at is null;
  if v_s.id is null or not core.module_on(v_s.tenant_id, 'training')
     or not ops.sop_is_mine(v_s) then
    perform ops.fail('NOT_AUTHORISED', 'that SOP');
  end if;
  if not v_s.needs_ack then
    perform ops.fail('INVALID_STATE', 'nothing to confirm');
  end if;
  insert into ops.sop_ack (tenant_id, org_node_id, sop_id, user_id, version)
  values (v_s.tenant_id, v_s.org_node_id, v_s.id, core.current_user_id(), v_s.version)
  on conflict (sop_id, user_id, version) do nothing;
end $$;

-- The places where I keep training.
create function ops.training_places()
returns table (place_id uuid, name text, kind text, people jsonb)
language sql stable security definer
set search_path = pg_catalog, core, ops, hr, extensions
as $$
  select n.id, n.name, n.kind,
         coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.display_name)
                                    order by a.display_name)
                     from hr.worker w
                     join core.hierarchy_node h on h.id = w.org_node_id
                     join core.app_user a on a.id = w.owner_user_id
                    where w.status = 'active' and h.path operator(extensions.<@) n.path),
                  '[]')
    from core.hierarchy_node n
   where n.tenant_id = core.my_tenant() and n.type = 'org' and n.archived_at is null
     and n.kind in ('outlet', 'department')
     and core.can('TRAINING', 'modify', n.id, null)
   order by (n.kind = 'outlet') desc, n.name;
$$;

create function ops.add_training_session(p_place uuid, p_title text, p_starts_at timestamptz,
                                         p_trainer text, p_is_test boolean, p_note text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from core.hierarchy_node
                  where id = p_place and tenant_id = core.my_tenant() and type = 'org'
                    and kind in ('outlet', 'department') and archived_at is null)
     or not core.can('TRAINING', 'modify', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'TRAINING modify');
  end if;
  if nullif(btrim(p_title), '') is null or p_starts_at is null then
    perform ops.fail('INVALID_VALUE', 'what and when');
  end if;
  insert into ops.training_session (tenant_id, org_node_id, title, starts_at, trainer, is_test,
                                    note)
  values (core.my_tenant(), p_place, btrim(p_title), p_starts_at,
          left(nullif(btrim(p_trainer), ''), 80), coalesce(p_is_test, false),
          left(nullif(btrim(p_note), ''), 500))
  returning id into v_id;
  return v_id;
end $$;

-- Someone's attendance at a session, and their score on a test; saving again corrects it.
create function ops.mark_attendance(p_session uuid, p_person uuid, p_attended boolean,
                                    p_score numeric)
returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr, extensions
as $$
declare
  v_s ops.training_session;
begin
  select * into v_s from ops.training_session
   where id = p_session and tenant_id = core.my_tenant();
  if not found then
    perform ops.fail('NOT_FOUND', 'no such session');
  end if;
  if not core.can('TRAINING', 'modify', v_s.org_node_id, null) then
    perform ops.fail('NOT_AUTHORISED', 'TRAINING modify');
  end if;
  if not exists (select 1 from hr.worker w
                   join core.hierarchy_node h on h.id = w.org_node_id
                   join core.hierarchy_node p on p.id = v_s.org_node_id
                  where w.owner_user_id = p_person and w.status = 'active'
                    and h.path operator(extensions.<@) p.path) then
    perform ops.fail('INVALID_VALUE', 'someone who works there');
  end if;
  if p_score is not null and (not v_s.is_test or p_score < 0 or p_score > 100
                              or not coalesce(p_attended, false)) then
    perform ops.fail('INVALID_VALUE', 'a score is for a test someone sat, 0 to 100');
  end if;
  insert into ops.training_attendance (tenant_id, org_node_id, session_id, person_id, attended,
                                       score)
  values (v_s.tenant_id, v_s.org_node_id, v_s.id, p_person, coalesce(p_attended, false),
          p_score)
  on conflict (session_id, person_id) do update
    set attended = excluded.attended, score = excluded.score;
end $$;

-- A place's sessions of the last p_days days and the next 60, with who attended and scores.
create function ops.training_sessions(p_place uuid, p_days int default 90)
returns table (id uuid, title text, starts_at timestamptz, trainer text, is_test boolean,
               note text, attendance jsonb)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
#variable_conflict use_column
begin
  if not core.can('TRAINING', 'view', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'TRAINING view');
  end if;
  return query
    select s.id, s.title, s.starts_at, s.trainer, s.is_test, s.note,
           coalesce((select jsonb_agg(jsonb_build_object(
                              'person_id', a.person_id, 'attended', a.attended,
                              'score', a.score,
                              'name', (select u.display_name from core.app_user u
                                        where u.id = a.person_id))
                              order by 4)
                       from ops.training_attendance a where a.session_id = s.id), '[]')
      from ops.training_session s
     where s.org_node_id = p_place and s.tenant_id = core.my_tenant()
       and s.starts_at > now() - make_interval(days => p_days)
       and s.starts_at < now() + interval '60 days'
     order by s.starts_at desc;
end $$;

-- Who has read each SOP that needs it, at a place and below: its people and how many read it.
create function ops.sop_reading(p_place uuid)
returns table (sop_id uuid, title text, version int, people int, acked int, not_yet jsonb)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops, hr, extensions
as $$
#variable_conflict use_column
begin
  if not core.can('TRAINING', 'view', p_place, null) then
    perform ops.fail('NOT_AUTHORISED', 'TRAINING view');
  end if;
  return query
    with p as (select path from core.hierarchy_node where id = p_place),
    s as (select x.* from ops.sop x, p
           join core.hierarchy_node sn on true
          where x.tenant_id = core.my_tenant() and x.archived_at is null and x.needs_ack
            and sn.id = x.org_node_id
            and (sn.path operator(extensions.<@) p.path or p.path operator(extensions.<@) sn.path)),
    f as (select s.id as sop_id, w.owner_user_id as user_id
            from s
            join core.hierarchy_node sn on sn.id = s.org_node_id
            join hr.worker w on w.status = 'active'
            join core.hierarchy_node h on h.id = w.org_node_id
                                      and h.path operator(extensions.<@) sn.path
            , p
           where h.path operator(extensions.<@) p.path
             and (cardinality(s.roles) = 0 or w.role_code = any (s.roles)))
    select s.id, s.title, s.version, count(distinct f.user_id)::int,
           count(distinct a.user_id)::int,
           coalesce(jsonb_agg(distinct u.display_name)
                      filter (where a.user_id is null and u.id is not null), '[]')
      from s
      left join f on f.sop_id = s.id
      left join ops.sop_ack a on a.sop_id = s.id and a.user_id = f.user_id
                             and a.version = s.version
      left join core.app_user u on u.id = f.user_id
     group by s.id, s.title, s.version
     order by s.title;
end $$;

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.sop', 'TRAINING', 'org', true),
  ('ops.sop_ack', 'TRAINING', 'org', true),
  ('ops.training_session', 'TRAINING', 'org', true),
  ('ops.training_attendance', 'TRAINING', 'org', true);
select core.apply_domain_rls(t) from unnest(array['ops.sop', 'ops.sop_ack',
  'ops.training_session', 'ops.training_attendance']) t;
select audit.enable(t) from unnest(array['ops.sop', 'ops.sop_ack',
  'ops.training_session', 'ops.training_attendance']) t;

revoke execute on function ops.sop_is_mine(ops.sop), ops.my_sops(), ops.sop_page(uuid),
  ops.ack_sop(uuid), ops.training_places(),
  ops.add_training_session(uuid, text, timestamptz, text, boolean, text),
  ops.mark_attendance(uuid, uuid, boolean, numeric), ops.training_sessions(uuid, int),
  ops.sop_reading(uuid)
  from public, platform_loader;
grant execute on function ops.my_sops(), ops.sop_page(uuid), ops.ack_sop(uuid),
  ops.training_places(),
  ops.add_training_session(uuid, text, timestamptz, text, boolean, text),
  ops.mark_attendance(uuid, uuid, boolean, numeric), ops.training_sessions(uuid, int),
  ops.sop_reading(uuid)
  to app_rw;
grant select, insert, update on ops.sop to platform_loader;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
revoke select, insert, update on ops.sop from platform_loader;
drop function ops.sop_reading(uuid);
drop function ops.training_sessions(uuid, int);
drop function ops.mark_attendance(uuid, uuid, boolean, numeric);
drop function ops.add_training_session(uuid, text, timestamptz, text, boolean, text);
drop function ops.training_places();
drop function ops.ack_sop(uuid);
drop function ops.sop_page(uuid);
drop function ops.my_sops();
drop function ops.sop_is_mine(ops.sop);
drop trigger sop_version on ops.sop;
drop function ops.sop_version();
delete from core.domain_table where table_name in ('ops.sop'::regclass,
  'ops.sop_ack'::regclass, 'ops.training_session'::regclass,
  'ops.training_attendance'::regclass);
drop table ops.training_attendance;
drop table ops.training_session;
drop table ops.sop_ack;
drop table ops.sop;
