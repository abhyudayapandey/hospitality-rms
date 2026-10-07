import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actAs,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  resetRole,
  type SeedIds,
} from '../test/helpers';

// Modules on or off per customer (UX-3b, ADR 026). A switched-off module disappears from
// the screens and its writes are refused with MODULE_OFF; its data and the access rules
// stay as they are. Only the Account Owner (COMPANY_SETTINGS modify at the company) turns
// modules on or off, only for their own company, and every change is in the audit log.
// The test data turns Events and Swaps off for Test Solo Bar Co. (file 00).

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const ALL = [
  'checklists',
  'compliance',
  'events',
  'leave',
  'maintenance',
  'menu_sales',
  'prep_lists',
  'production',
  'swaps',
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

const setModule = (c: PoolClient, who: string, code: string, on: boolean) =>
  attemptAs(c, ids.user(who), 'select core.set_module($1, $2)', [code, on]);

describe('which modules a company has', () => {
  it("the database lists the nine modules (the app's list is pinned in the loader test)", async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ codes: string[] }>('select core.module_codes() as codes');
      expect([...rows[0]!.codes].sort()).toEqual(ALL);
    });
  });

  it('every module in the plan is on unless the company turned it off', async () => {
    await inRolledBackTx(async (c) => {
      const m = await modules(c, 'test.server.3.0');
      expect(Object.keys(m).sort()).toEqual(ALL);
      expect(Object.values(m).every(Boolean)).toBe(true);
    });
  });

  it("Test Solo Bar Co. has Events and Swaps off (file 00); Test Company's are on", async () => {
    await inRolledBackTx(async (c) => {
      const solo = await modules(c, 'test.solo.server');
      expect(solo.events).toBe(false);
      expect(solo.swaps).toBe(false);
      // and Compliance is not in its plan (ADR 069)
      expect(ALL.filter((k) => !solo[k])).toEqual(['compliance', 'events', 'swaps']);
      expect((await modules(c, 'test.general-manager.1.0')).events).toBe(true);
    });
  });

  it('prep lists are off whenever production is off', async () => {
    await inRolledBackTx(async (c) => {
      expect((await setModule(c, 'test.account-owner', 'production', false)).error).toBeUndefined();
      const m = await modules(c, 'test.commis.1.0');
      expect(m.production).toBe(false);
      expect(m.prep_lists).toBe(false);
    });
  });
});

describe('who turns modules on or off', () => {
  it('the Account Owner, for their own company only; audited', async () => {
    await inRolledBackTx(async (c) => {
      const r = await setModule(c, 'test.account-owner', 'maintenance', false);
      expect(r.error).toBeUndefined();
      expect((await modules(c, 'test.technician.1.0')).maintenance).toBe(false);
      // the other company is untouched
      expect((await modules(c, 'test.solo.server')).maintenance).toBe(true);
      const audit = await c.query<{ actor_id: string; changed: string[] }>(
        `select actor_id, changed_fields as changed from audit.log
          where table_name = 'core.tenant' and row_id = $1 and occurred_at >= now()
          order by occurred_at desc limit 1`,
        [ids.tenant()],
      );
      expect(audit.rows[0]!.actor_id).toBe(ids.user('test.account-owner'));
      expect(audit.rows[0]!.changed).toContain('settings');

      // the solo owner changes only Test Solo Bar Co.
      expect((await setModule(c, 'test.solo.bar-manager', 'events', true)).error).toBeUndefined();
      expect((await modules(c, 'test.solo.server')).events).toBe(true);
      expect((await modules(c, 'test.technician.1.0')).maintenance).toBe(false);
    });
  });

  it('nobody else may: managers, HR, security admin, staff', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of [
        'test.general-manager.1.0',
        'test.area-manager',
        'test.hr-admin',
        'test.security-admin',
        'test.server.3.0',
        'test.solo.floor-manager',
      ]) {
        const r = await setModule(c, who, 'events', false);
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
      }
      expect((await modules(c, 'test.server.3.0')).events).toBe(true);
    });
  });

  it('an unknown module is refused; the settings cannot be written directly', async () => {
    await inRolledBackTx(async (c) => {
      expect((await setModule(c, 'test.account-owner', 'payroll', false)).error).toMatch(
        /INVALID_MODULE/,
      );
      const direct = await attemptAs(
        c,
        ids.user('test.account-owner'),
        `update core.tenant set settings = '{}'::jsonb`,
      );
      expect(direct.error ?? 'no error').toMatch(/permission denied|0 rows|no error/);
      const n = await c.query<{ s: unknown }>(
        'select settings as s from core.tenant where id = $1',
        [ids.tenant('TEST-SOLO-COMPANY')],
      );
      expect(n.rows[0]!.s).toMatchObject({ modules: { events: false, swaps: false } });
    });
  });
});

describe('a module that is off refuses its writes', () => {
  it('require_module says MODULE_OFF when off, nothing when on', async () => {
    await inRolledBackTx(async (c) => {
      const off = await attemptAs(
        c,
        ids.user('test.solo.server'),
        "select core.require_module('swaps')",
      );
      expect(off.error).toMatch(/MODULE_OFF/);
      const on = await attemptAs(
        c,
        ids.user('test.server.3.0'),
        "select core.require_module('swaps')",
      );
      expect(on.error).toBeUndefined();
      const prep = await setModule(c, 'test.account-owner', 'production', false);
      expect(prep.error).toBeUndefined();
      const p = await attemptAs(
        c,
        ids.user('test.commis.1.0'),
        "select core.require_module('prep_lists')",
      );
      expect(p.error).toMatch(/MODULE_OFF/);
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
      expect((await setModule(c, 'test.account-owner', 'leave', false)).error).toBeUndefined();
      expect((await ask()).error).toMatch(/MODULE_OFF/);
      expect((await setModule(c, 'test.account-owner', 'leave', true)).error).toBeUndefined();
      expect((await ask()).error).toBeUndefined();
    });
  });

  it('the tasks job makes no checklist rounds for a company with Checklists off', async () => {
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
      expect((await setModule(c, 'test.account-owner', 'checklists', false)).error).toBeUndefined();
      const before = await rounds();
      await tick(new Date(Date.now() + 3 * 86_400_000).toISOString());
      expect(await rounds()).toBe(before);
      expect((await setModule(c, 'test.account-owner', 'checklists', true)).error).toBeUndefined();
      await tick(new Date(Date.now() + 3 * 86_400_000).toISOString());
      expect(await rounds()).toBeGreaterThan(before);
    });
  });
});
