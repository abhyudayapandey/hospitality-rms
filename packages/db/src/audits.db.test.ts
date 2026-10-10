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

// Audits & taste panels (ADR 095): Test Company's Hotel 1.0 has a weekly service audit (yes, no
// or not applicable) and a taste panel twice a month (1 to 5), both from file 29 and so in the
// Audits block. A round's score leaves out what is not applicable; the Audits screen lists the
// rounds with their scores for whoever holds AUDITS there.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

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

/** The template's next round, made by the tasks job a day ahead of it. */
async function nextRound(c: PoolClient, code: string) {
  const { rows } = await c.query<{ at: string }>(
    `select o::text as at from ops.checklist_template t,
            ops.occurrences(t.schedule, 'Asia/Kolkata', now(), now() + interval '40 days') o
      where t.tenant_id = $1 and t.code = $2 order by o limit 1`,
    [ids.tenant(), code],
  );
  await actAs(c, 'wf_executor', null);
  await c.query(`select * from ops.tasks_tick($1::timestamptz - interval '1 hour')`, [rows[0]!.at]);
  await resetRole(c);
  const t = await c.query<{ id: string }>(
    `select k.id from ops.task k join ops.checklist_template t on t.id = k.template_id
      where t.tenant_id = $1 and t.code = $2 and k.due_at = $3::timestamptz`,
    [ids.tenant(), code, rows[0]!.at],
  );
  const steps = await c.query<{ id: string; label: string }>(
    `select id, label from ops.task_step where task_id = $1 order by position`,
    [t.rows[0]!.id],
  );
  return { task: t.rows[0]!.id, steps: steps.rows };
}

describe('audits', () => {
  it('a taste panel scores its ratings as a %', async () => {
    await inRolledBackTx(async (c) => {
      const { task, steps } = await nextRound(c, 'HOTEL-1.0-TASTE-PANEL');
      for (const [i, n] of [4, 5, 3].entries()) {
        await run(c, 'test.executive-chef.1.0', `select ops.complete_step($1, $2, $3::jsonb)`, [
          task,
          steps[i]!.id,
          JSON.stringify({ number: n }),
        ]);
      }
      const bad = await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        `select ops.complete_step($1, $2, $3::jsonb)`,
        [task, steps[0]!.id, JSON.stringify({ number: 6 })],
      );
      expect(bad.error).toMatch(/INVALID_VALUE/);
      await run(c, 'test.executive-chef.1.0', `select ops.complete_task($1)`, [task]);
      const [r] = await run<{ score: string }>(
        c,
        'test.general-manager.1.0',
        `select score::text from ops.audit_rounds($1) where task_id = $2`,
        [ids.node('TEST-HOTEL-1.0-KITCHEN'), task],
      );
      expect(r!.score).toBe('80.0');
    });
  });

  it('a service audit leaves out what is not applicable', async () => {
    await inRolledBackTx(async (c) => {
      const { task, steps } = await nextRound(c, 'HOTEL-1.0-SERVICE-AUDIT');
      for (const [i, a] of ['yes', 'yes', 'no', 'na'].entries()) {
        await run(c, 'test.restaurant-manager.1.0', `select ops.complete_step($1, $2, $3::jsonb)`, [
          task,
          steps[i]!.id,
          JSON.stringify({ answer: a }),
        ]);
      }
      await run(c, 'test.restaurant-manager.1.0', `select ops.complete_task($1)`, [task]);
      const [s] = await run<{ score: string }>(
        c,
        'test.restaurant-manager.1.0',
        `select ops.task_score($1)::text as score`,
        [task],
      );
      expect(s!.score).toBe('66.7');
    });
  });

  it('the Audits screen is for those who hold AUDITS', async () => {
    await inRolledBackTx(async (c) => {
      const places = await run<{ name: string; audits: number }>(
        c,
        'test.general-manager.1.0',
        `select name, audits from ops.audit_places()`,
      );
      expect(places.map((p) => p.audits).reduce((a, b) => a + b, 0)).toBe(2);
      const steward = await attemptAs(
        c,
        ids.user('test.steward.1.0'),
        `select * from ops.audit_rounds($1)`,
        [ids.node('TEST-HOTEL-1.0-RESTAURANT')],
      );
      expect(steward.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('no rounds while the Audits block is off', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `update core.tenant set settings = jsonb_set(settings, '{modules}',
           coalesce(settings -> 'modules', '{}') || '{"audits": false}') where id = $1`,
        [ids.tenant()],
      );
      await c.query(
        `delete from ops.task where template_id in (
           select id from ops.checklist_template where tenant_id = $1 and module = 'audits')`,
        [ids.tenant()],
      );
      await actAs(c, 'wf_executor', null);
      await c.query(`select * from ops.tasks_tick(now() + interval '20 days')`);
      await resetRole(c);
      const n = await c.query<{ n: number }>(
        `select count(*)::int as n from ops.task where template_id in (
           select id from ops.checklist_template where tenant_id = $1 and module = 'audits')`,
        [ids.tenant()],
      );
      expect(n.rows[0]!.n).toBe(0);
    });
  });
});
