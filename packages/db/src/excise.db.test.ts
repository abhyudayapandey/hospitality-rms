import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Excise (ADR 096): Test Company's liquor, wine and beer are under excise (file 10). The daily
// bar register and the FLR of Hotel 1.0's bar store come from the ledger, so their closing is
// what the store holds and each day starts where the one before ended. Permits are kept at the
// store by whoever holds EXCISE there.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const BAR_STORE = 'TEST-HOTEL-1.0-BAR-STORE';

async function run<T extends object = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  sql: string,
  params: unknown[] = [],
) {
  const r = await attemptAs<T>(c, ids.user(who), sql, params);
  if (r.error) throw new Error(`${who}: ${r.error}`);
  return r.rows!;
}

interface Line {
  item: string;
  opening: string;
  received: string;
  sold: string;
  sent: string;
  used: string;
  wasted: string;
  adjusted: string;
  closing: string;
}

const today = async (c: PoolClient) =>
  (
    await c.query<{ d: string }>(
      `select ((now() at time zone ops.tz_of($1)) - interval '4 hours')::date::text as d`,
      [ids.node(BAR_STORE)],
    )
  ).rows[0]!.d;

describe('the bar register', () => {
  it("today's closing is what the store holds, and each line adds up", async () => {
    await inRolledBackTx(async (c) => {
      const lines = await run<Line>(
        c,
        'test.bar-manager.1.0',
        `select item, opening::text, received::text, sold::text, sent::text, used::text,
                wasted::text, adjusted::text, closing::text
           from inv.excise_register($1, $2)`,
        [ids.node(BAR_STORE), await today(c)],
      );
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.map((l) => l.item)).not.toContain('Test Orange Juice');
      const held = await c.query<{ name: string; n: string }>(
        `select i.name, inv.on_hand(i.id, $1)::text as n from inv.item i
          join inv.item_node x on x.item_id = i.id and x.delivery_node_id = $1
         where i.excise`,
        [ids.node(BAR_STORE)],
      );
      const onHand = new Map(held.rows.map((r) => [r.name, Number(r.n)]));
      for (const l of lines) {
        expect(Number(l.closing), l.item).toBe(onHand.get(l.item));
        const sum =
          Number(l.opening) +
          Number(l.received) -
          Number(l.sold) -
          Number(l.sent) -
          Number(l.used) -
          Number(l.wasted) +
          Number(l.adjusted);
        expect(sum, l.item).toBeCloseTo(Number(l.closing), 6);
      }
    });
  });

  it('a day opens where the day before closed; the month closes where its last day does', async () => {
    await inRolledBackTx(async (c) => {
      const day = await today(c);
      const yesterday = (await c.query<{ d: string }>(`select ($1::date - 1)::text as d`, [day]))
        .rows[0]!.d;
      const q = `select item, opening::text, closing::text from inv.excise_register($1, $2)`;
      const y = await run<Line>(c, 'test.general-manager.1.0', q, [ids.node(BAR_STORE), yesterday]);
      const t = await run<Line>(c, 'test.general-manager.1.0', q, [ids.node(BAR_STORE), day]);
      expect(t.map((l) => [l.item, l.opening])).toEqual(y.map((l) => [l.item, l.closing]));
      const m = await run<Line>(
        c,
        'test.general-manager.1.0',
        `select item, closing::text from inv.excise_month($1, $2)`,
        [ids.node(BAR_STORE), day],
      );
      // the month runs to the end of its last business day, which is today or later
      expect(m.map((l) => [l.item, l.closing])).toEqual(t.map((l) => [l.item, l.closing]));
    });
  });

  it('a bottle sold today shows as sold', async () => {
    await inRolledBackTx(async (c) => {
      const vodka = (
        await c.query<{ id: string }>(`select id from inv.item where tenant_id = $1 and sku = $2`, [
          ids.tenant(),
          'VODKA-750ML',
        ])
      ).rows[0]!.id;
      const before = await run<Line>(
        c,
        'test.bar-manager.1.0',
        `select sold::text from inv.excise_register($1, $2) where item_id = $3`,
        [ids.node(BAR_STORE), await today(c), vodka],
      );
      await c.query(`select inv.post($1, $2, 'sales_depletion', -1, 0, 'test', null)`, [
        vodka,
        ids.node(BAR_STORE),
      ]);
      const after = await run<Line>(
        c,
        'test.bar-manager.1.0',
        `select sold::text from inv.excise_register($1, $2) where item_id = $3`,
        [ids.node(BAR_STORE), await today(c), vodka],
      );
      expect(Number(after[0]!.sold) - Number(before[0]!.sold)).toBe(1);
    });
  });

  it('only for those who hold EXCISE; permits once each', async () => {
    await inRolledBackTx(async (c) => {
      const head = await attemptAs(
        c,
        ids.user('test.head-bartender.1.0'),
        `select * from inv.excise_register($1, current_date)`,
        [ids.node(BAR_STORE)],
      );
      expect(head.error).toMatch(/NOT_AUTHORISED/);
      await run(
        c,
        'test.bar-manager.1.0',
        `select inv.add_excise_permit($1, 'TP-2026-0042', current_date, '2 FOC bottles')`,
        [ids.node(BAR_STORE)],
      );
      const again = await attemptAs(
        c,
        ids.user('test.bar-manager.1.0'),
        `select inv.add_excise_permit($1, 'tp-2026-0042', current_date, null)`,
        [ids.node(BAR_STORE)],
      );
      expect(again.error).toMatch(/INVALID_VALUE/);
      const permits = await run<{ permit_no: string; note: string }>(
        c,
        'test.cost-controller.1.0',
        `select permit_no, note from inv.excise_permits($1)`,
        [ids.node(BAR_STORE)],
      );
      expect(permits).toEqual([{ permit_no: 'TP-2026-0042', note: '2 FOC bottles' }]);
    });
  });
});

describe('covers (ADR 096)', () => {
  it('given by those who open the outlet’s sales; nobody else', async () => {
    await inRolledBackTx(async (c) => {
      const outlet = ids.node('TEST-HOTEL-1.0');
      const gm = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        `select ops.set_covers($1, rpt.today($1), 'lunch', 42)`,
        [outlet],
      );
      expect(gm.error).toBeUndefined();
      for (const who of ['test.steward.1.0', 'test.captain.1.0']) {
        const r = await attemptAs(
          c,
          ids.user(who),
          `select ops.set_covers($1, rpt.today($1), 'lunch', 1)`,
          [outlet],
        );
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
      }
      const wrong = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        `select ops.set_covers($1, rpt.today($1), 'brunch', 1)`,
        [outlet],
      );
      expect(wrong.error).toMatch(/INVALID_VALUE/);
    });
  });
});
