import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { as, everyone } from '../test/report-access';

// Labour cost (R-3, ADR 030): LABOUR_COST shows totals only, to outlet managers, area
// managers, HR admin and (through REPORTS) the Account Owner. No figure covers fewer than
// 3 paid people: smaller departments go into "Other departments"; if that is still fewer
// than 3, the smallest shown department joins it; an outlet with fewer than 3 shows
// nothing. One person's pay (COMPENSATION) stays HR's alone.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

/** Monthly ₹36,500 = ₹1,200 a day; hourly ₹150. */
async function pay(c: PoolClient, usernames: string[], basis: 'monthly' | 'hourly') {
  await c.query(
    `insert into hr.worker_sensitive (tenant_id, worker_id, owner_user_id, org_node_id, pay_rate,
                                      pay_basis)
     select w.tenant_id, w.id, w.owner_user_id, w.org_node_id, $2, $3
       from hr.worker w join core.app_user u on u.id = w.owner_user_id
      where u.username = any ($1)
     on conflict (worker_id) do update set pay_rate = excluded.pay_rate,
                                           pay_basis = excluded.pay_basis`,
    [usernames, basis === 'monthly' ? 36500 : 150, basis],
  );
}

/** No pay anywhere in the test customers, so each case starts clean. */
async function noPay(c: PoolClient) {
  await c.query(
    `update hr.worker_sensitive s set pay_rate = null, pay_basis = null
       from hr.worker w where w.id = s.worker_id
        and w.tenant_id in (select id from core.tenant
                             where code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY'))`,
  );
}

/** An 8-hour session `daysAgo` business days ago, 10:00 to 18:00 at the person's place. */
async function worked(c: PoolClient, username: string, daysAgo: number) {
  await c.query(
    `insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, clock_in_at,
                                clock_out_at, in_source, out_source, in_key, out_key)
     select w.tenant_id, w.id, w.owner_user_id, w.org_node_id,
            ((current_date - $2::int) + time '10:00') at time zone ops.tz_of(w.org_node_id),
            ((current_date - $2::int) + time '18:00') at time zone ops.tz_of(w.org_node_id),
            'online', 'online', 'fixture-' || $2 || '-' || w.id, 'fixture-out-' || $2 || '-' || w.id
       from hr.worker w join core.app_user u on u.id = w.owner_user_id
      where u.username = $1`,
    [username, daysAgo],
  );
}

interface Row {
  code: string;
  part: string;
  day: number;
  people: number;
  cost: string;
}

/** What may be shown for an outlet, by days ago, as the migrator (the rule itself). */
async function rows(c: PoolClient, outlet: string, from: number, to: number): Promise<Row[]> {
  const r = await c.query<Row>(
    `select n.code, r.part, current_date - r.business_date as day, r.people,
            (r.hourly_cost + r.salary_cost)::text as cost
       from rpt.labour_cost_rows(array[$1::uuid], current_date - $2::int, current_date - $3::int) r
       join core.hierarchy_node n on n.id = r.org_node_id
      order by day, r.part, n.code`,
    [ids.node(outlet), from, to],
  );
  return r.rows;
}

const KITCHEN_1_1 = [
  'test.executive-chef.1.1',
  'test.sous-chef.1.1',
  'test.chef-de-partie.1.1',
  'test.commis.1.1',
  'test.kitchen-steward.1.1',
];

describe('labour cost: no figure covers fewer than 3 people', () => {
  it('a department of 3 or more is shown, with the outlet; nothing smaller exists', async () => {
    await inRolledBackTx(async (c) => {
      await noPay(c);
      await pay(c, KITCHEN_1_1, 'monthly');
      expect(await rows(c, 'TEST-HOTEL-1.1', 3, 3)).toEqual([
        { code: 'TEST-HOTEL-1.1-KITCHEN', part: 'department', day: 3, people: 5, cost: '6000.00' },
        { code: 'TEST-HOTEL-1.1', part: 'outlet', day: 3, people: 5, cost: '6000.00' },
      ]);
    });
  });

  it('one person elsewhere would be the outlet minus the kitchen: the kitchen folds too', async () => {
    await inRolledBackTx(async (c) => {
      await noPay(c);
      await pay(c, KITCHEN_1_1, 'monthly');
      await pay(c, ['test.bartender.1.1'], 'hourly');
      await worked(c, 'test.bartender.1.1', 3);
      expect(await rows(c, 'TEST-HOTEL-1.1', 3, 3)).toEqual([
        { code: 'TEST-HOTEL-1.1', part: 'other', day: 3, people: 6, cost: '7200.00' },
        { code: 'TEST-HOTEL-1.1', part: 'outlet', day: 3, people: 6, cost: '7200.00' },
      ]);
    });
  });

  it('small places together make 3: they are "Other departments", the kitchen stays', async () => {
    await inRolledBackTx(async (c) => {
      await noPay(c);
      await pay(c, KITCHEN_1_1, 'monthly');
      await pay(c, ['test.general-manager.1.1', 'test.assistant-general-manager.1.1'], 'monthly');
      await pay(c, ['test.bartender.1.1'], 'hourly');
      await worked(c, 'test.bartender.1.1', 3);
      // day 3: the managers (2) and the bartender (1) make 3; day 2: the managers alone are
      // 2, so the kitchen joins them
      expect(await rows(c, 'TEST-HOTEL-1.1', 3, 2)).toEqual([
        { code: 'TEST-HOTEL-1.1', part: 'other', day: 2, people: 7, cost: '8400.00' },
        { code: 'TEST-HOTEL-1.1', part: 'outlet', day: 2, people: 7, cost: '8400.00' },
        { code: 'TEST-HOTEL-1.1-KITCHEN', part: 'department', day: 3, people: 5, cost: '6000.00' },
        { code: 'TEST-HOTEL-1.1', part: 'other', day: 3, people: 3, cost: '3600.00' },
        { code: 'TEST-HOTEL-1.1', part: 'outlet', day: 3, people: 8, cost: '9600.00' },
      ]);
    });
  });

  it('an outlet with fewer than 3 paid people shows nothing at all', async () => {
    await inRolledBackTx(async (c) => {
      await noPay(c);
      await pay(c, ['test.general-manager.1.1', 'test.assistant-general-manager.1.1'], 'monthly');
      expect(await rows(c, 'TEST-HOTEL-1.1', 3, 3)).toEqual([]);
    });
  });

  it('whatever the data, every stored row covers 3 or more, and the parts add up', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`select rpt.rebuild(current_date - 35, current_date)`);
      const bad = await c.query<{ outlet: string; day: string; problem: string }>(
        `with t as (
           select * from rpt.labour_cost_day where people > 0
         )
         select o.code as outlet, t.business_date::text as day, 'fewer than 3' as problem
           from t join core.hierarchy_node o on o.id = t.outlet_id where t.people < 3
         union all
         select o.code, x.business_date::text, 'parts do not add up'
           from (select t.outlet_id, t.business_date,
                        sum(t.people) filter (where t.part <> 'outlet') as parts_people,
                        sum(t.people) filter (where t.part = 'outlet') as outlet_people,
                        sum(t.hourly_cost + t.salary_cost) filter (where t.part <> 'outlet') as parts,
                        sum(t.hourly_cost + t.salary_cost) filter (where t.part = 'outlet') as total
                   from t group by t.outlet_id, t.business_date) x
           join core.hierarchy_node o on o.id = x.outlet_id
          where x.parts_people is distinct from x.outlet_people
             or abs(coalesce(x.parts, 0) - x.total) > 0.05`,
      );
      expect(bad.rows).toEqual([]);
      const n = await c.query<{ n: number }>(
        `select count(*)::int as n from rpt.labour_cost_day where people > 0`,
      );
      expect(n.rows[0]!.n).toBeGreaterThan(0);
    });
  }, 120_000);
});

describe('labour cost: who sees it (every user)', () => {
  it('opens at an outlet or site exactly where LABOUR_COST or REPORTS is held', async () => {
    await inRolledBackTx(async (c) => {
      const places = await c.query<{ id: string; code: string }>(
        `select n.id, n.code from core.hierarchy_node n join core.tenant t on t.id = n.tenant_id
          where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') and n.type = 'org'
            and n.kind in ('outlet', 'site', 'department')`,
      );
      const wrong: string[] = [];
      for (const p of await everyone(c)) {
        for (const pl of places.rows) {
          // the rule, worked out as the migrator for this person
          await c.query(`select set_config('app.user_id', $1, true)`, [p.id]);
          const rule = await c.query<{ ok: boolean }>(
            `select n.kind in ('outlet', 'site') and n.tenant_id = core.my_tenant()
                    and (core.can('REPORTS', 'view', n.id, null)
                         or core.can('LABOUR_COST', 'view', n.id, null)) as ok
               from core.hierarchy_node n where n.id = $1`,
            [pl.id],
          );
          await c.query(`select set_config('app.user_id', '', true)`);
          const allowed = rule.rows[0]?.ok === true;
          const r = await as(
            c,
            p.id,
            'select * from rpt.labour_cost($1, current_date - 6, current_date)',
            [pl.id],
          );
          const opened = r.error === undefined;
          if (opened !== allowed) wrong.push(`${p.username} ${pl.code} opened=${opened}`);
          if (!opened && r.error !== 'NOT_AUTHORISED') wrong.push(`${p.username} ${r.error}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }, 300_000);

  it('the expected people: GM, area manager, HR admin, owner yes; chef, cost controller, HR executive no', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const open = async (u: string) =>
        (
          await as(
            c,
            ids.user(u),
            'select * from rpt.labour_cost($1, current_date - 6, current_date)',
            [hotel],
          )
        ).error === undefined;
      for (const u of [
        'test.general-manager.1.0',
        'test.assistant-general-manager.1.0',
        'test.area-manager',
        'test.hr-admin',
        'test.account-owner',
      ]) {
        expect(await open(u), u).toBe(true);
      }
      for (const u of [
        'test.executive-chef.1.0',
        'test.cost-controller.1.0',
        'test.hr-executive.1.0',
        'test.store-manager.1.0',
        'test.bartender.1.0',
      ]) {
        expect(await open(u), u).toBe(false);
      }
    });
  });

  // Like every rpt table (ADR 023), a stored row is read directly only through its own domain;
  // REPORTS (the owner) reads labour cost through the report functions.
  it('the stored rows are read only with LABOUR_COST (RLS), and frontline staff read none', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`select rpt.rebuild(current_date - 35, current_date)`);
      const wrong: string[] = [];
      for (const p of await everyone(c)) {
        // the rows the person reads, against the rule worked out as the migrator
        const r = await as<{ id: string }>(c, p.id, 'select id from rpt.labour_cost_day');
        if (r.error !== undefined) {
          wrong.push(`${p.username} ${r.error}`);
          continue;
        }
        await c.query(`select set_config('app.user_id', $1, true)`, [p.id]);
        const rule = await c.query<{ id: string }>(
          `select l.id from rpt.labour_cost_day l
            where l.tenant_id = core.my_tenant()
              and core.can('LABOUR_COST', 'view', l.org_node_id, null)`,
        );
        await c.query(`select set_config('app.user_id', '', true)`);
        const seen = new Set(r.rows.map((x) => x.id));
        const allowed = new Set(rule.rows.map((x) => x.id));
        if (seen.size !== allowed.size || [...seen].some((x) => !allowed.has(x))) {
          wrong.push(`${p.username} reads ${seen.size}, allowed ${allowed.size}`);
        }
      }
      expect(wrong).toEqual([]);
      const r = await as<{ n: number }>(
        c,
        ids.user('test.commis.1.0'),
        'select count(*)::int as n from rpt.labour_cost_day',
      );
      expect(r.rows![0]!.n).toBe(0);
    });
  }, 300_000);

  it('Outlet today shows labour and prime cost only to people who see labour cost', async () => {
    await inRolledBackTx(async (c) => {
      const hotel = ids.node('TEST-HOTEL-1.0');
      const measures = async (u: string) => {
        const r = await as<{ measure: string }>(
          c,
          ids.user(u),
          'select measure from rpt.outlet_flash($1, current_date - 1)',
          [hotel],
        );
        if (r.error !== undefined) throw new Error(`${u}: ${r.error}`);
        return r.rows.map((x) => x.measure);
      };
      const labour = ['labour_cost', 'labour_pct', 'prime_cost', 'materials_pct'];
      for (const u of ['test.general-manager.1.0', 'test.account-owner', 'test.area-manager']) {
        const m = await measures(u);
        for (const x of [...labour, 'splh', 'cost_materials']) expect(m, `${u} ${x}`).toContain(x);
      }
      const cc = await measures('test.cost-controller.1.0');
      for (const x of labour) expect(cc, `cost controller ${x}`).not.toContain(x);
      expect(cc).toContain('cost_materials');
    });
  });

  it("Department today shows a department's labour cost only to people who see labour cost", async () => {
    await inRolledBackTx(async (c) => {
      const kitchen = ids.node('TEST-HOTEL-1.0-KITCHEN');
      const has = async (u: string) => {
        const r = await as<{ measure: string }>(
          c,
          ids.user(u),
          'select measure from rpt.department_day($1, current_date - 1)',
          [kitchen],
        );
        if (r.error !== undefined) throw new Error(`${u}: ${r.error}`);
        return r.rows.some((x) => x.measure === 'labour_cost');
      };
      expect(await has('test.general-manager.1.0')).toBe(true);
      expect(await has('test.executive-chef.1.0')).toBe(false);
      expect(await has('test.sous-chef.1.0')).toBe(false);
    });
  });

  it("one person's pay stays HR's: managers who see labour cost read no one else's rate", async () => {
    await inRolledBackTx(async (c) => {
      for (const u of ['test.general-manager.1.0', 'test.area-manager', 'test.account-owner']) {
        const r = await as<{ n: number }>(
          c,
          ids.user(u),
          `select count(*)::int as n from hr.worker_sensitive
            where owner_user_id <> core.current_user_id()`,
        );
        expect(r.rows?.[0]?.n ?? r.error, u).toBe(0);
      }
    });
  });

  it('the test-only loaders are not the app’s: app_rw cannot run them', async () => {
    await inRolledBackTx(async (c) => {
      const gm = ids.user('test.general-manager.1.0');
      for (const sql of [
        `select hr.record_test_attendance(now() - interval '2 days', now() - interval '1 day', 'x')`,
        `select inv.record_test_dispatch(gen_random_uuid(), '[]', now() - interval '1 day')`,
        `select inv.record_test_transfer_receipt(gen_random_uuid(), '[]', now() - interval '1 day')`,
        `select inv.dispatch_transfer_at(gen_random_uuid(), '[]', null, now())`,
        `select rpt.labour_cost_rows(array[gen_random_uuid()], current_date, current_date)`,
        `select rpt.rebuild_labour_cost(current_date, current_date)`,
      ]) {
        const r = await as(c, gm, sql);
        expect(r.error, sql).toMatch(/permission denied/);
      }
    });
  });
});
