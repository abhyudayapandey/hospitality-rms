import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  type SeedIds,
  stepPhoto,
} from '../test/helpers';

// The shift handover (ADR 118) on Test Hotel 1.0's front office: a checklist marked as a
// handover is read by the next shift of its department, every answer and the note, until they
// have seen it; never by whoever did it, nor by another department. Booking leads are a
// register: a name and a phone, closed as booked or lost.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const FO = 'TEST-HOTEL-1.0-FRONT-OFFICE';
const A = 'test.front-desk-executive.1.0';
const B = 'test.front-desk-executive-b.1.0';
const ATTENDANT = 'test.room-attendant.1.0';

async function as<T extends object>(c: PoolClient, who: string, sql: string, p: unknown[] = []) {
  const r = await attemptAs<T>(c, ids.user(who), sql, p);
  if (r.error) throw new Error(`${who}: ${r.error}`);
  return r.rows!;
}

/** A handover round for A at the front office, its two steps done, finished with a note. */
async function handoverDone(c: PoolClient, note: string | null) {
  const tpl = (
    await c.query<{ id: string }>(
      `insert into ops.checklist_template (tenant_id, org_node_id, name, schedule, assign, steps,
                                           handover)
       values ($1, $2, 'Front office handover', '{"kind":"daily","times":["15:00"]}',
               '{"mode":"on_shift"}', '[]', true) returning id`,
      [ids.tenant(), ids.node(FO)],
    )
  ).rows[0]!.id;
  const task = (
    await c.query<{ id: string }>(
      `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, status, assign_mode,
                             assignee_user_id, template_id)
       values ($1, $2, 'checklist', 'Front office handover', now(), 'open', 'person', $3, $4)
       returning id`,
      [ids.tenant(), ids.node(FO), ids.user(A), tpl],
    )
  ).rows[0]!.id;
  const steps = (
    await c.query<{ id: string }>(
      `insert into ops.task_step (tenant_id, org_node_id, task_id, position, label, kind, unit)
       values ($1, $2, $3, 1, 'Minibar charges added to bills', 'tick', null),
              ($1, $2, $3, 2, 'Cash float counted', 'number', '₹')
       returning id`,
      [ids.tenant(), ids.node(FO), task],
    )
  ).rows;
  await as(c, A, `select ops.complete_step($1, $2, ${stepPhoto()} || '{"done": true}'::jsonb)`, [
    task,
    steps[0]!.id,
  ]);
  await as(c, A, `select ops.complete_step($1, $2, ${stepPhoto()} || '{"number": 5000}'::jsonb)`, [
    task,
    steps[1]!.id,
  ]);
  await as(c, A, `select ops.complete_task($1, $2)`, [task, note]);
  return task;
}

type Card = {
  task_id: string;
  title: string;
  done_by: string;
  note: string | null;
  steps: unknown;
};
const cards = (c: PoolClient, who: string) =>
  as<Card>(c, who, `select task_id::text, title, done_by, note, steps from ops.last_handovers()`);

describe('the shift handover (ADR 118)', () => {
  it('keeps the note on its own and shows the next shift every answer', async () => {
    await inRolledBackTx(async (c) => {
      const task = await handoverDone(c, 'Room 104 wants a late checkout');
      const t = await c.query(`select done_note, description from ops.task where id = $1`, [task]);
      expect(t.rows[0]).toEqual({ done_note: 'Room 104 wants a late checkout', description: null });
      const mine = await cards(c, B);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        task_id: task,
        title: 'Front office handover',
        done_by: 'Test Front Desk Executive 1.0',
        note: 'Room 104 wants a late checkout',
      });
      expect(mine[0]!.steps).toMatchObject([
        { label: 'Minibar charges added to bills', done: true },
        { label: 'Cash float counted', num: 5000, unit: '₹', done: true },
      ]);
      // the manager of the department too
      expect(await cards(c, 'test.front-office-manager.1.0')).toHaveLength(1);
    });
  });

  it('is never shown to whoever did it, nor to another department', async () => {
    await inRolledBackTx(async (c) => {
      await handoverDone(c, null);
      expect(await cards(c, A)).toEqual([]);
      expect(await cards(c, ATTENDANT)).toEqual([]);
    });
  });

  it('leaves Home once seen; only for whoever it is for', async () => {
    await inRolledBackTx(async (c) => {
      const task = await handoverDone(c, 'All quiet');
      await as(c, ATTENDANT, `select ops.see_handover($1)`, [task]);
      expect(
        (
          await c.query<{ n: number }>(
            `select count(*)::int n from ops.handover_seen where task_id = $1`,
            [task],
          )
        ).rows[0]!.n,
      ).toBe(0);
      await as(c, B, `select ops.see_handover($1)`, [task]);
      expect(await cards(c, B)).toEqual([]);
      expect(await cards(c, 'test.front-office-manager.1.0')).toHaveLength(1);
    });
  });

  it('only shows the last round of a handover, and only for a day', async () => {
    await inRolledBackTx(async (c) => {
      const old = await handoverDone(c, 'first');
      await c.query(
        `update ops.task set completed_at = now() - interval '25 hours' where id = $1`,
        [old],
      );
      expect(await cards(c, B)).toEqual([]);
    });
  });
});

describe('booking leads (ADR 118)', () => {
  it('need a name and a phone, and close as booked or lost', async () => {
    await inRolledBackTx(async (c) => {
      const add = (fields: object) =>
        attemptAs<{ id: string }>(
          c,
          ids.user(A),
          `select ops.add_register_entry($1, 'leads', $2::jsonb) as id`,
          [ids.node(FO), JSON.stringify(fields)],
        );
      expect((await add({ name: 'Mr Rao' })).error).toMatch(/INVALID_VALUE/);
      const ok = await add({
        name: 'Mr Rao',
        phone: '98200 00000',
        dates: '12 to 14 Nov',
        rate: '6500',
      });
      expect(ok.error).toBeUndefined();
      await as(c, A, `select ops.close_register_entry($1, 'Booked', null)`, [ok.rows![0]!.id]);
      const row = await c.query(`select status, outcome from ops.register_entry where id = $1`, [
        ok.rows![0]!.id,
      ]);
      expect(row.rows[0]).toEqual({ status: 'closed', outcome: 'Booked' });
    });
  });
});
