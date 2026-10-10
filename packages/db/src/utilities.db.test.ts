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

// Utilities (ADR 091): the daily meter round, its readings kept, use by day and by month; who
// sees it; no rounds while the block is off.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const ENG = 'TEST-HOTEL-1.0-ENGINEERING';
const CODE = 'METERS-TEST-HOTEL-1.0-ENGINEERING-TECHNICIAN-0900';

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

async function tick(c: PoolClient, now: string) {
  await actAs(c, 'wf_executor', null);
  await c.query('select * from ops.tasks_tick($1::timestamptz)', [now]);
  await resetRole(c);
}

const rounds = async (c: PoolClient) =>
  (
    await c.query<{ id: string }>(
      `select t.id from ops.task t join ops.checklist_template c on c.id = t.template_id
        where c.code = $1 order by t.due_at`,
      [CODE],
    )
  ).rows.map((r) => r.id);

describe('utilities', () => {
  it("the technician's daily round keeps each meter's reading; use is today's less the last", async () => {
    await inRolledBackTx(async (c) => {
      // yesterday's readings
      await c.query(
        `insert into ops.meter_reading (tenant_id, meter_id, org_node_id, read_at, value)
         select m.tenant_id, m.id, m.org_node_id, now() - interval '1 day', 1000
           from ops.meter m where m.tenant_id = $1 and m.code like 'HOTEL-1.0-%'`,
        [ids.tenant()],
      );
      const [task] = await rounds(c);
      const steps = (
        await c.query<{ id: string; label: string }>(
          `select id, label from ops.task_step where task_id = $1 order by position`,
          [task],
        )
      ).rows;
      expect(steps.map((s) => s.label)).toEqual([
        'Electricity main',
        'Generator diesel',
        'Kitchen gas',
        'Water inlet',
      ]);
      for (const [i, s] of steps.entries()) {
        await run(c, 'test.technician.1.0', `select ops.complete_step($1, $2, $3::jsonb)`, [
          task,
          s.id,
          JSON.stringify({ number: 1100 + i * 10 }),
        ]);
      }
      // saving again corrects the reading, never adds a second
      await run(c, 'test.technician.1.0', `select ops.complete_step($1, $2, $3::jsonb)`, [
        task,
        steps[0]!.id,
        JSON.stringify({ number: 1150 }),
      ]);
      const today = await run<{ meter: string; used: string }>(
        c,
        'test.chief-engineer.1.0',
        `select meter, used from ops.utility_days($1, rpt.today($1), rpt.today($1))`,
        [ids.node(ENG)],
      );
      expect(today.map((d) => [d.meter, Number(d.used)])).toEqual([
        ['Electricity main', 150],
        ['Generator diesel', 110],
        ['Kitchen gas', 120],
        ['Water inlet', 130],
      ]);
      const month = await run<{ meter: string; used: string }>(
        c,
        'test.general-manager.1.0',
        `select meter, used from ops.utility_months($1) where meter = 'Electricity main'`,
        [ids.node(ENG)],
      );
      expect(month.map((m) => Number(m.used))).toContain(150);
    });
  });

  it('lists every meter, read or not, with who reads it and when, and its last reading (ADR 097)', async () => {
    await inRolledBackTx(async (c) => {
      const before = await run<{
        meter: string;
        read_by: string;
        read_at: string;
        last_reading: string | null;
      }>(
        c,
        'test.chief-engineer.1.0',
        `select meter, read_by, read_at, last_reading::text from ops.utility_meters($1)`,
        [ids.node(ENG)],
      );
      expect(before.map((m) => m.meter)).toEqual([
        'Electricity main',
        'Generator diesel',
        'Kitchen gas',
        'Water inlet',
      ]);
      expect(new Set(before.map((m) => `${m.read_by} at ${m.read_at}`))).toEqual(
        new Set(['Technician at 09:00']),
      );
      expect(before.every((m) => m.last_reading === null)).toBe(true);
      await c.query(
        `insert into ops.meter_reading (tenant_id, meter_id, org_node_id, read_at, value)
         select m.tenant_id, m.id, m.org_node_id, now() - interval '70 days', v
           from ops.meter m, (values (1000), (1200)) x(v)
          where m.tenant_id = $1 and m.code like 'HOTEL-1.0-%' and m.name = 'Kitchen gas'`,
        [ids.tenant()],
      );
      await c.query(
        `update ops.meter_reading set read_at = read_at + interval '1 hour' where value = 1200`,
      );
      const after = await run<{ meter: string; last_reading: string | null }>(
        c,
        'test.chief-engineer.1.0',
        `select meter, last_reading::text from ops.utility_meters($1) where meter = 'Kitchen gas'`,
        [ids.node(ENG)],
      );
      expect(Number(after[0]!.last_reading)).toBe(1200);
      // the readings are kept: 70 days back is still there for the days list
      const days = await run<{ day: string }>(
        c,
        'test.chief-engineer.1.0',
        `select day from ops.utility_days($1, rpt.today($1) - 400, rpt.today($1))
          where meter = 'Kitchen gas'`,
        [ids.node(ENG)],
      );
      expect(days).toHaveLength(1);
      const r = await attemptAs(
        c,
        ids.user('test.commis.1.0'),
        `select * from ops.utility_meters($1)`,
        [ids.node(ENG)],
      );
      expect(r.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('only engineering and the managers read it; not the kitchen, not another customer', async () => {
    await inRolledBackTx(async (c) => {
      for (const who of ['test.commis.1.0', 'test.solo.bar-manager']) {
        const r = await attemptAs(
          c,
          ids.user(who),
          `select * from ops.utility_days($1, current_date - 7, current_date)`,
          [ids.node(ENG)],
        );
        expect(r.error, who).toMatch(/NOT_AUTHORISED/);
      }
      const places = await run<{ place_id: string; meters: number }>(
        c,
        'test.chief-engineer.1.0',
        `select place_id, meters from ops.utility_places()`,
      );
      expect(places).toEqual([{ place_id: ids.node(ENG), meters: 4 }]);
    });
  });

  it('no rounds while the Utilities block is off; the checklists go on', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `delete from ops.task_step where task_id in (
                       select t.id from ops.task t join ops.checklist_template c on c.id = t.template_id
                        where c.code = $1)`,
        [CODE],
      );
      await c.query(
        `delete from ops.task where template_id = (select id from ops.checklist_template where code = $1)`,
        [CODE],
      );
      await c.query(
        `update core.tenant set settings = jsonb_set(settings, '{modules}',
           coalesce(settings -> 'modules', '{}') || '{"utilities": false}') where id = $1`,
        [ids.tenant()],
      );
      await tick(c, new Date().toISOString());
      expect(await rounds(c)).toEqual([]);
      const r = await attemptAs(
        c,
        ids.user('test.chief-engineer.1.0'),
        `select * from ops.utility_places()`,
      );
      expect(r.rows).toEqual([]);
    });
  });
});
