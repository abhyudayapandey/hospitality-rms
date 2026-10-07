-- migrate:up
-- Access a job role gives that was ended is given again when the job role gives it again
-- (ADR 066). Admin ends a grant rather than deleting it (core.sync_job_role_access, ADR 065),
-- so "Who does what" set to "We have it" ends the coverer's grant; an import or a cover saved
-- again later re-applies access through this function, which used to see the ended row and
-- give nothing. Now only live rows count, and an ended job-role row for the same group and
-- place is replaced, as core.sync_job_role_access does.
create or replace function core.apply_job_role_access(p_user uuid) returns void
language plpgsql
set search_path = pg_catalog, core, hr
as $$
declare
  v_tenant uuid;
  v_err text;
begin
  select string_agg(d.error, '; ') into v_err
    from core.derive_job_role_access(p_user) d where d.error is not null;
  if v_err is not null then
    raise exception 'JOB_ROLE_SCOPE' using detail = v_err;
  end if;
  select tenant_id into v_tenant from core.app_user where id = p_user;

  delete from core.role_assignment ra
   where ra.user_id = p_user and ra.source = 'job_role'
     and not exists (select 1 from core.derive_job_role_access(p_user) d
                       join core.security_group g
                         on g.tenant_id = v_tenant and g.code = d.access_group
                      where g.id = ra.group_id and d.node_id = ra.node_id
                        and d.include_descendants = ra.include_descendants);
  -- an ended job-role grant the job role gives again is replaced by a live one
  delete from core.role_assignment ra
   where ra.user_id = p_user and ra.source = 'job_role' and ra.effective_to < current_date
     and not exists (select 1 from core.role_assignment l
                      where l.user_id = p_user and l.group_id = ra.group_id
                        and l.node_id = ra.node_id
                        and (l.effective_to is null or l.effective_to >= current_date));
  -- access from the job role starts when the person joined (file 07), or today
  insert into core.role_assignment (tenant_id, user_id, group_id, node_id,
                                    include_descendants, effective_from, source, source_note)
  select v_tenant, p_user, g.id, d.node_id, bool_or(d.include_descendants),
         coalesce((select w.joined_on from hr.worker w where w.owner_user_id = p_user),
                  current_date),
         'job_role', min(d.source)
    from core.derive_job_role_access(p_user) d
    join core.security_group g on g.tenant_id = v_tenant and g.code = d.access_group
   where not exists (select 1 from core.role_assignment ra
                      where ra.user_id = p_user and ra.group_id = g.id
                        and ra.node_id = d.node_id
                        and (ra.effective_to is null or ra.effective_to >= current_date))
   group by g.id, d.node_id;
end $$;

-- migrate:down
create or replace function core.apply_job_role_access(p_user uuid) returns void
language plpgsql
set search_path = pg_catalog, core, hr
as $$
declare
  v_tenant uuid;
  v_err text;
begin
  select string_agg(d.error, '; ') into v_err
    from core.derive_job_role_access(p_user) d where d.error is not null;
  if v_err is not null then
    raise exception 'JOB_ROLE_SCOPE' using detail = v_err;
  end if;
  select tenant_id into v_tenant from core.app_user where id = p_user;

  delete from core.role_assignment ra
   where ra.user_id = p_user and ra.source = 'job_role'
     and not exists (select 1 from core.derive_job_role_access(p_user) d
                       join core.security_group g
                         on g.tenant_id = v_tenant and g.code = d.access_group
                      where g.id = ra.group_id and d.node_id = ra.node_id
                        and d.include_descendants = ra.include_descendants);
  -- access from the job role starts when the person joined (file 07), or today
  insert into core.role_assignment (tenant_id, user_id, group_id, node_id,
                                    include_descendants, effective_from, source, source_note)
  select v_tenant, p_user, g.id, d.node_id, bool_or(d.include_descendants),
         coalesce((select w.joined_on from hr.worker w where w.owner_user_id = p_user),
                  current_date),
         'job_role', min(d.source)
    from core.derive_job_role_access(p_user) d
    join core.security_group g on g.tenant_id = v_tenant and g.code = d.access_group
   where not exists (select 1 from core.role_assignment ra
                      where ra.user_id = p_user and ra.group_id = g.id
                        and ra.node_id = d.node_id)
   group by g.id, d.node_id;
end $$;
