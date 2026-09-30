import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx, migratorPool } from '../test/helpers';

// The core seed: tenant, trees and users. Access comes from the product sync, tested in
// packages/workflow/src/product.db.test.ts.

const seedFile = join(import.meta.dirname, '..', 'seed', '001_core.sql');

afterAll(closePools);

describe('core seed', () => {
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

describe('dev inventory seed (dev/003_inventory_dev.sql)', () => {
  it('has about 40 items and 2 suppliers, each item set up at the hub and both outlets', async () => {
    const { rows } = await migratorPool.query<{
      items: number;
      suppliers: number;
      missing: number;
      categories: number;
    }>(
      `select (select count(*)::int from inv.item where sku not like 'T-%') as items,
              (select count(*)::int from inv.supplier where name in
                 ('FreshFarm Produce', 'Metro Wholesale Foods')) as suppliers,
              (select count(*)::int from inv.item i
                where i.id::text like '01920000-0000-7000-8000-0000000004%'
                  and (select count(*) from inv.item_node n where n.item_id = i.id) <> 3) as missing,
              (select count(distinct category)::int from inv.item) as categories`,
    );
    expect(rows[0]!.items).toBeGreaterThanOrEqual(40);
    expect(rows[0]).toMatchObject({ suppliers: 2, missing: 0 });
    expect(rows[0]!.categories).toBeGreaterThanOrEqual(6);
  });

  it('has opening stock, with the cache matching the ledger everywhere', async () => {
    const { rows } = await migratorPool.query<{ mismatched: number; opening: number }>(
      `select (select count(*)::int from inv.stock_level s
                where s.on_hand <> (select coalesce(sum(qty), 0) from inv.stock_ledger l
                                     where l.item_id = s.item_id
                                       and l.delivery_node_id = s.delivery_node_id)) as mismatched,
              (select count(*)::int from inv.stock_ledger where ref_type = 'opening') as opening`,
    );
    expect(rows[0]!.mismatched).toBe(0);
    expect(rows[0]!.opening).toBeGreaterThanOrEqual(120);
  });
});

describe('dev workforce seed (dev/004_workforce_dev.sql)', () => {
  const SEEDED = `w.id::text like '01920000-0000-7000-8000-0000000007%'`;

  it('has 12 workers: 5 at Outlet A, 4 at Outlet B, 3 at the Hub site', async () => {
    const { rows } = await migratorPool.query<{ name: string; n: number }>(
      `select n.name, count(*)::int n from hr.worker w
         join core.hierarchy_node n on n.id = w.org_node_id
        where ${SEEDED} group by n.name order by n.name`,
    );
    expect(rows).toEqual([
      { name: 'Hub', n: 3 },
      { name: 'Outlet A', n: 5 },
      { name: 'Outlet B', n: 4 },
    ]);
  });

  it('has this week published and next week in draft, and no assignment breaks a rule', async () => {
    const { rows } = await migratorPool.query<{ week: number; status: string; n: number }>(
      `select (s.local_date - hr.week_start((now() at time zone 'Asia/Kolkata')::date)) / 7 as week,
              s.status, count(*)::int n
         from hr.shift s
        where s.template_id::text like '01920000-0000-7000-8000-0000000008%'
          and s.local_date between hr.week_start((now() at time zone 'Asia/Kolkata')::date)
                               and hr.week_start((now() at time zone 'Asia/Kolkata')::date) + 13
        group by 1, 2 order by 1, 2`,
    );
    expect(rows.map((r) => [r.week, r.status])).toEqual([
      [0, 'published'],
      [1, 'draft'],
    ]);
    const broken = await migratorPool.query(
      `select a.id, v.code from hr.shift_assignment a
         join hr.worker w on w.id = a.worker_id
         join hr.shift s on s.id = a.shift_id,
         lateral hr.assignment_violation(a.worker_id, a.start_at, a.end_at, a.org_node_id,
                                         s.role_code, a.id) v
        where a.status = 'assigned' and ${SEEDED}`,
    );
    expect(broken.rows).toEqual([]);
  });

  it('has leave types, balances for every worker, geofences and three upcoming events', async () => {
    const { rows } = await migratorPool.query<{
      types: number;
      unbalanced: number;
      fences: number;
      events: number;
      reqs: number;
    }>(
      `select (select count(*)::int from hr.leave_type where code in ('ANNUAL','SICK','CASUAL','UNPAID')) types,
              (select count(*)::int from hr.worker w where ${SEEDED}
                and not exists (select 1 from hr.leave_balance b where b.worker_id = w.id
                                   and b.year = extract(year from now() at time zone 'Asia/Kolkata'))) unbalanced,
              (select count(*)::int from hr.node_setting where latitude is not null) fences,
              (select count(*)::int from ops.event
                where id::text like '01920000-0000-7000-8000-00000000095%' and starts_at > now()) events,
              (select count(*)::int from ops.event_requirement
                where id::text like '01920000-0000-7000-8000-00000000096%'
                   or id::text like '01920000-0000-7000-8000-00000000097%') reqs`,
    );
    expect(rows[0]).toEqual({ types: 4, unbalanced: 0, fences: 3, events: 3, reqs: 10 });
  });
});
