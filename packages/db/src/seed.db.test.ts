import { afterAll, describe, expect, it } from 'vitest';
import { closePools, migratorPool } from '../test/helpers';

// What `pnpm db:seed` leaves behind: the two test customers loaded from
// docs/onboarding/test-data by the onboarding loader (tested in packages/onboarding), plus
// the dev layer (seed/dev/001_workforce_dev.sql). The loader's own guarantees (exact
// access, idempotency, errors) are tested with the loader.

afterAll(closePools);

const TODAY = `(now() at time zone 'Asia/Kolkata')::date`;

describe('test customers', () => {
  it('are loaded with their people, places and stock', async () => {
    const { rows } = await migratorPool.query<{
      code: string;
      users: number;
      places: number;
      items: number;
      stocked: number;
    }>(
      `select t.code,
              (select count(*)::int from core.app_user u
                where u.tenant_id = t.id and u.username like 'test.%') as users,
              (select count(*)::int from core.hierarchy_node n where n.tenant_id = t.id) as places,
              (select count(*)::int from inv.item i where i.tenant_id = t.id) as items,
              (select count(*)::int from inv.stock_level s
                where s.tenant_id = t.id and s.on_hand > 0) as stocked
         from core.tenant t where t.code like 'TEST-%' order by t.code`,
    );
    expect(rows).toEqual([
      { code: 'TEST-COMPANY', users: 113, places: 49, items: 81, stocked: 332 },
      { code: 'TEST-SOLO-COMPANY', users: 9, places: 9, items: 56, stocked: 52 },
    ]);
  });

  it('keep the stock cache equal to the ledger everywhere', async () => {
    const { rows } = await migratorPool.query<{ mismatched: number }>(
      `select count(*)::int as mismatched from inv.stock_level s
        where s.on_hand <> (select coalesce(sum(qty), 0) from inv.stock_ledger l
                             where l.item_id = s.item_id
                               and l.delivery_node_id = s.delivery_node_id)`,
    );
    expect(rows[0]!.mismatched).toBe(0);
  });

  it('each have an AI agent service user with view access at both tree roots', async () => {
    const { rows } = await migratorPool.query<{ code: string; roots: number }>(
      `select t.code, count(distinct ra.node_id)::int as roots
         from core.tenant t
         join core.app_user u on u.tenant_id = t.id and u.kind = 'service'
         join core.role_assignment ra on ra.user_id = u.id
         join core.security_group g on g.id = ra.group_id and g.code = 'AI_AGENT'
         join core.hierarchy_node n on n.id = ra.node_id and n.parent_id is null
        where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') -- e2e creates other customers
        group by t.code order by t.code`,
    );
    expect(rows).toEqual([
      { code: 'TEST-COMPANY', roots: 2 },
      { code: 'TEST-SOLO-COMPANY', roots: 2 },
    ]);
  });
});

describe('dev layer (seed/dev/001_workforce_dev.sql)', () => {
  it('has this week published and next week in draft, and no assignment breaks a rule', async () => {
    // next week at the places the test shifts file (25) covers is published by the loader
    const FILE_25 = `(n.code like 'TEST-BAR-3.0-%' or n.code in ('TEST-HOTEL-1.0-KITCHEN', 'TEST-HOTEL-1.0-BAR'))`;
    const { rows } = await migratorPool.query<{ week: number; file: boolean; status: string }>(
      `select distinct (s.local_date - hr.week_start(${TODAY})) / 7 as week,
              ${FILE_25} as file, s.status
         from hr.shift s join core.hierarchy_node n on n.id = s.org_node_id
        where s.local_date between hr.week_start(${TODAY}) and hr.week_start(${TODAY}) + 13
          and s.template_id is not null
        order by 1, 2, 3`,
    );
    expect(rows.map((r) => [r.week, r.file, r.status])).toEqual([
      [0, false, 'published'],
      [0, true, 'published'],
      [1, false, 'draft'],
      [1, true, 'published'],
    ]);
    const assigned = await migratorPool.query<{ n: number }>(
      `select count(*)::int n from hr.shift_assignment a
         join hr.shift s on s.id = a.shift_id
        where s.local_date between hr.week_start(${TODAY}) and hr.week_start(${TODAY}) + 13`,
    );
    expect(assigned.rows[0]!.n).toBeGreaterThan(100);
    const broken = await migratorPool.query(
      `select a.id, v.code from hr.shift_assignment a
         join hr.shift s on s.id = a.shift_id,
         lateral hr.assignment_violation(a.worker_id, a.start_at, a.end_at, a.org_node_id,
                                         s.role_code, a.id) v
        where a.status = 'assigned' and s.template_id is not null`,
    );
    expect(broken.rows).toEqual([]);
  });

  it('has leave balances for every worker and geofences for every outlet and site', async () => {
    const { rows } = await migratorPool.query<{ unbalanced: number; unfenced: string[] }>(
      `select (select count(*)::int from hr.worker w
                 join core.app_user u on u.id = w.owner_user_id and u.username like 'test.%'
                where not exists (select 1 from hr.leave_balance b where b.worker_id = w.id))
                as unbalanced,
              (select coalesce(array_agg(n.code order by n.code), '{}') from core.hierarchy_node n
                where n.type = 'org' and n.kind in ('outlet', 'site')
                  and hr.geofence_for(n.id) is null) as unfenced`,
    );
    expect(rows[0]).toEqual({ unbalanced: 0, unfenced: [] });
  });
});
