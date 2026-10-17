import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  resetRole,
  type SeedIds,
} from '../test/helpers';

// Stock and money correctness (ADR 168): counts post the difference from what was there when
// each line was counted; a minibar charges only what a guest used since the room was last
// full; a request's dead or closed order is never handed back; closed orders are not "still
// coming"; send tasks close when the request leaves "to send"; free goods can be received;
// a receipt keeps the amount typed. Run as the seeded users inside rolled-back transactions.
// One transaction shares one now(), so movements are dated with explicit times.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function ok<T = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T & object>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}

const fail = async (c: PoolClient, who: string, text: string, params: unknown[] = []) =>
  (await attemptAs(c, ids.user(who), text, params)).error;

const tenantOf = async (c: PoolClient, node: string) =>
  (
    await c.query<{ id: string }>('select tenant_id as id from core.hierarchy_node where id = $1', [
      node,
    ])
  ).rows[0]!.id;

/** An item kept at `node`, with `opening` on hand from four hours ago. */
async function stockedItem(
  c: PoolClient,
  node: string,
  sku: string,
  opening: number,
  extra: { tolerance?: number; par?: number } = {},
): Promise<string> {
  const tenant = await tenantOf(c, node);
  const item = (
    await c.query<{ id: string }>(
      `insert into inv.item (tenant_id, sku, name, category, base_uom)
       values ($1, $2, 'Item ' || $2, 'Test', 'kg') returning id`,
      [tenant, sku],
    )
  ).rows[0]!.id;
  await c.query(
    `insert into inv.item_node (tenant_id, item_id, delivery_node_id, count_tolerance_qty,
                                par_level)
     values ($1, $2, $3, $4, $5)`,
    [tenant, item, node, extra.tolerance ?? 0, extra.par ?? 0],
  );
  if (opening > 0) await move(c, item, node, 'receipt', opening, '4 hours');
  return item;
}

/** A ledger movement dated `ago` before now (receipt, consumption, ...). */
async function move(
  c: PoolClient,
  item: string,
  node: string,
  type: string,
  qty: number,
  ago: string,
): Promise<void> {
  await c.query(
    `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                   unit_cost, ref_type, occurred_at)
     select tenant_id, $1, $2, $3, $4, 10, 'test', now() - $5::interval
       from core.hierarchy_node where id = $2`,
    [item, node, type, qty, ago],
  );
}

const onHand = async (c: PoolClient, item: string, node: string) =>
  Number(
    (
      await c.query<{ q: string }>(
        `select coalesce((select on_hand from inv.stock_level
                           where item_id = $1 and delivery_node_id = $2), 0) as q`,
        [item, node],
      )
    ).rows[0]!.q,
  );

// ---------------------------------------------------------------------------------------------
// C3: counts
// ---------------------------------------------------------------------------------------------

describe('a stock check posts the difference from what was there when each line was counted', () => {
  const VERIFIER = 'test.cost-controller.1.0';
  const STORE = 'TEST-HOTEL-1.0-KITCHEN-STORE';
  const node = () => ids.node(STORE);
  const photo = (tenant: string) =>
    `stockcheck/${tenant}/${node()}/0123456789abcdef0123456789abcdef0123.jpg`;

  async function startCheck(c: PoolClient): Promise<string> {
    // any unfinished check from the test data is not this test's
    await c.query(
      `update inv.stock_check set status = 'finished', finished_at = now()
        where delivery_node_id = $1 and status in ('open', 'review')`,
      [node()],
    );
    const [r] = await ok<{ id: string }>(c, VERIFIER, 'select inv.start_stock_check($1) as id', [
      node(),
    ]);
    // it started three hours ago
    await c.query(
      `update inv.stock_check set started_at = now() - interval '3 hours' where id = $1`,
      [r!.id],
    );
    return r!.id;
  }
  const countAt = (c: PoolClient, check: string, item: string, qty: number, ago: string) =>
    ok(c, VERIFIER, `select inv.record_check_line($1, $2, $3, null, null, now() - $4::interval)`, [
      check,
      item,
      qty,
      ago,
    ]);

  it('a receipt between the start and the count is not counted twice; a sale after it stays', async () => {
    await inRolledBackTx(async (c) => {
      const tenant = await tenantOf(c, node());
      const a = await stockedItem(c, node(), 'C3-A', 10);
      const b = await stockedItem(c, node(), 'C3-B', 10);
      const check = await startCheck(c);
      // 20 arrive two hours ago: 30 on the shelf
      await move(c, a, node(), 'receipt', 20, '2 hours');
      await move(c, b, node(), 'receipt', 20, '2 hours');
      // an hour ago A is counted at 30 (right), B at 28 (2 gone missing)
      await countAt(c, check, a, 30, '1 hour');
      await countAt(c, check, b, 28, '1 hour');
      // half an hour ago 5 of each are used
      await move(c, a, node(), 'consumption', -5, '30 minutes');
      await move(c, b, node(), 'consumption', -5, '30 minutes');

      const review = await ok<{ item_id: string; expected_qty: string; difference: string }>(
        c,
        VERIFIER,
        'select item_id, expected_qty, difference from inv.review_stock_check($1)',
        [check],
      );
      const diff = (i: string) => Number(review.find((r) => r.item_id === i)!.difference);
      expect(diff(a)).toBe(0);
      expect(diff(b)).toBe(-2);
      await ok(c, VERIFIER, 'select inv.record_check_line($1, $2, null, $3)', [
        check,
        b,
        photo(tenant),
      ]);
      const [done] = await ok<{ r: { adjusted: number; matched: number } }>(
        c,
        VERIFIER,
        'select inv.finish_stock_check($1) as r',
        [check],
      );
      expect(done!.r).toMatchObject({ adjusted: 1, matched: 1 });
      // stock = what was counted + what moved after it was counted
      expect(await onHand(c, a, node())).toBe(25);
      expect(await onHand(c, b, node())).toBe(23);
    });
  });

  it('an unfinished check older than a day is not handed back and cannot be finished', async () => {
    await inRolledBackTx(async (c) => {
      const a = await stockedItem(c, node(), 'C3-OLD', 10);
      const old = await startCheck(c);
      await c.query(
        `update inv.stock_check set started_at = now() - interval '25 hours' where id = $1`,
        [old],
      );
      expect(await fail(c, VERIFIER, 'select inv.record_check_line($1, $2, 9)', [old, a])).toMatch(
        /COUNT_EXPIRED/,
      );
      expect(await fail(c, VERIFIER, 'select * from inv.review_stock_check($1)', [old])).toMatch(
        /COUNT_EXPIRED/,
      );
      const [fresh] = await ok<{ id: string }>(
        c,
        VERIFIER,
        'select inv.start_stock_check($1) as id',
        [node()],
      );
      expect(fresh!.id).not.toBe(old);
      const { rows } = await c.query<{ status: string }>(
        'select status from inv.stock_check where id = $1',
        [old],
      );
      expect(rows[0]!.status).toBe('expired');
    });
  });
});

describe('a count posts the difference from what was there when each line was counted', () => {
  const KIM = 'test.head-cook.3.0'; // keeps Test Bar 3.0's kitchen store
  const STORE = 'TEST-BAR-3.0-KITCHEN-STORE';
  const node = () => ids.node(STORE);

  async function startCount(c: PoolClient): Promise<string> {
    await c.query(
      `update inv.stock_count set status = 'submitted', submitted_at = now()
        where delivery_node_id = $1 and status = 'open'`,
      [node()],
    );
    const [r] = await ok<{ id: string }>(c, KIM, 'select inv.start_count($1) as id', [node()]);
    await c.query(
      `update inv.stock_count set started_at = now() - interval '3 hours' where id = $1`,
      [r!.id],
    );
    return r!.id;
  }

  it('a receipt between the start and the count is not counted twice; a sale after it stays', async () => {
    await inRolledBackTx(async (c) => {
      const a = await stockedItem(c, node(), 'C3-CA', 10, { tolerance: 100 });
      const b = await stockedItem(c, node(), 'C3-CB', 10, { tolerance: 100 });
      const count = await startCount(c);
      await move(c, a, node(), 'receipt', 20, '2 hours');
      await move(c, b, node(), 'receipt', 20, '2 hours');
      await move(c, a, node(), 'consumption', -5, '30 minutes');
      await move(c, b, node(), 'consumption', -5, '30 minutes');
      // A was counted an hour ago (its time), B too (how long ago, from the phone)
      const [s] = await ok<{ s: Record<string, unknown> }>(
        c,
        KIM,
        `select inv.submit_count($1, jsonb_build_array(
            jsonb_build_object('item_id', $2::uuid, 'counted_qty', 30,
                               'counted_at', now() - interval '1 hour'),
            jsonb_build_object('item_id', $3::uuid, 'counted_qty', 28, 'ago_ms', 3600000))) as s`,
        [count, a, b],
      );
      expect(s!.s).toMatchObject({ posted: 1 });
      expect(await onHand(c, a, node())).toBe(25);
      expect(await onHand(c, b, node())).toBe(23);
      const { rows } = await c.query<{ item_id: string; system_qty: string; outcome: string }>(
        `select item_id, system_qty::float8::text as system_qty, outcome
           from inv.stock_count_line where count_id = $1 and item_id in ($2, $3)`,
        [count, a, b],
      );
      expect(Object.fromEntries(rows.map((r) => [r.item_id, [r.system_qty, r.outcome]]))).toEqual({
        [a]: ['30', 'no_change'],
        [b]: ['30', 'posted'],
      });
    });
  });

  it('an open count older than a day is closed, not handed back, and cannot be submitted', async () => {
    await inRolledBackTx(async (c) => {
      const a = await stockedItem(c, node(), 'C3-COLD', 10, { tolerance: 100 });
      const old = await startCount(c);
      await c.query(
        `update inv.stock_count set started_at = now() - interval '25 hours' where id = $1`,
        [old],
      );
      expect(
        await fail(
          c,
          KIM,
          `select inv.submit_count($1, jsonb_build_array(
              jsonb_build_object('item_id', $2::uuid, 'counted_qty', 9)))`,
          [old, a],
        ),
      ).toMatch(/COUNT_EXPIRED/);
      const [fresh] = await ok<{ id: string }>(c, KIM, 'select inv.start_count($1) as id', [
        node(),
      ]);
      expect(fresh!.id).not.toBe(old);
      const { rows } = await c.query<{ status: string }>(
        'select status from inv.stock_count where id = $1',
        [old],
      );
      expect(rows[0]!.status).toBe('expired');
      expect(await onHand(c, a, node())).toBe(10);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// C4: minibar
// ---------------------------------------------------------------------------------------------

describe('a minibar charges only what a guest used since the room was last full', () => {
  // Test Hotel & Bar 1.0: rooms 101 to 201 have a minibar of beer, cola and tonic at par 2,
  // filled from the Bar Store (files 40, 41)
  const HOTEL = 'TEST-HOTEL-1.0';
  const BAR_STORE = 'TEST-HOTEL-1.0-BAR-STORE';
  const ATTENDANT = 'test.room-attendant.1.0';

  const room = async (c: PoolClient, n: string) =>
    (
      await c.query<{ id: string }>(
        `select id from ops.room where org_node_id = $1 and number = $2`,
        [ids.node(HOTEL), n],
      )
    ).rows[0]!.id;
  const sku = async (c: PoolClient, s: string) =>
    (
      await c.query<{ id: string }>(`select id from inv.item where tenant_id = $1 and sku = $2`, [
        ids.tenant(),
        s,
      ])
    ).rows[0]!.id;
  const left = async (c: PoolClient, beer: number, cola: number, tonic: number) =>
    JSON.stringify([
      { item_id: await sku(c, 'LAGER-BEER-330ML'), left: beer },
      { item_id: await sku(c, 'COLA-300ML'), left: cola },
      { item_id: await sku(c, 'TONIC-WATER-300ML'), left: tonic },
    ]);
  const check = async (c: PoolClient, r: string, lines: string) =>
    (
      await ok<{ id: string }>(c, ATTENDANT, 'select ops.check_minibar($1, $2) as id', [r, lines])
    )[0]!.id;
  const refill = async (c: PoolClient, id: string) => {
    const t = await c.query<{ id: string }>(
      `select id from ops.task where minibar_check_id = $1 and kind = 'minibar_refill'`,
      [id],
    );
    return (
      await ok<{ short: boolean }>(c, ATTENDANT, 'select ops.refill_minibar($1) as short', [
        t.rows[0]!.id,
      ])
    )[0]!.short;
  };
  const charge = async (c: PoolClient, id: string) =>
    (await c.query<{ charge: string }>('select charge from ops.minibar_check where id = $1', [id]))
      .rows[0]!.charge;

  it('a room checked again before its refill is refused, so its beers are not charged twice', async () => {
    await inRolledBackTx(async (c) => {
      const r = await room(c, '103');
      // two beers used; the refill task is still open
      const first = await check(c, r, await left(c, 0, 2, 2));
      expect(await charge(c, first)).toBe('500.00');
      expect(
        await fail(c, ATTENDANT, 'select ops.check_minibar($1, $2)', [r, await left(c, 0, 2, 2)]),
      ).toMatch(/MINIBAR_NOT_REFILLED/);
      const open = await ok<{ refill_open: boolean }>(
        c,
        ATTENDANT,
        'select refill_open from ops.minibar_expected($1)',
        [r],
      );
      expect(open.every((o) => o.refill_open)).toBe(true);
      // refilled, the next guest uses nothing: nothing to charge, nothing to refill
      expect(await refill(c, first)).toBe(false);
      const second = await check(c, r, await left(c, 2, 2, 2));
      expect(await charge(c, second)).toBe('0.00');
      const tasks = await c.query('select 1 from ops.task where minibar_check_id = $1', [second]);
      expect(tasks.rowCount).toBe(0);
    });
  });

  it('the store short of tonic: the next guest is not charged for it, and the refill makes it up', async () => {
    await inRolledBackTx(async (c) => {
      const tonic = await sku(c, 'TONIC-WATER-300ML');
      const store = ids.node(BAR_STORE);
      // the bar store down to one tonic
      await c.query(
        `select inv.post($1, $2, 'count_adjust', 1 - inv.on_hand($1, $2), 0, 'test', null)`,
        [tonic, store],
      );
      const r = await room(c, '102');
      const first = await check(c, r, await left(c, 2, 2, 0)); // two tonics used
      expect(await charge(c, first)).toBe('240.00');
      expect(await refill(c, first)).toBe(true); // only one went back
      // the check form says the same: one tonic should be there, the refill is done
      const expected = await ok<{ item_id: string; expected: string; refill_open: boolean }>(
        c,
        ATTENDANT,
        'select item_id, expected::float8::text as expected, refill_open from ops.minibar_expected($1)',
        [r],
      );
      expect(expected.find((e) => e.item_id === tonic)).toEqual({
        item_id: tonic,
        expected: '1',
        refill_open: false,
      });
      // the next guest uses nothing: one tonic is in the room, as the refill left it
      await c.query(
        `update ops.minibar_check set checked_at = now() - interval '1 hour' where id = $1`,
        [first],
      );
      const second = await check(c, r, await left(c, 2, 2, 1));
      expect(await charge(c, second)).toBe('0.00');
      // its refill puts back the missing tonic once the store has it
      await c.query(`select inv.post($1, $2, 'receipt', 5, 30, 'test', null)`, [tonic, store]);
      const task = await ok<{ used: { item: string; qty: number }[] }>(
        c,
        ATTENDANT,
        `select m.used from ops.task t cross join lateral ops.minibar_task_check(t.id) m
          where t.minibar_check_id = $1 and t.kind = 'minibar_refill'`,
        [second],
      );
      expect(task[0]!.used.map((u) => [u.item, Number(u.qty)])).toEqual([
        ['Test Tonic Water 300ml', 1],
      ]);
      expect(await refill(c, second)).toBe(false);
      // the room is full again: a third guest who drinks one tonic pays for one
      await c.query(
        `update ops.minibar_check set checked_at = now() - interval '30 minutes' where id = $1`,
        [second],
      );
      const third = await check(c, r, await left(c, 2, 2, 1));
      expect(await charge(c, third)).toBe('120.00');
    });
  });
});

// ---------------------------------------------------------------------------------------------
// H14, M22, H15, M20: a request's orders and send tasks (Test Hotel 1.0: housekeeping asks the
// Main Store, kept by the store keeper)
// ---------------------------------------------------------------------------------------------

const HK = 'TEST-HOTEL-1.0-HOUSEKEEPING-STORE';
const MAIN = 'TEST-HOTEL-1.0-MAIN-STORE';
const ASKER = 'test.executive-housekeeper.1.0';
const KEEPER = 'test.store-keeper.1.0';
const RUNNER = 'test.purchase-manager.1.0';

async function lager(c: PoolClient): Promise<string> {
  const item = (
    await c.query<{ id: string }>(
      `select id from inv.item where tenant_id = $1 and name = 'Test Lager Beer 330ml'`,
      [ids.tenant()],
    )
  ).rows[0]!.id;
  for (const store of [HK, MAIN]) {
    await c.query(
      `insert into inv.item_node (tenant_id, item_id, delivery_node_id, par_level)
       values ($1, $2, $3, 0) on conflict do nothing`,
      [ids.tenant(), item, ids.node(store)],
    );
  }
  return item;
}

/** Sets an item's stock at a store to `qty`. */
async function stockAt(c: PoolClient, item: string, store: string, qty: number) {
  const have = await onHand(c, item, ids.node(store));
  if (have !== qty) {
    await c.query(
      `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                     unit_cost, ref_type)
       values ($1, $2, $3, 'count_adjust', $4, 110, 'test')`,
      [ids.tenant(), item, ids.node(store), qty - have],
    );
  }
}

async function ask(c: PoolClient, item: string, qty: number): Promise<string> {
  const [r] = await ok<{ ids: string[] }>(
    c,
    ASKER,
    `select inv.ask_for_stock($1, $2::jsonb, null) as ids`,
    [ids.node(HK), JSON.stringify([{ item_id: item, qty }])],
  );
  return r!.ids[0]!;
}

/** Runs the executor on whatever is waiting, as wf-execute does each minute. */
async function execute(c: PoolClient) {
  for (;;) {
    const { rows: due } = await c.query<{ id: string; handler: string; request_id: string }>(
      `select id, handler, request_id from wf.outbox where status = 'pending'
        and tenant_id = $1 order by created_at, id limit 1`,
      [ids.tenant()],
    );
    const row = due[0];
    if (!row) return;
    await c.query(
      `update wf.request set state = 'executing' where id = $1 and state = 'approved'`,
      [row.request_id],
    );
    await actAs(c, 'wf_executor', null);
    await c.query('select inv.execute($1, $2)', [row.handler, row.request_id]);
    await resetRole(c);
    await c.query('select wf.complete_outbox($1)', [row.id]);
  }
}

const orderFor = async (c: PoolClient, t: string) =>
  (await ok<{ id: string }>(c, KEEPER, `select inv.order_for_request($1, null) as id`, [t]))[0]!.id;

/** The order placed with the supplier for the next day. */
async function place(c: PoolClient, po: string, item: string) {
  const supplier = (
    await c.query<{ id: string }>(
      `select id from inv.supplier where tenant_id = $1 and code = 'SUPPLIER-BEVERAGES-LIQUOR'`,
      [ids.tenant()],
    )
  ).rows[0]!.id;
  await ok(c, KEEPER, `select inv.place_order($1, $2::jsonb, null)`, [
    po,
    JSON.stringify([
      {
        supplier_id: supplier,
        expected_on: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        lines: [{ item_id: item }],
      },
    ]),
  ]);
  await execute(c);
}

describe("a request's order: never a closed or dead one (H14, M22)", () => {
  it('the keeper closed the order: Buy what’s short makes a new one', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, MAIN, 0);
      const t = await ask(c, item, 24);
      const po = await orderFor(c, t);
      // a second tap: the same order
      expect(await orderFor(c, t)).toBe(po);
      await execute(c);
      await place(c, po, item);
      await ok(c, KEEPER, `select inv.close_order($1, 'supplier has none')`, [po]);
      const [now] = await ok<{ stage: string }>(c, ASKER, 'select stage from inv.request_now($1)', [
        t,
      ]);
      expect(now!.stage).not.toBe('being_ordered');
      const again = await orderFor(c, t);
      expect(again).not.toBe(po);
    });
  });

  it('the order could not go through: ordering it again makes a new one', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, MAIN, 0);
      const t = await ask(c, item, 24);
      const po = await orderFor(c, t);
      await c.query(
        `update wf.request set state = 'failed', failure_code = 'HANDLER_NOT_FOUND'
          where id = (select wf_request_id from inv.purchase_order where id = $1)`,
        [po],
      );
      const [stuck] = await ok<{ stage: string; words: string }>(
        c,
        ASKER,
        'select stage, words from inv.request_now($1)',
        [t],
      );
      expect(stuck!.words).toMatch(/Order it again/);
      const again = await orderFor(c, t);
      expect(again).not.toBe(po);
      // the new one is the one the request follows now
      const [now] = await ok<{ stage: string }>(c, ASKER, 'select stage from inv.request_now($1)', [
        t,
      ]);
      expect(now!.stage).not.toBe('stuck');
    });
  });
});

describe('what is still coming: live orders only, never below nothing (H15)', () => {
  it("a closed order's rest is not coming; a line received over its order cancels nothing", async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node(MAIN);
      const item = await stockedItem(c, store, 'H15-ONION', 0, { par: 50 });
      const supplier = (
        await c.query<{ id: string }>(
          `select id from inv.supplier where tenant_id = $1 and code = 'SUPPLIER-BEVERAGES-LIQUOR'`,
          [ids.tenant()],
        )
      ).rows[0]!.id;
      // three orders placed with the supplier: 50 (20 came, the rest closed), 10 (10.5 came),
      // 30 (nothing yet)
      const order = async (qty: number, received: number, closed: boolean) => {
        const po = (
          await c.query<{ id: string }>(
            `insert into inv.purchase_order (tenant_id, delivery_node_id, supplier_id, status,
                                             released_at, ordered_at, closed_at, closed_by,
                                             close_reason)
             values ($1, $2, $3, 'released', now(), now(), $4, $5, $6) returning id`,
            [
              ids.tenant(),
              store,
              supplier,
              closed ? new Date() : null,
              closed ? ids.user(KEEPER) : null,
              closed ? 'not coming' : null,
            ],
          )
        ).rows[0]!.id;
        const line = (
          await c.query<{ id: string }>(
            `insert into inv.purchase_order_line (tenant_id, po_id, item_id, delivery_node_id, qty,
                                                  unit_cost)
             values ($1, $2, $3, $4, $5, 10) returning id`,
            [ids.tenant(), po, item, store, qty],
          )
        ).rows[0]!.id;
        if (received > 0) {
          const gr = (
            await c.query<{ id: string }>(
              `insert into inv.goods_receipt (tenant_id, po_id, delivery_node_id)
               values ($1, $2, $3) returning id`,
              [ids.tenant(), po, store],
            )
          ).rows[0]!.id;
          await c.query(
            `insert into inv.goods_receipt_line (tenant_id, receipt_id, po_line_id, item_id,
                                                 delivery_node_id, qty, unit_cost)
             values ($1, $2, $3, $4, $5, $6, 10)`,
            [ids.tenant(), gr, line, item, store, received],
          );
        }
      };
      await order(50, 20, true);
      await order(10, 10.5, false);
      await order(30, 0, false);
      const [s] = await ok<{ open_po_qty: string; suggested_qty: string }>(
        c,
        KEEPER,
        `select open_po_qty::float8::text, suggested_qty::float8::text
           from inv.suggested_order($1) where item_id = $2`,
        [store, item],
      );
      // only the 30 is coming: the par of 50 less 30
      expect(s).toEqual({ open_po_qty: '30', suggested_qty: '20' });
    });
  });
});

describe('a send task closes when its request is no longer waiting to be sent (M20)', () => {
  const sendTask = async (c: PoolClient, t: string) =>
    (
      await c.query<{ id: string; status: string; cancel_reason: string | null }>(
        `select id, status, cancel_reason from ops.task where transfer_id = $1 and kind = 'send'`,
        [t],
      )
    ).rows;

  it('given to a runner, then sent from the transfer page: the runner’s task is cancelled', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, MAIN, 40);
      const t = await ask(c, item, 12);
      await ok(c, KEEPER, 'select inv.give_send($1, $2)', [t, ids.user(RUNNER)]);
      await ok(c, KEEPER, 'select inv.dispatch_transfer($1, null)', [t]);
      expect(await sendTask(c, t)).toEqual([
        expect.objectContaining({
          status: 'cancelled',
          cancel_reason: 'sent by Test Store Keeper 1.0',
        }),
      ]);
    });
  });

  it('given to a runner, then rejected by the store: the runner’s task is cancelled', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, MAIN, 40);
      const t = await ask(c, item, 12);
      await ok(c, KEEPER, 'select inv.give_send($1, $2)', [t, ids.user(RUNNER)]);
      const req = (
        await c.query<{ r: string }>(
          'select wf_request_id::text as r from inv.transfer where id = $1',
          [t],
        )
      ).rows[0]!.r;
      await ok(c, KEEPER, `select wf.act($1, 'reject', 'none to spare')`, [req]);
      await execute(c);
      expect(await sendTask(c, t)).toEqual([
        expect.objectContaining({ status: 'cancelled', cancel_reason: 'rejected' }),
      ]);
    });
  });

  it('sent by the runner from their task: done, not cancelled', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, MAIN, 40);
      const t = await ask(c, item, 12);
      const [task] = await ok<{ id: string }>(c, KEEPER, 'select inv.give_send($1, $2) as id', [
        t,
        ids.user(RUNNER),
      ]);
      await ok(c, RUNNER, 'select ops.send_by_task($1, null)', [task!.id]);
      expect(await sendTask(c, t)).toEqual([
        expect.objectContaining({ id: task!.id, status: 'done' }),
      ]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// M14, M15: receiving
// ---------------------------------------------------------------------------------------------

describe('a receipt keeps the amount typed; free goods can be received (M14, M15)', () => {
  /** An order of `qty` lager for housekeeping, placed with the supplier by the Main Store. */
  async function placed(c: PoolClient, qty: number) {
    const item = await lager(c);
    await stockAt(c, item, MAIN, 0);
    await stockAt(c, item, HK, 0);
    const t = await ask(c, item, qty);
    const po = await orderFor(c, t);
    await execute(c);
    await place(c, po, item);
    return { po, item };
  }
  const receive = (c: PoolClient, po: string, lines: object[]) =>
    attemptAs(c, ids.user(KEEPER), `select inv.receive_goods($1, $2::jsonb, null) as id`, [
      po,
      JSON.stringify(lines),
    ]);

  it('Rs 1,000 for 3,000: the line, the ledger, the order and stock movements all say 1,000', async () => {
    await inRolledBackTx(async (c) => {
      const { po, item } = await placed(c, 3000);
      const r = await receive(c, po, [{ item_id: item, qty: 3000, amount: 1000 }]);
      expect(r.error).toBeUndefined();
      const gr = (r.rows![0] as { id: string }).id;
      const line = await c.query<{ amount: string; unit_cost: string }>(
        `select amount::text, unit_cost::text from inv.goods_receipt_line where receipt_id = $1`,
        [gr],
      );
      expect(line.rows).toEqual([{ amount: '1000.00', unit_cost: '0.333333' }]);
      const ledger = await c.query<{ v: string }>(
        `select round(sum(qty * unit_cost), 2)::text as v from inv.stock_ledger
          where ref_type = 'goods_receipt' and ref_id = $1`,
        [gr],
      );
      expect(ledger.rows[0]!.v).toBe('1000.00');
      const [value] = await ok<{ v: string }>(
        c,
        KEEPER,
        'select inv.po_received_value($1)::text as v',
        [po],
      );
      expect(value!.v).toBe('1000.00');
      const moves = await ok<{ id: string; value: string }>(
        c,
        KEEPER,
        `select id, value::text from rpt.stock_movements($1, current_date - 1, current_date + 1)
          where kind = 'received'`,
        [ids.node(MAIN)],
      );
      expect(moves.find((m) => m.id === gr)?.value).toBe('1000.00');
    });
  });

  it('a line marked free, with why, is received at no cost; without a reason it is refused', async () => {
    await inRolledBackTx(async (c) => {
      const { po, item } = await placed(c, 24);
      expect((await receive(c, po, [{ item_id: item, qty: 2, amount: 0 }])).error).toMatch(
        /AMOUNT_REQUIRED/,
      );
      expect(
        (await receive(c, po, [{ item_id: item, qty: 2, free: true, free_reason: ' ' }])).error,
      ).toMatch(/FREE_REASON_REQUIRED/);
      const r = await receive(c, po, [
        { item_id: item, qty: 2, free: true, free_reason: 'Sample' },
      ]);
      expect(r.error).toBeUndefined();
      const gr = (r.rows![0] as { id: string }).id;
      const line = await c.query(
        `select qty::float8 as qty, amount::text, unit_cost::float8 as unit_cost, free_reason
           from inv.goods_receipt_line where receipt_id = $1`,
        [gr],
      );
      expect(line.rows).toEqual([{ qty: 2, amount: '0.00', unit_cost: 0, free_reason: 'Sample' }]);
      expect(await onHand(c, item, ids.node(MAIN))).toBe(2);
      const ledger = await c.query<{ cost: number }>(
        `select unit_cost::float8 as cost from inv.stock_ledger
          where ref_type = 'goods_receipt' and ref_id = $1`,
        [gr],
      );
      expect(ledger.rows).toEqual([{ cost: 0 }]);
    });
  });
});
