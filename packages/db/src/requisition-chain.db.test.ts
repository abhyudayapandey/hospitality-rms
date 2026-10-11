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
      expect(await told(c, KEEPER)).toContainEqual(expect.stringMatching(/asks for 12 .*Lager/));
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

      await one(c, GM, `select wf.act($1, 'approve', null) as s`, [
        await requestOf(c, 'transfer', t),
      ]);
      expect(await todo(c, BAR_MANAGER)).toContain(t);
      expect(await told(c, BAR_MANAGER)).toContainEqual(expect.stringMatching(/asks for 12/));
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
        lines: [expect.objectContaining({ qty: 6, at_store: 10 })],
      });
      expect((await detail(ASKER)).may_act).toBe(true);
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
      await one(c, ASKER, `select inv.give_staff_ask($1, null) as s`, [ask]);
      const done = await askSeen(c, ATTENDANT, ask);
      expect(done.stage).toBe('given');
      expect(done.story.join(' | ')).toMatch(
        /Asked by .* \| .*asked the Main Store.* \| .*Received by Test Executive Housekeeper 1\.0.* \| Given by/,
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
