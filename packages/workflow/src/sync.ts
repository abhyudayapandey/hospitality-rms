import type { ClientBase } from 'pg';
import { ACCESS_GROUPS, DOMAINS, type GroupDef } from '@outlet-ops/domain';
import { BP_POLICY, type BpRule } from './bp-policy';
import { PROCESS_DEFS } from './processes';
import { processDefSchema, type ProcessDef } from './types';

/**
 * Writes the product-wide access definition into every tenant (or one): domains, access
 * groups, the domain policy matrix and bp_policy. Authoritative: a tenant's policy and
 * bp_policy rows that are not in the definition are removed. Run as migrator; part of
 * `pnpm db:seed`, every deploy (sync-defs) and the onboarding loader.
 */
export async function syncProductAccess(client: ClientBase, tenantId?: string): Promise<void> {
  checkAdminGroups(ACCESS_GROUPS);
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
  for (const t of tenants) {
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
