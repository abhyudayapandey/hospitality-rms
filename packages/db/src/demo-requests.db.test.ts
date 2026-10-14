import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asPlatform,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  newPlatformAdmin,
  type SeedIds,
} from '../test/helpers';

// Demo requests from the website (ADR 141), written before the route and the console: the
// one write that comes with no session. Nobody may touch the table; anyone may add a request
// through the one function, which checks every field and refuses a flood; only a platform
// admin lists them and marks them handled, and that is audited.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const ADD = 'select platform.add_demo_request($1, $2, $3, $4, $5, $6) as id';
const OK = [
  'Asha Rao',
  '+91 98200 12345',
  'Asha@Example.com ',
  'Blue Bean Café',
  'restaurant',
  '2-5',
];

/** As app_rw with no session at all: no user, no platform admin (the website's request). */
async function asNobody<T extends object>(c: pg.PoolClient, sql: string, params: unknown[] = []) {
  await c.query('set local role app_rw');
  await c.query(
    `select set_config('app.user_id', '', true), set_config('app.platform_admin_id', '', true)`,
  );
  await c.query('savepoint nobody');
  try {
    const r = await c.query<T>(sql, params);
    await c.query('release savepoint nobody');
    return { rows: r.rows, error: undefined };
  } catch (e) {
    await c.query('rollback to savepoint nobody');
    return { rows: undefined, error: (e as Error).message };
  } finally {
    await c.query('reset role');
  }
}

describe('demo requests', () => {
  it('anyone adds one with no session; blank email is none, email is kept lower case', async () => {
    await inRolledBackTx(async (c) => {
      const made = await asNobody<{ id: string }>(c, ADD, OK);
      expect(made.error).toBeUndefined();
      const blank = await asNobody<{ id: string }>(c, ADD, [
        ...OK.slice(0, 2),
        '  ',
        ...OK.slice(3),
      ]);
      expect(blank.error).toBeUndefined();
      const { rows } = await c.query<{ email: string | null; name: string }>(
        'select name, email from platform.demo_request where id = any($1) order by created_at',
        [[made.rows![0]!.id, blank.rows![0]!.id]],
      );
      expect(rows).toEqual([
        { name: 'Asha Rao', email: 'asha@example.com' },
        { name: 'Asha Rao', email: null },
      ]);
    });
  });

  it('takes every kind of business on the form, franchises included', async () => {
    await inRolledBackTx(async (c) => {
      for (const kind of [
        'hotel',
        'bar',
        'restaurant',
        'qsr',
        'cloud_kitchen',
        'franchise',
        'several',
      ]) {
        expect(
          (await asNobody(c, ADD, [...OK.slice(0, 4), kind, '20+'])).error,
          kind,
        ).toBeUndefined();
      }
    });
  });

  it.each([
    ['no name', 0, ''],
    ['a phone of letters', 1, 'call me'],
    ['a short phone', 1, '12345'],
    ['a bad email', 2, 'asha@'],
    ['no business', 3, '   '],
    ['an unknown kind of outlet', 4, 'spa'],
    ['an unknown number of outlets', 5, '7'],
    ['a name too long', 0, 'x'.repeat(121)],
  ])('refuses %s as INVALID_DEMO_REQUEST', async (_, field, value) => {
    await inRolledBackTx(async (c) => {
      const params = [...OK];
      params[field] = value;
      expect((await asNobody(c, ADD, params)).error).toMatch(/INVALID_DEMO_REQUEST/);
    });
  });

  it('refuses a flood: 100 an hour from everyone together', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `insert into platform.demo_request (name, phone, business, outlet_kind, outlets)
         select 'x', '9820012345', 'x', 'bar', '1' from generate_series(1, 100)`,
      );
      expect((await asNobody(c, ADD, OK)).error).toMatch(/RATE_LIMITED/);
    });
  });

  it('nobody reads or writes the table itself, and nobody without a console session lists them', async () => {
    await inRolledBackTx(async (c) => {
      expect((await asNobody(c, 'select * from platform.demo_request')).error).toMatch(
        /permission denied/,
      );
      expect((await asNobody(c, `delete from platform.demo_request`)).error).toMatch(
        /permission denied/,
      );
      expect((await asNobody(c, 'select * from platform.demo_requests()')).error).toMatch(
        /NOT_AUTHORISED/,
      );
      const owner = ids.user('test.account-owner');
      expect((await attemptAs(c, owner, 'select * from platform.demo_requests()')).error).toMatch(
        /NOT_AUTHORISED/,
      );
      expect(
        (await attemptAs(c, owner, 'select platform.mark_demo_request_handled(core.uuid_v7())'))
          .error,
      ).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('a platform admin sees new ones first, marks one handled, and that is audited', async () => {
    await inRolledBackTx(async (c) => {
      const id = (await asNobody<{ id: string }>(c, ADD, OK)).rows![0]!.id;
      const admin = await newPlatformAdmin(c);
      const count = async () =>
        (await asPlatform<{ n: number }>(c, admin, 'select platform.new_demo_requests() as n'))
          .rows![0]!.n;
      const before = await count();
      expect(before).toBeGreaterThanOrEqual(1);
      const list = await asPlatform<{ id: string; handled_at: Date | null; business: string }>(
        c,
        admin,
        'select id, handled_at, business from platform.demo_requests()',
      );
      expect(list.rows![0]).toMatchObject({ id, handled_at: null, business: 'Blue Bean Café' });

      await asPlatform(c, admin, 'select platform.mark_demo_request_handled($1)', [id]);
      expect(await count()).toBe(before - 1);
      const again = await asPlatform(c, admin, 'select platform.mark_demo_request_handled($1)', [
        id,
      ]);
      expect(again.error).toMatch(/NOT_FOUND/);
      const after = await asPlatform<{ id: string; handled_by_email: string | null }>(
        c,
        admin,
        'select id, handled_by_email from platform.demo_requests() where id = $1',
        [id],
      );
      expect(after.rows![0]!.handled_by_email).not.toBeNull();
      const { rows: audit } = await c.query<{ action: string }>(
        `select action from platform.audit_event where detail ->> 'request' = $1`,
        [id],
      );
      expect(audit.map((a) => a.action)).toEqual(['demo_request_handled']);
    });
  });
});
