import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// How many portions a batch makes (ADR 084): file 19's batch_portions on the recipe list, and
// on a prep task scaled to the quantity it asks for; its ingredients carry their category for
// their pictures. Hotel 1.0's kitchen: the sous chef gives the commis 250 g of mint chutney
// (a 500 g batch makes 20 portions, so 250 g makes 10).

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

const STORE = 'TEST-HOTEL-1.0-KITCHEN-STORE';

async function ok<T extends object>(
  c: PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
) {
  const r = await attemptAs<T>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}

describe('portions (ADR 084)', () => {
  it('the recipe list says how many portions a batch makes, where file 19 says', async () => {
    await inRolledBackTx(async (c) => {
      const rows = await ok<{ code: string; batch_portions: string | null }>(
        c,
        'test.commis.1.0',
        `select code, batch_portions::text from inv.my_recipes() where kind = 'prep'`,
      );
      const by = new Map(rows.map((r) => [r.code, r.batch_portions]));
      expect(Number(by.get('MINT-CHUTNEY'))).toBe(20);
      expect(by.get('GINGER-GARLIC-PASTE')).toBeNull();
    });
  });

  it("a prep task's portions follow its quantity; its ingredients carry their category", async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id
          where t.code = 'TEST-COMPANY' and i.sku = 'MINT-CHUTNEY'`,
      );
      const [t] = await ok<{ ids: string[] }>(
        c,
        'test.sous-chef.1.0',
        `select ops.create_prep_tasks($1, $2::jsonb, now() + interval '3 hours', $3::jsonb) as ids`,
        [
          ids.node(STORE),
          JSON.stringify([{ item_id: rows[0]!.id, qty: 250 }]),
          JSON.stringify({ mode: 'person', user_id: ids.user('test.commis.1.0') }),
        ],
      );
      const [r] = await ok<{
        r: { portions: number | null; ingredients: { name: string; category: string | null }[] };
      }>(c, 'test.commis.1.0', 'select ops.prep_task_recipe($1) as r', [t!.ids[0]]);
      expect(r!.r.portions).toBe(10);
      expect(r!.r.ingredients.length).toBeGreaterThan(0);
      expect(r!.r.ingredients.every((x) => typeof x.category === 'string')).toBe(true);
    });
  });
});
