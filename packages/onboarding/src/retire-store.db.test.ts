import { join } from 'node:path';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadCustomer } from './apply';
import { createCustomer, customerBundle } from './create';
import { readCustomerDir } from './dir';

// A store no longer in file 02 is retired (ADR 077): archived with its items and links, never
// deleted. It must be empty and have nothing open; at a test customer what is left on its
// shelves is counted out instead, so a demo can be re-imported as it is.

afterAll(closePools);
vi.setConfig({ testTimeout: 300_000 });

const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data');

/** A store the files do not name, under `parent`, linked to `department`, with `stock` of one item. */
async function strayStore(
  c: PoolClient,
  tenant: string,
  parent: string | null,
  department: string | null,
  stock: number,
): Promise<{ store: string; item: string }> {
  const store = (
    await c.query<{ id: string }>(
      `insert into core.hierarchy_node (tenant_id, type, kind, name, code, parent_id, timezone,
                                        holds_stock)
       values ($1, 'delivery', 'store', 'Pool Bar Store', 'STRAY-POOL-BAR-STORE', $2,
               'Asia/Kolkata', true)
       returning id`,
      [tenant, parent],
    )
  ).rows[0]!.id;
  if (department) {
    await c.query(
      `insert into core.node_link (tenant_id, org_node_id, delivery_node_id) values ($1, $2, $3)`,
      [tenant, department, store],
    );
  }
  const item = (
    await c.query<{ id: string }>(
      `insert into inv.item (tenant_id, sku, name, category, base_uom)
       values ($1, 'STRAY-TONIC', 'Stray tonic', 'Mixers', 'bottle') returning id`,
      [tenant],
    )
  ).rows[0]!.id;
  await c.query(
    `insert into inv.item_node (tenant_id, item_id, delivery_node_id, par_level)
     values ($1, $2, $3, 12)`,
    [tenant, item, store],
  );
  if (stock) {
    await c.query(`select inv.post_at($1, $2, 'receipt', $3, 40, 'test', null, now())`, [
      item,
      store,
      stock,
    ]);
  }
  return { store, item };
}

const state = async (c: PoolClient, store: string, item: string) =>
  (
    await c.query<{ archived: boolean; links: number; item_archived: boolean; on_hand: string }>(
      `select n.archived_at is not null as archived,
              (select count(*)::int from core.node_link l where l.delivery_node_id = n.id) as links,
              (select x.archived_at is not null from inv.item_node x
                where x.delivery_node_id = n.id and x.item_id = $2) as item_archived,
              coalesce((select s.on_hand::text from inv.stock_level s
                         where s.delivery_node_id = n.id and s.item_id = $2), '0') as on_hand
         from core.hierarchy_node n where n.id = $1`,
      [store, item],
    )
  ).rows[0]!;

describe('a store no longer in file 02', () => {
  it('at a test customer: retired, its stock counted out, and a second load changes nothing', async () => {
    await inRolledBackTx(async (c) => {
      const t = (
        await c.query<{ tenant_id: string; supply: string; bar: string }>(
          `select s.tenant_id, s.id as supply,
                  (select id from core.hierarchy_node where code = 'TEST-HOTEL-1.0-BAR') as bar
             from core.hierarchy_node s where s.code = 'TEST-HOTEL-1.0-SUPPLY'`,
        )
      ).rows[0]!;
      const { store, item } = await strayStore(c, t.tenant_id, t.supply, t.bar, 7);
      const files = readCustomerDir(join(DATA, 'test-company'));

      const dry = await loadCustomer(c, files, { nested: true, dryRun: true });
      expect(dry.issues).toEqual([]);
      expect(dry.counts['retired stores']).toEqual({ created: 0, updated: 1, unchanged: 0 });
      expect(dry.warnings).toContainEqual({
        file: '02_delivery_nodes.csv',
        message:
          'Pool Bar Store (STRAY-POOL-BAR-STORE) is not in this file: it is retired, with its 1 item; what is left on its shelves (1 item) is counted out, as this is a test customer',
      });
      expect((await state(c, store, item)).archived).toBe(false);

      const r = await loadCustomer(c, files, { nested: true });
      expect(r.ok).toBe(true);
      expect(await state(c, store, item)).toEqual({
        archived: true,
        links: 0,
        item_archived: true,
        on_hand: '0.000000',
      });
      const out = await c.query<{ qty: string; movement_type: string; ref_type: string }>(
        `select qty::text, movement_type, ref_type from inv.stock_ledger
          where delivery_node_id = $1 and qty < 0`,
        [store],
      );
      expect(out.rows).toEqual([
        { qty: '-7.000000', movement_type: 'count_adjust', ref_type: 'retired' },
      ]);
      // the bar's people no longer reach it
      const reach = await c.query(
        `select 1 from core.role_assignment where node_id = $1 and source <> 'extra'`,
        [store],
      );
      expect(reach.rowCount).toBe(0);

      const again = await loadCustomer(c, files, { nested: true, dryRun: true });
      expect(again.counts['retired stores']).toBeUndefined();
      expect(again.warnings.filter((w) => w.file === '02_delivery_nodes.csv')).toEqual([]);
    });
  });

  it('with a transfer still open: refused, at any customer', async () => {
    await inRolledBackTx(async (c) => {
      const t = (
        await c.query<{ tenant_id: string; supply: string; main: string }>(
          `select s.tenant_id, s.id as supply,
                  (select id from core.hierarchy_node where code = 'TEST-HOTEL-1.0-MAIN-STORE') as main
             from core.hierarchy_node s where s.code = 'TEST-HOTEL-1.0-SUPPLY'`,
        )
      ).rows[0]!;
      const { store } = await strayStore(c, t.tenant_id, t.supply, null, 0);
      await c.query(
        `insert into inv.transfer (tenant_id, from_node_id, to_node_id, status)
         values ($1, $2, $3, 'submitted')`,
        [t.tenant_id, t.main, store],
      );
      const r = await loadCustomer(c, readCustomerDir(join(DATA, 'test-company')), {
        nested: true,
        dryRun: true,
      });
      expect(r.issues).toContainEqual({
        file: '02_delivery_nodes.csv',
        column: 'node_code',
        message:
          'Pool Bar Store (STRAY-POOL-BAR-STORE) is not in this file, but it still has 1 stock request or order open: finish or withdraw it in the app first, or keep the store in the file',
      });
    });
  });

  it('at a real customer: refused while it holds stock, retired once it is empty', async () => {
    await inRolledBackTx(async (c) => {
      const made = await createCustomer(
        c,
        {
          code: 'RETIRE',
          name: 'Retire Hotels',
          country: 'India',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
          isTest: false,
          owner: { displayName: 'Ravi Rao', email: 'ravi@retire.example' },
        },
        { nested: true },
      );
      const tenant = made.tenantId!;
      // a supply point in the files, and a store that was dropped from them
      const files = {
        ...customerBundle({
          code: 'RETIRE',
          name: 'Retire Hotels',
          country: 'India',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
          isTest: false,
          owner: { displayName: 'Ravi Rao', email: 'ravi@retire.example' },
        }),
        '02_delivery_nodes.csv':
          'node_code,name,kind,parent_code,timezone,holds_stock,is_main_store\n' +
          'RETIRE-NETWORK,Supply Network,network,,,no,no\n' +
          'RETIRE-SUPPLY,Supply Point,outlet,RETIRE-NETWORK,Asia/Kolkata,no,no\n',
      };
      expect((await loadCustomer(c, files, { nested: true })).issues).toEqual([]);
      const supply = (
        await c.query<{ id: string }>(
          `select id from core.hierarchy_node where tenant_id = $1 and code = 'RETIRE-SUPPLY'`,
          [tenant],
        )
      ).rows[0]!.id;
      const { store, item } = await strayStore(c, tenant, supply, null, 3);

      const r = await loadCustomer(c, files, { nested: true, dryRun: true });
      expect(r.issues).toContainEqual({
        file: '02_delivery_nodes.csv',
        column: 'node_code',
        message:
          'Pool Bar Store (STRAY-POOL-BAR-STORE) is not in this file, but it still holds stock of 1 item: send it to another store or count it out in the app first, or keep the store in the file',
      });

      await c.query(`select inv.post_at($1, $2, 'count_adjust', -3, 40, 'test', null, now())`, [
        item,
        store,
      ]);
      const ok = await loadCustomer(c, files, { nested: true });
      expect(ok.issues).toEqual([]);
      expect(ok.warnings).toContainEqual({
        file: '02_delivery_nodes.csv',
        message:
          'Pool Bar Store (STRAY-POOL-BAR-STORE) is not in this file: it is retired, with its 1 item',
      });
      expect((await state(c, store, item)).archived).toBe(true);
    });
  });
});
