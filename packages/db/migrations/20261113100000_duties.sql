-- migrate:up
-- Duties (ADR 058, 059): one piece of responsibility in plain words, over the access-group
-- grants it stands for. Product code (packages/domain/src/duties.ts), written into every
-- tenant by the product sync like the access groups; read-only here. A job role holds
-- duties: each hr.job_role_access row records the duty it comes from (duty_code), or none
-- for a grant given directly (a company's own group, ADR 027). How a person's access is
-- worked out does not change: core.derive_job_role_access_at reads the same rows.

create table hr.duty (
  id uuid primary key default core.uuid_v7(),
  tenant_id uuid not null references core.tenant (id),
  code text not null check (code ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  name text not null,
  does text not null,
  at_another_department boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default core.current_user_id(),
  updated_at timestamptz not null default now(),
  updated_by uuid default core.current_user_id(),
  unique (tenant_id, code)
);

create table hr.duty_grant (
  id uuid primary key default core.uuid_v7(),
  tenant_id uuid not null references core.tenant (id),
  duty_code text not null,
  access_group text not null,
  scope text not null check (scope ~ ('^(home_department|whole_outlet|outlet_stores|'
    || 'department_store|main_store|central_kitchen|central_kitchen_store|whole_area|'
    || 'whole_company|department:[A-Z0-9][A-Z0-9-]*)$')),
  include_descendants boolean not null default true,
  position int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default core.current_user_id(),
  updated_at timestamptz not null default now(),
  updated_by uuid default core.current_user_id(),
  foreign key (tenant_id, duty_code) references hr.duty (tenant_id, code) on delete cascade,
  unique (tenant_id, duty_code, access_group, scope)
);

insert into core.domain_table (table_name, domain_code, hierarchy_type, catalog, rpc_only)
values ('hr.duty', 'USER_ACCESS', 'org', true, true),
       ('hr.duty_grant', 'USER_ACCESS', 'org', true, true);
select core.apply_domain_rls('hr.duty');
select core.apply_domain_rls('hr.duty_grant');
select audit.enable('hr.duty', false);
select audit.enable('hr.duty_grant', false);
create trigger touch before update on hr.duty
  for each row execute function core.touch();
create trigger touch before update on hr.duty_grant
  for each row execute function core.touch();

-- A duty in use by a job role cannot be removed from the catalogue (the sync fails loudly).
alter table hr.job_role_access
  add column duty_code text,
  add foreign key (tenant_id, duty_code) references hr.duty (tenant_id, code);

-- Labels a tenant's job-role grants with the duty they stand for, where every grant of a
-- duty is present for that role and outlet format (a duty given at another department
-- matches its `department:<CODE>` rows too). Only unlabelled rows change, so a grant given
-- directly, which matches no duty, stays unlabelled. Grants are never added, removed or
-- changed: access is exactly what it was. Returns the number of rows labelled. Run by the
-- product sync (every deploy and seed) and the onboarding loader.
create function hr.label_job_role_duties(p_tenant uuid) returns int
language plpgsql
set search_path = pg_catalog, hr
as $$
declare
  r record;
  d record;
  v_rows uuid[];
  v_missing int;
  v_n int;
  v_total int := 0;
begin
  for r in select distinct a.job_role_code, a.outlet_format from hr.job_role_access a
            where a.tenant_id = p_tenant and a.duty_code is null loop
    -- duties with more grants first, so a two-grant duty takes its rows before a
    -- one-grant duty over the same group could
    for d in select du.code, du.at_another_department,
                    (select count(*) from hr.duty_grant g
                      where g.tenant_id = p_tenant and g.duty_code = du.code) as n
               from hr.duty du where du.tenant_id = p_tenant
              order by 3 desc, du.position loop
      select count(*) into v_missing from hr.duty_grant g
       where g.tenant_id = p_tenant and g.duty_code = d.code
         and not exists (
           select 1 from hr.job_role_access a
            where a.tenant_id = p_tenant and a.job_role_code = r.job_role_code
              and a.outlet_format = r.outlet_format and a.duty_code is null
              and a.access_group = g.access_group
              and a.include_descendants = g.include_descendants
              and (a.scope = g.scope
                   or (d.at_another_department and a.scope like 'department:%')));
      continue when v_missing > 0 or d.n = 0;
      select array_agg(a.id) into v_rows from hr.job_role_access a
        join hr.duty_grant g on g.tenant_id = p_tenant and g.duty_code = d.code
                            and g.access_group = a.access_group
                            and g.include_descendants = a.include_descendants
                            and (a.scope = g.scope
                                 or (d.at_another_department and a.scope like 'department:%'))
       where a.tenant_id = p_tenant and a.job_role_code = r.job_role_code
         and a.outlet_format = r.outlet_format and a.duty_code is null;
      update hr.job_role_access set duty_code = d.code where id = any (v_rows);
      get diagnostics v_n = row_count;
      v_total := v_total + v_n;
    end loop;
  end loop;
  return v_total;
end $$;
-- the product sync (migrator) and the loader (platform_loader) only, never the app
revoke execute on function hr.label_job_role_duties(uuid) from public, app_rw, wf_executor;

-- migrate:down
drop function hr.label_job_role_duties(uuid);
alter table hr.job_role_access drop column duty_code;
delete from core.domain_table
 where table_name in ('hr.duty_grant'::regclass, 'hr.duty'::regclass);
drop table hr.duty_grant;
drop table hr.duty;
