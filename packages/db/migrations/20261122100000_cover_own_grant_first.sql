-- migrate:up
-- Who covers it (ADR 061), found with the first cover in the test data (ADR 066): when a
-- covered role's grant is one the person already holds through their own job role (the Front
-- Desk at Guest House 2.0 covering the Store Keeper: both give STAFF at the outlet), the grant
-- is their own, not the cover's. Before, both rows came back and whichever was applied last
-- named the source, so a second load could flip it. Access itself is the same either way.
create or replace function core.derive_job_role_access(p_user uuid)
returns table (access_group text, node_id uuid, include_descendants boolean, source text,
               error text)
language plpgsql stable
set search_path = pg_catalog, core, hr
as $$
begin
  return query
    select d.* from hr.worker wk,
           core.derive_job_role_access_at(wk.tenant_id, wk.role_code, wk.org_node_id) d
     where wk.owner_user_id = p_user;
  return query
    select d.access_group, d.node_id, d.include_descendants, 'covers ' || j.name, d.error
      from hr.worker wk
      join hr.role_cover c on c.tenant_id = wk.tenant_id and c.covered_by_role = wk.role_code
                          and c.mode = 'covered_by' and c.archived_at is null
                          and c.org_node_id = core.nearest(wk.org_node_id, array['outlet', 'site'])
      join hr.job_role j on j.tenant_id = c.tenant_id and j.code = c.job_role_code
      cross join lateral core.derive_job_role_access_at(
                   c.tenant_id, c.job_role_code,
                   coalesce(core.cover_home(c.org_node_id, c.job_role_code), wk.org_node_id)) d
     where wk.owner_user_id = p_user and wk.status = 'active'
       and not exists (
             select 1 from core.derive_job_role_access_at(wk.tenant_id, wk.role_code,
                                                          wk.org_node_id) o
              where o.error is null and d.error is null
                and o.access_group = d.access_group and o.node_id = d.node_id
                and o.include_descendants = d.include_descendants);
end $$;

-- migrate:down
create or replace function core.derive_job_role_access(p_user uuid)
returns table (access_group text, node_id uuid, include_descendants boolean, source text,
               error text)
language plpgsql stable
set search_path = pg_catalog, core, hr
as $$
begin
  return query
    select d.* from hr.worker wk,
           core.derive_job_role_access_at(wk.tenant_id, wk.role_code, wk.org_node_id) d
     where wk.owner_user_id = p_user;
  return query
    select d.access_group, d.node_id, d.include_descendants, 'covers ' || j.name, d.error
      from hr.worker wk
      join hr.role_cover c on c.tenant_id = wk.tenant_id and c.covered_by_role = wk.role_code
                          and c.mode = 'covered_by' and c.archived_at is null
                          and c.org_node_id = core.nearest(wk.org_node_id, array['outlet', 'site'])
      join hr.job_role j on j.tenant_id = c.tenant_id and j.code = c.job_role_code
      cross join lateral core.derive_job_role_access_at(
                   c.tenant_id, c.job_role_code,
                   coalesce(core.cover_home(c.org_node_id, c.job_role_code), wk.org_node_id)) d
     where wk.owner_user_id = p_user and wk.status = 'active';
end $$;
