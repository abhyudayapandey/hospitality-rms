import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// What management asks after a figure (owner review, 4 Oct; ADR 042): what is behind it.
// People cost % and Materials % are shares of the total cost (materials + people), not of
// sales, and add up to 100. Each figure opens its breakdown for a week or a month: the
// dishes behind sales and recipe cost, the items behind wastage and the stock value, the
// people behind hours and tasks, the readings that were flagged. Every breakdown adds up
// to the report's figure and opens where the report opens; names of people only for
// those who see the team (WORKERS) or every report (REPORTS).

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const BUSINESS_DAY = new Date(Date.now() - 6 * 3_600_000).toLocaleDateString('en-CA', {
  timeZone: 'Asia/Kolkata',
});
const daysBefore = (n: number) => {
  const d = new Date(`${BUSINESS_DAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const FROM = daysBefore(6);
const GM = 'test.general-manager.1.0';
const OWNER = 'test.account-owner';
const n = (v: unknown) => Number(v ?? 0);
const sum = <T>(rows: T[], k: keyof T) => rows.reduce((s, r) => s + n(r[k]), 0);

async function flash(c: PoolClient, who: string, node: string, day: string) {
  const r = await attemptAs<{ measure: string; value: string | null }>(
    c,
    ids.user(who),
    `select measure, value::text as value from rpt.outlet_flash($1, $2::date)`,
    [node, day],
  );
  expect(r.error).toBeUndefined();
  return new Map(r.rows!.map((x) => [x.measure, x.value]));
}

/** The flash's figure added up over the days FROM..BUSINESS_DAY. */
async function flashSum(c: PoolClient, who: string, node: string, measure: string) {
  let s = 0;
  for (let i = 6; i >= 0; i--) s += n((await flash(c, who, node, daysBefore(i))).get(measure));
  return s;
}

describe('People cost % and Materials % are shares of the total cost', () => {
  it('Outlet today: people ÷ (materials + people), materials the rest; no "of sales"', async () => {
    await inRolledBackTx(async (c) => {
      const m = await flash(c, GM, ids.node('TEST-HOTEL-1.0'), daysBefore(2));
      const materials = n(m.get('cost_materials'));
      const people = n(m.get('labour_cost'));
      expect(people).toBeGreaterThan(0);
      expect(n(m.get('labour_pct'))).toBeCloseTo((people * 100) / (materials + people), 1);
      expect(n(m.get('materials_pct'))).toBeCloseTo((materials * 100) / (materials + people), 1);
      expect(n(m.get('labour_pct')) + n(m.get('materials_pct'))).toBeCloseTo(100, 0);
      expect(n(m.get('prime_cost'))).toBeCloseTo(materials + people, 2);
      expect(m.has('prime_cost_pct')).toBe(false);
      // the cost controller sees no labour, so no shares of it either
      const cc = await flash(c, 'test.cost-controller.1.0', ids.node('TEST-HOTEL-1.0'), daysBefore(2));
      expect(cc.has('labour_pct')).toBe(false);
      expect(cc.has('materials_pct')).toBe(false);
    });
  });

  it('the cost breakdown gives each part as a share of the total cost', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs<{ part: string; value: string; pct: string }>(
        c,
        ids.user(GM),
        `select part, value::text as value, pct::text as pct
           from rpt.cost_breakdown($1, $2::date, $3::date)`,
        [ids.node('TEST-HOTEL-1.0'), FROM, BUSINESS_DAY],
      );
      expect(r.error).toBeUndefined();
      const p = new Map(r.rows!.map((x) => [x.part, x]));
      expect(n(p.get('prime')!.pct)).toBeCloseTo(100, 1);
      expect(n(p.get('materials')!.pct) + n(p.get('labour')!.pct)).toBeCloseTo(100, 0);
      // without labour the total is the materials
      const cc = await attemptAs<{ part: string; pct: string }>(
        c,
        ids.user('test.cost-controller.1.0'),
        `select part, pct::text as pct from rpt.cost_breakdown($1, $2::date, $3::date)`,
        [ids.node('TEST-HOTEL-1.0'), FROM, BUSINESS_DAY],
      );
      expect(n(cc.rows!.find((x) => x.part === 'materials')!.pct)).toBeCloseTo(100, 1);
    });
  });

  it('Outlets side by side: people cost % of total cost, materials % next to it', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs<{ code: string; labour_pct: string; materials_pct: string }>(
        c,
        ids.user('test.account-owner'),
        `select code, labour_pct::text, materials_pct::text
           from rpt.league($1, $2::date, $3::date)`,
        [ids.node('TEST-AREA-MUMBAI'), FROM, BUSINESS_DAY],
      );
      expect(r.error).toBeUndefined();
      const hotel = r.rows!.find((x) => x.code === 'TEST-HOTEL-1.0')!;
      expect(n(hotel.labour_pct) + n(hotel.materials_pct)).toBeCloseTo(100, 0);
    });
  });

  it('targets: People cost % is a share of cost; there is no prime cost target', async () => {
    await inRolledBackTx(async (c) => {
      const set = (targets: Record<string, number>) =>
        attemptAs(c, ids.user('test.account-owner'), 'select core.set_company_settings($1)', [
          JSON.stringify({ targets }),
        ]);
      expect((await set({ labour: 50 })).error).toBeUndefined();
      expect((await set({ prime: 60 })).error).toMatch(/INVALID_SETTING/);
      const d = await c.query<{ t: Record<string, number> }>(
        `select core.settings_defaults() -> 'targets' as t`,
      );
      expect(d.rows[0]!.t.labour).toBe(50);
      expect(d.rows[0]!.t).not.toHaveProperty('prime');
    });
  });
});

describe('what is behind each figure', () => {
  it('sales and recipe cost by dish add up to the outlet figures', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const r = await attemptAs<{ menu: string; dish: string; qty: string; sales: string; cost: string }>(
        c,
        ids.user(GM),
        `select menu, dish, qty::text, sales::text, cost::text
           from rpt.bd_dishes('outlet_flash', $1, $2::date, $3::date)`,
        [hotel, FROM, BUSINESS_DAY],
      );
      expect(r.error).toBeUndefined();
      expect(r.rows!.length).toBeGreaterThan(3);
      expect(sum(r.rows!, 'sales')).toBeCloseTo(await flashSum(c, GM, hotel, 'sales'), 0);
      const food = r.rows!.filter((x) => x.menu === 'Food');
      expect(sum(food, 'sales')).toBeCloseTo(await flashSum(c, GM, hotel, 'food_sales'), 0);
      // highest sales first
      expect(n(r.rows![0]!.sales)).toBeGreaterThanOrEqual(n(r.rows!.at(-1)!.sales));
      expect(
        (
          await attemptAs(c, ids.user('test.steward.1.0'), `select * from rpt.bd_dishes('outlet_flash', $1, $2::date, $3::date)`, [
            hotel,
            FROM,
            BUSINESS_DAY,
          ])
        ).error,
      ).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('wastage by item: what, how much, what it cost, why, who', async () => {
    await inRolledBackTx(async (c) => {
      // the seeded wastage is at Hotel 1.1 (a transit loss in its kitchen store)
      const hotel = ids.node('TEST-HOTEL-1.1');
      const r = await attemptAs<{ item: string; qty: string; unit: string; value: string; reason: string; recorded_by: string }>(
        c,
        ids.user(OWNER),
        `select item, qty::text, unit, value::text, reason, recorded_by
           from rpt.bd_wastage('outlet_flash', $1, $2::date, $3::date)`,
        [hotel, FROM, BUSINESS_DAY],
      );
      expect(r.error).toBeUndefined();
      expect(r.rows!.length).toBeGreaterThan(0);
      expect(sum(r.rows!, 'value')).toBeCloseTo(await flashSum(c, OWNER, hotel, 'wastage'), 0);
      for (const x of r.rows!) {
        expect(n(x.qty)).toBeGreaterThan(0);
        expect(x.unit).toBeTruthy();
      }
    });
  });

  it('stock value by item adds up to the value held now', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const r = await attemptAs<{ item: string; category: string; qty: string; value: string }>(
        c,
        ids.user(GM),
        `select item, category, qty::text, value::text from rpt.bd_stock('outlet_flash', $1)`,
        [hotel],
      );
      expect(r.error).toBeUndefined();
      const now = await flash(c, GM, hotel, BUSINESS_DAY);
      expect(sum(r.rows!, 'value')).toBeCloseTo(n(now.get('stock_value')), -1);
    });
  });

  it("people: each person's shifts, hours, late and no-shows; names only for those who see the team", async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const r = await attemptAs<{
        person: string;
        rostered_hours: string;
        worked_hours: string;
        late: string;
        no_shows: string;
      }>(
        c,
        ids.user(GM),
        `select person, rostered_hours::text, worked_hours::text, late::text, no_shows::text
           from rpt.bd_people('outlet_flash', $1, $2::date, $3::date)`,
        [hotel, FROM, BUSINESS_DAY],
      );
      expect(r.error).toBeUndefined();
      expect(r.rows!.length).toBeGreaterThan(3);
      // the people add up to the outlet's rostered and worked hours, late and no-shows
      expect(sum(r.rows!, 'rostered_hours')).toBeCloseTo(
        await flashSum(c, GM, hotel, 'scheduled_hours'),
        0,
      );
      expect(sum(r.rows!, 'worked_hours')).toBeCloseTo(await flashSum(c, GM, hotel, 'worked_hours'), 0);
      expect(sum(r.rows!, 'late')).toBe(await flashSum(c, GM, hotel, 'late'));
      expect(sum(r.rows!, 'no_shows')).toBe(await flashSum(c, GM, hotel, 'no_shows'));
      // the cost controller opens the outlet's day, but not its people
      expect(
        (
          await attemptAs(c, ids.user('test.cost-controller.1.0'), `select * from rpt.bd_people('outlet_flash', $1, $2::date, $3::date)`, [
            hotel,
            FROM,
            BUSINESS_DAY,
          ])
        ).error,
      ).toMatch(/NOT_AUTHORISED/);
      // the executive chef sees the kitchen's people on the department report
      const k = await attemptAs<{ person: string }>(
        c,
        ids.user('test.executive-chef.1.0'),
        `select person from rpt.bd_people('department', $1, $2::date, $3::date)`,
        [ids.node('TEST-HOTEL-1.0-KITCHEN'), FROM, BUSINESS_DAY],
      );
      expect(k.error).toBeUndefined();
      expect(k.rows!.length).toBeGreaterThan(0);
    });
  });

  it("tasks: each person's due, done on time, overdue and flagged readings", async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const r = await attemptAs<{ person: string; due: string; on_time: string; overdue: string; flagged: string }>(
        c,
        ids.user(GM),
        `select person, due::text, on_time::text, overdue::text, flagged::text
           from rpt.bd_tasks('outlet_flash', $1, $2::date, $3::date)`,
        [hotel, FROM, BUSINESS_DAY],
      );
      expect(r.error).toBeUndefined();
      expect(sum(r.rows!, 'due')).toBe(await flashSum(c, GM, hotel, 'tasks_due'));
      expect(sum(r.rows!, 'overdue')).toBe(await flashSum(c, GM, hotel, 'overdue'));
      expect(sum(r.rows!, 'flagged')).toBe(await flashSum(c, GM, hotel, 'flagged'));
      const rd = await attemptAs<{ task: string; reading: string; value: string; by_name: string }>(
        c,
        ids.user(GM),
        `select task, reading, value, by_name from rpt.bd_readings('outlet_flash', $1, $2::date, $3::date)`,
        [hotel, FROM, BUSINESS_DAY],
      );
      expect(rd.error).toBeUndefined();
      expect(rd.rows!.length).toBe(await flashSum(c, GM, hotel, 'flagged'));
    });
  });

  it('a breakdown opens only where its report does', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      for (const fn of ['bd_wastage', 'bd_tasks', 'bd_readings']) {
        for (const who of ['test.steward.1.0', 'test.general-manager.1.1', 'test.solo.bar-manager']) {
          expect(
            (
              await attemptAs(c, ids.user(who), `select * from rpt.${fn}('outlet_flash', $1, $2::date, $3::date)`, [
                hotel,
                FROM,
                BUSINESS_DAY,
              ])
            ).error,
            `${fn} ${who}`,
          ).toMatch(/NOT_AUTHORISED/);
        }
      }
      expect(
        (await attemptAs(c, ids.user('test.steward.1.0'), `select * from rpt.bd_stock('outlet_flash', $1)`, [hotel]))
          .error,
      ).toMatch(/NOT_AUTHORISED/);
      // a report the breakdown does not belong to
      expect(
        (
          await attemptAs(c, ids.user(GM), `select * from rpt.bd_dishes('people', $1, $2::date, $3::date)`, [
            hotel,
            FROM,
            BUSINESS_DAY,
          ])
        ).error,
      ).toMatch(/INVALID_REPORT/);
      // at most a month at a time
      expect(
        (
          await attemptAs(c, ids.user(GM), `select * from rpt.bd_wastage('outlet_flash', $1, $2::date, $3::date)`, [
            hotel,
            daysBefore(120),
            BUSINESS_DAY,
          ])
        ).error,
      ).toMatch(/INVALID_DATE/);
    });
  });
});
