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

// Vendor bills (BIL-1 to BIL-3, ADR 050). Test Hotel 1.0: the store keeper keeps the Main
// Store (the order desk), the executive chef the Kitchen store; the GM and the cost controller
// hold the supply point and everything below it.

const KEEPER = 'test.store-keeper.1.0';
const CHEF = 'test.executive-chef.1.0';
const GM = 'test.general-manager.1.0';
const COST = 'test.cost-controller.1.0';
const ENGINEER = 'test.chief-engineer.1.0'; // a department head with no store
const OUTSIDER = 'test.bar-manager.3.0'; // another outlet
const SOLO = 'test.solo.bar-manager'; // another customer

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const main = () => ids.node('TEST-HOTEL-1.0-MAIN-STORE');
const kitchen = () => ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');
const today = () => new Date().toISOString().slice(0, 10);

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
const rows = async (c: PoolClient, who: string, text: string, params: unknown[] = []) => {
  const r = await attemptAs<Record<string, unknown>>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
};

const tenant = async (c: PoolClient, node: string) =>
  (
    await c.query<{ t: string }>(`select tenant_id as t from core.hierarchy_node where id = $1`, [
      node,
    ])
  ).rows[0]!.t;
const fileAt = async (c: PoolClient, node: string, ext = 'pdf') =>
  `bills/${await tenant(c, node)}/${node}/${crypto.randomUUID()}.${ext}`;

const ADD = `select inv.add_bill($1, $2, $3, $4, $5, $6::date, $7, $8, $9::text[], $10) as id`;

/** A service bill at the Main Store, by its keeper. */
async function serviceBill(c: PoolClient, key: string | null = null): Promise<string> {
  const f = await fileAt(c, main());
  const { id } = await call<{ id: string }>(c, KEEPER, ADD, [
    main(),
    null,
    null,
    'Clean Linen Co',
    'LW-118',
    today(),
    4250.5,
    'Linen washing, week 40',
    [f],
    key,
  ]);
  return id;
}

/** A supply request from the kitchen, ordered by the Main Store's keeper (ADR 049). */
async function orderedRequest(c: PoolClient, place = true): Promise<string> {
  const its = (
    await c.query<{ id: string }>(
      `select item_id as id from inv.item_node where delivery_node_id = $1 and archived_at is null
        order by item_id limit 1`,
      [kitchen()],
    )
  ).rows.map((r) => r.id);
  const { id } = await call<{ id: string }>(
    c,
    CHEF,
    `select inv.request_supplies($1, $2::jsonb, null) as id`,
    [kitchen(), JSON.stringify([{ item_id: its[0], qty: 2 }])],
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
  if (place) {
    const s = (
      await c.query<{ id: string }>(
        `insert into inv.supplier (tenant_id, name)
         select tenant_id, 'Veg Supplier' from core.hierarchy_node where id = $1 returning id`,
        [kitchen()],
      )
    ).rows[0]!.id;
    await call(c, KEEPER, `select inv.place_order($1, $2::jsonb)`, [
      id,
      JSON.stringify([
        { supplier_id: s, expected_on: today(), lines: its.map((item_id) => ({ item_id })) },
      ]),
    ]);
  }
  return id;
}

describe('service bills (BIL-2)', () => {
  it('a store keeper records one at their store; the GM and the cost controller see it', async () => {
    await inRolledBackTx(async (c) => {
      const id = await serviceBill(c);
      const row = (
        await c.query<Record<string, unknown>>(
          `select kind, supplier_id, supplier_name, amount, po_id from inv.bill where id = $1`,
          [id],
        )
      ).rows[0];
      expect(row).toEqual({
        kind: 'service',
        supplier_id: null,
        supplier_name: 'Clean Linen Co',
        amount: '4250.50',
        po_id: null,
      });
      for (const who of [KEEPER, GM, COST]) {
        expect(await rows(c, who, `select id from inv.bill where id = $1`, [id])).toHaveLength(1);
        const d = await call<{ supplier: string; can_archive: boolean }>(
          c,
          who,
          `select supplier, can_archive from inv.bill_detail($1)`,
          [id],
        );
        expect(d.supplier).toBe('Clean Linen Co');
        expect(d.can_archive).toBe(who !== COST);
      }
    });
  });

  it('is hidden from people without bills there, in the outlet and outside it', async () => {
    await inRolledBackTx(async (c) => {
      const id = await serviceBill(c);
      for (const who of [CHEF, ENGINEER, OUTSIDER, SOLO]) {
        expect(await rows(c, who, `select id from inv.bill where id = $1`, [id])).toEqual([]);
        expect(await rows(c, who, `select * from inv.bill_detail($1)`, [id])).toEqual([]);
      }
    });
  });

  it('only people with bills there can add one; never by writing the table', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fileAt(c, main());
      const args = [main(), null, null, 'Pest Co', null, today(), 900, 'Pest control', [f], null];
      for (const who of [CHEF, COST, ENGINEER, OUTSIDER, SOLO]) {
        expect(await error(c, who, ADD, args)).toMatch(/NOT_AUTHORISED/);
      }
      expect(
        await error(
          c,
          KEEPER,
          `insert into inv.bill (tenant_id, delivery_node_id, kind, supplier_name, bill_date,
                                 amount, description, files)
           select tenant_id, id, 'service', 'X', current_date, 1, 'x', array['x']
             from core.hierarchy_node where id = $1`,
          [main()],
        ),
      ).toMatch(/NOT_AUTHORISED|permission denied/);
    });
  });

  it('checks the supplier, what it was for, the date, the amount and the files', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fileAt(c, main());
      const add = (over: Partial<Record<number, unknown>>) => {
        const a: unknown[] = [
          main(),
          null,
          null,
          'Pest Co',
          null,
          today(),
          900,
          'Pest control',
          [f],
          null,
        ];
        for (const [i, v] of Object.entries(over)) a[Number(i)] = v;
        return error(c, KEEPER, ADD, a);
      };
      expect(await add({ 3: ' ' })).toMatch(/INVALID_SUPPLIER/);
      expect(await add({ 7: null })).toMatch(/INVALID_BILL/);
      expect(await add({ 5: '2099-01-01' })).toMatch(/INVALID_BILL/);
      expect(await add({ 6: 0 })).toMatch(/INVALID_BILL/);
      expect(await add({ 8: [] })).toMatch(/INVALID_FILE/);
      expect(await add({ 8: [f, f] })).toMatch(/INVALID_FILE/);
      const t = await tenant(c, main());
      const six = [1, 2, 3, 4, 5, 6].map(() => `bills/${t}/${main()}/${crypto.randomUUID()}.pdf`);
      expect(await add({ 8: six })).toMatch(/INVALID_FILE/);
      // a key under another store, or a type that is not a photo or PDF
      expect(await add({ 8: [await fileAt(c, kitchen())] })).toMatch(/INVALID_FILE/);
      expect(await add({ 8: [await fileAt(c, main(), 'exe')] })).toMatch(/INVALID_FILE/);
      expect(await add({})).toBeUndefined();
    });
  });

  it('a replay returns the same bill', async () => {
    await inRolledBackTx(async (c) => {
      const a = await serviceBill(c, 'bill-key-1');
      const b = await serviceBill(c, 'bill-key-1');
      expect(b).toBe(a);
    });
  });
});

describe('bills for goods (BIL-1)', () => {
  it('the order desk attaches one to a supply request; the department and the GM see it', async () => {
    await inRolledBackTx(async (c) => {
      const po = await orderedRequest(c);
      // the bill goes to the order's store, whoever adds it
      const place = await call<{ n: string }>(c, KEEPER, `select inv.bill_place(null, $1) as n`, [
        po,
      ]);
      expect(place.n).toBe(kitchen());
      const f = await fileAt(c, kitchen(), 'jpg');
      const { id } = await call<{ id: string }>(c, KEEPER, ADD, [
        null,
        po,
        null,
        null,
        'INV-77',
        today(),
        180,
        null,
        [f],
        null,
      ]);
      const b = (
        await c.query<{ kind: string; supplier_id: string | null; delivery_node_id: string }>(
          `select kind, supplier_id, delivery_node_id from inv.bill where id = $1`,
          [id],
        )
      ).rows[0]!;
      expect(b.kind).toBe('goods');
      expect(b.supplier_id).not.toBeNull(); // the order's supplier
      expect(b.delivery_node_id).toBe(kitchen());
      for (const who of [KEEPER, CHEF, GM, COST]) {
        const list = await rows(c, who, `select id, bill_no from inv.po_bills($1)`, [po]);
        expect(list).toEqual([{ id, bill_no: 'INV-77' }]);
      }
      for (const who of [ENGINEER, OUTSIDER]) {
        expect(await rows(c, who, `select id from inv.po_bills($1)`, [po])).toEqual([]);
      }
    });
  });

  it('needs the order to have been placed, and someone who receives it', async () => {
    await inRolledBackTx(async (c) => {
      const po = await orderedRequest(c, false);
      expect(await error(c, KEEPER, `select inv.bill_place(null, $1)`, [po])).toMatch(
        /INVALID_STATE/,
      );
      const placed = await orderedRequest(c);
      for (const who of [COST, ENGINEER, OUTSIDER]) {
        expect(await error(c, who, `select inv.bill_place(null, $1)`, [placed])).toMatch(
          /NOT_AUTHORISED/,
        );
      }
    });
  });
});

describe('archiving a wrong bill', () => {
  it('whoever added it, with a reason; it leaves the order and cannot be archived twice', async () => {
    await inRolledBackTx(async (c) => {
      const id = await serviceBill(c);
      expect(await error(c, OUTSIDER, `select inv.archive_bill($1, 'wrong')`, [id])).toMatch(
        /NOT_AUTHORISED/,
      );
      expect(await error(c, COST, `select inv.archive_bill($1, 'wrong')`, [id])).toMatch(
        /NOT_AUTHORISED/,
      );
      expect(await error(c, KEEPER, `select inv.archive_bill($1, ' ')`, [id])).toMatch(
        /INVALID_BILL/,
      );
      await call(c, KEEPER, `select inv.archive_bill($1, 'Duplicate of LW-117')`, [id]);
      expect(await error(c, GM, `select inv.archive_bill($1, 'again')`, [id])).toMatch(
        /INVALID_STATE/,
      );
      const d = await call<{ archive_reason: string; can_archive: boolean }>(
        c,
        GM,
        `select archive_reason, can_archive from inv.bill_detail($1)`,
        [id],
      );
      expect(d).toEqual({ archive_reason: 'Duplicate of LW-117', can_archive: false });
    });
  });
});

describe('the Bills screen', () => {
  it('lists the stores where the person holds bills', async () => {
    await inRolledBackTx(async (c) => {
      const places = async (who: string) =>
        (await rows(c, who, `select id from core.screen_places('bills')`)).map((r) => r.id);
      expect(await places(KEEPER)).toContain(main());
      expect(await places(CHEF)).toEqual([kitchen()]);
      expect(await places(GM)).toEqual(expect.arrayContaining([main(), kitchen()]));
      expect(await places(COST)).toEqual(expect.arrayContaining([main(), kitchen()]));
      expect(await places(ENGINEER)).toEqual([]);
    });
  });
});
