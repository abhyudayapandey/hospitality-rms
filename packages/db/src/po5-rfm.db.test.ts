import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Department heads are responsible for orders (PO-5) and for requests for material (TR-3),
// ADR 043. No approval for menu ingredients in usual quantities; the department head (or the
// GM, who is told of every order) approves anything off the menu or over 1.5x what the store
// uses in a week; the area manager step above the value threshold stays. Run as the seeded
// users inside rolled-back transactions.

const KIM = 'test.head-cook.3.0'; // head of Kitchen and keeper of its store
const OLIVIA = 'test.bar-manager.3.0'; // GM of Test Bar 3.0
const ARIA = 'test.area-manager';
const CASEY = 'test.cook.3.0'; // uses the Kitchen store
const OTHER_COMPANY = 'test.solo.bar-manager';
const CK_KEEPER = 'test.central-kitchen-store-keeper';

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const kitchen = () => ids.node(BAR3.store);
const hubStore = () => ids.node('TEST-CENTRAL-KITCHEN-STORE');

interface Fixture {
  store: string;
  tenant: string;
  supplier: string;
  item(sku: string): string;
}

/**
 * Items at the Kitchen store with a dish and its recipe on the outlet's menu: P5-ON is in
 * the recipe, P5-OFF is not. P5-ON has opening stock and (optionally) a week's worth of
 * use in the last four weeks: `weekly` units a week, as sales depletion.
 */
const BAR3 = { store: 'TEST-BAR-3.0-KITCHEN-STORE', outlet: 'TEST-BAR-3.0' };
const HOTEL1 = { store: 'TEST-HOTEL-1.0-KITCHEN-STORE', outlet: 'TEST-HOTEL-1.0' };

async function fixture(
  c: PoolClient,
  weekly: number | null,
  at: { store: string; outlet: string } = BAR3,
): Promise<Fixture> {
  const store = ids.node(at.store);
  const tenant = (
    await c.query<{ id: string }>('select tenant_id as id from core.hierarchy_node where id = $1', [
      store,
    ])
  ).rows[0]!.id;
  const supplier = (
    await c.query<{ id: string }>(
      `insert into inv.supplier (tenant_id, name) values ($1, 'P5 Supplier ' || core.uuid_v7())
       returning id`,
      [tenant],
    )
  ).rows[0]!.id;
  const map = new Map<string, string>();
  for (const sku of ['P5-ON', 'P5-OFF']) {
    const id = (
      await c.query<{ id: string }>(
        `insert into inv.item (tenant_id, sku, name, category, base_uom)
         values ($1, $2, 'Item ' || $2, 'Test', 'kg') returning id`,
        [tenant, sku],
      )
    ).rows[0]!.id;
    map.set(sku, id);
    await c.query(
      `insert into inv.item_node (tenant_id, item_id, delivery_node_id, preferred_supplier_id)
       values ($1, $2, $3, $4)`,
      [tenant, id, store, supplier],
    );
    // a central kitchen can supply it, so requests for material can be tested
    await c.query(
      `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                     unit_cost, ref_type)
       values ($1, $2, $3, 'receipt', 1000, 10, 'opening')`,
      [tenant, id, store],
    );
  }
  await c.query(
    `insert into inv.item_unit (tenant_id, item_id, recipe_unit, recipe_units_per_stock_unit)
     values ($1, $2, 'g', 1000)`,
    [tenant, map.get('P5-ON')],
  );
  const dish = (
    await c.query<{ id: string }>(
      `insert into menu.menu_item (tenant_id, code, name, menu, category, serving)
       values ($1, 'P5-DISH', 'P5 Dish', 'Food', 'Mains', 'plate') returning id`,
      [tenant],
    )
  ).rows[0]!.id;
  const outlet = ids.node(at.outlet);
  await c.query(
    `insert into menu.menu_outlet (tenant_id, menu_item_id, org_node_id, delivery_node_id, price,
                                   effective_from)
     values ($1, $2, $3, $4, 100, current_date - 30)`,
    [tenant, dish, outlet, store],
  );
  const recipe = (
    await c.query<{ id: string }>(
      `insert into inv.recipe (tenant_id, menu_item_id, version, effective_from)
       values ($1, $2, 1, current_date - 30) returning id`,
      [tenant, dish],
    )
  ).rows[0]!.id;
  await c.query(
    `insert into inv.recipe_line (tenant_id, recipe_id, line_no, ingredient_item_id, qty, unit)
     values ($1, $2, 1, $3, 100, 'g')`,
    [tenant, recipe, map.get('P5-ON')],
  );
  if (weekly !== null) {
    // four weeks of use, spread over the 28 days
    for (const day of [3, 10, 17, 24]) {
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                       unit_cost, ref_type, occurred_at)
         values ($1, $2, $3, 'sales_depletion', $4, 10, 'sales', now() - make_interval(days => $5))`,
        [tenant, map.get('P5-ON'), store, -weekly, day],
      );
    }
  }
  return {
    store,
    tenant,
    supplier,
    item(sku) {
      return map.get(sku)!;
    },
  };
}

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

const lines = (l: object[]) => JSON.stringify(l);

async function createPo(c: PoolClient, f: Fixture, who: string, items: Record<string, number>) {
  const l = Object.entries(items).map(([sku, qty]) => ({
    item_id: f.item(sku),
    qty,
    unit_cost: 10,
  }));
  const { id } = await call<{ id: string }>(
    c,
    who,
    `select inv.create_po($1, $2, $3::jsonb) as id`,
    [f.store, f.supplier, lines(l)],
  );
  const { rows } = await c.query<{ r: string; state: string }>(
    `select p.wf_request_id as r, q.state from inv.purchase_order p
       join wf.request q on q.id = p.wf_request_id where p.id = $1`,
    [id],
  );
  return { id, request: rows[0]!.r, state: rows[0]!.state };
}

const steps = async (c: PoolClient, request: string) =>
  (
    await c.query<{ step: string; state: string }>(
      `select step, state from wf.step_instance where request_id = $1 order by seq`,
      [request],
    )
  ).rows;

async function inbox(c: PoolClient, who: string): Promise<string[]> {
  const r = await attemptAs<{ request_id: string }>(
    c,
    ids.user(who),
    'select request_id from wf.my_inbox()',
  );
  if (r.error !== undefined) throw new Error(r.error);
  return r.rows.map((x) => x.request_id);
}

describe('PO-5: which orders need an approval', () => {
  it('has none for a menu ingredient in a usual quantity: approved at once', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10); // uses 10 kg a week
      const po = await createPo(c, f, OLIVIA, { 'P5-ON': 12 }); // under 1.5 x 10 = 15
      expect(po.state).toBe('approved');
      expect(await steps(c, po.request)).toEqual([
        { step: 'department_approval', state: 'skipped' },
        { step: 'area_approval', state: 'skipped' },
      ]);
    });
  });

  it('tells the GM of every order, but not the person who made it', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10);
      await createPo(c, f, KIM, { 'P5-ON': 12 });
      const gm = await c.query(
        `select 1 from ops.notification where owner_user_id = $1 and kind = 'order'`,
        [ids.user(OLIVIA)],
      );
      expect(gm.rowCount).toBe(1);
      const self = await c.query(
        `select 1 from ops.notification where owner_user_id = $1 and kind = 'order'`,
        [ids.user(KIM)],
      );
      expect(self.rowCount).toBe(0);
    });
  });

  it('sends an item that is in no recipe of the outlet to the department head', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10);
      const po = await createPo(c, f, OLIVIA, { 'P5-OFF': 1 });
      expect(po.state).toBe('in_approval');
      expect((await steps(c, po.request))[0]).toEqual({
        step: 'department_approval',
        state: 'pending',
      });
      expect(await inbox(c, KIM)).toContain(po.request);
    });
  });

  it('sends more than 1.5 x the weekly use to the department head', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10);
      const po = await createPo(c, f, OLIVIA, { 'P5-ON': 16 }); // over 15
      expect(po.state).toBe('in_approval');
      expect(await inbox(c, KIM)).toContain(po.request);
    });
  });

  it('has no usual quantity yet without four weeks of use: a menu item goes through, an off-menu one does not', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, null);
      const on = await createPo(c, f, OLIVIA, { 'P5-ON': 500 });
      expect(on.state).toBe('approved');
      const off = await createPo(c, f, OLIVIA, { 'P5-OFF': 1 });
      expect(off.state).toBe('in_approval');
    });
  });

  it('follows the company setting for the factor', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10);
      await c.query(
        `update core.tenant set settings = coalesce(settings, '{}') || '{"usual_qty_factor": 3}'
          where id = $1`,
        [f.tenant],
      );
      expect((await createPo(c, f, OLIVIA, { 'P5-ON': 25 })).state).toBe('approved'); // under 30
      expect((await createPo(c, f, OLIVIA, { 'P5-ON': 31 })).state).toBe('in_approval');
    });
  });

  it('keeps the area manager step above the value threshold, even for usual quantities', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10000);
      const l = [{ item_id: f.item('P5-ON'), qty: 6000, unit_cost: 10 }]; // 60,000, under 15,000? usual
      const { id } = await call<{ id: string }>(
        c,
        OLIVIA,
        `select inv.create_po($1, $2, $3::jsonb) as id`,
        [kitchen(), f.supplier, lines(l)],
      );
      const { rows } = await c.query<{ r: string }>(
        'select wf_request_id as r from inv.purchase_order where id = $1',
        [id],
      );
      expect(await steps(c, rows[0]!.r)).toEqual([
        { step: 'department_approval', state: 'skipped' },
        { step: 'area_approval', state: 'pending' },
      ]);
      expect(await inbox(c, ARIA)).toContain(rows[0]!.r);
    });
  });
});

describe('PO-5: who approves', () => {
  it('lets the department head approve, and the order is released', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10);
      const po = await createPo(c, f, OLIVIA, { 'P5-OFF': 1 });
      await call(c, KIM, `select wf.act($1, 'approve', null)`, [po.request]);
      const { rows } = await c.query<{ state: string }>(
        'select state from wf.request where id = $1',
        [po.request],
      );
      expect(rows[0]!.state).toBe('approved');
    });
  });

  it('lets the GM approve too, when the department head is away, but not an order they made themselves', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10);
      const made = await createPo(c, f, KIM, { 'P5-OFF': 1 }); // the head made it: routed to the GM
      expect(await inbox(c, OLIVIA)).toContain(made.request);
      expect(await error(c, KIM, `select wf.act($1, 'approve', null)`, [made.request])).toMatch(
        /SEGREGATION_OF_DUTIES|NOT_AUTHORISED/,
      );
      await call(c, OLIVIA, `select wf.act($1, 'approve', null)`, [made.request]);

      // an order the GM makes can be approved by the head, never by the GM
      const mine = await createPo(c, f, OLIVIA, { 'P5-OFF': 2 });
      expect(await error(c, OLIVIA, `select wf.act($1, 'approve', null)`, [mine.request])).toMatch(
        /SEGREGATION_OF_DUTIES|NOT_AUTHORISED/,
      );
    });
  });

  it('lets the GM approve an order that is waiting for the department head, who is not away', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10, HOTEL1);
      // the AGM makes it; the executive chef (head of Kitchen) is the approver, and the GM can too
      const po = await createPo(c, f, 'test.assistant-general-manager.1.0', { 'P5-OFF': 1 });
      expect(po.state).toBe('in_approval');
      expect(await inbox(c, 'test.executive-chef.1.0')).toContain(po.request);
      expect(await inbox(c, 'test.general-manager.1.0')).toContain(po.request);
      await call(c, 'test.general-manager.1.0', `select wf.act($1, 'approve', null)`, [po.request]);
      const { rows } = await c.query<{ state: string }>(
        'select state from wf.request where id = $1',
        [po.request],
      );
      expect(rows[0]!.state).toBe('approved');
    });
  });

  it('shows the order only to those who can approve it', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10);
      const po = await createPo(c, f, OLIVIA, { 'P5-OFF': 1 });
      expect(await inbox(c, KIM)).toContain(po.request);
      expect(await inbox(c, CASEY)).not.toContain(po.request);
      expect(await error(c, CASEY, `select wf.act($1, 'approve', null)`, [po.request])).toMatch(
        /NOT_AUTHORISED/,
      );
    });
  });

  it('does not show or let another company approve', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10);
      const po = await createPo(c, f, OLIVIA, { 'P5-OFF': 1 });
      expect(await inbox(c, OTHER_COMPANY)).not.toContain(po.request);
      expect(
        await error(c, OTHER_COMPANY, `select wf.act($1, 'approve', null)`, [po.request]),
      ).toBeDefined();
    });
  });
});

describe('TR-3: request for material', () => {
  /** An RFM: the Kitchen store asks the outlet's other store; here the central kitchen. */
  async function rfm(c: PoolClient, f: Fixture, who: string, qty: number, sku = 'P5-ON') {
    const { id } = await call<{ id: string }>(
      c,
      who,
      `select inv.request_transfer($1, $2, $3::jsonb) as id`,
      [hubStore(), kitchen(), lines([{ item_id: f.item(sku), qty }])],
    );
    const { rows } = await c.query<{ r: string; kind: string }>(
      'select wf_request_id as r, kind from inv.transfer where id = $1',
      [id],
    );
    return { id, request: rows[0]!.r, kind: rows[0]!.kind };
  }

  it('is a request from a store to a department’s store, and shows as one', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10);
      // the central kitchen stocks the items too
      for (const sku of ['P5-ON', 'P5-OFF']) {
        await c.query(
          `insert into inv.item_node (tenant_id, item_id, delivery_node_id) values ($1, $2, $3)`,
          [f.tenant, f.item(sku), hubStore()],
        );
        await c.query(
          `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                         unit_cost, ref_type)
           values ($1, $2, $3, 'receipt', 1000, 10, 'opening')`,
          [f.tenant, f.item(sku), hubStore()],
        );
      }
      const r = await rfm(c, f, KIM, 5);
      expect(r.kind).toBe('rfm');
      expect(await steps(c, r.request)).toEqual([
        { step: 'approval', state: 'skipped' },
        { step: 'dispatch', state: 'pending' },
        { step: 'receipt', state: 'waiting' },
      ]);
      expect(await inbox(c, CK_KEEPER)).toContain(r.request); // the store keeper issues it
    });
  });

  it('needs the department head for something off the menu or over the usual', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10);
      for (const sku of ['P5-ON', 'P5-OFF']) {
        await c.query(
          `insert into inv.item_node (tenant_id, item_id, delivery_node_id) values ($1, $2, $3)`,
          [f.tenant, f.item(sku), hubStore()],
        );
        await c.query(
          `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                         unit_cost, ref_type)
           values ($1, $2, $3, 'receipt', 1000, 10, 'opening')`,
          [f.tenant, f.item(sku), hubStore()],
        );
      }
      const off = await rfm(c, f, CASEY, 1, 'P5-OFF');
      expect((await steps(c, off.request))[0]).toEqual({ step: 'approval', state: 'pending' });
      expect(await inbox(c, KIM)).toContain(off.request);
      expect(await inbox(c, CK_KEEPER)).not.toContain(off.request); // not yet to issue
      const over = await rfm(c, f, CASEY, 16);
      expect((await steps(c, over.request))[0]).toEqual({ step: 'approval', state: 'pending' });
    });
  });

  it('is refused for people without access, and for another company', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10);
      expect(
        await error(c, OTHER_COMPANY, `select inv.request_transfer($1, $2, $3::jsonb)`, [
          hubStore(),
          kitchen(),
          lines([{ item_id: f.item('P5-ON'), qty: 1 }]),
        ]),
      ).toMatch(/NOT_AUTHORISED/);
    });
  });
});

describe('usual quantities', () => {
  it('lists what is unusual, and why, for the screens', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, 10);
      const r = await attemptAs<{ item_id: string; reason: string }>(
        c,
        ids.user(OLIVIA),
        `select item_id, reason from inv.unusual_lines($1, $2::jsonb) order by reason`,
        [
          kitchen(),
          lines([
            { item_id: f.item('P5-ON'), qty: 16 },
            { item_id: f.item('P5-OFF'), qty: 1 },
          ]),
        ],
      );
      expect(r.rows).toEqual([
        { item_id: f.item('P5-OFF'), reason: 'off_menu' },
        { item_id: f.item('P5-ON'), reason: 'over_usual' },
      ]);
    });
  });
});
