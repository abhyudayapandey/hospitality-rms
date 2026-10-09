import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  asPlatform,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  newPlatformAdmin,
  resetRole,
  type SeedIds,
} from '../test/helpers';

// Building blocks (ADR 085, after ADR 026 and 067). Every group of functionality is a block
// (a module switch) in a bundle; only the base has none. Only a platform admin switches a
// customer's blocks (platform.set_module) and puts bundles in or out of its plan
// (platform.set_bundle), both in the platform audit; nobody in a customer can. A block that is
// off is gone: core.can says no to its domains, so RLS hides its rows and functions refuse;
// the blocks that need it go off with it. Salaries & labour cost off: no labour cost anywhere.
// The registry is pinned against the code's in the loader test (loader-checks.db.test.ts).

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const ALL = [
  'stock',
  'buying',
  'recipes',
  'production',
  'prep_lists',
  'menu_sales',
  'roster',
  'clock_in',
  'pay',
  'leave',
  'swaps',
  'checklists',
  'maintenance',
  'briefing',
  'minibars',
  'events',
  'compliance',
];

async function modules(c: PoolClient, who: string): Promise<Record<string, boolean>> {
  const r = await attemptAs<{ code: string; on: boolean }>(
    c,
    ids.user(who),
    'select code, "on" from core.my_modules()',
  );
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return Object.fromEntries(r.rows.map((m) => [m.code, m.on]));
}

const offFor = (m: Record<string, boolean>) =>
  Object.keys(m)
    .filter((k) => !m[k])
    .sort();

async function plan(c: PoolClient, who: string): Promise<Record<string, boolean>> {
  const r = await attemptAs<{ code: string; in_plan: boolean }>(
    c,
    ids.user(who),
    'select code, in_plan from core.my_bundles()',
  );
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return Object.fromEntries(r.rows.map((b) => [b.code, b.in_plan]));
}

/** Test Company's switch, as the console would set it, without a platform session. */
const switchFor = (c: PoolClient, code: string, on: boolean, tenant = ids.tenant()) =>
  c.query(
    `update core.tenant set settings = jsonb_set(settings, '{modules}',
       coalesce(settings -> 'modules', '{}') || jsonb_build_object($2::text, $3::boolean))
      where id = $1`,
    [tenant, code, on],
  );

const setModule = (c: PoolClient, admin: string, tenant: string, code: string, on: boolean) =>
  asPlatform<{ changed: boolean }>(c, admin, 'select platform.set_module($1, $2, $3) as changed', [
    tenant,
    code,
    on,
  ]);

const setBundle = (c: PoolClient, admin: string, tenant: string, bundle: string, on: boolean) =>
  asPlatform<{ changed: boolean }>(c, admin, 'select platform.set_bundle($1, $2, $3) as changed', [
    tenant,
    bundle,
    on,
  ]);

describe('which blocks a customer has', () => {
  it('the database lists the blocks in order, each after the blocks it needs', async () => {
    await inRolledBackTx(async (c) => {
      const r = await c.query<{ codes: string[]; bad: string[] }>(
        `select core.module_codes() as codes,
                array(select c from unnest(core.module_codes()) with ordinality a (c, i)
                       where exists (select 1 from unnest(core.module_needs(c)) n
                                      where array_position(core.module_codes(), n) >= a.i)) as bad`,
      );
      expect(r.rows[0]!.codes).toEqual(ALL);
      expect(r.rows[0]!.bad).toEqual([]);
    });
  });

  it('every customer kept what it had: Test Company everything, the Solo Bar as file 00 says', async () => {
    await inRolledBackTx(async (c) => {
      expect(offFor(await modules(c, 'test.server.3.0'))).toEqual([]);
      // Events and Swaps off (file 00), Compliance off by default, no Hotel bundle (no rooms)
      expect(offFor(await modules(c, 'test.solo.server'))).toEqual([
        'compliance',
        'events',
        'minibars',
        'swaps',
      ]);
      const all = {
        stock_buying: true,
        kitchen_bar: true,
        people: true,
        daily_work: true,
        events_compliance: true,
      };
      expect(await plan(c, 'test.server.3.0')).toEqual({ ...all, hotel: true });
      expect(await plan(c, 'test.solo.server')).toEqual({ ...all, hotel: false });
    });
  });

  it('a block is off whenever a block it needs is off', async () => {
    await inRolledBackTx(async (c) => {
      await switchFor(c, 'stock', false);
      expect(offFor(await modules(c, 'test.commis.1.0'))).toEqual([
        'buying',
        'menu_sales',
        'minibars',
        'prep_lists',
        'production',
        'recipes',
        'stock',
      ]);
      await switchFor(c, 'stock', true);
      await switchFor(c, 'roster', false);
      expect(offFor(await modules(c, 'test.commis.1.0'))).toEqual([
        'clock_in',
        'pay',
        'roster',
        'swaps',
      ]);
    });
  });
});

describe('only a platform admin changes blocks and bundles', () => {
  it('nobody in a customer can: the old switch is gone and the platform functions refuse them', async () => {
    await inRolledBackTx(async (c) => {
      const gone = await c.query<{ n: number }>(
        `select count(*)::int as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
          where s.nspname = 'core' and p.proname = 'set_module'`,
      );
      expect(gone.rows[0]!.n).toBe(0);
      for (const who of [
        'test.account-owner',
        'test.solo.bar-manager',
        'test.general-manager.1.0',
        'test.hr-admin',
        'test.security-admin',
        'test.server.3.0',
      ]) {
        for (const [sql, params] of [
          ['select platform.set_module($1, $2, $3)', [ids.tenant(), 'events', false]],
          ['select platform.set_bundle($1, $2, $3)', [ids.tenant(), 'daily_work', false]],
          ['select * from platform.customer_modules($1)', [ids.tenant()]],
        ] as const) {
          const r = await attemptAs(c, ids.user(who), sql, [...params]);
          expect(r.error, `${who}: ${sql}`).toMatch(/NOT_AUTHORISED|permission denied/);
        }
      }
      // nor through the company settings
      const r = await attemptAs(
        c,
        ids.user('test.account-owner'),
        'select core.set_company_settings($1)',
        [JSON.stringify({ modules: { events: false } })],
      );
      expect(r.error).toMatch(/INVALID_SETTING/);
      expect(offFor(await modules(c, 'test.server.3.0'))).toEqual([]);
    });
  });

  it('a platform admin switches a block off and on; audited; a second time changes nothing', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const off = await setModule(c, admin, ids.tenant(), 'maintenance', false);
      expect(off.rows).toEqual([{ changed: true }]);
      expect((await modules(c, 'test.technician.1.0')).maintenance).toBe(false);
      expect((await modules(c, 'test.solo.server')).maintenance).toBe(true);
      expect((await setModule(c, admin, ids.tenant(), 'maintenance', false)).rows).toEqual([
        { changed: false },
      ]);
      const audit = await c.query<{ action: string; detail: unknown }>(
        `select action, detail from platform.audit_event
          where tenant_id = $1 and action like 'module_%' order by at desc limit 1`,
        [ids.tenant()],
      );
      expect(audit.rows[0]).toEqual({ action: 'module_off', detail: { module: 'maintenance' } });
      expect((await setModule(c, admin, ids.tenant(), 'maintenance', true)).rows).toEqual([
        { changed: true },
      ]);
      expect((await modules(c, 'test.technician.1.0')).maintenance).toBe(true);
    });
  });

  it('refuses a block outside the plan, a block that does not exist and a missing customer', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const solo = ids.tenant('TEST-SOLO-COMPANY');
      expect((await setModule(c, admin, solo, 'minibars', true)).error).toMatch(/NOT_IN_PLAN/);
      expect((await setModule(c, admin, solo, 'payroll', true)).error).toMatch(/INVALID_MODULE/);
      expect(
        (await setModule(c, admin, '00000000-0000-7000-8000-000000000000', 'events', true)).error,
      ).toMatch(/NOT_FOUND/);
    });
  });

  it("the console reads a customer's blocks by bundle, in order", async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      const r = await asPlatform<{
        bundle: string;
        module: string;
        in_plan: boolean;
        switched_on: boolean;
        is_on: boolean;
      }>(c, admin, 'select * from platform.customer_modules($1)', [
        ids.tenant('TEST-SOLO-COMPANY'),
      ]);
      expect(r.error).toBeUndefined();
      expect(r.rows!.map((m) => m.module)).toEqual(ALL);
      expect(r.rows!.filter((m) => m.bundle === 'events_compliance')).toEqual([
        {
          bundle: 'events_compliance',
          module: 'events',
          in_plan: true,
          switched_on: false,
          is_on: false,
        },
        {
          bundle: 'events_compliance',
          module: 'compliance',
          in_plan: true,
          switched_on: false,
          is_on: false,
        },
      ]);
      expect(r.rows!.find((m) => m.module === 'minibars')).toMatchObject({
        in_plan: false,
        switched_on: true,
        is_on: false,
      });
    });
  });

  it('a bundle out of the plan: its blocks are off; back in, every one of them is on', async () => {
    await inRolledBackTx(async (c) => {
      const admin = await newPlatformAdmin(c);
      expect((await setBundle(c, admin, ids.tenant(), 'daily_work', false)).rows).toEqual([
        { changed: true },
      ]);
      expect(offFor(await modules(c, 'test.server.3.0'))).toEqual([
        'briefing',
        'checklists',
        'maintenance',
      ]);
      const solo = ids.tenant('TEST-SOLO-COMPANY');
      expect((await setBundle(c, admin, solo, 'events_compliance', false)).error).toBeUndefined();
      expect((await setBundle(c, admin, solo, 'events_compliance', true)).error).toBeUndefined();
      // in again: what was sold is on, Events and Compliance included
      const m = await modules(c, 'test.solo.server');
      expect(m.events).toBe(true);
      expect(m.compliance).toBe(true);
      expect(m.swaps).toBe(false);
    });
  });
});

describe('a block that is off is gone', () => {
  it('core.can says no to every one of its domains, for everyone who had them; on again, yes', async () => {
    await inRolledBackTx(async (c) => {
      const domains = (
        await c.query<{ code: string; module: string; type: string }>(
          `select d.code, core.domain_module(d.code) as module, d.hierarchy_type as type
             from core.domain d
            where d.tenant_id = $1 and core.domain_module(d.code) is not null
            order by d.code`,
          [ids.tenant()],
        )
      ).rows;
      const tried = new Set<string>();
      for (const d of domains) {
        // someone who has the domain somewhere in Test Company, at that place
        const holder = (
          await c.query<{ user_id: string; node: string }>(
            `select ea.user_id, n.id as node
               from core.effective_access ea
               join core.hierarchy_node n on n.path::text = ea.path::text and n.type = ea.type
              where ea.domain = $1 and n.tenant_id = $2 and n.type = $3
              order by ea.user_id, n.id limit 1`,
            [d.code, ids.tenant(), d.type],
          )
        ).rows[0];
        if (!holder) continue;
        const can = async () => {
          const r = await attemptAs<{ ok: boolean }>(
            c,
            holder.user_id,
            `select core.can($1, 'view', $2, $3) as ok`,
            d.type === 'org' ? [d.code, holder.node, null] : [d.code, null, holder.node],
          );
          if (r.error !== undefined) throw new Error(`${d.code}: ${r.error}`);
          return r.rows[0]!.ok;
        };
        expect(await can(), `${d.code} on`).toBe(true);
        await switchFor(c, d.module, false);
        expect(await can(), `${d.code} with ${d.module} off`).toBe(false);
        await switchFor(c, d.module, true);
        expect(await can(), `${d.code} back on`).toBe(true);
        tried.add(d.module);
      }
      // every block that owns a domain was tried
      expect([...tried].sort()).toEqual(ALL.filter((m) => m !== 'prep_lists').sort());
    });
  });

  it('its rows disappear and its writes are refused; nothing is deleted', async () => {
    await inRolledBackTx(async (c) => {
      const keeper = ids.user('test.store-keeper.1.0');
      const levels = async () => {
        const r = await attemptAs<{ n: number }>(
          c,
          keeper,
          'select count(*)::int as n from inv.stock_level',
        );
        return r.rows![0]!.n;
      };
      const before = await levels();
      expect(before).toBeGreaterThan(0);
      await switchFor(c, 'stock', false);
      expect(await levels()).toBe(0);
      const events = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        `select count(*)::int as n from ops.event`,
      );
      expect(events.error).toBeUndefined();
      await switchFor(c, 'stock', true);
      expect(await levels()).toBe(before);
    });
  });

  it('a leave request is refused while Leave is off, and accepted when back on', async () => {
    await inRolledBackTx(async (c) => {
      const type = (
        await c.query<{ id: string }>(
          `select t.id from hr.leave_type t where t.tenant_id = $1 and t.code = 'UNPAID_LEAVE'`,
          [ids.tenant()],
        )
      ).rows[0]!.id;
      const ask = () =>
        attemptAs(
          c,
          ids.user('test.server.3.0'),
          'select hr.request_leave($1, current_date + 60, current_date + 60) as id',
          [type],
        );
      await switchFor(c, 'leave', false);
      expect((await ask()).error).toMatch(/MODULE_OFF|NOT_AUTHORISED/);
      await switchFor(c, 'leave', true);
      expect((await ask()).error).toBeUndefined();
    });
  });

  it('require_module says MODULE_OFF while off, for the screens', async () => {
    await inRolledBackTx(async (c) => {
      const req = (code: string) =>
        attemptAs(c, ids.user('test.server.3.0'), 'select core.require_module($1)', [code]);
      expect((await req('briefing')).error).toBeUndefined();
      await switchFor(c, 'briefing', false);
      expect((await req('briefing')).error).toMatch(/MODULE_OFF/);
      expect((await req('payroll')).error).toMatch(/INVALID_MODULE/);
    });
  });
});

describe('reports are part of the base; each needs its block', () => {
  it('without Stores & stock, no stock position or purchasing; the outlet day stays', async () => {
    await inRolledBackTx(async (c) => {
      const reports = async () => {
        const r = await attemptAs<{ report: string }>(
          c,
          ids.user('test.cost-controller.1.0'),
          'select report from rpt.my_reports()',
        );
        if (r.error !== undefined) throw new Error(r.error);
        return r.rows.map((x) => x.report);
      };
      const before = await reports();
      expect(before).toEqual(
        expect.arrayContaining(['outlet_flash', 'stock_position', 'purchasing']),
      );
      await switchFor(c, 'stock', false);
      const after = await reports();
      expect(after).not.toContain('stock_position');
      expect(after).not.toContain('purchasing');
      expect(after).toContain('outlet_flash');
    });
  });
});

describe('jobs skip a block that is off', () => {
  it('no checklist rounds without Checklists', async () => {
    await inRolledBackTx(async (c) => {
      const tick = async (now: string) => {
        await actAs(c, 'wf_executor', null);
        await c.query('select * from ops.tasks_tick($1::timestamptz)', [now]);
        await resetRole(c);
      };
      const rounds = async () =>
        (
          await c.query<{ n: number }>(
            `select count(*)::int as n from ops.task where tenant_id = $1 and kind = 'checklist'`,
            [ids.tenant()],
          )
        ).rows[0]!.n;
      await switchFor(c, 'checklists', false);
      const before = await rounds();
      await tick(new Date(Date.now() + 3 * 86_400_000).toISOString());
      expect(await rounds()).toBe(before);
      await switchFor(c, 'checklists', true);
      await tick(new Date(Date.now() + 3 * 86_400_000).toISOString());
      expect(await rounds()).toBeGreaterThan(before);
    });
  });

  it('no attendance exceptions without Clock-in', async () => {
    await inRolledBackTx(async (c) => {
      const count = async () =>
        (
          await c.query<{ n: number }>(
            `select count(*)::int as n from hr.attendance_exception where tenant_id = $1`,
            [ids.tenant()],
          )
        ).rows[0]!.n;
      await c.query(
        `delete from hr.attendance_exception where tenant_id = $1 and local_date >= current_date - 2`,
        [ids.tenant()],
      );
      const before = await count();
      await switchFor(c, 'clock_in', false);
      await actAs(c, 'wf_executor', null);
      await c.query('select * from hr.nightly_attendance()');
      await resetRole(c);
      expect(await count()).toBe(before);
      await switchFor(c, 'clock_in', true);
      await actAs(c, 'wf_executor', null);
      await c.query('select * from hr.nightly_attendance()');
      await resetRole(c);
      expect(await count()).toBeGreaterThan(before);
    });
  });
});

describe('Salaries & labour cost', () => {
  it('off: no labour cost in any report, so the total cost is materials only; on again: back', async () => {
    await inRolledBackTx(async (c) => {
      const outlet = ids.node('TEST-HOTEL-1.0');
      const labour = async () =>
        Number(
          (
            await c.query<{ v: string | null }>(
              `select sum(hourly_cost + salary_cost) as v
                 from rpt.labour_cost_of($1, current_date - 30, current_date)`,
              [outlet],
            )
          ).rows[0]!.v ?? 0,
        );
      const on = await labour();
      expect(on).toBeGreaterThan(0);
      await switchFor(c, 'pay', false);
      expect(await labour()).toBe(0);
      // the GM no longer sees pay or labour cost at all
      const gm = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        `select core.can('LABOUR_COST', 'view', $1, null) as ok`,
        [outlet],
      );
      expect(gm.rows![0]).toEqual({ ok: false });
      await switchFor(c, 'pay', true);
      expect(await labour()).toBe(on);
    });
  });
});
