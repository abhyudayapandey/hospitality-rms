import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Store-level transfers (ADR 009, Prompt 7 item 6): between stores of one outlet and from
// the central kitchen to an outlet's store. Dispatch and receipt go to whoever runs the
// sending and the receiving location (store keeper, hub manager, outlet manager, account
// owner), looked up within that location's own outlet or hub.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function as<T extends object>(c: PoolClient, who: string, sql: string, params: unknown[]) {
  const r = await attemptAs<T>(c, ids.user(who), sql, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows[0]!;
}

async function item(c: PoolClient, sku: string, customer = 'TEST-COMPANY'): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id
      where t.code = $1 and i.sku = $2`,
    [customer, sku],
  );
  return rows[0]!.id;
}

async function onHand(c: PoolClient, itemId: string, place: string): Promise<number> {
  const { rows } = await c.query<{ q: string }>(
    `select coalesce(sum(qty), 0) as q from inv.stock_ledger
      where item_id = $1 and delivery_node_id = $2`,
    [itemId, ids.node(place)],
  );
  return Number(rows[0]!.q);
}

async function request(c: PoolClient, who: string, from: string, to: string, itemId: string) {
  const r = await attemptAs<{ id: string }>(
    c,
    ids.user(who),
    'select inv.request_transfer($1, $2, $3::jsonb) as id',
    [ids.node(from), ids.node(to), JSON.stringify([{ item_id: itemId, qty: 2 }])],
  );
  return r;
}

/** Each step: the group and place it went to. */
async function route(c: PoolClient, transfer: string) {
  const { rows } = await c.query<{ step: string; grp: string; place: string }>(
    `select s.step, g.code as grp, n.code as place
       from inv.transfer t join wf.step_instance s on s.request_id = t.wf_request_id
       join core.security_group g on g.id = s.assignee_group_id
       join core.hierarchy_node n on n.id = s.scope_node_id
      where t.id = $1 order by s.seq`,
    [transfer],
  );
  return rows;
}

const DISPATCH = `select inv.dispatch_transfer($1) as s`;
const RECEIVE = `select inv.receive_transfer($1) as s`;

describe('between stores of the same outlet', () => {
  it('Main Store to Kitchen Store: the main store keeper sends, the kitchen store keeper receives', async () => {
    await inRolledBackTx(async (c) => {
      const rice = await item(c, 'BASMATI-RICE');
      const main = await onHand(c, rice, 'TEST-HOTEL-1.0-MAIN-STORE');
      const kitchen = await onHand(c, rice, 'TEST-HOTEL-1.0-KITCHEN-STORE');
      const r = await request(
        c,
        'test.sous-chef.1.0',
        'TEST-HOTEL-1.0-MAIN-STORE',
        'TEST-HOTEL-1.0-KITCHEN-STORE',
        rice,
      );
      expect(r.error).toBeUndefined();
      const t = r.rows![0]!.id;
      expect(await route(c, t)).toEqual([
        { step: 'dispatch', grp: 'STORE_KEEPER', place: 'TEST-HOTEL-1.0-MAIN-STORE' },
        { step: 'receipt', grp: 'STORE_KEEPER', place: 'TEST-HOTEL-1.0-KITCHEN-STORE' },
      ]);
      // the kitchen's keeper cannot dispatch from the main store, nor the GM (not their step)
      for (const who of ['test.executive-chef.1.0', 'test.general-manager.1.0']) {
        expect((await attemptAs(c, ids.user(who), DISPATCH, [t])).error, who).toBe(
          'NOT_AUTHORISED',
        );
      }
      await as(c, 'test.store-keeper.1.0', DISPATCH, [t]);
      expect((await attemptAs(c, ids.user('test.store-keeper.1.0'), RECEIVE, [t])).error).toBe(
        'NOT_AUTHORISED',
      );
      expect((await as<{ s: string }>(c, 'test.executive-chef.1.0', RECEIVE, [t])).s).toBe(
        'approved',
      );
      expect(await onHand(c, rice, 'TEST-HOTEL-1.0-MAIN-STORE')).toBeCloseTo(main - 2);
      expect(await onHand(c, rice, 'TEST-HOTEL-1.0-KITCHEN-STORE')).toBeCloseTo(kitchen + 2);
    });
  });

  it('offers only its own outlet’s stores and the central kitchen as sources', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs<{ id: string }>(
        c,
        ids.user('test.sous-chef.1.0'),
        'select id from inv.transfer_sources($1)',
        [ids.node('TEST-HOTEL-1.0-KITCHEN-STORE')],
      );
      expect(r.rows!.map((x) => x.id)).toEqual(
        [
          'TEST-HOTEL-1.0-BAR-STORE',
          'TEST-HOTEL-1.0-HOUSEKEEPING-STORE',
          'TEST-HOTEL-1.0-MAIN-STORE',
          'TEST-CENTRAL-KITCHEN-STORE',
        ].map((code) => ids.node(code)),
      );
      const rice = await item(c, 'BASMATI-RICE');
      for (const from of ['TEST-HOTEL-1.1-MAIN-STORE', 'TEST-GUEST-HOUSE-2.0-SUPPLY']) {
        const other = await request(
          c,
          'test.sous-chef.1.0',
          from,
          'TEST-HOTEL-1.0-KITCHEN-STORE',
          rice,
        );
        expect(other.error, from).toBe('INVALID_SUBJECT');
      }
    });
  });
});

describe('central kitchen to an outlet', () => {
  it('the central kitchen store keeper sends; the Guest House (no store keeper) receives via its GM', async () => {
    await inRolledBackTx(async (c) => {
      const chicken = await item(c, 'CHICKEN-BREAST');
      const r = await request(
        c,
        'test.cook.2.0',
        'TEST-CENTRAL-KITCHEN-STORE',
        'TEST-GUEST-HOUSE-2.0-SUPPLY',
        chicken,
      );
      expect(r.error).toBeUndefined();
      const t = r.rows![0]!.id;
      expect(await route(c, t)).toEqual([
        { step: 'dispatch', grp: 'STORE_KEEPER', place: 'TEST-CENTRAL-KITCHEN-STORE' },
        { step: 'receipt', grp: 'OUTLET_MANAGER', place: 'TEST-GUEST-HOUSE-2.0-SUPPLY' },
      ]);
      await as(c, 'test.central-kitchen-store-keeper', DISPATCH, [t]);
      expect((await as<{ s: string }>(c, 'test.general-manager.2.0', RECEIVE, [t])).s).toBe(
        'approved',
      );
    });
  });

  it('the central kitchen store keeper never runs an outlet’s store', async () => {
    await inRolledBackTx(async (c) => {
      // the keeper's grant includes the outlets below the hub, but receipt stays in the outlet
      const rice = await item(c, 'BASMATI-RICE');
      const r = await request(
        c,
        'test.sous-chef.1.0',
        'TEST-CENTRAL-KITCHEN-STORE',
        'TEST-HOTEL-1.0-KITCHEN-STORE',
        rice,
      );
      const t = r.rows![0]!.id;
      expect((await route(c, t))[1]).toEqual({
        step: 'receipt',
        grp: 'STORE_KEEPER',
        place: 'TEST-HOTEL-1.0-KITCHEN-STORE',
      });
      await as(c, 'test.central-kitchen-store-keeper', DISPATCH, [t]);
      expect(
        (await attemptAs(c, ids.user('test.central-kitchen-store-keeper'), RECEIVE, [t])).error,
      ).toBe('NOT_AUTHORISED');
      const inbox = await attemptAs<{ request_id: string }>(
        c,
        ids.user('test.central-kitchen-store-keeper'),
        'select request_id from wf.my_inbox()',
      );
      expect(inbox.rows!.length).toBe(0);
    });
  });
});

describe('fallback to the account owner', () => {
  it('Solo Bar: with no one else to receive, the owner does, without any stock rights', async () => {
    await inRolledBackTx(async (c) => {
      const owner = 'test.solo.bar-manager';
      // the owner is only the account owner here: no outlet manager assignment
      await c.query(
        `delete from core.role_assignment ra using core.security_group g
          where g.id = ra.group_id and g.code <> 'ACCOUNT_OWNER' and ra.user_id = $1`,
        [ids.user(owner)],
      );
      const lemons = await item(c, 'LEMONS', 'TEST-SOLO-COMPANY');
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                       unit_cost, ref_type)
         select tenant_id, $1, $2, 'receipt', 10, 5, 'test' from inv.item where id = $1`,
        [lemons, ids.node('TEST-SOLO-BAR-BAR-STORE')],
      );
      // the head cook runs the kitchen store and asks for it, so cannot receive it (rule 7)
      const r = await request(
        c,
        'test.solo.head-cook',
        'TEST-SOLO-BAR-BAR-STORE',
        'TEST-SOLO-BAR-KITCHEN-STORE',
        lemons,
      );
      expect(r.error).toBeUndefined();
      const t = r.rows![0]!.id;
      expect((await route(c, t)).map((s) => [s.step, s.grp])).toEqual([
        ['dispatch', 'STORE_KEEPER'],
        ['receipt', 'ACCOUNT_OWNER'],
      ]);
      const can = await attemptAs<{ ok: boolean }>(
        c,
        ids.user(owner),
        `select core.can('TRANSFERS', 'view', null, $1) as ok`,
        [ids.node('TEST-SOLO-BAR-KITCHEN-STORE')],
      );
      expect(can.rows![0]!.ok).toBe(false);
      await as(c, 'test.solo.head-bartender', DISPATCH, [t]);
      // pending for them: the owner sees the transfer, receives it, then no longer sees it
      const sees = async () =>
        (await attemptAs(c, ids.user(owner), 'select id from inv.transfer where id = $1', [t]))
          .rows!.length;
      expect(await sees()).toBe(1);
      expect((await as<{ s: string }>(c, owner, RECEIVE, [t])).s).toBe('approved');
      expect(await sees()).toBe(0);
      expect(await onHand(c, lemons, 'TEST-SOLO-BAR-KITCHEN-STORE')).toBeGreaterThanOrEqual(2);
    });
  });
});
