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

// Supply requests (ADR 049): the person who needs supplies asks for items and quantities, the
// main store's keeper picks suppliers and dates, the department hears at each step.
// Test Hotel 1.0: the chef keeps the Kitchen store, the store keeper the Main Store.

const CHEF = 'test.executive-chef.1.0'; // keeper of the Kitchen store, raises the request
const KEEPER = 'test.store-keeper.1.0'; // keeper of the Main Store: the order desk
const GM = 'test.general-manager.1.0';
const OUTSIDER = 'test.bar-manager.3.0'; // another outlet

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const kitchen = () => ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');

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
const error = async (c: PoolClient, who: string, text: string, params: unknown[] = []) =>
  (await attemptAs(c, ids.user(who), text, params)).error;

const items = async (c: PoolClient, n: number): Promise<string[]> =>
  (
    await c.query<{ id: string }>(
      `select item_id as id from inv.item_node where delivery_node_id = $1 and archived_at is null
        order by item_id limit $2`,
      [kitchen(), n],
    )
  ).rows.map((r) => r.id);

/** Raise a request as the chef, approve it if it needed the department head, and release it. */
async function raised(c: PoolClient, qtys: number[]): Promise<{ po: string; items: string[] }> {
  const its = await items(c, qtys.length);
  const { id } = await call<{ id: string }>(
    c,
    CHEF,
    `select inv.request_supplies($1, $2::jsonb, 'for the weekend') as id`,
    [kitchen(), JSON.stringify(its.map((item_id, i) => ({ item_id, qty: qtys[i] })))],
  );
  const { rows } = await c.query<{ r: string; state: string }>(
    `select p.wf_request_id as r, q.state from inv.purchase_order p
       join wf.request q on q.id = p.wf_request_id where p.id = $1`,
    [id],
  );
  if (rows[0]!.state !== 'approved') {
    await call(c, GM, `select wf.act($1, 'approve')`, [rows[0]!.r]);
  }
  await c.query(`update wf.request set state = 'executing' where id = $1 and state = 'approved'`, [
    rows[0]!.r,
  ]);
  await actAs(c, 'wf_executor', null);
  await c.query('select inv.execute($1, $2)', ['inv.po.release', rows[0]!.r]);
  await resetRole(c);
  return { po: id, items: its };
}

const supplier = async (c: PoolClient, name: string): Promise<string> =>
  (
    await c.query<{ id: string }>(
      `insert into inv.supplier (tenant_id, name)
       select tenant_id, $1 from core.hierarchy_node where id = $2 returning id`,
      [name, kitchen()],
    )
  ).rows[0]!.id;

const tomorrow = '(current_date + 1)::text';
const notes = async (c: PoolClient, who: string) =>
  (
    await c.query<{ title: string }>(
      `select title from ops.notification where owner_user_id = $1 order by created_at, id`,
      [ids.user(who)],
    )
  ).rows.map((r) => r.title);

describe('raising a supply request', () => {
  it('needs no supplier and no price, and waits for the order desk once approved', async () => {
    await inRolledBackTx(async (c) => {
      const { po } = await raised(c, [1, 2]);
      const row = await c.query(
        `select supplier_id, status, ordered_at, progress from inv.purchase_order_summary where id = $1`,
        [po],
      );
      expect(row.rows[0]).toMatchObject({
        supplier_id: null,
        status: 'released',
        ordered_at: null,
        progress: 'to_order',
      });
      // the Main Store's keeper is told, and sees it in the desk list; the chef is not the desk
      expect((await notes(c, KEEPER)).some((t) => t.startsWith('Place an order for'))).toBe(true);
      const desk = await call<{ n: string }>(
        c,
        KEEPER,
        `select count(*) as n from inv.desk_orders() where po_id = $1 and stage = 'to_order'`,
        [po],
      );
      expect(desk.n).toBe('1');
    });
  });

  it('has no value limit and no area manager step', async () => {
    await inRolledBackTx(async (c) => {
      const its = await items(c, 1);
      const { id } = await call<{ id: string }>(
        c,
        CHEF,
        `select inv.request_supplies($1, $2::jsonb) as id`,
        [kitchen(), JSON.stringify([{ item_id: its[0], qty: 1 }])],
      );
      const steps = await c.query<{ step: string }>(
        `select step from wf.step_instance si join inv.purchase_order p on p.wf_request_id = si.request_id
          where p.id = $1`,
        [id],
      );
      expect(steps.rows.map((r) => r.step)).toEqual(['department_approval']);
    });
  });
});

describe('placing the order', () => {
  it('one supplier for everything: ordered, the department told, receivable', async () => {
    await inRolledBackTx(async (c) => {
      const { po, items: its } = await raised(c, [1, 2]);
      const s = await supplier(c, 'One Supplier');
      const ids2 = await call<{ ids: string[] }>(
        c,
        KEEPER,
        `select inv.place_order($1, $2::jsonb) as ids`,
        [
          po,
          JSON.stringify([
            {
              supplier_id: s,
              expected_on: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
              lines: its.map((item_id) => ({ item_id, unit_cost: 12.5 })),
            },
          ]),
        ],
      );
      expect(ids2.ids).toEqual([po]);
      const row = await c.query(
        `select supplier_id, progress, total from inv.purchase_order_summary where id = $1`,
        [po],
      );
      expect(row.rows[0]).toMatchObject({ supplier_id: s, progress: 'released', total: '37.50' });
      expect(await notes(c, CHEF)).toContain('Your supply request was ordered');
      // placing twice answers with what is placed
      const again = await call<{ ids: string[] }>(
        c,
        KEEPER,
        `select inv.place_order($1, $2::jsonb) as ids`,
        [
          po,
          JSON.stringify([
            { expected_on: '2099-01-01', lines: its.map((item_id) => ({ item_id })) },
          ]),
        ],
      );
      expect(again.ids).toEqual([po]);

      // the desk receives; the department is told, in full
      await call(c, KEEPER, `select inv.receive($1, $2::jsonb)`, [
        po,
        JSON.stringify([
          { item_id: its[0], qty: 1 },
          { item_id: its[1], qty: 2 },
        ]),
      ]);
      expect(
        (await c.query(`select progress from inv.purchase_order_summary where id = $1`, [po]))
          .rows[0],
      ).toEqual({
        progress: 'received',
      });
      expect(await notes(c, CHEF)).toContain('Your supplies were received');
      const left = await call<{ n: string }>(
        c,
        KEEPER,
        `select count(*) as n from inv.desk_orders() where po_id = $1`,
        [po],
      );
      expect(left.n).toBe('0');
    });
  });

  it('several suppliers split the request into one order each; the supplier is optional', async () => {
    await inRolledBackTx(async (c) => {
      const { po, items: its } = await raised(c, [1, 2]);
      const s = await supplier(c, 'Veg Supplier');
      const d = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const out = await call<{ ids: string[] }>(
        c,
        KEEPER,
        `select inv.place_order($1, $2::jsonb) as ids`,
        [
          po,
          JSON.stringify([
            { supplier_id: s, expected_on: d, lines: [{ item_id: its[0] }] },
            { expected_on: d, lines: [{ item_id: its[1] }] }, // no supplier named
          ]),
        ],
      );
      expect(out.ids).toHaveLength(2);
      expect(out.ids[0]).toBe(po);
      const rows = await c.query<{ supplier_id: string | null; n: string }>(
        `select p.supplier_id, (select count(*) from inv.purchase_order_line l where l.po_id = p.id) as n
           from inv.purchase_order p where p.id = any($1::uuid[]) order by p.created_at, p.id`,
        [out.ids],
      );
      expect(rows.rows).toEqual([
        { supplier_id: s, n: '1' },
        { supplier_id: null, n: '1' },
      ]);
      // a part receipt tells the department what is still to come
      await call(c, KEEPER, `select inv.receive($1, $2::jsonb)`, [
        out.ids[0],
        JSON.stringify([{ item_id: its[0], qty: 1 }]),
      ]);
      expect(await notes(c, CHEF)).toContain('Your supplies were received');
    });
  });

  it('needs every item in exactly one order, and a date', async () => {
    await inRolledBackTx(async (c) => {
      const { po, items: its } = await raised(c, [1, 2]);
      const d = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const place = (groups: object[]) =>
        error(c, KEEPER, `select inv.place_order($1, $2::jsonb)`, [po, JSON.stringify(groups)]);
      expect(await place([{ expected_on: d, lines: [{ item_id: its[0] }] }])).toMatch(
        /INVALID_LINES/,
      );
      expect(
        await place([
          { expected_on: d, lines: [{ item_id: its[0] }, { item_id: its[1] }] },
          { expected_on: d, lines: [{ item_id: its[1] }] },
        ]),
      ).toMatch(/INVALID_LINES/);
      expect(await place([{ lines: its.map((item_id) => ({ item_id })) }])).toMatch(/INVALID_DATE/);
      expect(tomorrow).toBeTruthy();
    });
  });

  it('is for the order desk only', async () => {
    await inRolledBackTx(async (c) => {
      const { po, items: its } = await raised(c, [1]);
      const d = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const groups = JSON.stringify([{ expected_on: d, lines: [{ item_id: its[0] }] }]);
      for (const who of [CHEF, OUTSIDER]) {
        expect(await error(c, who, `select inv.place_order($1, $2::jsonb)`, [po, groups])).toMatch(
          /NOT_AUTHORISED/,
        );
      }
      // and an unordered request cannot be received, by anyone
      expect(
        await error(c, KEEPER, `select inv.receive($1, $2::jsonb)`, [
          po,
          JSON.stringify([{ item_id: its[0], qty: 1 }]),
        ]),
      ).toMatch(/INVALID_STATE/);
      const none = await call<{ n: string }>(
        c,
        OUTSIDER,
        `select count(*) as n from inv.desk_orders()`,
      );
      expect(none.n).toBe('0');
    });
  });
});
