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

// Rounds after midnight belong to the night they began (ADR 169): a 22:00 to 04:00 round
// that has Monday-only steps keeps them at 00:00, 02:00 and 04:00 on Tuesday, and Sunday
// night's rounds after midnight do not pick up Monday's.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const KITCHEN = 'TEST-HOTEL-1.0-KITCHEN';

async function template(c: PoolClient, steps: object[], schedule: object) {
  const r = await attemptAs<{ id: string }>(
    c,
    ids.user('test.executive-chef.1.0'),
    `select ops.save_template(null, $1, 'Night round', $2::jsonb, $3::jsonb, $4::jsonb) as id`,
    [
      ids.node(KITCHEN),
      JSON.stringify(schedule),
      JSON.stringify({ mode: 'job_role', role: 'COMMIS' }),
      JSON.stringify(steps),
    ],
  );
  if (r.error) throw new Error(r.error);
  return r.rows![0]!.id;
}

async function tick(c: PoolClient, now: string) {
  await actAs(c, 'wf_executor', null);
  await c.query('select * from ops.tasks_tick($1::timestamptz)', [now]);
  await resetRole(c);
}

async function rounds(c: PoolClient, tpl: string) {
  const { rows } = await c.query<{ at: string; steps: string | null }>(
    `select to_char(t.due_at at time zone 'Asia/Kolkata', 'DD HH24:MI') as at,
            (select string_agg(s.label, ', ' order by s.position)
               from ops.task_step s where s.task_id = t.id) as steps
       from ops.task t where t.template_id = $1 order by t.due_at`,
    [tpl],
  );
  return rows;
}

describe('night rounds', () => {
  it("keep the night's steps after midnight", async () => {
    await inRolledBackTx(async (c) => {
      const tpl = await template(
        c,
        [
          { label: 'Hoods', kind: 'tick', days: [1] }, // Monday nights
          { label: 'Back door locked', kind: 'tick' },
        ],
        { kind: 'every_n_hours', from: '22:00', to: '04:00', every: 2 },
      );
      // Monday 5 Oct 2026, 21:00: the next 24 hours are made
      await tick(c, '2026-10-05T21:00:00+05:30');
      const made = (await rounds(c, tpl)).filter((r) => r.at <= '06 04:00');
      expect(made).toEqual([
        { at: '05 22:00', steps: 'Hoods, Back door locked' },
        { at: '06 00:00', steps: 'Hoods, Back door locked' },
        { at: '06 02:00', steps: 'Hoods, Back door locked' },
        { at: '06 04:00', steps: 'Hoods, Back door locked' },
      ]);
    });
  });

  it('a night with none of its steps has no rounds, before or after midnight', async () => {
    await inRolledBackTx(async (c) => {
      const tpl = await template(c, [{ label: 'Hoods', kind: 'tick', days: [1] }], {
        kind: 'every_n_hours',
        from: '22:00',
        to: '02:00',
        every: 2,
      });
      // Sunday night: nothing; Monday night: three rounds, the last on Tuesday at 02:00
      await tick(c, '2026-10-04T21:00:00+05:30');
      await tick(c, '2026-10-05T21:00:00+05:30');
      expect((await rounds(c, tpl)).map((r) => r.at)).toEqual(['05 22:00', '06 00:00', '06 02:00']);
    });
  });

  it('a weekly time after midnight is that day, and keeps that day’s steps', async () => {
    await inRolledBackTx(async (c) => {
      const tpl = await template(
        c,
        [{ label: 'Night audit', kind: 'tick', days: [2] }], // Tuesdays
        { kind: 'weekly', weekdays: [2], times: ['01:00'] },
      );
      await tick(c, '2026-10-05T21:00:00+05:30');
      expect(await rounds(c, tpl)).toEqual([{ at: '06 01:00', steps: 'Night audit' }]);
    });
  });
});
