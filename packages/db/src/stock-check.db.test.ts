import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Stock check (INV-10, INV-11, INV-7, INV-8; ADR 043): the verifier counts blind, sees the
// differences, adds a photo to each, and the differences post to the ledger at once with
// no approval. Run as the seeded users inside rolled-back transactions.

const VERIFIER = 'test.cost-controller.1.0'; // Cost Controller: verifies by default (INV-11)
const KEEPER = 'test.executive-chef.1.0'; // store keeper and head of the Kitchen
const GM = 'test.general-manager.1.0';
const STOCK_USER = 'test.chef-de-partie.1.0'; // uses the store, may not verify it
const OTHER_COMPANY = 'test.solo.bar-manager';
const STORE = 'TEST-HOTEL-1.0-KITCHEN-STORE';

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const node = () => ids.node(STORE);

async function fixture(c: PoolClient, items: Record<string, number>) {
  const tenant = (
    await c.query<{ id: string }>('select tenant_id as id from core.hierarchy_node where id = $1', [
      node(),
    ])
  ).rows[0]!.id;
  const map: Record<string, string> = {};
  let order = 0;
  for (const [sku, qty] of Object.entries(items)) {
    const item = (
      await c.query<{ id: string }>(
        `insert into inv.item (tenant_id, sku, name, category, base_uom)
         values ($1, $2, 'Item ' || $2, 'Test', 'kg') returning id`,
        [tenant, sku],
      )
    ).rows[0]!.id;
    map[sku] = item;
    await c.query(
      `insert into inv.item_node (tenant_id, item_id, delivery_node_id, shelf, shelf_order)
       values ($1, $2, $3, 'Shelf A', $4)`,
      [tenant, item, node(), order++],
    );
    await c.query(
      `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                     unit_cost, ref_type)
       values ($1, $2, $3, 'receipt', $4, 100, 'opening')`,
      [tenant, item, node(), qty],
    );
  }
  return { tenant, item: (sku: string) => map[sku]! };
}

async function ok<T = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T & object>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}

const fail = async (c: PoolClient, who: string, text: string, params: unknown[] = []) =>
  (await attemptAs(c, ids.user(who), text, params)).error;

async function startCheck(c: PoolClient, who = VERIFIER, mode = 'standard'): Promise<string> {
  const rows = await ok<{ id: string }>(c, who, 'select inv.start_stock_check($1, $2) as id', [
    node(),
    mode,
  ]);
  return rows[0]!.id;
}

const count = (c: PoolClient, who: string, check: string, item: string, qty: number | null) =>
  ok(c, who, 'select inv.record_check_line($1, $2, $3)', [check, item, qty]);

const onHand = async (c: PoolClient, item: string) =>
  Number(
    (
      await c.query<{ q: string }>(
        `select coalesce((select on_hand from inv.stock_level
                           where item_id = $1 and delivery_node_id = $2), 0) as q`,
        [item, node()],
      )
    ).rows[0]!.q,
  );

describe('who may verify', () => {
  it('lets the Cost Controller start a check and refuses stock users and other companies', async () => {
    await inRolledBackTx(async (c) => {
      await fixture(c, { 'SC-A': 10 });
      expect(await startCheck(c)).toBeTruthy();
      expect(await fail(c, STOCK_USER, 'select inv.start_stock_check($1)', [node()])).toMatch(
        /NOT_AUTHORISED/,
      );
      expect(await fail(c, KEEPER, 'select inv.start_stock_check($1)', [node()])).toMatch(
        /NOT_AUTHORISED/,
      );
      expect(await fail(c, OTHER_COMPANY, 'select inv.start_stock_check($1)', [node()])).toMatch(
        /NOT_AUTHORISED/,
      );
    });
  });

  it('shows the store keeper and the GM the tags but not the right to count', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10 });
      for (const who of [KEEPER, GM, VERIFIER]) {
        const rows = await ok<{ item_id: string; verified_at: string | null }>(
          c,
          who,
          'select item_id, verified_at from inv.stock_check_view($1)',
          [node()],
        );
        expect(rows.find((r) => r.item_id === f.item('SC-A'))?.verified_at).toBeNull();
      }
      expect(await fail(c, STOCK_USER, 'select * from inv.stock_check_view($1)', [node()])).toMatch(
        /NOT_AUTHORISED/,
      );
      expect(
        await fail(c, OTHER_COMPANY, 'select * from inv.stock_check_view($1)', [node()]),
      ).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('keeps checks of one company out of sight of another', async () => {
    await inRolledBackTx(async (c) => {
      await fixture(c, { 'SC-A': 10 });
      const check = await startCheck(c);
      const seen = await ok(c, OTHER_COMPANY, 'select id from inv.stock_check where id = $1', [
        check,
      ]);
      expect(seen).toEqual([]);
    });
  });
});

describe('a blind check', () => {
  it('snapshots what should be left, hides it from the sheet and orders the sheet by shelf', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10, 'SC-B': 4 });
      const check = await startCheck(c);
      const sheet = await ok<Record<string, unknown>>(
        c,
        VERIFIER,
        'select * from inv.stock_check_sheet($1)',
        [check],
      );
      const ours = sheet.filter((r) => String(r.sku).startsWith('SC-'));
      expect(ours.map((r) => r.item_id)).toEqual([f.item('SC-A'), f.item('SC-B')]);
      expect(sheet[0]).not.toHaveProperty('expected_qty');
      // the same check is resumed, not duplicated
      expect(await startCheck(c)).toBe(check);
    });
  });

  it('matches the expected quantity of the report maths (inv.variance_of)', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10 });
      const check = await startCheck(c);
      const { rows } = await c.query<{ e: string; closing: string }>(
        `select l.expected_qty as e,
                (select closing from inv.variance_of($1, current_date - 1, current_date + 1)
                  where item_id = l.item_id) as closing
           from inv.stock_check_line l where l.check_id = $2 and l.item_id = $3`,
        [node(), check, f.item('SC-A')],
      );
      expect(Number(rows[0]!.e)).toBe(10);
      expect(Number(rows[0]!.closing)).toBe(10);
    });
  });

  it('shows differences only after review, and locks the counts then', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10, 'SC-B': 4 });
      const check = await startCheck(c);
      await count(c, VERIFIER, check, f.item('SC-A'), 10);
      await count(c, VERIFIER, check, f.item('SC-B'), 3);
      const review = await ok<{ item_id: string; difference: string; needs_photo: boolean }>(
        c,
        VERIFIER,
        'select item_id, difference, needs_photo from inv.review_stock_check($1)',
        [check],
      );
      const b = review.find((r) => r.item_id === f.item('SC-B'))!;
      expect(Number(b.difference)).toBe(-1);
      expect(b.needs_photo).toBe(true);
      expect(review.find((r) => r.item_id === f.item('SC-A'))!.needs_photo).toBe(false);
      expect(
        await fail(c, VERIFIER, 'select inv.record_check_line($1, $2, 5)', [check, f.item('SC-B')]),
      ).toMatch(/CHECK_LOCKED/);
    });
  });
});

describe('finishing', () => {
  const photo = (tenant: string) =>
    `stockcheck/${tenant}/${'00000000-0000-0000-0000-000000000001'}/${'0123456789abcdef0123456789abcdef0123'.slice(0, 36)}.jpg`;

  it('needs a photo for every difference, then posts at once with no approval', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10, 'SC-B': 4 });
      const check = await startCheck(c);
      await count(c, VERIFIER, check, f.item('SC-A'), 10);
      await count(c, VERIFIER, check, f.item('SC-B'), 3);
      await ok(c, VERIFIER, 'select * from inv.review_stock_check($1)', [check]);
      expect(await fail(c, VERIFIER, 'select inv.finish_stock_check($1)', [check])).toMatch(
        /PHOTO_REQUIRED/,
      );
      const key = `stockcheck/${f.tenant}/${node()}/0123456789abcdef0123456789abcdef0123.jpg`;
      expect(photo(f.tenant)).toBeTruthy();
      await ok(c, VERIFIER, 'select inv.record_check_line($1, $2, null, $3)', [
        check,
        f.item('SC-B'),
        key,
      ]);
      const [done] = await ok<{ r: { adjusted: number; matched: number } }>(
        c,
        VERIFIER,
        'select inv.finish_stock_check($1) as r',
        [check],
      );
      expect(done!.r).toMatchObject({ adjusted: 1, matched: 1 });
      expect(await onHand(c, f.item('SC-B'))).toBe(3);
      expect(await onHand(c, f.item('SC-A'))).toBe(10);
      const adj = await c.query(`select 1 from inv.stock_adjustment where source_id = $1`, [check]);
      expect(adj.rowCount).toBe(0); // no approval step
      const ledger = await c.query<{ movement_type: string; ref_type: string }>(
        `select movement_type, ref_type from inv.stock_ledger
          where item_id = $1 and movement_type = 'count_adjust'`,
        [f.item('SC-B')],
      );
      expect(ledger.rows).toEqual([{ movement_type: 'count_adjust', ref_type: 'stock_check' }]);
    });
  });

  it('refuses a photo that was not uploaded for this store', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10 });
      const check = await startCheck(c);
      await count(c, VERIFIER, check, f.item('SC-A'), 9);
      await ok(c, VERIFIER, 'select * from inv.review_stock_check($1)', [check]);
      expect(
        await fail(c, VERIFIER, 'select inv.record_check_line($1, $2, null, $3)', [
          check,
          f.item('SC-A'),
          'stockcheck/elsewhere/x.jpg',
        ]),
      ).toMatch(/INVALID_PHOTO/);
    });
  });

  it('tags the items verified, with who and when', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10, 'SC-B': 4 });
      const check = await startCheck(c);
      await count(c, VERIFIER, check, f.item('SC-A'), 10);
      await ok(c, VERIFIER, 'select * from inv.review_stock_check($1)', [check]);
      await ok(c, VERIFIER, 'select inv.finish_stock_check($1)', [check]);
      const rows = await ok<{ item_id: string; verified_at: string | null; verified_by: string }>(
        c,
        GM,
        'select item_id, verified_at, verified_by from inv.stock_check_view($1)',
        [node()],
      );
      const a = rows.find((r) => r.item_id === f.item('SC-A'))!;
      expect(a.verified_at).not.toBeNull();
      expect(a.verified_by).toMatch(/Cost Controller/);
      expect(rows.find((r) => r.item_id === f.item('SC-B'))!.verified_at).toBeNull();
    });
  });

  it('tells the heads of the team and the GM about a difference, not the verifier', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10 });
      const check = await startCheck(c);
      await count(c, VERIFIER, check, f.item('SC-A'), 8);
      await ok(c, VERIFIER, 'select * from inv.review_stock_check($1)', [check]);
      const key = `stockcheck/${f.tenant}/${node()}/0123456789abcdef0123456789abcdef0123.jpg`;
      await ok(c, VERIFIER, 'select inv.record_check_line($1, $2, null, $3)', [
        check,
        f.item('SC-A'),
        key,
      ]);
      await ok(c, VERIFIER, 'select inv.finish_stock_check($1)', [check]);
      const told = async (who: string) =>
        (
          await c.query(
            `select 1 from ops.notification where owner_user_id = $1 and kind = 'stock_check' and created_at = now()`,
            [ids.user(who)],
          )
        ).rowCount;
      expect(await told(KEEPER)).toBe(1);
      expect(await told(GM)).toBe(1);
      expect(await told(VERIFIER)).toBe(0);
    });
  });

  it('cannot be finished twice or changed after', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10 });
      const check = await startCheck(c);
      await count(c, VERIFIER, check, f.item('SC-A'), 10);
      await ok(c, VERIFIER, 'select * from inv.review_stock_check($1)', [check]);
      await ok(c, VERIFIER, 'select inv.finish_stock_check($1)', [check]);
      expect(await fail(c, VERIFIER, 'select inv.finish_stock_check($1)', [check])).toMatch(
        /CHECK_FINISHED/,
      );
      expect(
        await fail(c, VERIFIER, 'select inv.record_check_line($1, $2, 1)', [check, f.item('SC-A')]),
      ).toMatch(/CHECK_FINISHED/);
    });
  });
});

describe('bar mode and several devices (INV-7)', () => {
  it('counts full bottles and tenths of an open one', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-GIN': 7.5 });
      const check = await startCheck(c, VERIFIER, 'bar');
      await ok(
        c,
        VERIFIER,
        'select inv.record_check_line($1, $2, null, null, $3, null, $4, $5, $6)',
        [check, f.item('SC-GIN'), 'Back bar', 'phone-1', 7, 5],
      );
      const review = await ok<{ difference: string }>(
        c,
        VERIFIER,
        'select difference from inv.review_stock_check($1)',
        [check],
      );
      expect(Number(review[0]!.difference)).toBe(0);
      expect(
        await fail(
          c,
          VERIFIER,
          'select inv.record_check_line($1, $2, null, null, null, null, null, 1, 10)',
          [check, f.item('SC-GIN')],
        ),
      ).toMatch(/INVALID_QUANTITY/);
    });
  });

  it('lets two devices count different areas of one check', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10, 'SC-B': 4 });
      const check = await startCheck(c);
      await ok(c, VERIFIER, 'select inv.record_check_line($1, $2, 10, null, $3, null, $4)', [
        check,
        f.item('SC-A'),
        'Shelf A',
        'phone-1',
      ]);
      await ok(c, VERIFIER, 'select inv.record_check_line($1, $2, 4, null, $3, null, $4)', [
        check,
        f.item('SC-B'),
        'Cold room',
        'phone-2',
      ]);
      const { rows } = await c.query<{ area: string; device_id: string }>(
        `select area, device_id from inv.stock_check_line
          where check_id = $1 and counted_qty is not null order by area`,
        [check],
      );
      expect(rows).toEqual([
        { area: 'Cold room', device_id: 'phone-2' },
        { area: 'Shelf A', device_id: 'phone-1' },
      ]);
    });
  });
});

describe('offline counts (INV-8)', () => {
  it('keeps the count with the latest original time when a late sync arrives', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10 });
      const check = await startCheck(c);
      const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
      // the newer count syncs first, then an older one that was queued longer
      await ok(c, VERIFIER, 'select inv.record_check_line($1, $2, 9, null, null, $3)', [
        check,
        f.item('SC-A'),
        t(5),
      ]);
      await ok(c, VERIFIER, 'select inv.record_check_line($1, $2, 8, null, null, $3)', [
        check,
        f.item('SC-A'),
        t(30),
      ]);
      const { rows } = await c.query<{ counted_qty: string }>(
        'select counted_qty from inv.stock_check_line where check_id = $1 and item_id = $2',
        [check, f.item('SC-A')],
      );
      expect(Number(rows[0]!.counted_qty)).toBe(9);
    });
  });

  it('refuses a time in the future', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10 });
      const check = await startCheck(c);
      expect(
        await fail(c, VERIFIER, 'select inv.record_check_line($1, $2, 9, null, null, $3)', [
          check,
          f.item('SC-A'),
          new Date(Date.now() + 3_600_000).toISOString(),
        ]),
      ).toMatch(/INVALID_TIME/);
    });
  });
});

describe('offline wastage (INV-8)', () => {
  it('posts with the original time, and a repeat of the same key posts once', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10 });
      const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
      const lines = JSON.stringify([{ item_id: f.item('SC-A'), qty: 1, reason: 'spoiled' }]);
      const first = await ok<{ id: string }>(
        c,
        KEEPER,
        'select inv.record_wastage_at($1, $2::jsonb, $3, $4) as id',
        [node(), lines, 'w-key-1', at],
      );
      const again = await ok<{ id: string }>(
        c,
        KEEPER,
        'select inv.record_wastage_at($1, $2::jsonb, $3, $4) as id',
        [node(), lines, 'w-key-1', at],
      );
      expect(again[0]!.id).toBe(first[0]!.id);
      const { rows } = await c.query<{ n: string; secs: string }>(
        `select count(*) as n, max(extract(epoch from (occurred_at - $2::timestamptz))) as secs
           from inv.stock_ledger where ref_id = $1`,
        [first[0]!.id, at],
      );
      expect(Number(rows[0]!.n)).toBe(1);
      expect(Math.abs(Number(rows[0]!.secs))).toBeLessThan(1);
      expect(await onHand(c, f.item('SC-A'))).toBe(9);
    });
  });

  it('refuses wastage older than 24 hours or from the future, and a stock user without access', async () => {
    await inRolledBackTx(async (c) => {
      const f = await fixture(c, { 'SC-A': 10 });
      const lines = JSON.stringify([{ item_id: f.item('SC-A'), qty: 1, reason: 'spoiled' }]);
      const q = 'select inv.record_wastage_at($1, $2::jsonb, $3, $4) as id';
      const old = new Date(Date.now() - 30 * 3_600_000).toISOString();
      const future = new Date(Date.now() + 3_600_000).toISOString();
      expect(await fail(c, KEEPER, q, [node(), lines, 'k1', old])).toMatch(/INVALID_TIME/);
      expect(await fail(c, KEEPER, q, [node(), lines, 'k2', future])).toMatch(/INVALID_TIME/);
      expect(
        await fail(c, OTHER_COMPANY, q, [node(), lines, 'k3', new Date().toISOString()]),
      ).toMatch(/NOT_AUTHORISED/);
    });
  });
});

describe('test data for the stock check', () => {
  it('has shelves in Bar 3.0’s bar store, so the bar sheet is shelf-ordered (INV-7)', async () => {
    await inRolledBackTx(async (c) => {
      const bar = ids.node('TEST-BAR-3.0-BAR-STORE');
      const tenantNode = await c.query<{ shelf: string; n: string }>(
        `select shelf, count(*) as n from inv.item_node
          where delivery_node_id = $1 and shelf is not null group by shelf order by min(shelf_order)`,
        [bar],
      );
      expect(tenantNode.rows.map((r) => r.shelf).sort()).toEqual([
        'Back bar',
        'Bar fridge',
        'Dry store',
        'Wine rack',
      ]);
      expect(tenantNode.rows.reduce((a, r) => a + Number(r.n), 0)).toBe(28);
    });
  });

  it('has an Accountant who verifies stock checks in Test Solo Bar Co., which has no Cost Controller (INV-11)', async () => {
    await inRolledBackTx(async (c) => {
      const solo = ids.node('TEST-SOLO-BAR-KITCHEN-STORE');
      const r = await attemptAs(
        c,
        ids.user('test.solo.accountant'),
        'select inv.start_stock_check($1) as id',
        [solo],
      );
      expect(r.error).toBeUndefined();
      // the bar manager there only sees the tags
      const bm = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        'select inv.start_stock_check($1)',
        [solo],
      );
      expect(bm.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});
