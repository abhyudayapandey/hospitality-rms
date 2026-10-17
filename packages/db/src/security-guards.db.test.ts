import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  migratorPool,
  newPlatformAdmin,
  resetRole,
  type SeedIds,
} from '../test/helpers';

// Guards for the class of leak behind the transfer summary (ADR 166): a view re-created
// without security_invoker ran as its owner and showed every customer's transfers to anyone
// signed in, and no test looked at views. These look at every relation and function the app
// can reach, not a sample.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

/**
 * Views the app may read that run as their owner on purpose, each with why. A view here
 * must filter by the caller's company itself.
 */
const DEFINER_VIEWS: Record<string, string> = {
  'hr.worker_directory':
    'names and job roles of active people for pickers, without the rest of hr.worker; ' +
    'filters by core.my_tenant() and ROSTER places itself (security_barrier)',
};

/**
 * Relations the app may read that have no tenant_id column, with the SQL (run as the owner)
 * that gives each row's company, keyed by the relation's row id column.
 */
const NO_TENANT_COLUMN: Record<string, { key: string; tenantOf: string }> = {
  'hr.worker_directory': {
    key: 'worker_id',
    tenantOf: 'select id, tenant_id from hr.worker',
  },
};

/** SECURITY DEFINER functions anyone (PUBLIC) may run, each with why. None today. */
const PUBLIC_DEFINERS: Record<string, string> = {};

const viewsQuery = `
  select c.oid::regclass::text as view
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('v', 'm') and n.nspname not in ('pg_catalog', 'information_schema')
     and has_any_column_privilege('app_rw', c.oid, 'select')
     and not coalesce('security_invoker=true' = any(c.reloptions)
                      or 'security_invoker=on' = any(c.reloptions), false)
   order by 1`;

const publicDefinersQuery = `
  select p.oid::regprocedure::text as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema', 'extensions')
     and (p.proacl is null
          or exists (select 1 from aclexplode(p.proacl) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
   order by 1`;

describe('views the app can read', () => {
  it('run as the caller (security_invoker), or are on the allow-list with a reason', async () => {
    const { rows } = await migratorPool.query<{ view: string }>(viewsQuery);
    expect(rows.map((r) => r.view).filter((v) => !(v in DEFINER_VIEWS))).toEqual([]);
  });

  it('a view made without security_invoker is caught (so the check above can fail)', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('create view inv.zz_open as select id, tenant_id from inv.transfer');
      await c.query('grant select on inv.zz_open to app_rw');
      const { rows } = await c.query<{ view: string }>(viewsQuery);
      expect(rows.map((r) => r.view)).toContain('inv.zz_open');
      // re-creating with CREATE OR REPLACE drops the option: the transfer summary's leak
      await c.query(
        `create view inv.zz_shut with (security_invoker = true) as select id from inv.transfer`,
      );
      await c.query('grant select on inv.zz_shut to app_rw');
      expect((await c.query<{ view: string }>(viewsQuery)).rows.map((r) => r.view)).not.toContain(
        'inv.zz_shut',
      );
      await c.query(`create or replace view inv.zz_shut as select id from inv.transfer`);
      expect((await c.query<{ view: string }>(viewsQuery)).rows.map((r) => r.view)).toContain(
        'inv.zz_shut',
      );
    });
  });
});

interface Relation {
  rel: string;
  has_tenant: boolean;
}

/** Every table and view app_rw may select from (any column), partitions included. */
async function readableRelations(c: PoolClient): Promise<Relation[]> {
  const { rows } = await c.query<Relation>(
    `select c.oid::regclass::text as rel,
            exists (select 1 from pg_attribute a
                     where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
                       and has_column_privilege('app_rw', c.oid, a.attnum, 'select')) as has_tenant
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm', 'f')
        and n.nspname not in ('pg_catalog', 'information_schema')
        and has_any_column_privilege('app_rw', c.oid, 'select')
      order by 1`,
  );
  return rows;
}

/**
 * Rows of `others` (company ids) that `viewer` reads from each relation, as app_rw: the
 * relations with any, and those that failed to read.
 */
async function sweep(
  c: PoolClient,
  viewer: { user: string | null; platformAdmin?: string },
  others: string[],
): Promise<{ leaks: string[]; errors: string[]; checked: number }> {
  const relations = await readableRelations(c);
  // the company of each row of a relation without tenant_id, read as the owner
  const owners = new Map<string, Map<string, string>>();
  for (const r of relations.filter((x) => !x.has_tenant)) {
    const spec = NO_TENANT_COLUMN[r.rel];
    if (!spec) continue;
    const { rows } = await c.query<{ id: string; tenant_id: string }>(spec.tenantOf);
    owners.set(r.rel, new Map(rows.map((x) => [x.id, x.tenant_id])));
  }
  await actAs(c, 'app_rw', viewer.user);
  if (viewer.platformAdmin) {
    await c.query(`select set_config('app.platform_admin_id', $1, true)`, [viewer.platformAdmin]);
  }
  const leaks: string[] = [];
  const errors: string[] = [];
  let checked = 0;
  for (const r of relations) {
    await c.query('savepoint sweep');
    try {
      if (r.has_tenant) {
        const { rows } = await c.query<{ n: string }>(
          `select count(*) as n from ${r.rel} where tenant_id = any($1::uuid[])`,
          [others],
        );
        if (rows[0]!.n !== '0') leaks.push(`${r.rel}: ${rows[0]!.n}`);
      } else {
        const spec = NO_TENANT_COLUMN[r.rel];
        if (!spec) {
          errors.push(`${r.rel}: no tenant_id column and not in NO_TENANT_COLUMN`);
        } else {
          const { rows } = await c.query<{ id: string }>(`select ${spec.key} as id from ${r.rel}`);
          const of = owners.get(r.rel)!;
          const n = rows.filter((x) => others.includes(of.get(x.id) ?? '')).length;
          if (n > 0) leaks.push(`${r.rel}: ${n}`);
        }
      }
      checked += 1;
      await c.query('release savepoint sweep');
    } catch (err) {
      await c.query('rollback to savepoint sweep');
      errors.push(`${r.rel}: ${(err as Error).message}`);
    }
  }
  await resetRole(c);
  await c.query(`select set_config('app.platform_admin_id', '', true)`);
  return { leaks, errors, checked };
}

describe('tenant isolation, every relation', () => {
  it('a Test Solo Bar Co. manager reads no row of Test Company anywhere', async () => {
    await inRolledBackTx(async (c) => {
      const r = await sweep(c, { user: ids.user('test.solo.bar-manager') }, [ids.tenant()]);
      expect(r.errors).toEqual([]);
      expect(r.leaks).toEqual([]);
      expect(r.checked).toBeGreaterThan(100);
    });
  });

  it("Test Company's account owner reads no row of Test Solo Bar Co. anywhere", async () => {
    await inRolledBackTx(async (c) => {
      const r = await sweep(c, { user: ids.user('test.account-owner') }, [
        ids.tenant('TEST-SOLO-COMPANY'),
      ]);
      expect(r.errors).toEqual([]);
      expect(r.leaks).toEqual([]);
    });
  });

  it('a request with no person, and a platform admin, read no customer row anywhere', async () => {
    await inRolledBackTx(async (c) => {
      const both = [ids.tenant(), ids.tenant('TEST-SOLO-COMPANY')];
      const nobody = await sweep(c, { user: null }, both);
      expect(nobody.errors).toEqual([]);
      expect(nobody.leaks).toEqual([]);
      const admin = await newPlatformAdmin(c, 'platform-sub-sweep');
      const platform = await sweep(c, { user: null, platformAdmin: admin }, both);
      expect(platform.errors).toEqual([]);
      expect(platform.leaks).toEqual([]);
    });
  });

  it("the positive control: an area manager reads their own company's transfers", async () => {
    await inRolledBackTx(async (c) => {
      await actAs(c, 'app_rw', ids.user('test.area-manager'));
      const own = await c.query<{ n: string }>(
        'select count(*) as n from inv.transfer_summary where tenant_id = $1',
        [ids.tenant()],
      );
      expect(Number(own.rows[0]!.n)).toBeGreaterThan(0);
    });
  });
});

describe('SECURITY DEFINER functions', () => {
  it('none may be run by PUBLIC outside the allow-list', async () => {
    const { rows } = await migratorPool.query<{ fn: string }>(publicDefinersQuery);
    expect(rows.map((r) => r.fn).filter((f) => !(f in PUBLIC_DEFINERS))).toEqual([]);
  });

  it('a new function is not PUBLIC by default (default privileges)', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`create function core.zz_new() returns int language sql security definer
                     set search_path = pg_catalog as $$ select 1 $$`);
      const { rows } = await c.query<{ fn: string }>(publicDefinersQuery);
      expect(rows.map((r) => r.fn)).not.toContain('core.zz_new()');
    });
  });

  it('the roles keep what they call: app_rw, wf_executor and platform_loader', async () => {
    const { rows } = await migratorPool.query<{ fn: string; role: string; ok: boolean }>(
      `select f.fn, r.role, has_function_privilege(r.role, f.fn::regprocedure, 'execute') as ok
         from unnest(array['core.can(text,text,uuid,uuid,uuid)', 'core.org_root(uuid)',
                           'core.my_tenant()', 'core.can_any(text,text)', 'core.node_name(uuid)',
                           'core.visible_nodes(text,text)', 'core.visible_domain_nodes(text)'])
              f(fn),
              unnest(array['app_rw', 'wf_executor', 'platform_loader']) r(role)
       union all
       select f.fn, 'app_rw', has_function_privilege('app_rw', f.fn::regprocedure, 'execute')
         from unnest(array['platform.account_owners(uuid)',
                           'platform.remove_account_owner(uuid,uuid,text)']) f(fn)
        order by 1, 2`,
    );
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });
});
