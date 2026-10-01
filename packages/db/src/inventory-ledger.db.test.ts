import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  resetRole,
  sqlState,
  type SeedIds,
} from '../test/helpers';

// Inventory tables (ADR 006): ledger-only stock changes (rule 3), the on-hand cache,
// weighted average cost, no negative stock, and who can read what. Fixtures are inserted
// as migrator inside rolled-back transactions.

const KIM = 'test.head-cook.3.0';
const OLIVIA = 'test.bar-manager.3.0';
const ARIA = 'test.area-manager';
const HUGO = 'test.central-kitchen-manager';
const SAM = 'test.server.3.0';

// Test Bar 3.0's Kitchen Store, the Guest House supply point, the central kitchen store
const A = 'TEST-BAR-3.0-KITCHEN-STORE';
const B = 'TEST-GUEST-HOUSE-2.0-SUPPLY';
const HUB = 'TEST-CENTRAL-KITCHEN-STORE';

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function tenantId(c: PoolClient): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    'select tenant_id as id from core.hierarchy_node where id = $1',
    [ids.node('TEST-COMPANY')],
  );
  return rows[0]!.id;
}

async function makeItem(c: PoolClient, sku: string, perishable = false): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into inv.item (tenant_id, sku, name, category, base_uom, is_perishable)
     values ($1, $2, $2, 'Test', 'kg', $3) returning id`,
    [await tenantId(c), sku, perishable],
  );
  return rows[0]!.id;
}

async function move(
  c: PoolClient,
  item: string,
  node: string,
  type: string,
  qty: number,
  unitCost = 0,
): Promise<void> {
  await c.query(
    `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                   unit_cost, ref_type)
     values ($1, $2, $3, $4, $5, $6, 'test')`,
    [await tenantId(c), item, ids.node(node), type, qty, unitCost],
  );
}

async function level(c: PoolClient, item: string, node: string) {
  const { rows } = await c.query<{ on_hand: string; avg_cost: string; value: string }>(
    `select on_hand, avg_cost, value from inv.stock_level
      where item_id = $1 and delivery_node_id = $2`,
    [item, ids.node(node)],
  );
  return rows[0];
}

const INV_TABLES = [
  'item',
  'supplier',
  'item_node',
  'node_setting',
  'stock_ledger',
  'stock_level',
  'stock_count',
  'stock_count_line',
  'stock_adjustment',
  'stock_adjustment_line',
  'wastage',
  'wastage_line',
  'purchase_order',
  'purchase_order_line',
  'goods_receipt',
  'goods_receipt_line',
  'transfer',
  'transfer_line',
];

describe('stock changes only through the ledger (rule 3)', () => {
  it('app_rw cannot insert, update or delete any inventory table, even with modify rights', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [KIM, OLIVIA]) {
        await actAs(c, 'app_rw', ids.user(who));
        for (const t of INV_TABLES) {
          expect(await sqlState(c, `insert into inv.${t} default values`), `${who} ${t}`).toBe(
            '42501',
          );
          expect(await sqlState(c, `update inv.${t} set updated_at = now()`), t).toBe('42501');
          expect(await sqlState(c, `delete from inv.${t}`), t).toBe('42501');
        }
        await resetRole(c);
      }
    });
  });

  it('the ledger is append-only for every role, including its owner', async () => {
    await inRolledBackTx(async (c) => {
      const item = await makeItem(c, 'T-APPEND');
      await move(c, item, A, 'receipt', 5, 10);
      for (const stmt of [
        `update inv.stock_ledger set qty = 50 where item_id = '${item}'`,
        `delete from inv.stock_ledger where item_id = '${item}'`,
        `truncate inv.stock_ledger`,
      ]) {
        await c.query('savepoint s');
        await expect(c.query(stmt), stmt).rejects.toThrow('LEDGER_APPEND_ONLY');
        await c.query('rollback to savepoint s');
      }
      expect(await level(c, item, A)).toMatchObject({ on_hand: '5.000000' });
    });
  });

  it('keeps inv.stock_level equal to the sum of the ledger', async () => {
    await inRolledBackTx(async (c) => {
      const item = await makeItem(c, 'T-SUM');
      await move(c, item, A, 'receipt', 10, 100);
      await move(c, item, A, 'wastage', -2);
      await move(c, item, A, 'count_adjust', -1.5);
      await move(c, item, A, 'count_adjust', 0.25);
      await move(c, item, HUB, 'receipt', 4, 90);
      const { rows } = await c.query<{ node: string; ledger: string; cached: string }>(
        `select n.code as node, sum(l.qty)::numeric(14,3)::text as ledger,
                max(s.on_hand)::text as cached
           from inv.stock_ledger l
           join inv.stock_level s using (item_id, delivery_node_id)
           join core.hierarchy_node n on n.id = l.delivery_node_id
          where l.item_id = $1 group by n.code order by n.code`,
        [item],
      );
      expect(rows).toEqual([
        { node: A, ledger: '6.750', cached: '6.750000' },
        { node: HUB, ledger: '4.000', cached: '4.000000' },
      ]);
    });
  });
});

describe('valuation and invariants', () => {
  it('recomputes the weighted average cost on receipts and values outflows at it', async () => {
    await inRolledBackTx(async (c) => {
      const item = await makeItem(c, 'T-WAC');
      await move(c, item, A, 'receipt', 10, 100);
      await move(c, item, A, 'receipt', 10, 120);
      expect(await level(c, item, A)).toEqual({
        on_hand: '20.000000',
        avg_cost: '110.0000',
        value: '2200.00',
      });
      await move(c, item, A, 'wastage', -5);
      const { rows } = await c.query<{ unit_cost: string }>(
        `select unit_cost from inv.stock_ledger where item_id = $1 and movement_type = 'wastage'`,
        [item],
      );
      expect(rows).toEqual([{ unit_cost: '110.0000' }]);
      expect(await level(c, item, A)).toEqual({
        on_hand: '15.000000',
        avg_cost: '110.0000',
        value: '1650.00',
      });
    });
  });

  it('rejects any movement that would take on-hand below zero, perishable or not', async () => {
    await inRolledBackTx(async (c) => {
      for (const perishable of [false, true]) {
        const item = await makeItem(c, `T-NEG-${perishable}`, perishable);
        await move(c, item, A, 'receipt', 3, 10);
        for (const [type, qty] of [
          ['wastage', -3.001],
          ['transfer_out', -4],
          ['count_adjust', -5],
          ['consumption', -10],
        ] as const) {
          await c.query('savepoint s');
          await expect(move(c, item, A, type, qty), type).rejects.toThrow('INSUFFICIENT_STOCK');
          await c.query('rollback to savepoint s');
        }
        await move(c, item, A, 'wastage', -3); // exactly to zero is fine
        expect(await level(c, item, A)).toMatchObject({ on_hand: '0.000000' });
      }
    });
  });

  it('enforces the sign of each movement type', async () => {
    await inRolledBackTx(async (c) => {
      const item = await makeItem(c, 'T-SIGN');
      await move(c, item, A, 'receipt', 10, 1);
      for (const [type, qty] of [
        ['receipt', -1],
        ['transfer_in', -1],
        ['wastage', 1],
        ['transfer_out', 1],
        ['count_adjust', 0],
      ] as const) {
        expect(
          await sqlState(
            c,
            `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type,
                                           qty, ref_type)
             select tenant_id, id, $1, $2, $3, 'test' from inv.item where id = $4`,
            [ids.node('TEST-BAR-3.0-KITCHEN-STORE'), type, qty, item],
          ),
          `${type} ${qty}`,
        ).toBe('23514');
      }
    });
  });
});

describe('who reads what', () => {
  it('stock levels follow STOCK_LEVELS on the delivery tree, derived for the area manager', async () => {
    await inRolledBackTx(async (c) => {
      const item = await makeItem(c, 'T-READ');
      for (const node of [HUB, A, B]) await move(c, item, node, 'receipt', 1, 1);
      const nodesSeenBy = async (who: string) => {
        const r = await attemptAs<{ node: string }>(
          c,
          ids.user(who),
          'select delivery_node_id as node from inv.stock_level where item_id = $1',
          [item],
        );
        if (r.error !== undefined) throw new Error(r.error);
        const names = new Map([HUB, A, B].map((n) => [ids.node(n), n]));
        return r.rows.map((x) => names.get(x.node)).sort();
      };
      expect(await nodesSeenBy(KIM)).toEqual([A]);
      expect(await nodesSeenBy(OLIVIA)).toEqual([A]);
      // DERIVED_STOCK_LEVELS: the central kitchen is in the area too
      expect(await nodesSeenBy(ARIA)).toEqual([A, B, HUB].sort());
      expect(await nodesSeenBy(HUGO)).toEqual([A, B, HUB].sort()); // SUPPLY_VIEWER
      expect(await nodesSeenBy(SAM)).toEqual([]);
    });
  });

  it('the item catalogue is visible to anyone with stock access in the tenant', async () => {
    await inRolledBackTx(async (c) => {
      await makeItem(c, 'T-CAT');
      const sees = async (who: string) => {
        const r = await attemptAs<{ n: string }>(
          c,
          ids.user(who),
          `select count(*) as n from inv.item where sku = 'T-CAT'`,
        );
        if (r.error !== undefined) throw new Error(r.error);
        return Number(r.rows[0]!.n);
      };
      expect(await sees(KIM)).toBe(1);
      expect(await sees(ARIA)).toBe(1); // derived
      expect(await sees(HUGO)).toBe(1);
      expect(await sees(SAM)).toBe(0);
    });
  });

  it('catalogue checks run once per query, not per row', async () => {
    await inRolledBackTx(async (c) => {
      await actAs(c, 'app_rw', ids.user(KIM));
      const { rows } = await c.query<{ 'QUERY PLAN': string }>('explain select * from inv.item');
      await resetRole(c);
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/InitPlan/);
    });
  });
});
