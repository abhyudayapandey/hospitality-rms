import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Stock movements (ADR 122) on the test data: Test Hotel 1.0's orders (file 33) and Test
// Company's central kitchen transfers (file 36). Each line adds up to the ledger behind it; the
// GM, the purchase manager and whoever reads the stores' bills open it, a bartender does not.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const HOTEL = 'TEST-HOTEL-1.0-SUPPLY';
const KS = 'TEST-HOTEL-1.0-KITCHEN-STORE';

interface Move {
  kind: string;
  store: string;
  other: string | null;
  direction: string;
  status: string | null;
  value: string;
  lines: { item: string; qty: string; value: string }[];
}

async function as<T extends object>(c: PoolClient, user: string, sql: string, params: unknown[]) {
  const r = await attemptAs<T>(c, ids.user(user), sql, params);
  if (r.error !== undefined) throw new Error(`${user}: ${r.error}`);
  return r.rows;
}

const period = async (c: PoolClient) =>
  (
    await c.query<{ from: string; to: string }>(
      `select (rpt.today($1) - 40)::text as from, rpt.today($1)::text as to`,
      [ids.node(KS)],
    )
  ).rows[0]!;

const moves = async (c: PoolClient, user: string, place: string, from: string, to: string) =>
  as<Move>(
    c,
    user,
    `select kind, store, other, direction, status, value::text, lines
       from rpt.stock_movements($1, $2, $3)`,
    [ids.node(place), from, to],
  );

const sum = (rows: { value: string }[]) =>
  Math.round(rows.reduce((t, r) => t + Number(r.value), 0) * 100) / 100;

describe('stock movements', () => {
  it("the hotel's orders and receipts: each line is its items, and receipts are the ledger's", async () => {
    await inRolledBackTx(async (c) => {
      const { from, to } = await period(c);
      const rows = await moves(c, 'test.general-manager.1.0', HOTEL, from, to);
      const ordered = rows.filter((r) => r.kind === 'ordered');
      const received = rows.filter((r) => r.kind === 'received');
      // file 33: PO-1 to PO-4 at the kitchen store
      expect(ordered.length).toBe(4);
      expect(ordered.every((r) => r.store === 'Test Hotel & Bar 1.0 – Kitchen Store')).toBe(true);
      expect(new Set(ordered.map((r) => r.status))).toContain('received');
      for (const r of [...ordered, ...received]) {
        expect(Number(r.value), JSON.stringify(r)).toBeCloseTo(sum(r.lines), 2);
      }
      const ledger = (
        await c.query<{ v: string }>(
          `select coalesce(round(sum(l.qty * l.unit_cost), 2), 0)::text as v
             from inv.stock_ledger l join inv.goods_receipt g on g.id = l.ref_id
            where l.ref_type = 'goods_receipt' and l.movement_type = 'receipt'
              and g.delivery_node_id in (select h.id from core.hierarchy_node h
                                          where h.code like 'TEST-HOTEL-1.0-%')
              and rpt.business_date(g.received_at, 'Asia/Kolkata') between $1 and $2`,
          [from, to],
        )
      ).rows[0]!.v;
      expect(received.length).toBeGreaterThan(0);
      expect(sum(received)).toBeCloseTo(Number(ledger), 2);
      // one store is its own part of the outlet's list
      const ks = await moves(c, 'test.general-manager.1.0', KS, from, to);
      expect(ks.filter((r) => r.kind !== 'transfer').length).toBe(ordered.length + received.length);
    });
  });

  it("transfers: out of the central kitchen, into the outlet's store, at the ledger's value", async () => {
    await inRolledBackTx(async (c) => {
      const { from, to } = await period(c);
      const out = (
        await moves(c, 'test.account-owner', 'TEST-CENTRAL-KITCHEN-STORE', from, to)
      ).filter((r) => r.kind === 'transfer');
      expect(out.length).toBe(2);
      expect(out.every((r) => r.direction === 'out')).toBe(true);
      const ledger = (
        await c.query<{ v: string }>(
          `select coalesce(round(-sum(l.qty * l.unit_cost), 2), 0)::text as v
             from inv.stock_ledger l join inv.transfer t on t.id = l.ref_id
            where l.ref_type = 'transfer' and l.movement_type = 'transfer_out'
              and t.from_node_id = $1
              and rpt.business_date(t.dispatched_at, 'Asia/Kolkata') between $2 and $3`,
          [ids.node('TEST-CENTRAL-KITCHEN-STORE'), from, to],
        )
      ).rows[0]!.v;
      expect(sum(out)).toBeCloseTo(Number(ledger), 2);
      const into = (
        await moves(c, 'test.general-manager.1.1', 'TEST-HOTEL-1.1-KITCHEN-STORE', from, to)
      ).filter((r) => r.kind === 'transfer');
      expect(into).toHaveLength(1);
      expect(into[0]).toMatchObject({ direction: 'in', status: 'received' });
    });
  });

  it('the GM, the purchase manager and the accountant open it; a bartender and another outlet do not', async () => {
    await inRolledBackTx(async (c) => {
      const { from, to } = await period(c);
      for (const who of ['test.general-manager.1.0', 'test.purchase-manager.1.0']) {
        const places = await as<{ code: string }>(
          c,
          who,
          `select code from rpt.report_places('movements')`,
          [],
        );
        expect(
          places.map((p) => p.code),
          who,
        ).toEqual(expect.arrayContaining([HOTEL, KS, 'TEST-HOTEL-1.0-BAR-STORE']));
        const reports = await as<{ report: string }>(
          c,
          who,
          `select report from rpt.my_reports()`,
          [],
        );
        expect(
          reports.map((r) => r.report),
          who,
        ).toContain('movements');
        await moves(c, who, HOTEL, from, to);
      }
      const acct = await as<{ code: string }>(
        c,
        'test.solo.accountant',
        `select code from rpt.report_places('movements')`,
        [],
      );
      expect(acct.map((p) => p.code)).toContain('TEST-SOLO-BAR-BAR-STORE');
      for (const [who, place] of [
        ['test.bartender.1.0', HOTEL],
        ['test.bartender.1.0', 'TEST-HOTEL-1.0-BAR-STORE'],
        ['test.general-manager.1.0', 'TEST-HOTEL-1.1-SUPPLY'],
        ['test.solo.accountant', HOTEL],
      ] as const) {
        const r = await attemptAs(
          c,
          ids.user(who),
          `select * from rpt.stock_movements($1, $2, $3)`,
          [ids.node(place), from, to],
        );
        expect(r.error, `${who} at ${place}`).toMatch(/NOT_AUTHORISED/);
      }
      const bartender = await as<{ report: string }>(
        c,
        'test.bartender.1.0',
        `select report from rpt.my_reports()`,
        [],
      );
      expect(bartender.map((r) => r.report)).not.toContain('movements');
    });
  });

  it('a year at most, and never backwards', async () => {
    await inRolledBackTx(async (c) => {
      for (const [from, to] of [
        ['2026-01-01', '2027-02-01'],
        ['2026-03-02', '2026-03-01'],
      ]) {
        const r = await attemptAs(
          c,
          ids.user('test.general-manager.1.0'),
          `select * from rpt.stock_movements($1, $2, $3)`,
          [ids.node(HOTEL), from, to],
        );
        expect(r.error).toMatch(/INVALID_VALUE/);
      }
    });
  });
});
