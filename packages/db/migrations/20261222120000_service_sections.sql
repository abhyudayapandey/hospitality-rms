-- migrate:up
-- Sections of a restaurant or bar floor, given to its serving staff per day (ADR 133), as rooms
-- are given to attendants (ADR 111).
--
-- * ops.service_section: a department's sections (file 47, by name, in order). A section no
--   longer in the file is archived.
-- * ops.section_assignment: who has a section on a day. Given by whoever manages tasks at the
--   department (its head, a captain, the GM: TASKS modify there), to someone who works in it.
--   Nobody is limited to their own section: everyone in the department sees who has which.

create table ops.service_section (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the department
  name text not null check (length(btrim(name)) between 1 and 60),
  position int not null default 0,
  archived_at timestamptz
);
select core.add_standard_columns('ops.service_section');
create unique index service_section_name on ops.service_section (org_node_id, name);

create table ops.section_assignment (
  id uuid primary key default core.uuid_v7(),
  org_node_id uuid not null references core.hierarchy_node(id),   -- the department
  day date not null,
  section_id uuid not null references ops.service_section(id),
  user_id uuid not null references core.app_user(id)
);
select core.add_standard_columns('ops.section_assignment');
create unique index section_assignment_day on ops.section_assignment (section_id, day);
create index section_assignment_user on ops.section_assignment (user_id, day);

-- Whether I may give out the department's sections.
create function ops.gives_sections(p_department uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select exists (select 1 from ops.service_section s
                  where s.org_node_id = p_department and s.archived_at is null)
     and core.can('TASKS', 'modify', p_department, null);
$$;

-- The departments with sections where I give them out (for the Give sections screen and Home).
create function ops.section_places()
returns table (department_id uuid, name text, outlet_name text)
language sql stable security definer
set search_path = pg_catalog, core, ops
as $$
  select distinct d.id, d.name, o.name
    from ops.service_section s
    join core.hierarchy_node d on d.id = s.org_node_id
    left join core.hierarchy_node o on o.id = d.parent_id
   where s.tenant_id = core.my_tenant() and s.archived_at is null
     and core.can('TASKS', 'modify', d.id, null)
   order by o.name, d.name;
$$;

-- Who sections may be given to: the department's active people.
create function ops.section_people(p_department uuid)
returns table (user_id uuid, name text, role_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops
as $$
begin
  if not core.can('TASKS', 'view', p_department, null) then
    perform ops.fail('NOT_AUTHORISED', 'TASKS view');
  end if;
  return query
    select distinct on (u.id) u.id, u.display_name, coalesce(jr.name, w.role_code)
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id
      left join hr.job_role jr on jr.tenant_id = w.tenant_id and jr.code = w.role_code
     where w.status = 'active' and w.org_node_id = p_department
     order by u.id, u.display_name;
end $$;

-- The department's sections on a day, and who has each.
create function ops.sections(p_department uuid, p_day date)
returns table (section_id uuid, name text, user_id uuid, user_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
begin
  if not core.can('TASKS', 'view', p_department, null) then
    perform ops.fail('NOT_AUTHORISED', 'TASKS view');
  end if;
  return query
    select s.id, s.name, a.user_id, u.display_name
      from ops.service_section s
      left join ops.section_assignment a on a.section_id = s.id and a.day = p_day
      left join core.app_user u on u.id = a.user_id
     where s.org_node_id = p_department and s.tenant_id = core.my_tenant()
       and s.archived_at is null
     order by s.position, s.name;
end $$;

-- Give sections for a day: p_user gets exactly p_sections (one another had moves to them; ones
-- they had that are not in the list are taken off).
create function ops.give_sections(p_department uuid, p_day date, p_user uuid, p_sections uuid[])
returns int
language plpgsql security definer
set search_path = pg_catalog, core, ops, rpt
as $$
begin
  if not exists (select 1 from core.hierarchy_node
                  where id = p_department and tenant_id = core.my_tenant())
     or not ops.gives_sections(p_department) then
    perform ops.fail('NOT_AUTHORISED', 'gives sections');
  end if;
  if p_day is null or p_day < rpt.today(p_department) or p_day > rpt.today(p_department) + 7 then
    perform ops.fail('INVALID_VALUE', 'today up to a week ahead');
  end if;
  if exists (select 1 from unnest(coalesce(p_sections, '{}')) x(id)
              where not exists (select 1 from ops.service_section s where s.id = x.id
                                   and s.org_node_id = p_department and s.archived_at is null)) then
    perform ops.fail('NOT_FOUND', 'a section of this department');
  end if;
  if not exists (select 1 from ops.section_people(p_department) p where p.user_id = p_user) then
    perform ops.fail('INVALID_VALUE', 'someone who works here');
  end if;
  delete from ops.section_assignment
   where org_node_id = p_department and day = p_day and user_id = p_user
     and section_id <> all (coalesce(p_sections, '{}'));
  insert into ops.section_assignment (tenant_id, org_node_id, day, section_id, user_id)
  select core.my_tenant(), p_department, p_day, x.id, p_user
    from unnest(coalesce(p_sections, '{}')) x(id)
  on conflict (section_id, day) do update set user_id = excluded.user_id
   where ops.section_assignment.user_id is distinct from excluded.user_id;
  return coalesce(array_length(p_sections, 1), 0);
end $$;

-- My sections today, for Home ("Your section today").
create function ops.my_sections()
returns table (department_name text, sections text)
language sql stable security definer
set search_path = pg_catalog, core, ops, rpt
as $$
  select d.name, string_agg(s.name, ', ' order by s.position, s.name)
    from ops.section_assignment a
    join ops.service_section s on s.id = a.section_id and s.archived_at is null
    join core.hierarchy_node d on d.id = a.org_node_id
   where a.user_id = core.current_user_id() and a.day = rpt.today(a.org_node_id)
   group by d.name
   order by d.name;
$$;

-- RLS (rule 1), audit (rule 5), grants
insert into core.domain_table (table_name, domain_code, hierarchy_type, rpc_only) values
  ('ops.service_section', 'TASKS', 'org', true),
  ('ops.section_assignment', 'TASKS', 'org', true);
select core.apply_domain_rls('ops.service_section');
select core.apply_domain_rls('ops.section_assignment');
select audit.enable('ops.service_section');
select audit.enable('ops.section_assignment');

revoke execute on function ops.gives_sections(uuid), ops.section_places(),
  ops.section_people(uuid), ops.sections(uuid, date), ops.give_sections(uuid, date, uuid, uuid[]),
  ops.my_sections()
  from public, platform_loader;
grant execute on function ops.gives_sections(uuid), ops.section_places(),
  ops.section_people(uuid), ops.sections(uuid, date), ops.give_sections(uuid, date, uuid, uuid[]),
  ops.my_sections()
  to app_rw;

-- migrate:down
drop function ops.my_sections();
drop function ops.give_sections(uuid, date, uuid, uuid[]);
drop function ops.sections(uuid, date);
drop function ops.section_people(uuid);
drop function ops.section_places();
drop function ops.gives_sections(uuid);
delete from core.domain_table
 where table_name in ('ops.service_section', 'ops.section_assignment');
drop table ops.section_assignment;
drop table ops.service_section;
