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

// The Main Store keeper's day (ADR 051): receiving at actual amounts, the order desk's list,
// and sending stock to a department, received through a task. Test Hotel 1.0: the store
// keeper keeps the Main Store; the executive chef heads the kitchen and keeps its store.

const KEEPER = 'test.store-keeper.1.0';
const CHEF = 'test.executive-chef.1.0'; // kitchen head, keeper of the Kitchen store
const COMMIS = 'test.commis.1.0';
const GM = 'test.general-manager.1.0';
const OUTSIDER = 'test.bar-manager.3.0';

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const main = () => ids.node('TEST-HOTEL-1.0-MAIN-STORE');
const kitchen = () => ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');
const kitchenTeam = () => ids.node('TEST-HOTEL-1.0-KITCHEN');
// today at the test outlets (India), as current_date is in a test session (helpers.ts),
// not the UTC date, which is a day behind from 18:30 to 24:00 UTC
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

async function call<T = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
): Promise<T> {
  const r = await attemptAs<T & object>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows[0] as T;
}
const rows = async (c: PoolClient, who: string, text: string, params: unknown[] = []) => {
  const r = await attemptAs<Record<string, unknown>>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
};
const error = async (c: PoolClient, who: string, text: string, params: unknown[] = []) =>
  (await attemptAs(c, ids.user(who), text, params)).error;

const onHand = async (c: PoolClient, item: string, node: string) =>
  Number(
    (
      await c.query<{ q: string | null }>(
        `select on_hand as q from inv.stock_level where item_id = $1 and delivery_node_id = $2`,
        [item, node],
      )
    ).rows[0]?.q ?? 0,
  );

/** A kitchen supply request, approved if it asked, released, and placed by the desk. */
async function placedRequest(c: PoolClient): Promise<{ po: string; items: string[] }> {
  const its = (
    await c.query<{ id: string }>(
      `select item_id as id from inv.item_node where delivery_node_id = $1 and archived_at is null
        order by item_id limit 2`,
      [kitchen()],
    )
  ).rows.map((r) => r.id);
  const { id } = await call<{ id: string }>(
    c,
    CHEF,
    `select inv.request_supplies($1, $2::jsonb, null) as id`,
    [kitchen(), JSON.stringify(its.map((item_id) => ({ item_id, qty: 2 })))],
  );
  const req = (
    await c.query<{ r: string; state: string }>(
      `select p.wf_request_id as r, q.state from inv.purchase_order p
         join wf.request q on q.id = p.wf_request_id where p.id = $1`,
      [id],
    )
  ).rows[0]!;
  if (req.state !== 'approved') await call(c, GM, `select wf.act($1, 'approve')`, [req.r]);
  await c.query(`update wf.request set state = 'executing' where id = $1 and state = 'approved'`, [
    req.r,
  ]);
  await actAs(c, 'wf_executor', null);
  await c.query('select inv.execute($1, $2)', ['inv.po.release', req.r]);
  await resetRole(c);
  const s = (
    await c.query<{ id: string }>(
      `insert into inv.supplier (tenant_id, name)
       select tenant_id, 'Flow Supplier' from core.hierarchy_node where id = $1 returning id`,
      [kitchen()],
    )
  ).rows[0]!.id;
  await call(c, KEEPER, `select inv.place_order($1, $2::jsonb)`, [
    id,
    JSON.stringify([
      { supplier_id: s, expected_on: today(), lines: its.map((item_id) => ({ item_id })) },
    ]),
  ]);
  return { po: id, items: its };
}

describe('receiving at actual amounts', () => {
  it('needs the amount for everything received and costs the stock at what was paid', async () => {
    await inRolledBackTx(async (c) => {
      const { po, items } = await placedRequest(c);
      const receive = (lines: object[]) =>
        error(c, KEEPER, `select inv.receive_goods($1, $2::jsonb, null)`, [
          po,
          JSON.stringify(lines),
        ]);
      expect(await receive([{ item_id: items[0], qty: 2 }])).toMatch(/AMOUNT_REQUIRED/);
      expect(await receive([{ item_id: items[0], qty: 0, amount: 0 }])).toMatch(/INVALID_LINES/);
      expect(await receive([{ item_id: items[0], qty: -1, amount: 5 }])).toMatch(
        /INVALID_QUANTITY/,
      );
      // the second line had nothing yet: skipped, and the order stays part received
      expect(
        await receive([
          { item_id: items[0], qty: 2, amount: 250 },
          { item_id: items[1], qty: null, amount: null },
        ]),
      ).toBeUndefined();
      const cost = await c.query<{ unit_cost: string }>(
        `select l.unit_cost from inv.stock_ledger l
          join inv.goods_receipt g on g.id = l.ref_id
         where g.po_id = $1 and l.movement_type = 'receipt'`,
        [po],
      );
      expect(cost.rows.map((r) => Number(r.unit_cost))).toEqual([125]);
      const v = await call<{ v: string; missing: boolean }>(
        c,
        CHEF,
        `select inv.po_received_value($1) as v, inv.po_bill_missing($1) as missing`,
        [po],
      );
      expect(v).toEqual({ v: '250.00', missing: true });
      expect(
        (
          await call<{ m: boolean | null }>(c, OUTSIDER, `select inv.po_bill_missing($1) as m`, [
            po,
          ])
        ).m,
      ).toBeNull();
    });
  });

  it('the bill clears the "Bill missing" flag', async () => {
    await inRolledBackTx(async (c) => {
      const { po, items } = await placedRequest(c);
      await call(c, KEEPER, `select inv.receive_goods($1, $2::jsonb, null)`, [
        po,
        JSON.stringify([{ item_id: items[0], qty: 2, amount: 100 }]),
      ]);
      const t = (
        await c.query<{ t: string }>(
          `select tenant_id as t from core.hierarchy_node where id = $1`,
          [kitchen()],
        )
      ).rows[0]!.t;
      await call(
        c,
        KEEPER,
        `select inv.add_bill(null, $1, null, null, 'B-1', current_date, 100, null, $2::text[])`,
        [po, [`bills/${t}/${kitchen()}/${crypto.randomUUID()}.jpg`]],
      );
      expect(
        (await call<{ m: boolean }>(c, GM, `select inv.po_bill_missing($1) as m`, [po])).m,
      ).toBe(false);
    });
  });
});

describe("the order desk's list", () => {
  it('holds the requests it places for other stores, to order, to receive and received', async () => {
    await inRolledBackTx(async (c) => {
      const { po, items } = await placedRequest(c);
      const stage = async () =>
        (
          await rows(
            c,
            KEEPER,
            `select progress, bill_missing from inv.desk_order_list() where po_id = $1`,
            [po],
          )
        )[0];
      expect(await stage()).toEqual({ progress: 'released', bill_missing: false });
      await call(c, KEEPER, `select inv.receive_goods($1, $2::jsonb, null)`, [
        po,
        JSON.stringify(items.map((item_id) => ({ item_id, qty: 2, amount: 50 }))),
      ]);
      expect(await stage()).toEqual({ progress: 'received', bill_missing: true });
      // the kitchen is not anyone's order desk here; another outlet sees none of it
      for (const who of [CHEF, OUTSIDER]) {
        expect(
          await rows(c, who, `select po_id from inv.desk_order_list() where po_id = $1`, [po]),
        ).toEqual([]);
      }
    });
  });
});

/** Puts COMMIS on a published kitchen shift covering now (or nobody, when `who` is null). */
async function onShift(c: PoolClient, who: string | null) {
  await c.query(
    `update hr.shift_assignment a set status = 'dropped', drop_reason = 'unassigned'
      where a.start_at <= now() and a.end_at > now() and a.status = 'assigned'`,
  );
  if (!who) return;
  const a = (
    await c.query<{ id: string; shift_id: string }>(
      `select a.id, a.shift_id from hr.shift_assignment a
        where a.owner_user_id = $1 order by a.start_at desc limit 1`,
      [ids.user(who)],
    )
  ).rows[0];
  if (!a) throw new Error(`${who} has no shift to move`);
  await c.query(
    `update hr.shift set status = 'published', start_at = now() - interval '1 hour',
                         end_at = now() + interval '3 hours' where id = $1`,
    [a.shift_id],
  );
  await c.query(
    `update hr.shift_assignment set status = 'assigned', drop_reason = null, start_at = now() - interval '1 hour',
                                    end_at = now() + interval '3 hours' where id = $1`,
    [a.id],
  );
}

async function send(
  c: PoolClient,
  qty = 2,
): Promise<{ transfer: string; item: string; task: string }> {
  const item = (
    await rows(c, KEEPER, `select item_id from inv.send_items($1, $2) order by name limit 1`, [
      main(),
      kitchen(),
    ])
  )[0]!.item_id as string;
  // enough at the Main Store to send
  await c.query(`select inv.post_at($1, $2, 'receipt', 10, 5, 'test', null, now())`, [
    item,
    main(),
  ]);
  const { id } = await call<{ id: string }>(
    c,
    KEEPER,
    `select inv.send_stock($1, $2, $3::jsonb, null) as id`,
    [main(), kitchen(), JSON.stringify([{ item_id: item, qty }])],
  );
  const task = (
    await c.query<{ id: string }>(`select id from ops.task where transfer_id = $1`, [id])
  ).rows[0]!.id;
  return { transfer: id, item, task };
}

describe('send stock', () => {
  it('leaves the Main Store at once; the person on shift in the department gets the task', async () => {
    await inRolledBackTx(async (c) => {
      await onShift(c, COMMIS);
      const { transfer, item, task } = await send(c);
      // 10 put in by send(), 2 sent
      const out = await c.query<{ q: string }>(
        `select sum(qty) as q from inv.stock_ledger where ref_id = $1 and delivery_node_id = $2`,
        [transfer, main()],
      );
      expect(Number(out.rows[0]!.q)).toBe(-2);
      const t = (
        await c.query<{ assignee: string; kind: string; status: string }>(
          `select assignee_user_id as assignee, kind, status from ops.task where id = $1`,
          [task],
        )
      ).rows[0]!;
      expect(t).toEqual({ assignee: ids.user(COMMIS), kind: 'receive', status: 'open' });
      const progress = (
        await c.query<{ progress: string }>(
          `select progress from inv.transfer_summary where id = $1`,
          [transfer],
        )
      ).rows[0]!.progress;
      expect(progress).toBe('in_transit');
      // the head is told who will receive it
      const told = await c.query(
        `select 1 from ops.notification where owner_user_id = $1 and kind = 'stock_sent'`,
        [ids.user(CHEF)],
      );
      expect(told.rowCount).toBeGreaterThan(0);
      // it is in the commis's tasks, with what was sent
      expect(
        (await rows(c, COMMIS, `select id from ops.my_tasks() where id = $1`, [task])).length,
      ).toBe(1);
      expect(await rows(c, COMMIS, `select item_id, sent from ops.sent_lines($1)`, [task])).toEqual(
        [{ item_id: item, sent: '2.000' }],
      );
    });
  });

  it('reaches the department when the person confirms; a shortfall is transit loss, the head told', async () => {
    await inRolledBackTx(async (c) => {
      await onShift(c, COMMIS);
      const { transfer, item, task } = await send(c);
      const kitchenBefore = await onHand(c, item, kitchen());
      const confirm = (who: string, qty: number) =>
        error(c, who, `select ops.receive_sent($1, $2::jsonb)`, [
          task,
          JSON.stringify([{ item_id: item, qty }]),
        ]);
      expect(await confirm(OUTSIDER, 2)).toMatch(/NOT_AUTHORISED|NOT_FOUND/);
      expect(await confirm(COMMIS, 3)).toMatch(/INVALID_QUANTITY/);
      expect(await confirm(COMMIS, 1.5)).toBeUndefined();
      expect(await onHand(c, item, kitchen())).toBeCloseTo(kitchenBefore + 1.5, 3);
      const done = (
        await c.query<{ status: string; tstatus: string }>(
          `select t.status, tr.status as tstatus from ops.task t
             join inv.transfer tr on tr.id = t.transfer_id where t.id = $1`,
          [task],
        )
      ).rows[0]!;
      expect(done).toEqual({ status: 'done', tstatus: 'completed' });
      const short = await c.query(
        `select 1 from ops.notification where owner_user_id = $1 and kind = 'stock_short'`,
        [ids.user(CHEF)],
      );
      expect(short.rowCount).toBeGreaterThan(0);
      expect(await confirm(COMMIS, 2)).toMatch(/INVALID_STATE/);
      expect(
        (await c.query(`select progress from inv.transfer_summary where id = $1`, [transfer]))
          .rows[0],
      ).toEqual({ progress: 'completed' });
    });
  });

  it('with nobody on shift the head gets it, and passes it to someone in the team', async () => {
    await inRolledBackTx(async (c) => {
      await onShift(c, null);
      const { item, task } = await send(c);
      const assignee = async () =>
        (
          await c.query<{ a: string }>(`select assignee_user_id as a from ops.task where id = $1`, [
            task,
          ])
        ).rows[0]!.a;
      expect(await assignee()).toBe(ids.user(CHEF));
      expect(
        await error(c, COMMIS, `select ops.reassign_task($1, $2)`, [task, ids.user(COMMIS)]),
      ).toMatch(/NOT_AUTHORISED/);
      expect(
        await error(c, CHEF, `select ops.reassign_task($1, $2)`, [task, ids.user(OUTSIDER)]),
      ).toMatch(/INVALID_ASSIGNEE/);
      await call(c, CHEF, `select ops.reassign_task($1, $2)`, [task, ids.user(COMMIS)]);
      expect(await assignee()).toBe(ids.user(COMMIS));
      // the head still follows it, with who has it (ADR 074)
      expect(
        await rows(c, CHEF, `select assignee_name from ops.my_handed_on() where id = $1`, [task]),
      ).toEqual([{ assignee_name: 'Test Commis 1.0' }]);
      expect(await error(c, CHEF, `select ops.task_detail($1)`, [task])).toBeUndefined();
      await call(c, COMMIS, `select ops.receive_sent($1, $2::jsonb)`, [
        task,
        JSON.stringify([{ item_id: item, qty: 2 }]),
      ]);
      // and is told it was received
      const done = await c.query(
        `select 1 from ops.notification where owner_user_id = $1 and kind = 'task_done'`,
        [ids.user(CHEF)],
      );
      expect(done.rowCount).toBe(1);
    });
  });

  it('only from a store the person keeps, to a store of the same outlet a team uses', async () => {
    await inRolledBackTx(async (c) => {
      const item = (
        await rows(c, KEEPER, `select item_id from inv.send_items($1, $2) limit 1`, [
          main(),
          kitchen(),
        ])
      )[0]!.item_id as string;
      const lines = JSON.stringify([{ item_id: item, qty: 1 }]);
      for (const who of [COMMIS, OUTSIDER]) {
        expect(
          await error(c, who, `select inv.send_stock($1, $2, $3::jsonb)`, [
            main(),
            kitchen(),
            lines,
          ]),
        ).toMatch(/NOT_AUTHORISED/);
      }
      const otherOutlet = ids.node('TEST-BAR-3.0-KITCHEN-STORE');
      expect(
        await error(c, KEEPER, `select inv.send_stock($1, $2, $3::jsonb)`, [
          main(),
          otherOutlet,
          lines,
        ]),
      ).toMatch(/INVALID_SUBJECT/);
      expect(
        await error(c, KEEPER, `select inv.send_stock($1, $2, $3::jsonb)`, [
          main(),
          kitchen(),
          JSON.stringify([{ item_id: item, qty: 0 }]),
        ]),
      ).toMatch(/INVALID_LINES/);
      expect(
        (await rows(c, KEEPER, `select id from inv.send_destinations($1)`, [main()])).map(
          (r) => r.id,
        ),
      ).toContain(kitchen());
      expect(kitchenTeam()).toBeTruthy();
    });
  });
});

describe('what the Main Store can give (ADR 051 addendum)', () => {
  const bar = () => ids.node('TEST-HOTEL-1.0-BAR-STORE');
  const housekeeping = () => ids.node('TEST-HOTEL-1.0-HOUSEKEEPING-STORE');
  const BAR_KEEPER = 'test.bar-manager.1.0';
  const names = async (c: PoolClient, who: string, text: string, params: unknown[]) =>
    (await rows(c, who, text, params)).map((r) => r.name as string);
  const itemId = async (c: PoolClient, name: string) =>
    (
      await c.query<{ id: string }>(
        `select id from inv.item where name = $1 and tenant_id =
           (select tenant_id from core.hierarchy_node where id = $2)`,
        [name, main()],
      )
    ).rows[0]!.id;

  it('every store sees everything, in two groups, its own first; the first send sets it up', async () => {
    await inRolledBackTx(async (c) => {
      // linen at the Main Store too: used only by housekeeping, so a Housekeeping item
      const linen = (
        await c.query<{ item_id: string; name: string }>(
          `select x.item_id, i.name from inv.item_node x join inv.item i on i.id = x.item_id
            where x.delivery_node_id = $1 and i.category = 'Linen' limit 1`,
          [housekeeping()],
        )
      ).rows[0]!;
      await c.query(
        `insert into inv.item_node (tenant_id, item_id, delivery_node_id)
         select tenant_id, $1, id from core.hierarchy_node where id = $2`,
        [linen.item_id, main()],
      );
      const list = async (to: string) =>
        (
          await rows(c, KEEPER, `select name, item_group from inv.send_items($1, $2)`, [main(), to])
        ).map((r) => [r.name as string, r.item_group as string]);
      const toBar = await list(bar());
      expect(toBar).toEqual(
        expect.arrayContaining([
          ['Test Tomato Ketchup', 'kitchen_bar'],
          ['Test Aluminium Foil Roll', 'kitchen_bar'],
          [linen.name, 'housekeeping'],
        ]),
      );
      // the bar's own group first
      expect(toBar[0]![1]).toBe('kitchen_bar');
      expect(toBar.at(-1)![1]).toBe('housekeeping');
      const toHk = await list(housekeeping());
      expect(toHk[0]).toEqual([linen.name, 'housekeeping']);
      expect(toHk.map((r) => r[0])).toContain('Test Basmati Rice');
      // ketchup is not set up at the bar; sending it sets it up and it arrives
      const ketchup = await itemId(c, 'Test Tomato Ketchup');
      await c.query(`select inv.post_at($1, $2, 'receipt', 5, 80, 'test', null, now())`, [
        ketchup,
        main(),
      ]);
      await call(c, KEEPER, `select inv.send_stock($1, $2, $3::jsonb, null)`, [
        main(),
        bar(),
        JSON.stringify([{ item_id: ketchup, qty: 1 }]),
      ]);
      const setUp = await c.query(
        `select par_level from inv.item_node where item_id = $1 and delivery_node_id = $2`,
        [ketchup, bar()],
      );
      expect(setUp.rows).toEqual([{ par_level: '0.000' }]);
    });
  });

  it('the bar can ask the Main Store for them too', async () => {
    await inRolledBackTx(async (c) => {
      const foil = await itemId(c, 'Test Aluminium Foil Roll');
      expect(
        await names(c, BAR_KEEPER, `select name from inv.request_items($1, $2)`, [bar(), main()]),
      ).toContain('Test Aluminium Foil Roll');
      await call(c, BAR_KEEPER, `select inv.request_transfer($1, $2, $3::jsonb, null)`, [
        main(),
        bar(),
        JSON.stringify([{ item_id: foil, qty: 1 }]),
      ]);
      // and nobody else's list: another outlet's keeper is refused
      expect(
        await error(c, OUTSIDER, `select name from inv.request_items($1, $2)`, [bar(), main()]),
      ).toMatch(/NOT_AUTHORISED/);
    });
  });

  // ADR 077: asking a store lists what that store keeps, not the asker's own list
  it('asking another store lists only what both stores keep, with what is here and its par', async () => {
    await inRolledBackTx(async (c) => {
      const HK_HEAD = 'test.executive-housekeeper.1.0';
      const own = async (node: string) =>
        (
          await c.query<{ name: string }>(
            `select i.name from inv.item_node x join inv.item i on i.id = x.item_id
              where x.delivery_node_id = $1 and x.archived_at is null`,
            [node],
          )
        ).rows.map((r) => r.name);
      // one kitchen item housekeeping keeps too
      const rice = await itemId(c, 'Test Basmati Rice');
      await c.query(
        `insert into inv.item_node (tenant_id, item_id, delivery_node_id, par_level)
         select tenant_id, $1, id, 4 from core.hierarchy_node where id = $2`,
        [rice, housekeeping()],
      );
      const fromKitchen = await rows(
        c,
        HK_HEAD,
        `select name, on_hand, par_level from inv.request_items($1, $2)`,
        [housekeeping(), kitchen()],
      );
      const kitchenItems = await own(kitchen());
      const hkItems = await own(housekeeping());
      // exactly the items both keep: the rice, and the garbage bags both stores use
      const both = hkItems.filter((n) => kitchenItems.includes(n)).sort();
      expect(both).toContain('Test Basmati Rice');
      expect(both.length).toBeLessThan(hkItems.length);
      expect(fromKitchen.map((r) => r.name as string).sort()).toEqual(both);
      expect(fromKitchen.find((r) => r.name === 'Test Basmati Rice')).toMatchObject({
        on_hand: '0',
        par_level: '4.000',
      });
      // the Main Store: what it may give, not housekeeping's items it does not keep
      const fromMain = (
        await rows(c, HK_HEAD, `select name from inv.request_items($1, $2)`, [
          housekeeping(),
          main(),
        ])
      ).map((r) => r.name as string);
      const mainItems = await own(main());
      expect(fromMain.length).toBeGreaterThan(0);
      expect(fromMain.every((n) => mainItems.includes(n))).toBe(true);
      // no source: nothing to list
      expect(
        await rows(c, HK_HEAD, `select name from inv.request_items($1, null)`, [housekeeping()]),
      ).toEqual([]);
    });
  });
});
