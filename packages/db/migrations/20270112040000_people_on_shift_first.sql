-- migrate:up
-- Person pickers put who is on shift today first (ADR 110, 113), everywhere a task, a discard or a
-- repair is given to someone; giving a task on never offers the giver (QA of the Passport Hotel
-- demo: a licence's "Give it to someone" listed all 38 people A to Z, the giver among them).
--
-- * ops.is_on_shift(user, node): clocked in now, or on a published shift there this business day
--   (the test ops.on_shift_today uses).
-- * ops.assignable_people and ops.hand_on_people gain `on_shift` and list those on shift first,
--   then the rest, each by name; one row a person (a person working in two departments of the
--   place was listed twice).
-- * ops.hand_on_people leaves out whoever gives it and whoever already has it. Who may get it is
--   unchanged: anyone working at the task's place (ops.reassign_task's ops.works_under).

create function ops.is_on_shift(p_user uuid, p_node uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, core, hr, ops, rpt
as $$
  select ops.clocked_in(p_user, now())
      or exists (select 1 from hr.shift_assignment a
                   join hr.shift s on s.id = a.shift_id and s.status = 'published'
                  where a.owner_user_id = p_user and a.status = 'assigned'
                    and s.local_date = rpt.business_date(now(), ops.tz_of(p_node)));
$$;
revoke all on function ops.is_on_shift(uuid, uuid) from public;

drop function ops.assignable_people(uuid);
create function ops.assignable_people(p_node uuid)
returns table (user_id uuid, name text, job_role text, place_name text, on_shift boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
begin
  if not (core.can('TASKS', 'modify', p_node, null) or core.can('MAINTENANCE', 'modify', p_node, null)) then
    perform ops.fail('NOT_AUTHORISED', format('modify TASKS at %s', p_node));
  end if;
  return query
    select x.id, x.display_name, x.role_name, x.place, ops.is_on_shift(x.id, p_node)
      from (select distinct on (u.id) u.id, u.display_name, r.name as role_name, h.name as place
              from hr.worker w
              join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
              join core.hierarchy_node h on h.id = w.org_node_id
              join core.hierarchy_node n on n.id = p_node and n.tenant_id = w.tenant_id
              left join hr.job_role r on r.tenant_id = w.tenant_id and r.code = w.role_code
             where w.status = 'active' and h.path operator(extensions.<@) n.path
             order by u.id, h.path) x
     order by 5 desc, x.display_name;
end $$;

drop function ops.hand_on_people(uuid);
create function ops.hand_on_people(p_task uuid)
returns table (user_id uuid, name text, job_role text, place_name text, on_shift boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
declare
  v_t ops.task;
  v_dept text;
  v_outlet core.hierarchy_node;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant();
  if not found or not ops.may_hand_on(v_t) then
    perform ops.fail('NOT_AUTHORISED', 'not yours to hand on');
  end if;
  -- who may get it is ADR 151's: a licence's or compliance job's role, department and the
  -- outlet's managers; every other task, everyone where it is. On shift today first, never
  -- the giver or whoever has it now (ADR 145).
  if v_t.kind in ('licence', 'compliance') and v_t.job_role_code is not null then
    select * into v_outlet from core.hierarchy_node
     where id = core.nearest(v_t.org_node_id, array['outlet', 'site']);
    select usual_department into v_dept from hr.job_role
     where tenant_id = v_t.tenant_id and code = v_t.job_role_code;
    return query
      select x.id, x.display_name, x.role_name, x.place, ops.is_on_shift(x.id, v_t.org_node_id)
        from (select distinct on (u.id) u.id, u.display_name, r.name as role_name, h.name as place
                from hr.worker w
                join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
                join core.hierarchy_node h on h.id = w.org_node_id
                left join hr.job_role r on r.tenant_id = w.tenant_id and r.code = w.role_code
               where w.status = 'active' and w.tenant_id = v_t.tenant_id
                 and h.path operator(extensions.<@) v_outlet.path
                 and (ops.of_task_role(v_t, u.id)
                      or (v_dept is not null and h.code = v_outlet.code || '-' || v_dept)
                      or (h.id = v_outlet.id and ops.runs_something(u.id, w.tenant_id)))
                 and u.id is distinct from core.current_user_id()
                 and u.id is distinct from v_t.assignee_user_id
               order by u.id, h.path) x
       order by 5 desc, x.display_name;
    return;
  end if;
  return query
    select x.id, x.display_name, x.role_name, x.place, ops.is_on_shift(x.id, v_t.org_node_id)
      from (select distinct on (u.id) u.id, u.display_name, r.name as role_name, h.name as place
              from hr.worker w
              join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
              join core.hierarchy_node h on h.id = w.org_node_id
              join core.hierarchy_node n on n.id = v_t.org_node_id and n.tenant_id = w.tenant_id
              left join hr.job_role r on r.tenant_id = w.tenant_id and r.code = w.role_code
             where w.status = 'active' and h.path operator(extensions.<@) n.path
               and u.id is distinct from core.current_user_id()
               and u.id is distinct from v_t.assignee_user_id
             order by u.id, h.path) x
     order by 5 desc, x.display_name;
end $$;

revoke execute on function ops.assignable_people(uuid), ops.hand_on_people(uuid) from public;
grant execute on function ops.assignable_people(uuid), ops.hand_on_people(uuid) to app_rw;

-- migrate:down
drop function ops.hand_on_people(uuid);
create function ops.hand_on_people(p_task uuid)
returns table (user_id uuid, name text, job_role text, place_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
declare
  v_t ops.task;
begin
  select * into v_t from ops.task where id = p_task and tenant_id = core.my_tenant();
  if not found or not ops.may_hand_on(v_t) then
    perform ops.fail('NOT_AUTHORISED', 'not yours to hand on');
  end if;
  return query
    select u.id, u.display_name, r.name, h.name
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node n on n.id = v_t.org_node_id and n.tenant_id = w.tenant_id
      left join hr.job_role r on r.tenant_id = w.tenant_id and r.code = w.role_code
     where w.status = 'active' and h.path operator(extensions.<@) n.path
     order by u.display_name;
end $$;

drop function ops.assignable_people(uuid);
create function ops.assignable_people(p_node uuid)
returns table (user_id uuid, name text, job_role text, place_name text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, ops, extensions
as $$
begin
  if not (core.can('TASKS', 'modify', p_node, null) or core.can('MAINTENANCE', 'modify', p_node, null)) then
    perform ops.fail('NOT_AUTHORISED', format('modify TASKS at %s', p_node));
  end if;
  return query
    select u.id, u.display_name, r.name, h.name
      from hr.worker w
      join core.app_user u on u.id = w.owner_user_id and u.status = 'active'
      join core.hierarchy_node h on h.id = w.org_node_id
      join core.hierarchy_node n on n.id = p_node and n.tenant_id = w.tenant_id
      left join hr.job_role r on r.tenant_id = w.tenant_id and r.code = w.role_code
     where w.status = 'active' and h.path operator(extensions.<@) n.path
     order by u.display_name;
end $$;

revoke execute on function ops.assignable_people(uuid), ops.hand_on_people(uuid) from public;
grant execute on function ops.assignable_people(uuid), ops.hand_on_people(uuid) to app_rw;

drop function ops.is_on_shift(uuid, uuid);
