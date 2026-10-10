import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Roles with little to do (ADR 109): the accountant reads the outlet's vendor bills and orders
// and opens the purchasing report (READS_BILLS); the sales manager plans events (PLANS_EVENTS).
// Neither gains anything else: no stock counts or wastage, no pay, no other report. The job
// roles are made here as the catalogue gives them (packages/domain/src/catalogue.ts), from
// the duties the product sync wrote into the tenant (hr.duty_grant), at Test Hotel 1.0.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const ROLES: Record<string, string[]> = {
  ACCOUNTANT: ['WORKS_SHIFTS', 'READS_BILLS'],
  SALES_MANAGER: ['WORKS_SHIFTS', 'PLANS_EVENTS'],
  // what every shift worker holds, to compare against
  JUST_WORKS: ['WORKS_SHIFTS'],
};

async function person(c: PoolClient, role: string, place: string): Promise<string> {
  const tenant = ids.tenant();
  await c.query(
    `insert into hr.job_role (tenant_id, code, name) values ($1, $2, initcap($2))
     on conflict (tenant_id, code) do nothing`,
    [tenant, role],
  );
  await c.query(
    `insert into hr.job_role_access (tenant_id, job_role_code, outlet_format, access_group, scope,
                                     include_descendants, position, duty_code)
     select $1, $2, 'any', g.access_group, g.scope, g.include_descendants,
            row_number() over (order by d.ord, g.position), g.duty_code
       from unnest($3::text[]) with ordinality d(code, ord)
       join hr.duty_grant g on g.tenant_id = $1 and g.duty_code = d.code
     on conflict do nothing`,
    [tenant, role, ROLES[role]],
  );
  const user = (
    await c.query<{ id: string }>(
      `insert into core.app_user (tenant_id, kind, display_name) values ($1, 'human', $2)
       returning id`,
      [tenant, `Test ${role}`],
    )
  ).rows[0]!.id;
  await c.query(
    `insert into hr.worker (tenant_id, owner_user_id, org_node_id, role_code, joined_on)
     values ($1, $2, $3, $4, date '2026-01-01')`,
    [tenant, user, ids.node(place), role],
  );
  await c.query('select core.apply_job_role_access($1)', [user]);
  return user;
}

async function as<T extends object>(
  c: PoolClient,
  user: string,
  sql: string,
  params: unknown[] = [],
) {
  const r = await attemptAs<T>(c, user, sql, params);
  if (r.error !== undefined) throw new Error(`${sql}: ${r.error}`);
  return r.rows;
}

async function domains(c: PoolClient, user: string): Promise<Map<string, string>> {
  const rows = await as<{ domain: string; access: string }>(
    c,
    user,
    'select domain, access from core.my_domains()',
  );
  return new Map(rows.map((r) => [r.domain, r.access]));
}

/** What `user` holds beyond what someone who only works shifts at `place` holds. */
async function gained(c: PoolClient, user: string, place: string) {
  const base = await domains(c, await person(c, 'JUST_WORKS', place));
  const mine = await domains(c, user);
  return Object.fromEntries([...mine].filter(([d, a]) => base.get(d) !== a));
}

const reports = async (c: PoolClient, user: string) =>
  (await as<{ report: string }>(c, user, 'select report from rpt.my_reports()')).map(
    (r) => r.report,
  );

const can = async (c: PoolClient, user: string, domain: string, access: string, store: string) =>
  (
    await as<{ v: boolean }>(c, user, 'select core.can($1, $2, null, $3) as v', [
      domain,
      access,
      ids.node(store),
    ])
  )[0]!.v;

describe('the accountant (ADR 109)', () => {
  const PLACE = 'TEST-HOTEL-1.0-ADMIN-FINANCE';
  const KITCHEN = 'TEST-HOTEL-1.0-KITCHEN-STORE';

  it("reads the outlet's bills and orders, and nothing else beyond a shift worker's", async () => {
    await inRolledBackTx(async (c) => {
      const acc = await person(c, 'ACCOUNTANT', PLACE);
      expect(await gained(c, acc, PLACE)).toEqual({ BILLS: 'view', PURCHASE_ORDERS: 'view' });
      for (const store of [KITCHEN, 'TEST-HOTEL-1.0-BAR-STORE']) {
        expect(await can(c, acc, 'BILLS', 'view', store)).toBe(true);
        expect(await can(c, acc, 'BILLS', 'modify', store)).toBe(false);
        expect(await can(c, acc, 'STOCK_ADJUSTMENTS', 'view', store)).toBe(false);
        expect(await can(c, acc, 'PURCHASE_ORDERS', 'modify', store)).toBe(false);
      }
      // another outlet's stores are not theirs
      expect(await can(c, acc, 'BILLS', 'view', 'TEST-BAR-3.0-BAR-STORE')).toBe(false);
      // a bill the GM adds at the kitchen store is there to read (RLS), as the GM reads them
      const store = ids.node(KITCHEN);
      const file = `bills/${ids.tenant()}/${store}/${crypto.randomUUID()}.pdf`;
      const bill = (
        await as<{ id: string }>(
          c,
          ids.user('test.general-manager.1.0'),
          `select inv.add_bill($1, null, null, 'Pest Co', 'PC-1', current_date, 1200,
                               'Monthly service', $2::text[], null) as id`,
          [store, [file]],
        )
      )[0]!.id;
      const seen = await as<{ id: string }>(c, acc, 'select id from inv.bill');
      // every bill of Hotel 1.0's stores, and no other (read as the migrator, without RLS)
      const outlet = (
        await c.query<{ id: string }>(
          `select b.id from inv.bill b join core.hierarchy_node n on n.id = b.delivery_node_id
            where n.type = 'delivery' and n.code like 'TEST-HOTEL-1.0-%'`,
        )
      ).rows;
      expect(seen.map((r) => r.id)).toContain(bill);
      expect(seen.map((r) => r.id).sort()).toEqual(outlet.map((r) => r.id).sort());
    });
  });

  it('opens the purchasing report, and no stock, cost, pay or people report', async () => {
    await inRolledBackTx(async (c) => {
      const acc = await person(c, 'ACCOUNTANT', PLACE);
      const mine = await reports(c, acc);
      expect(mine).toContain('purchasing');
      for (const r of [
        'stock_position',
        'cost_of_sales',
        'labour_cost',
        'people',
        'outlet_flash',
      ]) {
        expect(mine, r).not.toContain(r);
      }
      // the same price changes the cost controller reads, store by store
      const p = [ids.node(KITCHEN), '2020-01-01', '2100-01-01'];
      const q = 'select sku, unit_cost from rpt.price_changes($1, $2, $3) order by 1, 2';
      expect(await as(c, acc, q, p)).toEqual(
        await as(c, ids.user('test.cost-controller.1.0'), q, p),
      );
      expect(
        (await attemptAs(c, acc, 'select * from rpt.stock_summary($1)', [ids.node(KITCHEN)])).error,
      ).toBeDefined();
      // no pay: no labour cost, and only their own pay record
      expect(
        (await as<{ v: boolean }>(c, acc, "select core.can_any('LABOUR_COST', 'view') as v"))[0]!.v,
      ).toBe(false);
      const pay = await as<{ n: number }>(
        c,
        acc,
        `select count(*)::int as n from hr.worker_sensitive
          where owner_user_id <> core.current_user_id()`,
      );
      expect(pay[0]!.n).toBe(0);
    });
  });
});

describe('the sales manager (ADR 109)', () => {
  const PLACE = 'TEST-HOTEL-1.0-BANQUETS';

  it('creates an event at the outlet, and gains nothing else', async () => {
    await inRolledBackTx(async (c) => {
      const sm = await person(c, 'SALES_MANAGER', PLACE);
      expect(await gained(c, sm, PLACE)).toEqual({ EVENTS: 'modify' });
      const r = await attemptAs<{ id: string }>(
        c,
        sm,
        `select ops.upsert_event(null, $1, 'Corporate dinner', $2::timestamptz, $3::timestamptz,
                                 80, null, '[]'::jsonb, 'planned', null) as id`,
        [ids.node('TEST-HOTEL-1.0'), '2026-12-12T13:00:00Z', '2026-12-12T16:00:00Z'],
      );
      expect(r.error).toBeUndefined();
      // not at another outlet
      const away = await attemptAs(
        c,
        sm,
        `select ops.upsert_event(null, $1, 'Elsewhere', $2::timestamptz, $3::timestamptz,
                                 10, null, '[]'::jsonb, 'planned', null)`,
        [ids.node('TEST-BAR-3.0'), '2026-12-12T13:00:00Z', '2026-12-12T16:00:00Z'],
      );
      expect(away.error).toMatch(/NOT_AUTHORISED/);
      expect(await reports(c, sm)).toEqual(['my_week']);
    });
  });
});
