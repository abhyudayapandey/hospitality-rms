-- migrate:up
-- The compliance pack (ADR 069): a licence register and a compliance calendar, sold as their own
-- bundle. Licences (FSSAI, fire NOC, excise ...) have a number, an authority, dates, the job
-- role that renews them and their documents; renewing keeps the old one as history. Calendar
-- jobs (pest service, duct cleaning, fire drill ...) recur every 1 to 36 months, with an owner
-- role and, where the SOP asks, proof. Reminders are To do items: a licence's 90 days before it
-- expires (notices again at 30 and 7 days), a job's 14 days before it is due; overdue ones go up
-- like any task. Whoever a reminder goes to renews or marks it done from that item; the keepers
-- (COMPLIANCE modify: the outlet's manager, or a role given the duty) see and change it all.
--
-- Compliance is the first bundle that is out of a plan unless the platform admin puts it in, for
-- every customer, existing ones too: nobody gets it by default.

-- ---------------------------------------------------------------------------
-- The bundle and its module
-- ---------------------------------------------------------------------------
create or replace function core.module_codes() returns text[]
language sql immutable
as $$
  select array['checklists', 'compliance', 'events', 'leave', 'maintenance', 'menu_sales',
               'prep_lists', 'production', 'swaps'];
$$;

create or replace function core.bundle_codes() returns text[]
language sql immutable
as $$
  select array['compliance', 'people_roster', 'stock_cost', 'tasks_food_safety'];
$$;

create or replace function core.module_bundle(p_code text) returns text
language sql immutable
as $$
  select case p_code
           when 'production' then 'stock_cost'
           when 'prep_lists' then 'stock_cost'
           when 'menu_sales' then 'stock_cost'
           when 'leave' then 'people_roster'
           when 'swaps' then 'people_roster'
           when 'events' then 'people_roster'
           when 'checklists' then 'tasks_food_safety'
           when 'maintenance' then 'tasks_food_safety'
           when 'compliance' then 'compliance'
         end;
$$;

-- Whether a bundle is in a plan when the plan doesn't say: every bundle but Compliance.
create function core.bundle_default(p_bundle text) returns boolean
language sql immutable
as $$
  select p_bundle <> 'compliance';
$$;

create or replace function core.bundle_on(p_tenant uuid, p_bundle text) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce((select (t.settings -> 'bundles' ->> p_bundle)::boolean
                     from core.tenant t where t.id = p_tenant), core.bundle_default(p_bundle));
$$;

create or replace function platform.set_bundle(p_tenant uuid, p_bundle text, p_on boolean)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_was boolean;
  v_settings jsonb;
begin
  perform platform.current_admin();
  if p_bundle is null or not (p_bundle = any (core.bundle_codes())) or p_on is null then
    raise exception 'INVALID_BUNDLE' using detail = coalesce(p_bundle, '');
  end if;
  select t.settings,
         coalesce((t.settings -> 'bundles' ->> p_bundle)::boolean, core.bundle_default(p_bundle))
    into v_settings, v_was
    from core.tenant t where t.id = p_tenant
     for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  if v_was = p_on then
    return false;
  end if;
  v_settings := jsonb_set(v_settings, '{bundles}',
                          coalesce(v_settings -> 'bundles', '{}') || jsonb_build_object(p_bundle, p_on));
  if p_on then
    v_settings := jsonb_set(v_settings, '{modules}',
                            coalesce(v_settings -> 'modules', '{}')
                              - array(select c from unnest(core.module_codes()) c
                                       where core.module_bundle(c) = p_bundle));
  end if;
  update core.tenant set settings = v_settings where id = p_tenant;
  perform platform.log(case when p_on then 'bundle_on' else 'bundle_off' end, p_tenant, null,
                       jsonb_build_object('bundle', p_bundle));
  return true;
end $$;

-- The wizard's new screen "What they buy" (ADR 069) comes after Outlets.
alter table platform.setup_draft drop constraint setup_draft_step_check;
alter table platform.setup_draft add constraint setup_draft_step_check
  check (step in ('company', 'outlets', 'bundles', 'departments', 'roles', 'people', 'stock',
                  'review'));

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table ops.licence (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  -- the library's kind (FSSAI, FIRE_NOC ...) or the customer's own (OTHER)
  kind text not null check (kind ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  number text check (number is null or length(btrim(number)) between 1 and 80),
  authority text check (authority is null or length(btrim(authority)) between 1 and 120),
  issued_on date,
  expires_on date,
  renewal_role text not null,
  files text[] not null default '{}' check (cardinality(files) <= 5),
  -- the last notice sent before expiry: 90, 30 or 7 (days)
  noticed int check (noticed in (90, 30, 7)),
  replaced_by uuid references ops.licence(id),
  archived_at timestamptz,
  archived_by uuid references core.app_user(id),
  archive_reason text check (archive_reason is null or length(archive_reason) between 1 and 300),
  idempotency_key text,
  check (expires_on is null or issued_on is null or expires_on >= issued_on),
  check (replaced_by is null or archived_at is not null)
);
select core.add_standard_columns('ops.licence');
create unique index licence_idem on ops.licence (tenant_id, created_by, idempotency_key)
  where idempotency_key is not null;
create index licence_node on ops.licence (org_node_id) where archived_at is null;
create index licence_expiry on ops.licence (expires_on) where archived_at is null;

create table ops.compliance_item (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  name text not null check (length(btrim(name)) between 1 and 120),
  every_months int not null check (every_months in (1, 2, 3, 4, 6, 12, 24, 36)),
  next_due date not null,
  owner_role text not null,
  needs_proof boolean not null default false,
  -- from the product library (ADR 069), like a checklist copy (ADR 062)
  library_code text check (library_code ~ '^[A-Z][A-Z0-9-]*$'),
  library_version int check (library_version > 0),
  archived_at timestamptz,
  idempotency_key text,
  check ((library_code is null) = (library_version is null))
);
select core.add_standard_columns('ops.compliance_item');
create unique index compliance_item_idem on ops.compliance_item (tenant_id, created_by, idempotency_key)
  where idempotency_key is not null;
create index compliance_item_due on ops.compliance_item (next_due) where archived_at is null;

create table ops.compliance_done (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),
  item_id uuid not null references ops.compliance_item(id),
  due_on date not null,
  done_on date not null,
  files text[] not null default '{}' check (cardinality(files) <= 5),
  note text check (note is null or length(note) between 1 and 300)
);
select core.add_standard_columns('ops.compliance_done');
create index compliance_done_item on ops.compliance_done (item_id, done_on desc);

-- the reminders are To do items that point at what they are about
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check
  check (kind in ('one_off', 'checklist', 'prep', 'expiry', 'receive', 'licence', 'compliance'));
alter table ops.task
  add column licence_id uuid references ops.licence(id),
  add column compliance_item_id uuid references ops.compliance_item(id),
  add constraint task_licence check ((kind = 'licence') = (licence_id is not null)),
  add constraint task_compliance check ((kind = 'compliance') = (compliance_item_id is not null));
create unique index task_licence_open on ops.task (licence_id)
  where licence_id is not null and status in ('open', 'in_progress');
create unique index task_compliance_due on ops.task (compliance_item_id, due_at)
  where compliance_item_id is not null and status <> 'cancelled';

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

-- Where a licence or a calendar job may sit: an outlet or site, or a team place of one
-- (the engineering department's DG service). Raises otherwise.
create function ops.check_compliance_place(p_node uuid) returns void
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
begin
  if not exists (select 1 from core.hierarchy_node n
                  where n.id = p_node and n.tenant_id = core.my_tenant() and n.type = 'org'
                    and n.archived_at is null
                    and (n.kind in ('outlet', 'site') or core.is_team_place(n.id))) then
    perform ops.fail('INVALID_PLACE', 'an outlet or one of its departments');
  end if;
end $$;

-- Documents are uploaded under compliance/<tenant>/<outlet>/ (the app presigns only there).
create function ops.check_compliance_files(p_files text[], p_node uuid) returns void
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_f text;
  v_outlet uuid := coalesce(core.nearest(p_node, array['outlet', 'site']), p_node);
begin
  if cardinality(coalesce(p_files, '{}')) > 5 then
    perform ops.fail('INVALID_FILE', 'up to 5 documents');
  end if;
  foreach v_f in array coalesce(p_files, '{}') loop
    if v_f !~ ('^compliance/' || core.my_tenant() || '/' || v_outlet
               || '/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$') then
      perform ops.fail('INVALID_FILE', 'not an upload for this place');
    end if;
  end loop;
end $$;

-- The job role a reminder goes to: someone in it works there, or covers it (as any task).
create function ops.check_compliance_role(p_node uuid, p_role text) returns void
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
begin
  if p_role is null or not exists (select 1 from hr.job_role r
                                    where r.tenant_id = core.my_tenant() and r.code = p_role
                                      and r.archived_at is null) then
    perform ops.fail('INVALID_ASSIGNEE', 'not a job role of this company');
  end if;
  perform ops.check_assign(p_node, jsonb_build_object('mode', 'job_role', 'role', p_role));
end $$;

-- The outlet a place belongs to, for the presigned upload's key.
create function ops.compliance_upload_place(p_node uuid) returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
begin
  perform core.require_module('compliance');
  if not (core.can('COMPLIANCE', 'modify', p_node, null)
          or exists (select 1 from ops.task t
                      where t.org_node_id = p_node and t.kind in ('licence', 'compliance')
                        and t.status in ('open', 'in_progress')
                        and ops.can_work(t, core.current_user_id()))) then
    perform ops.fail('NOT_AUTHORISED', 'COMPLIANCE modify');
  end if;
  return coalesce(core.nearest(p_node, array['outlet', 'site']), p_node);
end $$;

-- A local date for a place.
create function ops.today_at(p_node uuid, p_now timestamptz default now()) returns date
language sql stable
set search_path = pg_catalog, ops
as $$
  select (p_now at time zone ops.tz_of(p_node))::date;
$$;

-- ---------------------------------------------------------------------------
-- Licences
-- ---------------------------------------------------------------------------

-- Adds a licence (p_id null) or corrects one. Keepers only.
create function ops.save_licence(p_id uuid, p_node uuid, p_kind text, p_name text, p_number text,
                                 p_authority text, p_issued date, p_expires date, p_role text,
                                 p_files text[], p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_me core.app_user := wf.me();
  v_old ops.licence;
  v_id uuid;
begin
  perform core.require_module('compliance');
  if p_id is null and p_idempotency_key is not null then
    select id into v_id from ops.licence
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_id; end if;
  end if;
  perform hr.require('COMPLIANCE', 'modify', p_node);
  perform ops.check_compliance_place(p_node);
  if p_id is not null then
    select * into v_old from ops.licence
     where id = p_id and tenant_id = v_me.tenant_id and archived_at is null for update;
    if not found then
      perform ops.fail('NOT_FOUND', 'no such licence');
    end if;
    perform hr.require('COMPLIANCE', 'modify', v_old.org_node_id);
  end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then
    perform ops.fail('INVALID_TITLE', 'the licence needs a name');
  end if;
  if p_expires is not null and p_issued is not null and p_expires < p_issued then
    perform ops.fail('INVALID_DATES', 'it expires before it was issued');
  end if;
  perform ops.check_compliance_role(p_node, p_role);
  perform ops.check_compliance_files(p_files, p_node);
  if p_id is null then
    insert into ops.licence (tenant_id, org_node_id, kind, name, number, authority, issued_on,
                             expires_on, renewal_role, files, idempotency_key)
    values (v_me.tenant_id, p_node, coalesce(nullif(p_kind, ''), 'OTHER'), btrim(p_name),
            nullif(btrim(p_number), ''), nullif(btrim(p_authority), ''), p_issued, p_expires,
            p_role, coalesce(p_files, '{}'), p_idempotency_key)
    returning id into v_id;
  else
    update ops.licence
       set org_node_id = p_node, kind = coalesce(nullif(p_kind, ''), kind), name = btrim(p_name),
           number = nullif(btrim(p_number), ''), authority = nullif(btrim(p_authority), ''),
           issued_on = p_issued, expires_on = p_expires, renewal_role = p_role,
           files = coalesce(p_files, '{}'),
           -- a new expiry date starts its notices again
           noticed = case when expires_on is distinct from p_expires then null else noticed end
     where id = p_id returning id into v_id;
    -- an open reminder follows the licence's new date and role
    update ops.task
       set due_at = (p_expires + time '10:00') at time zone ops.tz_of(p_node),
           job_role_code = p_role, org_node_id = p_node
     where licence_id = p_id and status in ('open', 'in_progress') and p_expires is not null;
    update ops.task set status = 'cancelled', cancel_reason = 'the licence no longer expires'
     where licence_id = p_id and status in ('open', 'in_progress') and p_expires is null;
  end if;
  return v_id;
end $$;

-- Renews a licence: a new one with the new dates and document; the old one is kept as history
-- (archived, replaced_by). Its keepers, or whoever its reminder is with.
create function ops.renew_licence(p_id uuid, p_number text, p_issued date, p_expires date,
                                  p_files text[]) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_me core.app_user := wf.me();
  v_old ops.licence;
  v_id uuid;
begin
  perform core.require_module('compliance');
  select * into v_old from ops.licence
   where id = p_id and tenant_id = v_me.tenant_id and archived_at is null for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such licence');
  end if;
  if not (core.can('COMPLIANCE', 'modify', v_old.org_node_id, null)
          or exists (select 1 from ops.task t
                      where t.licence_id = p_id and t.status in ('open', 'in_progress')
                        and ops.can_work(t, v_me.id))) then
    perform ops.fail('NOT_AUTHORISED', 'COMPLIANCE modify');
  end if;
  if p_expires is null or (p_issued is not null and p_expires < p_issued)
     or (v_old.expires_on is not null and p_expires <= v_old.expires_on) then
    perform ops.fail('INVALID_DATES', 'the new expiry is after the old one');
  end if;
  if cardinality(coalesce(p_files, '{}')) = 0 then
    perform ops.fail('DOCUMENT_NEEDED', 'add the renewed licence');
  end if;
  perform ops.check_compliance_files(p_files, v_old.org_node_id);
  insert into ops.licence (tenant_id, org_node_id, kind, name, number, authority, issued_on,
                           expires_on, renewal_role, files)
  values (v_old.tenant_id, v_old.org_node_id, v_old.kind, v_old.name,
          coalesce(nullif(btrim(p_number), ''), v_old.number), v_old.authority, p_issued,
          p_expires, v_old.renewal_role, p_files)
  returning id into v_id;
  update ops.licence set archived_at = now(), archived_by = v_me.id, replaced_by = v_id,
                         archive_reason = 'renewed'
   where id = p_id;
  update ops.task set status = 'done', completed_by = v_me.id, completed_at = now()
   where licence_id = p_id and status in ('open', 'in_progress');
  return v_id;
end $$;

-- A licence the outlet no longer needs. Keepers only; kept, never deleted.
create function ops.archive_licence(p_id uuid, p_reason text) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_me core.app_user := wf.me();
  v_l ops.licence;
begin
  perform core.require_module('compliance');
  select * into v_l from ops.licence
   where id = p_id and tenant_id = v_me.tenant_id and archived_at is null for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such licence');
  end if;
  perform hr.require('COMPLIANCE', 'modify', v_l.org_node_id);
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    perform ops.fail('INVALID_REASON', 'say why it is no longer needed');
  end if;
  update ops.licence set archived_at = now(), archived_by = v_me.id,
                         archive_reason = btrim(p_reason)
   where id = p_id;
  update ops.task set status = 'cancelled', cancel_reason = 'the licence was removed'
   where licence_id = p_id and status in ('open', 'in_progress');
end $$;

-- The licences the caller sees: at p_node and below, or everywhere they hold COMPLIANCE view
-- (p_node null). Current ones only; days_left is from the place's today (null: no expiry).
create function ops.licences(p_node uuid)
returns table (id uuid, org_node_id uuid, place_name text, kind text, name text, number text,
               authority text, issued_on date, expires_on date, days_left int,
               renewal_role text, renewal_role_name text, files text[], renewed_from date,
               open_task uuid)
language sql stable security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  select l.id, l.org_node_id, n.name, l.kind, l.name, l.number, l.authority, l.issued_on,
         l.expires_on, (l.expires_on - ops.today_at(l.org_node_id))::int, l.renewal_role,
         coalesce(r.name, l.renewal_role), l.files,
         (select p.expires_on from ops.licence p where p.replaced_by = l.id),
         (select t.id from ops.task t where t.licence_id = l.id
                                         and t.status in ('open', 'in_progress'))
    from ops.licence l
    join core.hierarchy_node n on n.id = l.org_node_id
    left join hr.job_role r on r.tenant_id = l.tenant_id and r.code = l.renewal_role
   where l.tenant_id = core.my_tenant() and l.archived_at is null
     and core.module_on(l.tenant_id, 'compliance')
     and core.can('COMPLIANCE', 'view', l.org_node_id, null)
     and (p_node is null or n.path operator(extensions.<@)
                            (select p.path from core.hierarchy_node p where p.id = p_node))
   order by l.expires_on nulls last, n.name, l.name;
$$;

-- One licence and its history, for whoever sees it or has its reminder.
create function ops.licence_history(p_id uuid)
returns table (id uuid, number text, issued_on date, expires_on date, files text[],
               archived_at timestamptz, archive_reason text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_l ops.licence;
begin
  select * into v_l from ops.licence x where x.id = p_id and x.tenant_id = core.my_tenant();
  if not found or not (core.can('COMPLIANCE', 'view', v_l.org_node_id, null)
                       or exists (select 1 from ops.task t where t.licence_id = p_id
                                     and ops.can_work(t, core.current_user_id()))) then
    perform ops.fail('NOT_FOUND', 'no such licence');
  end if;
  return query
    with recursive back as (
      select l.* from ops.licence l where l.id = p_id
      union all
      select p.* from ops.licence p join back b on p.replaced_by = b.id
    )
    select b.id, b.number, b.issued_on, b.expires_on, b.files, b.archived_at, b.archive_reason
      from back b order by b.expires_on desc nulls first;
end $$;

-- ---------------------------------------------------------------------------
-- The compliance calendar
-- ---------------------------------------------------------------------------

create function ops.save_compliance_item(p_id uuid, p_node uuid, p_name text, p_every int,
                                         p_next_due date, p_role text, p_needs_proof boolean,
                                         p_idempotency_key text default null) returns uuid
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_me core.app_user := wf.me();
  v_old ops.compliance_item;
  v_id uuid;
begin
  perform core.require_module('compliance');
  if p_id is null and p_idempotency_key is not null then
    select id into v_id from ops.compliance_item
     where tenant_id = v_me.tenant_id and created_by = v_me.id
       and idempotency_key = p_idempotency_key;
    if found then return v_id; end if;
  end if;
  perform hr.require('COMPLIANCE', 'modify', p_node);
  perform ops.check_compliance_place(p_node);
  if p_id is not null then
    select * into v_old from ops.compliance_item
     where id = p_id and tenant_id = v_me.tenant_id and archived_at is null for update;
    if not found then
      perform ops.fail('NOT_FOUND', 'no such job');
    end if;
    perform hr.require('COMPLIANCE', 'modify', v_old.org_node_id);
  end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then
    perform ops.fail('INVALID_TITLE', 'the job needs a name');
  end if;
  if p_every is null or p_every not in (1, 2, 3, 4, 6, 12, 24, 36) then
    perform ops.fail('INVALID_SCHEDULE', 'every 1, 2, 3, 4, 6, 12, 24 or 36 months');
  end if;
  if p_next_due is null then
    perform ops.fail('INVALID_DATES', 'when it is next due');
  end if;
  perform ops.check_compliance_role(p_node, p_role);
  if p_id is null then
    insert into ops.compliance_item (tenant_id, org_node_id, name, every_months, next_due,
                                     owner_role, needs_proof, idempotency_key)
    values (v_me.tenant_id, p_node, btrim(p_name), p_every, p_next_due, p_role,
            coalesce(p_needs_proof, false), p_idempotency_key)
    returning id into v_id;
  else
    update ops.compliance_item
       set org_node_id = p_node, name = btrim(p_name), every_months = p_every,
           next_due = p_next_due, owner_role = p_role,
           needs_proof = coalesce(p_needs_proof, false)
     where id = p_id returning id into v_id;
    -- an open reminder follows the job's new date and owner
    update ops.task
       set due_at = (p_next_due + time '10:00') at time zone ops.tz_of(p_node),
           job_role_code = p_role, org_node_id = p_node, title = btrim(p_name)
     where compliance_item_id = p_id and status in ('open', 'in_progress');
  end if;
  return v_id;
end $$;

create function ops.archive_compliance_item(p_id uuid) returns void
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_i ops.compliance_item;
begin
  perform core.require_module('compliance');
  select * into v_i from ops.compliance_item
   where id = p_id and tenant_id = core.my_tenant() and archived_at is null for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such job');
  end if;
  perform hr.require('COMPLIANCE', 'modify', v_i.org_node_id);
  update ops.compliance_item set archived_at = now() where id = p_id;
  update ops.task set status = 'cancelled', cancel_reason = 'the job was removed'
   where compliance_item_id = p_id and status in ('open', 'in_progress');
end $$;

-- Marks a calendar job done: who and when, its proof (required where the job asks for it),
-- and the next due date (that many months after it was done). Its keepers, or whoever its
-- reminder is with.
create function ops.mark_compliance_done(p_id uuid, p_done_on date, p_files text[],
                                         p_note text) returns date
language plpgsql security definer
set search_path = pg_catalog, core, ops, hr
as $$
declare
  v_me core.app_user := wf.me();
  v_i ops.compliance_item;
  v_next date;
begin
  perform core.require_module('compliance');
  select * into v_i from ops.compliance_item
   where id = p_id and tenant_id = v_me.tenant_id and archived_at is null for update;
  if not found then
    perform ops.fail('NOT_FOUND', 'no such job');
  end if;
  if not (core.can('COMPLIANCE', 'modify', v_i.org_node_id, null)
          or exists (select 1 from ops.task t
                      where t.compliance_item_id = p_id and t.status in ('open', 'in_progress')
                        and ops.can_work(t, v_me.id))) then
    perform ops.fail('NOT_AUTHORISED', 'COMPLIANCE modify');
  end if;
  if p_done_on is null or p_done_on > ops.today_at(v_i.org_node_id) then
    perform ops.fail('INVALID_DATES', 'when it was done, not later than today');
  end if;
  if v_i.needs_proof and cardinality(coalesce(p_files, '{}')) = 0 then
    perform ops.fail('DOCUMENT_NEEDED', 'add the report or certificate');
  end if;
  perform ops.check_compliance_files(p_files, v_i.org_node_id);
  insert into ops.compliance_done (tenant_id, org_node_id, item_id, due_on, done_on, files, note)
  values (v_i.tenant_id, v_i.org_node_id, p_id, v_i.next_due, p_done_on,
          coalesce(p_files, '{}'), nullif(btrim(p_note), ''));
  v_next := (p_done_on + make_interval(months => v_i.every_months))::date;
  update ops.compliance_item set next_due = v_next where id = p_id;
  update ops.task set status = 'done', completed_by = v_me.id, completed_at = now()
   where compliance_item_id = p_id and status in ('open', 'in_progress');
  return v_next;
end $$;

-- The calendar jobs the caller sees, as ops.licences.
create function ops.compliance_items(p_node uuid)
returns table (id uuid, org_node_id uuid, place_name text, name text, every_months int,
               next_due date, days_left int, owner_role text, owner_role_name text,
               needs_proof boolean, last_done date, last_files text[], open_task uuid)
language sql stable security definer
set search_path = pg_catalog, core, ops, extensions
as $$
  select i.id, i.org_node_id, n.name, i.name, i.every_months, i.next_due,
         (i.next_due - ops.today_at(i.org_node_id))::int, i.owner_role,
         coalesce(r.name, i.owner_role), i.needs_proof, d.done_on, d.files,
         (select t.id from ops.task t where t.compliance_item_id = i.id
                                         and t.status in ('open', 'in_progress')
           order by t.due_at limit 1)
    from ops.compliance_item i
    join core.hierarchy_node n on n.id = i.org_node_id
    left join hr.job_role r on r.tenant_id = i.tenant_id and r.code = i.owner_role
    left join lateral (select x.done_on, x.files from ops.compliance_done x
                        where x.item_id = i.id order by x.done_on desc, x.created_at desc
                        limit 1) d on true
   where i.tenant_id = core.my_tenant() and i.archived_at is null
     and core.module_on(i.tenant_id, 'compliance')
     and core.can('COMPLIANCE', 'view', i.org_node_id, null)
     and (p_node is null or n.path operator(extensions.<@)
                            (select p.path from core.hierarchy_node p where p.id = p_node))
   order by i.next_due, n.name, i.name;
$$;

-- A job's past: when it was due, when done, by whom, with what proof.
create function ops.compliance_history(p_id uuid)
returns table (due_on date, done_on date, done_by text, files text[], note text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_i ops.compliance_item;
begin
  select * into v_i from ops.compliance_item where id = p_id and tenant_id = core.my_tenant();
  if not found or not (core.can('COMPLIANCE', 'view', v_i.org_node_id, null)
                       or exists (select 1 from ops.task t where t.compliance_item_id = p_id
                                     and ops.can_work(t, core.current_user_id()))) then
    perform ops.fail('NOT_FOUND', 'no such job');
  end if;
  return query
    select d.due_on, d.done_on, u.display_name, d.files, d.note
      from ops.compliance_done d join core.app_user u on u.id = d.created_by
     where d.item_id = p_id order by d.done_on desc, d.created_at desc;
end $$;

-- What a To do item about a licence or a calendar job points at, for whoever it is with.
create function ops.compliance_task(p_task uuid)
returns table (licence_id uuid, item_id uuid, name text, place_name text, number text,
               authority text, expires_on date, next_due date, every_months int,
               needs_proof boolean, can_act boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task
   where id = p_task and tenant_id = core.my_tenant() and kind in ('licence', 'compliance');
  if not found or not (core.can('TASKS', 'view', v_t.org_node_id, null)
                       or ops.can_work(v_t, core.current_user_id())
                       or core.can('COMPLIANCE', 'view', v_t.org_node_id, null)) then
    perform ops.fail('NOT_FOUND', 'no such task');
  end if;
  return query
    select l.id, i.id, coalesce(l.name, i.name), n.name, l.number, l.authority, l.expires_on,
           i.next_due, i.every_months, coalesce(i.needs_proof, true),
           v_t.status in ('open', 'in_progress')
             and (ops.can_work(v_t, core.current_user_id())
                  or core.can('COMPLIANCE', 'modify', v_t.org_node_id, null))
      from (select 1) one
      left join ops.licence l on l.id = v_t.licence_id
      left join ops.compliance_item i on i.id = v_t.compliance_item_id
      join core.hierarchy_node n on n.id = v_t.org_node_id;
end $$;

-- Home's Needs attention and the screen's tabs: counted in SQL over what the caller sees.
create function ops.compliance_counts(p_node uuid)
returns table (licences int, expiring int, items int, overdue int)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select (select count(*)::int from ops.licences(p_node)),
         (select count(*)::int from ops.licences(p_node) where days_left <= 90),
         (select count(*)::int from ops.compliance_items(p_node)),
         (select count(*)::int from ops.compliance_items(p_node) where days_left < 0);
$$;

-- ---------------------------------------------------------------------------
-- Reminders (the tasks job, every 5 minutes)
-- ---------------------------------------------------------------------------

-- A licence's To do item 90 days before it expires, due on the day (overdue goes up like any
-- task: to whoever set it, then the place's leads); notices again at 30 and 7 days. A calendar
-- job's item 14 days before it is due. Only where Compliance is on.
create function ops.compliance_tick(p_now timestamptz default now())
returns table (created int, noticed int)
language plpgsql security definer
set search_path = pg_catalog, core, ops
as $$
declare
  v_l record;
  v_i record;
  v_t ops.task;
  v_created int := 0;
  v_noticed int := 0;
  v_left int;
  v_due timestamptz;
begin
  for v_l in
    select l.* from ops.licence l
      join core.hierarchy_node n on n.id = l.org_node_id and n.archived_at is null
     where l.archived_at is null and l.expires_on is not null
       and core.tenant_active(l.tenant_id) and core.module_on(l.tenant_id, 'compliance')
       and l.expires_on - ops.today_at(l.org_node_id, p_now) <= 90
     for update of l skip locked
  loop
    v_left := v_l.expires_on - ops.today_at(v_l.org_node_id, p_now);
    v_due := (v_l.expires_on + time '10:00') at time zone ops.tz_of(v_l.org_node_id);
    select * into v_t from ops.task
     where licence_id = v_l.id and status in ('open', 'in_progress');
    if not found then
      insert into ops.task (tenant_id, org_node_id, kind, title, description, due_at, priority,
                            assign_mode, job_role_code, assigned_by, licence_id)
      values (v_l.tenant_id, v_l.org_node_id, 'licence', 'Renew: ' || v_l.name,
              'Expires ' || to_char(v_l.expires_on, 'FMDD Mon YYYY')
                || coalesce(' · ' || v_l.number, ''),
              v_due, 'high', 'job_role', v_l.renewal_role,
              coalesce(v_l.updated_by, v_l.created_by), v_l.id)
      on conflict do nothing
      returning * into v_t;
      if v_t.id is not null then
        v_created := v_created + 1;
        perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'licence_expiring',
                                'Licence expires in ' || v_left || ' days: ' || v_l.name);
        update ops.licence set noticed = 90 where id = v_l.id;
      end if;
    elsif v_left <= 7 and coalesce(v_l.noticed, 90) > 7
       or v_left <= 30 and coalesce(v_l.noticed, 90) > 30 then
      perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'licence_expiring',
                              case when v_left < 0 then 'Licence expired: '
                                   else 'Licence expires in ' || v_left || ' days: ' end
                                || v_l.name);
      update ops.licence set noticed = case when v_left <= 7 then 7 else 30 end
       where id = v_l.id;
      v_noticed := v_noticed + 1;
    end if;
  end loop;

  for v_i in
    select i.* from ops.compliance_item i
      join core.hierarchy_node n on n.id = i.org_node_id and n.archived_at is null
     where i.archived_at is null
       and core.tenant_active(i.tenant_id) and core.module_on(i.tenant_id, 'compliance')
       and i.next_due - ops.today_at(i.org_node_id, p_now) <= 14
       and not exists (select 1 from ops.task t where t.compliance_item_id = i.id
                                                   and t.status in ('open', 'in_progress'))
  loop
    insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode,
                          job_role_code, assigned_by, compliance_item_id)
    values (v_i.tenant_id, v_i.org_node_id, 'compliance', v_i.name,
            (v_i.next_due + time '10:00') at time zone ops.tz_of(v_i.org_node_id),
            'job_role', v_i.owner_role, coalesce(v_i.updated_by, v_i.created_by), v_i.id)
    on conflict do nothing
    returning * into v_t;
    if v_t.id is not null then
      v_created := v_created + 1;
      perform ops.notify_task(v_t, array(select ops.task_people(v_t)), 'compliance_due',
                              'Due ' || to_char(v_i.next_due, 'FMDD Mon') || ': ' || v_i.name);
    end if;
  end loop;
  return query select v_created, v_noticed;
end $$;

-- ---------------------------------------------------------------------------
-- The Compliance screen's places: outlets and sites where the caller holds COMPLIANCE view
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('core.screen_places(text)'::regprocedure);
  v_new text;
begin
  v_new := replace(v_def, $a$'team_people', 'team_leave', 'pos_import', 'check', 'bills') then$a$,
                          $a$'team_people', 'team_leave', 'pos_import', 'check', 'bills', 'compliance') then$a$);
  v_new := replace(v_new, $a$         when p_screen = 'events' then$a$,
                          $a$         when p_screen = 'compliance' then
           n.type = 'org' and n.kind in ('outlet', 'site')
           and core.can('COMPLIANCE', 'view', n.id, null)
         when p_screen = 'events' then$a$);
  if length(v_new) - length(v_def) < 120 then
    raise exception 'core.screen_places did not take the compliance screen';
  end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- RLS (rule 1), audit (rule 5), grants
-- ---------------------------------------------------------------------------
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.licence', 'COMPLIANCE', 'org', true),
  ('ops.compliance_item', 'COMPLIANCE', 'org', true),
  ('ops.compliance_done', 'COMPLIANCE', 'org', true);
select core.apply_domain_rls('ops.licence');
select core.apply_domain_rls('ops.compliance_item');
select core.apply_domain_rls('ops.compliance_done');
select audit.enable('ops.licence');
select audit.enable('ops.compliance_item');
select audit.enable('ops.compliance_done');

revoke execute on function core.bundle_default(text), ops.check_compliance_place(uuid),
  ops.check_compliance_files(text[], uuid), ops.check_compliance_role(uuid, text),
  ops.compliance_upload_place(uuid), ops.today_at(uuid, timestamptz),
  ops.save_licence(uuid, uuid, text, text, text, text, date, date, text, text[], text),
  ops.renew_licence(uuid, text, date, date, text[]), ops.archive_licence(uuid, text),
  ops.licences(uuid), ops.licence_history(uuid),
  ops.save_compliance_item(uuid, uuid, text, int, date, text, boolean, text),
  ops.archive_compliance_item(uuid), ops.mark_compliance_done(uuid, date, text[], text),
  ops.compliance_items(uuid), ops.compliance_history(uuid), ops.compliance_task(uuid),
  ops.compliance_counts(uuid), ops.compliance_tick(timestamptz) from public;
grant execute on function core.bundle_default(text), ops.compliance_upload_place(uuid),
  ops.save_licence(uuid, uuid, text, text, text, text, date, date, text, text[], text),
  ops.renew_licence(uuid, text, date, date, text[]), ops.archive_licence(uuid, text),
  ops.licences(uuid), ops.licence_history(uuid),
  ops.save_compliance_item(uuid, uuid, text, int, date, text, boolean, text),
  ops.archive_compliance_item(uuid), ops.mark_compliance_done(uuid, date, text[], text),
  ops.compliance_items(uuid), ops.compliance_history(uuid), ops.compliance_task(uuid),
  ops.compliance_counts(uuid) to app_rw;
grant execute on function ops.compliance_tick(timestamptz) to wf_executor;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function ops.compliance_tick(timestamptz), ops.compliance_counts(uuid),
  ops.compliance_task(uuid), ops.compliance_history(uuid), ops.compliance_items(uuid),
  ops.mark_compliance_done(uuid, date, text[], text), ops.archive_compliance_item(uuid),
  ops.save_compliance_item(uuid, uuid, text, int, date, text, boolean, text),
  ops.licence_history(uuid), ops.licences(uuid), ops.archive_licence(uuid, text),
  ops.renew_licence(uuid, text, date, date, text[]),
  ops.save_licence(uuid, uuid, text, text, text, text, date, date, text, text[], text),
  ops.today_at(uuid, timestamptz), ops.compliance_upload_place(uuid),
  ops.check_compliance_role(uuid, text), ops.check_compliance_files(text[], uuid),
  ops.check_compliance_place(uuid);
do $$
declare
  v_def text := pg_get_functiondef('core.screen_places(text)'::regprocedure);
begin
  v_def := replace(v_def, $a$, 'bills', 'compliance') then$a$, $a$, 'bills') then$a$);
  v_def := regexp_replace(v_def, $a$\s+when p_screen = 'compliance' then.*?COMPLIANCE', 'view', n.id, null\)$a$, '', 's');
  execute v_def;
end $$;
delete from ops.task where kind in ('licence', 'compliance');
drop index ops.task_compliance_due;
drop index ops.task_licence_open;
alter table ops.task drop constraint task_compliance, drop constraint task_licence,
  drop column compliance_item_id, drop column licence_id;
alter table ops.task drop constraint task_kind_check;
alter table ops.task add constraint task_kind_check
  check (kind in ('one_off', 'checklist', 'prep', 'expiry', 'receive'));
delete from core.domain_table
 where table_name in ('ops.licence', 'ops.compliance_item', 'ops.compliance_done');
drop table ops.compliance_done;
drop table ops.compliance_item;
drop table ops.licence;
update platform.setup_draft set step = 'outlets' where step = 'bundles';
alter table platform.setup_draft drop constraint setup_draft_step_check;
alter table platform.setup_draft add constraint setup_draft_step_check
  check (step in ('company', 'outlets', 'departments', 'roles', 'people', 'stock', 'review'));
create or replace function platform.set_bundle(p_tenant uuid, p_bundle text, p_on boolean)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, core, platform
as $$
declare
  v_was boolean;
  v_settings jsonb;
begin
  perform platform.current_admin();
  if p_bundle is null or not (p_bundle = any (core.bundle_codes())) or p_on is null then
    raise exception 'INVALID_BUNDLE' using detail = coalesce(p_bundle, '');
  end if;
  select t.settings, coalesce((t.settings -> 'bundles' ->> p_bundle)::boolean, true)
    into v_settings, v_was
    from core.tenant t where t.id = p_tenant
     for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  if v_was = p_on then
    return false;
  end if;
  v_settings := jsonb_set(v_settings, '{bundles}',
                          coalesce(v_settings -> 'bundles', '{}') || jsonb_build_object(p_bundle, p_on));
  if p_on then
    v_settings := jsonb_set(v_settings, '{modules}',
                            coalesce(v_settings -> 'modules', '{}')
                              - array(select c from unnest(core.module_codes()) c
                                       where core.module_bundle(c) = p_bundle));
  end if;
  update core.tenant set settings = v_settings where id = p_tenant;
  perform platform.log(case when p_on then 'bundle_on' else 'bundle_off' end, p_tenant, null,
                       jsonb_build_object('bundle', p_bundle));
  return true;
end $$;
create or replace function core.bundle_on(p_tenant uuid, p_bundle text) returns boolean
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce((select (t.settings -> 'bundles' ->> p_bundle)::boolean
                     from core.tenant t where t.id = p_tenant), true);
$$;
drop function core.bundle_default(text);
create or replace function core.module_bundle(p_code text) returns text
language sql immutable
as $$
  select case p_code
           when 'production' then 'stock_cost'
           when 'prep_lists' then 'stock_cost'
           when 'menu_sales' then 'stock_cost'
           when 'leave' then 'people_roster'
           when 'swaps' then 'people_roster'
           when 'events' then 'people_roster'
           when 'checklists' then 'tasks_food_safety'
           when 'maintenance' then 'tasks_food_safety'
         end;
$$;
create or replace function core.bundle_codes() returns text[]
language sql immutable
as $$
  select array['people_roster', 'stock_cost', 'tasks_food_safety'];
$$;
create or replace function core.module_codes() returns text[]
language sql immutable
as $$
  select array['checklists', 'events', 'leave', 'maintenance', 'menu_sales', 'prep_lists',
               'production', 'swaps'];
$$;
