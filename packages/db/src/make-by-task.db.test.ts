import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Make by task, FSSAI batch labels and the first round of the GM's fixes (ADR 076).
// Hotel 1.0's kitchen: the sous chef leads it (task access over the kitchen), the commis
// makes what he is given. Its housekeeping store asks for things that are on no menu.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

const STORE = 'TEST-HOTEL-1.0-KITCHEN-STORE';
const LEAD = 'test.sous-chef.1.0';
const COMMIS = 'test.commis.1.0';

async function ok<T extends object>(
  c: PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
) {
  const r = await attemptAs<T>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}
const error = async (c: PoolClient, who: string, text: string, params: unknown[] = []) =>
  (await attemptAs(c, ids.user(who), text, params)).error;

async function prep(c: PoolClient, code: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id
      where t.code = 'TEST-COMPANY' and i.sku = $1`,
    [code],
  );
  return rows[0]!.id;
}
/** Enough of every ingredient of a prep item at the store for a batch (fixture). */
async function stockFor(c: PoolClient, item: string) {
  await c.query(
    `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                   unit_cost, ref_type)
     select n.tenant_id, l.ingredient_item_id, n.id, 'receipt', 10000, 1, 'fixture'
       from inv.recipe r join inv.recipe_line l on l.recipe_id = r.id
       join core.hierarchy_node n on n.id = $1
      where r.prep_item_id = $2 and r.effective_to is null`,
    [ids.node(STORE), item],
  );
}

describe('make by task', () => {
  it('the commis sees the store’s batches (he records them), not only stock viewers', () =>
    inRolledBackTx(async (c) => {
      const all = await ok(c, LEAD, 'select batch_no from inv.batches($1)', [ids.node(STORE)]);
      const his = await ok(c, COMMIS, 'select batch_no from inv.batches($1)', [ids.node(STORE)]);
      expect(his.length).toBe(all.length);
      expect(his.length).toBeGreaterThan(0);
    }));

  it('only the lead records a batch straight from Make; the commis makes what he is given', () =>
    inRolledBackTx(async (c) => {
      const item = await prep(c, 'GINGER-GARLIC-PASTE');
      await stockFor(c, item);
      const made = 'select inv.record_production($1, $2, 100) as id';
      expect(await error(c, COMMIS, made, [ids.node(STORE), item])).toBe('MAKE_BY_TASK');
      expect(await error(c, LEAD, made, [ids.node(STORE), item])).toBeUndefined();
      // nothing to make until he is given it
      // what he was given already (the seed's prep list), and nothing else
      const mine = async () =>
        (
          await ok<{ item_id: string }>(c, COMMIS, 'select item_id from inv.made_here($1)', [
            ids.node(STORE),
          ])
        ).map((r) => r.item_id);
      expect(await mine()).not.toContain(item);
      expect(
        (await ok(c, LEAD, 'select item_id from inv.made_here($1)', [ids.node(STORE)])).length,
      ).toBeGreaterThan(1);
      const [t] = await ok<{ ids: string[] }>(
        c,
        LEAD,
        `select ops.create_prep_tasks($1, $2::jsonb, now() + interval '3 hours', $3::jsonb) as ids`,
        [
          ids.node(STORE),
          JSON.stringify([{ item_id: item, qty: 200 }]),
          JSON.stringify({ mode: 'person', user_id: ids.user(COMMIS) }),
        ],
      );
      expect(await mine()).toContain(item);
      const [b] = await ok<{ id: string }>(
        c,
        COMMIS,
        'select ops.record_task_batch($1, 200) as id',
        [t!.ids[0]],
      );
      // its label: FSSAI's batch number, use-by, veg mark, allergens and who made it
      const [label] = await ok<{ made_by: string; batch_no: string; expires_at: Date }>(
        c,
        COMMIS,
        'select made_by, batch_no, expires_at from inv.batch_label($1)',
        [b!.id],
      );
      expect(label!.made_by).toBe('Test Commis 1.0');
      expect(label!.batch_no).toMatch(/^\d{8}-\d+$/);
      // the task is done, and Make has nothing left for him
      const { rows } = await c.query<{ status: string }>(
        'select status from ops.task where id = $1',
        [t!.ids[0]],
      );
      expect(rows[0]!.status).toBe('done');
      expect(await mine()).not.toContain(item);
      // the newest batch is first on the list
      const [first] = await ok<{ batch_no: string; made_by: string }>(
        c,
        COMMIS,
        'select batch_no, made_by from inv.batches($1) limit 1',
        [ids.node(STORE)],
      );
      expect(first).toEqual({ batch_no: label!.batch_no, made_by: 'Test Commis 1.0' });
    }));

  it('a batch label belongs to who may see the store’s batches', () =>
    inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        'select id from inv.production where delivery_node_id = $1 limit 1',
        [ids.node(STORE)],
      );
      expect(
        await error(c, LEAD, 'select * from inv.batch_label($1)', [rows[0]!.id]),
      ).toBeUndefined();
      expect(
        await error(c, 'test.bar-manager.3.0', 'select * from inv.batch_label($1)', [rows[0]!.id]),
      ).toBe('NOT_AUTHORISED');
    }));
});

describe('housekeeping asks for what is on no menu', () => {
  it('is not "unusual" at a store that serves no menu; a kitchen still is', () =>
    inRolledBackTx(async (c) => {
      const hk = ids.node('TEST-HOTEL-1.0-HOUSEKEEPING-STORE');
      const { rows } = await c.query<{ id: string }>(
        `select x.item_id as id from inv.item_node x where x.delivery_node_id = $1 limit 1`,
        [hk],
      );
      const lines = JSON.stringify([{ item_id: rows[0]!.id, qty: 1 }]);
      const { rows: u } = await c.query('select * from inv.unusual_calc($1, $2::jsonb)', [
        hk,
        lines,
      ]);
      expect(u).toEqual([]);
      const { rows: k } = await c.query('select reason from inv.unusual_calc($1, $2::jsonb)', [
        ids.node(STORE),
        lines,
      ]);
      expect(k).toEqual([{ reason: 'off_menu' }]);
    }));
});

describe('a count far above what the store holds', () => {
  it('is refused; a usual count goes through', () =>
    inRolledBackTx(async (c) => {
      const store = ids.node(STORE);
      const COUNTER = 'test.cost-controller.1.0';
      const [check] = await ok<{ id: string }>(
        c,
        COUNTER,
        `select inv.start_stock_check($1) as id`,
        [store],
      );
      const [line] = await ok<{ item_id: string; count_limit: string }>(
        c,
        COUNTER,
        `select item_id, count_limit from inv.stock_check_sheet($1)
          where count_limit is not null limit 1`,
        [check!.id],
      );
      const record = 'select inv.record_check_line($1, $2, $3)';
      const limit = Number(line!.count_limit);
      expect(await error(c, COUNTER, record, [check!.id, line!.item_id, limit + 1])).toBe(
        'COUNT_TOO_HIGH',
      );
      expect(await error(c, COUNTER, record, [check!.id, line!.item_id, limit])).toBeUndefined();
    }));
});

describe('durable things', () => {
  it('stay out of "not moved in 30 days" and days on hand', () =>
    inRolledBackTx(async (c) => {
      const store = ids.node('TEST-HOTEL-1.0-HOUSEKEEPING-STORE');
      const dead = async () =>
        (
          await c.query<{ sku: string }>('select sku from rpt.store_items($1) where dead', [store])
        ).rows.map((r) => r.sku);
      const before = await dead();
      expect(before.length).toBeGreaterThan(0);
      await c.query(`update inv.item set durable = true where sku = any($1)`, [before]);
      expect(await dead()).toEqual([]);
      const { rows } = await c.query(
        'select 1 from rpt.store_items($1) where sku = any($2) and days_on_hand is not null',
        [store, before],
      );
      expect(rows).toEqual([]);
    }));
});

describe('briefings', () => {
  it('have breakfast and late night, and say which part it is now', () =>
    inRolledBackTx(async (c) => {
      const outlet = ids.node('TEST-HOTEL-1.0');
      const part = async (hhmm: string) =>
        (
          await c.query<{ p: string }>(
            `select ops.briefing_part_now($1, (current_date + $2::time) at time zone 'Asia/Kolkata') as p`,
            [outlet, hhmm],
          )
        ).rows[0]!.p;
      expect(await part('07:00')).toBe('breakfast');
      expect(await part('13:00')).toBe('lunch');
      expect(await part('20:00')).toBe('dinner');
      expect(await part('23:30')).toBe('late_night');
      expect(await part('02:00')).toBe('late_night');
      expect(
        await error(
          c,
          'test.general-manager.1.0',
          `select ops.save_briefing($1, 'breakfast', 'Eggs off', '{}')`,
          [outlet],
        ),
      ).toBeUndefined();
    }));
});

describe('a department in two places', () => {
  it('holds its store duties at every store it is linked to', () =>
    inRolledBackTx(async (c) => {
      // Hotel 1.0's kitchen also runs the housekeeping store (as a hotel bar runs two bars)
      const kitchen = ids.node('TEST-HOTEL-1.0-KITCHEN');
      const derived = async () =>
        (
          await c.query<{ node_id: string }>(
            `select a.node_id from core.derive_job_role_access_at(
                      (select tenant_id from core.hierarchy_node where id = $1), 'SOUS_CHEF', $1) a
              where a.access_group = 'STOCK_USER'`,
            [kitchen],
          )
        ).rows.map((r) => r.node_id);
      expect(await derived()).toEqual([ids.node(STORE)]);
      await c.query(
        `insert into core.node_link (tenant_id, org_node_id, delivery_node_id)
         select tenant_id, id, $2 from core.hierarchy_node where id = $1`,
        [kitchen, ids.node('TEST-HOTEL-1.0-HOUSEKEEPING-STORE')],
      );
      expect((await derived()).sort()).toEqual(
        [ids.node(STORE), ids.node('TEST-HOTEL-1.0-HOUSEKEEPING-STORE')].sort(),
      );
    }));
});
