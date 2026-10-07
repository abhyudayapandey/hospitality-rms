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

// UX audit 3's serious findings in the database (ADR 052): the keeper closes an order whose
// rest is not coming and the GM is told; whoever asked withdraws a request nobody has ordered;
// the Main Store, not the department, receives what it orders for a department; and the order
// desk sends the order it placed to the supplier. Test Hotel 1.0: the store keeper keeps the
// Main Store; the executive chef heads the kitchen and keeps its store.

const KEEPER = 'test.store-keeper.1.0';
const CHEF = 'test.executive-chef.1.0';
const GM = 'test.general-manager.1.0';
const HEAD_COOK = 'test.head-cook.3.0';
const BAR_MANAGER = 'test.bar-manager.3.0';
const OUTSIDER = 'test.bar-manager.3.0';

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const kitchen = () => ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');
// today at the test outlets (India), as current_date is in a test session (helpers.ts),
// not the UTC date, which is a day behind from 18:30 to 24:00 UTC
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

const error = async (c: PoolClient, who: string, text: string, params: unknown[] = []) =>
  (await attemptAs(c, ids.user(who), text, params)).error;
async function call<T = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T & object>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}
const progress = async (c: PoolClient, po: string) =>
  (
    await c.query<{ p: string }>(
      `select progress as p from inv.purchase_order_summary where id = $1`,
      [po],
    )
  ).rows[0]!.p;

/** A kitchen supply request for two items, released, the wf request left as it came out. */
async function request(c: PoolClient, qty = 2): Promise<{ po: string; items: string[] }> {
  const items = (
    await c.query<{ id: string }>(
      `select item_id as id from inv.item_node where delivery_node_id = $1 and archived_at is null
        order by item_id limit 2`,
      [kitchen()],
    )
  ).rows.map((r) => r.id);
  const [r] = await call<{ id: string }>(
    c,
    CHEF,
    `select inv.request_supplies($1, $2::jsonb, null) as id`,
    [kitchen(), JSON.stringify(items.map((item_id) => ({ item_id, qty })))],
  );
  return { po: r!.id, items };
}

async function release(c: PoolClient, po: string) {
  const req = (
    await c.query<{ r: string; state: string }>(
      `select p.wf_request_id as r, q.state from inv.purchase_order p
         join wf.request q on q.id = p.wf_request_id where p.id = $1`,
      [po],
    )
  ).rows[0]!;
  if (req.state !== 'approved') await call(c, GM, `select wf.act($1, 'approve')`, [req.r]);
  await c.query(`update wf.request set state = 'executing' where id = $1 and state = 'approved'`, [
    req.r,
  ]);
  await actAs(c, 'wf_executor', null);
  await c.query('select inv.execute($1, $2)', ['inv.po.release', req.r]);
  await resetRole(c);
}

async function place(c: PoolClient, po: string, items: string[]): Promise<string> {
  const s = (
    await c.query<{ id: string }>(
      `insert into inv.supplier (tenant_id, name, phone)
       select tenant_id, 'Close Supplier', '+91 98450 12345' from core.hierarchy_node where id = $1
       returning id`,
      [kitchen()],
    )
  ).rows[0]!.id;
  await call(c, KEEPER, `select inv.place_order($1, $2::jsonb)`, [
    po,
    JSON.stringify([
      { supplier_id: s, expected_on: today(), lines: items.map((item_id) => ({ item_id })) },
    ]),
  ]);
  return s;
}

const receive = (c: PoolClient, who: string, po: string, item: string) =>
  error(c, who, `select inv.receive_goods($1, $2::jsonb, null)`, [
    po,
    JSON.stringify([{ item_id: item, qty: 1, amount: 50 }]),
  ]);

describe('the Main Store receives what it orders for a department', () => {
  it('refuses the department, takes the keeper', async () => {
    await inRolledBackTx(async (c) => {
      const { po, items } = await request(c);
      await release(c, po);
      await place(c, po, items);
      expect(
        (await call<{ v: boolean }>(c, CHEF, `select inv.via_desk($1) as v`, [po]))[0]!.v,
      ).toBe(true);
      // the chef follows it ("on the way"); the keeper runs it
      const follows = async (who: string) =>
        (
          await call<{ o: boolean; s: boolean }>(
            c,
            who,
            `select inv.follows_order($1) as o, inv.follows_store($2) as s`,
            [po, kitchen()],
          )
        )[0];
      expect(await follows(CHEF)).toEqual({ o: true, s: true });
      expect(await follows(KEEPER)).toEqual({ o: false, s: false });
      expect(await receive(c, CHEF, po, items[0]!)).toMatch(/NOT_AUTHORISED/);
      expect(await receive(c, KEEPER, po, items[0]!)).toBeUndefined();
      expect(await progress(c, po)).toBe('partially_received');
    });
  });
});

describe('Rest is not coming', () => {
  it('the keeper closes with a reason; nothing more is received; the GM and chef are told', async () => {
    await inRolledBackTx(async (c) => {
      const { po, items } = await request(c);
      await release(c, po);
      // not ordered yet: nothing to close
      expect(await error(c, KEEPER, `select inv.close_order($1, 'x')`, [po])).toMatch(
        /INVALID_STATE/,
      );
      await place(c, po, items);
      await receive(c, KEEPER, po, items[0]!);
      expect(await error(c, CHEF, `select inv.close_order($1, 'x')`, [po])).toMatch(
        /NOT_AUTHORISED/,
      );
      expect(await error(c, OUTSIDER, `select inv.close_order($1, 'x')`, [po])).toMatch(
        /NOT_AUTHORISED/,
      );
      expect(await error(c, KEEPER, `select inv.close_order($1, '  ')`, [po])).toMatch(
        /REASON_REQUIRED/,
      );
      await call(c, KEEPER, `select inv.close_order($1, 'Supplier out of stock')`, [po]);
      await call(c, KEEPER, `select inv.close_order($1, 'again')`, [po]); // a double tap
      expect(await progress(c, po)).toBe('closed');
      expect(await receive(c, KEEPER, po, items[1]!)).toMatch(/INVALID_STATE/);
      // it leaves the desk's To receive
      const desk = await call<{ po_id: string }>(c, KEEPER, `select po_id from inv.desk_orders()`);
      expect(desk.map((d) => d.po_id)).not.toContain(po);
      const listed = await call<{ progress: string }>(
        c,
        KEEPER,
        `select progress from inv.desk_order_list() where po_id = $1`,
        [po],
      );
      expect(listed[0]?.progress).toBe('closed');
      // why and by whom, for who sees or places it; not for another outlet
      const [why] = await call<{ reason: string; closed_by: string }>(
        c,
        GM,
        `select * from inv.po_closed($1)`,
        [po],
      );
      expect(why).toMatchObject({
        reason: 'Supplier out of stock',
        closed_by: 'Test Store Keeper 1.0',
      });
      expect(await call(c, OUTSIDER, `select * from inv.po_closed($1)`, [po])).toEqual([]);
      // the GM and the chef are told, the keeper is not
      const told = await c.query<{ u: string }>(
        `select u.username as u from ops.notification n join core.app_user u on u.id = n.owner_user_id
          where n.title like '%closed' and n.link like '%' || $1 || '%'`,
        [po],
      );
      const who = told.rows.map((r) => r.u);
      expect(who).toContain(GM);
      expect(who).toContain(CHEF);
      expect(who).not.toContain(KEEPER);
    });
  });
});

describe('withdrawing a request', () => {
  it('whoever asked withdraws it until it is ordered, never after', async () => {
    await inRolledBackTx(async (c) => {
      const { po, items } = await request(c);
      await release(c, po);
      expect(await error(c, GM, `select inv.withdraw_request($1)`, [po])).toMatch(/NOT_AUTHORISED/);
      expect(await error(c, KEEPER, `select inv.withdraw_request($1)`, [po])).toMatch(
        /NOT_AUTHORISED/,
      );
      await call(c, CHEF, `select inv.withdraw_request($1, 'not needed')`, [po]);
      expect(await progress(c, po)).toBe('withdrawn');
      const desk = await call<{ po_id: string }>(c, KEEPER, `select po_id from inv.desk_orders()`);
      expect(desk.map((d) => d.po_id)).not.toContain(po);
      expect(await error(c, KEEPER, `select inv.place_order($1, '[]'::jsonb)`, [po])).toBeDefined();

      const other = await request(c);
      await release(c, other.po);
      await place(c, other.po, other.items);
      expect(await error(c, CHEF, `select inv.withdraw_request($1)`, [other.po])).toMatch(
        /INVALID_STATE/,
      );
      void items;
    });
  });

  it('a request waiting for approval leaves the approver’s list', async () => {
    await inRolledBackTx(async (c) => {
      // Test Bar 3.0's head cook asks for napkins, in no recipe: the Bar Manager approves it
      const store = ids.node('TEST-BAR-3.0-KITCHEN-STORE');
      const napkins = (
        await c.query<{ id: string }>(
          `select id from inv.item where sku = 'PAPER-NAPKINS-PACK-OF-100'
                                         and tenant_id = (select tenant_id from core.hierarchy_node
                                                           where id = $1)`,
          [store],
        )
      ).rows[0]!.id;
      const [r] = await call<{ id: string }>(
        c,
        HEAD_COOK,
        `select inv.request_supplies($1, $2::jsonb, null) as id`,
        [store, JSON.stringify([{ item_id: napkins, qty: 5 }])],
      );
      const po = r!.id;
      const before = (
        await c.query<{ state: string; r: string }>(
          `select q.state, q.id as r from inv.purchase_order p join wf.request q on q.id = p.wf_request_id
            where p.id = $1`,
          [po],
        )
      ).rows[0]!;
      expect(before.state).toBe('in_approval');
      expect(await error(c, BAR_MANAGER, `select inv.withdraw_request($1)`, [po])).toMatch(
        /NOT_AUTHORISED/,
      );
      await call(c, HEAD_COOK, `select inv.withdraw_request($1)`, [po]);
      const after = await c.query<{ state: string }>(`select state from wf.request where id = $1`, [
        before.r,
      ]);
      expect(after.rows[0]!.state).toBe('cancelled');
      expect(await progress(c, po)).toBe('withdrawn');
      const inbox = await call<{ request_id: string }>(
        c,
        BAR_MANAGER,
        `select request_id from wf.my_inbox()`,
      );
      expect(inbox.map((x) => x.request_id)).not.toContain(before.r);
    });
  });
});

describe('the order desk sends the order it placed', () => {
  it('records and reads the sends; another outlet may not', async () => {
    await inRolledBackTx(async (c) => {
      const { po, items } = await request(c);
      await release(c, po);
      await place(c, po, items);
      await call(c, KEEPER, `select inv.record_po_send($1, 'whatsapp')`, [po]);
      const sends = await call<{ channel: string }>(c, KEEPER, `select * from inv.po_sends($1)`, [
        po,
      ]);
      expect(sends.map((s) => s.channel)).toEqual(['whatsapp']);
      expect(await error(c, OUTSIDER, `select inv.record_po_send($1, 'email')`, [po])).toMatch(
        /NOT_AUTHORISED/,
      );
      expect(await error(c, OUTSIDER, `select * from inv.po_sends($1)`, [po])).toMatch(
        /NOT_AUTHORISED/,
      );
    });
  });
});
