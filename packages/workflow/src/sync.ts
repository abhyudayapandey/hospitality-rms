import type { ClientBase } from 'pg';
import { ACCESS_GROUPS, DOMAINS, DUTIES, checkDuties, type GroupDef } from '@outlet-ops/domain';
import { BP_POLICY, type BpRule } from './bp-policy';
import { PROCESS_DEFS } from './processes';
import { processDefSchema, type ProcessDef } from './types';

/**
 * Writes the product-wide access definition into every tenant (or one): domains, access
 * groups, the domain policy matrix, bp_policy and the duties (ADR 059). Authoritative for
 * product groups: their policy and bp_policy rows that are not in the definition are
 * removed, and so are duties no longer in the catalogue (a duty a job role still holds
 * cannot be removed: the foreign key fails the sync). A company's own groups (kind
 * 'custom', ADR 027) and their rights are left alone. Then labels the tenant's job-role
 * grants with their duties (`hr.label_job_role_duties`), which never changes access. Run
 * as migrator; part of `pnpm db:seed`, every deploy (sync-defs) and the onboarding loader.
 */
export async function syncProductAccess(client: ClientBase, tenantId?: string): Promise<void> {
  checkAdminGroups(ACCESS_GROUPS);
  checkDuties(DUTIES);
  const tenants = tenantId
    ? [tenantId]
    : (await client.query<{ id: string }>('select id from core.tenant order by id')).rows.map(
        (r) => r.id,
      );
  const domains = DOMAINS.map((d) => ({ code: d.code, tree: d.tree, admin: d.admin === true }));
  const groups = ACCESS_GROUPS.map((g) => ({ code: g.code, name: g.name, kind: g.kind }));
  const policy = ACCESS_GROUPS.flatMap((g) =>
    Object.entries(g.grants).map(([domain, access]) => ({ grp: g.code, domain, access })),
  );
  const bp: readonly BpRule[] = BP_POLICY;
  const duties = DUTIES.map((d, i) => ({
    code: d.code,
    name: d.name,
    does: d.does,
    other: d.atAnotherDepartment === true,
    position: i,
  }));
  const dutyGrants = DUTIES.flatMap((d) =>
    d.grants.map((g, i) => ({
      duty: d.code,
      grp: g.group,
      scope: g.scope,
      descendants: !g.thisPlaceOnly,
      position: i,
    })),
  );
  for (const t of tenants) {
    // a product group added since a company built a group with the same code
    const clash = await client.query<{ code: string }>(
      `select code from core.security_group
        where tenant_id = $1 and kind = 'custom' and code = any ($2)`,
      [t, groups.map((g) => g.code)],
    );
    if (clash.rows.length) {
      throw new Error(
        `tenant ${t}: custom groups use product codes: ${clash.rows.map((r) => r.code).join(', ')}`,
      );
    }
    await client.query(
      `insert into core.domain (tenant_id, code, hierarchy_type, admin)
       select $1, d.code, d.tree, d.admin
         from jsonb_to_recordset($2::jsonb) d(code text, tree text, admin boolean)
       on conflict (tenant_id, code) do update set admin = excluded.admin
         where core.domain.admin is distinct from excluded.admin`,
      [t, JSON.stringify(domains)],
    );
    await client.query(
      `insert into core.security_group (tenant_id, code, name, kind)
       select $1, g.code, g.name, g.kind
         from jsonb_to_recordset($2::jsonb) g(code text, name text, kind text)
       on conflict (tenant_id, code) do update set name = excluded.name, kind = excluded.kind
         where (core.security_group.name, core.security_group.kind)
               is distinct from (excluded.name, excluded.kind)`,
      [t, JSON.stringify(groups)],
    );
    await client.query(
      `with want as (
         select g.id as group_id, d.id as domain_id, p.access
           from jsonb_to_recordset($2::jsonb) p(grp text, domain text, access text)
           join core.security_group g on g.tenant_id = $1 and g.code = p.grp
           join core.domain d on d.tenant_id = $1 and d.code = p.domain),
       gone as (
         delete from core.domain_policy dp
          where dp.tenant_id = $1
            and dp.group_id not in (select id from core.security_group
                                     where tenant_id = $1 and kind = 'custom')
            and not exists (select 1 from want w
                             where w.group_id = dp.group_id and w.domain_id = dp.domain_id)
         returning 1)
       insert into core.domain_policy (tenant_id, domain_id, group_id, access)
       select $1, domain_id, group_id, access from want
       on conflict (domain_id, group_id) do update set access = excluded.access
         where core.domain_policy.access is distinct from excluded.access`,
      [t, JSON.stringify(policy)],
    );
    await client.query(
      `with want as (
         select b.process, b.step, g.id as group_id, b.action
           from jsonb_to_recordset($2::jsonb) b(process text, step text, "group" text, action text)
           join core.security_group g on g.tenant_id = $1 and g.code = b."group"),
       gone as (
         delete from core.bp_policy bp
          where bp.tenant_id = $1
            and not exists (select 1 from want w
                             where w.process = bp.process_type and w.step = bp.step
                               and w.group_id = bp.group_id and w.action = bp.action)
         returning 1)
       insert into core.bp_policy (tenant_id, process_type, step, group_id, action)
       select $1, process, step, group_id, action from want
       on conflict (process_type, step, group_id, action) do nothing`,
      [t, JSON.stringify(bp)],
    );
    await client.query(
      `with want as (
         select * from jsonb_to_recordset($2::jsonb)
                d(code text, name text, does text, other boolean, position int)),
       gone as (
         delete from hr.duty du
          where du.tenant_id = $1 and not exists (select 1 from want w where w.code = du.code)
         returning 1)
       insert into hr.duty (tenant_id, code, name, does, at_another_department, position)
       select $1, code, name, does, other, position from want
       on conflict (tenant_id, code) do update
          set name = excluded.name, does = excluded.does,
              at_another_department = excluded.at_another_department,
              position = excluded.position
        where (hr.duty.name, hr.duty.does, hr.duty.at_another_department, hr.duty.position)
              is distinct from (excluded.name, excluded.does, excluded.at_another_department,
                                excluded.position)`,
      [t, JSON.stringify(duties)],
    );
    await client.query(
      `with want as (
         select * from jsonb_to_recordset($2::jsonb)
                g(duty text, grp text, scope text, descendants boolean, position int)),
       gone as (
         delete from hr.duty_grant dg
          where dg.tenant_id = $1
            and not exists (select 1 from want w
                             where w.duty = dg.duty_code and w.grp = dg.access_group
                               and w.scope = dg.scope))
       insert into hr.duty_grant (tenant_id, duty_code, access_group, scope,
                                  include_descendants, position)
       select $1, duty, grp, scope, descendants, position from want
       on conflict (tenant_id, duty_code, access_group, scope) do update
          set include_descendants = excluded.include_descendants, position = excluded.position
        where (hr.duty_grant.include_descendants, hr.duty_grant.position)
              is distinct from (excluded.include_descendants, excluded.position)`,
      [t, JSON.stringify(dutyGrants)],
    );
    await client.query('select hr.label_job_role_duties($1)', [t]);
  }
}

/** Admin groups carry no business data (also enforced by a trigger on domain_policy). */
function checkAdminGroups(groups: readonly GroupDef[]): void {
  const admin = new Set(DOMAINS.filter((d) => d.admin).map((d) => d.code));
  for (const g of groups) {
    if (g.kind !== 'admin') continue;
    const bad = Object.keys(g.grants).filter((d) => !admin.has(d));
    if (bad.length)
      throw new Error(`admin group ${g.code} holds business domains: ${bad.join(', ')}`);
  }
}

/** Validates the code definitions and upserts them into wf.process_def (as migrator). */
export async function syncProcessDefs(
  client: ClientBase,
  defs: readonly ProcessDef[] = PROCESS_DEFS,
): Promise<number> {
  for (const def of defs) {
    const parsed = processDefSchema.parse(def);
    await client.query('select wf.upsert_process_def($1::jsonb)', [JSON.stringify(parsed)]);
  }
  return defs.length;
}
