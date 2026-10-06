import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Duties are product catalogue (ADR 059): readable, like job-role access, by people who
// administer users; never written by the app; the labelling function is for the product
// sync and the loader only.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

describe('duty tables from the app', () => {
  it('a user admin reads the catalogue; frontline staff see nothing', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await attemptAs<{ n: number }>(
        c,
        ids.user('test.general-manager.1.0'),
        `select (select count(*)::int from hr.duty) + (select count(*)::int from hr.duty_grant) n`,
      );
      expect(admin.rows?.[0]?.n).toBeGreaterThan(20);
      const server = await attemptAs<{ n: number }>(
        c,
        ids.user('test.server.3.0'),
        `select (select count(*)::int from hr.duty) + (select count(*)::int from hr.duty_grant) n`,
      );
      expect(server.rows?.[0]?.n).toBe(0);
    });
  });

  it('only sees its own company', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs<{ n: number }>(
        c,
        ids.user('test.general-manager.1.0'),
        `select count(*)::int n from hr.duty where tenant_id <> $1`,
        [ids.tenant()],
      );
      expect(r.rows?.[0]?.n).toBe(0);
    });
  });

  it('cannot change duties, their grants or a job role’s duty', async () => {
    await inRolledBackTx(async (c) => {
      const owner = ids.user('test.account-owner');
      const t = ids.tenant();
      for (const sql of [
        `insert into hr.duty (tenant_id, code, name, does) values ('${t}', 'NEW_DUTY', 'N', 'N')`,
        `update hr.duty set name = 'x' where code = 'RUNS_OUTLET'`,
        `delete from hr.duty where code = 'RUNS_OUTLET'`,
        `insert into hr.duty_grant (tenant_id, duty_code, access_group, scope)
         values ('${t}', 'RUNS_OUTLET', 'STAFF', 'whole_company')`,
        `update hr.duty_grant set scope = 'whole_company' where duty_code = 'WORKS_SHIFTS'`,
        `update hr.job_role_access set duty_code = 'RUNS_OUTLET' where job_role_code = 'BELLBOY'`,
        `select hr.label_job_role_duties('${t}')`,
      ]) {
        const r = await attemptAs(c, owner, sql);
        expect(r.error, sql).toMatch(/permission denied/);
      }
    });
  });
});
