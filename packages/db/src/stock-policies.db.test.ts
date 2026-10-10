import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Stock policies (ADR 092): par by day of the week, which orders need approving, and items only
// thrown away once the GM approves (Test Company's single malt, file 10).

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const BAR_STORE = 'TEST-HOTEL-1.0-BAR-STORE';
const KITCHEN_STORE = 'TEST-HOTEL-1.0-KITCHEN-STORE';

async function run<T extends object = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  sql: string,
  params: unknown[] = [],
) {
  const r = await attemptAs<T>(c, ids.user(who), sql, params);
  if (r.error) throw new Error(`${who}: ${r.error}`);
  return r.rows!;
}

const item = async (c: PoolClient, sku: string) =>
  (
    await c.query<{ id: string }>(`select id from inv.item where tenant_id = $1 and sku = $2`, [
      ids.tenant(),
      sku,
    ])
  ).rows[0]!.id;

const onHand = async (c: PoolClient, sku: string, store: string) =>
  Number(
    (
      await c.query<{ n: string }>(`select inv.on_hand($1, $2) as n`, [
        await item(c, sku),
        ids.node(store),
      ])
    ).rows[0]!.n,
  );

describe('par by day of the week', () => {
  it("the store's par is today's: Monday to Thursday 40, the weekend 50", async () => {
    await inRolledBackTx(async (c) => {
      const par = async () =>
        Number(
          (
            await c.query<{ p: string }>(
              `select par_level as p from inv.item_node where item_id = $1 and delivery_node_id = $2`,
              [await item(c, 'ONIONS'), ids.node(KITCHEN_STORE)],
            )
          ).rows[0]!.p,
        );
      // Monday 5 Oct 2026 at noon, Saturday 10 Oct
      await c.query(`select inv.apply_par_by_day('2026-10-05T12:00:00+05:30')`);
      expect(await par()).toBe(40);
      await c.query(`select inv.apply_par_by_day('2026-10-10T12:00:00+05:30')`);
      expect(await par()).toBe(50);
      // Saturday 02:00 is still Friday's business day (the 04:00 cut, ADR 057)
      await c.query(`select inv.apply_par_by_day('2026-10-10T02:00:00+05:30')`);
      expect(await par()).toBe(50);
      await c.query(`select inv.apply_par_by_day('2026-10-05T02:00:00+05:30')`);
      expect(await par()).toBe(50);
      // the tasks job keeps it
      await c.query(`select * from ops.tasks_tick('2026-10-06T12:00:00+05:30')`);
      expect(await par()).toBe(40);
    });
  });
});

describe('purchase approval', () => {
  const lines = async (c: PoolClient, qty: number) =>
    JSON.stringify([{ item_id: await item(c, 'ONIONS'), qty }]);
  const unusual = async (c: PoolClient, l: string) =>
    (
      await c.query<{ u: boolean; why: string }>(
        `select inv.order_unusual($1, $2::jsonb) as u, inv.order_why($1, $2::jsonb) as why`,
        [ids.node(KITCHEN_STORE), l],
      )
    ).rows[0]!;
  const rule = (c: PoolClient, r: string) =>
    c.query(
      `update core.tenant set settings = settings || jsonb_build_object('purchase_approval', $2::text)
        where id = $1`,
      [ids.tenant(), r],
    );

  it('unusual (the default), every order, or above an amount at standard cost', async () => {
    await inRolledBackTx(async (c) => {
      const small = await lines(c, 1);
      expect((await unusual(c, small)).u).toBe(false);
      await rule(c, 'every');
      expect(await unusual(c, small)).toEqual({ u: true, why: 'Every order is approved here' });
      await rule(c, 'above:1000');
      // onions at ₹35 a kg
      expect((await unusual(c, small)).u).toBe(false);
      expect(await unusual(c, await lines(c, 30))).toEqual({
        u: true,
        why: 'Worth ₹1050, above ₹1000',
      });
    });
  });

  it('a supply request is approved on that rule', async () => {
    await inRolledBackTx(async (c) => {
      await rule(c, 'every');
      const [r] = await run<{ id: string }>(
        c,
        'test.executive-chef.1.0',
        `select inv.request_supplies($1, $2::jsonb) as id`,
        [ids.node(KITCHEN_STORE), await lines(c, 1)],
      );
      const { rows } = await c.query<{ unusual: boolean }>(
        `select (r.payload ->> 'unusual')::boolean as unusual
           from inv.purchase_order p join wf.request r on r.id = p.wf_request_id where p.id = $1`,
        [r!.id],
      );
      expect(rows[0]!.unusual).toBe(true);
    });
  });
});

describe('items only thrown away once the GM approves', () => {
  it('never recorded straight away; asked, approved by the GM, thrown away by whoever has it', async () => {
    await inRolledBackTx(async (c) => {
      const malt = await item(c, 'SINGLE-MALT-750ML');
      const before = await onHand(c, 'SINGLE-MALT-750ML', BAR_STORE);
      const direct = await attemptAs(
        c,
        ids.user('test.bar-manager.1.0'),
        `select inv.record_wastage($1, $2::jsonb)`,
        [ids.node(BAR_STORE), JSON.stringify([{ item_id: malt, qty: 1, reason: 'damaged' }])],
      );
      expect(direct.error).toMatch(/NEEDS_GM/);

      const [ask] = await run<{ id: string }>(
        c,
        'test.bartender.1.0',
        `select ops.ask_discard($1, $2, 1, 'damaged') as id`,
        [ids.node(BAR_STORE), malt],
      );
      const task = ask!.id;
      // the head bartender gives out the bar's tasks, but not this
      const head = await attemptAs(
        c,
        ids.user('test.head-bartender.1.0'),
        `select ops.approve_discard($1, null)`,
        [task],
      );
      expect(head.error).toMatch(/NEEDS_GM/);
      await run(c, 'test.general-manager.1.0', `select ops.approve_discard($1, $2)`, [
        task,
        ids.user('test.bartender-b.1.0'),
      ]);
      expect(await onHand(c, 'SINGLE-MALT-750ML', BAR_STORE)).toBe(before);
      await run(c, 'test.bartender-b.1.0', `select ops.discard_expired($1, 1)`, [task]);
      expect(await onHand(c, 'SINGLE-MALT-750ML', BAR_STORE)).toBe(before - 1);
      const line = await c.query<{ reason: string; outcome: string }>(
        `select reason, outcome from inv.wastage_line where task_id = $1`,
        [task],
      );
      // worth ₹5,200, above the store's limit, yet no second approval: the GM gave it
      expect(line.rows).toEqual([{ reason: 'damaged', outcome: 'posted' }]);
    });
  });

  it('whoever asked never approves it; every other discard is approved by the department head', async () => {
    await inRolledBackTx(async (c) => {
      const malt = await item(c, 'SINGLE-MALT-750ML');
      const [own] = await run<{ id: string }>(
        c,
        'test.general-manager.1.0',
        `select ops.ask_discard($1, $2, 1, 'damaged') as id`,
        [ids.node(BAR_STORE), malt],
      );
      const self = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        `select ops.approve_discard($1, null)`,
        [own!.id],
      );
      expect(self.error).toMatch(/SELF_APPROVAL/);

      const onions = await item(c, 'ONIONS');
      const [ask] = await run<{ id: string }>(
        c,
        'test.commis.1.0',
        `select ops.ask_discard($1, $2, 2, 'spoiled') as id`,
        [ids.node(KITCHEN_STORE), onions],
      );
      await run(c, 'test.executive-chef.1.0', `select ops.approve_discard($1, null)`, [ask!.id]);
      const t = await c.query<{ status: string; assign_mode: string }>(
        `select status, assign_mode from ops.task where id = $1`,
        [ask!.id],
      );
      expect(t.rows[0]).toEqual({ status: 'open', assign_mode: 'on_shift' });
      // more than the store has is refused; another customer can't ask
      expect(
        (
          await attemptAs(
            c,
            ids.user('test.commis.1.0'),
            `select ops.ask_discard($1, $2, 9999, 'spoiled')`,
            [ids.node(KITCHEN_STORE), onions],
          )
        ).error,
      ).toMatch(/INVALID_QUANTITY/);
      expect(
        (
          await attemptAs(
            c,
            ids.user('test.solo.cook'),
            `select ops.ask_discard($1, $2, 1, 'spoiled')`,
            [ids.node(KITCHEN_STORE), onions],
          )
        ).error,
      ).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('the department head is told of every other discard', async () => {
    await inRolledBackTx(async (c) => {
      await run(c, 'test.chef-de-partie.1.0', `select inv.record_wastage($1, $2::jsonb)`, [
        ids.node(KITCHEN_STORE),
        JSON.stringify([{ item_id: await item(c, 'ONIONS'), qty: 1, reason: 'spoiled' }]),
      ]);
      const told = await c.query<{ n: number }>(
        `select count(*)::int as n from ops.notification
          where owner_user_id = $1 and kind = 'wastage' and created_at >= now()`,
        [ids.user('test.executive-chef.1.0')],
      );
      expect(told.rows[0]!.n).toBe(1);
    });
  });
});
