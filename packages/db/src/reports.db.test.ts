import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { newUser } from '../test/workforce';

// The report figures (ADR 023): one definition per measure (rpt.calc_*), stored nightly by
// rpt.rebuild and read live for today and yesterday. The business day runs 06:00 to
// 06:00 local time. The test data's week of sales (file 27) gives figures to check against
// the existing cost report.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const GM = () => ids.user('test.general-manager.1.0');
const n = (v: string | null | undefined) => Number(v ?? 0);

async function today(c: PoolClient, place: string): Promise<string> {
  return (await c.query<{ d: string }>(`select rpt.today($1)::text as d`, [ids.node(place)]))
    .rows[0]!.d;
}

async function flash(c: PoolClient, user: string, outlet: string, day: string) {
  const r = await attemptAs<{ measure: string; value: string | null; last_week: string | null }>(
    c,
    ids.user(user),
    'select measure, value::text, last_week::text from rpt.outlet_flash($1, $2::date)',
    [ids.node(outlet), day],
  );
  if (r.error !== undefined) throw new Error(r.error);
  return new Map(r.rows.map((x) => [x.measure, x]));
}

describe('rpt figures', () => {
  it('sales and recipe cost agree with the cost report for the test week (file 27)', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`select rpt.rebuild(current_date - 10, current_date)`);
      // the test week counts from the load day (a calendar day), not the business day
      const t = (await c.query<{ d: string }>(`select current_date::text as d`)).rows[0]!.d;
      const { rows } = await c.query<{ menu: string; sales: string; pct: string }>(
        `select menu, sum(sales)::text sales,
                round(sum(theoretical_cost) * 100 / sum(sales), 1)::text pct
           from rpt.sales_day
          where org_node_id = $1 and business_date between $2::date - 6 and $2::date - 1
          group by menu order by menu`,
        [ids.node('TEST-HOTEL-1.0'), t],
      );
      // docs/onboarding/test-data/README.md, "Cost %"
      expect(rows).toEqual([
        { menu: 'Bar', sales: '107550.00', pct: '34.4' },
        { menu: 'Food', sales: '37620.00', pct: '21.5' },
      ]);
      const report = await attemptAs<{ menu: string; revenue: string; theoretical_pct: string }>(
        c,
        GM(),
        `select menu, revenue::text, theoretical_pct::text
           from menu.cost_report($1, $2::date - 6, $2::date - 1) order by menu`,
        [ids.node('TEST-HOTEL-1.0'), t],
      );
      expect(report.rows!.map((r) => [r.menu, r.revenue, r.theoretical_pct])).toEqual(
        rows.map((r) => [r.menu, r.sales, r.pct]),
      );
    });
  });

  it('the flash: a stored day and a live day give the same figures', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`select rpt.rebuild(current_date - 10, current_date)`);
      const t = await today(c, 'TEST-HOTEL-1.0');
      const day = (await c.query<{ d: string }>(`select ($1::date - 3)::text d`, [t])).rows[0]!.d;
      const stored = await flash(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0', day);
      expect(n(stored.get('sales')!.value)).toBe(24195); // 107550/6 + 37620/6
      expect(n(stored.get('food_cost_pct')!.value)).toBe(21.5);
      // the same day computed live matches what was stored
      const live = await c.query<{ sales: string }>(
        `select sum(sales)::text sales from rpt.calc_sales_day(array[$1::uuid], $2::date, $2::date)`,
        [ids.node('TEST-HOTEL-1.0'), day],
      );
      expect(n(live.rows[0]!.sales)).toBe(24195);
      // today is live: no stored row needed
      await c.query(`delete from rpt.store_day`);
      const now = await flash(c, 'test.general-manager.1.0', 'TEST-HOTEL-1.0', t);
      expect(n(now.get('stock_value')!.value)).toBeGreaterThan(0);
    });
  });

  it('a stock movement at 02:00 belongs to the business day before (06:00 cut-off)', async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');
      const item = (
        await c.query<{ id: string }>(
          `select item_id as id from inv.stock_level where delivery_node_id = $1 and on_hand > 1
            order by item_id limit 1`,
          [store],
        )
      ).rows[0]!.id;
      const day = '2026-09-10';
      for (const [time, qty] of [
        ['02:00', -1],
        ['07:00', -0.5],
      ] as const) {
        await c.query(
          `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                         unit_cost, ref_type, occurred_at)
           values ($1, $2, $3, 'wastage', $4, 100, 'test', ($5::date + $6::time) at time zone 'Asia/Kolkata')`,
          [ids.tenant(), item, store, qty, day, time],
        );
      }
      const { rows } = await c.query<{ business_date: string; wastage: string }>(
        `select business_date::text, wastage::text
           from rpt.calc_store_day(array[$1::uuid], '2026-09-09', '2026-09-10') order by 1`,
        [store],
      );
      expect(rows).toEqual([
        { business_date: '2026-09-09', wastage: '100.00' },
        { business_date: '2026-09-10', wastage: '50.00' },
      ]);
    });
  });

  it('store days chain: each closing is the next opening, and opening + movements = closing', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{
        day: string;
        opening: string;
        closing: string;
        moved: string;
      }>(
        `select business_date::text as day, opening_value::text opening, closing_value::text closing,
                (receipts + transfers_in - transfers_out + production_in - production_out
                 - wastage + count_adjust - sales_use - other_use)::text moved
           from rpt.calc_store_day(array[$1::uuid], current_date - 8, current_date)
          order by business_date`,
        [ids.node('TEST-HOTEL-1.0-BAR-STORE')],
      );
      expect(rows.length).toBe(9);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        expect(Math.abs(n(r.opening) + n(r.moved) - n(r.closing))).toBeLessThanOrEqual(0.1);
        if (i > 0) expect(r.opening).toBe(rows[i - 1]!.closing);
      }
      // the week's sales used stock from the bar store
      expect(rows.some((r) => n(r.moved) < 0)).toBe(true);
    });
  });

  it('a second rebuild changes nothing, so the audit log records changes, not runs', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`select rpt.rebuild(current_date - 10, current_date)`);
      const before = await c.query<{ n: number }>(
        `select count(*)::int n from audit.log where table_name like 'rpt.%'`,
      );
      const again = await c.query<{ n: number }>(
        `select rpt.rebuild(current_date - 10, current_date) as n`,
      );
      expect(again.rows[0]!.n).toBe(0);
      const after = await c.query<{ n: number }>(
        `select count(*)::int n from audit.log where table_name like 'rpt.%'`,
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });
  });

  it('labour and tasks: hours, open slots, done on time', async () => {
    await inRolledBackTx(async (c) => {
      const place = ids.node('TEST-BAR-3.0-FLOOR-SERVICE');
      const day = '2026-09-15';
      const worker = (
        await c.query<{ id: string; owner: string }>(
          `select id, owner_user_id as owner from hr.worker where owner_user_id = $1`,
          [ids.user('test.server.3.0')],
        )
      ).rows[0]!;
      const shift = (
        await c.query<{ id: string }>(
          `insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code,
                                 headcount, status, published_at)
           values ($1, $2, $3, ($3::date + time '18:00') at time zone 'Asia/Kolkata',
                   ($3::date + time '23:00') at time zone 'Asia/Kolkata', 'SERVER', 2,
                   'published', now())
           returning id`,
          [ids.tenant(), place, day],
        )
      ).rows[0]!.id;
      await c.query(
        `insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id,
                                          org_node_id, start_at, end_at)
         select tenant_id, id, $2, $3, org_node_id, start_at, end_at from hr.shift where id = $1`,
        [shift, worker.id, worker.owner],
      );
      // clocked 18:10 to 22:40 (4.5 h); the session ends after midnight UTC, not locally
      await c.query(
        `insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, shift_id,
                                    clock_in_at, clock_out_at, in_source, out_source, in_key, out_key)
         values ($1, $2, $3, $4, $5, ($6::date + time '18:10') at time zone 'Asia/Kolkata',
                 ($6::date + time '22:40') at time zone 'Asia/Kolkata', 'online', 'online', 'k1', 'k2')`,
        [ids.tenant(), worker.id, worker.owner, place, shift, day],
      );
      // two tasks due at 20:00: one done on time, one done after the day ended
      for (const done of ['19:30', '2026-09-16 07:00']) {
        await c.query(
          `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, status, assign_mode,
                                 assignee_user_id, completed_at, completed_by)
           values ($1, $2, 'one_off', 'Polish glasses', ($3::date + time '20:00') at time zone 'Asia/Kolkata',
                   'done', 'person', $4,
                   (case when $5 like '%-%' then $5::timestamp else $3::date + $5::time end)
                     at time zone 'Asia/Kolkata', $4)`,
          [ids.tenant(), place, day, worker.owner, done],
        );
      }
      const labour = await c.query(
        `select shifts, slots, filled, scheduled_hours::text, worked_hours::text
           from rpt.calc_labour_day(array[$1::uuid], $2::date, $2::date)`,
        [place, day],
      );
      expect(labour.rows[0]).toEqual({
        shifts: 1,
        slots: 2,
        filled: 1,
        scheduled_hours: '5.00',
        worked_hours: '4.50',
      });
      const tasks = await c.query(
        `select due, done, done_on_time, overdue
           from rpt.calc_task_day(array[$1::uuid], $2::date, $2::date)`,
        [place, day],
      );
      expect(tasks.rows[0]).toEqual({ due: 2, done: 2, done_on_time: 1, overdue: 1 });
    });
  });

  it('my week: only the person’s own figures', async () => {
    await inRolledBackTx(async (c) => {
      const monday = (
        await c.query<{ d: string }>(
          `select hr.week_start((now() at time zone 'Asia/Kolkata')::date)::text d`,
        )
      ).rows[0]!.d;
      const mine = await attemptAs<{ measure: string; value: string }>(
        c,
        ids.user('test.server.3.0'),
        'select measure, value::text from rpt.my_week($1::date)',
        [monday],
      );
      expect(mine.rows!.map((r) => r.measure)).toEqual([
        'shifts',
        'scheduled_hours',
        'worked_hours',
        'late',
        'no_shows',
        'on_time',
        'tasks_done',
        'tasks_on_time',
      ]);
      // the shifts counted are the server's own
      const own = await c.query<{ n: number }>(
        `select count(*)::int n from hr.shift_assignment a join hr.shift s on s.id = a.shift_id
          where a.owner_user_id = $1 and a.status = 'assigned' and s.status = 'published'
            and s.start_at >= rpt.day_start($2::date, 'Asia/Kolkata')
            and s.start_at < rpt.day_start($2::date + 7, 'Asia/Kolkata')`,
        [ids.user('test.server.3.0'), monday],
      );
      expect(n(mine.rows!.find((r) => r.measure === 'shifts')!.value)).toBe(own.rows[0]!.n);
      // someone who is not a worker has no week of their own
      const nobody = await newUser(c, ids, 'No Worker');
      const none = await attemptAs(c, nobody, 'select * from rpt.my_week($1::date)', [monday]);
      expect(none.error).toBe('INVALID_WORKER');
    });
  });

  it('refuses a day in the future and an unknown report', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(c, GM(), `select * from rpt.outlet_flash($1, rpt.today($1) + 1)`, [
        ids.node('TEST-HOTEL-1.0'),
      ]);
      expect(r.error).toBe('INVALID_DATE');
      const x = await attemptAs(c, GM(), `select * from rpt.report_places('payroll')`);
      expect(x.error).toBe('INVALID_REPORT');
    });
  });
});
