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

// Web Push (ADR 137): a person saves, sees and removes only their own phones; only the
// browsers' push services are accepted; only the sender (wf_executor) reads what is due, once,
// for the owner's live phones, and archives a phone that has gone away.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const STEWARD = 'test.steward.1.0';
const OTHER = 'test.steward-b.1.0';
const KEY = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);
const FCM = (n: string) => `https://fcm.googleapis.com/fcm/send/${n}`;

const save = (c: PoolClient, who: string, endpoint: string) =>
  attemptAs<{ id: string }>(
    c,
    ids.user(who),
    'select ops.save_push_subscription($1, $2, $3, $4) as id',
    [endpoint, KEY, AUTH, 'Android phone'],
  );

async function asSender<T extends object>(c: PoolClient, text: string, params: unknown[] = []) {
  await actAs(c, 'wf_executor', null);
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await resetRole(c);
  }
}

async function notify(c: PoolClient, who: string, title: string, ago = '0 minutes') {
  await c.query(
    `insert into ops.notification (tenant_id, owner_user_id, kind, title, link, created_at)
     select tenant_id, id, 'test', $2, '/inbox', now() - $3::interval
       from core.app_user where id = $1`,
    [ids.user(who), title, ago],
  );
}

describe('push subscriptions: each person their own phones', () => {
  it('saves only a push service, reads only its own, and a phone moves to whoever signs in', async () => {
    await inRolledBackTx(async (c) => {
      expect((await save(c, STEWARD, FCM('one'))).error).toBeUndefined();
      for (const bad of [
        'http://fcm.googleapis.com/x',
        'https://169.254.169.254/latest',
        'https://evil.example/fcm.googleapis.com/',
      ]) {
        expect((await save(c, STEWARD, bad)).error, bad).toMatch(/INVALID_VALUE/);
      }
      // the other steward sees none of the steward's phones, and cannot remove them
      const theirs = await attemptAs<{ n: number }>(
        c,
        ids.user(OTHER),
        'select count(*)::int as n from ops.push_subscription',
      );
      expect(theirs.rows![0]!.n).toBe(0);
      await attemptAs(c, ids.user(OTHER), 'select ops.remove_push_subscription($1)', [FCM('one')]);
      const mine = await attemptAs<{ endpoint: string }>(
        c,
        ids.user(STEWARD),
        'select endpoint from ops.push_subscription where archived_at is null',
      );
      expect(mine.rows!.map((r) => r.endpoint)).toEqual([FCM('one')]);
      // nobody writes the table directly
      const direct = await attemptAs(
        c,
        ids.user(STEWARD),
        `insert into ops.push_subscription (tenant_id, owner_user_id, endpoint, p256dh, auth)
         select tenant_id, id, $2, $3, $4 from core.app_user where id = $1`,
        [ids.user(STEWARD), FCM('two'), KEY, AUTH],
      );
      expect(direct.error).toMatch(/permission denied/);

      // the same phone, signed in by the other steward: theirs now, the steward's no more
      expect((await save(c, OTHER, FCM('one'))).error).toBeUndefined();
      const after = await c.query<{ owner: string }>(
        `select owner_user_id::text as owner from ops.push_subscription
          where endpoint = $1 and archived_at is null`,
        [FCM('one')],
      );
      expect(after.rows.map((r) => r.owner)).toEqual([ids.user(OTHER)]);

      // the owner turns it off
      await attemptAs(c, ids.user(OTHER), 'select ops.remove_push_subscription($1)', [FCM('one')]);
      const left = await c.query(
        `select 1 from ops.push_subscription where endpoint = $1 and archived_at is null`,
        [FCM('one')],
      );
      expect(left.rowCount).toBe(0);
    });
  });

  it('only the sender reads what is due; the app cannot', async () => {
    await inRolledBackTx(async (c) => {
      const due = await attemptAs(c, ids.user(STEWARD), 'select * from ops.push_due(10)');
      expect(due.error).toMatch(/permission denied/);
      const result = await attemptAs(
        c,
        ids.user(STEWARD),
        'select ops.push_result($1, true, false)',
        ['00000000-0000-0000-0000-000000000000'],
      );
      expect(result.error).toMatch(/permission denied/);
    });
  });
});

describe('sending', () => {
  it('sends each new notification once to its owner phones; late ones are not sent', async () => {
    await inRolledBackTx(async (c) => {
      await asSender(c, 'select * from ops.push_due(1000)'); // whatever is waiting already
      await save(c, STEWARD, FCM('a'));
      await save(c, STEWARD, FCM('b'));
      await notify(c, STEWARD, 'Your roster is published');
      await notify(c, STEWARD, 'An old one', '20 minutes');
      await notify(c, OTHER, 'No phone, nothing sent');
      const rows = await asSender<{ endpoint: string; title: string; link: string }>(
        c,
        'select endpoint, title, link from ops.push_due(100) order by endpoint',
      );
      expect(rows).toEqual([
        { endpoint: FCM('a'), title: 'Your roster is published', link: '/inbox' },
        { endpoint: FCM('b'), title: 'Your roster is published', link: '/inbox' },
      ]);
      // once: nothing left on the next pass, the late one and the phoneless one marked too
      expect(await asSender(c, 'select * from ops.push_due(100)')).toEqual([]);
      const unpushed = await c.query(
        `select 1 from ops.notification where pushed_at is null and owner_user_id = any($1)`,
        [[ids.user(STEWARD), ids.user(OTHER)]],
      );
      expect(unpushed.rowCount).toBe(0);
    });
  });

  it('a phone that has gone, or fails five times running, is archived', async () => {
    await inRolledBackTx(async (c) => {
      const gone = (await save(c, STEWARD, FCM('gone'))).rows![0]!.id;
      const flaky = (await save(c, STEWARD, FCM('flaky'))).rows![0]!.id;
      await asSender(c, 'select ops.push_result($1, false, true)', [gone]);
      for (let i = 0; i < 4; i++)
        await asSender(c, 'select ops.push_result($1, false, false)', [flaky]);
      await asSender(c, 'select ops.push_result($1, true, false)', [flaky]); // one good resets
      for (let i = 0; i < 4; i++)
        await asSender(c, 'select ops.push_result($1, false, false)', [flaky]);
      const state = async (id: string) =>
        (
          await c.query<{ archived: boolean; failures: number }>(
            `select archived_at is not null as archived, failures
               from ops.push_subscription where id = $1`,
            [id],
          )
        ).rows[0];
      expect(await state(gone)).toMatchObject({ archived: true });
      expect(await state(flaky)).toEqual({ archived: false, failures: 4 });
      await asSender(c, 'select ops.push_result($1, false, false)', [flaky]);
      expect(await state(flaky)).toMatchObject({ archived: true });
    });
  });
});
