import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Prompt 10 access groups (ADR 016):
//  * PRODUCTION_TEAM: record production only, at the store linked to the person's
//    department, for items made there. No stock, count, wastage, order or transfer access.
//    File 06 gives it to Commis, Cook, Bartender and Central Kitchen Commis (not Kitchen
//    Steward or Bar Back).
//  * EVENT_PLANNER: create and edit events for the whole outlet. Events are outlet-level;
//    DEPARTMENT_HEAD views them only, OUTLET_MANAGER keeps modify.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function sku(c: PoolClient, code: string, tenant = 'TEST-COMPANY'): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id
      where t.code = $2 and i.sku = $1`,
    [code, tenant],
  );
  return rows[0]!.id;
}
async function itemAt(c: PoolClient, store: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select x.item_id as id from inv.item_node x join inv.item i on i.id = x.item_id
      where x.delivery_node_id = $1 and i.kind = 'raw' order by i.sku limit 1`,
    [ids.node(store)],
  );
  return rows[0]!.id;
}
/** Puts enough of every ingredient of a prep item at a store for one batch (fixture). */
async function stockFor(c: PoolClient, store: string, prep: string): Promise<void> {
  await c.query(
    `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                   unit_cost, ref_type)
     select n.tenant_id, l.ingredient_item_id, n.id, 'receipt', 1000, 1, 'fixture'
       from inv.recipe r join inv.recipe_line l on l.recipe_id = r.id
       join core.hierarchy_node n on n.id = $1
      where r.prep_item_id = $2 and r.effective_to is null`,
    [ids.node(store), prep],
  );
}
const PRODUCE = 'select inv.record_production($1, $2, $3) as id';

async function produce(c: PoolClient, user: string, store: string, item: string, tenant?: string) {
  const prep = await sku(c, item, tenant);
  await stockFor(c, store, prep);
  return attemptAs<{ id: string }>(c, ids.user(user), PRODUCE, [ids.node(store), prep, 100]);
}

/** A prep task for the person at the store (as their lead gives it, ADR 076). */
async function giveTask(c: PoolClient, user: string, store: string, prep: string) {
  const { rows } = await c.query<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, delivery_node_id, kind, title, due_at,
                           assign_mode, assignee_user_id, item_id, target_qty)
     select n.tenant_id, coalesce(ops.team_of_store(n.id), n.parent_id), n.id, 'prep', 'Make it',
            now() + interval '2 hours', 'person', $2, $3, 100
       from core.hierarchy_node n where n.id = $1
     returning id`,
    [ids.node(store), ids.user(user), prep],
  );
  await c.query(
    `insert into ops.task_step (tenant_id, task_id, org_node_id, position, label, kind)
     select tenant_id, id, org_node_id, 1, 'Record the batch', 'batch' from ops.task where id = $1`,
    [rows[0]!.id],
  );
  return rows[0]!.id;
}

describe('PRODUCTION_TEAM: production at the department store, nothing else', () => {
  it('commis, cook, bartender and central kitchen commis make what they are given at their store', async () => {
    await inRolledBackTx(async (c) => {
      const cases: [string, string, string, string?][] = [
        ['test.commis.1.0', 'TEST-HOTEL-1.0-KITCHEN-STORE', 'GINGER-GARLIC-PASTE'],
        ['test.commis.3.0', 'TEST-BAR-3.0-KITCHEN-STORE', 'MINT-CHUTNEY'],
        ['test.cook.3.0', 'TEST-BAR-3.0-KITCHEN-STORE', 'GINGER-GARLIC-PASTE'],
        ['test.bartender.1.0', 'TEST-HOTEL-1.0-BAR-STORE', 'SUGAR-SYRUP'],
        ['test.bartender.3.0', 'TEST-BAR-3.0-BAR-STORE', 'SOUR-MIX'],
        ['test.central-kitchen-commis', 'TEST-CENTRAL-KITCHEN-STORE', 'MAKHANI-GRAVY'],
        ['test.solo.bartender', 'TEST-SOLO-BAR-BAR-STORE', 'SUGAR-SYRUP', 'TEST-SOLO-COMPANY'],
      ];
      for (const [user, store, item, tenant] of cases) {
        // not straight from Make: that is their lead's (ADR 076)
        const r = await produce(c, user, store, item, tenant);
        expect(r.error, `${user} ${item} at ${store}`).toBe('MAKE_BY_TASK');
        // given it, they record it on the task
        const task = await giveTask(c, user, store, await sku(c, item, tenant));
        const made = await attemptAs(c, ids.user(user), 'select ops.record_task_batch($1, 100)', [
          task,
        ]);
        expect(made.error, `${user} ${item} at ${store}`).toBeUndefined();
      }
    });
  });

  it('only items made there: a received prep item is NOT_MADE_HERE', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(c, ids.user('test.sous-chef.1.0'), PRODUCE, [
        ids.node('TEST-HOTEL-1.0-KITCHEN-STORE'),
        await sku(c, 'MAKHANI-GRAVY'),
        100,
      ]);
      expect(r.error).toBe('NOT_MADE_HERE');
    });
  });

  it('only at their own department store: not the bar store, another outlet or the hub', async () => {
    await inRolledBackTx(async (c) => {
      const tries: [string, string, string][] = [
        ['test.commis.1.0', 'TEST-HOTEL-1.0-BAR-STORE', 'SUGAR-SYRUP'],
        ['test.commis.1.0', 'TEST-HOTEL-1.1-KITCHEN-STORE', 'GINGER-GARLIC-PASTE'],
        ['test.commis.1.0', 'TEST-BAR-3.0-KITCHEN-STORE', 'GINGER-GARLIC-PASTE'],
        ['test.commis.1.0', 'TEST-CENTRAL-KITCHEN-STORE', 'MAKHANI-GRAVY'],
        ['test.bartender.1.0', 'TEST-HOTEL-1.0-KITCHEN-STORE', 'GINGER-GARLIC-PASTE'],
        ['test.central-kitchen-commis', 'TEST-HOTEL-1.0-KITCHEN-STORE', 'GINGER-GARLIC-PASTE'],
      ];
      for (const [user, store, item] of tries) {
        const r = await attemptAs(c, ids.user(user), PRODUCE, [
          ids.node(store),
          await sku(c, item),
          100,
        ]);
        expect(r.error, `${user} at ${store}`).toBe('NOT_AUTHORISED');
      }
    });
  });

  it('kitchen steward and bar back do not get it', async () => {
    await inRolledBackTx(async (c) => {
      for (const [user, store, item] of [
        ['test.kitchen-steward.1.0', 'TEST-HOTEL-1.0-KITCHEN-STORE', 'GINGER-GARLIC-PASTE'],
        ['test.bar-back.1.0', 'TEST-HOTEL-1.0-BAR-STORE', 'SUGAR-SYRUP'],
        ['test.bar-back.3.0', 'TEST-BAR-3.0-BAR-STORE', 'SUGAR-SYRUP'],
      ] as const) {
        const r = await attemptAs(c, ids.user(user), PRODUCE, [
          ids.node(store),
          await sku(c, item),
          100,
        ]);
        expect(r.error, user).toBe('NOT_AUTHORISED');
        const plan = await attemptAs(c, ids.user(user), 'select * from inv.made_here($1)', [
          ids.node(store),
        ]);
        expect(plan.error, user).toBe('NOT_AUTHORISED');
      }
    });
  });

  it('the production screen reads work for them: what is made, the plan, the batches', async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');
      const commis = ids.user('test.commis.1.0');
      const made = await attemptAs<{ sku: string }>(
        c,
        commis,
        'select sku from inv.made_here($1)',
        [store],
      );
      // what he was given (file 32's open Mint Chutney); his lead sees all three (ADR 076)
      expect(made.rows!.map((r) => r.sku)).toEqual(['MINT-CHUTNEY']);
      const all = await attemptAs<{ sku: string }>(
        c,
        ids.user('test.sous-chef.1.0'),
        'select sku from inv.made_here($1)',
        [store],
      );
      expect(all.rows!.map((r) => r.sku).sort()).toEqual([
        'GINGER-GARLIC-PASTE',
        'MINT-CHUTNEY',
        'STEAMED-RICE',
      ]);
      const plan = await attemptAs(c, commis, 'select * from inv.production_plan($1, $2)', [
        store,
        await sku(c, 'MINT-CHUTNEY'),
      ]);
      expect(plan.error).toBeUndefined();
      expect(plan.rows!.length).toBeGreaterThan(0);
      const batches = await attemptAs(c, commis, 'select * from inv.batches($1)', [store]);
      expect(batches.error).toBeUndefined();
    });
  });

  it('no stock, count, wastage, order or transfer access comes with it', async () => {
    await inRolledBackTx(async (c) => {
      const commis = ids.user('test.commis.1.0');
      const store = 'TEST-HOTEL-1.0-KITCHEN-STORE';
      const item = await itemAt(c, store);
      const { rows: sup } = await c.query<{ id: string }>(
        `select s.id from inv.supplier s where s.tenant_id = $1 order by s.code limit 1`,
        [ids.tenant()],
      );
      const writes: [string, unknown[]][] = [
        [
          'select inv.record_wastage($1, $2::jsonb)',
          [ids.node(store), JSON.stringify([{ item_id: item, qty: 1, reason: 'spoiled' }])],
        ],
        ['select inv.start_count($1)', [ids.node(store)]],
        [
          'select inv.create_po($1, $2, $3::jsonb)',
          [ids.node(store), sup[0]!.id, JSON.stringify([{ item_id: item, qty: 1, unit_cost: 1 }])],
        ],
        [
          'select inv.request_transfer($1, $2, $3::jsonb)',
          [
            ids.node('TEST-HOTEL-1.0-MAIN-STORE'),
            ids.node(store),
            JSON.stringify([{ item_id: item, qty: 1 }]),
          ],
        ],
      ];
      for (const [sql, params] of writes) {
        expect((await attemptAs(c, commis, sql, params)).error, sql).toBe('NOT_AUTHORISED');
      }
      for (const table of [
        'inv.stock_level',
        'inv.stock_ledger',
        'inv.stock_count',
        'inv.purchase_order',
        'inv.transfer',
        'inv.production',
      ]) {
        const r = await attemptAs<{ n: string }>(c, commis, `select count(*) n from ${table}`);
        expect(r.rows![0]!.n, table).toBe('0');
      }
      const can = await attemptAs<{ d: string; ok: boolean }>(
        c,
        commis,
        `select d, core.can(d, a, null, $1) as ok
           from (values ('STOCK_LEVELS', 'view'), ('STOCK_ADJUSTMENTS', 'modify'),
                        ('PURCHASE_ORDERS', 'view'), ('TRANSFERS', 'view'),
                        ('PRODUCTION', 'view'), ('MENU', 'view')) v(d, a)`,
        [ids.node(store)],
      );
      expect(can.rows!.filter((r) => r.ok)).toEqual([]);
    });
  });
});

const upsert = `select ops.upsert_event($1, $2, $3, $4::timestamptz, $5::timestamptz, $6) as id`;
const event = (node: string, id: string | null = null) => [
  id,
  ids.node(node),
  'Test gala',
  '2026-12-20T13:00:00Z',
  '2026-12-20T17:00:00Z',
  80,
];

describe('EVENT_PLANNER: events are planned for the whole outlet', () => {
  it('the Executive Chef cannot create an event; the Banquet Manager can', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        (await attemptAs(c, ids.user('test.executive-chef.1.0'), upsert, event('TEST-HOTEL-1.0')))
          .error,
      ).toBe('NOT_AUTHORISED');
      expect(
        (
          await attemptAs(
            c,
            ids.user('test.executive-chef.1.0'),
            upsert,
            event('TEST-HOTEL-1.0-KITCHEN'),
          )
        ).error,
      ).toBe('NOT_AUTHORISED');
      const made = await attemptAs<{ id: string }>(
        c,
        ids.user('test.banquet-manager.1.0'),
        upsert,
        event('TEST-HOTEL-1.0'),
      );
      expect(made.error).toBeUndefined();
    });
  });

  it('F&B and Restaurant Managers plan events too, and edit and cancel them; only at their outlet', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of ['test.fandb-manager.1.0', 'test.restaurant-manager.1.0']) {
        const r = await attemptAs<{ id: string }>(
          c,
          ids.user(who),
          upsert,
          event('TEST-HOTEL-1.0'),
        );
        expect(r.error, who).toBeUndefined();
        const edit = event('TEST-HOTEL-1.0', r.rows![0]!.id);
        edit[5] = 90;
        expect((await attemptAs(c, ids.user(who), upsert, edit)).error, who).toBeUndefined();
        expect(
          (await attemptAs(c, ids.user(who), 'select ops.cancel_event($1)', [r.rows![0]!.id]))
            .error,
          who,
        ).toBeUndefined();
        expect(
          (await attemptAs(c, ids.user(who), upsert, event('TEST-HOTEL-1.1'))).error,
          who,
        ).toBe('NOT_AUTHORISED');
      }
    });
  });

  it('events go on an outlet, never a department (OUTLET_REQUIRED)', async () => {
    await inRolledBackTx(async (c) => {
      for (const [who, node] of [
        ['test.banquet-manager.1.0', 'TEST-HOTEL-1.0-BANQUETS'],
        ['test.general-manager.1.0', 'TEST-HOTEL-1.0-KITCHEN'],
        ['test.bar-manager.3.0', 'TEST-BAR-3.0-FLOOR-SERVICE'],
      ] as const) {
        expect((await attemptAs(c, ids.user(who), upsert, event(node))).error, who).toBe(
          'OUTLET_REQUIRED',
        );
      }
      // outlet managers keep modify
      expect(
        (await attemptAs(c, ids.user('test.bar-manager.3.0'), upsert, event('TEST-BAR-3.0'))).error,
      ).toBeUndefined();
    });
  });

  it('department heads view events only', async () => {
    await inRolledBackTx(async (c) => {
      for (const [who, dept] of [
        ['test.executive-chef.1.0', 'TEST-HOTEL-1.0-KITCHEN'],
        ['test.bar-manager.1.0', 'TEST-HOTEL-1.0-BAR'],
        ['test.floor-manager.3.0', 'TEST-BAR-3.0-FLOOR-SERVICE'],
      ] as const) {
        const r = await attemptAs<{ v: boolean; m: boolean }>(
          c,
          ids.user(who),
          `select core.can('EVENTS', 'view', $1, null) v, core.can('EVENTS', 'modify', $1, null) m`,
          [ids.node(dept)],
        );
        expect(r.rows![0], who).toEqual({ v: true, m: false });
      }
    });
  });

  it('everyone working at the outlet reads its events; other outlets do not', async () => {
    await inRolledBackTx(async (c) => {
      const id = (
        await attemptAs<{ id: string }>(
          c,
          ids.user('test.banquet-manager.1.0'),
          `select ops.upsert_event($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, null,
                                   $7::jsonb) as id`,
          [
            ...event('TEST-HOTEL-1.0'),
            JSON.stringify([
              {
                kind: 'role',
                role_code: 'BARTENDER',
                headcount: 2,
                starts_at: '2026-12-20T12:00:00Z',
                ends_at: '2026-12-20T18:00:00Z',
              },
            ]),
          ],
        )
      ).rows![0]!.id;
      const sees = async (who: string) => {
        const ev = await attemptAs<{ n: string }>(
          c,
          ids.user(who),
          'select count(*) n from ops.event where id = $1',
          [id],
        );
        const req = await attemptAs<{ n: string }>(
          c,
          ids.user(who),
          'select count(*) n from ops.event_requirement where event_id = $1',
          [id],
        );
        return [ev.rows![0]!.n, req.rows![0]!.n];
      };
      for (const who of [
        'test.commis.1.0',
        'test.bartender.1.0',
        'test.room-attendant.1.0',
        'test.executive-chef.1.0',
        'test.general-manager.1.0',
        'test.area-manager',
        'ai-agent',
      ]) {
        expect(await sees(who), who).toEqual(['1', '1']);
      }
      for (const who of ['test.commis.1.1', 'test.general-manager.2.0', 'test.server.3.0']) {
        expect(await sees(who), who).toEqual(['0', '0']);
      }
    });
  });

  it('the seeded events are all at outlets', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ kind: string; n: string }>(
        `select n.kind, count(*) n from ops.event e join core.hierarchy_node n on n.id = e.org_node_id
          where e.tenant_id = $1 group by n.kind`,
        [ids.tenant()],
      );
      expect(rows).toEqual([{ kind: 'outlet', n: '4' }]);
    });
  });
});
