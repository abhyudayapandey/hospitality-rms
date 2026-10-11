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

// A department asks for stock and follows it to the end (ADR 115), walked on Test Hotel 1.0
// with the housekeeping store keeping lager for the room minibars, as Passport's does:
//   housekeeping asks -> the store that keeps it (the Bar) -> its manager sends it, or gives
//   it to someone who sends it -> housekeeping receives it.
//   The Bar is short -> it asks the Main Store -> the GM approves (every request to the Main
//   Store) -> the keeper sends it, or orders it from a supplier and sends it once received ->
//   the Bar receives it and is told to send on -> housekeeping receives it.
// At each step: who has it in their To do list, who was told, and what whoever asked sees.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const HK = 'TEST-HOTEL-1.0-HOUSEKEEPING-STORE';
const BAR = 'TEST-HOTEL-1.0-BAR-STORE';
const MAIN = 'TEST-HOTEL-1.0-MAIN-STORE';
const ASKER = 'test.executive-housekeeper.1.0';
const BAR_MANAGER = 'test.bar-manager.1.0';
const BARTENDER = 'test.bartender.1.0';
const GM = 'test.general-manager.1.0';
const KEEPER = 'test.store-keeper.1.0';

async function rows<T extends object>(
  c: PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}

async function one<T extends object>(
  c: PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
) {
  return (await rows<T>(c, who, text, params))[0]!;
}

async function fails(c: PoolClient, who: string, text: string, params: unknown[] = []) {
  return (await attemptAs(c, ids.user(who), text, params)).error ?? null;
}

/** The lager item, kept at the housekeeping store (par 48) as well as the Bar. */
async function lager(c: PoolClient): Promise<string> {
  const item = (
    await c.query<{ id: string }>(
      `select id from inv.item where tenant_id = $1 and name = 'Test Lager Beer 330ml'`,
      [ids.tenant()],
    )
  ).rows[0]!.id;
  await c.query(
    `insert into inv.item_node (tenant_id, item_id, delivery_node_id, par_level)
     values ($1, $2, $3, 48) on conflict do nothing`,
    [ids.tenant(), item, ids.node(HK)],
  );
  return item;
}

/** Sets an item's stock at a store to `qty` (an adjustment, as a count would). */
async function stockAt(c: PoolClient, item: string, store: string, qty: number) {
  await c.query(
    `insert into inv.item_node (tenant_id, item_id, delivery_node_id, par_level)
     values ($1, $2, $3, 0) on conflict do nothing`,
    [ids.tenant(), item, ids.node(store)],
  );
  const have = Number(
    (
      await c.query<{ q: string }>(
        `select coalesce((select on_hand from inv.stock_level
                           where item_id = $1 and delivery_node_id = $2), 0) as q`,
        [item, ids.node(store)],
      )
    ).rows[0]!.q,
  );
  if (have !== qty) {
    await c.query(
      `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                     unit_cost, ref_type)
       values ($1, $2, $3, 'count_adjust', $4, 110, 'test')`,
      [ids.tenant(), item, ids.node(store), qty - have],
    );
  }
}

async function onHand(c: PoolClient, item: string, store: string): Promise<number> {
  return Number(
    (
      await c.query<{ q: string }>(
        `select coalesce((select on_hand from inv.stock_level
                           where item_id = $1 and delivery_node_id = $2), 0) as q`,
        [item, ids.node(store)],
      )
    ).rows[0]!.q,
  );
}

/** Runs the executor on whatever the chain has waiting, as wf-execute does each minute. */
async function execute(c: PoolClient) {
  for (;;) {
    const { rows: due } = await c.query<{ id: string; handler: string; request_id: string }>(
      `select id, handler, request_id from wf.outbox where status = 'pending'
        and tenant_id = $1 order by created_at limit 1`,
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

/** The requests in a person's To do list, by subject. */
async function todo(c: PoolClient, who: string): Promise<string[]> {
  return (await rows<{ subject_id: string }>(c, who, `select subject_id from wf.my_inbox()`)).map(
    (r) => r.subject_id,
  );
}

/** Open tasks a person has, by kind and transfer. */
async function tasks(c: PoolClient, who: string, transfer: string) {
  return (
    await c.query<{ id: string; kind: string }>(
      `select id, kind from ops.task
        where transfer_id = $1 and assignee_user_id = $2 and status in ('open', 'in_progress')`,
      [transfer, ids.user(who)],
    )
  ).rows;
}

/** Notifications a person got in this test (all stamped with its transaction's time). */
async function told(c: PoolClient, who: string, _since?: Date): Promise<string[]> {
  return (
    await c.query<{ title: string }>(
      `select title from ops.notification where owner_user_id = $1 and created_at >= now()
        order by id`,
      [ids.user(who)],
    )
  ).rows.map((r) => r.title);
}

/** What whoever asked sees: where it is now, and its story so far. */
async function seen(c: PoolClient, who: string, transfer: string) {
  const now = await one<{ stage: string; words: string }>(
    c,
    who,
    `select stage, words from inv.request_now($1)`,
    [transfer],
  );
  const story = (
    await rows<{ words: string }>(c, who, `select words from inv.request_story($1)`, [transfer])
  ).map((r) => r.words);
  return { ...now, story };
}

async function ask(c: PoolClient, item: string, qty: number): Promise<string> {
  const r = await one<{ ids: string[] }>(
    c,
    ASKER,
    `select inv.ask_for_stock($1, $2::jsonb, 'for the minibars') as ids`,
    [ids.node(HK), JSON.stringify([{ item_id: item, qty }])],
  );
  expect(r.ids).toHaveLength(1);
  return r.ids[0]!;
}

async function transferOf(c: PoolClient, id: string) {
  return (
    await c.query<{
      from_code: string;
      status: string;
      dispatched_at: Date | null;
      received_at: Date | null;
    }>(
      `select n.code as from_code, t.status, t.dispatched_at, t.received_at
         from inv.transfer t join core.hierarchy_node n on n.id = t.from_node_id
        where t.id = $1`,
      [id],
    )
  ).rows[0]!;
}

describe('a department asks for stock and follows it (ADR 115)', () => {
  it('goes to the store that keeps the item: the Bar for lager, the Main Store for towels', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      expect(
        (
          await one<{ s: string }>(c, ASKER, `select inv.stock_source($1, $2)::text as s`, [
            ids.node(HK),
            item,
          ])
        ).s,
      ).toBe(ids.node(BAR));
      const towel = (
        await c.query<{ id: string }>(
          `select id from inv.item where tenant_id = $1 and name ilike '%bath towel%' limit 1`,
          [ids.tenant()],
        )
      ).rows[0]!.id;
      expect(
        (
          await one<{ s: string }>(c, ASKER, `select inv.stock_source($1, $2)::text as s`, [
            ids.node(HK),
            towel,
          ])
        ).s,
      ).toBe(ids.node(MAIN));
      // one ask for both makes one request to each store
      const r = await one<{ ids: string[] }>(
        c,
        ASKER,
        `select inv.ask_for_stock($1, $2::jsonb) as ids`,
        [
          ids.node(HK),
          JSON.stringify([
            { item_id: item, qty: 12 },
            { item_id: towel, qty: 10 },
          ]),
        ],
      );
      expect(r.ids).toHaveLength(2);
      const from = await Promise.all(r.ids.map(async (t) => (await transferOf(c, t)).from_code));
      expect(from.sort()).toEqual([BAR, MAIN].sort());
    });
  });

  it('the Bar has it: its manager gives it to a bartender, who sends it; housekeeping receives it', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, BAR, 40);
      const since = new Date();
      const t = await ask(c, item, 12);

      // the Bar manager has it to send; no approval for one department asking another
      expect(await todo(c, BAR_MANAGER)).toContain(t);
      expect(await todo(c, GM)).not.toContain(t);
      expect(await told(c, BAR_MANAGER, since)).toContainEqual(
        expect.stringMatching(/asks for 12 .*Lager/),
      );
      const asked = await seen(c, ASKER, t);
      expect(asked.stage).toBe('with_store');
      expect(asked.words).toMatch(/Bar Store/);
      expect(asked.story[0]).toMatch(/Asked by Test Executive Housekeeper 1\.0/);

      // given to a bartender: a task for them; whoever asked is told who is bringing it
      await one(c, BAR_MANAGER, `select inv.give_send($1, $2) as id`, [t, ids.user(BARTENDER)]);
      const [send] = await tasks(c, BARTENDER, t);
      expect(send?.kind).toBe('send');
      expect(await told(c, BARTENDER, since)).toContainEqual(expect.stringMatching(/Send/));
      expect((await seen(c, ASKER, t)).words).toMatch(/Test Bartender 1\.0/);

      // the bartender sends it: it leaves the Bar, and whoever asked gets it to receive
      await one(c, BARTENDER, `select ops.send_by_task($1, null) as id`, [send!.id]);
      expect(await onHand(c, item, BAR)).toBe(28);
      expect((await transferOf(c, t)).dispatched_at).not.toBeNull();
      expect(await todo(c, BAR_MANAGER)).not.toContain(t);
      await execute(c);
      const [receive] = await tasks(c, ASKER, t);
      expect(receive?.kind).toBe('receive');
      expect(await told(c, ASKER, since)).toContainEqual(expect.stringMatching(/On the way/));
      expect((await seen(c, ASKER, t)).stage).toBe('on_the_way');

      // received: in the housekeeping store, done, and the Bar manager hears it arrived
      await one(c, ASKER, `select ops.receive_sent($1, $2::jsonb) as id`, [
        receive!.id,
        JSON.stringify([{ item_id: item, qty: 12 }]),
      ]);
      expect(await onHand(c, item, HK)).toBe(12);
      const done = await seen(c, ASKER, t);
      expect(done.stage).toBe('received');
      expect(done.story.join(' | ')).toMatch(
        /Asked by .* \| Given to Test Bartender 1\.0 to send \| Sent by Test Bartender 1\.0: 12 × .* \| Received by Test Executive Housekeeper 1\.0/,
      );
      expect(await told(c, BAR_MANAGER, since)).toContainEqual(expect.stringMatching(/Received/));
    });
  });

  it('the Bar is short: it asks the Main Store, the GM approves, the keeper sends; the Bar sends on', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, BAR, 2);
      await stockAt(c, item, MAIN, 100);
      const since = new Date();
      const t = await ask(c, item, 12);

      // the Bar manager asks the Main Store for what is short
      const up = (
        await one<{ id: string }>(c, BAR_MANAGER, `select inv.ask_main_store($1, null) as id`, [t])
      ).id;
      expect((await transferOf(c, up)).from_code).toBe(MAIN);
      expect(
        (
          await c.query<{ qty: string }>(
            `select requested_qty::text as qty from inv.transfer_line where transfer_id = $1`,
            [up],
          )
        ).rows[0]!.qty,
      ).toMatch(/^10(\.0+)?$/);
      expect((await seen(c, ASKER, t)).words).toMatch(/Main Store/);
      expect(await told(c, ASKER, since)).toContainEqual(expect.stringMatching(/Main Store/));

      // every request to the Main Store waits for the GM, by name; the keeper sees it waiting
      expect(await todo(c, GM)).toContain(up);
      expect(await todo(c, KEEPER)).not.toContain(up);
      expect((await seen(c, BAR_MANAGER, up)).words).toMatch(
        /Waiting for Test General Manager 1\.0/,
      );
      expect((await seen(c, ASKER, t)).words).toMatch(/Test General Manager 1\.0/);
      expect(await told(c, GM, since)).toContainEqual(expect.stringMatching(/approve/i));

      // approved: the keeper has it to send; the Bar and whoever asked are told
      const req = (
        await c.query<{ r: string }>(
          `select wf_request_id::text as r from inv.transfer where id = $1`,
          [up],
        )
      ).rows[0]!.r;
      await one(c, GM, `select wf.act($1, 'approve', null) as s`, [req]);
      expect(await todo(c, KEEPER)).toContain(up);
      expect(await told(c, BAR_MANAGER, since)).toContainEqual(expect.stringMatching(/approved/i));
      expect((await seen(c, ASKER, t)).story.join(' | ')).toMatch(
        /Approved by Test General Manager 1\.0/,
      );

      // the keeper sends it; the Bar manager receives it and is told to send on
      await one(c, KEEPER, `select inv.send_request($1, null) as s`, [up]);
      await execute(c);
      const [barReceive] = await tasks(c, BAR_MANAGER, up);
      expect(barReceive?.kind).toBe('receive');
      await one(c, BAR_MANAGER, `select ops.receive_sent($1, $2::jsonb) as id`, [
        barReceive!.id,
        JSON.stringify([{ item_id: item, qty: 10 }]),
      ]);
      expect(await onHand(c, item, BAR)).toBe(12);
      // back with the Bar to send on; whoever asked hears it reached the Bar
      expect(await todo(c, BAR_MANAGER)).toContain(t);
      expect(await told(c, ASKER, since)).toContainEqual(
        expect.stringMatching(/Arrived at the Bar Store/),
      );

      // and on to housekeeping, the Bar manager sending it himself
      await one(c, BAR_MANAGER, `select inv.send_request($1, null) as s`, [t]);
      await execute(c);
      const [receive] = await tasks(c, ASKER, t);
      await one(c, ASKER, `select ops.receive_sent($1, $2::jsonb) as id`, [
        receive!.id,
        JSON.stringify([{ item_id: item, qty: 12 }]),
      ]);
      expect(await onHand(c, item, HK)).toBe(12);
      const story = (await seen(c, ASKER, t)).story.join(' | ');
      expect(story).toMatch(/Bar Store asked the Main Store for 10/);
      expect(story).toMatch(/Approved by Test General Manager 1\.0/);
      expect(story).toMatch(/Received by Test Executive Housekeeper 1\.0/);
    });
  });

  it('nobody has it: the keeper orders it, receives it, is told to send it; the chain carries on', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, BAR, 0);
      await stockAt(c, item, MAIN, 0);
      const since = new Date();
      const t = await ask(c, item, 24);
      const up = (
        await one<{ id: string }>(c, BAR_MANAGER, `select inv.ask_main_store($1, null) as id`, [t])
      ).id;
      const req = (
        await c.query<{ r: string }>(
          `select wf_request_id::text as r from inv.transfer where id = $1`,
          [up],
        )
      ).rows[0]!.r;
      await one(c, GM, `select wf.act($1, 'approve', null) as s`, [req]);

      // the keeper orders it: already approved, so straight onto the order desk
      const po = (
        await one<{ id: string }>(c, KEEPER, `select inv.order_for_request($1, null) as id`, [up])
      ).id;
      await execute(c);
      expect(
        (
          await c.query<{ p: string }>(
            `select progress as p from inv.purchase_order_summary where id = $1`,
            [po],
          )
        ).rows[0]!.p,
      ).toBe('to_order');
      expect((await seen(c, ASKER, t)).words).toMatch(/ordered|supplier/i);

      // placed with the supplier, then received at the Main Store
      const supplier = (
        await c.query<{ id: string }>(
          `select id from inv.supplier where tenant_id = $1 and code = 'SUPPLIER-BEVERAGES-LIQUOR'`,
          [ids.tenant()],
        )
      ).rows[0]!.id;
      await one(c, KEEPER, `select inv.place_order($1, $2::jsonb, null) as ids`, [
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
      const placed = (
        await c.query<{ id: string }>(
          `select id from inv.purchase_order where (id = $1 or request_po_id = $1)
              and supplier_id is not null order by created_at desc limit 1`,
          [po],
        )
      ).rows[0]!.id;
      expect((await seen(c, ASKER, t)).story.join(' | ')).toMatch(/Ordered from .* due/);
      await one(c, KEEPER, `select inv.receive_goods($1, $2::jsonb, null) as s`, [
        placed,
        JSON.stringify([{ item_id: item, qty: 24, amount: 2640 }]),
      ]);
      expect(await onHand(c, item, MAIN)).toBe(24);
      // the store's other keeper is told to send it on; it is in the keeper's To do list
      expect(await told(c, 'test.purchase-manager.1.0', since)).toContainEqual(
        expect.stringMatching(/send it to the Bar Store/i),
      );
      expect(await todo(c, KEEPER)).toContain(up);
      expect((await seen(c, ASKER, t)).story.join(' | ')).toMatch(/Arrived at .*Main Store/);

      // the rest is the same chain: Main Store to the Bar, the Bar to housekeeping
      await one(c, KEEPER, `select inv.send_request($1, null) as s`, [up]);
      await execute(c);
      const [barReceive] = await tasks(c, BAR_MANAGER, up);
      await one(c, BAR_MANAGER, `select ops.receive_sent($1, $2::jsonb) as id`, [
        barReceive!.id,
        JSON.stringify([{ item_id: item, qty: 24 }]),
      ]);
      await one(c, BAR_MANAGER, `select inv.send_request($1, null) as s`, [t]);
      await execute(c);
      const [receive] = await tasks(c, ASKER, t);
      await one(c, ASKER, `select ops.receive_sent($1, $2::jsonb) as id`, [
        receive!.id,
        JSON.stringify([{ item_id: item, qty: 24 }]),
      ]);
      expect(await onHand(c, item, HK)).toBe(24);
      expect((await seen(c, ASKER, t)).stage).toBe('received');
    });
  });

  it('the GM says no: the Bar manager and whoever asked hear why; the Bar decides what to send', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, BAR, 4);
      const since = new Date();
      const t = await ask(c, item, 12);
      const up = (
        await one<{ id: string }>(c, BAR_MANAGER, `select inv.ask_main_store($1, null) as id`, [t])
      ).id;
      const req = (
        await c.query<{ r: string }>(
          `select wf_request_id::text as r from inv.transfer where id = $1`,
          [up],
        )
      ).rows[0]!.r;
      await one(c, GM, `select wf.act($1, 'reject', 'enough for this week') as s`, [req]);
      await execute(c);
      expect(await told(c, BAR_MANAGER, since)).toContainEqual(
        expect.stringMatching(/not approved/i),
      );
      expect(await told(c, ASKER, since)).toContainEqual(expect.stringMatching(/not approved/i));
      expect((await seen(c, ASKER, t)).story.join(' | ')).toMatch(/enough for this week/);
      // still the Bar's to send: what it has
      expect(await todo(c, BAR_MANAGER)).toContain(t);
      await one(c, BAR_MANAGER, `select inv.send_request($1, $2::jsonb) as s`, [
        t,
        JSON.stringify([{ item_id: item, qty: 4 }]),
      ]);
      await execute(c);
      const [receive] = await tasks(c, ASKER, t);
      await one(c, ASKER, `select ops.receive_sent($1, $2::jsonb) as id`, [
        receive!.id,
        JSON.stringify([{ item_id: item, qty: 4 }]),
      ]);
      expect(await onHand(c, item, HK)).toBe(4);
    });
  });

  it('asking the Main Store directly waits for the GM too, never for whoever asked', async () => {
    await inRolledBackTx(async (c) => {
      const towel = (
        await c.query<{ id: string }>(
          `select id from inv.item where tenant_id = $1 and name ilike '%bath towel%' limit 1`,
          [ids.tenant()],
        )
      ).rows[0]!.id;
      await stockAt(c, towel, MAIN, 50);
      const r = await one<{ ids: string[] }>(
        c,
        ASKER,
        `select inv.ask_for_stock($1, $2::jsonb) as ids`,
        [ids.node(HK), JSON.stringify([{ item_id: towel, qty: 10 }])],
      );
      const t = r.ids[0]!;
      expect(await todo(c, GM)).toContain(t);
      expect(await todo(c, ASKER)).not.toContain(t);
      expect((await seen(c, ASKER, t)).words).toMatch(/Waiting for Test General Manager 1\.0/);
      // the store keeper sees it waiting for the GM, not in his To do list yet
      expect(await todo(c, KEEPER)).not.toContain(t);
    });
  });

  it('only the people of the stores see a request, its story and its steps', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, BAR, 40);
      const t = await ask(c, item, 12);
      // someone of another outlet: refused, not told what exists
      expect(
        await fails(c, 'test.bar-manager.3.0', `select * from inv.request_story($1)`, [t]),
      ).toMatch(/NOT_AUTHORISED/);
      expect(
        await fails(c, 'test.solo.bar-manager', `select * from inv.request_now($1)`, [t]),
      ).toMatch(/NOT_AUTHORISED/);
      // a bartender can't give it out or ask the Main Store; only the Bar's manager can
      expect(
        await fails(c, BARTENDER, `select inv.give_send($1, $2)`, [t, ids.user(BARTENDER)]),
      ).toMatch(/NOT_AUTHORISED/);
      expect(await fails(c, BARTENDER, `select inv.ask_main_store($1, null)`, [t])).toMatch(
        /NOT_AUTHORISED/,
      );
      // someone else's send task can't be done by another
      await one(c, BAR_MANAGER, `select inv.give_send($1, $2) as id`, [t, ids.user(BARTENDER)]);
      const [send] = await tasks(c, BARTENDER, t);
      expect(
        await fails(c, 'test.bartender-b.1.0', `select ops.send_by_task($1, null)`, [send!.id]),
      ).toMatch(/NOT_AUTHORISED|NOT_FOUND/);
    });
  });
});

// A frontline person asks their department head (ADR 115): the head gives it from the
// department's store, or asks for it (the chain above) and gives it once it arrives. Whoever
// asked follows it the whole way.
describe('a frontline person asks their department head, and follows it', () => {
  const ATTENDANT = 'test.room-attendant.1.0';

  async function raise(c: PoolClient, item: string, qty: number): Promise<string> {
    return (
      await one<{ id: string }>(
        c,
        ATTENDANT,
        `select inv.raise_staff_ask($1, $2::jsonb, 'for room 104') as id`,
        [ids.node(HK), JSON.stringify([{ item_id: item, qty }])],
      )
    ).id;
  }

  async function askSeen(c: PoolClient, who: string, ask: string) {
    const now = await one<{ stage: string; words: string }>(
      c,
      who,
      `select stage, words from inv.staff_ask_now($1)`,
      [ask],
    );
    const story = (
      await rows<{ words: string }>(c, who, `select words from inv.staff_ask_story($1)`, [ask])
    ).map((r) => r.words);
    return { ...now, story };
  }

  async function headTask(c: PoolClient, ask: string) {
    return (
      await c.query<{ id: string; assignee: string; status: string }>(
        `select id, assignee_user_id::text as assignee, status from ops.task
          where staff_ask_id = $1 and kind = 'ask'`,
        [ask],
      )
    ).rows[0];
  }

  it('the store has it: the head gives it; the attendant sees it with the head, then given', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, HK, 10);
      // the attendant asks the store their department uses
      const stores = await rows<{ id: string }>(
        c,
        ATTENDANT,
        `select id::text from inv.my_ask_stores()`,
      );
      expect(stores.map((s) => s.id)).toContain(ids.node(HK));
      const ask = await raise(c, item, 6);
      const task = await headTask(c, ask);
      expect(task?.assignee).toBe(ids.user(ASKER));
      expect(await told(c, ASKER)).toContainEqual(
        expect.stringMatching(/Test Room Attendant 1\.0 asks for 6 × .*Lager/),
      );
      const asked = await askSeen(c, ATTENDANT, ask);
      expect(asked.stage).toBe('with_head');
      expect(asked.words).toMatch(/Test Executive Housekeeper 1\.0/);

      await one(c, ASKER, `select inv.give_staff_ask($1, null) as s`, [ask]);
      expect(await told(c, ATTENDANT)).toContainEqual(expect.stringMatching(/Ready for you/));
      const given = await askSeen(c, ATTENDANT, ask);
      expect(given.stage).toBe('given');
      expect(given.story.join(' | ')).toMatch(
        /Asked by Test Room Attendant 1\.0 .* \| Given by Test Executive Housekeeper 1\.0/,
      );
      expect((await headTask(c, ask))?.status).toBe('done');
      // in the attendant's own list
      const mine = await rows<{ id: string; stage: string }>(
        c,
        ATTENDANT,
        `select id::text, stage from inv.my_staff_asks()`,
      );
      expect(mine).toContainEqual({ id: ask, stage: 'given' });
    });
  });

  it('the store is short: the head asks the Bar; the attendant follows it to the end', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, HK, 0);
      await stockAt(c, item, BAR, 40);
      const ask = await raise(c, item, 6);

      const [t] = (
        await one<{ ids: string[] }>(c, ASKER, `select inv.ask_for_staff($1) as ids`, [ask])
      ).ids;
      expect((await transferOf(c, t!)).from_code).toBe(BAR);
      const asked = await askSeen(c, ATTENDANT, ask);
      expect(asked.stage).toBe('asked_on');
      expect(asked.words).toMatch(/Bar Store/);
      expect(await told(c, ATTENDANT)).toContainEqual(expect.stringMatching(/Bar Store/));

      await one(c, BAR_MANAGER, `select inv.send_request($1, null) as s`, [t]);
      await execute(c);
      expect((await askSeen(c, ATTENDANT, ask)).words).toMatch(/On the way/);
      const [receive] = await tasks(c, ASKER, t!);
      await one(c, ASKER, `select ops.receive_sent($1, $2::jsonb) as id`, [
        receive!.id,
        JSON.stringify([{ item_id: item, qty: 6 }]),
      ]);
      // arrived: the attendant hears it; the head's task is still open, to give it
      expect(await told(c, ATTENDANT)).toContainEqual(
        expect.stringMatching(/Arrived at the Housekeeping Store/),
      );
      expect((await headTask(c, ask))?.status).toMatch(/open|in_progress/);
      await one(c, ASKER, `select inv.give_staff_ask($1, null) as s`, [ask]);
      const done = await askSeen(c, ATTENDANT, ask);
      expect(done.stage).toBe('given');
      expect(done.story.join(' | ')).toMatch(
        /Asked by .* \| .*asked the Bar Store.* \| .*Received by Test Executive Housekeeper 1\.0.* \| Given by/,
      );
    });
  });

  it('the head says no: the attendant hears why', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      const ask = await raise(c, item, 6);
      await one(c, ASKER, `select inv.close_staff_ask($1, 'enough in the room') as s`, [ask]);
      expect(await told(c, ATTENDANT)).toContainEqual(expect.stringMatching(/Not given/));
      const seen = await askSeen(c, ATTENDANT, ask);
      expect(seen.stage).toBe('closed');
      expect(seen.words).toMatch(/enough in the room/);
    });
  });

  it('only whoever asked and the store’s people see it; only the head acts on it', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      const ask = await raise(c, item, 6);
      expect(
        await fails(c, 'test.room-attendant-b.1.0', `select * from inv.staff_ask_now($1)`, [ask]),
      ).toMatch(/NOT_AUTHORISED/);
      expect(await fails(c, ATTENDANT, `select inv.give_staff_ask($1, null)`, [ask])).toMatch(
        /NOT_AUTHORISED/,
      );
      // a bartender may not ask the housekeeping store
      expect(
        await fails(c, BARTENDER, `select inv.raise_staff_ask($1, $2::jsonb)`, [
          ids.node(HK),
          JSON.stringify([{ item_id: item, qty: 1 }]),
        ]),
      ).toMatch(/NOT_AUTHORISED/);
      // the table itself shows a frontline person nothing: they read it through the functions
      expect(
        await rows<{ n: number }>(c, ATTENDANT, `select count(*)::int as n from inv.staff_ask`),
      ).toEqual([{ n: 0 }]);
    });
  });
});
