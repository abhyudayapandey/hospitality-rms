import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Any discard tells the GM (NT-2, ADR 033): every wastage recorded at a store notifies the
// outlet managers of the store's outlet (OUTLET_MANAGER there: the General Manager and the
// Assistant GM; a standalone bar's Bar Manager), whether it posts at once or waits for
// approval. Since ADR 092 the head of the store's department is told too (the Executive Chef
// for the kitchen store). Nobody else is told, and never the person who recorded it.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const KITCHEN = 'TEST-HOTEL-1.0-KITCHEN-STORE';

async function item(c: PoolClient, store: string, name: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select i.id from inv.item i join inv.stock_level s on s.item_id = i.id
      where s.delivery_node_id = $1 and i.name = $2 and s.on_hand > 0`,
    [ids.node(store), name],
  );
  expect(rows, name).toHaveLength(1);
  return rows[0]!.id;
}

/** Who was notified of wastage since the transaction began (now() is its start). */
async function told(
  c: PoolClient,
): Promise<{ username: string; title: string; body: string; link: string }[]> {
  const { rows } = await c.query<{ username: string; title: string; body: string; link: string }>(
    `select u.username, n.title, n.body, n.link from ops.notification n
       join core.app_user u on u.id = n.owner_user_id
      where n.kind = 'wastage' and n.created_at >= now()
      order by u.username`,
  );
  return rows;
}

const record = (c: PoolClient, user: string, store: string, lines: object[]) =>
  attemptAs<{ id: string }>(c, ids.user(user), 'select inv.record_wastage($1, $2::jsonb) as id', [
    ids.node(store),
    JSON.stringify(lines),
  ]);

describe('wastage notifies the GM (NT-2)', () => {
  it('a small discard posts and tells the outlet’s managers (its department head recorded it)', async () => {
    await inRolledBackTx(async (c) => {
      const paste = await item(c, KITCHEN, 'Ginger Garlic Paste');
      const r = await record(c, 'test.executive-chef.1.0', KITCHEN, [
        { item_id: paste, qty: 10, reason: 'spoiled' },
      ]);
      expect(r.error).toBeUndefined();
      const got = await told(c);
      expect(got.map((n) => n.username)).toEqual([
        'test.assistant-general-manager.1.0',
        'test.general-manager.1.0',
      ]);
      expect(got[0]!.title).toBe('Wastage at Test Hotel & Bar 1.0 – Kitchen Store');
      expect(got[0]!.body).toContain('Ginger Garlic Paste');
      expect(got[0]!.body).toContain('Spoiled');
      expect(got[0]!.body).toContain('Test Executive Chef 1.0');
      expect(got[0]!.link).toBe('/stock/wastage');
    });
  });

  it('a discard that waits for approval also tells them', async () => {
    await inRolledBackTx(async (c) => {
      const paste = await item(c, KITCHEN, 'Ginger Garlic Paste');
      await c.query(
        `insert into inv.node_setting (tenant_id, delivery_node_id, wastage_approval_value)
         values ($1, $2, 1)
         on conflict (tenant_id, delivery_node_id) do update set wastage_approval_value = 1`,
        [ids.tenant(), ids.node(KITCHEN)],
      );
      const photo = `wastage/${ids.tenant()}/${ids.node(KITCHEN)}/${crypto.randomUUID()}.jpg`;
      const r = await record(c, 'test.sous-chef.1.0', KITCHEN, [
        { item_id: paste, qty: 100, reason: 'expired', photo_key: photo },
      ]);
      expect(r.error).toBeUndefined();
      expect((await told(c)).map((n) => n.username)).toEqual([
        'test.assistant-general-manager.1.0',
        'test.executive-chef.1.0',
        'test.general-manager.1.0',
      ]);
    });
  });

  it('the GM who records it is not told about their own discard', async () => {
    await inRolledBackTx(async (c) => {
      const paste = await item(c, KITCHEN, 'Ginger Garlic Paste');
      const r = await record(c, 'test.general-manager.1.0', KITCHEN, [
        { item_id: paste, qty: 5, reason: 'damaged' },
      ]);
      expect(r.error).toBeUndefined();
      expect((await told(c)).map((n) => n.username)).toEqual([
        'test.assistant-general-manager.1.0',
        'test.executive-chef.1.0',
      ]);
    });
  });

  it('a standalone bar: its Bar Manager is told; Test Company is not', async () => {
    await inRolledBackTx(async (c) => {
      const store = 'TEST-SOLO-BAR-BAR-STORE';
      const lemons = await item(c, store, 'Test Lemons');
      const r = await record(c, 'test.solo.head-bartender', store, [
        { item_id: lemons, qty: 2, reason: 'spoiled' },
      ]);
      expect(r.error).toBeUndefined();
      expect((await told(c)).map((n) => n.username)).toEqual(['test.solo.bar-manager']);
    });
  });

  it('a refused discard tells nobody', async () => {
    await inRolledBackTx(async (c) => {
      const paste = await item(c, KITCHEN, 'Ginger Garlic Paste');
      const r = await record(c, 'test.server.3.0', KITCHEN, [
        { item_id: paste, qty: 10, reason: 'spoiled' },
      ]);
      expect(r.error).toBe('NOT_AUTHORISED');
      expect(await told(c)).toEqual([]);
    });
  });
});
