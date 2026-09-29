import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  attemptAs,
  closePools,
  inRolledBackTx,
  installSubjectFixture,
  loadSeedIds,
  resetRole,
  type SeedIds,
} from '../test/helpers';

// Two-tenant isolation. Tenant B is a copy of the seeded tenant A's catalogue:
// identical group and domain codes, the same policy matrix, bp_policy and process
// definitions. Bob holds OUTLET_MANAGER at B's outlet in both trees. Bob must not see
// or act on anything of tenant A, while seeing his own tenant's data (positive control).

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

interface TenantB {
  tenant: string;
  bob: string;
  orgOutlet: string;
  dlvOutlet: string;
}

async function setUpTenantB(c: PoolClient): Promise<TenantB> {
  const tenantA = (
    await c.query<{ id: string }>(`select tenant_id as id from core.app_user limit 1`)
  ).rows[0]!.id;
  const b = (
    await c.query<{ id: string }>(`insert into core.tenant (name) values ('Tenant B') returning id`)
  ).rows[0]!.id;
  const node = async (type: string, kind: string, name: string, parent: string | null) =>
    (
      await c.query<{ id: string }>(
        `insert into core.hierarchy_node (tenant_id, type, kind, name, parent_id)
         values ($1, $2, $3, $4, $5) returning id`,
        [b, type, kind, name, parent],
      )
    ).rows[0]!.id;
  const orgRoot = await node('org', 'company', 'B Company', null);
  const orgOutlet = await node('org', 'outlet', 'B Outlet', orgRoot);
  const dlvRoot = await node('delivery', 'network', 'B Network', null);
  const dlvOutlet = await node('delivery', 'outlet', 'B Outlet', dlvRoot);
  await c.query(
    `insert into core.node_link (tenant_id, org_node_id, delivery_node_id) values ($1, $2, $3)`,
    [b, orgOutlet, dlvOutlet],
  );

  // Identical codes, copied from tenant A.
  await c.query(
    `insert into core.security_group (tenant_id, code, name, kind)
     select $2, code, name, kind from core.security_group where tenant_id = $1`,
    [tenantA, b],
  );
  await c.query(
    `insert into core.domain (tenant_id, code, hierarchy_type)
     select $2, code, hierarchy_type from core.domain where tenant_id = $1`,
    [tenantA, b],
  );
  await c.query(
    `insert into core.domain_policy (tenant_id, domain_id, group_id, access)
     select $2, db.id, gb.id, dp.access
       from core.domain_policy dp
       join core.domain da on da.id = dp.domain_id
       join core.security_group ga on ga.id = dp.group_id
       join core.domain db on db.tenant_id = $2 and db.code = da.code
       join core.security_group gb on gb.tenant_id = $2 and gb.code = ga.code
      where dp.tenant_id = $1`,
    [tenantA, b],
  );
  await c.query(
    `insert into core.bp_policy (tenant_id, process_type, step, group_id, action)
     select $2, bp.process_type, bp.step, gb.id, bp.action
       from core.bp_policy bp
       join core.security_group ga on ga.id = bp.group_id
       join core.security_group gb on gb.tenant_id = $2 and gb.code = ga.code
      where bp.tenant_id = $1`,
    [tenantA, b],
  );
  await c.query(
    `select wf.upsert_process_def(definition) from wf.process_def where tenant_id = $1`,
    [tenantA],
  );

  const bob = (
    await c.query<{ id: string }>(
      `insert into core.app_user (tenant_id, kind, display_name) values ($1, 'human', 'Bob B')
       returning id`,
      [b],
    )
  ).rows[0]!.id;
  await c.query(
    `insert into core.role_assignment (tenant_id, user_id, group_id, node_id, effective_from)
     select $1, $2, g.id, n.node, date '2026-01-01'
       from core.security_group g, unnest(array[$3, $4]::uuid[]) as n(node)
      where g.tenant_id = $1 and g.code = 'OUTLET_MANAGER'`,
    [b, bob, orgOutlet, dlvOutlet],
  );
  return { tenant: b, bob, orgOutlet, dlvOutlet };
}

async function canAs(
  c: PoolClient,
  user: string,
  domain: string,
  access: string,
  org: string | null,
  dlv: string | null,
) {
  const r = await attemptAs<{ ok: boolean }>(c, user, 'select core.can($1, $2, $3, $4) as ok', [
    domain,
    access,
    org,
    dlv,
  ]);
  if (r.error !== undefined) throw new Error(r.error);
  return r.rows[0]!.ok;
}

describe('tenant isolation', () => {
  it('a tenant B outlet manager with identical codes sees and acts on nothing of tenant A', async () => {
    await inRolledBackTx(async (c) => {
      const b = await setUpTenantB(c);

      // Tenant A data: a PO request pending Olivia's approval, and a fixture business table.
      const subject = await installSubjectFixture(c, [
        'inv.purchase_order',
        'inv.stock_adjustment',
      ]);
      const poA = await subject({ delivery: ids.node('delivery:Outlet A'), amount: 1000 });
      const adjA = await subject({ delivery: ids.node('delivery:Outlet A'), amount: 100 });
      const req = await attemptAs<{ id: string }>(
        c,
        ids.user('Kim Storekeeper'),
        `select wf.submit('PURCHASE_ORDER', 'inv.purchase_order', $1) as id`,
        [poA],
      );
      if (req.error !== undefined) throw new Error(req.error);
      const reqA = req.rows[0]!.id;

      await c.query(`create table inv.zz_stock (
        id uuid primary key default core.uuid_v7(), tenant_id uuid not null,
        delivery_node_id uuid not null, label text not null)`);
      await c.query(`insert into core.domain_table (table_name, domain_code, hierarchy_type)
                     values ('inv.zz_stock', 'STOCK_LEVELS', 'delivery')`);
      await c.query(`select core.apply_domain_rls('inv.zz_stock')`);
      await c.query(`select audit.enable('inv.zz_stock')`);
      await c.query(
        `insert into inv.zz_stock (tenant_id, delivery_node_id, label)
         select tenant_id, $1::uuid, 'A' from core.app_user where id = $3
         union all select tenant_id, $2::uuid, 'B' from core.app_user where id = $4`,
        [ids.node('delivery:Outlet A'), b.dlvOutlet, ids.user('Kim Storekeeper'), b.bob],
      );

      // Positive control: Bob has access in his own tenant.
      expect(await canAs(c, b.bob, 'STOCK_LEVELS', 'view', null, b.dlvOutlet)).toBe(true);
      expect(await canAs(c, b.bob, 'ROSTER', 'modify', b.orgOutlet, null)).toBe(true);

      // core.can() on every tenant A node, for every domain Bob's group has.
      for (const [domain, access] of [
        ['STOCK_LEVELS', 'view'],
        ['PURCHASE_ORDERS', 'modify'],
        ['TRANSFERS', 'modify'],
        ['ROSTER', 'modify'],
        ['LEAVE', 'view'],
        ['EVENTS', 'modify'],
      ] as const) {
        for (const n of ['org:Company', 'org:Area', 'org:Outlet A', 'org:Outlet B'] as const) {
          expect(await canAs(c, b.bob, domain, access, ids.node(n), null), `${domain} ${n}`).toBe(
            false,
          );
        }
        for (const n of [
          'delivery:Company Supply Network',
          'delivery:Hub',
          'delivery:Outlet A',
        ] as const) {
          expect(await canAs(c, b.bob, domain, access, null, ids.node(n)), `${domain} ${n}`).toBe(
            false,
          );
        }
      }

      // Rows: only tenant B's stock row; no tenant A wf rows.
      await actAs(c, 'app_rw', b.bob);
      const stock = await c.query<{ label: string }>('select label from inv.zz_stock order by 1');
      expect(stock.rows.map((r) => r.label)).toEqual(['B']);
      const wf = await c.query<{ n: string }>(
        `select (select count(*) from wf.request) + (select count(*) from wf.step_instance)
              + (select count(*) from wf.outbox) + (select count(*) from wf.process_def)
              + (select count(*) from audit.log) as n`,
      );
      expect(wf.rows[0]!.n).toBe('0');
      await resetRole(c);

      // RPCs: no inbox items, cannot act on or submit against tenant A.
      const inbox = await attemptAs<{ request_id: string }>(
        c,
        b.bob,
        'select request_id from wf.my_inbox()',
      );
      expect(inbox.rows).toEqual([]);
      for (const action of ['approve', 'reject', 'cancel']) {
        const r = await attemptAs(c, b.bob, 'select wf.act($1, $2)', [reqA, action]);
        expect(r.error, action).toBe('REQUEST_NOT_FOUND');
      }
      // A tenant A subject does not exist as far as Bob's tenant is concerned.
      const submit = await attemptAs(
        c,
        b.bob,
        `select wf.submit('STOCK_ADJUSTMENT', 'inv.stock_adjustment', $1)`,
        [adjA],
      );
      expect(submit.error).toBe('INVALID_SUBJECT');

      // Tenant A's approver still sees the request; nothing of B leaks the other way.
      const olivia = await attemptAs<{ request_id: string }>(
        c,
        ids.user('Olivia Outlet Manager'),
        'select request_id from wf.my_inbox()',
      );
      expect(olivia.rows?.map((r) => r.request_id)).toEqual([reqA]);
      expect(
        await canAs(
          c,
          ids.user('Olivia Outlet Manager'),
          'STOCK_LEVELS',
          'view',
          null,
          b.dlvOutlet,
        ),
      ).toBe(false);
    });
  });

  it('rejects cross-tenant role assignments, node links and domain policies', async () => {
    await inRolledBackTx(async (c) => {
      const b = await setUpTenantB(c);
      const aTenant = (
        await c.query<{ id: string }>('select tenant_id as id from core.app_user where id = $1', [
          ids.user('Olivia Outlet Manager'),
        ])
      ).rows[0]!.id;
      const one = async (text: string, params: unknown[]) =>
        (await c.query<{ id: string }>(text, params)).rows[0]!.id;
      const groupB = await one(
        `select id from core.security_group where tenant_id = $1 and code = 'OUTLET_MANAGER'`,
        [b.tenant],
      );
      const groupA = await one(
        `select id from core.security_group where tenant_id = $1 and code = 'OUTLET_MANAGER'`,
        [aTenant],
      );
      const domainB = await one(
        `select id from core.domain where tenant_id = $1 and code = 'ROSTER'`,
        [b.tenant],
      );
      const domainA = await one(
        `select id from core.domain where tenant_id = $1 and code = 'ROSTER'`,
        [aTenant],
      );

      const fails = async (text: string, params: unknown[]) => {
        await c.query('savepoint x');
        try {
          await c.query(text, params);
          await c.query('release savepoint x');
          return null;
        } catch (err) {
          await c.query('rollback to savepoint x');
          return (err as Error).message;
        }
      };
      const assign = `insert into core.role_assignment (tenant_id, user_id, group_id, node_id)
                      values ($1, $2, $3, $4)`;
      const link = `insert into core.node_link (tenant_id, org_node_id, delivery_node_id)
                    values ($1, $2, $3)`;
      const policy = `insert into core.domain_policy (tenant_id, domain_id, group_id, access)
                      values ($1, $2, $3, 'view')`;

      // role_assignment: user, group, node each from the other tenant
      expect(
        await fails(assign, [b.tenant, ids.user('Olivia Outlet Manager'), groupB, b.orgOutlet]),
      ).toBe('TENANT_MISMATCH');
      expect(await fails(assign, [b.tenant, b.bob, groupA, b.orgOutlet])).toBe('TENANT_MISMATCH');
      expect(await fails(assign, [b.tenant, b.bob, groupB, ids.node('org:Outlet A')])).toBe(
        'TENANT_MISMATCH',
      );
      expect(await fails(assign, [aTenant, b.bob, groupA, ids.node('org:Outlet A')])).toBe(
        'TENANT_MISMATCH',
      );
      // ...and via UPDATE
      expect(
        await fails(`update core.role_assignment set node_id = $1 where user_id = $2`, [
          ids.node('org:Outlet A'),
          b.bob,
        ]),
      ).toBe('TENANT_MISMATCH');

      // node_link: either node from the other tenant
      expect(await fails(link, [b.tenant, ids.node('org:Outlet A'), b.dlvOutlet])).toBe(
        'TENANT_MISMATCH',
      );
      expect(await fails(link, [b.tenant, b.orgOutlet, ids.node('delivery:Outlet A')])).toBe(
        'TENANT_MISMATCH',
      );

      // domain_policy: group or domain from the other tenant
      expect(await fails(policy, [b.tenant, domainA, groupB])).toBe('TENANT_MISMATCH');
      expect(await fails(policy, [b.tenant, domainB, groupA])).toBe('TENANT_MISMATCH');

      // bp_policy: group from the other tenant
      expect(
        await fails(
          `insert into core.bp_policy (tenant_id, process_type, step, group_id, action)
           values ($1, 'LEAVE', 'extra', $2, 'approve')`,
          [b.tenant, groupA],
        ),
      ).toBe('TENANT_MISMATCH');
      // hierarchy_node: parent from the other tenant (insert and re-parent)
      expect(
        await fails(
          `insert into core.hierarchy_node (tenant_id, type, kind, name, parent_id)
           values ($1, 'org', 'outlet', 'Sneaky', $2)`,
          [b.tenant, ids.node('org:Area')],
        ),
      ).toBe('TENANT_MISMATCH');
      expect(
        await fails(`update core.hierarchy_node set parent_id = $1 where id = $2`, [
          ids.node('org:Area'),
          b.orgOutlet,
        ]),
      ).toBe('TENANT_MISMATCH');

      // Control: a same-tenant row is accepted.
      expect(await fails(assign, [b.tenant, b.bob, groupB, b.dlvOutlet])).toBeNull();
    });
  });
});
