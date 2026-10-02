import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The figures docs/onboarding/test-data/README.md promises for the test-only activity
// files 25 to 28 (ADR 017), read through the app's own functions as the people who would
// look. The window is the 7 days ending on the closing count's day (the load day). Figures
// that depend only on that window are pinned; running totals (the expected closing) are
// only pinned where the README says so.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

interface Row {
  sku: string;
  production_in: string;
  production_out: string;
  sales_use: string;
  expected_closing: string;
  variance_qty: string;
  variance_value: string;
  counted: boolean;
  unexplained: boolean;
}
interface Cost {
  menu: string;
  revenue: string;
  theoretical_pct: string;
  actual_pct: string;
}

/** The window: the 7 days ending on the day of the Hotel 1.0 Bar Store closing count. */
async function window(c: PoolClient): Promise<{ from: string; to: string }> {
  const { rows } = await c.query<{ from: string; to: string }>(
    `select ((max(submitted_at) at time zone 'Asia/Kolkata')::date - 6)::text as from,
            ((max(submitted_at) at time zone 'Asia/Kolkata')::date)::text as to
       from inv.stock_count where delivery_node_id = $1 and status = 'submitted'`,
    [ids.node('TEST-HOTEL-1.0-BAR-STORE')],
  );
  expect(rows[0]!.to).not.toBeNull();
  return rows[0]!;
}

async function variance(c: PoolClient, user: string, store: string): Promise<Map<string, Row>> {
  const w = await window(c);
  const r = await attemptAs<Row>(c, ids.user(user), 'select * from inv.variance($1, $2, $3)', [
    ids.node(store),
    w.from,
    w.to,
  ]);
  if (r.error !== undefined) throw new Error(r.error);
  return new Map(r.rows.map((x) => [x.sku, x]));
}

async function costs(c: PoolClient, user: string, outlet: string): Promise<Cost[]> {
  const w = await window(c);
  const r = await attemptAs<Cost>(
    c,
    ids.user(user),
    'select menu, revenue, theoretical_pct, actual_pct from menu.cost_report($1, $2, $3) order by menu',
    [ids.node(outlet), w.from, w.to],
  );
  if (r.error !== undefined) throw new Error(r.error);
  return r.rows;
}

const n = (v: string) => Number(v);

describe('Test Company activity (files 25 to 28): the README figures', () => {
  it('Hotel 1.0 Bar Store: the closing count, one unexplained loss (gin), the rest on target', async () => {
    await inRolledBackTx(async (c) => {
      const v = await variance(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0-BAR-STORE');
      const gin = v.get('GIN-750ML')!;
      expect([n(gin.sales_use), n(gin.variance_qty), n(gin.variance_value)]).toEqual([
        4.8, -1, -1800,
      ]);
      expect([gin.counted, gin.unexplained]).toEqual([true, true]);
      // within its 2% tolerance: posted at the count, not a loss to explain
      const vodka = v.get('VODKA-750ML')!;
      expect([n(vodka.sales_use), n(vodka.variance_qty), n(vodka.variance_value)]).toEqual([
        2.88, -0.1, -140,
      ]);
      expect(vodka.unexplained).toBe(false);
      for (const sku of [
        'BLENDED-WHISKY-750ML',
        'WHITE-RUM-750ML',
        'RED-WINE-750ML',
        'LAGER-BEER-330ML',
        'TONIC-WATER-300ML',
      ]) {
        expect([sku, v.get(sku)!.counted, n(v.get(sku)!.variance_qty)]).toEqual([sku, true, 0]);
      }
      expect([...v.values()].filter((r) => r.unexplained).map((r) => r.sku)).toEqual(['GIN-750ML']);
      // house mixers made here and used by the bar's sales
      const syrup = v.get('SUGAR-SYRUP')!;
      expect([n(syrup.production_in), n(syrup.production_out), n(syrup.sales_use)]).toEqual([
        800, 400, 360,
      ]);
      const sour = v.get('SOUR-MIX')!;
      expect([n(sour.production_in), n(sour.sales_use)]).toEqual([900, 810]);
      // the count's loss went through approval: approved by the GM, posted by the executor
      const { rows } = await c.query<{ state: string; initiator: string; approver: string }>(
        `select r.state, i.username as initiator, a.username as approver
           from inv.stock_count sc
           join inv.stock_adjustment adj on adj.id = sc.adjustment_id
           join wf.request r on r.id = adj.wf_request_id
           join core.app_user i on i.id = r.initiator_id
           join wf.step_instance s on s.request_id = r.id
           join core.app_user a on a.id = s.actor_id
          where sc.delivery_node_id = $1 order by sc.submitted_at desc limit 1`,
        [ids.node('TEST-HOTEL-1.0-BAR-STORE')],
      );
      expect(rows[0]).toEqual({
        state: 'completed',
        initiator: 'test.bar-manager.1.0',
        approver: 'test.general-manager.1.0',
      });
    });
  });

  it('Bar 3.0 Bar Store: tonic sold below zero, nothing counted, nothing unexplained', async () => {
    await inRolledBackTx(async (c) => {
      const v = await variance(c, 'test.bar-manager.3.0', 'TEST-BAR-3.0-BAR-STORE');
      const tonic = v.get('TONIC-WATER-300ML')!;
      expect(n(tonic.sales_use)).toBe(42);
      expect(n(tonic.expected_closing)).toBeLessThan(0); // -8 cans on the first load
      expect(tonic.counted).toBe(false);
      const negroni = v.get('NEGRONI-BATCH')!;
      expect([n(negroni.production_in), n(negroni.sales_use)]).toEqual([2000, 1620]);
      expect([...v.values()].filter((r) => r.unexplained)).toEqual([]);
      expect([...v.values()].filter((r) => n(r.expected_closing) < 0).map((r) => r.sku)).toEqual([
        'TONIC-WATER-300ML',
      ]);
    });
  });

  it('cost %: Hotel 1.0 and Bar 3.0, recipe against actual', async () => {
    await inRolledBackTx(async (c) => {
      const pct = (r: Cost[]) =>
        r.map((x) => [x.menu, n(x.revenue), n(x.theoretical_pct), n(x.actual_pct)]);
      expect(pct(await costs(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0'))).toEqual([
        ['Bar', 107550, 34.4, 36.2],
        ['Food', 37620, 21.5, 21.5],
      ]);
      expect(pct(await costs(c, 'test.bar-manager.3.0', 'TEST-BAR-3.0'))).toEqual([
        ['Bar', 58860, 38.1, 38.1],
        ['Food', 12000, 10.1, 10.1],
      ]);
    });
  });

  it('batches: six made by the production team, the Mint Chutney one expired with 140 g left', async () => {
    await inRolledBackTx(async (c) => {
      const w = await window(c);
      const made = await c.query<{ sku: string; username: string }>(
        `select i.sku, u.username from inv.production p
           join inv.item i on i.id = p.prep_item_id
           join core.app_user u on u.id = p.created_by
          where p.tenant_id = $1 and p.idempotency_key like 'test-data %'
            and (p.made_at at time zone 'Asia/Kolkata')::date between $2::date and $3::date
          order by p.made_at`,
        [ids.tenant(), w.from, w.to],
      );
      expect(made.rows.map((r) => `${r.sku} ${r.username}`)).toEqual([
        'SUGAR-SYRUP test.bartender.1.0',
        'MINT-CHUTNEY test.commis.1.0',
        'GINGER-GARLIC-PASTE test.commis-b.1.0',
        'NEGRONI-BATCH test.bartender.3.0',
        'GINGER-GARLIC-PASTE test.commis.3.0',
        'SOUR-MIX test.bartender-b.1.0',
      ]);
      const r = await attemptAs<{ sku: string; remaining: string; expired: boolean }>(
        c,
        ids.user('test.commis.1.0'),
        'select sku, remaining, expired from inv.batches($1) where expired',
        [ids.node('TEST-HOTEL-1.0-KITCHEN-STORE')],
      );
      expect(r.rows?.map((x) => [x.sku, n(x.remaining)])).toEqual([['MINT-CHUTNEY', 140]]);
    });
  });

  it('shifts: two weeks from next Monday, published, every file row assigned', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ assigned: number; unpublished: number; people: number }>(
        `select count(*)::int as assigned,
                count(*) filter (where s.status <> 'published')::int as unpublished,
                count(distinct a.worker_id)::int as people
           from hr.shift_assignment a
           join hr.shift s on s.id = a.shift_id
           join core.hierarchy_node n on n.id = s.org_node_id
          where a.status = 'assigned' and a.tenant_id = $1
            and (n.code like 'TEST-BAR-3.0-%' or n.code in ('TEST-HOTEL-1.0-KITCHEN', 'TEST-HOTEL-1.0-BAR'))
            and s.local_date between hr.week_start((now() at time zone 'Asia/Kolkata')::date) + 7
                                 and hr.week_start((now() at time zone 'Asia/Kolkata')::date) + 20`,
        [ids.tenant()],
      );
      // 19 people, 88 shifts a week (README)
      expect(rows[0]).toEqual({ assigned: 176, unpublished: 0, people: 19 });
    });
  });
});

describe('Test Company tasks (files 29 to 32): the README figures', () => {
  it('tasks: the commis has an overdue deep clean; commis B finished the descale', async () => {
    await inRolledBackTx(async (c) => {
      const mine = await attemptAs<{ title: string; overdue: boolean; status: string }>(
        c,
        ids.user('test.commis.1.0'),
        `select title, overdue, status from ops.my_tasks() where kind = 'one_off' order by due_at`,
      );
      expect(mine.rows).toEqual([
        { title: 'Deep clean the walk-in chiller', overdue: true, status: 'open' },
        { title: 'Label the dry store shelves', overdue: false, status: 'open' },
      ]);
      const done = await c.query<{ status: string; done_by: string }>(
        `select t.status, u.username as done_by from ops.task t
           join core.app_user u on u.id = t.completed_by
          where t.tenant_id = $1 and t.title = 'Descale the combi oven'`,
        [ids.tenant()],
      );
      expect(done.rows).toEqual([{ status: 'done', done_by: 'test.commis-b.1.0' }]);
      const servers = await attemptAs<{ title: string }>(
        c,
        ids.user('test.server-b.3.0'),
        `select title from ops.my_tasks() where kind = 'one_off'`,
      );
      expect(servers.rows).toEqual([{ title: 'Wipe down the menu cards' }]);
    });
  });

  it('maintenance: one open request, for Hotel 1.0 Engineering to assign', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs<{ kind: string; title: string }>(
        c,
        ids.user('test.chief-engineer.1.0'),
        `select kind, title from ops.my_to_assign()`,
      );
      expect(r.rows).toEqual([{ kind: 'maintenance', title: 'Dishwasher leaking at the door' }]);
    });
  });

  it('prep: three tasks done by their batches from file 26, one open for the load day', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ title: string; status: string; batches: number }>(
        `select t.title, t.status,
                (select count(*)::int from inv.production p where p.task_id = t.id) as batches
           from ops.task t where t.tenant_id = $1 and t.kind = 'prep' order by t.due_at`,
        [ids.tenant()],
      );
      expect(rows).toEqual([
        { title: 'Make Mint Chutney 500 g', status: 'done', batches: 1 },
        { title: 'Make Ginger Garlic Paste 1000 g', status: 'done', batches: 1 },
        { title: 'Make Negroni (pre-batched) 2000 ml', status: 'done', batches: 1 },
        { title: 'Make Mint Chutney 1000 g', status: 'open', batches: 0 },
      ]);
    });
  });

  it('checklists: each customer’s templates, with tasks for the next 24 hours', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ customer: string; templates: number; upcoming: number }>(
        `select tn.code as customer, count(distinct ct.id)::int as templates,
                count(t.id) filter (where t.due_at > now())::int as upcoming
           from ops.checklist_template ct
           join core.tenant tn on tn.id = ct.tenant_id
           left join ops.task t on t.template_id = ct.id
          where tn.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') and ct.archived_at is null
          group by tn.code order by tn.code`,
      );
      expect(rows.map((r) => [r.customer, r.templates])).toEqual([
        ['TEST-COMPANY', 11],
        ['TEST-SOLO-COMPANY', 4],
      ]);
      for (const r of rows) expect(r.upcoming, r.customer).toBeGreaterThan(0);
    });
  });
});
