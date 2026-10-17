-- migrate:up
-- A section may be given to several people on a day (ADR 170): a busy section has two servers.
-- One row per person per section per day; giving a section to someone adds them and takes it
-- from nobody.

drop index ops.section_assignment_day;
create unique index section_assignment_day on ops.section_assignment (section_id, day, user_id);

-- The department's sections on a day, and everyone who has each (by name).
drop function ops.sections(uuid, date);
create function ops.sections(p_department uuid, p_day date)
returns table (section_id uuid, name text, user_ids uuid[], user_names text)
language plpgsql stable security definer
set search_path = pg_catalog, core, ops
as $$
begin
  if not core.can('TASKS', 'view', p_department, null) then
    perform ops.fail('NOT_AUTHORISED', 'TASKS view');
  end if;
  return query
    select s.id, s.name,
           coalesce(array_agg(a.user_id order by u.display_name, u.id)
                      filter (where a.user_id is not null), '{}'),
           string_agg(u.display_name, ', ' order by u.display_name, u.id)
      from ops.service_section s
      left join ops.section_assignment a on a.section_id = s.id and a.day = p_day
      left join core.app_user u on u.id = a.user_id
     where s.org_node_id = p_department and s.tenant_id = core.my_tenant()
       and s.archived_at is null
     group by s.id, s.name, s.position
     order by s.position, s.name;
end $$;

-- Give sections for a day: p_user has exactly p_sections (ones they had that are not in the list
-- are taken off). Others who have the same sections keep them.
create or replace function ops.give_sections(p_department uuid, p_day date, p_user uuid,
                                             p_sections uuid[])
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
  select distinct core.my_tenant(), p_department, p_day, x.id, p_user
    from unnest(coalesce(p_sections, '{}')) x(id)
  on conflict (section_id, day, user_id) do nothing;
  return (select count(distinct x.id)::int from unnest(coalesce(p_sections, '{}')) x(id));
end $$;

revoke execute on function ops.sections(uuid, date) from public, platform_loader;
grant execute on function ops.sections(uuid, date) to app_rw;

-- migrate:down
-- back to one person per section: the first given keeps it
delete from ops.section_assignment a
 using ops.section_assignment b
 where b.section_id = a.section_id and b.day = a.day and b.id < a.id;
drop index ops.section_assignment_day;
create unique index section_assignment_day on ops.section_assignment (section_id, day);

drop function ops.sections(uuid, date);
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
revoke execute on function ops.sections(uuid, date) from public, platform_loader;
grant execute on function ops.sections(uuid, date) to app_rw;

create or replace function ops.give_sections(p_department uuid, p_day date, p_user uuid,
                                             p_sections uuid[])
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
