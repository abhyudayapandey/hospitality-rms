import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCESS_GROUPS, DOMAINS, RETIRED_GROUPS } from '@outlet-ops/domain';
import { closePools, inRolledBackTx, migratorPool } from '@outlet-ops/db/test-helpers';
import { afterAll, describe, expect, it } from 'vitest';
import { BP_POLICY } from './bp-policy';
import { syncProductAccess } from './sync';

// The product-wide access definition (ADR 009): what is in the code is what every tenant
// has, the sync is authoritative, admin groups hold no business data, and the code matches
// the product reference file in docs/onboarding/test-data.

afterAll(closePools);

const key = (g: string, d: string, a: string) => `${g} ${d} ${a}`;

describe('product access', () => {
  it('every tenant holds exactly the code matrix and bp_policy', async () => {
    const want = ACCESS_GROUPS.flatMap((g) =>
      Object.entries(g.grants).map(([d, a]) => key(g.code, d, a)),
    ).sort();
    const tenants = await migratorPool.query<{ id: string }>(
      `select distinct tenant_id as id from core.domain_policy`,
    );
    expect(tenants.rowCount).toBeGreaterThan(0);
    for (const { id } of tenants.rows) {
      const { rows } = await migratorPool.query<{ k: string }>(
        `select g.code || ' ' || d.code || ' ' || dp.access as k
           from core.domain_policy dp
           join core.security_group g on g.id = dp.group_id
           join core.domain d on d.id = dp.domain_id
          where dp.tenant_id = $1 order by 1`,
        [id],
      );
      expect(rows.map((r) => r.k).sort()).toEqual(want);
      const bp = await migratorPool.query<{ k: string }>(
        `select bp.process_type || '/' || bp.step || '/' || g.code || '/' || bp.action as k
           from core.bp_policy bp join core.security_group g on g.id = bp.group_id
          where bp.tenant_id = $1 order by 1`,
        [id],
      );
      expect(bp.rows.map((r) => r.k).sort()).toEqual(
        BP_POLICY.map((b) => `${b.process}/${b.step}/${b.group}/${b.action}`).sort(),
      );
    }
  });

  it('the sync restores changed access and removes rows that are not in the code', async () => {
    await inRolledBackTx(async (c) => {
      const policy = async (grp: string, dom: string) =>
        (
          await c.query<{ access: string }>(
            `select dp.access from core.domain_policy dp
               join core.security_group g on g.id = dp.group_id
               join core.domain d on d.id = dp.domain_id and d.tenant_id = g.tenant_id
              where g.code = $1 and d.code = $2 limit 1`,
            [grp, dom],
          )
        ).rows[0]?.access ?? null;
      await c.query(
        `update core.domain_policy dp set access = 'modify'
           from core.security_group g, core.domain d
          where g.id = dp.group_id and d.id = dp.domain_id and g.code = 'STAFF' and d.code = 'ROSTER'`,
      );
      await c.query(
        `insert into core.domain_policy (tenant_id, domain_id, group_id, access)
         select g.tenant_id, d.id, g.id, 'view' from core.security_group g
           join core.domain d on d.tenant_id = g.tenant_id and d.code = 'COMPENSATION'
          where g.code = 'STAFF'`,
      );
      expect(await policy('STAFF', 'ROSTER')).toBe('modify');
      await syncProductAccess(c);
      expect(await policy('STAFF', 'ROSTER')).toBe('view');
      expect(await policy('STAFF', 'COMPENSATION')).toBeNull();
    });
  });

  it('admin groups hold only admin domains, in code and in the database', async () => {
    const admin = new Set(DOMAINS.filter((d) => d.admin).map((d) => d.code));
    for (const g of ACCESS_GROUPS.filter((x) => x.kind === 'admin')) {
      expect(
        Object.keys(g.grants).filter((d) => !admin.has(d)),
        g.code,
      ).toEqual([]);
    }
    await inRolledBackTx(async (c) => {
      await c.query('savepoint s');
      await expect(
        c.query(
          `insert into core.domain_policy (tenant_id, domain_id, group_id, access)
           select g.tenant_id, d.id, g.id, 'view' from core.security_group g
             join core.domain d on d.tenant_id = g.tenant_id and d.code = 'STOCK_LEVELS'
            where g.code = 'ACCOUNT_OWNER' limit 1`,
        ),
      ).rejects.toThrow('ADMIN_NOT_DATA');
      await c.query('rollback to savepoint s');
    });
  });

  it('matches the product access-group reference, and CHEF is retired', async () => {
    const csv = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'docs',
        'onboarding',
        'test-data',
        'PRODUCT_access_groups_REFERENCE.csv',
      ),
      'utf8',
    );
    const documented = csv
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split(',')[0]!)
      .sort();
    const code = ACCESS_GROUPS.map((g) => g.code)
      .filter((c) => c !== 'AI_AGENT')
      .sort();
    expect(code).toEqual(documented);
    for (const retired of Object.keys(RETIRED_GROUPS)) {
      expect(code).not.toContain(retired);
    }
    const { rows } = await migratorPool.query(
      `select 1 from core.security_group where code = any($1)`,
      [Object.keys(RETIRED_GROUPS)],
    );
    expect(rows).toEqual([]);
  });
});
