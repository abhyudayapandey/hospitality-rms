import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The central kitchen's stock users work at the central kitchen store only (file 06,
// "(this store only)"). In the delivery tree the outlets' stores sit under that store, so
// "this place and everything below" would let them post stock at every hotel store.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const CK_STORE = 'TEST-CENTRAL-KITCHEN-STORE';
const HOTEL_KITCHEN = 'TEST-HOTEL-1.0-KITCHEN-STORE';

async function itemAt(c: PoolClient, store: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select item_id as id from inv.item_node where delivery_node_id = $1 order by item_id limit 1`,
    [ids.node(store)],
  );
  return rows[0]!.id;
}
async function sku(c: PoolClient, code: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id
      where t.code = 'TEST-COMPANY' and i.sku = $1`,
    [code],
  );
  return rows[0]!.id;
}
/** Every hotel stock location: main, kitchen, bar and housekeeping stores of both hotels. */
async function hotelStores(c: PoolClient): Promise<string[]> {
  const { rows } = await c.query<{ code: string }>(
    `select n.code from core.hierarchy_node n join core.tenant t on t.id = n.tenant_id
      where t.code = 'TEST-COMPANY' and n.type = 'delivery' and n.holds_stock
        and n.code like 'TEST-HOTEL-%' order by n.code`,
  );
  return rows.map((r) => r.code);
}

describe('the central kitchen chef works at the central kitchen store only', () => {
  const CHEF = 'test.central-kitchen-chef';

  it('cannot record production at the Hotel 1.0 kitchen store', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(c, ids.user(CHEF), 'select inv.record_production($1, $2, $3)', [
        ids.node(HOTEL_KITCHEN),
        await sku(c, 'GINGER-GARLIC-PASTE'),
        500,
      ]);
      expect(r.error).toBe('NOT_AUTHORISED');
    });
  });

  it('cannot record wastage at the Hotel 1.0 kitchen store', async () => {
    await inRolledBackTx(async (c) => {
      const lines = JSON.stringify([
        { item_id: await itemAt(c, HOTEL_KITCHEN), qty: 1, reason: 'spoiled' },
      ]);
      const r = await attemptAs(c, ids.user(CHEF), 'select inv.record_wastage($1, $2::jsonb)', [
        ids.node(HOTEL_KITCHEN),
        lines,
      ]);
      expect(r.error).toBe('NOT_AUTHORISED');
    });
  });

  it('still records production and wastage at the central kitchen store', async () => {
    await inRolledBackTx(async (c) => {
      const made = await attemptAs(c, ids.user(CHEF), 'select inv.record_production($1, $2, $3)', [
        ids.node(CK_STORE),
        await sku(c, 'MAKHANI-GRAVY'),
        1000,
      ]);
      expect(made.error).not.toBe('NOT_AUTHORISED');
      const lines = JSON.stringify([
        { item_id: await itemAt(c, CK_STORE), qty: 1, reason: 'spoiled' },
      ]);
      const wasted = await attemptAs(
        c,
        ids.user(CHEF),
        'select inv.record_wastage($1, $2::jsonb)',
        [ids.node(CK_STORE), lines],
      );
      expect(wasted.error).not.toBe('NOT_AUTHORISED');
    });
  });
});

describe('the central kitchen store keeper orders for the central kitchen store only', () => {
  const KEEPER = 'test.central-kitchen-store-keeper';

  it('cannot create a purchase order for any hotel store', async () => {
    await inRolledBackTx(async (c) => {
      const stores = await hotelStores(c);
      expect(stores.length).toBe(8);
      const { rows } = await c.query<{ id: string }>(
        `select s.id from inv.supplier s join core.tenant t on t.id = s.tenant_id
          where t.code = 'TEST-COMPANY' order by s.code limit 1`,
      );
      for (const store of stores) {
        const r = await attemptAs(c, ids.user(KEEPER), 'select inv.create_po($1, $2, $3::jsonb)', [
          ids.node(store),
          rows[0]!.id,
          JSON.stringify([{ item_id: await itemAt(c, store), qty: 1, unit_cost: 10 }]),
        ]);
        expect(r.error, store).toBe('NOT_AUTHORISED');
      }
    });
  });

  it('still creates one for the central kitchen store', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select s.id from inv.supplier s join core.tenant t on t.id = s.tenant_id
          where t.code = 'TEST-COMPANY' order by s.code limit 1`,
      );
      const r = await attemptAs(c, ids.user(KEEPER), 'select inv.create_po($1, $2, $3::jsonb)', [
        ids.node(CK_STORE),
        rows[0]!.id,
        JSON.stringify([{ item_id: await itemAt(c, CK_STORE), qty: 1, unit_cost: 10 }]),
      ]);
      expect(r.error).toBeUndefined();
    });
  });
});
