import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// The POS import by the cashier (SAL-1, SAL-2, ADR 039): who may import a day's "Sale by
// item" file, who may match POS codes to menu items, and what an import does to the day's
// sales and stock. Codes are matched only through the outlet's own list (file 23's
// pos_code, or a manager's match); an unknown code is listed, never guessed.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

// the outlets' business day (06:00 to 06:00 IST, ADR 037)
const BUSINESS_DAY = new Date(Date.now() - 6 * 3_600_000).toLocaleDateString('en-CA', {
  timeZone: 'Asia/Kolkata',
});

interface PosLine {
  code: string;
  description: string;
  qty: number;
  value: number;
  discount: number;
}
interface ImportResult {
  import_id: string;
  posted: number;
  unmatched: { code: string; description: string; qty: number; value: number }[];
  net: number;
  discount: number;
}

// Paneer Tikka (3001, ₹355) and Mojito (3022, ₹430) at Test Bar 3.0, as file 23 maps them
const LINES: PosLine[] = [
  { code: '3001', description: 'PANEER TIKKA', qty: 2, value: 650, discount: 60 },
  { code: '3022', description: 'MOJITO', qty: 3, value: 1290, discount: 0 },
  { code: '9999', description: 'CHEF SPECIAL', qty: 1, value: 400, discount: 0 },
];
const file = (lines: PosLine[], extra: Record<string, unknown> = {}) => ({
  file_name: 'sale_by_item.xlsx',
  pos_outlets: ['TEST BAR 3.0'],
  period_from: null,
  period_to: null,
  total_value: lines.reduce((s, l) => s + l.value, 0),
  lines,
  ...extra,
});

const importAs = (
  c: PoolClient,
  who: string,
  outlet: string,
  body: unknown,
  date = BUSINESS_DAY,
  key: string | null = null,
) =>
  attemptAs<{ r: ImportResult }>(
    c,
    ids.user(who),
    'select menu.import_pos($1, $2::date, $3::jsonb, $4) as r',
    [ids.node(outlet), date, JSON.stringify(body), key],
  );

async function menuItem(c: PoolClient, code: string, customer = 'TEST-COMPANY'): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select m.id from menu.menu_item m join core.tenant t on t.id = m.tenant_id where t.code = $1 and m.code = $2`,
    [customer, code],
  );
  return rows[0]!.id;
}
async function posted(c: PoolClient, outlet: string, code: string, source = 'pos') {
  const { rows } = await c.query<{ qty: string; net: string | null; discount: string }>(
    `select sl.qty, sl.net, sl.discount from menu.sales_line sl
       join menu.sales_day sd on sd.id = sl.sales_day_id
       join menu.menu_item m on m.id = sl.menu_item_id
      where sd.org_node_id = $1 and sd.business_date = $2::date and sd.source = $3 and m.code = $4`,
    [ids.node(outlet), BUSINESS_DAY, source, code],
  );
  return rows[0]
    ? { qty: Number(rows[0].qty), net: rows[0].net, discount: Number(rows[0].discount) }
    : null;
}
async function onHand(c: PoolClient, sku: string, store: string): Promise<number> {
  const { rows } = await c.query<{ q: string }>(
    `select coalesce(sum(l.qty), 0) as q from inv.stock_ledger l join inv.item i on i.id = l.item_id
      where i.sku = $1 and l.delivery_node_id = $2`,
    [sku, ids.node(store)],
  );
  return Number(rows[0]!.q);
}

describe('who imports', () => {
  it("the cashier imports their outlet's day; matched lines post, the rest are listed", async () => {
    await inRolledBackTx(async (c) => {
      const r = await importAs(c, 'test.cashier.3.0', 'TEST-BAR-3.0', file(LINES));
      expect(r.error).toBeUndefined();
      const res = r.rows![0]!.r;
      expect(res.posted).toBe(2);
      expect(res.unmatched).toEqual([
        expect.objectContaining({ code: '9999', description: 'CHEF SPECIAL', qty: 1, value: 400 }),
      ]);
      // the file's totals, matched or not
      expect(Number(res.net)).toBe(2340);
      expect(Number(res.discount)).toBe(60);
      // net and discount come from the POS, not the menu price
      expect(await posted(c, 'TEST-BAR-3.0', 'PANEER-TIKKA')).toEqual({
        qty: 2,
        net: '650.00',
        discount: 60,
      });
      expect(await posted(c, 'TEST-BAR-3.0', 'MOJITO')).toEqual({
        qty: 3,
        net: '1290.00',
        discount: 0,
      });
      // and the sales depleted the stores by recipe
      const { rows } = await c.query<{ n: string }>(
        `select count(*) as n from inv.stock_ledger l join menu.sales_day sd on sd.id = l.ref_id
          where l.ref_type = 'sales_day' and sd.org_node_id = $1 and sd.business_date = $2::date
            and sd.source = 'pos'`,
        [ids.node('TEST-BAR-3.0'), BUSINESS_DAY],
      );
      expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    });
  });

  it('the cashier imports only at their own outlet', async () => {
    await inRolledBackTx(async (c) => {
      const r = await importAs(c, 'test.cashier.3.0', 'TEST-HOTEL-1.0', file(LINES));
      expect(r.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('a server, a cook and another customer cannot import', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of ['test.server.3.0', 'test.cook.3.0', 'test.solo.bar-manager']) {
        const r = await importAs(c, who, 'TEST-BAR-3.0', file(LINES));
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it('managers who post sales import too', async () => {
    await inRolledBackTx(async (c) => {
      const r = await importAs(c, 'test.bar-manager.3.0', 'TEST-BAR-3.0', file(LINES));
      expect(r.error).toBeUndefined();
      expect(r.rows![0]!.r.posted).toBe(2);
    });
  });

  it("the cashier never reads the outlet's sales, costs or reports", async () => {
    await inRolledBackTx(async (c) => {
      await importAs(c, 'test.cashier.3.0', 'TEST-BAR-3.0', file(LINES));
      const u = ids.user('test.cashier.3.0');
      const lines = await attemptAs<{ n: string }>(
        c,
        u,
        'select count(*) as n from menu.sales_line',
      );
      expect(lines.error).toBeUndefined();
      expect(Number(lines.rows![0]!.n)).toBe(0);
      const days = await attemptAs<{ n: string }>(c, u, 'select count(*) as n from menu.sales_day');
      expect(Number(days.rows![0]!.n)).toBe(0);
      const reports = await attemptAs<{ report: string }>(c, u, 'select * from rpt.my_reports()');
      expect(reports.rows!.map((r) => r.report)).toEqual(['my_week']);
      const flash = await attemptAs(c, u, `select * from rpt.outlet_flash($1, $2::date)`, [
        ids.node('TEST-BAR-3.0'),
        BUSINESS_DAY,
      ]);
      expect(flash.error).toMatch(/NOT_AUTHORISED/);
      // nor types sales in by hand
      const manual = await attemptAs(c, u, `select menu.post_sales($1, $2::date, $3::jsonb)`, [
        ids.node('TEST-BAR-3.0'),
        BUSINESS_DAY,
        JSON.stringify([{ menu_item_id: await menuItem(c, 'MOJITO'), qty: 1 }]),
      ]);
      expect(manual.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('POS sales come only through the import', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(
        c,
        ids.user('test.bar-manager.3.0'),
        `select menu.post_sales($1, $2::date, $3::jsonb, 'pos')`,
        [
          ids.node('TEST-BAR-3.0'),
          BUSINESS_DAY,
          JSON.stringify([{ menu_item_id: await menuItem(c, 'MOJITO'), qty: 1 }]),
        ],
      );
      expect(r.error).toMatch(/INVALID_SOURCE/);
    });
  });
});

describe('matching POS codes', () => {
  it('the cashier cannot match a code; the bar manager can, and the day posts again', async () => {
    await inRolledBackTx(async (c) => {
      const first = await importAs(c, 'test.cashier.3.0', 'TEST-BAR-3.0', file(LINES));
      const importId = first.rows![0]!.r.import_id;
      const sangria = await menuItem(c, 'SANGRIA-GLASS');
      const map = (who: string) =>
        attemptAs(c, ids.user(who), 'select menu.map_pos_item($1, $2, $3)', [
          ids.node('TEST-BAR-3.0'),
          '9999',
          sangria,
        ]);
      expect((await map('test.cashier.3.0')).error).toMatch(/NOT_AUTHORISED/);
      expect((await map('test.general-manager.1.0')).error).toMatch(/NOT_AUTHORISED/);
      expect((await map('test.bar-manager.3.0')).error).toBeUndefined();
      // a dish not on this outlet's menu is refused
      const other = await attemptAs(
        c,
        ids.user('test.bar-manager.3.0'),
        'select menu.map_pos_item($1, $2, $3)',
        [ids.node('TEST-BAR-3.0'), '9998', await menuItem(c, 'DAL-TADKA')],
      );
      expect(other.error).toMatch(/INVALID_ITEM/);

      const again = await attemptAs<{ r: ImportResult }>(
        c,
        ids.user('test.cashier.3.0'),
        'select menu.repost_pos($1) as r',
        [importId],
      );
      expect(again.error).toBeUndefined();
      expect(again.rows![0]!.r.posted).toBe(3);
      expect(again.rows![0]!.r.unmatched).toEqual([]);
      expect(await posted(c, 'TEST-BAR-3.0', 'SANGRIA-GLASS')).toEqual({
        qty: 1,
        net: '400.00',
        discount: 0,
      });
    });
  });

  it("another outlet's cashier cannot post an import again", async () => {
    await inRolledBackTx(async (c) => {
      const first = await importAs(c, 'test.cashier.3.0', 'TEST-BAR-3.0', file(LINES));
      const r = await attemptAs(c, ids.user('test.server.3.0'), 'select menu.repost_pos($1)', [
        first.rows![0]!.r.import_id,
      ]);
      expect(r.error).toMatch(/NOT_AUTHORISED|NOT_FOUND/);
    });
  });
});

describe('what an import does to the day', () => {
  it("replaces the day's typed-in sales, and typing in is closed after", async () => {
    await inRolledBackTx(async (c) => {
      const mgr = ids.user('test.bar-manager.3.0');
      const cola = await menuItem(c, 'COLA-SERVE');
      const typed = await attemptAs(c, mgr, 'select menu.post_sales($1, $2::date, $3::jsonb)', [
        ids.node('TEST-BAR-3.0'),
        BUSINESS_DAY,
        JSON.stringify([{ menu_item_id: cola, qty: 5 }]),
      ]);
      expect(typed.error).toBeUndefined();
      const stockAfterTyped = await onHand(c, 'COLA-300ML', 'TEST-BAR-3.0-BAR-STORE');
      await importAs(c, 'test.cashier.3.0', 'TEST-BAR-3.0', file(LINES));
      expect((await posted(c, 'TEST-BAR-3.0', 'COLA-SERVE', 'manual'))?.qty).toBe(0);
      // the cola sold by hand went back to stock
      expect(await onHand(c, 'COLA-300ML', 'TEST-BAR-3.0-BAR-STORE')).toBeGreaterThan(
        stockAfterTyped,
      );
      const after = await attemptAs(c, mgr, 'select menu.post_sales($1, $2::date, $3::jsonb)', [
        ids.node('TEST-BAR-3.0'),
        BUSINESS_DAY,
        JSON.stringify([{ menu_item_id: cola, qty: 1 }]),
      ]);
      expect(after.error).toMatch(/SALES_FROM_POS/);
    });
  });

  it('importing the day again replaces the first import', async () => {
    await inRolledBackTx(async (c) => {
      await importAs(c, 'test.cashier.3.0', 'TEST-BAR-3.0', file(LINES));
      const second = file([
        { code: '3022', description: 'MOJITO', qty: 4, value: 1720, discount: 0 },
      ]);
      const r = await importAs(c, 'test.cashier.3.0', 'TEST-BAR-3.0', second);
      expect(r.error).toBeUndefined();
      expect((await posted(c, 'TEST-BAR-3.0', 'MOJITO'))?.qty).toBe(4);
      expect((await posted(c, 'TEST-BAR-3.0', 'PANEER-TIKKA'))?.qty).toBe(0);
    });
  });

  it('the same import key returns the first import', async () => {
    await inRolledBackTx(async (c) => {
      const a = await importAs(
        c,
        'test.cashier.3.0',
        'TEST-BAR-3.0',
        file(LINES),
        BUSINESS_DAY,
        'k-1',
      );
      const b = await importAs(
        c,
        'test.cashier.3.0',
        'TEST-BAR-3.0',
        file(LINES),
        BUSINESS_DAY,
        'k-1',
      );
      expect(b.rows![0]!.r.import_id).toBe(a.rows![0]!.r.import_id);
      expect((await posted(c, 'TEST-BAR-3.0', 'MOJITO'))?.qty).toBe(3);
    });
  });

  it('refuses a file for several days, for another day, or whose totals do not add up', async () => {
    await inRolledBackTx(async (c) => {
      const month = await importAs(
        c,
        'test.cashier.3.0',
        'TEST-BAR-3.0',
        file(LINES, { period_from: '2026-07-01', period_to: '2026-07-31' }),
      );
      expect(month.error).toMatch(/POS_FILE_SPANS_DAYS/);
      const other = await importAs(
        c,
        'test.cashier.3.0',
        'TEST-BAR-3.0',
        file(LINES, { period_from: '2026-07-01', period_to: '2026-07-01' }),
      );
      expect(other.error).toMatch(/POS_FILE_OTHER_DAY/);
      const sums = await importAs(
        c,
        'test.cashier.3.0',
        'TEST-BAR-3.0',
        file(LINES, { total_value: 1 }),
      );
      expect(sums.error).toMatch(/POS_TOTALS_MISMATCH/);
      const negative = await importAs(
        c,
        'test.cashier.3.0',
        'TEST-BAR-3.0',
        file([{ ...LINES[0]!, qty: -1 }]),
      );
      expect(negative.error).toMatch(/INVALID_QUANTITY/);
      const future = await importAs(
        c,
        'test.cashier.3.0',
        'TEST-BAR-3.0',
        file(LINES),
        '2099-01-01',
      );
      expect(future.error).toMatch(/INVALID_DATE/);
    });
  });

  it("the day's import shows to the cashier on their screen", async () => {
    await inRolledBackTx(async (c) => {
      await importAs(c, 'test.cashier.3.0', 'TEST-BAR-3.0', file(LINES));
      const r = await attemptAs<{ file_name: string; posted: number; unmatched: unknown[] }>(
        c,
        ids.user('test.cashier.3.0'),
        'select * from menu.pos_import_of($1, $2::date)',
        [ids.node('TEST-BAR-3.0'), BUSINESS_DAY],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows![0]).toMatchObject({ file_name: 'sale_by_item.xlsx', posted: 2 });
      expect(r.rows![0]!.unmatched).toHaveLength(1);
      const places = await attemptAs<{ outlet_id: string }>(
        c,
        ids.user('test.cashier.3.0'),
        'select * from menu.pos_places()',
      );
      expect(places.rows!.map((p) => p.outlet_id)).toEqual([ids.node('TEST-BAR-3.0')]);
      const none = await attemptAs(
        c,
        ids.user('test.server.3.0'),
        'select * from menu.pos_places()',
      );
      expect(none.rows).toEqual([]);
    });
  });
});

describe('reports use what the POS took', () => {
  it("menu engineering's revenue is the POS net, after discount", async () => {
    await inRolledBackTx(async (c) => {
      const read = async () => {
        const r = await attemptAs<{ code: string; revenue: string }>(
          c,
          ids.user('test.bar-manager.3.0'),
          `select code, revenue from rpt.menu_engineering($1, $2::date, $2::date) where code = 'PANEER-TIKKA'`,
          [ids.node('TEST-BAR-3.0'), BUSINESS_DAY],
        );
        return Number(r.rows![0]!.revenue);
      };
      const before = await read();
      await importAs(c, 'test.cashier.3.0', 'TEST-BAR-3.0', file(LINES));
      expect((await read()) - before).toBe(650);
    });
  });
});
