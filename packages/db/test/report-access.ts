import type { PoolClient } from 'pg';
import { expect } from 'vitest';
import { attemptAs } from './helpers';

// Shared by reports-access.db.test.ts and reports-refusals-*.db.test.ts: every person of both
// test customers, and a call made as one of them.

export interface Person {
  id: string;
  username: string;
  tenant: string;
  groups: string[];
  worker: boolean;
}

export async function everyone(c: PoolClient): Promise<Person[]> {
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

export async function as<T extends object>(
  c: PoolClient,
  user: string,
  sql: string,
  params: unknown[] = [],
) {
  return attemptAs<T>(c, user, sql, params);
}

export async function reportsOf(c: PoolClient, user: string): Promise<string[]> {
  const r = await as<{ report: string }>(c, user, 'select report from rpt.my_reports()');
  if (r.error !== undefined) throw new Error(r.error);
  return r.rows.map((x) => x.report);
}

export async function placesOf(c: PoolClient, user: string, report: string): Promise<string[]> {
  const r = await as<{ code: string }>(c, user, 'select code from rpt.report_places($1)', [report]);
  if (r.error !== undefined) throw new Error(`${report}: ${r.error}`);
  return r.rows.map((x) => x.code).sort();
}

/**
 * Every report's refusals for `people` (R-1 to R-4): each place a report does not list for a
 * person must answer NOT_AUTHORISED. Returns what leaked. The reports-refusals files each take
 * a part of everyone, so they run side by side (ADR 029, 052).
 */
export async function refusalLeaks(c: PoolClient, people: readonly Person[]): Promise<string[]> {
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
                       'TEST-CENTRAL-KITCHEN-STORE', 'TEST-SOLO-BAR-BAR-STORE',
                       'TEST-HOTEL-1.0-SUPPLY', 'TEST-BAR-3.0-SUPPLY', 'TEST-SOLO-BAR-SUPPLY')`,
  );
  // stores, and supply points: "All stores" of an outlet (RPT-14, ADR 033)
  expect(stores.rows).toHaveLength(9);
  // the People report also opens at a company or area (HR admin, the owner)
  const tops = await c.query<{ id: string; code: string }>(
    `select n.id, n.code from core.hierarchy_node n join core.tenant t on t.id = n.tenant_id
      where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') and n.type = 'org'
        and n.kind in ('company', 'region', 'area')`,
  );
  const leaks: string[] = [];
  for (const p of people) {
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
    // the league table (R-4, ADR 031): companies, regions and areas only
    const league = new Set(await placesOf(c, p.id, 'league'));
    for (const o of [...tops.rows, ...outlets.rows]) {
      if (league.has(o.code)) continue;
      const fn = 'rpt.league($1, current_date - 6, current_date)';
      const r = await as(c, p.id, `select * from ${fn}`, [o.id]);
      if (r.error !== 'NOT_AUTHORISED') leaks.push(`${p.username} ${fn} ${o.code}`);
    }
  }
  return leaks;
}
