import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx, migratorPool } from '../test/helpers';

// The core seed's policy matrix is authoritative (ADR 002): re-seeding resets
// changed access and removes rows that are not in the matrix.

const seedFile = join(import.meta.dirname, '..', 'seed', '001_core.sql');

afterAll(closePools);

async function policy(c: PoolClient, grp: string, dom: string): Promise<string | null> {
  const { rows } = await c.query<{ access: string }>(
    `select dp.access from core.domain_policy dp
       join core.security_group g on g.id = dp.group_id
       join core.domain d on d.id = dp.domain_id and d.tenant_id = g.tenant_id
      where g.code = $1 and d.code = $2`,
    [grp, dom],
  );
  return rows[0]?.access ?? null;
}

describe('core seed', () => {
  it('re-seeding restores changed access and removes rows not in the matrix', async () => {
    await inRolledBackTx(async (c) => {
      expect(await policy(c, 'STAFF', 'ROSTER')).toBe('view');
      await c.query(
        `update core.domain_policy dp set access = 'modify'
           from core.security_group g, core.domain d
          where g.id = dp.group_id and d.id = dp.domain_id
            and g.code = 'STAFF' and d.code = 'ROSTER'`,
      );
      await c.query(
        `insert into core.domain_policy (tenant_id, domain_id, group_id, access)
         select g.tenant_id, d.id, g.id, 'view'
           from core.security_group g
           join core.domain d on d.tenant_id = g.tenant_id and d.code = 'COMPENSATION'
          where g.code = 'STAFF'`,
      );
      expect(await policy(c, 'STAFF', 'ROSTER')).toBe('modify');
      expect(await policy(c, 'STAFF', 'COMPENSATION')).toBe('view');

      await c.query(await readFile(seedFile, 'utf8'));

      expect(await policy(c, 'STAFF', 'ROSTER')).toBe('view');
      expect(await policy(c, 'STAFF', 'COMPENSATION')).toBeNull();
    });
  });

  it('is idempotent', async () => {
    await inRolledBackTx(async (c) => {
      const count = async () =>
        (
          await c.query<{ n: string }>(
            `select (select count(*) from core.domain_policy)
                  + (select count(*) from core.role_assignment)
                  + (select count(*) from core.hierarchy_node)
                  + (select count(*) from core.node_link) as n`,
          )
        ).rows[0]!.n;
      const before = await count();
      await c.query(await readFile(seedFile, 'utf8'));
      expect(await count()).toBe(before);
    });
  });

  it('grants the workflow domains exactly as approved (ADR 003)', async () => {
    const { rows } = await migratorPool.query<{ dom: string; grp: string; access: string }>(
      `select d.code as dom, g.code as grp, dp.access
         from core.domain_policy dp
         join core.domain d on d.id = dp.domain_id
         join core.security_group g on g.id = dp.group_id
        where d.code in ('SHIFT_SWAPS', 'SECURITY_ROLES', 'WF_CONFIG')
        order by 1, 2`,
    );
    expect(rows.map((r) => `${r.dom} ${r.grp} ${r.access}`)).toEqual([
      'SECURITY_ROLES AUDITOR view',
      'SECURITY_ROLES HR_ADMIN modify',
      'SECURITY_ROLES SECURITY_ADMIN view',
      'SHIFT_SWAPS AI_AGENT view',
      'SHIFT_SWAPS AREA_MANAGER view',
      'SHIFT_SWAPS OUTLET_MANAGER view',
      'SHIFT_SWAPS SELF modify',
      'WF_CONFIG HR_ADMIN view',
      'WF_CONFIG SECURITY_ADMIN view',
    ]);
  });

  it('links the org Hub site to the delivery Hub', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ kind: string; parent: string }>(
        `select o.kind, p.name as parent
           from core.node_link nl
           join core.hierarchy_node o on o.id = nl.org_node_id and o.type = 'org'
           join core.hierarchy_node dlv on dlv.id = nl.delivery_node_id and dlv.type = 'delivery'
           join core.hierarchy_node p on p.id = o.parent_id
          where o.name = 'Hub' and dlv.name = 'Hub'`,
      );
      expect(rows).toEqual([{ kind: 'site', parent: 'Region' }]);
    });
  });
});
