import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  migratorPool,
  type SeedIds,
} from '../test/helpers';

// Reports audit (ADR 057): a figure is what is behind it, for everyone. As a person of every
// kind of report access (one per set of reports the test customers' people have, and a person
// covering a role; every person with REPORTS_ALL_USERS=1), at up to 3 of the places each
// report offers them, for today, yesterday and 3 days ago:
// - Department and Outlet today: shifts, hours, late and no-shows equal the people list;
//   tasks equal the tasks list; wastage, stock value and sales equal their lists; every
//   figure equals its trend's point for that day.
// - People: the summary equals its departments and its list of people; its figures equal
//   their trends added up.
// - Outlets side by side: an outlet's sales equal Outlet today's, day by day.
// - Stock position, Central kitchen and Cost of sales equal their lists.
// Then the rules the audit fixed, one by one.

let ids: SeedIds;
let people: { id: string; username: string }[] = [];
const ALL = process.env.REPORTS_ALL_USERS === '1';

beforeAll(async () => {
  ids = await loadSeedIds();
  const users = await migratorPool.query<{ id: string; username: string }>(
    `select id, username from core.app_user
      where status = 'active' and username like 'test.%' order by username`,
  );
  if (ALL) {
    people = users.rows;
    return;
  }
  // one person per set of reports
  const seen = new Set<string>();
  await inRolledBackTx(async (c) => {
    for (const u of users.rows) {
      const r = await attemptAs<{ s: string | null }>(
        c,
        u.id,
        `select string_agg(report, ',' order by report) as s from rpt.my_reports()`,
      );
      const shape = r.rows?.[0]?.s ?? '';
      if (!seen.has(shape)) {
        seen.add(shape);
        people.push(u);
      }
    }
  });
  // and a person whose access comes partly from covering a role (ADR 061, 066): Guest House
  // 2.0's Front Desk, covering its Store Keeper
  const coverer = users.rows.find((u) => u.username === 'test.front-desk-executive.2.0')!;
  if (!people.includes(coverer)) people.push(coverer);
}, 120_000);
afterAll(closePools);

const n = (v: unknown) => Number(v ?? 0);
const sum = <T>(rows: T[], k: keyof T) => rows.reduce((s, r) => s + n(r[k]), 0);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const before = (day: string, k: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - k);
  return iso(d);
};

type Row = Record<string, unknown>;

/** Everything that does not add up for one person, as "report place day: what a vs b". */
async function mismatches(c: PoolClient, userId: string): Promise<string[]> {
  const out: string[] = [];
  const q = async (sql: string, params: unknown[] = []) => {
    const r = await attemptAs<Row>(c, userId, sql, params);
    return { rows: r.rows ?? [], error: r.error };
  };
  const eq = (where: string, what: string, a: unknown, b: unknown) => {
    if (Math.abs(n(a) - n(b)) >= 0.011) out.push(`${where}: ${what} ${String(a)} vs ${String(b)}`);
  };
  const reps = await q(`select report from rpt.my_reports()`);
  if (reps.error) return [`my_reports: ${reps.error}`];
  for (const { report } of reps.rows as { report: string }[]) {
    if (report === 'my_week') {
      const r = await q(`select * from rpt.my_week(date_trunc('week', now())::date)`);
      if (r.error) out.push(`my_week: ${r.error}`);
      continue;
    }
    const places = await q(`select * from rpt.report_places($1)`, [report]);
    if (places.error) {
      out.push(`${report} places: ${places.error}`);
      continue;
    }
    for (const p of places.rows.slice(0, 3)) {
      const place = String(p.id);
      const today = String((await q(`select rpt.today($1)::text as d`, [place])).rows[0]?.d);
      const days = [today, before(today, 1), before(today, 3)];
      const at = `${report} ${String(p.name)}`;

      if (report === 'department' || report === 'outlet_flash') {
        const fn = report === 'department' ? 'department_day' : 'outlet_flash';
        for (const day of days) {
          const where = `${at} ${day}`;
          const m = await q(`select measure, value::text from rpt.${fn}($1, $2::date)`, [
            place,
            day,
          ]);
          if (m.error) {
            out.push(`${where}: ${m.error}`);
            continue;
          }
          const v = new Map(m.rows.map((r) => [String(r.measure), r.value]));
          const bp = await q(`select * from rpt.bd_people($1, $2, $3::date, $3::date)`, [
            report,
            place,
            day,
          ]);
          if (!bp.error) {
            if (v.has('shifts'))
              eq(where, 'shifts vs people', v.get('shifts'), sum(bp.rows, 'shifts'));
            eq(
              where,
              'worked hours vs people',
              v.get('worked_hours'),
              sum(bp.rows, 'worked_hours'),
            );
            eq(
              where,
              'rostered hours vs people',
              v.get('scheduled_hours'),
              sum(bp.rows, 'rostered_hours'),
            );
            eq(where, 'late vs people', v.get('late'), sum(bp.rows, 'late'));
            eq(where, 'no-shows vs people', v.get('no_shows'), sum(bp.rows, 'no_shows'));
          }
          const bt = await q(`select * from rpt.bd_tasks($1, $2, $3::date, $3::date)`, [
            report,
            place,
            day,
          ]);
          if (!bt.error) {
            eq(where, 'tasks due vs tasks', v.get('tasks_due'), sum(bt.rows, 'due'));
            eq(where, 'tasks done vs tasks', v.get('tasks_done'), sum(bt.rows, 'done'));
            eq(where, 'overdue vs tasks', v.get('overdue'), sum(bt.rows, 'overdue'));
            eq(where, 'flagged vs tasks', v.get('flagged'), sum(bt.rows, 'flagged'));
          }
          if (v.has('wastage')) {
            const bw = await q(`select * from rpt.bd_wastage($1, $2, $3::date, $3::date)`, [
              report,
              place,
              day,
            ]);
            if (bw.error) out.push(`${where}: wastage list ${bw.error}`);
            else eq(where, 'wastage vs items', v.get('wastage'), sum(bw.rows, 'value'));
          }
          if (day === today && v.has('stock_value')) {
            const bs = await q(`select * from rpt.bd_stock($1, $2)`, [report, place]);
            if (!bs.error)
              eq(where, 'stock value vs items', v.get('stock_value'), sum(bs.rows, 'value'));
          }
          if (v.has('sales')) {
            const bd = await q(`select * from rpt.bd_dishes($1, $2, $3::date, $3::date)`, [
              report,
              place,
              day,
            ]);
            if (!bd.error) eq(where, 'sales vs dishes', v.get('sales'), sum(bd.rows, 'sales'));
          }
          for (const [measure, value] of v) {
            const t = await q(
              `select value::text from rpt.measure_trend($1, $2, $3, 'day', $4::date, $4::date)`,
              [report, place, measure, day],
            );
            if (t.error) {
              if (!/INVALID_MEASURE|NOT_AUTHORISED|MODULE/.test(t.error))
                out.push(`${where}: trend ${measure} ${t.error}`);
              continue;
            }
            eq(where, `trend ${measure}`, t.rows[0]?.value, value);
          }
        }
      }

      if (report === 'people') {
        const [from, to] = [days[2]!, days[0]!];
        const s = await q(
          `select measure, value::text from rpt.people_summary($1, $2::date, $3::date)`,
          [place, from, to],
        );
        if (s.error) {
          out.push(`${at}: ${s.error}`);
          continue;
        }
        const v = new Map(s.rows.map((r) => [String(r.measure), r.value]));
        const d = await q(`select * from rpt.people_departments($1, $2::date, $3::date)`, [
          place,
          from,
          to,
        ]);
        if (!d.error) {
          for (const k of ['shifts', 'late', 'no_shows'])
            eq(at, `${k} vs departments`, v.get(k), sum(d.rows, k));
          eq(at, 'worked hours vs departments', v.get('worked_hours'), sum(d.rows, 'hours'));
        }
        const bp = await q(`select * from rpt.bd_people('people', $1, $2::date, $3::date)`, [
          place,
          from,
          to,
        ]);
        if (!bp.error) {
          eq(at, 'shifts vs people list', v.get('shifts'), sum(bp.rows, 'shifts'));
          eq(
            at,
            'worked hours vs people list',
            v.get('worked_hours'),
            sum(bp.rows, 'worked_hours'),
          );
          eq(at, 'late vs people list', v.get('late'), sum(bp.rows, 'late'));
          eq(at, 'no-shows vs people list', v.get('no_shows'), sum(bp.rows, 'no_shows'));
        }
        for (const [measure, value] of v) {
          if (['on_time_pct', 'swaps'].includes(measure)) continue;
          const t = await q(
            `select coalesce(sum(value), 0)::text as value
               from rpt.measure_trend('people', $1, $2, 'day', $3::date, $4::date)`,
            [place, measure, from, to],
          );
          if (!t.error) eq(at, `trend ${measure} (days added up)`, t.rows[0]?.value, value);
        }
      }

      if (report === 'league') {
        const lg = await q(`select * from rpt.league($1, $2::date, $3::date)`, [
          place,
          days[2],
          days[0],
        ]);
        if (lg.error) out.push(`${at}: ${lg.error}`);
        else
          for (const row of lg.rows) {
            let sales = 0;
            for (let k = 3; k >= 0; k--) {
              const f = await q(
                `select value::text from rpt.outlet_flash($1, $2::date) where measure = 'sales'`,
                [row.outlet_id, before(today, k)],
              );
              sales += n(f.rows?.[0]?.value);
            }
            eq(`${at} ${String(row.name)}`, 'sales vs Outlet today', row.sales, sales);
          }
      }

      if (report === 'stock_position') {
        const s = await q(`select measure, value::text from rpt.stock_summary($1)`, [place]);
        const it = await q(`select * from rpt.stock_items($1)`, [place]);
        if (s.error || it.error) out.push(`${at}: ${s.error ?? it.error}`);
        else {
          const v = new Map(s.rows.map((r) => [String(r.measure), r.value]));
          eq(at, 'stock value vs items', v.get('stock_value'), sum(it.rows, 'value'));
          eq(
            at,
            'dead value vs items',
            v.get('dead_value'),
            sum(
              it.rows.filter((r) => r.dead),
              'value',
            ),
          );
          eq(
            at,
            'expired value vs items',
            v.get('expired_stock_value'),
            sum(it.rows, 'expired_value'),
          );
          const t = await q(
            `select value::text from rpt.measure_trend('stock_position', $1, 'stock_value', 'day', $2::date, $2::date)`,
            [place, today],
          );
          if (t.error) out.push(`${at}: trend ${t.error}`);
          else eq(at, 'stock value vs trend', v.get('stock_value'), t.rows[0]?.value);
        }
      }

      if (report === 'central_kitchen') {
        const s = await q(
          `select measure, value::text from rpt.kitchen_summary($1, $2::date, $3::date)`,
          [place, days[2], days[0]],
        );
        const d = await q(`select * from rpt.kitchen_dispatch($1, $2::date, $3::date)`, [
          place,
          days[2],
          days[0],
        ]);
        if (s.error || d.error) out.push(`${at}: ${s.error ?? d.error}`);
        else {
          const v = new Map(s.rows.map((r) => [String(r.measure), r.value]));
          for (const k of ['transfers', 'requested_value', 'dispatched_value', 'transit_loss'])
            eq(at, `${k} vs outlets`, v.get(k), sum(d.rows, k));
        }
      }

      if (report === 'cost_of_sales') {
        const s = await q(
          `select measure, value::text from rpt.cost_totals($1, $2::date, $3::date)`,
          [place, days[2], days[0]],
        );
        const w = await q(`select * from rpt.bd_wastage('cost_of_sales', $1, $2::date, $3::date)`, [
          place,
          days[2],
          days[0],
        ]);
        const bd = await q(`select * from rpt.bd_dishes('cost_of_sales', $1, $2::date, $3::date)`, [
          place,
          days[2],
          days[0],
        ]);
        if (s.error || w.error || bd.error) out.push(`${at}: ${s.error ?? w.error ?? bd.error}`);
        else {
          const v = new Map(s.rows.map((r) => [String(r.measure), r.value]));
          eq(at, 'wastage vs items', v.get('wastage'), sum(w.rows, 'value'));
          eq(
            at,
            'expired vs items',
            v.get('expired'),
            sum(
              w.rows.filter((r) => r.reason === 'expired'),
              'value',
            ),
          );
          for (const [menu, key] of [
            ['Food', 'food_sales'],
            ['Bar', 'bar_sales'],
          ] as const)
            eq(
              at,
              `${key} vs dishes`,
              v.get(key),
              sum(
                bd.rows.filter((r) => r.menu === menu),
                'sales',
              ),
            );
        }
      }

      for (const sql of {
        purchasing: [
          `select * from rpt.supplier_fill($1, $2::date, $3::date)`,
          `select * from rpt.price_changes($1, $2::date, $3::date)`,
        ],
        menu_engineering: [`select * from rpt.menu_engineering($1, $2::date, $3::date)`],
      }[report] ?? []) {
        const r = await q(sql, [place, days[2], days[0]]);
        if (r.error) out.push(`${at}: ${r.error}`);
      }
    }
  }
  return out;
}

describe('every figure equals what is behind it, for every kind of report access', () => {
  it('found the people to check', () => {
    expect(people.length).toBeGreaterThanOrEqual(ALL ? 100 : 12);
  });
  it(
    'each person: no figure differs from its list, its trend or the report it comes from',
    { timeout: ALL ? 3_600_000 : 600_000 },
    async () => {
      const all: string[] = [];
      for (const u of people) {
        const found = await inRolledBackTx((c) => mismatches(c, u.id));
        all.push(...found.map((f) => `${u.username} ${f}`));
      }
      expect(all).toEqual([]);
    },
  );
});

describe('the rules the audit fixed', () => {
  const KITCHEN = 'TEST-HOTEL-1.0-KITCHEN';
  const CHEF = 'test.executive-chef.1.0';

  it('a shift is someone on it: an open slot is not counted as a shift, Home says the same', async () => {
    await inRolledBackTx(async (c) => {
      const place = ids.node(KITCHEN);
      const day = (await c.query<{ d: string }>(`select rpt.today($1)::text as d`, [place]))
        .rows[0]!.d;
      // straight from the roster: the people assigned to today's published shifts there
      const raw = await c.query<{ assigned: string; slots: string; filled: string }>(
        `select count(a.id)::text as assigned,
                (select sum(s2.headcount) from hr.shift s2
                  where s2.org_node_id = $1 and s2.status = 'published'
                    and rpt.business_date(s2.start_at, ops.tz_of($1)) = $2::date)::text as slots,
                (select sum(least(s3.headcount, (select count(*) from hr.shift_assignment x
                                                  where x.shift_id = s3.id and x.status = 'assigned')))
                   from hr.shift s3
                  where s3.org_node_id = $1 and s3.status = 'published'
                    and rpt.business_date(s3.start_at, ops.tz_of($1)) = $2::date)::text as filled
           from hr.shift s join hr.shift_assignment a on a.shift_id = s.id and a.status = 'assigned'
          where s.org_node_id = $1 and s.status = 'published'
            and rpt.business_date(s.start_at, ops.tz_of($1)) = $2::date`,
        [place, day],
      );
      const r = await attemptAs<{ measure: string; value: string }>(
        c,
        ids.user(CHEF),
        `select measure, value::text from rpt.department_day($1, $2::date)`,
        [place, day],
      );
      const v = new Map(r.rows!.map((x) => [x.measure, x.value]));
      expect(n(v.get('shifts'))).toBe(n(raw.rows[0]!.assigned));
      expect(n(v.get('open_slots'))).toBe(n(raw.rows[0]!.slots) - n(raw.rows[0]!.filled));
      // the people on the department's screen are the same shifts
      const list = await attemptAs(c, ids.user(CHEF), `select * from rpt.department_people($1)`, [
        place,
      ]);
      expect(list.rows!.length).toBe(n(v.get('shifts')));
      // the seed has open slots there, so the old count (every shift) would differ
      expect(n(v.get('open_slots'))).toBeGreaterThan(0);
    });
  });

  it('a task not yet due is not due, overdue or against the on-time share until it is', async () => {
    await inRolledBackTx(async (c) => {
      const place = ids.node(KITCHEN);
      const read = async () => {
        const r = await attemptAs<{ measure: string; value: string }>(
          c,
          ids.user(CHEF),
          `select measure, value::text from rpt.department_day($1, rpt.today($1))`,
          [place],
        );
        return new Map(r.rows!.map((x) => [x.measure, n(x.value)]));
      };
      const was = await read();
      // a copy of one of the kitchen's tasks, due in two hours and not done
      const added = await c.query<{ id: string }>(
        `insert into ops.task
         select (jsonb_populate_record(null::ops.task, to_jsonb(t) || jsonb_build_object(
                  'id', core.uuid_v7(), 'idempotency_key', core.uuid_v7()::text, 'template_id', null,
                  'status', 'open', 'completed_at', null,
                  'completed_by', null, 'due_at', now() + interval '2 hours'))).*
           from ops.task t where t.org_node_id = $1 limit 1
         returning id`,
        [place],
      );
      const now = await read();
      for (const k of ['tasks_due', 'tasks_done', 'overdue', 'task_pct'])
        expect(now.get(k), k).toBe(was.get(k));
      // and once its time has passed, it is due and overdue
      await c.query(`update ops.task set due_at = now() - interval '1 minute' where id = $1`, [
        added.rows[0]!.id,
      ]);
      const later = await read();
      expect(later.get('tasks_due')).toBe(n(was.get('tasks_due')) + 1);
      expect(later.get('overdue')).toBe(n(was.get('overdue')) + 1);
    });
  });

  it("the dishes behind a bar manager's Cost of sales are the bar's only", async () => {
    await inRolledBackTx(async (c) => {
      const outlet = ids.node('TEST-HOTEL-1.0');
      const r = await attemptAs<{ menu: string }>(
        c,
        ids.user('test.bar-manager.1.0'),
        `select menu from rpt.bd_dishes('cost_of_sales', $1, current_date - 30, current_date)`,
        [outlet],
      );
      expect(r.error).toBeUndefined();
      expect(r.rows!.filter((x) => x.menu === 'Food')).toEqual([]);
      // the GM, who sees every store, still has both
      const gm = await attemptAs<{ menu: string }>(
        c,
        ids.user('test.general-manager.1.0'),
        `select distinct menu from rpt.bd_dishes('cost_of_sales', $1, current_date - 30, current_date)`,
        [outlet],
      );
      expect(gm.rows!.map((x) => x.menu).sort()).toEqual(['Bar', 'Food']);
    });
  });

  it('a store with no time zone of its own counts days in its outlet’s, never UTC', async () => {
    await inRolledBackTx(async (c) => {
      const outlet = ids.node('TEST-HOTEL-1.0');
      const read = async () =>
        (
          await attemptAs<{ measure: string; value: string }>(
            c,
            ids.user('test.general-manager.1.0'),
            `select measure, value::text from rpt.cost_totals($1, current_date - 6, current_date)`,
            [outlet],
          )
        ).rows!;
      const was = await read();
      await c.query(
        `update core.hierarchy_node set timezone = null
          where type = 'delivery' and kind = 'store' and code like 'TEST-HOTEL-1.0-%'`,
      );
      expect(await read()).toEqual(was);
    });
  });

  it('the spend per cover is the outlet flash’s sales over the day’s covers (ADR 096)', async () => {
    await inRolledBackTx(async (c) => {
      const place = ids.node('TEST-BAR-3.0');
      const who = ids.user('test.bar-manager.3.0');
      // the last day of file 27's sales
      const day = (
        await migratorPool.query<{ d: string }>(
          `select max(business_date)::text as d from rpt.sales_day
            where org_node_id = $1 and sales > 0`,
          [place],
        )
      ).rows[0]!.d;
      for (const [period, covers] of [
        ['lunch', 40],
        ['dinner', 60],
      ] as const) {
        const r = await attemptAs(c, who, `select ops.set_covers($1, $2, $3, $4)`, [
          place,
          day,
          period,
          covers,
        ]);
        expect(r.error).toBeUndefined();
      }
      const flash = await attemptAs<{ value: string }>(
        c,
        who,
        `select value::text from rpt.outlet_flash($1, $2) where measure = 'sales'`,
        [place, day],
      );
      const rows = await attemptAs<{
        covers: number | null;
        total_covers: number;
        sales: string;
        per_cover: string;
      }>(
        c,
        who,
        `select covers, total_covers, sales::text, per_cover::text from ops.covers_day($1, $2)`,
        [place, day],
      );
      const r = rows.rows!;
      expect(sum(r, 'covers')).toBe(r[0]!.total_covers);
      expect(n(r[0]!.sales)).toBe(n(flash.rows![0]!.value));
      expect(n(r[0]!.sales)).toBeGreaterThan(0);
      expect(n(r[0]!.per_cover)).toBe(Math.round((n(r[0]!.sales) / 100) * 100) / 100);
    });
  });

  it('the People report counts the people who belong to the place, wherever they worked', async () => {
    await inRolledBackTx(async (c) => {
      const place = ids.node('TEST-BAR-3.0');
      const who = ids.user('test.bar-manager.3.0');
      const s = await attemptAs<{ measure: string; value: string }>(
        c,
        who,
        `select measure, value::text from rpt.people_summary($1, current_date - 6, current_date)`,
        [place],
      );
      const v = new Map(s.rows!.map((x) => [x.measure, n(x.value)]));
      const list = await attemptAs<{ shifts: number }>(
        c,
        who,
        `select * from rpt.bd_people('people', $1, current_date - 6, current_date)`,
        [place],
      );
      expect(sum(list.rows!, 'shifts')).toBe(v.get('shifts'));
      expect(v.get('shifts')).toBeGreaterThan(0);
    });
  });
});
