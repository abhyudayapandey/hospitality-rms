import { join } from 'node:path';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
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
      ).toBe(18);
      expect(
        await one(
          `select count(*)::int n from core.app_user where tenant_id = $1 and demo_presenter`,
        ),
      ).toBe(1);
      // a kitchen, a restaurant floor, a bar and a stores team; a Main Store, kitchen and bar
      expect(
        (
          await c.query<{ code: string }>(
            `select code from core.hierarchy_node where tenant_id = $1 and kind = 'department'
              order by code`,
            [tenant],
          )
        ).rows.map((x) => x.code),
      ).toEqual([`${H}-BAR`, `${H}-KITCHEN`, `${H}-RESTAURANT`, `${H}-STORES-TEAM`]);
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
      // the managers have none of their own: they follow everyone else's (the template's rule)
      expect(without.rows.map((x) => x.role_code)).toEqual([
        'ACCOUNT_OWNER',
        'ASSISTANT_MANAGER',
        'BAR_MANAGER',
        'HEAD_COOK',
        'RESTAURANT_GENERAL_MANAGER',
        'SOUS_CHEF',
      ]);
    });
  });
});
