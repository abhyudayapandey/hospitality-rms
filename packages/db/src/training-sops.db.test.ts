import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Training & SOPs (ADR 095): Test Company's file 46 puts handwashing (everyone in Hotel 1.0's
// kitchen, read and confirmed), serving an allergy (the chef de partie and commis) and the
// turndown (room attendants) in the SOP library. Me → SOPs lists one's own; "I've read this" is
// kept per version. Training sessions, attendance and test scores are kept by whoever holds
// TRAINING modify at the place.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const KITCHEN = 'TEST-HOTEL-1.0-KITCHEN';

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

const sop = async (c: PoolClient, code: string) =>
  (
    await c.query<{ id: string }>(`select id from ops.sop where tenant_id = $1 and code = $2`, [
      ids.tenant(),
      code,
    ])
  ).rows[0]!.id;

describe('SOPs', () => {
  it('each person sees the SOPs for their place and role', async () => {
    await inRolledBackTx(async (c) => {
      const titles = async (who: string) =>
        (await run<{ title: string }>(c, who, `select title from ops.my_sops()`))
          .map((s) => s.title)
          .sort();
      expect(await titles('test.commis.1.0')).toEqual([
        'Handwashing',
        'Serving a guest with an allergy',
      ]);
      expect(await titles('test.kitchen-steward.1.0')).toEqual(['Handwashing']);
      expect(await titles('test.room-attendant.1.0')).toEqual(['Evening turndown']);
      expect(await titles('test.bar-manager.3.0')).toEqual([]);
      const other = await attemptAs(
        c,
        ids.user('test.room-attendant.1.0'),
        `select * from ops.sop_page($1)`,
        [await sop(c, 'HOTEL-1.0-HANDWASH')],
      );
      expect(other.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('"I\'ve read this" is kept per version; a changed text asks again', async () => {
    await inRolledBackTx(async (c) => {
      const hand = await sop(c, 'HOTEL-1.0-HANDWASH');
      await run(c, 'test.commis.1.0', `select ops.ack_sop($1)`, [hand]);
      const acked = async () =>
        (
          await run<{ acked: boolean }>(
            c,
            'test.commis.1.0',
            `select acked from ops.my_sops() where id = $1`,
            [hand],
          )
        )[0]!.acked;
      expect(await acked()).toBe(true);
      await c.query(`update ops.sop set body = body || ' Then sanitise.' where id = $1`, [hand]);
      expect(await acked()).toBe(false);
      const turndown = await attemptAs(
        c,
        ids.user('test.room-attendant.1.0'),
        `select ops.ack_sop($1)`,
        [await sop(c, 'HOTEL-1.0-ROOM-TURNDOWN')],
      );
      expect(turndown.error).toMatch(/INVALID_STATE/);
    });
  });

  it('the kitchen head sees who has not read an SOP yet', async () => {
    await inRolledBackTx(async (c) => {
      await run(c, 'test.commis.1.0', `select ops.ack_sop($1)`, [
        await sop(c, 'HOTEL-1.0-ALLERGENS'),
      ]);
      const [row] = await run<{ people: number; acked: number; not_yet: string[] }>(
        c,
        'test.executive-chef.1.0',
        `select people, acked, not_yet from ops.sop_reading($1) where title = 'Serving a guest with an allergy'`,
        [ids.node(KITCHEN)],
      );
      expect(row!.acked).toBe(1);
      expect(row!.not_yet).toContain('Test Chef de Partie 1.0');
      expect(row!.not_yet).not.toContain('Test Commis 1.0');
      expect(row!.people).toBe(row!.not_yet.length + 1);
    });
  });
});

describe('training sessions', () => {
  it('a session, who came and their test scores', async () => {
    await inRolledBackTx(async (c) => {
      const [s] = await run<{ id: string }>(
        c,
        'test.executive-chef.1.0',
        `select ops.add_training_session($1, 'Allergen awareness', now() - interval '1 day',
                                         'Test Executive Chef 1.0', true, null) as id`,
        [ids.node(KITCHEN)],
      );
      await run(c, 'test.executive-chef.1.0', `select ops.mark_attendance($1, $2, true, 85)`, [
        s!.id,
        ids.user('test.commis.1.0'),
      ]);
      await run(c, 'test.executive-chef.1.0', `select ops.mark_attendance($1, $2, false, null)`, [
        s!.id,
        ids.user('test.commis-b.1.0'),
      ]);
      const absentScore = await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        `select ops.mark_attendance($1, $2, false, 50)`,
        [s!.id, ids.user('test.commis-b.1.0')],
      );
      expect(absentScore.error).toMatch(/INVALID_VALUE/);
      const [row] = await run<{ attendance: { name: string; attended: boolean; score: number }[] }>(
        c,
        'test.executive-chef.1.0',
        `select attendance from ops.training_sessions($1) where id = $2`,
        [ids.node(KITCHEN), s!.id],
      );
      expect(row!.attendance.map((a) => [a.name, a.attended, a.score])).toEqual([
        ['Test Commis 1.0', true, 85],
        ['Test Commis B 1.0', false, null],
      ]);
    });
  });

  it('staff keep no sessions; someone from elsewhere is not marked', async () => {
    await inRolledBackTx(async (c) => {
      const commis = await attemptAs(
        c,
        ids.user('test.commis.1.0'),
        `select ops.add_training_session($1, 'x', now(), null, false, null)`,
        [ids.node(KITCHEN)],
      );
      expect(commis.error).toMatch(/NOT_AUTHORISED/);
      const [s] = await run<{ id: string }>(
        c,
        'test.executive-chef.1.0',
        `select ops.add_training_session($1, 'Knife skills', now(), null, false, null) as id`,
        [ids.node(KITCHEN)],
      );
      const steward = await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        `select ops.mark_attendance($1, $2, true, null)`,
        [s!.id, ids.user('test.steward.1.0')],
      );
      expect(steward.error).toMatch(/INVALID_VALUE/);
    });
  });

  it('nothing while the Training block is off', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `update core.tenant set settings = jsonb_set(settings, '{modules}',
           coalesce(settings -> 'modules', '{}') || '{"training": false}') where id = $1`,
        [ids.tenant()],
      );
      expect(await run(c, 'test.commis.1.0', `select * from ops.my_sops()`)).toEqual([]);
      const chef = await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        `select * from ops.training_sessions($1)`,
        [ids.node(KITCHEN)],
      );
      expect(chef.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});
