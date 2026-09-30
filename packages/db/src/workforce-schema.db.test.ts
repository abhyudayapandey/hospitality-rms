import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  resetRole,
  type SeedIds,
} from '../test/helpers';
import { newWorker, tenantOf, workerFor } from '../test/workforce';

// Workforce schema (ADR 008): the worker directory, sensitive data, tenant checks,
// self-service resolvers, catalogues through SELF and owner-only notifications. Generic
// RLS coverage and ADR 007 equivalence are in rls-coverage / rls-equivalence tests.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

/** Workers at both outlets and the hub site, for directory tests. */
async function people(c: PoolClient) {
  const sam = await workerFor(c, ids, 'Sam Staff', 'org:Outlet A', 'SERVER');
  const olivia = await workerFor(c, ids, 'Olivia Outlet Manager', 'org:Outlet A', 'MANAGER');
  const bea = await newWorker(c, ids, 'Bea Outlet B', 'org:Outlet B', 'SERVER');
  const hal = await newWorker(c, ids, 'Hal Hub', 'org:Hub', 'STORE');
  await c.query(
    `insert into hr.worker_sensitive (tenant_id, worker_id, owner_user_id, org_node_id,
                                      pay_rate, pay_basis)
     select tenant_id, id, owner_user_id, org_node_id, 150, 'hourly' from hr.worker
      where id = any($1::uuid[])
     on conflict (worker_id) do nothing`,
    [[sam, olivia, bea.workerId, hal.workerId]],
  );
  return { sam, olivia, bea, hal };
}

describe('hr.worker_directory', () => {
  it('lets STAFF see colleagues by name, role and node only, and no other worker fields', async () => {
    await inRolledBackTx(async (c) => {
      const p = await people(c);
      const dir = await attemptAs<Record<string, unknown>>(
        c,
        ids.user('Sam Staff'),
        'select * from hr.worker_directory order by display_name',
      );
      expect(dir.error).toBeUndefined();
      const rows = dir.rows!;
      expect(Object.keys(rows[0]!).sort()).toEqual(
        ['display_name', 'org_node_id', 'role_code', 'worker_id'].sort(),
      );
      const names = rows.map((r) => r.display_name);
      expect(names).toContain('Olivia Outlet Manager');
      expect(names).toContain('Sam Staff');
      expect(names).not.toContain('Bea Outlet B'); // other outlet
      expect(names).not.toContain('Hal Hub');

      // hr.worker itself: only Sam's own row (SELF WORKERS view); no WORKERS grant
      const workers = await attemptAs<{ id: string }>(
        c,
        ids.user('Sam Staff'),
        'select id from hr.worker',
      );
      expect(workers.rows!.map((r) => r.id)).toEqual([p.sam]);
      // sensitive: only his own pay (SELF COMPENSATION view)
      const pay = await attemptAs<{ worker_id: string }>(
        c,
        ids.user('Sam Staff'),
        'select worker_id from hr.worker_sensitive',
      );
      expect(pay.rows!.map((r) => r.worker_id)).toEqual([p.sam]);
    });
  });

  it('matches core.can(ROSTER, view) on the worker node, or own row, for every user', async () => {
    await inRolledBackTx(async (c) => {
      await people(c);
      const users = (
        await c.query<{ id: string; name: string }>(
          `select id, display_name as name from core.app_user order by display_name`,
        )
      ).rows;
      const mismatches: string[] = [];
      for (const u of users) {
        await c.query(`select set_config('app.user_id', $1, true)`, [u.id]);
        const expected = await c.query<{ id: string }>(
          `select w.id from hr.worker w join core.app_user a on a.id = w.owner_user_id
            where w.status = 'active' and a.status = 'active'
              and w.tenant_id = core.my_tenant()
              and core.can('ROSTER', 'view', w.org_node_id, null, w.owner_user_id)
            order by w.id`,
        );
        await actAs(c, 'app_rw', u.id);
        const actual = await c.query<{ id: string }>(
          'select worker_id as id from hr.worker_directory order by worker_id',
        );
        await resetRole(c);
        if (JSON.stringify(expected.rows) !== JSON.stringify(actual.rows)) {
          mismatches.push(`${u.name}: expected ${expected.rowCount}, got ${actual.rowCount}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  it('is not writable', async () => {
    await inRolledBackTx(async (c) => {
      const p = await people(c);
      const r = await attemptAs(
        c,
        ids.user('Olivia Outlet Manager'),
        `update hr.worker_directory set display_name = 'x' where worker_id = $1`,
        [p.sam],
      );
      expect(r.error).toMatch(/permission denied|cannot update/);
    });
  });
});

describe('sensitive worker data', () => {
  it('audits hr.worker_sensitive with field names only', async () => {
    await inRolledBackTx(async (c) => {
      const p = await people(c);
      await c.query(`update hr.worker_sensitive set pay_rate = 175 where worker_id = $1`, [p.sam]);
      const { rows } = await c.query<{ before: unknown; after: unknown; changed_fields: string[] }>(
        `select before, after, changed_fields from audit.log
          where table_name = 'hr.worker_sensitive' and op = 'UPDATE'
          order by occurred_at desc limit 1`,
      );
      expect(rows[0]!.before).toBeNull();
      expect(rows[0]!.after).toBeNull();
      expect(rows[0]!.changed_fields).toContain('pay_rate');
    });
  });

  it('holds no bank or identity-document references (data minimisation)', async () => {
    const { rows } = await inRolledBackTx((c) =>
      c.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'hr' and table_name = 'worker_sensitive'`,
      ),
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('pay_rate');
    expect(cols.filter((c) => /bank|id_doc/.test(c))).toEqual([]);
  });

  it('is hidden from managers without COMPENSATION', async () => {
    await inRolledBackTx(async (c) => {
      await people(c);
      const r = await attemptAs(
        c,
        ids.user('Olivia Outlet Manager'),
        'select * from hr.worker_sensitive',
      );
      // Olivia holds WORKERS view but not COMPENSATION: only her own row (SELF)
      expect(r.rows!.length).toBe(1);
      const hr = await attemptAs(
        c,
        ids.user('Harper HR Admin'),
        'select * from hr.worker_sensitive',
      );
      expect(hr.rows!.length).toBeGreaterThanOrEqual(4);
    });
  });
});

describe('tenant consistency', () => {
  it('rejects rows that reference another tenant', async () => {
    await inRolledBackTx(async (c) => {
      const tenant = await tenantOf(c, ids);
      const other = (
        await c.query<{ id: string }>(
          `insert into core.tenant (name) values ('Other') returning id`,
        )
      ).rows[0]!.id;
      const node = (
        await c.query<{ id: string }>(
          `insert into core.hierarchy_node (tenant_id, type, kind, name)
           values ($1, 'org', 'company', 'Other Co') returning id`,
          [other],
        )
      ).rows[0]!.id;
      await workerFor(c, ids, 'Sam Staff', 'org:Outlet A', 'SERVER');
      await c.query('savepoint s');
      await expect(
        c.query(
          `insert into hr.worker (tenant_id, owner_user_id, org_node_id, role_code)
           values ($1, $2, $3, 'SERVER')`,
          [tenant, ids.user('Casey Chef'), node],
        ),
      ).rejects.toThrow('TENANT_MISMATCH');
      await c.query('rollback to savepoint s');
      await expect(
        c.query(
          `insert into ops.notification (tenant_id, owner_user_id, kind, title)
           values ($1, $2, 'test', 'x')`,
          [other, ids.user('Sam Staff')],
        ),
      ).rejects.toThrow('TENANT_MISMATCH');
    });
  });
});

describe('self-service resolvers', () => {
  it('only the owner can submit their leave draft', async () => {
    await inRolledBackTx(async (c) => {
      const sam = await workerFor(c, ids, 'Sam Staff', 'org:Outlet A', 'SERVER');
      const tenant = await tenantOf(c, ids);
      const type = (
        await c.query<{ id: string }>(
          `insert into hr.leave_type (tenant_id, code, name, annual_days)
           values ($1, 'ZZ_TEST', 'Test leave', 10) returning id`,
          [tenant],
        )
      ).rows[0]!.id;
      const leave = (
        await c.query<{ id: string }>(
          `insert into hr.leave_request (tenant_id, worker_id, owner_user_id, org_node_id,
                                         leave_type_id, from_date, to_date, days)
           values ($1, $2, $3, $4, $5, date '2026-11-02', date '2026-11-03', 2) returning id`,
          [tenant, sam, ids.user('Sam Staff'), ids.node('org:Outlet A'), type],
        )
      ).rows[0]!.id;
      const submit = `select wf.submit('LEAVE', 'hr.leave_request', $1) as id`;
      const casey = await attemptAs(c, ids.user('Casey Chef'), submit, [leave]);
      expect(casey.error).toBe('INVALID_SUBJECT');
      const own = await attemptAs<{ id: string }>(c, ids.user('Sam Staff'), submit, [leave]);
      expect(own.error).toBeUndefined();
    });
  });
});

describe('catalogues through SELF', () => {
  it('shows leave types to self-service users without a LEAVE grant', async () => {
    await inRolledBackTx(async (c) => {
      const tenant = await tenantOf(c, ids);
      await c.query(
        `insert into hr.leave_type (tenant_id, code, name, annual_days)
         values ($1, 'ZZ_TEST', 'Test leave', 10)`,
        [tenant],
      );
      const r = await attemptAs<{ code: string }>(
        c,
        ids.user('Sam Staff'),
        'select code from hr.leave_type',
      );
      expect(r.rows!.map((x) => x.code)).toContain('ZZ_TEST');
      // SELF holds no stock domain: items stay hidden from staff
      const items = await attemptAs(c, ids.user('Sam Staff'), 'select id from inv.item');
      expect(items.rows!.length).toBe(0);
    });
  });
});

describe('notifications', () => {
  it('are visible only to their recipient and not writable by app_rw', async () => {
    await inRolledBackTx(async (c) => {
      const tenant = await tenantOf(c, ids);
      await c.query(`select ops.notify($1, $2, 'test', 'For Sam')`, [
        tenant,
        ids.user('Sam Staff'),
      ]);
      await c.query(`select ops.notify($1, $2, 'test', 'For Casey')`, [
        tenant,
        ids.user('Casey Chef'),
      ]);
      const sam = await attemptAs<{ title: string }>(
        c,
        ids.user('Sam Staff'),
        `select title from ops.notification where kind = 'test'`,
      );
      expect(sam.rows!.map((r) => r.title)).toEqual(['For Sam']);
      const olivia = await attemptAs(
        c,
        ids.user('Olivia Outlet Manager'),
        `select * from ops.notification where kind = 'test'`,
      );
      expect(olivia.rows!.length).toBe(0);
      const write = await attemptAs(
        c,
        ids.user('Sam Staff'),
        `update ops.notification set title = 'x' where kind = 'test'`,
      );
      expect(write.error).toMatch(/permission denied/);
    });
  });
});
