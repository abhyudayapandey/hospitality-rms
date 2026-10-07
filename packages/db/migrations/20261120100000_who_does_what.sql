-- migrate:up
-- Admin → Who does what (ADR 065, Step 6 of docs/templates-and-cover.md): after go-live, an
-- Account Owner or user admin changes who covers a job role at an outlet. The same rules and
-- checks as file 37 (core.role_cover_errors); access is applied again at once for everyone
-- working there through core.sync_job_role_access, so the usual guardrails hold (your own
-- access, rank, sensitive grants waiting for approval); unstarted tasks of the role go to
-- whoever does its work now.

-- Who changed a cover in Admin, and when: an import's dry run warns before file 37 changes
-- or removes it (as for locations, ADR 018). The loader clears it when it writes the row.
alter table hr.role_cover
  add column set_in_app_by uuid references core.app_user (id),
  add column set_in_app_at timestamptz;

-- The outlet, central kitchen or site the caller may see in Who does what, else a refusal.
-- Another customer's place and a place that doesn't exist get the same answer.
create function core.cover_outlet_check(p_outlet uuid, p_access text) returns void
language plpgsql stable security definer
set search_path = pg_catalog, core, wf
as $$
declare
  v_me core.app_user := wf.me();
begin
  if not exists (select 1 from core.hierarchy_node
                  where id = p_outlet and tenant_id = v_me.tenant_id and type = 'org'
                    and kind in ('outlet', 'site') and archived_at is null) then
    perform wf.fail('NOT_FOUND', 'outlet');
  end if;
  perform core.require_user_admin(p_access);
  if not core.in_user_access_scope(p_outlet, p_access) then
    perform wf.fail('NOT_AUTHORISED', 'the place is outside your user administration');
  end if;
end $$;

-- A person's live job-role grants, as one comparable string.
create function core.job_role_grants_key(p_user uuid) returns text
language sql stable security definer
set search_path = pg_catalog, core
as $$
  select coalesce(string_agg(ra.group_id || '@' || ra.node_id, ',' order by ra.group_id, ra.node_id), '')
    from core.role_assignment ra
   where ra.user_id = p_user and ra.source = 'job_role'
     and ra.effective_from <= current_date
     and (ra.effective_to is null or ra.effective_to >= current_date);
$$;

-- Sets who does a job role's work at an outlet: 'have' (the outlet has the role: no cover),
-- 'covered_by' p_by, or 'not_done'. One transaction: the cover, everyone's access there,
-- and the role's unstarted tasks.
create function core.set_role_cover(p_outlet uuid, p_role text, p_answer text,
                                    p_by text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, hr, ops, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_cur hr.role_cover;
  v_err record;
  w record;
  v_before text;
  v_res jsonb;
  v_n int;
  v_t ops.task;
  v_applied int := 0;
  v_pending int := 0;
  v_people jsonb := '[]';
  v_returned int := 0;
  v_given int := 0;
begin
  perform core.cover_outlet_check(p_outlet, 'modify');
  if p_answer is null or p_answer not in ('have', 'covered_by', 'not_done')
     or (p_answer <> 'covered_by' and p_by is not null) then
    perform wf.fail('INVALID_MODE', coalesce(p_answer, '(blank)'));
  end if;
  if not exists (select 1 from hr.job_role where tenant_id = v_me.tenant_id and code = p_role
                    and archived_at is null) then
    perform wf.fail('INVALID_JOB_ROLE', coalesce(p_role, '(blank)'));
  end if;

  select * into v_cur from hr.role_cover
   where org_node_id = p_outlet and job_role_code = p_role and archived_at is null
   for update;
  if p_answer = 'have' then
    if v_cur.id is null then
      return jsonb_build_object('changed', false);
    end if;
    update hr.role_cover set archived_at = now(), set_in_app_by = v_me.id, set_in_app_at = now()
     where id = v_cur.id;
  else
    for v_err in select * from core.role_cover_errors(v_me.tenant_id, p_outlet, p_role,
                                                       p_answer, p_by) loop
      perform wf.fail(v_err.code, v_err.detail);
    end loop;
    if v_cur.id is not null then
      if (v_cur.mode, v_cur.covered_by_role) is not distinct from (p_answer, p_by) then
        return jsonb_build_object('changed', false);
      end if;
      update hr.role_cover set mode = p_answer, covered_by_role = p_by,
                               set_in_app_by = v_me.id, set_in_app_at = now()
       where id = v_cur.id;
    else
      insert into hr.role_cover (tenant_id, org_node_id, job_role_code, mode, covered_by_role,
                                 set_in_app_by, set_in_app_at)
      values (v_me.tenant_id, p_outlet, p_role, p_answer, p_by, v_me.id, now());
    end if;
  end if;

  -- everyone working there, through the same checks as any access change: refused for your
  -- own access or someone above your rank, sensitive grants as requests waiting for approval
  for w in select wk.owner_user_id as id, u.display_name from hr.worker wk
             join core.app_user u on u.id = wk.owner_user_id
            where wk.tenant_id = v_me.tenant_id and wk.status = 'active'
              and core.nearest(wk.org_node_id, array['outlet', 'site']) = p_outlet
            order by u.display_name, wk.owner_user_id loop
    v_before := core.job_role_grants_key(w.id);
    v_res := core.sync_job_role_access(w.id);
    v_n := jsonb_array_length(v_res -> 'pending');
    v_applied := v_applied + (v_res ->> 'applied')::int;
    v_pending := v_pending + v_n;
    if v_n > 0 or core.job_role_grants_key(w.id) <> v_before then
      v_people := v_people || jsonb_build_object('user_id', w.id, 'name', w.display_name,
                                                 'waiting', v_n);
    end if;
  end loop;

  -- unstarted tasks of the role here held by someone no longer in its pool (the person who
  -- covered it) go back to the role; a task someone has started stays with them
  update ops.task t set assignee_user_id = null, auto_assigned_at = null
   where t.tenant_id = v_me.tenant_id and t.status = 'open' and t.assign_mode = 'job_role'
     and t.job_role_code = p_role and t.assignee_user_id is not null
     and core.nearest(t.org_node_id, array['outlet', 'site']) = p_outlet
     and not ops.in_pool(t, t.assignee_user_id);
  get diagnostics v_returned = row_count;

  -- covered: what is due now goes to a coverer on duty at once, as the tick would
  if p_answer = 'covered_by' then
    for v_t in select t.* from ops.task t
                where t.tenant_id = v_me.tenant_id and t.status = 'open'
                  and t.assign_mode = 'job_role' and t.job_role_code = p_role
                  and t.assignee_user_id is null and t.due_at <= now() + interval '30 minutes'
                  and core.nearest(t.org_node_id, array['outlet', 'site']) = p_outlet
                order by t.due_at
                for update skip locked loop
      if ops.give_covered_task(v_t, now()) is not null then
        v_given := v_given + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'changed', true, 'applied', v_applied, 'pending', v_pending, 'people', v_people,
    'tasks_returned', v_returned, 'tasks_given', v_given,
    'tasks_open', (select count(*)::int from ops.task t
                    where t.tenant_id = v_me.tenant_id and t.status = 'open'
                      and t.assign_mode = 'job_role' and t.job_role_code = p_role
                      and t.assignee_user_id is null
                      and core.nearest(t.org_node_id, array['outlet', 'site']) = p_outlet));
end $$;

-- What saving would do: every reason it can't be saved, or what core.set_role_cover does,
-- run and rolled back, so the preview and the save cannot drift apart. The same checks
-- first, so it can't be used to look at another customer's places.
create function core.preview_role_cover(p_outlet uuid, p_role text, p_answer text,
                                        p_by text default null)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_me core.app_user := wf.me();
  v_errors jsonb;
  v_res jsonb;
  v_state text;
  v_msg text;
  v_detail text;
begin
  perform core.cover_outlet_check(p_outlet, 'modify');
  if p_answer in ('covered_by', 'not_done') then
    select coalesce(jsonb_agg(jsonb_build_object('code', e.code, 'detail', e.detail)), '[]')
      into v_errors
      from core.role_cover_errors(v_me.tenant_id, p_outlet, p_role, p_answer, p_by) e;
    if jsonb_array_length(v_errors) > 0 then
      return jsonb_build_object('errors', v_errors);
    end if;
  end if;
  begin
    v_res := core.set_role_cover(p_outlet, p_role, p_answer, p_by);
    raise exception 'preview' using errcode = 'UA002';
  exception
    when sqlstate 'UA002' then
      null; -- everything set_role_cover did is rolled back; v_res keeps the answer
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                              v_detail = pg_exception_detail;
      return jsonb_build_object('errors', jsonb_build_array(jsonb_build_object(
        'code', case when v_state = 'P0001' and v_msg ~ '^[A-Z][A-Z_]+$' then v_msg
                     else 'UNEXPECTED' end,
        'detail', case when v_state = 'P0001' then v_detail end)));
  end;
  return jsonb_build_object('errors', '[]'::jsonb, 'result', v_res);
end $$;

-- The outlets (and central kitchens) in the caller's user administration, with how many
-- covers each has.
create function core.admin_cover_outlets()
returns table (outlet_id uuid, outlet_name text, covers int, can_change boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf
as $$
begin
  perform core.require_user_admin('view');
  return query
    select n.id, n.name,
           (select count(*)::int from hr.role_cover c
             where c.org_node_id = n.id and c.archived_at is null),
           core.in_user_access_scope(n.id, 'modify')
      from core.hierarchy_node n
     where n.tenant_id = core.my_tenant() and n.type = 'org' and n.kind in ('outlet', 'site')
       and n.archived_at is null and core.in_user_access_scope(n.id, 'view')
     order by n.kind = 'site', n.name, n.id;
end $$;

-- Who does what at one outlet: each job role that works there (its department is there, or
-- it works at outlet level, and it has access for the outlet's format), every role someone
-- there holds, and every role with a cover; with its answer, the people in it and its
-- duties. With no outlet: only the covers, across every outlet in the caller's user
-- administration.
create function core.admin_role_cover(p_outlet uuid default null)
returns table (outlet_id uuid, outlet_name text, job_role_code text, role_name text,
               duties text[], duty_names text[], people int, answer text,
               covered_by_role text, covered_by_name text, changed_by text,
               changed_at timestamptz, can_change boolean)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, wf
as $$
declare
  v_tenant uuid;
begin
  if p_outlet is not null then
    perform core.cover_outlet_check(p_outlet, 'view');
  else
    perform core.require_user_admin('view');
  end if;
  v_tenant := core.my_tenant();
  return query
    with outlets as (
      select n.id, n.name, n.outlet_format, core.in_user_access_scope(n.id, 'modify') as can
        from core.hierarchy_node n
       where n.tenant_id = v_tenant and n.type = 'org' and n.kind in ('outlet', 'site')
         and n.archived_at is null
         and (n.id = p_outlet
              or (p_outlet is null and core.in_user_access_scope(n.id, 'view')
                  and exists (select 1 from hr.role_cover c
                               where c.org_node_id = n.id and c.archived_at is null)))),
    roles as (
      select o.id as outlet_id, j.code
        from outlets o
        join hr.job_role j on j.tenant_id = v_tenant and j.archived_at is null
       where (p_outlet is not null
              and ((coalesce(j.usual_department, '(outlet)') not in ('(company)', '(area)')
                    and core.cover_home(o.id, j.code) is not null
                    and exists (select 1 from hr.job_role_access a
                                 where a.tenant_id = v_tenant and a.job_role_code = j.code
                                   and a.outlet_format in ('any', coalesce(o.outlet_format, 'any')))
                    and not exists (select 1 from hr.job_role_access a
                                     where a.tenant_id = v_tenant and a.job_role_code = j.code
                                       and a.scope in ('whole_area', 'whole_company')))
                   or exists (select 1 from hr.worker w
                               where w.tenant_id = v_tenant and w.status = 'active'
                                 and w.role_code = j.code
                                 and core.nearest(w.org_node_id, array['outlet', 'site']) = o.id)))
          or exists (select 1 from hr.role_cover c
                      where c.org_node_id = o.id and c.job_role_code = j.code
                        and c.archived_at is null))
    select o.id, o.name, j.code, j.name,
           array(select distinct a.duty_code from hr.job_role_access a
                  where a.tenant_id = v_tenant and a.job_role_code = j.code
                    and a.duty_code is not null
                    and a.outlet_format in ('any', coalesce(o.outlet_format, 'any'))
                  order by 1),
           array(select d.name from hr.duty d
                  where d.tenant_id = v_tenant
                    and d.code in (select a.duty_code from hr.job_role_access a
                                    where a.tenant_id = v_tenant and a.job_role_code = j.code
                                      and a.outlet_format in ('any', coalesce(o.outlet_format, 'any')))
                  order by d.position, d.code),
           (select count(*)::int from hr.worker w
             where w.tenant_id = v_tenant and w.status = 'active' and w.role_code = j.code
               and core.nearest(w.org_node_id, array['outlet', 'site']) = o.id),
           coalesce(c.mode, 'have'), c.covered_by_role, b.name,
           u.display_name, last.set_in_app_at, o.can
      from roles r
      join outlets o on o.id = r.outlet_id
      join hr.job_role j on j.tenant_id = v_tenant and j.code = r.code
      left join hr.role_cover c on c.org_node_id = o.id and c.job_role_code = j.code
                               and c.archived_at is null
      left join hr.job_role b on b.tenant_id = v_tenant and b.code = c.covered_by_role
      left join lateral (select x.set_in_app_by, x.set_in_app_at from hr.role_cover x
                          where x.org_node_id = o.id and x.job_role_code = j.code
                          order by x.archived_at is null desc, x.updated_at desc limit 1) last
             on true
      left join core.app_user u on u.id = last.set_in_app_by
     order by o.name, o.id, j.name, j.code;
end $$;

-- The customer's live covers as file 37 rows, so the console's current files (Add an
-- outlet) carry what Admin set rather than the last upload. Platform admins only.
create function platform.role_cover_rows(p_tenant uuid)
returns table (outlet_code text, job_role_code text, mode text, covered_by_role text)
language plpgsql stable security definer
set search_path = pg_catalog, core, hr, platform
as $$
begin
  perform platform.current_admin();
  return query
    select n.code, c.job_role_code, c.mode, c.covered_by_role
      from hr.role_cover c
      join core.hierarchy_node n on n.id = c.org_node_id
     where c.tenant_id = p_tenant and c.archived_at is null
     order by n.code, c.job_role_code;
end $$;

revoke execute on function core.cover_outlet_check(uuid, text), core.job_role_grants_key(uuid),
  core.set_role_cover(uuid, text, text, text), core.preview_role_cover(uuid, text, text, text),
  core.admin_cover_outlets(), core.admin_role_cover(uuid), platform.role_cover_rows(uuid)
  from public;
grant execute on function core.set_role_cover(uuid, text, text, text),
  core.preview_role_cover(uuid, text, text, text), core.admin_cover_outlets(),
  core.admin_role_cover(uuid), platform.role_cover_rows(uuid) to app_rw;

-- migrate:down
-- Forward-only in production (ADR 005); this restores the previous shape for local work.
drop function platform.role_cover_rows(uuid);
drop function core.admin_role_cover(uuid);
drop function core.admin_cover_outlets();
drop function core.preview_role_cover(uuid, text, text, text);
drop function core.set_role_cover(uuid, text, text, text);
drop function core.job_role_grants_key(uuid);
drop function core.cover_outlet_check(uuid, text);
alter table hr.role_cover drop column set_in_app_at, drop column set_in_app_by;
