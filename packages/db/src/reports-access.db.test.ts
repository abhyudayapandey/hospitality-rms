import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';
import { as, everyone, placesOf, reportsOf } from '../test/report-access';

// Who may open which report (docs/reporting.md section 5, ADR 023), for every person in
// both test customers. A report opens where its source is visible: the outlet flash where
// the person can see the outlet's sales, a department's day where they can see its
// attendance, and everyone's own week. The Account Owner holds REPORTS (read-only, the
// whole company). Frontline staff see only their own week: a server never sees the
// outlet's sales, costs or P&L.
//
// The cost controller's reports (R-2, ADR 028): cost of sales and menu engineering open
// where the person sees the menu costs (MENU view) at one of the place's stores; the stock
// and purchasing reports open at a store for its cost people: MENU view or PURCHASE_ORDERS
// modify there (store keepers, cost controllers, managers). STOCK_LEVELS and
// PURCHASE_ORDERS view are not enough: commis and bartenders hold them to use the store.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

/** Groups that make someone frontline: they never see business numbers. */
const FRONTLINE = new Set(['SELF', 'STAFF', 'STOCK_USER', 'PRODUCTION_TEAM']);

/** The store reports: a stock-holding store, for the people who answer for its cost. */
const STORE_RULE = `n.type = 'delivery' and n.holds_stock
  and (core.can('MENU', 'view', null, n.id)
       or core.can('PURCHASE_ORDERS', 'modify', null, n.id)
       or exists (select 1 from core.node_link l where l.delivery_node_id = n.id
                     and core.can('REPORTS', 'view', l.org_node_id, null)))`;

/** Every report with places, in the order rpt.my_reports() lists them. */
const PLACED = [
  'league',
  'outlet_flash',
  'department',
  'cost_of_sales',
  'menu_engineering',
  'stock_position',
  'purchasing',
  'central_kitchen',
  'people',
] as const;

/** The rule each report applies, as an independent check (n = a hierarchy_node). */
const RULES: Record<string, string> = {
  outlet_flash: `n.type = 'org' and n.kind = 'outlet'
                 and (core.can('REPORTS', 'view', n.id, null)
                      or exists (select 1 from core.node_link l where l.org_node_id = n.id
                                    and core.can('SALES', 'view', null, l.delivery_node_id)))`,
  department: `n.type = 'org' and core.is_team_place(n.id)
               and (core.can('REPORTS', 'view', n.id, null)
                    or core.can('ATTENDANCE', 'view', n.id, null))`,
  cost_of_sales: `n.type = 'org' and n.kind in ('outlet', 'site')
                  and exists (select 1 from core.node_link l
                                join core.hierarchy_node o on o.id = l.org_node_id
                                join core.hierarchy_node s on s.id = l.delivery_node_id
                               where o.path operator(extensions.<@) n.path
                                 and s.holds_stock and s.archived_at is null
                                 and (core.can('REPORTS', 'view', n.id, null)
                                      or core.can('MENU', 'view', null, s.id)))`,
  menu_engineering: `n.type = 'org' and n.kind = 'outlet'
                     and exists (select 1 from menu.menu_outlet mo where mo.org_node_id = n.id
                                    and (core.can('REPORTS', 'view', n.id, null)
                                         or core.can('MENU', 'view', null, mo.delivery_node_id)))`,
  stock_position: STORE_RULE,
  purchasing: STORE_RULE,
  // R-3 (ADR 030): a central kitchen's store, for its cost people
  central_kitchen: `${STORE_RULE}
    and exists (select 1 from core.node_link l
                  join core.hierarchy_node o on o.id = l.org_node_id
                  join core.hierarchy_node site on site.type = 'org' and site.kind = 'site'
                                               and o.path operator(extensions.<@) site.path
                 where l.delivery_node_id = n.id)`,
  // R-4 (ADR 031): the outlets of a company, region or area side by side, for whoever reads
  // their sales there (the Area Manager) or holds REPORTS, when two or more are theirs
  league: `n.type = 'org' and n.kind in ('company', 'region', 'area')
           and (core.can('REPORTS', 'view', n.id, null)
                or core.can('DERIVED_SALES', 'view', n.id, null))
           and (select count(*) from core.hierarchy_node o
                 where o.type = 'org' and o.kind = 'outlet' and o.archived_at is null
                   and o.path operator(extensions.<@) n.path
                   and rpt.can_open('outlet_flash', o.id)) >= 2`,
  // whoever keeps the worker records (HR), at any level above a department
  people: `n.type = 'org' and n.kind in ('company', 'region', 'area', 'outlet', 'site')
           and (core.can('REPORTS', 'view', n.id, null)
                or core.can('WORKERS', 'modify', n.id, null))`,
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
            mismatches.push(
              `${p.username} ${report}: got [${got.join(', ')}], want [${want.join(', ')}]`,
            );
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
        if (JSON.stringify(got) !== JSON.stringify(want))
          wrong.push(`${p.username}: ${got.join(', ')}`);
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
        const want: string[] = [];
        for (const r of PLACED) if ((await placesOf(c, p.id, r)).length) want.push(r);
        if (p.worker) want.push('my_week');
        if (JSON.stringify(listed) !== JSON.stringify(want)) {
          wrong.push(`${p.username}: got [${listed.join(', ')}], want [${want.join(', ')}]`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }, 180_000);

  it('expected shapes: GM, cost controller, chef, sous chef, HR, area manager, owner', async () => {
    await inRolledBackTx(async (c) => {
      const r = (u: string) => reportsOf(c, ids.user(u));
      const pl = (u: string, rep: string) => placesOf(c, ids.user(u), rep);
      const all6 = [
        'outlet_flash',
        'department',
        'cost_of_sales',
        'menu_engineering',
        'stock_position',
        'purchasing',
        'my_week',
      ];
      expect(await r('test.general-manager.1.0')).toEqual(all6);
      expect(await pl('test.general-manager.1.0', 'outlet_flash')).toEqual(['TEST-HOTEL-1.0']);
      expect(await pl('test.general-manager.1.0', 'cost_of_sales')).toEqual(['TEST-HOTEL-1.0']);
      expect(await r('test.cost-controller.1.0')).toEqual([
        'outlet_flash',
        'cost_of_sales',
        'menu_engineering',
        'stock_position',
        'purchasing',
        'my_week',
      ]);
      expect(await pl('test.cost-controller.1.0', 'stock_position')).toEqual(
        expect.arrayContaining(['TEST-HOTEL-1.0-BAR-STORE', 'TEST-HOTEL-1.0-KITCHEN-STORE']),
      );
      // the executive chef answers for the kitchen store: its cost of sales, stock and orders
      expect(await r('test.executive-chef.1.0')).toEqual([
        'department',
        'cost_of_sales',
        'menu_engineering',
        'stock_position',
        'purchasing',
        'my_week',
      ]);
      expect(await pl('test.executive-chef.1.0', 'stock_position')).toEqual([
        'TEST-HOTEL-1.0-KITCHEN-STORE',
      ]);
      expect(await pl('test.executive-chef.1.0', 'department')).toEqual(['TEST-HOTEL-1.0-KITCHEN']);
      expect(await r('test.sous-chef.1.0')).toEqual(['department', 'my_week']);
      expect(await r('test.hr-admin')).toEqual(['department', 'people', 'my_week']);
      expect(await pl('test.hr-admin', 'people')).toContain('TEST-COMPANY');
      // the HR executive keeps the outlet's records: the People report there, no costs
      expect(await r('test.hr-executive.1.0')).toEqual(['department', 'people', 'my_week']);
      expect(await pl('test.hr-executive.1.0', 'people')).toEqual(['TEST-HOTEL-1.0']);
      // the central kitchen's people: its own store's report
      expect(await pl('test.central-kitchen-manager', 'central_kitchen')).toEqual([
        'TEST-CENTRAL-KITCHEN-STORE',
      ]);
      expect(await r('test.central-kitchen-store-keeper')).toEqual([
        'stock_position',
        'purchasing',
        'central_kitchen',
        'my_week',
      ]);
      expect(await r('test.central-kitchen-chef')).toEqual(['my_week']);
      expect(await pl('test.general-manager.1.0', 'central_kitchen')).toEqual([]);
      expect((await pl('test.area-manager', 'outlet_flash')).length).toBeGreaterThan(1);
      expect(await r('test.steward.1.0')).toEqual(['my_week']);
      expect(await r('test.server.3.0')).toEqual(['my_week']);
      expect(await r('test.commis.1.0')).toEqual(['my_week']);
      expect(await r('test.bartender.1.0')).toEqual(['my_week']);

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
      expect(await r('test.account-owner')).toEqual(
        expect.arrayContaining([
          'cost_of_sales',
          'menu_engineering',
          'stock_position',
          'purchasing',
          'central_kitchen',
          'people',
        ]),
      );
      const soloStore = await as(c, owner, 'select * from rpt.stock_summary($1)', [
        ids.node('TEST-SOLO-BAR-BAR-STORE'),
      ]);
      expect(soloStore.error).toBe('NOT_AUTHORISED');
    });
  });

  it('with Menu and sales off, cost of sales and menu engineering are neither listed nor open', async () => {
    await inRolledBackTx(async (c) => {
      const cc = ids.user('test.cost-controller.1.0');
      await c.query(
        `update core.tenant
            set settings = coalesce(settings, '{}') || jsonb_build_object('modules',
                  coalesce(settings -> 'modules', '{}') || '{"menu_sales": false}')
          where id = $1`,
        [ids.tenant()],
      );
      expect(await reportsOf(c, cc)).toEqual([
        'outlet_flash',
        'stock_position',
        'purchasing',
        'my_week',
      ]);
      for (const fn of [
        'rpt.cost_items($1, current_date - 6, current_date)',
        'rpt.cost_totals($1, current_date - 6, current_date)',
        'rpt.menu_engineering($1, current_date - 6, current_date)',
      ]) {
        const r = await as(c, cc, `select * from ${fn}`, [ids.node('TEST-HOTEL-1.0')]);
        expect(r.error, fn).toBe('MODULE_OFF');
      }
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
