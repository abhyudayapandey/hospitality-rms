import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Running low (KI-05: ADR 141 with ADR 034): under its par, or lasting 3 days or fewer at what
// the store used over the last 14 days, par or no par; durable things by par only. One rule in
// the database (`inv.running_low`, `inv.recent_use`), read by Home's counts (lib/today.ts) and
// the Stock lists (lib/inventory.ts); apps/web/lib/low-stock.ts mirrors it for the words.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const low = async (c: PoolClient, on: number, par: number, used: number | null, durable = false) =>
  (
    await c.query<{ low: boolean }>('select inv.running_low($1, $2, $3, $4) as low', [
      on,
      par,
      used,
      durable,
    ])
  ).rows[0]!.low;

// Home's count of a store's low items, as lib/today.ts reads it
const homeCount = async (c: PoolClient, store: string) =>
  (
    await c.query<{ n: number }>(
      `select count(*)::int as n
         from inv.item_node n
         join inv.item i on i.id = n.item_id and i.archived_at is null
         left join inv.stock_level s on s.item_id = n.item_id
                                    and s.delivery_node_id = n.delivery_node_id
        where n.archived_at is null and n.delivery_node_id = $1
          and inv.running_low(coalesce(s.on_hand, 0), n.par_level,
                              inv.recent_use(n.item_id, n.delivery_node_id), i.durable)`,
      [store],
    )
  ).rows[0]!.n;

// the Stock screen's list, as lib/inventory.ts reads it
const listRows = async (c: PoolClient, store: string) =>
  (
    await c.query<{ name: string; low: boolean; below_par: boolean }>(
      `select i.name, coalesce(s.on_hand, 0) < n.par_level as below_par,
              inv.running_low(coalesce(s.on_hand, 0), n.par_level, u.used, i.durable) as low
         from inv.item_node n
         join inv.item i on i.id = n.item_id
         left join inv.stock_level s on s.item_id = n.item_id
                                    and s.delivery_node_id = n.delivery_node_id
         cross join lateral (select inv.recent_use(n.item_id, n.delivery_node_id) as used) u
        where n.delivery_node_id = $1 and n.archived_at is null and i.archived_at is null`,
      [store],
    )
  ).rows;

describe('running low', () => {
  it('under par, or 3 days or fewer of use left; each item once', async () => {
    await inRolledBackTx(async (c) => {
      expect(await low(c, 14, 20, 196)).toBe(true); // under par and short
      expect(await low(c, 1, 10, 0)).toBe(true); // under par, not used
      expect(await low(c, 30, 0, 140)).toBe(true); // no par, 3 days left
      expect(await low(c, 31, 0, 140)).toBe(false); // no par, more than 3 days
      expect(await low(c, 20, 20, 140)).toBe(true); // at par, 2 days left
      expect(await low(c, 0, 0, 5)).toBe(true); // none left and used
      expect(await low(c, 0, 0, 0)).toBe(false); // no par, never used
      expect(await low(c, 3, 0, null)).toBe(false);
      expect(await low(c, 5, 0, 140, true)).toBe(false); // durable: par only
      expect(await low(c, 5, 10, 0, true)).toBe(true);
    });
  });

  it('an item with no par still counts by days left, on Home and in the list alike', async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node('TEST-BAR-3.0-BAR-STORE');
      // tonic is used every day and none is left: low with its par taken away too
      await c.query(
        `update inv.item_node n set par_level = 0
           from inv.item i
          where i.id = n.item_id and n.delivery_node_id = $1 and i.name = 'Test Tonic Water 300ml'`,
        [store],
      );
      await actAs(c, 'app_rw', ids.user('test.bar-manager.3.0'));
      const rows = await listRows(c, store);
      const tonic = rows.find((r) => r.name === 'Test Tonic Water 300ml')!;
      expect(tonic.low).toBe(true);
      const lows = rows.filter((r) => r.low).length;
      expect(lows).toBeGreaterThan(0);
      expect(await homeCount(c, store)).toBe(lows);
      // every item under par is low, and is counted once
      expect(rows.filter((r) => r.below_par && !r.low)).toEqual([]);
    });
  });
});

// "Fill all short items" fills every low item (ADR 145): under par up to par; at or over par
// but 3 days or fewer left, a week's use (`inv.fill_qty`), on the order form and Send stock.
describe('fill short items', () => {
  const fill = async (
    c: PoolClient,
    on: number,
    par: number,
    used: number | null,
    durable = false,
  ) =>
    Number(
      (
        await c.query<{ q: string }>('select inv.fill_qty($1, $2, $3, $4) as q', [
          on,
          par,
          used,
          durable,
        ])
      ).rows[0]!.q,
    );

  it('up to par when under it, else a week of use when it runs out in 3 days', async () => {
    await inRolledBackTx(async (c) => {
      expect(await fill(c, 14, 20, 196)).toBe(6); // under par: up to par
      expect(await fill(c, 20, 20, 140)).toBe(50); // at par, 2 days left: a week (70) less 20
      expect(await fill(c, 30, 0, 140)).toBe(40); // no par, 3 days left
      expect(await fill(c, 31, 0, 140)).toBe(0); // not low
      expect(await fill(c, 5, 0, 140, true)).toBe(0); // durable: par only
      expect(await fill(c, 0, 0, 0)).toBe(0); // never used
    });
  });

  it('the order form suggests what a low item with no par needs', async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node('TEST-BAR-3.0-BAR-STORE');
      await c.query(
        `update inv.item_node n set par_level = 0
           from inv.item i
          where i.id = n.item_id and n.delivery_node_id = $1 and i.name = 'Test Tonic Water 300ml'`,
        [store],
      );
      const expected = (
        await c.query<{ q: string }>(
          `select inv.fill_qty(coalesce(s.on_hand, 0), 0, inv.recent_use(i.id, $1), i.durable) as q
             from inv.item i
             left join inv.stock_level s on s.item_id = i.id and s.delivery_node_id = $1
            where i.name = 'Test Tonic Water 300ml' and i.tenant_id = (
              select tenant_id from core.hierarchy_node where id = $1)`,
          [store],
        )
      ).rows[0]!.q;
      expect(Number(expected)).toBeGreaterThan(0);
      await actAs(c, 'app_rw', ids.user('test.bar-manager.3.0'));
      const r = await c.query<{ suggested_qty: string; open_po_qty: string }>(
        `select s.suggested_qty, s.open_po_qty from inv.suggested_order($1) s
           join inv.item i on i.id = s.item_id where i.name = 'Test Tonic Water 300ml'`,
        [store],
      );
      expect(Number(r.rows[0]!.suggested_qty)).toBe(
        Math.max(Number(expected) - Number(r.rows[0]!.open_po_qty), 0),
      );
    });
  });
});
