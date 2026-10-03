import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { as } from '../test/report-access';

// The R-3 figures on the test data (ADR 030), as the test data README states them:
//   file 34  pay rates (monthly rates are a whole number of rupees a day: ₹36,500 = ₹1,200)
//   file 35  Hotel 1.0's past week of sessions
//   file 36  two transfers of onion tomato masala from the central kitchen (to Hotel 1.1,
//            received short; to Bar 3.0, on the road); files 26 and 32 its batches and plan
// Days count back from the load date, so these hold whenever the data was loaded.
// Overtime alone depends on the weekday (the week runs from Monday), so it is worked out
// here from the sessions.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function rows<T extends object>(c: PoolClient, user: string, sql: string, params: unknown[]) {
  const r = await as<T>(c, ids.user(user), sql, params);
  if (r.error !== undefined) throw new Error(`${user}: ${r.error}`);
  return r.rows;
}

/** test.commis.1.0 works 13 hours on each of the last 7 days: what is over 48 a week. */
async function commisOvertime(c: PoolClient): Promise<number> {
  const { rows: days } = await c.query<{ week: string }>(
    `select hr.week_start(current_date - d)::text as week from generate_series(1, 7) d`,
  );
  const perWeek = new Map<string, number>();
  for (const d of days) perWeek.set(d.week, (perWeek.get(d.week) ?? 0) + 13);
  return [...perWeek.values()].reduce((s, h) => s + Math.max(h - 48, 0), 0);
}

describe('labour cost on the test data', () => {
  it('Hotel 1.0 over the last 7 days, department by department', async () => {
    await inRolledBackTx(async (c) => {
      const r = await rows<{
        code: string;
        part: string;
        days: number;
        people: number;
        hours: string;
        cost: string;
      }>(
        c,
        'test.general-manager.1.0',
        `select l.org_node_id as code, l.part, l.days, l.people, l.hours::text, l.cost::text
           from rpt.labour_cost($1, current_date - 7, current_date - 1) l`,
        [ids.node('TEST-HOTEL-1.0')],
      );
      // rows carry the place's id: match them by its code
      const by = (code: string, part = 'department') =>
        r.find((x) => x.code === ids.node(code) && x.part === part);
      expect(by('TEST-HOTEL-1.0', 'outlet')).toMatchObject({
        days: 7,
        people: 42,
        hours: '789.00',
        cost: '465225.00',
      });
      expect(by('TEST-HOTEL-1.0-KITCHEN')).toMatchObject({ days: 7, cost: '69575.00' });
      expect(by('TEST-HOTEL-1.0-RESTAURANT')).toMatchObject({ days: 7, cost: '60000.00' });
      expect(by('TEST-HOTEL-1.0-FRONT-OFFICE')).toMatchObject({ days: 7, cost: '48000.00' });
      expect(by('TEST-HOTEL-1.0-STORES-TEAM')).toMatchObject({ days: 7, cost: '33600.00' });
      // only 2 paid people on the days nobody else came in: those days are in "Other"
      expect(by('TEST-HOTEL-1.0-BAR')).toMatchObject({ days: 6, cost: '45600.00' });
      expect(by('TEST-HOTEL-1.0-HOUSEKEEPING')).toMatchObject({ days: 6, cost: '45600.00' });
      expect(by('TEST-HOTEL-1.0-BANQUETS')).toMatchObject({ days: 2, people: 3, cost: '8450.00' });
      expect(by('TEST-HOTEL-1.0', 'other')).toMatchObject({ days: 7, cost: '154400.00' });
      // never shown on their own: 2 people each
      for (const small of [
        'TEST-HOTEL-1.0-ADMIN-FINANCE',
        'TEST-HOTEL-1.0-ENGINEERING',
        'TEST-HOTEL-1.0-SECURITY',
      ]) {
        expect(by(small), small).toBeUndefined();
      }
      const sum = r.filter((x) => x.part !== 'outlet').reduce((s, x) => s + Number(x.cost), 0);
      expect(sum).toBe(465225);
    });
  });

  it('hourly and salaried parts, and overtime from the weekly cap', async () => {
    await inRolledBackTx(async (c) => {
      const [t] = await rows<{ hourly: string; salary: string; overtime: string }>(
        c,
        'test.general-manager.1.0',
        `select hourly_cost::text as hourly, salary_cost::text as salary,
                overtime_hours::text as overtime
           from rpt.labour_cost($1, current_date - 7, current_date - 1) where part = 'outlet'`,
        [ids.node('TEST-HOTEL-1.0')],
      );
      expect(t).toMatchObject({ hourly: '99825.00', salary: '365400.00' });
      expect(Number(t!.overtime)).toBe(await commisOvertime(c));
      expect(await commisOvertime(c)).toBeGreaterThan(0);
    });
  });

  it('Outlet today, two days ago: ₹69,025 of labour, and prime cost on top of materials', async () => {
    await inRolledBackTx(async (c) => {
      const m = new Map(
        (
          await rows<{ measure: string; value: string | null }>(
            c,
            'test.general-manager.1.0',
            'select measure, value::text from rpt.outlet_flash($1, current_date - 2)',
            [ids.node('TEST-HOTEL-1.0')],
          )
        ).map((x) => [x.measure, x.value]),
      );
      expect(m.get('labour_salary')).toBe('52200.00');
      expect(m.get('labour_hourly')).toBe('16825.00');
      expect(m.get('labour_cost')).toBe('69025.00');
      expect(Number(m.get('prime_cost'))).toBeCloseTo(Number(m.get('cost_materials')) + 69025, 2);
      const sales = Number(m.get('sales'));
      expect(Number(m.get('labour_pct'))).toBeCloseTo((69025 * 100) / sales, 1);
      expect(Number(m.get('splh'))).toBe(Math.round(sales / Number(m.get('worked_hours'))));
    });
  });

  it("Department today: the kitchen's own labour that day", async () => {
    await inRolledBackTx(async (c) => {
      const r = await rows<{ value: string }>(
        c,
        'test.general-manager.1.0',
        `select value::text from rpt.department_day($1, current_date - 2)
          where measure = 'labour_cost'`,
        [ids.node('TEST-HOTEL-1.0-KITCHEN')],
      );
      // 3 salaried (₹6,600 a day), 13 h + 8 h + 8 h at ₹125
      expect(r[0]!.value).toBe('10225.00');
    });
  });

  it('the cost breakdown adds up to the cost of sales, then labour, then prime cost', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const parts = new Map(
        (
          await rows<{ part: string; value: string | null }>(
            c,
            'test.general-manager.1.0',
            'select part, value::text from rpt.cost_breakdown($1, current_date - 7, current_date - 1)',
            [hotel],
          )
        ).map((x) => [x.part, Number(x.value)]),
      );
      const materials = [
        'food_recipe',
        'bar_recipe',
        'expired',
        'transit_loss',
        'wastage_other',
        'other_use',
        'count_loss',
      ].reduce((s, p) => s + parts.get(p)!, 0);
      expect(parts.get('materials')).toBeCloseTo(materials, 1);
      // nothing came short to Hotel 1.0 (the transfers go to Hotel 1.1 and Bar 3.0)
      expect(parts.get('transit_loss')).toBe(0);
      const actual = await c.query<{ cost: string }>(
        `select sum(actual_cost)::text as cost
           from menu.cost_calc($1, rpt.cost_stores($1), current_date - 7, current_date - 1)`,
        [hotel],
      );
      // as the GM sees it (every store of the outlet)
      await c.query(`select set_config('app.user_id', $1, true)`, [
        ids.user('test.general-manager.1.0'),
      ]);
      const asGm = await c.query<{ cost: string }>(
        `select sum(actual_cost)::text as cost
           from menu.cost_calc($1, rpt.cost_stores($1), current_date - 7, current_date - 1)`,
        [hotel],
      );
      expect(Number(asGm.rows[0]!.cost ?? actual.rows[0]!.cost)).toBeCloseTo(
        parts.get('materials')!,
        1,
      );
      expect(parts.get('labour')).toBe(465225);
      expect(parts.get('prime')).toBeCloseTo(parts.get('materials')! + 465225, 1);
      // the cost controller sees the materials, never labour
      const cc = await rows<{ part: string }>(
        c,
        'test.cost-controller.1.0',
        'select part from rpt.cost_breakdown($1, current_date - 7, current_date - 1)',
        [hotel],
      );
      expect(cc.map((x) => x.part)).not.toContain('labour');
      expect(cc.map((x) => x.part)).toContain('materials');
    });
  });
});

describe('the central kitchen on the test data', () => {
  it('made against the plan, dispatched against requests, the transit loss, what is on the road', async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node('TEST-CENTRAL-KITCHEN-STORE');
      const m = new Map(
        (
          await rows<{ measure: string; value: string }>(
            c,
            'test.central-kitchen-manager',
            'select measure, value::text from rpt.kitchen_summary($1, current_date - 6, current_date)',
            [store],
          )
        ).map((x) => [x.measure, x.value]),
      );
      expect(m.get('batches')).toBe('2');
      expect(m.get('transfers')).toBe('2');
      expect(m.get('requested_value')).toBe('492.60');
      expect(m.get('dispatched_value')).toBe('459.76');
      expect(m.get('fill_pct')).toBe('93.3');
      expect(m.get('transit_loss')).toBe('16.42');
      expect(m.get('in_transit_value')).toBe('164.20');

      const made = await rows<{ sku: string; planned: string; made: string; batches: number }>(
        c,
        'test.central-kitchen-manager',
        `select sku, planned::numeric(14,0)::text as planned, made::numeric(14,0)::text as made,
                batches from rpt.kitchen_production($1, current_date - 6, current_date)`,
        [store],
      );
      expect(made).toEqual([
        { sku: 'ONION-TOMATO-MASALA', planned: '11200', made: '9600', batches: 2 },
      ]);

      const sent = await rows<{
        code: string;
        fill_pct: string;
        transit_loss: string;
        short_lines: number;
      }>(
        c,
        'test.central-kitchen-manager',
        `select d.store_id as code, d.fill_pct::text, d.transit_loss::text, d.short_lines
           from rpt.kitchen_dispatch($1, current_date - 6, current_date) d
          order by d.store_name`,
        [store],
      );
      expect(sent).toEqual([
        {
          code: ids.node('TEST-BAR-3.0-KITCHEN-STORE'),
          fill_pct: '100.0',
          transit_loss: '0.00',
          short_lines: 0,
        },
        {
          code: ids.node('TEST-HOTEL-1.1-KITCHEN-STORE'),
          fill_pct: '90.0',
          transit_loss: '16.42',
          short_lines: 1,
        },
      ]);

      const road = await rows<{ store_name: string; value: string }>(
        c,
        'test.central-kitchen-manager',
        'select store_name, value::text from rpt.kitchen_in_transit($1)',
        [store],
      );
      expect(road).toEqual([{ store_name: 'Test Bar 3.0 – Kitchen Store', value: '164.20' }]);
    });
  });

  it("the Hotel 1.1 kitchen's Purchasing: what came from the central kitchen", async () => {
    await inRolledBackTx(async (c) => {
      const r = await rows<{
        from_name: string;
        requested_value: string;
        received_value: string;
        fill_pct: string;
        transit_loss: string;
        short_lines: number;
      }>(
        c,
        'test.executive-chef.1.1',
        `select from_name, requested_value::text, received_value::text, fill_pct::text,
                transit_loss::text, short_lines
           from rpt.transfers_in($1, current_date - 6, current_date)`,
        [ids.node('TEST-HOTEL-1.1-KITCHEN-STORE')],
      );
      // 4,000 g asked for, 3,600 g sent, 3,400 g arrived
      expect(r).toEqual([
        {
          from_name: 'Test Central Kitchen – Store',
          requested_value: '328.40',
          received_value: '279.14',
          fill_pct: '85.0',
          transit_loss: '16.42',
          short_lines: 1,
        },
      ]);
    });
  });
});

describe('the People report on the test data', () => {
  it('HR sees hours, overtime and leave in days; rupees only with labour cost', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const summary = async (u: string) =>
        new Map(
          (
            await rows<{ measure: string; value: string | null }>(
              c,
              u,
              'select measure, value::text from rpt.people_summary($1, current_date - 7, current_date - 1)',
              [hotel],
            )
          ).map((x) => [x.measure, x.value]),
        );
      const hr = await summary('test.hr-executive.1.0');
      expect(hr.get('headcount')).toBe('42');
      expect(hr.get('worked_hours')).toBe('789.00');
      expect(Number(hr.get('overtime_hours'))).toBe(await commisOvertime(c));
      expect(hr.get('leave_balance_days')).toBe('1573.0');
      expect(hr.get('leave_liability')).toBeNull();
      const admin = await summary('test.hr-admin');
      expect(admin.get('leave_liability')).toBe('2582200.00');
      // names: for the people who keep the records, never through REPORTS alone
      const flags = (u: string) =>
        rows(c, u, 'select * from rpt.people_flags($1, current_date - 7, current_date - 1)', [
          hotel,
        ]);
      expect((await flags('test.hr-executive.1.0')).length).toBeGreaterThan(0);
      expect(await flags('test.account-owner')).toEqual([]);
    });
  });
});
