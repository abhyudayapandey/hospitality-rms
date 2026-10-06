import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx } from '../test/helpers';

// Job-role default access (ADR 009): scope words are resolved from the person's home place
// by walking the tree, with the documented fallbacks and per-format overrides. Uses its own
// tenant so it does not depend on the seed.

afterAll(closePools);

interface Fixture {
  tenant: string;
  node: (code: string) => string;
  person: (code: string, role: string, home: string) => Promise<string>;
}

async function fixture(c: PoolClient): Promise<Fixture> {
  const tenant = (
    await c.query<{ id: string }>(
      `insert into core.tenant (name, code) values ('JRA Test', 'JRA-TEST') returning id`,
    )
  ).rows[0]!.id;
  const nodes = new Map<string, string>();
  const add = async (
    type: 'org' | 'delivery',
    code: string,
    kind: string,
    parent: string | null,
    extra: { format?: string; holds?: boolean; main?: boolean } = {},
  ) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into core.hierarchy_node (tenant_id, type, kind, name, code, parent_id,
                                        outlet_format, holds_stock, is_main_store)
       values ($1, $2, $3, $4, $4, $5, $6, coalesce($7, $3 = 'store'), coalesce($8, false))
       returning id`,
      [
        tenant,
        type,
        kind,
        code,
        parent && nodes.get(parent),
        extra.format ?? null,
        extra.holds ?? null,
        extra.main ?? null,
      ],
    );
    nodes.set(code, rows[0]!.id);
  };
  await add('org', 'CO', 'company', null);
  await add('org', 'AREA', 'area', 'CO');
  await add('org', 'HOTEL', 'outlet', 'AREA', { format: 'hotel' });
  await add('org', 'HOTEL-BAR', 'department', 'HOTEL');
  await add('org', 'HOTEL-KITCHEN', 'department', 'HOTEL');
  await add('org', 'HOTEL-SECURITY', 'department', 'HOTEL');
  await add('org', 'GH', 'outlet', 'AREA', { format: 'hotel' });
  await add('org', 'BAR3', 'outlet', 'AREA', { format: 'bar_pub' });
  await add('org', 'BAR3-BAR', 'department', 'BAR3');
  await add('org', 'CK', 'site', 'AREA');
  await add('org', 'CK-PROD', 'department', 'CK');
  await add('delivery', 'NET', 'network', null, { holds: false });
  await add('delivery', 'CK-STORE', 'hub', 'NET', { holds: true });
  await add('delivery', 'HOTEL-SUPPLY', 'outlet', 'CK-STORE', { holds: false });
  await add('delivery', 'HOTEL-MAIN', 'store', 'HOTEL-SUPPLY', { main: true });
  await add('delivery', 'HOTEL-BAR-STORE', 'store', 'HOTEL-SUPPLY');
  await add('delivery', 'GH-SUPPLY', 'outlet', 'CK-STORE', { holds: true });
  await add('delivery', 'BAR3-SUPPLY', 'outlet', 'CK-STORE', { holds: false });
  await add('delivery', 'BAR3-BAR-STORE', 'store', 'BAR3-SUPPLY');
  for (const [o, d] of [
    ['HOTEL', 'HOTEL-SUPPLY'],
    ['HOTEL-BAR', 'HOTEL-BAR-STORE'],
    ['GH', 'GH-SUPPLY'],
    ['BAR3', 'BAR3-SUPPLY'],
    ['BAR3-BAR', 'BAR3-BAR-STORE'],
    ['CK', 'CK-STORE'],
  ]) {
    await c.query(
      `insert into core.node_link (tenant_id, org_node_id, delivery_node_id) values ($1, $2, $3)`,
      [tenant, nodes.get(o!), nodes.get(d!)],
    );
  }
  for (const g of [
    'STAFF',
    'STOCK_USER',
    'STORE_KEEPER',
    'DEPARTMENT_HEAD',
    'OUTLET_MANAGER',
    'HUB_MANAGER',
    'AREA_MANAGER',
  ]) {
    await c.query(
      `insert into core.security_group (tenant_id, code, name, kind) values ($1, $2, $2, 'role')`,
      [tenant, g],
    );
  }
  // job role -> [format, group, scope, include_descendants]
  const roles: Record<string, [string, string, string, boolean][]> = {
    COOK: [
      ['any', 'STOCK_USER', 'department_store', true],
      ['any', 'STAFF', 'home_department', true],
    ],
    BAR_MANAGER: [
      ['any', 'DEPARTMENT_HEAD', 'home_department', true],
      ['any', 'STORE_KEEPER', 'department_store', true],
      ['bar_pub', 'OUTLET_MANAGER', 'whole_outlet', true],
      ['bar_pub', 'OUTLET_MANAGER', 'outlet_stores', true],
    ],
    STORE_KEEPER: [['any', 'STORE_KEEPER', 'main_store', true]],
    FANDB_MANAGER: [
      ['any', 'DEPARTMENT_HEAD', 'home_department', true],
      ['any', 'DEPARTMENT_HEAD', 'department:BAR', true],
    ],
    CK_MANAGER: [['any', 'HUB_MANAGER', 'central_kitchen_store', false]],
    AREA_MANAGER: [['any', 'AREA_MANAGER', 'whole_area', true]],
    BROKEN: [['any', 'DEPARTMENT_HEAD', 'department:NOPE', true]],
  };
  for (const [code, rows] of Object.entries(roles)) {
    await c.query(`insert into hr.job_role (tenant_id, code, name) values ($1, $2, $2)`, [
      tenant,
      code,
    ]);
    for (const [i, [format, group, scope, desc]] of rows.entries()) {
      await c.query(
        `insert into hr.job_role_access (tenant_id, job_role_code, outlet_format, access_group,
                                         scope, include_descendants, position)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [tenant, code, format, group, scope, desc, i],
      );
    }
  }
  const node = (code: string) => nodes.get(code)!;
  const person = async (code: string, role: string, home: string) => {
    const user = (
      await c.query<{ id: string }>(
        `insert into core.app_user (tenant_id, kind, display_name, username)
         values ($1, 'human', $2, lower($2)) returning id`,
        [tenant, code],
      )
    ).rows[0]!.id;
    await c.query(
      `insert into hr.worker (tenant_id, owner_user_id, org_node_id, role_code)
       values ($1, $2, $3, $4)`,
      [tenant, user, node(home), role],
    );
    return user;
  };
  return { tenant, node, person };
}

type Derived = { group: string; node: string; below: boolean; source: string; error: string };

async function derive(c: PoolClient, user: string, f: Fixture): Promise<Derived[]> {
  const codes = new Map<string, string>();
  for (const r of (
    await c.query<{ id: string; code: string }>(
      `select id, code from core.hierarchy_node where tenant_id = $1`,
      [f.tenant],
    )
  ).rows) {
    codes.set(r.id, r.code);
  }
  const { rows } = await c.query<{
    access_group: string;
    node_id: string | null;
    include_descendants: boolean;
    source: string;
    error: string | null;
  }>(`select * from core.derive_job_role_access($1)`, [user]);
  return rows.map((r) => ({
    group: r.access_group,
    node: r.node_id ? codes.get(r.node_id)! : '',
    below: r.include_descendants,
    source: r.source,
    error: r.error ?? '',
  }));
}

const ok = (group: string, node: string, source = 'job role default (any)', below = true) => ({
  group,
  node,
  below,
  source,
  error: '',
});

describe('job-role default access', () => {
  it('a cook uses the department store, or the outlet stock location when there is none', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      expect(await derive(c, await f.person('HOTEL-COOK', 'COOK', 'HOTEL-KITCHEN'), f)).toEqual([
        // the Hotel kitchen has no linked store: the supply point holds none, so the main store
        ok(
          'STOCK_USER',
          'HOTEL-MAIN',
          "job role default (any) — fallback: no store linked to their department, so the outlet's stock location",
        ),
        ok('STAFF', 'HOTEL-KITCHEN'),
      ]);
      // Guest House: no departments, stock held at the supply point itself
      expect(await derive(c, await f.person('GH-COOK', 'COOK', 'GH'), f)).toEqual([
        ok(
          'STOCK_USER',
          'GH-SUPPLY',
          "job role default (any) — fallback: no store linked to their department, so the outlet's stock location",
        ),
        ok('STAFF', 'GH'),
      ]);
    });
  });

  it('a standalone bar overrides the Bar Manager default; a hotel bar keeps it', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      expect(await derive(c, await f.person('HOTEL-BM', 'BAR_MANAGER', 'HOTEL-BAR'), f)).toEqual([
        ok('DEPARTMENT_HEAD', 'HOTEL-BAR'),
        ok('STORE_KEEPER', 'HOTEL-BAR-STORE'),
      ]);
      const sb = 'job role default (bar_pub)';
      expect(await derive(c, await f.person('BAR3-BM', 'BAR_MANAGER', 'BAR3'), f)).toEqual([
        ok('OUTLET_MANAGER', 'BAR3', sb),
        ok('OUTLET_MANAGER', 'BAR3-SUPPLY', sb),
      ]);
    });
  });

  it('resolves main store, named departments, the central kitchen store and the area', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      expect(
        await derive(c, await f.person('HOTEL-SK', 'STORE_KEEPER', 'HOTEL-SECURITY'), f),
      ).toEqual([ok('STORE_KEEPER', 'HOTEL-MAIN')]);
      expect(await derive(c, await f.person('GH-SK', 'STORE_KEEPER', 'GH'), f)).toEqual([
        ok(
          'STORE_KEEPER',
          'GH-SUPPLY',
          "job role default (any) — fallback: no main store, so the outlet's stock location",
        ),
      ]);
      expect(
        await derive(c, await f.person('HOTEL-FB', 'FANDB_MANAGER', 'HOTEL-KITCHEN'), f),
      ).toEqual([ok('DEPARTMENT_HEAD', 'HOTEL-KITCHEN'), ok('DEPARTMENT_HEAD', 'HOTEL-BAR')]);
      expect(await derive(c, await f.person('CKM', 'CK_MANAGER', 'CK-PROD'), f)).toEqual([
        ok('HUB_MANAGER', 'CK-STORE', 'job role default (any)', false),
      ]);
      expect(await derive(c, await f.person('AM', 'AREA_MANAGER', 'AREA'), f)).toEqual([
        ok('AREA_MANAGER', 'AREA'),
      ]);
    });
  });

  it('reports what cannot be resolved instead of guessing', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      // no main store and the supply point holds no stock: a main store is required
      await c.query(`update core.hierarchy_node set is_main_store = false where id = $1`, [
        f.node('HOTEL-MAIN'),
      ]);
      const sk = await f.person('HOTEL-SK', 'STORE_KEEPER', 'HOTEL-SECURITY');
      expect((await derive(c, sk, f)).map((d) => d.error)).toEqual([
        'MAIN_STORE_REQUIRED (main_store)',
      ]);
      const broken = await f.person('B', 'BROKEN', 'HOTEL-BAR');
      expect((await derive(c, broken, f)).map((d) => d.error)).toEqual([
        'DEPARTMENT_NOT_FOUND (department:NOPE)',
      ]);
      await c.query('savepoint s');
      await expect(c.query('select core.apply_job_role_access($1)', [broken])).rejects.toThrow(
        'JOB_ROLE_SCOPE',
      );
      await c.query('rollback to savepoint s');
    });
  });

  it('applies idempotently and replaces only job-role assignments', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c);
      const bm = await f.person('BAR3-BM', 'BAR_MANAGER', 'BAR3-BAR');
      await c.query(
        `insert into core.role_assignment (tenant_id, user_id, group_id, node_id, source)
         select $1, $2, id, $3, 'extra' from core.security_group
          where tenant_id = $1 and code = 'AREA_MANAGER'`,
        [f.tenant, bm, f.node('AREA')],
      );
      const held = async () =>
        (
          await c.query<{ k: string }>(
            `select g.code || '@' || n.code || ':' || coalesce(ra.source, '') as k
               from core.role_assignment ra
               join core.security_group g on g.id = ra.group_id
               join core.hierarchy_node n on n.id = ra.node_id
              where ra.user_id = $1 order by 1`,
            [bm],
          )
        ).rows.map((r) => r.k);
      await c.query('select core.apply_job_role_access($1)', [bm]);
      await c.query('select core.apply_job_role_access($1)', [bm]);
      expect(await held()).toEqual([
        'AREA_MANAGER@AREA:extra',
        'OUTLET_MANAGER@BAR3:job_role',
        'OUTLET_MANAGER@BAR3-SUPPLY:job_role',
      ]);
      // moved into the bar department of the hotel: the job-role grants follow
      await c.query(`update hr.worker set org_node_id = $1 where owner_user_id = $2`, [
        f.node('HOTEL-BAR'),
        bm,
      ]);
      await c.query('select core.apply_job_role_access($1)', [bm]);
      expect(await held()).toEqual([
        'AREA_MANAGER@AREA:extra',
        'DEPARTMENT_HEAD@HOTEL-BAR:job_role',
        'STORE_KEEPER@HOTEL-BAR-STORE:job_role',
      ]);
    });
  });
});
