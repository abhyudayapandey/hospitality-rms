import { join } from 'node:path';
import { attemptAs, closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadCustomer } from './apply';
import { createCustomer } from './create';
import { readCustomerDir } from './dir';

// The restaurant demo (docs/onboarding/demo/test-restaurant, written by
// scripts/restaurant-demo.ts from the set-up wizard's "Restaurant + Bar" outlet): it loads with
// no problems and no warnings as a test customer, as the console's path runs it
// (platform_loader), and a second load changes nothing. A restaurant with a bar that has one
// person per job role, a week behind it and a working day today.

afterAll(closePools);
vi.setConfig({ testTimeout: 300_000 });

const DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'onboarding',
  'demo',
  'test-restaurant',
);

const RESTAURANT = {
  code: 'RESTAURANT-TEST',
  name: '[TEST] Restaurant',
  country: 'India',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  isTest: true,
  owner: {
    displayName: 'Leena Sequeira',
    email: null,
    username: 'test.leena-sequeira',
    loginType: 'username' as const,
  },
};

/** The README's step 3: what the wizard's "Restaurant + Bar" buys, and Compliance on. */
const plan = (c: PoolClient) =>
  c.query(
    `update core.tenant
        set settings = jsonb_set(jsonb_set(settings, '{bundles}',
                         coalesce(settings -> 'bundles', '{}')
                         || '{"stock_buying": true, "kitchen_bar": true, "people": true,
                              "daily_work": true, "events_compliance": true}'),
                       '{modules}', coalesce(settings -> 'modules', '{}') || '{"compliance": true}')
      where code = 'RESTAURANT-TEST'`,
  );

const H = 'RESTAURANT-TEST-RESTAURANT-BAR-PANJIM';

describe('the restaurant demo', () => {
  it('imports as the README says: no problems or warnings, nothing changed after', async () => {
    await inRolledBackTx(async (c) => {
      const exists = await c.query(`select 1 from core.tenant where code = 'RESTAURANT-TEST'`);
      if (exists.rowCount) return; // loaded here already (a local database)
      await c.query('set local role platform_loader');
      const made = await createCustomer(c, RESTAURANT, { nested: true });
      expect(made.report.issues).toEqual([]);
      await plan(c);
      const files = readCustomerDir(DIR);
      const dry = await loadCustomer(c, files, { nested: true, dryRun: true });
      expect(dry.issues).toEqual([]);
      expect(dry.warnings).toEqual([]);
      const r = await loadCustomer(c, files, { nested: true });
      expect(r.issues).toEqual([]);
      expect(r.applied).toBe(true);
      const again = await loadCustomer(c, files, { nested: true, dryRun: true });
      expect(Object.entries(again.counts).filter(([, x]) => x.created || x.updated)).toEqual([]);
      await c.query('reset role');

      const tenant = (
        await c.query<{ id: string }>(`select id from core.tenant where code = 'RESTAURANT-TEST'`)
      ).rows[0]!.id;
      const one = async (sql: string) => (await c.query<{ n: number }>(sql, [tenant])).rows[0]!.n;
      // one person per job role, plus the owner and the demo presenter
      expect(
        await one(
          `select count(*)::int n from (select role_code from hr.worker where tenant_id = $1
            group by role_code having count(*) > 1 and role_code <> 'ACCOUNT_OWNER') x`,
        ),
      ).toBe(0);
      expect(
        await one(
          `select count(*)::int n from hr.worker where tenant_id = $1 and status = 'active'`,
        ),
      ).toBe(21);
      expect(
        await one(
          `select count(*)::int n from core.app_user where tenant_id = $1 and demo_presenter`,
        ),
      ).toBe(1);
      // a kitchen, a restaurant floor, a bar, a stores team, Engineering and Admin & Finance
      // (ADR 140); a Main Store, kitchen and bar
      expect(
        (
          await c.query<{ code: string }>(
            `select code from core.hierarchy_node where tenant_id = $1 and kind = 'department'
              order by code`,
            [tenant],
          )
        ).rows.map((x) => x.code),
      ).toEqual([
        `${H}-ADMIN-FINANCE`,
        `${H}-BAR`,
        `${H}-ENGINEERING`,
        `${H}-KITCHEN`,
        `${H}-RESTAURANT`,
        `${H}-STORES-TEAM`,
      ]);
      // a working restaurant: nothing below zero, every past clock-in on a shift, people on
      // today, a week of sales, the bar's count and an order still to arrive
      expect(
        (
          await c.query(
            `select i.sku from inv.stock_level s join inv.item i on i.id = s.item_id
              where i.tenant_id = $1 and s.on_hand < 0`,
            [tenant],
          )
        ).rows,
      ).toEqual([]);
      expect(
        await one(
          `select count(*)::int n from hr.attendance a
            where a.tenant_id = $1 and a.in_key like 'test-data att %'
              and not exists (select 1 from hr.shift_assignment x
                                join hr.shift s on s.id = x.shift_id and s.status = 'published'
                               where x.worker_id = a.worker_id and x.status = 'assigned'
                                 and x.start_at < a.clock_out_at and x.end_at > a.clock_in_at)`,
        ),
      ).toBe(0);
      expect(
        await one(
          `select count(*)::int n from hr.shift_assignment x
             join hr.shift s on s.id = x.shift_id and s.status = 'published'
            where x.tenant_id = $1 and x.status = 'assigned'
              and s.local_date = rpt.business_date(now(), ops.tz_of(s.org_node_id))`,
        ),
      ).toBeGreaterThan(5);
      const all = (e: string) =>
        r.counts[e]!.created + r.counts[e]!.updated + r.counts[e]!.unchanged;
      expect(all('sales days')).toBe(7);
      expect(all('menu items')).toBe(28);
      expect(all('purchase orders')).toBe(3);
      // the bar's dishes come from the bar's store, its sections are the counter and terrace
      expect(
        await one(
          `select count(*)::int n from ops.service_section s join core.hierarchy_node d on d.id = s.org_node_id
            where s.tenant_id = $1 and d.code like '%-BAR'`,
        ),
      ).toBe(2);
      // everyone on the floor, in the kitchen and behind the bar has a daily checklist of
      // their own role's (ADR 075)
      const without = await c.query<{ role_code: string }>(
        `select distinct w.role_code from hr.worker w
          where w.tenant_id = $1 and w.status = 'active'
            and not exists (select 1 from ops.checklist_template t
                             where t.tenant_id = w.tenant_id and t.archived_at is null
                               and t.assign ->> 'role' = w.role_code)
          order by 1`,
        [tenant],
      );
      // the managers follow everyone else's; the office has none (the template's rule). The
      // sous chef has the line check, the assistant manager the reset and lock-up (ADR 140)
      expect(without.rows.map((x) => x.role_code)).toEqual([
        'ACCOUNTANT',
        'ACCOUNT_OWNER',
        'BAR_MANAGER',
        'COST_CONTROLLER',
        'HEAD_COOK',
        'RESTAURANT_GENERAL_MANAGER',
      ]);

      // the starter SOPs, each at its department
      expect(
        await one(
          `select count(*)::int n from ops.sop where tenant_id = $1 and archived_at is null`,
        ),
      ).toBe(14);

      const user = async (u: string) =>
        (await c.query<{ id: string }>(`select id from core.app_user where username = $1`, [u]))
          .rows[0]!.id;
      const gm = await user('restaurant.manager');
      // the GM gives the repair to the technician, who works in Engineering (ADR 140)
      const repair = (
        await c.query<{ id: string }>(
          `select id from ops.maintenance_request where tenant_id = $1 limit 1`,
          [tenant],
        )
      ).rows[0]!.id;
      const technician = await user('restaurant.technician');
      expect(
        await attemptAs(c, gm, 'select ops.assign_maintenance($1, $2)', [repair, technician]),
      ).not.toHaveProperty('error');

      // Push today lists drinks as well as food, to the bar and the floor alike
      const push = async (u: string) =>
        (
          await attemptAs<{ menu: string }>(
            c,
            await user(u),
            'select menu from menu.my_push_today()',
          )
        ).rows!.map((x) => x.menu);
      for (const u of ['restaurant.bartender', 'restaurant.steward']) {
        expect(new Set(await push(u)), u).toEqual(new Set(['Bar', 'Food']));
      }

      // the technician reads Engineering's meters in Utilities (TE-04, ADR 164)
      const places = await attemptAs<{ id: string }>(
        c,
        technician,
        'select p.place_id as id from ops.utility_places() p',
      );
      expect(places.rows?.length).toBe(1);
      const meters = await attemptAs<{ name: string }>(
        c,
        technician,
        'select meter as name from ops.utility_meters($1) order by meter',
        [places.rows![0]!.id],
      );
      expect(meters.rows?.map((m) => m.name)).toEqual([
        'Electricity main',
        'Kitchen gas',
        'Water inlet',
      ]);
      // every Main Store item sits on a shelf, for the keeper's stock check (SK-08)
      expect(
        await one(
          `select count(*)::int n from inv.item_node l
             join core.hierarchy_node s on s.id = l.delivery_node_id
            where s.tenant_id = $1 and s.code = '${H}-MAIN-STORE' and l.archived_at is null
              and l.shelf is null`,
        ),
      ).toBe(0);
    });
  });
});
