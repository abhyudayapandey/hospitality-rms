import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Who may open which report (docs/reporting.md section 5, ADR 023), for every person in
// both test customers. A report opens where its source is visible: the outlet flash where
// the person can see the outlet's sales, a department's day where they can see its
// attendance, and everyone's own week. The Account Owner holds REPORTS (read-only, the
// whole company). Frontline staff see only their own week: a server never sees the
// outlet's sales, costs or P&L.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

/** Groups that make someone frontline: they never see business numbers. */
const FRONTLINE = new Set(['SELF', 'STAFF', 'STOCK_USER', 'PRODUCTION_TEAM']);

interface Person {
  id: string;
  username: string;
  tenant: string;
  groups: string[];
  worker: boolean;
}

async function everyone(c: PoolClient): Promise<Person[]> {
  const { rows } = await c.query<Person>(
    `select u.id, u.username, t.code as tenant,
            coalesce(array_agg(distinct g.code) filter (where g.code is not null), '{}') as groups,
            exists (select 1 from hr.worker w where w.owner_user_id = u.id and w.status = 'active')
              as worker
       from core.app_user u
       join core.tenant t on t.id = u.tenant_id
       left join core.role_assignment ra on ra.user_id = u.id
                                        and ra.effective_from <= current_date
                                        and (ra.effective_to is null or ra.effective_to >= current_date)
       left join core.security_group g on g.id = ra.group_id
      where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') and u.kind = 'human'
        and u.status = 'active' and u.username is not null
      group by u.id, u.username, t.code
      order by u.username`,
  );
  return rows;
}

async function as<T extends object>(
  c: PoolClient,
  user: string,
  sql: string,
  params: unknown[] = [],
) {
  return attemptAs<T>(c, user, sql, params);
}

async function reportsOf(c: PoolClient, user: string): Promise<string[]> {
  const r = await as<{ report: string }>(c, user, 'select report from rpt.my_reports()');
  if (r.error !== undefined) throw new Error(r.error);
  return r.rows.map((x) => x.report);
}

async function placesOf(c: PoolClient, user: string, report: string): Promise<string[]> {
  const r = await as<{ code: string }>(c, user, 'select code from rpt.report_places($1)', [report]);
  if (r.error !== undefined) throw new Error(`${report}: ${r.error}`);
  return r.rows.map((x) => x.code).sort();
}

/** The rule each report applies, as an independent check (n = a hierarchy_node). */
const RULES: Record<string, string> = {
  outlet_flash: `n.type = 'org' and n.kind = 'outlet'
                 and (core.can('REPORTS', 'view', n.id, null)
                      or exists (select 1 from core.node_link l where l.org_node_id = n.id
                                    and core.can('SALES', 'view', null, l.delivery_node_id)))`,
  department: `n.type = 'org' and core.is_team_place(n.id)
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('ATTENDANCE', 'view', n.id, null))`,
};

describe('reports: who opens what (every user)', () => {
  it('lists exactly the places that pass each report rule', async () => {
    await inRolledBackTx(async (c) => {
      const mismatches: string[] = [];
      for (const p of await everyone(c)) {
        for (const [report, rule] of Object.entries(RULES)) {
          const got = await placesOf(c, p.id, report);
          await c.query(`select set_config('app.user_id', $1, true)`, [p.id]);
          const { rows } = await c.query<{ code: string }>(
            `select n.code from core.hierarchy_node n
              where n.tenant_id = core.my_tenant() and n.archived_at is null and ${rule}`,
          );
          await c.query(`select set_config('app.user_id', '', true)`);
          const want = rows.map((r) => r.code).sort();
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            mismatches.push(`${p.username} ${report}: got [${got}], want [${want}]`);
          }
        }
      }
      expect(mismatches).toEqual([]);
    });
  }, 180_000);

  it('frontline staff see only their own week: no sales, costs or department figures', async () => {
    await inRolledBackTx(async (c) => {
      const wrong: string[] = [];
      let frontline = 0;
      for (const p of await everyone(c)) {
        if (!p.groups.every((g) => FRONTLINE.has(g))) continue;
        frontline++;
        const got = await reportsOf(c, p.id);
        const want = p.worker ? ['my_week'] : [];
        if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${p.username}: ${got}`);
      }
      expect(wrong).toEqual([]);
      // the test data has plenty of them: servers, commis, bartenders, stewards, ...
      expect(frontline).toBeGreaterThan(40);
    });
  }, 180_000);

  it('the reports list matches the places: a report is listed where it opens somewhere', async () => {
    await inRolledBackTx(async (c) => {
      const wrong: string[] = [];
      for (const p of await everyone(c)) {
        const listed = await reportsOf(c, p.id);
        const want = [
          ...((await placesOf(c, p.id, 'outlet_flash')).length ? ['outlet_flash'] : []),
          ...((await placesOf(c, p.id, 'department')).length ? ['department'] : []),
          ...(p.worker ? ['my_week'] : []),
        ];
        if (JSON.stringify(listed) !== JSON.stringify(want)) {
          wrong.push(`${p.username}: got [${listed}], want [${want}]`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }, 180_000);

  it('a report refuses every place it does not list', async () => {
    await inRolledBackTx(async (c) => {
      const outlets = await c.query<{ id: string; code: string; tenant: string }>(
        `select n.id, n.code, t.code as tenant from core.hierarchy_node n
           join core.tenant t on t.id = n.tenant_id
          where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') and n.type = 'org'
            and n.kind = 'outlet'`,
      );
      const depts = await c.query<{ id: string; code: string }>(
        `select n.id, n.code from core.hierarchy_node n
          where n.code in ('TEST-HOTEL-1.0-KITCHEN', 'TEST-BAR-3.0-FLOOR-SERVICE',
                           'TEST-GUEST-HOUSE-2.0', 'TEST-SOLO-BAR')`,
      );
      const leaks: string[] = [];
      for (const p of await everyone(c)) {
        const flash = new Set(await placesOf(c, p.id, 'outlet_flash'));
        for (const o of outlets.rows) {
          if (flash.has(o.code)) continue;
          const r = await as(c, p.id, 'select * from rpt.outlet_flash($1, current_date)', [o.id]);
          if (r.error !== 'NOT_AUTHORISED') leaks.push(`${p.username} outlet_flash ${o.code}`);
        }
        const dept = new Set(await placesOf(c, p.id, 'department'));
        for (const d of depts.rows) {
          if (dept.has(d.code)) continue;
          for (const fn of ['rpt.department_day($1, current_date)', 'rpt.department_people($1)']) {
            const r = await as(c, p.id, `select * from ${fn}`, [d.id]);
            if (r.error !== 'NOT_AUTHORISED') leaks.push(`${p.username} ${fn} ${d.code}`);
          }
        }
      }
      expect(leaks).toEqual([]);
    });
  }, 180_000);

  it('expected shapes: GM, cost controller, chef, sous chef, HR, area manager, owner', async () => {
    await inRolledBackTx(async (c) => {
      const r = (u: string) => reportsOf(c, ids.user(u));
      const pl = (u: string, rep: string) => placesOf(c, ids.user(u), rep);
      expect(await r('test.general-manager.1.0')).toEqual([
        'outlet_flash',
        'department',
        'my_week',
      ]);
      expect(await pl('test.general-manager.1.0', 'outlet_flash')).toEqual(['TEST-HOTEL-1.0']);
      expect(await r('test.cost-controller.1.0')).toEqual(['outlet_flash', 'my_week']);
      expect(await r('test.executive-chef.1.0')).toEqual(['department', 'my_week']);
      expect(await pl('test.executive-chef.1.0', 'department')).toEqual(['TEST-HOTEL-1.0-KITCHEN']);
      expect(await r('test.sous-chef.1.0')).toEqual(['department', 'my_week']);
      expect(await r('test.hr-admin')).toContain('department');
      expect(await r('test.hr-admin')).not.toContain('outlet_flash');
      expect((await pl('test.area-manager', 'outlet_flash')).length).toBeGreaterThan(1);
      expect(await r('test.steward.1.0')).toEqual(['my_week']);
      expect(await r('test.server.3.0')).toEqual(['my_week']);
      expect(await r('test.commis.1.0')).toEqual(['my_week']);

      // the owner: every outlet and team place of their own company, nothing of another
      const owner = ids.user('test.account-owner');
      expect(await r('test.account-owner')).toEqual(
        expect.arrayContaining(['outlet_flash', 'department']),
      );
      const all = await c.query<{ code: string }>(
        `select code from core.hierarchy_node where tenant_id = $1 and type = 'org'
            and kind = 'outlet' and archived_at is null`,
        [ids.tenant()],
      );
      expect(await placesOf(c, owner, 'outlet_flash')).toEqual(all.rows.map((x) => x.code).sort());
      const solo = await as(c, owner, 'select * from rpt.outlet_flash($1, current_date)', [
        ids.node('TEST-SOLO-BAR'),
      ]);
      expect(solo.error).toBe('NOT_AUTHORISED');
    });
  });

  it('the owner reads reports but changes nothing: REPORTS is view-only', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ group: string; access: string }>(
        `select g.code as group, p.access from core.domain_policy p
           join core.domain d on d.id = p.domain_id
           join core.security_group g on g.id = p.group_id
          where d.code = 'REPORTS' and g.tenant_id = $1 order by g.code`,
        [ids.tenant()],
      );
      expect(rows).toEqual([{ group: 'ACCOUNT_OWNER', access: 'view' }]);
    });
  });
});

describe('reports: the rpt tables behind them', () => {
  it('frontline staff read no report rows: no sales, labour or task totals', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`select rpt.rebuild(current_date - 35, current_date - 1)`);
      const seen: string[] = [];
      for (const p of await everyone(c)) {
        if (!p.groups.every((g) => FRONTLINE.has(g))) continue;
        for (const t of ['rpt.sales_day', 'rpt.labour_day', 'rpt.task_day']) {
          const r = await as<{ n: number }>(c, p.id, `select count(*)::int as n from ${t}`);
          if (r.error !== undefined || r.rows[0]!.n > 0) seen.push(`${p.username} ${t}`);
        }
        // staff without a store see no store figures either (stock users see their
        // store's, as they already see its stock levels)
        if (!p.groups.includes('STOCK_USER')) {
          const r = await as<{ n: number }>(
            c,
            p.id,
            'select count(*)::int as n from rpt.store_day',
          );
          if (r.error !== undefined || r.rows[0]!.n > 0) seen.push(`${p.username} rpt.store_day`);
        }
      }
      expect(seen).toEqual([]);
    });
  }, 180_000);

  it('app users cannot write report rows; only the rebuild does', async () => {
    await inRolledBackTx(async (c) => {
      const gm = ids.user('test.general-manager.1.0');
      for (const sql of [
        `insert into rpt.task_day (tenant_id, org_node_id, business_date, due, done, done_on_time,
                                   flagged, overdue)
         values (core.my_tenant(), '${ids.node('TEST-HOTEL-1.0-KITCHEN')}', current_date, 1, 1, 1, 0, 0)`,
        `update rpt.sales_day set sales = 0`,
        `delete from rpt.labour_day`,
        `select rpt.rebuild(current_date - 1, current_date - 1)`,
      ]) {
        const r = await as(c, gm, sql);
        expect(r.error, sql).toMatch(/permission denied/);
      }
    });
  });

  it('another customer never sees the rows', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`select rpt.rebuild(current_date - 35, current_date - 1)`);
      const solo = ids.user('test.solo.bar-manager');
      for (const t of ['rpt.sales_day', 'rpt.store_day', 'rpt.labour_day', 'rpt.task_day']) {
        const r = await as<{ n: number }>(
          c,
          solo,
          `select count(*)::int as n from ${t} where tenant_id <> core.my_tenant()`,
        );
        expect(r.rows![0]!.n, t).toBe(0);
      }
    });
  });
});
