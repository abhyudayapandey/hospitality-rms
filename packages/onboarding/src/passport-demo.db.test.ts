import { join } from 'node:path';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadCustomer } from './apply';
import { createCustomer } from './create';
import { readCustomerDir } from './dir';

// The Passport Hotel pilot demo (docs/onboarding/demo/passport-hotel, written by
// scripts/passport-demo.ts): it loads with no problems and no warnings, as a test customer,
// with what the pitch shows: a demo presenter, one person per job role, one bar store for
// the roof and the lobby, 27 rooms with minibars and a past week of activity. The console's
// path runs as platform_loader, as the production worker does: a function the loader calls
// that the role may not run fails here, not on production.

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
  'passport-hotel',
);

const PASSPORT = {
  code: 'PASSPORT-TEST',
  name: '[TEST] Passport Hotel',
  country: 'India',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  isTest: true,
  owner: {
    displayName: 'Ashesh Sajnani',
    email: null,
    username: 'test.ashesh-sajnani',
    loginType: 'username' as const,
  },
};

/** The README's step 3, as a platform admin sets it: Hotel in the plan, Compliance on. */
const plan = (c: PoolClient) =>
  c.query(
    `update core.tenant
        set settings = jsonb_set(jsonb_set(settings, '{bundles}',
                         coalesce(settings -> 'bundles', '{}') || '{"hotel": true}'),
                       '{modules}', coalesce(settings -> 'modules', '{}') || '{"compliance": true}')
      where code = 'PASSPORT-TEST'`,
  );

describe('the Passport Hotel demo', () => {
  it('imports as the README says: created in the console, dry run, apply, no changes after', async () => {
    await inRolledBackTx(async (c) => {
      const exists = await c.query(`select 1 from core.tenant where code = 'PASSPORT-TEST'`);
      if (exists.rowCount) return; // loaded here already (a local database), nothing to show
      await c.query('set local role platform_loader');
      const made = await createCustomer(c, PASSPORT, { nested: true });
      expect(made.report.issues).toEqual([]);
      await plan(c);
      const files = readCustomerDir(DIR);
      const dry = await loadCustomer(c, files, { nested: true, dryRun: true });
      expect(dry.issues).toEqual([]);
      expect(dry.warnings).toEqual([]);
      const n = (e: string) => [dry.counts[e]?.created ?? 0, dry.counts[e]?.updated ?? 0];
      // the README's step 4
      expect({
        org: n('org places'),
        delivery: n('delivery places'),
        links: n('links'),
        roles: n('job roles'),
        users: n('users'),
        workers: n('workers'),
        items: n('items'),
        locations: n('item locations'),
        menu: n('menu items'),
        rooms: n('rooms'),
        sets: n('minibar sets'),
        checks: n('minibar checks'),
        sales: n('sales days'),
        orders: n('purchase orders'),
        attendance: n('attendance sessions'),
        checklists: n('checklists'),
        meters: n('meters'),
        contents: n('room contents'),
        sops: n('SOPs'),
      }).toEqual({
        org: [12, 1],
        delivery: [6, 0],
        links: [5, 0],
        roles: [38, 0],
        users: [38, 0],
        workers: [38, 1],
        items: [80, 0],
        locations: [109, 0],
        menu: [34, 0],
        rooms: [27, 0],
        sets: [2, 0],
        checks: [53, 0],
        sales: [7, 0],
        orders: [5, 0],
        attendance: [138, 0],
        // 28 daily ones, the room ready check, the service audit, the taste panel and the
        // technician's meter round (ADR 088, 091, 095)
        checklists: [32, 0],
        meters: [5, 0],
        contents: [17, 0],
        sops: [4, 0],
      });
      expect((await loadCustomer(c, files, { nested: true })).ok).toBe(true);
      const again = await loadCustomer(c, files, { nested: true, dryRun: true });
      expect(Object.entries(again.counts).filter(([, x]) => x.created || x.updated)).toEqual([]);
      await c.query('reset role');
      // the GM answers for pest control; the executive housekeeper does it (ADR 073). A
      // reminder made before (on the GM's list) moves to them when the files are loaded again
      await c.query(`select * from ops.compliance_tick()`);
      const pest = `select t.job_role_code from ops.task t
                      join ops.compliance_item i on i.id = t.compliance_item_id
                      join core.tenant x on x.id = i.tenant_id
                     where x.code = 'PASSPORT-TEST' and i.name = 'Pest control service'
                       and t.status in ('open', 'in_progress')`;
      expect((await c.query(pest)).rows).toEqual([{ job_role_code: 'EXECUTIVE_HOUSEKEEPER' }]);
      await c.query(`update ops.task set job_role_code = 'GENERAL_MANAGER'
                      where id in (select t.id from ops.task t
                                     join ops.compliance_item i on i.id = t.compliance_item_id
                                    where i.name = 'Pest control service')`);
      await c.query('set local role platform_loader');
      expect((await loadCustomer(c, files, { nested: true })).ok).toBe(true);
      await c.query('reset role');
      expect((await c.query(pest)).rows).toEqual([{ job_role_code: 'EXECUTIVE_HOUSEKEEPER' }]);
      // file 42's checks the front desk added to the bill are marked so
      const charged = await c.query(
        `select 1 from ops.minibar_check k join core.tenant t on t.id = k.tenant_id
          where t.code = 'PASSPORT-TEST' and k.charged_by is not null`,
      );
      expect(charged.rowCount).toBeGreaterThan(0);
    });
  });

  it('loads clean, with everything the pitch needs', async () => {
    await inRolledBackTx(async (c) => {
      // created in the console with its plan (the README's steps 2 and 3), then loaded
      const exists = await c.query(`select 1 from core.tenant where code = 'PASSPORT-TEST'`);
      if (!exists.rowCount) {
        await createCustomer(c, PASSPORT, { nested: true });
        await plan(c);
      }
      const r = await loadCustomer(c, readCustomerDir(DIR), { nested: true });
      expect(r.issues).toEqual([]);
      expect(r.warnings).toEqual([]);
      expect(r.applied).toBe(true);
      const tenant = (
        await c.query<{ id: string; is_test: boolean }>(
          `select id, is_test from core.tenant where code = 'PASSPORT-TEST'`,
        )
      ).rows[0]!;
      expect(tenant.is_test).toBe(true);
      const one = async (sql: string) =>
        (await c.query<{ n: number }>(sql, [tenant.id])).rows[0]!.n;
      expect(
        await one(
          `select count(*)::int n from core.app_user where tenant_id = $1 and demo_presenter`,
        ),
      ).toBe(1);
      // one person per job role, the presenter and the owner both account owners
      expect(
        await one(
          `select count(*)::int n from (select role_code from hr.worker where tenant_id = $1
            group by role_code having count(*) > 1 and role_code <> 'ACCOUNT_OWNER') x`,
        ),
      ).toBe(0);
      expect(
        await one(
          `select count(*)::int n from ops.room where tenant_id = $1 and minibar_set_id is not null`,
        ),
      ).toBe(27);
      expect(
        await one(
          `select count(*)::int n from ops.minibar_check where tenant_id = $1 and charged_at is null`,
        ),
      ).toBeGreaterThan(0);
      // the bar is one department with one store for the roof and the lobby (ADR 083)
      const bar = r.access.filter((a) => a.username === 'passport.bar-manager');
      expect(
        new Set(bar.filter((a) => a.node_code.endsWith('-STORE')).map((a) => a.node_code)),
      ).toEqual(new Set(['PASSPORT-ASSAGAO-LAYOVER-BAR-STORE']));
      // new, or already there from an earlier load
      const all = (e: string) =>
        r.counts[e]!.created + r.counts[e]!.updated + r.counts[e]!.unchanged;
      expect(all('sales days')).toBe(7);
      expect(all('licences')).toBe(6);
      // the tepache is a prep task (ADR 084): the bartender opens it on its ingredients for
      // the litre, the method, and how many it makes
      const tepache = await c.query<{
        who: string;
        uid: string;
        task: string;
      }>(
        `select u.username as who, u.id::text as uid, t.id::text as task
           from ops.task t join inv.item i on i.id = t.item_id
           join core.app_user u on u.id = t.assignee_user_id
          where t.tenant_id = $1 and t.kind = 'prep' and i.sku = 'TEPACHE-LIQUEUR'`,
        [tenant.id],
      );
      expect(tepache.rows).toHaveLength(1);
      expect(tepache.rows[0]!.who).toBe('passport.bartender');
      // what the bartender sees on it
      await c.query(`select set_config('app.user_id', $1, true)`, [tepache.rows[0]!.uid]);
      const seen = (
        await c.query<{
          r: { portions: number; ingredients: { name: string }[]; method: unknown[] };
        }>(`select ops.prep_task_recipe($1::uuid) as r`, [tepache.rows[0]!.task])
      ).rows[0]!.r;
      await c.query(`select set_config('app.user_id', '', true)`);
      expect(seen.portions).toBe(33);
      expect(seen.ingredients.map((x) => x.name)).toContain('Pineapple');
      expect(seen.method).toHaveLength(2);
      expect(
        await one(
          `select count(*)::int n from ops.task where tenant_id = $1 and title like '%tepache%' and kind <> 'prep'`,
        ),
      ).toBe(0);
      // everyone who works shifts has a daily checklist of their own role's (ADR 075); only
      // the managers, the office and the store keeper (receiving and sending is his day) have
      // none; the executive chef's taste panel and the restaurant manager's service audit are
      // theirs (ADR 095)
      const without = await c.query<{ role_code: string }>(
        `select distinct w.role_code from hr.worker w
          where w.tenant_id = $1 and w.status = 'active'
            and not exists (select 1 from ops.checklist_template t
                             where t.tenant_id = w.tenant_id and t.archived_at is null
                               and t.assign ->> 'role' = w.role_code)
          order by 1`,
        [tenant.id],
      );
      expect(without.rows.map((x) => x.role_code)).toEqual([
        'ACCOUNTANT',
        'ACCOUNT_OWNER',
        'BANQUET_MANAGER',
        'BAR_MANAGER',
        'CHIEF_ENGINEER',
        'COST_CONTROLLER',
        'EXECUTIVE_HOUSEKEEPER',
        'FRONT_OFFICE_MANAGER',
        'GENERAL_MANAGER',
        'HR_EXECUTIVE',
        'PURCHASE_MANAGER',
        'SALES_MANAGER',
        'STORE_KEEPER',
      ]);
    });
  });
});
