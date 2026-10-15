import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Somewhere to ask (ADR 149): a team with a store asks its own; a department with no store
// (the Solo Bar's floor service) asks its outlet's stores; whoever sits at the outlet (the GM)
// asks none, and requests from a store on Stock instead.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

async function askStores(username: string): Promise<string[]> {
  return inRolledBackTx(async (c) => {
    const r = await attemptAs<{ name: string }>(
      c,
      ids.user(username),
      `select name from inv.my_ask_stores() order by 1`,
    );
    expect(r.error).toBeUndefined();
    return r.rows!.map((x) => x.name);
  });
}

describe('the stores a person asks', () => {
  it('a team with its own store asks only that one', async () => {
    expect(await askStores('test.commis.1.0')).toEqual(['Kitchen Store']);
    expect(await askStores('test.bartender.1.0')).toEqual(['Bar Store']);
  });

  it('a department with no store asks the outlet’s stores', async () => {
    expect(await askStores('test.solo.server')).toEqual(['Bar Store', 'Kitchen Store']);
  });

  it('the GM asks none', async () => {
    expect(await askStores('test.general-manager.1.0')).toEqual([]);
  });

  it('a server’s ask goes to the store’s head, never to the server', async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node('TEST-SOLO-BAR-BAR-STORE');
      const item = await c.query<{ item_id: string }>(
        `select item_id from inv.item_node where delivery_node_id = $1 limit 1`,
        [store],
      );
      const r = await attemptAs<{ id: string }>(
        c,
        ids.user('test.solo.server'),
        `select inv.raise_staff_ask($1, jsonb_build_array(jsonb_build_object('item_id', $2::uuid,
                'qty', 1)), null, null) as id`,
        [store, item.rows[0]!.item_id],
      );
      expect(r.error).toBeUndefined();
      const heads = await c.query<{ h: string[] }>(`select inv.ask_heads($1) as h`, [
        r.rows![0]!.id,
      ]);
      expect(heads.rows[0]!.h.length).toBeGreaterThan(0);
      expect(heads.rows[0]!.h).not.toContain(ids.user('test.solo.server'));
    });
  });
});
