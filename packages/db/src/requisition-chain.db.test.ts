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
// with the housekeeping store keeping lager for the room minibars:
//   With a Main Store: housekeeping asks the Main Store -> its keeper sends it, or gives it to
//   someone who sends it, or orders it from a supplier (approved as the company's purchase
//   rule says, by the GM) and sends it once received -> housekeeping receives it.
//   With no Main Store (Passport): housekeeping asks the store that keeps it (the Bar) -> the
//   GM approves -> the Bar sends it, or orders it -> housekeeping receives it; what no other
//   store keeps, housekeeping buys, the GM approving.
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
const PURCHASE_MANAGER = 'test.purchase-manager.1.0';

/** Sets Test Hotel 1.0's rules for its stores, as file 02's outlet row does. */
async function outletRules(c: PoolClient, rules: Record<string, string>) {
  await c.query(
    `update core.hierarchy_node o set stock_rules = o.stock_rules || $2::jsonb
       from core.hierarchy_node s where s.id = $1 and o.id = s.parent_id`,
    [ids.node(HK), JSON.stringify(rules)],
  );
}

/** Test Hotel 1.0 set up as Passport is: no Main Store, and the GM approves every request. */
async function noMainStore(c: PoolClient) {
  await c.query(`update core.hierarchy_node set is_main_store = false where id = $1`, [
    ids.node(MAIN),
  ]);
  await outletRules(c, { request_approval: 'gm' });
}

/** The outlet approves every purchase, and the GM approves them. */
async function approveEveryPurchase(c: PoolClient) {
  await outletRules(c, { purchase_approval: 'every', purchase_approver: 'gm' });
}

async function requestOf(c: PoolClient, table: 'transfer' | 'purchase_order', id: string) {
  return (
    await c.query<{ r: string }>(
      `select wf_request_id::text as r from inv.${table} where id = $1`,
      [id],
    )
  ).rows[0]!.r;
}

async function towelOf(c: PoolClient): Promise<string> {
  return (
    await c.query<{ id: string }>(
      `select id from inv.item where tenant_id = $1 and name ilike '%bath towel%' limit 1`,
      [ids.tenant()],
    )
  ).rows[0]!.id;
}

/** Places a store's order with the supplier and receives it all. */
async function buyAndReceive(c: PoolClient, who: string, po: string, item: string, qty: number) {
  const supplier = (
    await c.query<{ id: string }>(
      `select id from inv.supplier where tenant_id = $1 and code = 'SUPPLIER-BEVERAGES-LIQUOR'`,
      [ids.tenant()],
    )
  ).rows[0]!.id;
  await one(c, who, `select inv.place_order($1, $2::jsonb, null) as ids`, [
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
  await one(c, who, `select inv.receive_goods($1, $2::jsonb, null) as s`, [
    placed,
    JSON.stringify([{ item_id: item, qty, amount: qty * 110 }]),
  ]);
}

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

describe('with a Main Store, a department asks it (ADR 115)', () => {
  it('whoever decides or sends it sees what each store has, and the par (ADR 141)', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, MAIN, 40);
      await stockAt(c, item, HK, 5);
      const t = await ask(c, item, 24);
      for (const who of [KEEPER, ASKER]) {
        const levels = await rows<{
          from_on_hand: number;
          to_on_hand: number;
          to_par: number;
          from_name: string;
          to_name: string;
        }>(
          c,
          who,
          `select from_on_hand::int, to_on_hand::int, to_par::int, from_name, to_name
             from inv.request_levels($1)`,
          [t],
        );
        expect(levels).toEqual([
          {
            from_on_hand: 40,
            to_on_hand: 5,
            to_par: 48,
            from_name: 'Main Store',
            to_name: 'Housekeeping Store',
          },
        ]);
      }
      expect(
        await fails(c, 'test.room-attendant-b.1.0', `select * from inv.request_levels($1)`, [t]),
      ).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('the Main Store doesn’t keep it: its keeper buys it for the store, and keeps it from then on', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, HK, 0);
      await c.query(
        `update inv.item_node set archived_at = now() where item_id = $1 and delivery_node_id = $2`,
        [item, ids.node(MAIN)],
      );
      const t = await ask(c, item, 24);
      expect((await transferOf(c, t)).from_code).toBe(MAIN);
      const po = (
        await one<{ id: string }>(c, KEEPER, `select inv.order_for_request($1, null) as id`, [t])
      ).id;
      expect(po).toBeTruthy();
      const kept = await c.query<{ archived: boolean }>(
        `select archived_at is not null as archived from inv.item_node
          where item_id = $1 and delivery_node_id = $2`,
        [item, ids.node(MAIN)],
      );
      expect(kept.rows).toEqual([{ archived: false }]);
    });
  });

  // ADR 162: a line the store has in full was ordered too, at the whole quantity asked
  it('Buy what’s short buys only what is short; nothing short is refused', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      const towel = await towelOf(c);
      await stockAt(c, item, MAIN, 10);
      await stockAt(c, towel, MAIN, 50);
      const r = await one<{ ids: string[] }>(
        c,
        ASKER,
        `select inv.ask_for_stock($1, $2::jsonb, null) as ids`,
        [
          ids.node(HK),
          JSON.stringify([
            { item_id: item, qty: 24 },
            { item_id: towel, qty: 6 },
          ]),
        ],
      );
      const t = r.ids[0]!;
      const po = (
        await one<{ id: string }>(c, KEEPER, `select inv.order_for_request($1, null) as id`, [t])
      ).id;
      const lines = await c.query<{ item_id: string; qty: number }>(
        `select item_id::text, qty::float as qty from inv.purchase_order_line where po_id = $1`,
        [po],
      );
      expect(lines.rows).toEqual([{ item_id: item, qty: 14 }]);

      const whole = await ask(c, towel, 6);
      expect(await fails(c, KEEPER, `select inv.order_for_request($1, null)`, [whole])).toMatch(
        /NOTHING_SHORT/,
      );
    });
  });

  it('asks the Main Store for everything, though the Bar keeps lager: one request', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      const towel = await towelOf(c);
      for (const it of [item, towel]) {
        expect(
          (
            await one<{ s: string }>(c, ASKER, `select inv.stock_source($1, $2)::text as s`, [
              ids.node(HK),
              it,
            ])
          ).s,
        ).toBe(ids.node(MAIN));
      }
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
      expect(r.ids).toHaveLength(1);
      expect((await transferOf(c, r.ids[0]!)).from_code).toBe(MAIN);
      // the form's grouping says the same; what the Main Store does not keep comes from the
      // central kitchen when it does, else the Main Store buys it
      const src = await rows<{ item_id: string; source_name: string }>(
        c,
        ASKER,
        `select item_id::text, source_name from inv.ask_items($1) where item_id = any ($2)`,
        [ids.node(HK), [item, towel]],
      );
      expect(src.map((r) => r.source_name)).toEqual(['Main Store', 'Main Store']);
      const elsewhere = await rows<{ n: number }>(
        c,
        ASKER,
        `select count(*)::int as n from inv.ask_items($1)
          where source_name not in ('Main Store', 'Test Central Kitchen – Store')`,
        [ids.node(HK)],
      );
      expect(elsewhere).toEqual([{ n: 0 }]);
    });
  });

  it('the Main Store has it: no approval; the keeper gives it to someone, who sends it', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, MAIN, 40);
      const t = await ask(c, item, 12);

      // straight to the keeper; the GM has nothing to approve
      expect(await todo(c, KEEPER)).toContain(t);
      expect(await todo(c, GM)).not.toContain(t);
      expect(await told(c, KEEPER)).toContainEqual(
        expect.stringMatching(/^Request from the .*: 12 .*Lager/),
      );
      const asked = await seen(c, ASKER, t);
      expect(asked.stage).toBe('with_store');
      expect(asked.words).toMatch(/Main Store/);
      expect(asked.story[0]).toMatch(/Asked by Test Executive Housekeeper 1\.0/);

      // what each may do on its page: the keeper sends; whoever asked waits
      const actions = (who: string) =>
        one<{ may_send: boolean; may_receive: boolean; given_to: string | null }>(
          c,
          who,
          `select may_send, may_receive, given_to from inv.request_actions($1)`,
          [t],
        );
      expect(await actions(KEEPER)).toEqual({ may_send: true, may_receive: false, given_to: null });
      expect(await actions(ASKER)).toEqual({ may_send: false, may_receive: false, given_to: null });
      // whom the keeper may give it to: the Stores team; no one else may ask
      expect(
        (await rows<{ name: string }>(c, KEEPER, `select name from inv.send_people($1)`, [t])).map(
          (r) => r.name,
        ),
      ).toContain('Test Purchase Manager 1.0');
      // never the keeper giving it, who can send it themselves (ADR 145)
      expect(
        (await rows<{ name: string }>(c, KEEPER, `select name from inv.send_people($1)`, [t])).map(
          (r) => r.name,
        ),
      ).not.toContain('Test Store Keeper 1.0');
      expect(await fails(c, ASKER, `select * from inv.send_people($1)`, [t])).toMatch(
        /NOT_AUTHORISED/,
      );

      // given to the purchase manager: a task for them; whoever asked is told who brings it
      await one(c, KEEPER, `select inv.give_send($1, $2) as id`, [t, ids.user(PURCHASE_MANAGER)]);
      const [send] = await tasks(c, PURCHASE_MANAGER, t);
      expect(send?.kind).toBe('send');
      expect((await seen(c, ASKER, t)).words).toMatch(/Test Purchase Manager 1\.0/);
      expect((await actions(KEEPER)).given_to).toBe('Test Purchase Manager 1.0');
      const sendLines = await rows<{ asked: string; at_store: string }>(
        c,
        PURCHASE_MANAGER,
        `select asked::int::text as asked, at_store::int::text as at_store
           from ops.send_task_lines($1)`,
        [send!.id],
      );
      expect(sendLines).toEqual([{ asked: '12', at_store: '40' }]);

      await one(c, PURCHASE_MANAGER, `select ops.send_by_task($1, null) as id`, [send!.id]);
      expect(await onHand(c, item, MAIN)).toBe(28);
      expect(await todo(c, KEEPER)).not.toContain(t);
      await execute(c);
      const [receive] = await tasks(c, ASKER, t);
      expect(receive?.kind).toBe('receive');
      expect(await told(c, ASKER)).toContainEqual(expect.stringMatching(/On the way/));
      expect((await actions(ASKER)).may_receive).toBe(true);
      expect((await actions(KEEPER)).may_receive).toBe(false);
      expect((await seen(c, ASKER, t)).stage).toBe('on_the_way');

      await one(c, ASKER, `select ops.receive_sent($1, $2::jsonb) as id`, [
        receive!.id,
        JSON.stringify([{ item_id: item, qty: 12 }]),
      ]);
      expect(await onHand(c, item, HK)).toBe(12);
      const done = await seen(c, ASKER, t);
      expect(done.stage).toBe('received');
      expect(done.story.join(' | ')).toMatch(
        /Asked by .* \| Given to Test Purchase Manager 1\.0 to send \| Sent by Test Purchase Manager 1\.0: 12 × .* \| Received by Test Executive Housekeeper 1\.0/,
      );
      expect(await told(c, KEEPER)).toContainEqual(expect.stringMatching(/Received/));
    });
  });

  it('the Main Store is short: the keeper orders it; by the usual rule no one approves', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, MAIN, 0);
      const t = await ask(c, item, 24);
      const po = (
        await one<{ id: string }>(c, KEEPER, `select inv.order_for_request($1, null) as id`, [t])
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
      expect(await told(c, ASKER)).toContainEqual(expect.stringMatching(/Main Store is buying it/));

      await buyAndReceive(c, KEEPER, po, item, 24);
      expect(await onHand(c, item, MAIN)).toBe(24);
      expect(await told(c, PURCHASE_MANAGER)).toContainEqual(
        expect.stringMatching(/send it to the Housekeeping Store/i),
      );
      expect(await todo(c, KEEPER)).toContain(t);
      expect((await seen(c, ASKER, t)).story.join(' | ')).toMatch(
        /Ordered from .* due .*Arrived at the Main Store/,
      );

      await one(c, KEEPER, `select inv.send_request($1, null) as s`, [t]);
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

  it('where every purchase is approved, the GM approves the order; a no is heard by all', async () => {
    await inRolledBackTx(async (c) => {
      await approveEveryPurchase(c);
      const item = await lager(c);
      await stockAt(c, item, MAIN, 0);
      const t = await ask(c, item, 24);
      const po = (
        await one<{ id: string }>(c, KEEPER, `select inv.order_for_request($1, null) as id`, [t])
      ).id;
      // the GM, not the head of the Stores department (they asked)
      expect(await todo(c, GM)).toContain(po);
      expect(await told(c, GM)).toContainEqual(expect.stringMatching(/To approve/));
      const waiting = await seen(c, ASKER, t);
      expect(waiting.stage).toBe('waiting_approval');
      expect(waiting.words).toMatch(
        /Main Store is buying it: waiting for Test General Manager 1\.0.* to approve/,
      );

      await one(c, GM, `select wf.act($1, 'reject', 'buy it next week') as s`, [
        await requestOf(c, 'purchase_order', po),
      ]);
      await execute(c);
      expect(await told(c, ASKER)).toContainEqual(expect.stringMatching(/Order not approved/));
      expect(await told(c, KEEPER)).toContainEqual(expect.stringMatching(/Order not approved/));
      const after = await seen(c, ASKER, t);
      expect(after.stage).toBe('with_store');
      expect(after.words).toMatch(/not approved by Test General Manager 1\.0/);
      expect(after.story.join(' | ')).toMatch(/Order not approved by .*buy it next week/);

      // asked again: approved, and on it goes
      const again = (
        await one<{ id: string }>(c, KEEPER, `select inv.order_for_request($1, null) as id`, [t])
      ).id;
      expect(again).not.toBe(po);
      await one(c, GM, `select wf.act($1, 'approve', null) as s`, [
        await requestOf(c, 'purchase_order', again),
      ]);
      await execute(c);
      expect(await told(c, ASKER)).toContainEqual(expect.stringMatching(/Order approved/));
      expect((await seen(c, ASKER, t)).stage).toBe('being_ordered');
    });
  });
});

describe('with no Main Store, a department asks the store that keeps it (ADR 115)', () => {
  it('lager comes from the Bar once the GM approves; the Bar gives it to a bartender', async () => {
    await inRolledBackTx(async (c) => {
      await noMainStore(c);
      const item = await lager(c);
      await stockAt(c, item, BAR, 40);
      expect(
        (
          await one<{ s: string }>(c, ASKER, `select inv.stock_source($1, $2)::text as s`, [
            ids.node(HK),
            item,
          ])
        ).s,
      ).toBe(ids.node(BAR));
      const t = await ask(c, item, 12);
      expect((await transferOf(c, t)).from_code).toBe(BAR);

      // the GM first, by name; the Bar manager sees nothing to do yet
      expect(await todo(c, GM)).toContain(t);
      expect(await todo(c, BAR_MANAGER)).not.toContain(t);
      expect(await todo(c, ASKER)).not.toContain(t);
      expect((await seen(c, ASKER, t)).words).toMatch(
        /Waiting for Test General Manager 1\.0.* to approve/,
      );
      expect(await told(c, GM)).toContainEqual(expect.stringMatching(/To approve.*Bar Store/));
      // its status says so too, not "waiting to be sent" (ADR 145)
      const progress = async () =>
        (
          await one<{ p: string }>(
            c,
            ASKER,
            `select progress as p from inv.transfer_summary where id = $1`,
            [t],
          )
        ).p;
      expect(await progress()).toBe('awaiting_approval');

      await one(c, GM, `select wf.act($1, 'approve', null) as s`, [
        await requestOf(c, 'transfer', t),
      ]);
      expect(await progress()).toBe('awaiting_dispatch');
      expect(await todo(c, BAR_MANAGER)).toContain(t);
      expect(await told(c, BAR_MANAGER)).toContainEqual(
        expect.stringMatching(/^Request from the .*: 12 /),
      );
      expect(await told(c, ASKER)).toContainEqual(
        expect.stringMatching(/Approved by Test General Manager 1\.0/),
      );

      await one(c, BAR_MANAGER, `select inv.give_send($1, $2) as id`, [t, ids.user(BARTENDER)]);
      const [send] = await tasks(c, BARTENDER, t);
      await one(c, BARTENDER, `select ops.send_by_task($1, null) as id`, [send!.id]);
      expect(await onHand(c, item, BAR)).toBe(28);
      await execute(c);
      const [receive] = await tasks(c, ASKER, t);
      await one(c, ASKER, `select ops.receive_sent($1, $2::jsonb) as id`, [
        receive!.id,
        JSON.stringify([{ item_id: item, qty: 12 }]),
      ]);
      expect(await onHand(c, item, HK)).toBe(12);
      expect((await seen(c, ASKER, t)).story.join(' | ')).toMatch(
        /Asked by .* \| Approved by Test General Manager 1\.0 \| Given to Test Bartender 1\.0 to send \| Sent by .* \| Received by/,
      );
    });
  });

  it('the Bar is short: it orders it, the GM approving; it arrives and goes on to housekeeping', async () => {
    await inRolledBackTx(async (c) => {
      await noMainStore(c);
      await approveEveryPurchase(c);
      const item = await lager(c);
      await stockAt(c, item, BAR, 2);
      const t = await ask(c, item, 12);
      await one(c, GM, `select wf.act($1, 'approve', null) as s`, [
        await requestOf(c, 'transfer', t),
      ]);
      const po = (
        await one<{ id: string }>(c, BAR_MANAGER, `select inv.order_for_request($1, null) as id`, [
          t,
        ])
      ).id;
      // what is short: 10
      expect(
        (
          await c.query<{ qty: string }>(
            `select qty::text from inv.purchase_order_line where po_id = $1`,
            [po],
          )
        ).rows[0]!.qty,
      ).toMatch(/^10(\.0+)?$/);
      expect(await todo(c, GM)).toContain(po);
      expect((await seen(c, ASKER, t)).words).toMatch(/Bar Store is buying it: waiting for/);
      await one(c, GM, `select wf.act($1, 'approve', null) as s`, [
        await requestOf(c, 'purchase_order', po),
      ]);
      await execute(c);
      await buyAndReceive(c, BAR_MANAGER, po, item, 10);
      expect(await onHand(c, item, BAR)).toBe(12);
      expect(await told(c, ASKER)).toContainEqual(
        expect.stringMatching(/Arrived at the Bar Store/),
      );
      expect(await todo(c, BAR_MANAGER)).toContain(t);
      await one(c, BAR_MANAGER, `select inv.send_request($1, null) as s`, [t]);
      await execute(c);
      const [receive] = await tasks(c, ASKER, t);
      await one(c, ASKER, `select ops.receive_sent($1, $2::jsonb) as id`, [
        receive!.id,
        JSON.stringify([{ item_id: item, qty: 12 }]),
      ]);
      expect(await onHand(c, item, HK)).toBe(12);
      const story = (await seen(c, ASKER, t)).story.join(' | ');
      expect(story).toMatch(/Order approved by Test General Manager 1\.0/);
      expect(story).toMatch(/Received by Test Executive Housekeeper 1\.0/);
    });
  });

  it('the GM says no: whoever asked hears why, and it goes no further', async () => {
    await inRolledBackTx(async (c) => {
      await noMainStore(c);
      const item = await lager(c);
      await stockAt(c, item, BAR, 40);
      const t = await ask(c, item, 12);
      await one(c, GM, `select wf.act($1, 'reject', 'enough for this week') as s`, [
        await requestOf(c, 'transfer', t),
      ]);
      await execute(c);
      expect(await told(c, ASKER)).toContainEqual(expect.stringMatching(/Not approved/));
      const after = await seen(c, ASKER, t);
      expect(after.stage).toBe('closed');
      expect(after.words).toMatch(/enough for this week/);
      expect(await todo(c, BAR_MANAGER)).not.toContain(t);
    });
  });

  it('what no other store keeps, housekeeping buys itself, the GM approving', async () => {
    await inRolledBackTx(async (c) => {
      await noMainStore(c);
      await approveEveryPurchase(c);
      const item = await lager(c);
      await c.query(
        `update inv.item_node set archived_at = now() where item_id = $1 and delivery_node_id <> $2`,
        [item, ids.node(HK)],
      );
      expect(
        await fails(c, ASKER, `select inv.ask_for_stock($1, $2::jsonb)`, [
          ids.node(HK),
          JSON.stringify([{ item_id: item, qty: 12 }]),
        ]),
      ).toMatch(/NO_STORE_KEEPS_IT/);
      const src = await rows<{ item_id: string; source_id: string | null }>(
        c,
        ASKER,
        `select item_id::text, source_id::text from inv.ask_items($1) where item_id = $2`,
        [ids.node(HK), item],
      );
      expect(src).toEqual([{ item_id: item, source_id: null }]);
      const po = (
        await one<{ id: string }>(
          c,
          ASKER,
          `select inv.request_supplies($1, $2::jsonb, null, null) as id`,
          [ids.node(HK), JSON.stringify([{ item_id: item, qty: 12 }])],
        )
      ).id;
      expect(await todo(c, GM)).toContain(po);
      expect(await todo(c, ASKER)).not.toContain(po);
    });
  });
});

describe('who may act on a request (ADR 115)', () => {
  it('only the people of the stores see it; only whoever runs the store gives it out', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, MAIN, 40);
      const t = await ask(c, item, 12);
      expect(
        await fails(c, 'test.bar-manager.3.0', `select * from inv.request_story($1)`, [t]),
      ).toMatch(/NOT_AUTHORISED/);
      expect(
        await fails(c, 'test.solo.bar-manager', `select * from inv.request_now($1)`, [t]),
      ).toMatch(/NOT_AUTHORISED/);
      expect(
        await fails(c, BARTENDER, `select inv.give_send($1, $2)`, [t, ids.user(BARTENDER)]),
      ).toMatch(/NOT_AUTHORISED/);
      expect(await fails(c, BARTENDER, `select inv.order_for_request($1, null)`, [t])).toMatch(
        /NOT_AUTHORISED/,
      );
      expect(await fails(c, ASKER, `select inv.send_request($1, null)`, [t])).toMatch(
        /NOT_AUTHORISED/,
      );
      // given to someone outside the store's team: refused
      expect(
        await fails(c, KEEPER, `select inv.give_send($1, $2)`, [t, ids.user(BARTENDER)]),
      ).toMatch(/INVALID_ASSIGNEE/);
      await one(c, KEEPER, `select inv.give_send($1, $2) as id`, [t, ids.user(PURCHASE_MANAGER)]);
      const [send] = await tasks(c, PURCHASE_MANAGER, t);
      expect(
        await fails(c, 'test.receiving-clerk.1.0', `select ops.send_by_task($1, null)`, [send!.id]),
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
      const keeps = await rows<{ item_id: string; on_hand: string }>(
        c,
        ATTENDANT,
        `select item_id::text, on_hand::int::text as on_hand from inv.ask_store_items($1)`,
        [ids.node(HK)],
      );
      expect(keeps).toContainEqual({ item_id: item, on_hand: '10' });
      const ask = await raise(c, item, 6);
      // its page: the head acts on it, the attendant follows it
      const detail = (who: string) =>
        one<{ may_act: boolean; asked_by: string; lines: { qty: number }[] }>(
          c,
          who,
          `select may_act, asked_by, lines from inv.staff_ask_detail($1)`,
          [ask],
        );
      expect(await detail(ATTENDANT)).toMatchObject({
        may_act: false,
        asked_by: 'Test Room Attendant 1.0',
        lines: [expect.objectContaining({ qty: 6, at_store: 10, par: 48 })],
      });
      expect((await detail(ASKER)).may_act).toBe(true);
      const task = await headTask(c, ask);
      expect(task?.assignee).toBe(ids.user(ASKER));
      expect(await told(c, ASKER)).toContainEqual(
        expect.stringMatching(/^Request from Test Room Attendant 1\.0: 6 × .*Lager/),
      );
      const asked = await askSeen(c, ATTENDANT, ask);
      expect(asked.stage).toBe('with_head');
      expect(asked.words).toMatch(/Test Executive Housekeeper 1\.0/);

      await one(c, ASKER, `select inv.give_staff_ask($1, null) as s`, [ask]);
      expect(await told(c, ATTENDANT)).toContainEqual(expect.stringMatching(/Ready for you/));
      // "Ready for you" says it; the head's task sends no "Done: ..." as well (ADR 141)
      expect(await told(c, ATTENDANT)).not.toContainEqual(expect.stringMatching(/^Done: /));
      const given = await askSeen(c, ATTENDANT, ask);
      // given: the attendant takes it to the department (ADR 142)
      expect(given.stage).toBe('to_collect');
      expect(given.words).toBe(
        'Given by Test Executive Housekeeper 1.0. Take it to the Housekeeping.',
      );
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
      expect(mine).toContainEqual({ id: ask, stage: 'to_collect' });
    });
  });

  it('the store is short: the head asks the Main Store; the attendant follows it to the end', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, HK, 0);
      await stockAt(c, item, MAIN, 40);
      const ask = await raise(c, item, 6);

      const [t] = (
        await one<{ ids: string[] }>(c, ASKER, `select inv.ask_for_staff($1) as ids`, [ask])
      ).ids;
      expect((await transferOf(c, t!)).from_code).toBe(MAIN);
      const asked = await askSeen(c, ATTENDANT, ask);
      expect(asked.stage).toBe('asked_on');
      expect(asked.words).toMatch(/Main Store/);
      // nothing has arrived: the head may not give it yet (ADR 141)
      expect(await told(c, ATTENDANT)).toContainEqual(expect.stringMatching(/Main Store/));

      await one(c, KEEPER, `select inv.send_request($1, null) as s`, [t]);
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
      expect((await askSeen(c, ASKER, ask)).stage).toBe('arrived');
      await one(c, ASKER, `select inv.give_staff_ask($1, null) as s`, [ask]);
      const done = await askSeen(c, ATTENDANT, ask);
      expect(done.stage).toBe('to_collect');
      expect(done.story.join(' | ')).toMatch(
        /Asked by .* \| .*asked the Main Store.* \| .*Received by Test Executive Housekeeper 1\.0.* \| Given by/,
      );
    });
  });

  it('given: whoever asked takes it to the department, by the end of their shift (ADR 142)', async () => {
    await inRolledBackTx(async (c) => {
      // no shift today: due in 2 hours (with a shift, at its end)
      await c.query(`delete from hr.shift_assignment where owner_user_id = $1`, [
        ids.user(ATTENDANT),
      ]);
      const item = await lager(c);
      await stockAt(c, item, HK, 10);
      const ask = await raise(c, item, 6);
      await one(c, ASKER, `select inv.give_staff_ask($1, null) as s`, [ask]);
      // a Collect task, for whoever asked, from the head; due in 2 hours with no shift today
      const collect = (
        await c.query<{
          id: string;
          assignee: string;
          assigned_by: string;
          title: string;
          description: string;
          hours: number;
          status: string;
        }>(
          `select id, assignee_user_id::text as assignee, assigned_by::text as assigned_by, title,
                  description, round(extract(epoch from due_at - now()) / 3600)::int as hours,
                  status
             from ops.task where staff_ask_id = $1 and kind = 'collect'`,
          [ask],
        )
      ).rows;
      expect(collect).toHaveLength(1);
      expect(collect[0]).toMatchObject({
        assignee: ids.user(ATTENDANT),
        assigned_by: ids.user(ASKER),
        description: 'Take it to the Housekeeping, then tap Transfer to Housekeeping done.',
        status: 'open',
      });
      expect(collect[0]!.title).toMatch(/^Collect from the Housekeeping Store: 6 × .*Lager/);
      expect(collect[0]!.hours).toBeLessThanOrEqual(2);
      // it leads to the ask's page, where its one button is
      expect(
        (
          await one<{ ask: string | null }>(c, ATTENDANT, `select ops.task_ask($1)::text as ask`, [
            collect[0]!.id,
          ])
        ).ask,
      ).toBe(ask);
      expect(
        await rows<{ department: string }>(
          c,
          ATTENDANT,
          `select department from inv.my_collect($1)`,
          [ask],
        ),
      ).toEqual([{ department: 'Housekeeping' }]);
      // only whoever asked says it went to the department; no stock moves
      expect(await rows(c, ASKER, `select department from inv.my_collect($1)`, [ask])).toEqual([]);
      expect(await fails(c, ASKER, `select inv.collect_staff_ask($1)`, [ask])).toMatch(
        /NOT_AUTHORISED/,
      );
      const before = await onHand(c, item, HK);
      await one(c, ATTENDANT, `select inv.collect_staff_ask($1) as s`, [ask]);
      expect(await onHand(c, item, HK)).toBe(before);
      const done = await askSeen(c, ATTENDANT, ask);
      expect(done.stage).toBe('given');
      expect(done.words).toBe('Taken to the Housekeeping by Test Room Attendant 1.0');
      // newest first is the screen's job; the story itself runs in time order
      expect(done.story.at(-1)).toBe('Taken to the Housekeeping by Test Room Attendant 1.0');
      const after = await c.query<{ status: string }>(`select status from ops.task where id = $1`, [
        collect[0]!.id,
      ]);
      expect(after.rows[0]?.status).toBe('done');
      // once is enough
      expect(await fails(c, ATTENDANT, `select inv.collect_staff_ask($1)`, [ask])).toMatch(
        /NOT_AUTHORISED|ALREADY|NOT_OPEN/,
      );
    });
  });

  it('the overdue Collect task is the head’s to hear about', async () => {
    await inRolledBackTx(async (c) => {
      // no shift today: due in 2 hours (with a shift, at its end)
      await c.query(`delete from hr.shift_assignment where owner_user_id = $1`, [
        ids.user(ATTENDANT),
      ]);
      const item = await lager(c);
      await stockAt(c, item, HK, 10);
      const ask = await raise(c, item, 6);
      await one(c, ASKER, `select inv.give_staff_ask($1, null) as s`, [ask]);
      await resetRole(c);
      await c.query(`select * from ops.tasks_tick(now() + interval '3 hours')`);
      expect(await told(c, ASKER)).toContainEqual(expect.stringMatching(/^Overdue: Collect from/));
    });
  });

  it('whoever asked never hands on the head’s ask', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      const ask = await raise(c, item, 6);
      const task = await headTask(c, ask);
      expect(
        await fails(c, ATTENDANT, `select ops.reassign_task($1, $2)`, [
          task!.id,
          ids.user('test.room-attendant-b.1.0'),
        ]),
      ).toMatch(/NOT_AUTHORISED|NOT_FOUND/);
      const mine = await rows<{ id: string }>(
        c,
        ATTENDANT,
        `select id::text from ops.my_handed_on() where id = $1`,
        [task!.id],
      );
      expect(mine).toEqual([{ id: task!.id }]);
    });
  });

  it('the Main Store’s request carries the ask: who asked, why, first in its story (ADR 142)', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, HK, 0);
      await stockAt(c, item, MAIN, 40);
      const ask = await raise(c, item, 6);
      const [t] = (
        await one<{ ids: string[] }>(c, ASKER, `select inv.ask_for_staff($1) as ids`, [ask])
      ).ids;
      const forAsk = (who: string) =>
        rows<{ ask_id: string; asked_by: string; note: string | null }>(
          c,
          who,
          `select ask_id::text, asked_by, note from inv.request_for_ask($1)`,
          [t],
        );
      const expected = [{ ask_id: ask, asked_by: 'Test Room Attendant 1.0', note: 'for room 104' }];
      expect(await forAsk(KEEPER)).toEqual(expected);
      expect(await forAsk(ASKER)).toEqual(expected);
      expect(await forAsk(ATTENDANT)).toEqual(expected);
      // nobody else: nothing, rather than a failure that would empty a whole list
      expect(await forAsk(BARTENDER)).toEqual([]);
      // whoever asked follows the request itself, and its story starts with the ask
      const story = (await seen(c, ATTENDANT, t!)).story;
      expect(story[0]).toMatch(/^Asked by Test Room Attendant 1\.0 for .*Lager.*: for room 104$/);
      // and their alerts about it open the ask's page, never the request they cannot act on
      await one(c, KEEPER, `select inv.send_request($1, null) as s`, [t]);
      const links = (
        await c.query<{ link: string }>(
          `select link from ops.notification where owner_user_id = $1 and created_at >= now()`,
          [ids.user(ATTENDANT)],
        )
      ).rows.map((r) => r.link);
      expect(links.length).toBeGreaterThan(0);
      expect(links.every((l) => l === `/stock/asks/${ask}`)).toBe(true);
    });
  });

  it('the head says no: the attendant hears why', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      const ask = await raise(c, item, 6);
      await one(c, ASKER, `select inv.close_staff_ask($1, 'enough in the room') as s`, [ask]);
      expect(await told(c, ATTENDANT)).toContainEqual(expect.stringMatching(/^Rejected: /));
      const seen = await askSeen(c, ATTENDANT, ask);
      expect(seen.stage).toBe('closed');
      expect(seen.words).toBe('Rejected: enough in the room');
      // its story says who rejected it, and why
      expect(seen.story).toContain(
        'Rejected by Test Executive Housekeeper 1.0: enough in the room',
      );
      // the lists say it was rejected and why, never done (ADR 141); one alert, not "Done: ..."
      const task = await headTask(c, ask);
      const mine = await rows<{ id: string; not_given_reason: string | null }>(
        c,
        ASKER,
        `select id::text, not_given_reason from ops.my_tasks() where id = $1`,
        [task!.id],
      );
      expect(mine).toEqual([{ id: task!.id, not_given_reason: 'enough in the room' }]);
      const given = await rows<{ id: string; not_given_reason: string | null }>(
        c,
        ATTENDANT,
        `select id::text, not_given_reason from ops.my_handed_on() where id = $1`,
        [task!.id],
      );
      expect(given).toEqual([{ id: task!.id, not_given_reason: 'enough in the room' }]);
      expect(await told(c, ATTENDANT)).not.toContainEqual(expect.stringMatching(/^Done: /));
      // opened from Given to others, the head's task leads whoever asked to the ask's page,
      // though its row is hidden from them; nobody else is led there
      const via = (who: string) =>
        one<{ ask: string | null }>(c, who, `select ops.task_ask($1)::text as ask`, [task!.id]);
      expect((await via(ATTENDANT)).ask).toBe(ask);
      expect((await via(ASKER)).ask).toBe(ask);
      expect((await via('test.room-attendant-b.1.0')).ask).toBeNull();
      expect(
        await rows<{ n: number }>(
          c,
          ATTENDANT,
          `select count(*)::int as n from ops.task where id = $1`,
          [task!.id],
        ),
      ).toEqual([{ n: 0 }]);
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
      // a bartender may not ask the housekeeping store, nor see what it keeps
      expect(
        await fails(c, BARTENDER, `select * from inv.ask_store_items($1)`, [ids.node(HK)]),
      ).toMatch(/NOT_AUTHORISED/);
      expect(await fails(c, BARTENDER, `select * from inv.staff_ask_detail($1)`, [ask])).toMatch(
        /NOT_AUTHORISED/,
      );
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

  it('says who gives it in the reader’s own words (ADR 146)', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      const ask = await raise(c, item, 2);
      const giver = (who: string) =>
        one<{ w: string }>(c, who, `select inv.ask_giver_words($1) as w`, [ask]);
      expect((await giver(ATTENDANT)).w).toBe('Test Executive Housekeeper 1.0 will give it to you');
      expect((await giver(ASKER)).w).toBe('give it to Test Room Attendant 1.0');
      expect((await giver('test.general-manager.1.0')).w).toBe(
        'Test Executive Housekeeper 1.0 will give it to Test Room Attendant 1.0',
      );
    });
  });

  it('one request, one screen: every step of it opens on the ask (ADR 147)', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, HK, 0);
      await stockAt(c, item, MAIN, 40);
      const ask = await raise(c, item, 6);
      const [t] = (
        await one<{ ids: string[] }>(c, ASKER, `select inv.ask_for_staff($1) as ids`, [ask])
      ).ids;
      // whoever asked, the head, the keeper who sends it (though not one of Housekeeping's):
      // the request opens on the ask
      for (const who of [ATTENDANT, ASKER, KEEPER]) {
        expect(
          (await one<{ a: string | null }>(c, who, `select inv.request_ask($1) as a`, [t])).a,
          who,
        ).toBe(ask);
        expect(
          (await rows<{ id: string }>(c, who, `select inv.ask_requests($1) as id`, [ask])).map(
            (r) => r.id,
          ),
          who,
        ).toEqual([t]);
      }
      // someone with no part in it sees neither
      expect(
        (await one<{ a: string | null }>(c, BARTENDER, `select inv.request_ask($1) as a`, [t])).a,
      ).toBeNull();
      expect(await rows(c, BARTENDER, `select inv.ask_requests($1) as id`, [ask])).toEqual([]);
    });
  });

  it('an ask given before the Collect step can still be taken to the department (ADR 146)', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      await stockAt(c, item, HK, 10);
      const ask = await raise(c, item, 2);
      await one(c, ASKER, `select inv.give_staff_ask($1, null) as s`, [ask]);
      // as it was before ADR 142: given, and no Collect task
      await c.query(`delete from ops.task where staff_ask_id = $1 and kind = 'collect'`, [ask]);
      const mine = await rows<{ task_id: string | null; department: string }>(
        c,
        ATTENDANT,
        `select task_id::text, department from inv.my_collect($1)`,
        [ask],
      );
      expect(mine).toEqual([{ task_id: null, department: 'Housekeeping' }]);
      // nobody else may say it arrived
      expect(await fails(c, ASKER, `select inv.collect_staff_ask($1)`, [ask])).toMatch(
        /NOT_AUTHORISED/,
      );
      await one(c, ATTENDANT, `select inv.collect_staff_ask($1) as s`, [ask]);
      expect((await askSeen(c, ATTENDANT, ask)).words).toMatch(/^Taken to the Housekeeping by/);
      expect(await rows(c, ATTENDANT, `select * from inv.my_collect($1)`, [ask])).toEqual([]);
      expect(await fails(c, ATTENDANT, `select inv.collect_staff_ask($1)`, [ask])).toMatch(
        /NOT_AUTHORISED/,
      );
    });
  });
});

// The over-par order that "showed waiting for approval, with no way to approve it": its page
// says for whom it waits and lets that person approve it there, and an order whose workflow
// failed says so instead of waiting forever (ADR 115).
describe("an order's approval, on its page", () => {
  it('names who approves, lets them approve, then says who did; a failed one says it failed', async () => {
    await inRolledBackTx(async (c) => {
      // every purchase approved, by the department head (the default approver)
      await outletRules(c, { purchase_approval: 'every' });
      const item = await lager(c);
      const po = (
        await one<{ id: string }>(
          c,
          ASKER,
          `select inv.request_supplies($1, $2::jsonb, null, null) as id`,
          [ids.node(HK), JSON.stringify([{ item_id: item, qty: 500 }])],
        )
      ).id;
      const approval = (who: string) =>
        one<{
          state: string;
          waiting_for: string | null;
          may_act: boolean;
          approved_by: string | null;
          failure: string | null;
        }>(
          c,
          who,
          `select state, waiting_for, may_act, approved_by, failure from inv.po_approval($1)`,
          [po],
        );
      // whoever asked heads the department, so the GM approves it, and both see that
      const asked = await approval(ASKER);
      expect(asked).toMatchObject({ state: 'in_approval', may_act: false });
      expect(asked.waiting_for).toMatch(/Test General Manager 1\.0/);
      expect((await approval(GM)).may_act).toBe(true);
      await one(c, GM, `select wf.act($1, 'approve', null) as s`, [
        await requestOf(c, 'purchase_order', po),
      ]);
      expect(await approval(ASKER)).toMatchObject({
        state: 'approved',
        may_act: false,
        approved_by: 'Test General Manager 1.0',
      });
      await execute(c);
      expect((await approval(ASKER)).state).toBe('completed');
      // stuck: the workflow failed
      await c.query(
        `update wf.request set state = 'failed', failure_code = 'HANDLER_NOT_FOUND' where id = $1`,
        [await requestOf(c, 'purchase_order', po)],
      );
      expect((await approval(ASKER)).failure).toBe('HANDLER_NOT_FOUND');
      // someone of another outlet sees nothing
      expect(
        await rows(c, 'test.bar-manager.3.0', `select * from inv.po_approval($1)`, [po]),
      ).toEqual([]);
    });
  });
});

describe('the ask and order forms say whose yes it waits for (ADR 145)', () => {
  const preview = (c: PoolClient, node: string, item: string, qty: number, kind: string) =>
    rows<{ approver: string | null; rule: string | null; why: string[] }>(
      c,
      ASKER,
      `select * from inv.approval_preview($1, $2::jsonb, $3)`,
      [ids.node(node), JSON.stringify([{ item_id: item, qty }]), kind],
    );

  it('the GM, where the outlet has the GM approve every request', async () => {
    await inRolledBackTx(async (c) => {
      await noMainStore(c);
      const item = await lager(c);
      expect(await preview(c, HK, item, 12, 'transfer')).toEqual([
        { approver: 'gm', rule: 'every', why: [] },
      ]);
    });
  });

  it('nobody for a usual request by the usual rule; the GM for every order where so set', async () => {
    await inRolledBackTx(async (c) => {
      const item = await lager(c);
      expect(await preview(c, HK, item, 1, 'transfer')).toEqual([]);
      await approveEveryPurchase(c);
      expect(await preview(c, HK, item, 1, 'order')).toEqual([
        { approver: 'gm', rule: 'every', why: [] },
      ]);
    });
  });
});
