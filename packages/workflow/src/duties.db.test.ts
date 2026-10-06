import { DUTIES } from '@outlet-ops/domain';
import { closePools, inRolledBackTx, migratorPool } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { syncProductAccess } from './sync';

// Duties (ADR 059): the catalogue in code is what every tenant holds, the sync is
// authoritative, and labelling job-role grants with their duty never changes anyone's
// access.

afterAll(closePools);

const want = DUTIES.flatMap((d) =>
  d.grants.map((g) => `${d.code} ${g.group}@${g.scope} ${!g.thisPlaceOnly}`),
).sort();

async function catalogue(c: PoolClient | typeof migratorPool, tenant: string) {
  const { rows } = await c.query<{ k: string }>(
    `select g.duty_code || ' ' || g.access_group || '@' || g.scope || ' ' || g.include_descendants k
       from hr.duty_grant g where g.tenant_id = $1`,
    [tenant],
  );
  return rows.map((r) => r.k).sort();
}

/** Every worker's derived job-role access, as text, for one tenant. */
async function derived(c: PoolClient, tenant: string): Promise<string[]> {
  const { rows } = await c.query<{ k: string }>(
    `select w.owner_user_id || ' ' || d.access_group || ' ' || coalesce(d.node_id::text, '-')
            || ' ' || d.include_descendants || ' ' || d.source || ' ' || coalesce(d.error, '') k
       from hr.worker w cross join lateral core.derive_job_role_access(w.owner_user_id) d
      where w.tenant_id = $1 and w.owner_user_id is not null`,
    [tenant],
  );
  return rows.map((r) => r.k).sort();
}

async function tenantOf(c: PoolClient, code: string): Promise<string> {
  return (await c.query<{ id: string }>(`select id from core.tenant where code = $1`, [code]))
    .rows[0]!.id;
}

describe('duties', () => {
  it('every tenant holds exactly the code catalogue', async () => {
    const tenants = await migratorPool.query<{ id: string }>(`select id from core.tenant`);
    expect(tenants.rowCount).toBeGreaterThan(1);
    for (const { id } of tenants.rows) {
      expect(await catalogue(migratorPool, id)).toEqual(want);
      const names = await migratorPool.query<{ code: string; name: string }>(
        `select code, name from hr.duty where tenant_id = $1 order by position`,
        [id],
      );
      expect(names.rows).toEqual(DUTIES.map((d) => ({ code: d.code, name: d.name })));
    }
  });

  it("every grant of the test customers' job roles comes from a duty", async () => {
    const { rows } = await migratorPool.query<{ n: number }>(
      `select count(*)::int n from hr.job_role_access a join core.tenant t on t.id = a.tenant_id
        where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') and a.duty_code is null`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('the sync restores a changed duty and removes one not in the code', async () => {
    await inRolledBackTx(async (c) => {
      const t = await tenantOf(c, 'TEST-COMPANY');
      await c.query(
        `update hr.duty_grant set scope = 'whole_outlet'
          where tenant_id = $1 and duty_code = 'WORKS_SHIFTS'`,
        [t],
      );
      await c.query(
        `insert into hr.duty (tenant_id, code, name, does) values ($1, 'OLD_DUTY', 'Old', 'Old')`,
        [t],
      );
      await c.query(
        `insert into hr.duty_grant (tenant_id, duty_code, access_group, scope)
         values ($1, 'OLD_DUTY', 'STAFF', 'whole_outlet')`,
        [t],
      );
      expect(await catalogue(c, t)).not.toEqual(want);
      await syncProductAccess(c, t);
      expect(await catalogue(c, t)).toEqual(want);
    });
  });

  it('refuses to remove a duty a job role still holds', async () => {
    await inRolledBackTx(async (c) => {
      const t = await tenantOf(c, 'TEST-COMPANY');
      await c.query(
        `insert into hr.duty (tenant_id, code, name, does) values ($1, 'OLD_DUTY', 'Old', 'Old')`,
        [t],
      );
      await c.query(
        `update hr.job_role_access set duty_code = 'OLD_DUTY'
          where tenant_id = $1 and job_role_code = 'BELLBOY'`,
        [t],
      );
      await expect(syncProductAccess(c, t)).rejects.toThrow(/foreign key/);
    });
  });

  it('labelling puts every grant back under its duty and changes no one’s access', async () => {
    await inRolledBackTx(async (c) => {
      for (const code of ['TEST-COMPANY', 'TEST-SOLO-COMPANY']) {
        const t = await tenantOf(c, code);
        const labels = async () =>
          (
            await c.query<{ k: string }>(
              `select job_role_code || ' ' || outlet_format || ' ' || access_group || '@' || scope
                      || ' ' || coalesce(duty_code, '-') k
                 from hr.job_role_access where tenant_id = $1 order by 1`,
              [t],
            )
          ).rows.map((r) => r.k);
        const before = await labels();
        const access = await derived(c, t);
        expect(access.length).toBeGreaterThan(5);
        await c.query(`update hr.job_role_access set duty_code = null where tenant_id = $1`, [t]);
        const { rows } = await c.query<{ n: number }>(`select hr.label_job_role_duties($1) n`, [t]);
        expect(rows[0]!.n).toBe(before.length);
        expect(await labels()).toEqual(before);
        expect(await derived(c, t)).toEqual(access);
      }
    });
  });

  it('labels a duty only when all its grants are there, and leaves direct grants alone', async () => {
    await inRolledBackTx(async (c) => {
      const t = await tenantOf(c, 'TEST-COMPANY');
      await c.query(`insert into hr.job_role (tenant_id, code, name) values ($1, 'X_ROLE', 'X')`, [
        t,
      ]);
      const grant = (group: string, scope: string, descendants = true) =>
        c.query(
          `insert into hr.job_role_access (tenant_id, job_role_code, outlet_format, access_group,
                                           scope, include_descendants)
           values ($1, 'X_ROLE', 'any', $2, $3, $4)`,
          [t, group, scope, descendants],
        );
      // half of RUNS_CENTRAL_KITCHEN_STORE, half of RUNS_OUTLET, a duty at another
      // department, a duty whose "this store only" differs, and a company's own group
      await grant('HUB_MANAGER', 'central_kitchen_store', false);
      await grant('OUTLET_MANAGER', 'whole_outlet');
      await grant('DEPARTMENT_HEAD', 'department:BAR');
      await grant('STORE_KEEPER', 'central_kitchen_store', true);
      await grant('KITCHEN_LEAD', 'home_department');
      await c.query('select hr.label_job_role_duties($1)', [t]);
      const { rows } = await c.query<{ k: string }>(
        `select access_group || '@' || scope || ' ' || coalesce(duty_code, '-') k
           from hr.job_role_access where tenant_id = $1 and job_role_code = 'X_ROLE' order by 1`,
        [t],
      );
      expect(rows.map((r) => r.k)).toEqual([
        'DEPARTMENT_HEAD@department:BAR RUNS_DEPARTMENT',
        'HUB_MANAGER@central_kitchen_store -',
        'KITCHEN_LEAD@home_department -',
        'OUTLET_MANAGER@whole_outlet -',
        'STORE_KEEPER@central_kitchen_store -',
      ]);
    });
  });
});
