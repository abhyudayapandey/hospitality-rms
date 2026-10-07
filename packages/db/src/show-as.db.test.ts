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

// Show as someone else, for demos (ADR 071). Only a demo presenter in a test customer may,
// only as an active person of their own company, only after core.begin_show_as; every request
// shown as someone is checked by core.presented_by and its audit rows say who presented;
// nothing touches the shown person's login meanwhile.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const PRESENTER = 'test.account-owner';
const TARGET = 'test.bar-manager.3.0';

async function makePresenter(c: PoolClient, username = PRESENTER) {
  await c.query(`update core.app_user set demo_presenter = true where id = $1`, [
    ids.user(username),
  ]);
}

/** Runs `sql` as `target` shown by `presenter`, in a savepoint; the error code or the rows. */
async function shown<T extends object>(
  c: PoolClient,
  presenter: string,
  target: string,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows?: T[]; error?: string }> {
  await actAs(c, 'app_rw', target);
  await c.query('savepoint shown');
  try {
    await c.query(`select core.presented_by($1)`, [presenter]);
    const r = await c.query<T>(sql, params);
    await c.query('release savepoint shown');
    return { rows: r.rows };
  } catch (err) {
    await c.query('rollback to savepoint shown');
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    await c.query(`select set_config('app.presented_by', '', true)`);
    await resetRole(c);
  }
}

describe('who may present', () => {
  it('only a flagged person in a test customer; never in a real one', async () => {
    await inRolledBackTx(async (c) => {
      const owner = ids.user(PRESENTER);
      const before = await attemptAs<{ ok: boolean }>(c, owner, 'select core.am_presenter() ok');
      expect(before.rows?.[0]?.ok).toBe(false);
      expect((await attemptAs(c, owner, 'select * from core.show_as_people()')).error).toMatch(
        /NOT_AUTHORISED/,
      );
      await makePresenter(c);
      const after = await attemptAs<{ ok: boolean }>(c, owner, 'select core.am_presenter() ok');
      expect(after.rows?.[0]?.ok).toBe(true);

      // a real customer cannot have one
      const t = (
        await c.query<{ id: string }>(
          `insert into core.tenant (name, code, country, currency, default_timezone, is_test)
           values ('Real Co', 'REAL-SHOW-AS', 'India', 'INR', 'Asia/Kolkata', false)
           returning id`,
        )
      ).rows[0]!.id;
      await c.query('savepoint real');
      await expect(
        c.query(
          `insert into core.app_user (tenant_id, kind, display_name, demo_presenter)
           values ($1, 'human', 'Real Person', true)`,
          [t],
        ),
      ).rejects.toThrow(/NOT_A_TEST_CUSTOMER/);
      await c.query('rollback to savepoint real');
    });
  });

  it('lists active people of their own company only, never themselves', async () => {
    await inRolledBackTx(async (c) => {
      await makePresenter(c);
      const r = await attemptAs<{ id: string; name: string; job_title: string | null }>(
        c,
        ids.user(PRESENTER),
        'select * from core.show_as_people()',
      );
      const people = r.rows!;
      expect(people.map((p) => p.id)).toContain(ids.user(TARGET));
      expect(people.map((p) => p.id)).not.toContain(ids.user(PRESENTER));
      // the other test customer's people are not there
      expect(people.map((p) => p.id)).not.toContain(ids.user('test.solo.bar-manager'));
      expect(people.find((p) => p.id === ids.user(TARGET))?.job_title).toBe('Bar Manager');
    });
  });
});

describe('showing as someone', () => {
  it('needs begin_show_as first; ends with end_show_as', async () => {
    await inRolledBackTx(async (c) => {
      await makePresenter(c);
      const owner = ids.user(PRESENTER);
      const target = ids.user(TARGET);
      // not begun: refused
      expect((await shown(c, owner, target, 'select 1')).error).toMatch(/NOT_AUTHORISED/);
      expect(
        (await attemptAs(c, owner, 'select core.begin_show_as($1)', [target])).error,
      ).toBeUndefined();
      const ok = await attemptAs<{ ok: boolean }>(c, owner, 'select core.showing_as($1) ok', [
        target,
      ]);
      expect(ok.rows?.[0]?.ok).toBe(true);
      // now the request runs as the bar manager, and sees what they see
      const r = await shown<{ id: string }>(c, owner, target, 'select id from core.me()');
      expect(r.rows?.[0]?.id).toBe(target);
      // switching to someone else ends the first
      const other = ids.user('test.head-cook.3.0');
      await attemptAs(c, owner, 'select core.begin_show_as($1)', [other]);
      expect((await shown(c, owner, target, 'select 1')).error).toMatch(/NOT_AUTHORISED/);
      expect((await shown(c, owner, other, 'select 1')).error).toBeUndefined();
      await attemptAs(c, owner, 'select core.end_show_as()');
      expect((await shown(c, owner, other, 'select 1')).error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('refuses a non-presenter, another company, an inactive person and a service user', async () => {
    await inRolledBackTx(async (c) => {
      const gm = ids.user('test.general-manager.1.0');
      // not a presenter
      expect(
        (await attemptAs(c, gm, 'select core.begin_show_as($1)', [ids.user(TARGET)])).error,
      ).toMatch(/NOT_AUTHORISED/);
      await makePresenter(c);
      const owner = ids.user(PRESENTER);
      // another company
      expect(
        (
          await attemptAs(c, owner, 'select core.begin_show_as($1)', [
            ids.user('test.solo.bar-manager'),
          ])
        ).error,
      ).toMatch(/NOT_AUTHORISED/);
      // themselves
      expect((await attemptAs(c, owner, 'select core.begin_show_as($1)', [owner])).error).toMatch(
        /NOT_AUTHORISED/,
      );
      // a service user
      const svc = (
        await c.query<{ id: string }>(
          `select id from core.app_user where kind = 'service' and tenant_id =
             (select tenant_id from core.app_user where id = $1) limit 1`,
          [owner],
        )
      ).rows[0];
      if (svc) {
        expect(
          (await attemptAs(c, owner, 'select core.begin_show_as($1)', [svc.id])).error,
        ).toMatch(/NOT_AUTHORISED/);
      }
      // begun, then the person leaves: refused at once
      const target = ids.user(TARGET);
      await attemptAs(c, owner, 'select core.begin_show_as($1)', [target]);
      await c.query(`update core.app_user set status = 'inactive' where id = $1`, [target]);
      expect((await shown(c, owner, target, 'select 1')).error).toMatch(/NOT_AUTHORISED/);
      await c.query(`update core.app_user set status = 'active' where id = $1`, [target]);
      // the presenter loses the flag: refused at once
      await c.query(`update core.app_user set demo_presenter = false where id = $1`, [owner]);
      expect((await shown(c, owner, target, 'select 1')).error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('cannot be set up from the app: no direct access to the log, no nesting', async () => {
    await inRolledBackTx(async (c) => {
      await makePresenter(c);
      const owner = ids.user(PRESENTER);
      const target = ids.user(TARGET);
      expect(
        (
          await attemptAs(
            c,
            owner,
            `insert into core.show_as_log (tenant_id, presenter_id, target_id)
             select tenant_id, $1, $2 from core.app_user where id = $1`,
            [owner, target],
          )
        ).error,
      ).toMatch(/permission denied/);
      expect((await attemptAs(c, owner, 'select * from core.show_as_log')).error).toMatch(
        /permission denied/,
      );
      // while shown as someone, no starting another
      await attemptAs(c, owner, 'select core.begin_show_as($1)', [target]);
      const nested = await shown(c, owner, target, 'select core.begin_show_as($1)', [
        ids.user('test.head-cook.3.0'),
      ]);
      expect(nested.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});

describe('what showing as someone leaves behind', () => {
  it('audit rows say who presented', async () => {
    await inRolledBackTx(async (c) => {
      await makePresenter(c);
      const owner = ids.user(PRESENTER);
      const target = ids.user(TARGET);
      await attemptAs(c, owner, 'select core.begin_show_as($1)', [target]);
      const bar = ids.node('TEST-BAR-3.0-BAR');
      const r = await shown<{ id: string }>(
        c,
        owner,
        target,
        `select ops.save_briefing($1, 'day', 'Shown as the bar manager', '{}') as id`,
        [bar],
      );
      expect(r.error).toBeUndefined();
      const log = await c.query<{ actor_id: string; presented_by: string | null }>(
        `select actor_id, presented_by from audit.log
          where table_name = 'ops.briefing' and row_id = $1`,
        [r.rows![0]!.id],
      );
      expect(log.rows[0]).toEqual({ actor_id: target, presented_by: owner });
      // the start of showing as them is audited too
      const started = await c.query(
        `select 1 from audit.log where table_name = 'core.show_as_log' and actor_id = $1`,
        [owner],
      );
      expect(started.rowCount).toBeGreaterThan(0);
    });
  });

  it("nothing touches the shown person's login", async () => {
    await inRolledBackTx(async (c) => {
      await makePresenter(c);
      const owner = ids.user(PRESENTER);
      const target = ids.user(TARGET);
      await attemptAs(c, owner, 'select core.begin_show_as($1)', [target]);
      expect(
        (await shown(c, owner, target, 'select * from core.sign_out_everywhere()')).error,
      ).toMatch(/PRESENTING/);
      expect(
        (await shown(c, owner, target, 'select core.record_own_password_change(true)')).error,
      ).toMatch(/PRESENTING/);
      // shown as the GM (a user admin), no login admin on anyone
      const gm = ids.user('test.general-manager.1.0');
      await attemptAs(c, owner, 'select core.begin_show_as($1)', [gm]);
      expect(
        (
          await shown(c, owner, gm, `select * from core.login_admin_target($1, 'reset_password')`, [
            ids.user('test.commis.1.0'),
          ])
        ).error,
      ).toMatch(/PRESENTING/);
      // signed in as themselves, the same person still can
      const own = await attemptAs(c, target, 'select * from core.sign_out_everywhere()');
      expect(own.error).toBeUndefined();
    });
  });
});
