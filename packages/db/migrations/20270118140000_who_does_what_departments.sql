-- migrate:up
-- Admin -> Who does what by department (OW-03, ADR 164): each role says the department its
-- people work in at the outlet (core.cover_home), so the screen lists roles under their
-- department, the outlet's own roles (the GM, the assistant manager) first.
drop function core.admin_role_cover(uuid);
create function core.admin_role_cover(p_outlet uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outlet_id uuid, outlet_name text, job_role_code text, role_name text, duties text[], duty_names text[], people integer, answer text, covered_by_role text, covered_by_name text, changed_by text, changed_at timestamp with time zone, can_change boolean, department_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr', 'wf'
AS $function$
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
           u.display_name, last.set_in_app_at, o.can,
           -- the department its people work in there; null for the outlet's own roles
           (select d.name from core.hierarchy_node d
             where d.id = core.cover_home(o.id, j.code) and d.kind = 'department')
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
end $function$;
revoke execute on function core.admin_role_cover(uuid) from public;
grant execute on function core.admin_role_cover(uuid) to app_rw;

-- migrate:down
drop function core.admin_role_cover(uuid);
create function core.admin_role_cover(p_outlet uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outlet_id uuid, outlet_name text, job_role_code text, role_name text, duties text[], duty_names text[], people integer, answer text, covered_by_role text, covered_by_name text, changed_by text, changed_at timestamp with time zone, can_change boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'hr', 'wf'
AS $function$
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
end $function$;
revoke execute on function core.admin_role_cover(uuid) from public;
grant execute on function core.admin_role_cover(uuid) to app_rw;
