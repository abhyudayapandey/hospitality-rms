import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Every figure on a report opens its trend (RPT-12, ADR 041): rpt.measure_trend gives one
// measure of one report at one place by day, week or month. By day it is the figure the
// report shows for that day; by week or month the money and counts add up and the
// percentages are worked out again from what they are a share of. It opens exactly where
// the report opens, and labour only for people who see labour on the report.

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

interface Point {
  period: string;
  value: string | null;
}
const trend = (
  c: PoolClient,
  who: string,
  report: string,
  node: string,
  measure: string,
  grain = 'day',
  from = daysBefore(13),
  to = BUSINESS_DAY,
  key: string | null = null,
) =>
  attemptAs<Point>(
    c,
    ids.user(who),
    `select period::text as period, value::text as value
       from rpt.measure_trend($1, $2, $3, $4, $5::date, $6::date, $7)`,
    [report, node, measure, grain, from, to, key],
  );

/** The report's own figure for each day: rpt.outlet_flash or rpt.department_day. */
async function daily(
  c: PoolClient,
  who: string,
  fn: 'outlet_flash' | 'department_day',
  node: string,
  days: string[],
): Promise<Map<string, Map<string, string | null>>> {
  const out = new Map<string, Map<string, string | null>>();
  for (const day of days) {
    const r = await attemptAs<{ measure: string; value: string | null }>(
      c,
      ids.user(who),
      `select measure, value::text as value from rpt.${fn}($1, $2::date)`,
      [node, day],
    );
    expect(r.error, `${fn} ${day}`).toBeUndefined();
    out.set(day, new Map(r.rows!.map((x) => [x.measure, x.value])));
  }
  return out;
}

const OUTLET_MEASURES = [
  'sales',
  'food_sales',
  'bar_sales',
  'food_cost_pct',
  'bar_cost_pct',
  'wastage',
  'wastage_pct',
  'stock_value',
  'scheduled_hours',
  'worked_hours',
  'open_slots',
  'late',
  'no_shows',
  'task_pct',
  'tasks_due',
  'overdue',
  'flagged',
  'labour_cost',
  'labour_pct',
  'splh',
  'prime_cost',
  'prime_cost_pct',
];
const LABOUR = ['labour_cost', 'labour_pct', 'prime_cost', 'prime_cost_pct'];
const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

describe("the outlet's figures", () => {
  it('by day, each is what the outlet report shows for that day', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const days = Array.from({ length: 8 }, (_, i) => daysBefore(7 - i));
      const flash = await daily(c, 'test.general-manager.1.0', 'outlet_flash', hotel, days);
      for (const m of OUTLET_MEASURES) {
        const r = await trend(
          c,
          'test.general-manager.1.0',
          'outlet_flash',
          hotel,
          m,
          'day',
          days[0],
        );
        expect(r.error, m).toBeUndefined();
        expect(r.rows!.map((p) => p.period)).toEqual(days);
        for (const p of r.rows!) {
          const want = num(flash.get(p.period)!.get(m));
          const got = num(p.value);
          if (want === null) expect(got, `${m} ${p.period}`).toBeNull();
          else expect(got, `${m} ${p.period}`).toBeCloseTo(want, 1);
        }
      }
    });
  });

  it('by week, money and counts add up and percentages are worked out again', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const from = daysBefore(13);
      const byDay = async (m: string) =>
        (await trend(c, 'test.general-manager.1.0', 'outlet_flash', hotel, m, 'day', from)).rows!;
      const byWeek = async (m: string) =>
        (await trend(c, 'test.general-manager.1.0', 'outlet_flash', hotel, m, 'week', from)).rows!;
      const weekOf = (d: string) => {
        const x = new Date(`${d}T00:00:00Z`);
        x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
        return x.toISOString().slice(0, 10);
      };
      const sales = await byDay('sales');
      const food = await byDay('food_sales');
      const foodPct = await byDay('food_cost_pct');
      const stock = await byDay('stock_value');
      const weeks = await byWeek('sales');
      expect(weeks.length).toBeGreaterThanOrEqual(2);
      for (const w of weeks) {
        const inWeek = (rows: Point[]) => rows.filter((p) => weekOf(p.period) === w.period);
        expect(Number(w.value)).toBeCloseTo(
          inWeek(sales).reduce((s, p) => s + Number(p.value), 0),
          2,
        );
        // a week's food cost % is its food cost over its food sales, not an average of days
        const fs = inWeek(food).reduce((s, p) => s + Number(p.value), 0);
        const fc = inWeek(foodPct).reduce(
          (s, p, i) => s + (Number(p.value) * Number(inWeek(food)[i]!.value)) / 100,
          0,
        );
        const wp = (await byWeek('food_cost_pct')).find((x) => x.period === w.period)!;
        if (fs > 0) expect(Number(wp.value)).toBeCloseTo((fc * 100) / fs, 0);
        // stock value is what was held at the end of the week
        const sw = (await byWeek('stock_value')).find((x) => x.period === w.period)!;
        expect(Number(sw.value)).toBeCloseTo(Number(inWeek(stock).at(-1)!.value), 2);
      }
    });
  });

  it('by month over a year: one point a month, from the 1st', async () => {
    await inRolledBackTx(async (c) => {
      const r = await trend(
        c,
        'test.general-manager.1.0',
        'outlet_flash',
        ids.node('TEST-HOTEL-1.0'),
        'sales',
        'month',
        `${daysBefore(360).slice(0, 7)}-01`,
      );
      expect(r.error).toBeUndefined();
      expect(r.rows!.length).toBeGreaterThanOrEqual(12);
      for (const p of r.rows!) expect(p.period.endsWith('-01')).toBe(true);
    });
  });

  it('opens where the outlet report opens; labour only for those who see it there', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      // the cost controller opens the outlet's day, without labour
      expect(
        (await trend(c, 'test.cost-controller.1.0', 'outlet_flash', hotel, 'sales')).error,
      ).toBeUndefined();
      for (const m of LABOUR) {
        expect(
          (await trend(c, 'test.cost-controller.1.0', 'outlet_flash', hotel, m)).error,
          m,
        ).toMatch(/NOT_AUTHORISED/);
      }
      for (const who of [
        'test.steward.1.0',
        'test.executive-chef.1.0',
        'test.general-manager.1.1',
        'test.solo.bar-manager',
      ]) {
        expect((await trend(c, who, 'outlet_flash', hotel, 'sales')).error, who).toMatch(
          /NOT_AUTHORISED/,
        );
      }
    });
  });

  it('refuses a measure the report has not, a bad grain, too long a period or a future day', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const gm = 'test.general-manager.1.0';
      expect((await trend(c, gm, 'outlet_flash', hotel, 'headcount')).error).toMatch(
        /INVALID_MEASURE/,
      );
      expect((await trend(c, gm, 'nonsense', hotel, 'sales')).error).toMatch(/INVALID_MEASURE/);
      expect((await trend(c, gm, 'outlet_flash', hotel, 'sales', 'hour')).error).toMatch(
        /INVALID_GRAIN/,
      );
      expect(
        (await trend(c, gm, 'outlet_flash', hotel, 'sales', 'week', daysBefore(420))).error,
      ).toMatch(/INVALID_DATES/);
      expect(
        (await trend(c, gm, 'outlet_flash', hotel, 'sales', 'day', BUSINESS_DAY, daysBefore(-2)))
          .error,
      ).toMatch(/INVALID_DATE/);
    });
  });
});

describe("a department's figures", () => {
  it('by day, each is what the department report shows; labour only where it shows', async () => {
    await inRolledBackTx(async (c) => {
      const kitchen = ids.node('TEST-HOTEL-1.0-KITCHEN');
      const days = Array.from({ length: 5 }, (_, i) => daysBefore(4 - i));
      const dept = await daily(c, 'test.general-manager.1.0', 'department_day', kitchen, days);
      for (const m of ['worked_hours', 'shifts', 'late', 'task_pct', 'wastage', 'labour_cost']) {
        const r = await trend(
          c,
          'test.general-manager.1.0',
          'department',
          kitchen,
          m,
          'day',
          days[0],
        );
        expect(r.error, m).toBeUndefined();
        for (const p of r.rows!) {
          const want = num(dept.get(p.period)!.get(m));
          if (want === null) expect(num(p.value), `${m} ${p.period}`).toBeNull();
          else expect(num(p.value), `${m} ${p.period}`).toBeCloseTo(want, 1);
        }
      }
      // the executive chef opens the kitchen's report, without labour cost
      expect(
        (await trend(c, 'test.executive-chef.1.0', 'department', kitchen, 'worked_hours')).error,
      ).toBeUndefined();
      expect(
        (await trend(c, 'test.executive-chef.1.0', 'department', kitchen, 'labour_cost')).error,
      ).toMatch(/NOT_AUTHORISED/);
      expect((await trend(c, 'test.commis.1.0', 'department', kitchen, 'shifts')).error).toMatch(
        /NOT_AUTHORISED/,
      );
    });
  });
});

describe('the period reports, a week or a month at a time', () => {
  it('cost of sales: each week is the report over that week', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const r = await trend(
        c,
        'test.cost-controller.1.0',
        'cost_of_sales',
        hotel,
        'food_cost_pct',
        'week',
      );
      expect(r.error).toBeUndefined();
      const last = r.rows!.at(-1)!;
      const report = await attemptAs<{ value: string }>(
        c,
        ids.user('test.cost-controller.1.0'),
        `select value::text as value from rpt.cost_totals($1, $2::date, $3::date)
          where measure = 'food_cost_pct'`,
        [hotel, last.period, BUSINESS_DAY],
      );
      expect(num(last.value)).toBe(num(report.rows![0]?.value));
      expect(
        (await trend(c, 'test.steward.1.0', 'cost_of_sales', hotel, 'food_cost_pct')).error,
      ).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('people, the central kitchen and the stock value open where their reports do', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const ck = ids.node('TEST-CENTRAL-KITCHEN-STORE');
      const store = ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');
      const ok = [
        ['test.general-manager.1.0', 'people', hotel, 'worked_hours'],
        ['test.central-kitchen-manager', 'central_kitchen', ck, 'made_value'],
        ['test.executive-chef.1.0', 'stock_position', store, 'stock_value'],
      ] as const;
      for (const [who, report, node, m] of ok) {
        const r = await trend(c, who, report, node, m, 'week');
        expect(r.error, report).toBeUndefined();
        expect(r.rows!.length, report).toBeGreaterThanOrEqual(2);
      }
      for (const [, report, node, m] of ok) {
        expect((await trend(c, 'test.steward.1.0', report, node, m)).error, report).toMatch(
          /NOT_AUTHORISED/,
        );
      }
      // the stock value at the end of the last week is what the store holds now
      const now = await attemptAs<{ value: string }>(
        c,
        ids.user('test.executive-chef.1.0'),
        `select value::text as value from rpt.stock_summary($1) where measure = 'stock_value'`,
        [store],
      );
      const r = await trend(c, 'test.executive-chef.1.0', 'stock_position', store, 'stock_value');
      expect(Number(r.rows!.at(-1)!.value)).toBeCloseTo(Number(now.rows![0]!.value), 2);
      // a figure of the moment has no trend
      expect(
        (await trend(c, 'test.general-manager.1.0', 'people', hotel, 'leave_balance_days')).error,
      ).toMatch(/INVALID_MEASURE/);
    });
  });

  it("a supplier's fill and a kitchen's dispatch to one store, by the row's key", async () => {
    await inRolledBackTx(async (c) => {
      const hotelStore = ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');
      const fill = await attemptAs<{ supplier_id: string; fill_pct: string }>(
        c,
        ids.user('test.general-manager.1.0'),
        `select supplier_id, fill_pct::text from rpt.supplier_fill($1, $2::date, $3::date)
          order by ordered_value desc limit 1`,
        [hotelStore, daysBefore(29), BUSINESS_DAY],
      );
      expect(fill.error).toBeUndefined();
      const supplier = fill.rows![0]!.supplier_id;
      const r = await trend(
        c,
        'test.general-manager.1.0',
        'purchasing',
        hotelStore,
        'fill_pct',
        'month',
        daysBefore(29),
        BUSINESS_DAY,
        supplier,
      );
      expect(r.error).toBeUndefined();
      expect(r.rows!.some((p) => p.value !== null)).toBe(true);
      // a key is needed, and the steward opens no purchasing
      expect(
        (await trend(c, 'test.general-manager.1.0', 'purchasing', hotelStore, 'fill_pct')).error,
      ).toMatch(/INVALID_MEASURE/);
      expect(
        (
          await trend(
            c,
            'test.steward.1.0',
            'purchasing',
            hotelStore,
            'fill_pct',
            'week',
            daysBefore(13),
            BUSINESS_DAY,
            supplier,
          )
        ).error,
      ).toMatch(/NOT_AUTHORISED/);

      const ck = ids.node('TEST-CENTRAL-KITCHEN-STORE');
      const d = await attemptAs<{ store_id: string }>(
        c,
        ids.user('test.central-kitchen-manager'),
        `select store_id from rpt.kitchen_dispatch($1, $2::date, $3::date) limit 1`,
        [ck, daysBefore(13), BUSINESS_DAY],
      );
      const k = await trend(
        c,
        'test.central-kitchen-manager',
        'central_kitchen',
        ck,
        'fill_pct',
        'week',
        daysBefore(13),
        BUSINESS_DAY,
        d.rows![0]!.store_id,
      );
      expect(k.error).toBeUndefined();
      expect(k.rows!.some((p) => p.value !== null)).toBe(true);
    });
  });
});
