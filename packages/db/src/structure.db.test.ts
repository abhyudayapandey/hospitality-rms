import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx } from '../test/helpers';

// Flexible structure (ADR 009): optional levels, departments and stores, outlet formats,
// holds_stock and the main store flag, and stock kept only at stock locations.

afterAll(closePools);

async function tenant(c: PoolClient): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into core.tenant (name, code) values ('Shape Co', 'SHAPE-CO') returning id`,
  );
  return rows[0]!.id;
}

async function node(
  c: PoolClient,
  t: string,
  type: 'org' | 'delivery',
  kind: string,
  code: string,
  parent: string | null,
  extra: { outlet_format?: string; holds_stock?: boolean; is_main_store?: boolean } = {},
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into core.hierarchy_node (tenant_id, type, kind, name, code, parent_id, outlet_format,
                                      holds_stock, is_main_store)
     values ($1, $2, $3, $4, $4, $5, $6, $7, coalesce($8, false)) returning id`,
    [
      t,
      type,
      kind,
      code,
      parent,
      extra.outlet_format ?? null,
      extra.holds_stock ?? null,
      extra.is_main_store ?? null,
    ],
  );
  return rows[0]!.id;
}

async function fails(c: PoolClient, sql: string, params: unknown[]): Promise<string | null> {
  await c.query('savepoint s');
  try {
    await c.query(sql, params);
    await c.query('release savepoint s');
    return null;
  } catch (err) {
    await c.query('rollback to savepoint s');
    return (err as Error).message;
  }
}

describe('structure', () => {
  it('allows a company with an outlet directly under it (no region, area or departments)', async () => {
    await inRolledBackTx(async (c) => {
      const t = await tenant(c);
      const co = await node(c, t, 'org', 'company', 'SHAPE-CO', null);
      const bar = await node(c, t, 'org', 'outlet', 'SHAPE-BAR', co, {
        outlet_format: 'standalone_bar',
      });
      const net = await node(c, t, 'delivery', 'network', 'SHAPE-NET', null, {
        holds_stock: false,
      });
      const supply = await node(c, t, 'delivery', 'outlet', 'SHAPE-BAR-SUPPLY', net);
      const { rows } = await c.query(
        `select code, holds_stock from core.hierarchy_node where id = any($1) order by code`,
        [[bar, supply]],
      );
      // a supply point holds stock unless told otherwise (the Guest House shape)
      expect(rows).toEqual([
        { code: 'SHAPE-BAR', holds_stock: false },
        { code: 'SHAPE-BAR-SUPPLY', holds_stock: true },
      ]);
    });
  });

  it('puts departments under outlets or sites and stores under supply points or hubs', async () => {
    await inRolledBackTx(async (c) => {
      const t = await tenant(c);
      const co = await node(c, t, 'org', 'company', 'SHAPE-CO', null);
      const hotel = await node(c, t, 'org', 'outlet', 'SHAPE-HOTEL', co, {
        outlet_format: 'full_hotel',
      });
      await node(c, t, 'org', 'department', 'SHAPE-HOTEL-BAR', hotel);
      const insert = `insert into core.hierarchy_node (tenant_id, type, kind, name, code, parent_id)
                      values ($1, $2, $3, 'x', $4, $5)`;
      expect(await fails(c, insert, [t, 'org', 'department', 'SHAPE-BAD-DEPT', co])).toBe(
        'INVALID_PARENT',
      );
      const net = await node(c, t, 'delivery', 'network', 'SHAPE-NET', null, {
        holds_stock: false,
      });
      expect(await fails(c, insert, [t, 'delivery', 'store', 'SHAPE-BAD-STORE', net])).toBe(
        'INVALID_PARENT',
      );
      expect(await fails(c, insert, [t, 'org', 'hub', 'SHAPE-X', co])).toMatch(
        /hierarchy_node_kind/,
      );
      // outlet formats only on org outlets
      expect(
        await fails(
          c,
          `update core.hierarchy_node set outlet_format = 'full_hotel' where id = $1`,
          [co],
        ),
      ).toMatch(/hierarchy_node_format/);
    });
  });

  it('keeps codes unique per tenant and one main store per supply point', async () => {
    await inRolledBackTx(async (c) => {
      const t = await tenant(c);
      const net = await node(c, t, 'delivery', 'network', 'SHAPE-NET', null, {
        holds_stock: false,
      });
      const supply = await node(c, t, 'delivery', 'outlet', 'SHAPE-SUPPLY', net, {
        holds_stock: false,
      });
      await node(c, t, 'delivery', 'store', 'SHAPE-MAIN', supply, { is_main_store: true });
      const insert = `insert into core.hierarchy_node (tenant_id, type, kind, name, code, parent_id, is_main_store)
                      values ($1, 'delivery', 'store', 'x', $2, $3, $4)`;
      expect(await fails(c, insert, [t, 'SHAPE-MAIN-2', supply, true])).toMatch(/one_main_store/);
      expect(await fails(c, insert, [t, 'SHAPE-MAIN', supply, false])).toMatch(
        /hierarchy_node_code/,
      );
      // the same code in another tenant is fine
      const other = (
        await c.query<{ id: string }>(
          `insert into core.tenant (name) values ('Other') returning id`,
        )
      ).rows[0]!.id;
      await node(c, other, 'delivery', 'network', 'SHAPE-NET', null, { holds_stock: false });
    });
  });

  it('keeps stock only at holds_stock locations', async () => {
    await inRolledBackTx(async (c) => {
      const t = await tenant(c);
      const net = await node(c, t, 'delivery', 'network', 'SHAPE-NET', null, {
        holds_stock: false,
      });
      const supply = await node(c, t, 'delivery', 'outlet', 'SHAPE-SUPPLY', net, {
        holds_stock: false,
      });
      const store = await node(c, t, 'delivery', 'store', 'SHAPE-STORE', supply);
      const item = (
        await c.query<{ id: string }>(
          `insert into inv.item (tenant_id, sku, name, category, base_uom)
           values ($1, 'SH-1', 'Shape item', 'Test', 'kg') returning id`,
          [t],
        )
      ).rows[0]!.id;
      const ledger = `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type,
                                                     qty, unit_cost, ref_type)
                      values ($1, $2, $3, 'receipt', 1, 1, 'test')`;
      expect(await fails(c, ledger, [t, item, supply])).toBe('NOT_A_STOCK_LOCATION');
      expect(await fails(c, ledger, [t, item, store])).toBeNull();
      const itemNode = `insert into inv.item_node (tenant_id, item_id, delivery_node_id, par_level)
                        values ($1, $2, $3, 1)`;
      expect(await fails(c, itemNode, [t, item, supply])).toBe('NOT_A_STOCK_LOCATION');
      expect(await fails(c, itemNode, [t, item, store])).toBeNull();
      const transfer = `insert into inv.transfer (tenant_id, from_node_id, to_node_id) values ($1, $2, $3)`;
      expect(await fails(c, transfer, [t, store, supply])).toBe('NOT_A_STOCK_LOCATION');
    });
  });
});
