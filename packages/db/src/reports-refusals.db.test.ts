import { afterAll, describe, expect, it } from 'vitest';
import { closePools, inRolledBackTx } from '../test/helpers';
import { as, everyone, placesOf } from '../test/report-access';

// Every report refuses, for every person of both test customers, each place it does not
// list for them (R-1 to R-3: ADR 023, ADR 028, ADR 030). Split from reports-access.db.test.ts, which
// checks the lists against the rules, so the two run side by side (ADR 029).

afterAll(closePools);

describe('reports: every place not listed is refused (every user)', () => {
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
      const sites = await c.query<{ id: string; code: string }>(
        `select n.id, n.code from core.hierarchy_node n
          where n.code in ('TEST-CENTRAL-KITCHEN')`,
      );
      const stores = await c.query<{ id: string; code: string }>(
        `select n.id, n.code from core.hierarchy_node n
          where n.code in ('TEST-HOTEL-1.0-KITCHEN-STORE', 'TEST-HOTEL-1.0-BAR-STORE',
                           'TEST-HOTEL-1.0-MAIN-STORE', 'TEST-BAR-3.0-BAR-STORE',
                           'TEST-CENTRAL-KITCHEN-STORE', 'TEST-SOLO-BAR-BAR-STORE')`,
      );
      expect(stores.rows).toHaveLength(6);
      // the People report also opens at a company or area (HR admin, the owner)
      const tops = await c.query<{ id: string; code: string }>(
        `select n.id, n.code from core.hierarchy_node n join core.tenant t on t.id = n.tenant_id
          where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') and n.type = 'org'
            and n.kind in ('company', 'region', 'area')`,
      );
      const leaks: string[] = [];
      for (const p of await everyone(c)) {
        const flash = new Set(await placesOf(c, p.id, 'outlet_flash'));
        for (const o of outlets.rows) {
          if (flash.has(o.code)) continue;
          const r = await as(c, p.id, 'select * from rpt.outlet_flash($1, current_date)', [o.id]);
          if (r.error !== 'NOT_AUTHORISED') leaks.push(`${p.username} outlet_flash ${o.code}`);
        }
        const cost = new Set(await placesOf(c, p.id, 'cost_of_sales'));
        for (const o of [...outlets.rows, ...sites.rows]) {
          if (cost.has(o.code)) continue;
          for (const fn of [
            'rpt.cost_items($1, current_date - 6, current_date)',
            'rpt.cost_totals($1, current_date - 6, current_date)',
          ]) {
            const r = await as(c, p.id, `select * from ${fn}`, [o.id]);
            if (r.error !== 'NOT_AUTHORISED') leaks.push(`${p.username} ${fn} ${o.code}`);
          }
        }
        const menu = new Set(await placesOf(c, p.id, 'menu_engineering'));
        for (const o of outlets.rows) {
          if (menu.has(o.code)) continue;
          const r = await as(
            c,
            p.id,
            'select * from rpt.menu_engineering($1, current_date - 6, current_date)',
            [o.id],
          );
          if (r.error !== 'NOT_AUTHORISED') leaks.push(`${p.username} menu_engineering ${o.code}`);
        }
        for (const [report, fns] of [
          ['stock_position', ['rpt.stock_summary($1)', 'rpt.stock_items($1)']],
          [
            'purchasing',
            [
              'rpt.price_changes($1, current_date - 27, current_date)',
              'rpt.supplier_fill($1, current_date - 27, current_date)',
              'rpt.short_deliveries($1, current_date - 27, current_date)',
              'rpt.transfers_in($1, current_date - 27, current_date)',
            ],
          ],
          [
            'central_kitchen',
            [
              'rpt.kitchen_summary($1, current_date - 6, current_date)',
              'rpt.kitchen_production($1, current_date - 6, current_date)',
              'rpt.kitchen_dispatch($1, current_date - 6, current_date)',
              'rpt.kitchen_in_transit($1)',
            ],
          ],
        ] as const) {
          const mine = new Set(await placesOf(c, p.id, report));
          for (const st of stores.rows) {
            if (mine.has(st.code)) continue;
            for (const fn of fns) {
              const r = await as(c, p.id, `select * from ${fn}`, [st.id]);
              if (r.error !== 'NOT_AUTHORISED') leaks.push(`${p.username} ${fn} ${st.code}`);
            }
          }
        }
        const dept = new Set(await placesOf(c, p.id, 'department'));
        for (const d of depts.rows) {
          if (dept.has(d.code)) continue;
          for (const fn of ['rpt.department_day($1, current_date)', 'rpt.department_people($1)']) {
            const r = await as(c, p.id, `select * from ${fn}`, [d.id]);
            if (r.error !== 'NOT_AUTHORISED') leaks.push(`${p.username} ${fn} ${d.code}`);
          }
        }
        const people = new Set(await placesOf(c, p.id, 'people'));
        for (const o of [...outlets.rows, ...sites.rows, ...tops.rows, ...depts.rows]) {
          if (people.has(o.code)) continue;
          for (const fn of [
            'rpt.people_summary($1, current_date - 6, current_date)',
            'rpt.people_departments($1, current_date - 6, current_date)',
            'rpt.people_flags($1, current_date - 6, current_date)',
            'rpt.people_leave($1, current_date - 6, current_date)',
          ]) {
            const r = await as(c, p.id, `select * from ${fn}`, [o.id]);
            if (r.error !== 'NOT_AUTHORISED') leaks.push(`${p.username} ${fn} ${o.code}`);
          }
        }
      }
      expect(leaks).toEqual([]);
    });
  }, 300_000);
});
