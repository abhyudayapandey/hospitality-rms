import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Logbook & handover (ADR 089): handovers acknowledged by whoever they are for, logs that hold
// until a time; who may write, read and acknowledge.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const RESTAURANT = 'TEST-HOTEL-1.0-RESTAURANT';
const FRONT = 'TEST-HOTEL-1.0-FRONT-OFFICE';

async function run<T extends object = Record<string, unknown>>(
  c: PoolClient,
  who: string,
  sql: string,
  params: unknown[] = [],
) {
  const r = await attemptAs<T>(c, ids.user(who), sql, params);
  if (r.error) throw new Error(`${who}: ${r.error}`);
  return r.rows!;
}

const write = (
  c: PoolClient,
  who: string,
  place: string,
  kind: string,
  body: string,
  toPlace: string | null,
  to: object | null,
  validTill: string | null = null,
) =>
  attemptAs<{ id: string }>(
    c,
    ids.user(who),
    `select ops.write_log($1, $2, $3, $4, $5::jsonb, $6::timestamptz) as id`,
    [
      ids.node(place),
      kind,
      body,
      toPlace ? ids.node(toPlace) : null,
      to ? JSON.stringify(to) : null,
      validTill,
    ],
  );

const book = (c: PoolClient, who: string, place: string) =>
  run<{
    kind: string;
    body: string;
    to_who: string | null;
    acknowledged_by: string | null;
    task_id: string | null;
    mine: boolean;
  }>(c, who, `select * from ops.logbook($1)`, [ids.node(place)]);

describe('handovers', () => {
  it('to the next shift: a To do item until someone on it acknowledges it', async () => {
    await inRolledBackTx(async (c) => {
      const w = await write(
        c,
        'test.steward.1.0',
        RESTAURANT,
        'handover',
        'Table 4 owes 2 coffees',
        RESTAURANT,
        {
          mode: 'on_shift',
        },
      );
      expect(w.error).toBeUndefined();
      const [entry] = await book(c, 'test.steward.1.0', RESTAURANT);
      expect(entry).toMatchObject({
        kind: 'handover',
        body: 'Table 4 owes 2 coffees',
        to_who: 'Whoever is on shift',
        acknowledged_by: null,
        mine: true,
      });
      const task = await c.query<{ kind: string; status: string; description: string }>(
        `select kind, status, description from ops.task where id = $1`,
        [entry!.task_id],
      );
      expect(task.rows[0]).toEqual({
        kind: 'handover',
        status: 'open',
        description: 'Table 4 owes 2 coffees',
      });
      // whoever is on shift there takes it (ops.in_pool); here, Steward B
      await c.query(`update ops.task set assignee_user_id = $2 where id = $1`, [
        entry!.task_id,
        ids.user('test.steward-b.1.0'),
      ]);
      // not finished like other tasks
      const plain = await attemptAs(
        c,
        ids.user('test.steward-b.1.0'),
        `select ops.complete_task($1, null)`,
        [entry!.task_id],
      );
      expect(plain.error).toMatch(/INVALID_STATE/);
      await run(c, 'test.steward-b.1.0', `select ops.acknowledge_handover($1)`, [entry!.task_id]);
      const [after] = await book(c, 'test.restaurant-manager.1.0', RESTAURANT);
      expect(after!.acknowledged_by).toBe('Test Steward B 1.0');
    });
  });

  it('to a named person or a job role; only they acknowledge it', async () => {
    await inRolledBackTx(async (c) => {
      const person = await write(
        c,
        'test.front-office-manager.1.0',
        FRONT,
        'handover',
        'VIP in 104 at 9',
        FRONT,
        {
          mode: 'person',
          user_id: ids.user('test.front-desk-executive.1.0'),
        },
      );
      expect(person.error).toBeUndefined();
      const [p] = await book(c, 'test.front-office-manager.1.0', FRONT);
      expect(p!.to_who).toBe('Test Front Desk Executive 1.0');
      const other = await attemptAs(
        c,
        ids.user('test.front-desk-executive-b.1.0'),
        `select ops.acknowledge_handover($1)`,
        [p!.task_id],
      );
      expect(other.error).toMatch(/NOT_AUTHORISED/);
      await run(c, 'test.front-desk-executive.1.0', `select ops.acknowledge_handover($1)`, [
        p!.task_id,
      ]);

      // from the restaurant to the kitchen's chef de partie
      const role = await write(
        c,
        'test.restaurant-manager.1.0',
        RESTAURANT,
        'handover',
        'Nut allergy at 12',
        'TEST-HOTEL-1.0-KITCHEN',
        {
          mode: 'job_role',
          role: 'CHEF_DE_PARTIE',
        },
      );
      expect(role.error).toBeUndefined();
      const mine = await run<{ kind: string }>(
        c,
        'test.chef-de-partie.1.0',
        `select kind from ops.my_tasks() where kind = 'handover'`,
      );
      expect(mine).toHaveLength(1);
    });
  });

  it('refused: writing where one does not work, to another outlet, or to nobody there', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        (
          await write(c, 'test.commis.1.0', RESTAURANT, 'handover', 'x', RESTAURANT, {
            mode: 'on_shift',
          })
        ).error,
      ).toMatch(/NOT_AUTHORISED/);
      expect(
        (
          await write(c, 'test.steward.1.0', RESTAURANT, 'handover', 'x', 'TEST-BAR-3.0', {
            mode: 'on_shift',
          })
        ).error,
      ).toMatch(/INVALID_ASSIGNEE/);
      expect(
        (
          await write(c, 'test.steward.1.0', RESTAURANT, 'handover', 'x', RESTAURANT, {
            mode: 'job_role',
            role: 'BELLBOY',
          })
        ).error,
      ).toMatch(/INVALID_ASSIGNEE/);
      expect(
        (
          await write(c, 'test.steward.1.0', RESTAURANT, 'handover', '  ', RESTAURANT, {
            mode: 'on_shift',
          })
        ).error,
      ).toMatch(/INVALID_VALUE/);
      expect(
        (await write(c, 'test.solo.server', RESTAURANT, 'log', 'x', null, null, '2099-01-01'))
          .error,
      ).toMatch(/NOT_AUTHORISED/);
      const read = await attemptAs(
        c,
        ids.user('test.commis.1.0'),
        `select * from ops.logbook($1)`,
        [ids.node(RESTAURANT)],
      );
      expect(read.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});

describe('logs', () => {
  it('hold until their time; taken down early by whoever may write there', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        (
          await write(
            c,
            'test.steward.1.0',
            RESTAURANT,
            'log',
            'Lift 2 out of order',
            null,
            null,
            '2000-01-01',
          )
        ).error,
      ).toMatch(/INVALID_VALUE/);
      const ok = await write(
        c,
        'test.steward.1.0',
        RESTAURANT,
        'log',
        'Lift 2 out of order',
        null,
        null,
        new Date(Date.now() + 3_600_000).toISOString(),
      );
      expect(ok.error).toBeUndefined();
      const id = ok.rows![0]!.id;
      expect((await book(c, 'test.captain.1.0', RESTAURANT)).map((e) => e.body)).toContain(
        'Lift 2 out of order',
      );
      // gone when it no longer holds
      await c.query(
        `update ops.log_entry set valid_till = now() - interval '1 minute' where id = $1`,
        [id],
      );
      expect((await book(c, 'test.captain.1.0', RESTAURANT)).map((e) => e.body)).not.toContain(
        'Lift 2 out of order',
      );
      await c.query(
        `update ops.log_entry set valid_till = now() + interval '1 hour' where id = $1`,
        [id],
      );
      await run(c, 'test.restaurant-manager.1.0', `select ops.take_down_log($1)`, [id]);
      expect((await book(c, 'test.captain.1.0', RESTAURANT)).map((e) => e.body)).not.toContain(
        'Lift 2 out of order',
      );
    });
  });

  it('nothing while the Logbook block is off', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `update core.tenant set settings = jsonb_set(settings, '{modules}',
           coalesce(settings -> 'modules', '{}') || '{"logbook": false}') where id = $1`,
        [ids.tenant()],
      );
      expect(
        (
          await write(c, 'test.steward.1.0', RESTAURANT, 'handover', 'x', RESTAURANT, {
            mode: 'on_shift',
          })
        ).error,
      ).toMatch(/NOT_AUTHORISED/);
      expect(await run(c, 'test.steward.1.0', `select * from ops.logbook_places()`)).toEqual([]);
    });
  });
});
