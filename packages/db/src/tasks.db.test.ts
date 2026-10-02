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

// How tasks behave (Prompt 11b, ADR 020): schedules, the tasks job, flagged readings,
// completion, prep lists and the expired-batch flow. Access is in tasks-access.db.test.ts.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const KITCHEN = 'TEST-HOTEL-1.0-KITCHEN';
const KITCHEN_STORE = 'TEST-HOTEL-1.0-KITCHEN-STORE';
const IST = 'Asia/Kolkata';

async function occurrences(c: PoolClient, schedule: object, from: string, to: string) {
  const { rows } = await c.query<{ at: Date }>(
    `select o as at from ops.occurrences($1::jsonb, $2, $3::timestamptz, $4::timestamptz) o order by o`,
    [JSON.stringify(schedule), IST, from, to],
  );
  // as IST wall-clock "YYYY-MM-DD HH:MM"
  return rows.map((r) =>
    r.at.toLocaleString('sv-SE', { timeZone: IST, hour12: false }).slice(0, 16),
  );
}

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
  const { rows } = await c.query<{ created: number; reminded: number; escalated: number }>(
    'select * from ops.tasks_tick($1::timestamptz)',
    [now],
  );
  await resetRole(c);
  return rows[0]!;
}

const notes = async (c: PoolClient, who: string, kind: string) =>
  (
    await c.query<{ title: string }>(
      `select title from ops.notification
        where owner_user_id = $1 and kind = $2 and created_at >= now() order by created_at`,
      [ids.user(who), kind],
    )
  ).rows.map((r) => r.title);

describe('schedules', () => {
  it('daily times are local to the place', async () => {
    await inRolledBackTx(async (c) => {
      const got = await occurrences(
        c,
        { kind: 'daily', times: ['07:00', '22:30'] },
        '2026-10-05T00:00:00+05:30',
        '2026-10-06T23:59:00+05:30',
      );
      expect(got).toEqual([
        '2026-10-05 07:00',
        '2026-10-05 22:30',
        '2026-10-06 07:00',
        '2026-10-06 22:30',
      ]);
    });
  });

  it('every N hours runs from the window start up to its end', async () => {
    await inRolledBackTx(async (c) => {
      const got = await occurrences(
        c,
        { kind: 'every_n_hours', every: 2, from: '08:00', to: '22:00' },
        '2026-10-05T00:00:00+05:30',
        '2026-10-05T23:59:00+05:30',
      );
      expect(got).toEqual([
        '2026-10-05 08:00',
        '2026-10-05 10:00',
        '2026-10-05 12:00',
        '2026-10-05 14:00',
        '2026-10-05 16:00',
        '2026-10-05 18:00',
        '2026-10-05 20:00',
        '2026-10-05 22:00',
      ]);
      // an uneven window stops at the last whole step
      const three = await occurrences(
        c,
        { kind: 'every_n_hours', every: 3, from: '09:30', to: '17:00' },
        '2026-10-05T00:00:00+05:30',
        '2026-10-05T23:59:00+05:30',
      );
      expect(three).toEqual(['2026-10-05 09:30', '2026-10-05 12:30', '2026-10-05 15:30']);
    });
  });

  it('a window past midnight belongs to the night it started', async () => {
    await inRolledBackTx(async (c) => {
      const got = await occurrences(
        c,
        { kind: 'every_n_hours', every: 2, from: '22:00', to: '02:00' },
        '2026-10-05T12:00:00+05:30',
        '2026-10-06T12:00:00+05:30',
      );
      expect(got).toEqual(['2026-10-05 22:00', '2026-10-06 00:00', '2026-10-06 02:00']);
    });
  });

  it('weekly on the chosen weekdays (1 = Monday)', async () => {
    await inRolledBackTx(async (c) => {
      // 5 Oct 2026 is a Monday
      const got = await occurrences(
        c,
        { kind: 'weekly', weekdays: [1, 4], times: ['09:00'] },
        '2026-10-05T00:00:00+05:30',
        '2026-10-18T23:59:00+05:30',
      );
      expect(got).toEqual([
        '2026-10-05 09:00',
        '2026-10-08 09:00',
        '2026-10-12 09:00',
        '2026-10-15 09:00',
      ]);
    });
  });

  it('refuses a schedule it cannot read', async () => {
    await inRolledBackTx(async (c) => {
      for (const bad of [
        { kind: 'daily', times: ['7am'] },
        { kind: 'weekly', weekdays: [0], times: ['09:00'] },
        { kind: 'every_n_hours', every: 5, from: '08:00', to: '22:00' },
        { kind: 'monthly' },
      ]) {
        await c.query('savepoint s');
        await expect(
          c.query(
            `select * from ops.occurrences($1::jsonb, 'UTC', now(), now() + interval '1 day')`,
            [JSON.stringify(bad)],
          ),
          JSON.stringify(bad),
        ).rejects.toThrow(/INVALID_SCHEDULE/);
        await c.query('rollback to savepoint s');
      }
    });
  });
});

describe('the tasks job', () => {
  async function template(
    c: PoolClient,
    schedule: object,
    assign: object = { mode: 'job_role', role: 'COMMIS' },
  ) {
    const [row] = await run<{ id: string }>(
      c,
      'test.executive-chef.1.0',
      `select ops.save_template(null, $1, 'Fridge temperatures', $2::jsonb, $3::jsonb, $4::jsonb) as id`,
      [
        ids.node(KITCHEN),
        JSON.stringify(schedule),
        JSON.stringify(assign),
        JSON.stringify([
          { label: 'Walk-in', kind: 'number', min: 0, max: 5, unit: '°C' },
          { label: 'Doors closed', kind: 'tick' },
        ]),
      ],
    );
    return row!.id;
  }

  it('creates each checklist once for the next 24 hours, with its steps', async () => {
    await inRolledBackTx(async (c) => {
      const tpl = await template(c, { kind: 'daily', times: ['07:00', '15:00'] });
      const now = '2026-10-05T06:00:00+05:30';
      const first = await tick(c, now);
      expect(first.created).toBeGreaterThanOrEqual(2);
      const again = await tick(c, now);
      expect(again.created).toBe(0);
      const { rows } = await c.query<{ due: string; steps: number; mode: string }>(
        `select to_char(t.due_at at time zone 'Asia/Kolkata', 'DD HH24:MI') as due,
                (select count(*)::int from ops.task_step s where s.task_id = t.id) as steps,
                t.assign_mode as mode
           from ops.task t where t.template_id = $1 order by t.due_at`,
        [tpl],
      );
      expect(rows).toEqual([
        { due: '05 07:00', steps: 2, mode: 'job_role' },
        { due: '05 15:00', steps: 2, mode: 'job_role' },
      ]);
    });
  });

  it('reminds 30 minutes before, then tells the assigner, then the lead an hour late', async () => {
    await inRolledBackTx(async (c) => {
      // the test data's checklists would fall due in the same window
      await c.query(`update ops.checklist_template set archived_at = now()`);
      // and its open tasks are all overdue by 2099: as if already chased
      await c.query(
        `update ops.task set reminded_at = now(), escalated_at = now(), escalated_head_at = now()`,
      );
      const [t] = await run<{ id: string }>(
        c,
        'test.sous-chef.1.0',
        `select ops.create_task($1, 'Label the dry store', null, $2, 'normal', $3::jsonb) as id`,
        [
          ids.node(KITCHEN),
          '2099-01-01T10:00:00+05:30',
          JSON.stringify({ mode: 'person', user_id: ids.user('test.commis.1.0') }),
        ],
      );
      expect((await tick(c, '2099-01-01T09:00:00+05:30')).reminded).toBe(0);
      expect((await tick(c, '2099-01-01T09:40:00+05:30')).reminded).toBe(1);
      expect(await notes(c, 'test.commis.1.0', 'task_due_soon')).toEqual([
        'Due soon: Label the dry store',
      ]);
      expect((await tick(c, '2099-01-01T09:45:00+05:30')).reminded).toBe(0);
      await tick(c, '2099-01-01T10:05:00+05:30');
      expect(await notes(c, 'test.sous-chef.1.0', 'task_overdue')).toEqual([
        'Overdue: Label the dry store',
      ]);
      expect(await notes(c, 'test.executive-chef.1.0', 'task_overdue')).toEqual([]);
      await tick(c, '2099-01-01T11:05:00+05:30');
      expect(await notes(c, 'test.executive-chef.1.0', 'task_overdue')).toEqual([
        'Overdue by an hour: Label the dry store',
      ]);
      // nothing more after that
      await tick(c, '2099-01-01T12:05:00+05:30');
      expect(await notes(c, 'test.executive-chef.1.0', 'task_overdue')).toHaveLength(1);
      expect(t).toBeDefined();
    });
  });

  it('stopping a checklist cancels its future instances nobody started', async () => {
    await inRolledBackTx(async (c) => {
      const tpl = await template(c, {
        kind: 'every_n_hours',
        every: 4,
        from: '00:00',
        to: '20:00',
      });
      await tick(c, new Date().toISOString());
      await run(c, 'test.executive-chef.1.0', 'select ops.archive_template($1)', [tpl]);
      const { rows } = await c.query<{ status: string; n: number }>(
        `select status, count(*)::int as n from ops.task
          where template_id = $1 and due_at > now() group by status`,
        [tpl],
      );
      expect(rows.map((r) => r.status)).toEqual(['cancelled']);
      expect((await tick(c, new Date().toISOString())).created).toBe(0);
    });
  });
});

describe('working through a checklist', () => {
  async function checklist(c: PoolClient) {
    const [row] = await run<{ id: string }>(
      c,
      'test.executive-chef.1.0',
      `select ops.create_task($1, 'Closing checks', null, now() + interval '1 hour', 'high',
                              $2::jsonb, $3::jsonb) as id`,
      [
        ids.node(KITCHEN),
        JSON.stringify({ mode: 'person', user_id: ids.user('test.commis.1.0') }),
        JSON.stringify([
          { label: 'Walk-in', kind: 'number', min: 0, max: 5, unit: '°C' },
          { label: 'Gas off', kind: 'tick', photo_required: true },
          { label: 'Handover note', kind: 'text' },
        ]),
      ],
    );
    const steps = (
      await c.query<{ id: string }>(
        `select id from ops.task_step where task_id = $1 order by position`,
        [row!.id],
      )
    ).rows.map((r) => r.id);
    return { task: row!.id, steps };
  }
  const photo = (node: string, kind = 'routine') =>
    `tasks/${kind}/${ids.tenant()}/${ids.node(node)}/0190a8a2-0000-7000-8000-00000000000${kind === 'keep' ? 2 : 1}.jpg`;

  it('flags a reading out of range and tells the lead', async () => {
    await inRolledBackTx(async (c) => {
      const { task, steps } = await checklist(c);
      const step = (value: object, i = 0) =>
        attemptAs<{ r: { flagged: boolean } }>(
          c,
          ids.user('test.commis.1.0'),
          'select ops.complete_step($1, $2, $3::jsonb) as r',
          [task, steps[i], JSON.stringify(value)],
        );
      expect((await step({ number: 3 })).rows![0]!.r.flagged).toBe(false);
      expect((await step({ number: 9, photo_key: photo(KITCHEN) })).rows![0]!.r.flagged).toBe(true);
      expect(await notes(c, 'test.executive-chef.1.0', 'task_flagged')).toEqual([
        'Closing checks: Walk-in is 9 °C',
      ]);
      // the flagged photo is kept: only its own copy under keep/
      const keep = (key: string) =>
        attemptAs(c, ids.user('test.commis.1.0'), 'select ops.keep_step_photo($1, $2, $3)', [
          task,
          steps[0],
          key,
        ]);
      expect((await keep(photo(KITCHEN, 'keep').replace('0002', '0009'))).error).toMatch(
        /INVALID_PHOTO/,
      );
      expect((await keep(photo(KITCHEN).replace('/routine/', '/keep/'))).error).toBeUndefined();
      // a photo is needed where the step says so, and must be for this place
      expect((await step({ done: true }, 1)).error).toMatch(/PHOTO_REQUIRED/);
      expect((await step({ done: true, photo_key: photo('TEST-HOTEL-1.0-BAR') }, 1)).error).toMatch(
        /INVALID_PHOTO/,
      );
      expect((await step({ number: 'warm' })).error).toMatch(/INVALID_VALUE/);
    });
  });

  it('is finished only when every step is done', async () => {
    await inRolledBackTx(async (c) => {
      const { task, steps } = await checklist(c);
      const done = () =>
        attemptAs(c, ids.user('test.commis.1.0'), `select ops.complete_task($1, 'All good')`, [
          task,
        ]);
      expect((await done()).error).toMatch(/STEPS_INCOMPLETE/);
      await run(c, 'test.commis.1.0', 'select ops.complete_step($1, $2, $3::jsonb)', [
        task,
        steps[0],
        JSON.stringify({ number: 4 }),
      ]);
      await run(c, 'test.commis.1.0', 'select ops.complete_step($1, $2, $3::jsonb)', [
        task,
        steps[1],
        JSON.stringify({ done: true, photo_key: photo(KITCHEN) }),
      ]);
      await run(c, 'test.commis.1.0', 'select ops.complete_step($1, $2, $3::jsonb)', [
        task,
        steps[2],
        JSON.stringify({ text: 'Fryer oil changed' }),
      ]);
      expect((await done()).error).toBeUndefined();
      const [d] = await run<{ d: { status: string; steps: { done_by_name: string }[] } }>(
        c,
        'test.sous-chef.1.0',
        'select ops.task_detail($1) as d',
        [task],
      );
      expect(d!.d.status).toBe('done');
      expect(d!.d.steps.map((s) => s.done_by_name)).toEqual([
        'Test Commis 1.0',
        'Test Commis 1.0',
        'Test Commis 1.0',
      ]);
      // it stays on My tasks for the day, as done
      const mine = await run<{ id: string; status: string }>(
        c,
        'test.commis.1.0',
        'select id, status from ops.my_tasks()',
      );
      expect(mine.find((m) => m.id === task)?.status).toBe('done');
    });
  });

  it('weekly completion counts tasks due so far, per department', async () => {
    await inRolledBackTx(async (c) => {
      // last week (IST), so every task below is due by now whatever the time of day
      const { rows: w } = await c.query<{ monday: string }>(
        `select (date_trunc('week', now() at time zone 'Asia/Kolkata') - interval '7 days')::date::text as monday`,
      );
      const monday = w[0]!.monday;
      const completion = async (week: string) =>
        run<{ place_name: string; due: number; done: number; on_time: number; pct: number | null }>(
          c,
          'test.general-manager.1.0',
          'select place_name, due, done, on_time, pct from ops.completion($1, $2::date)',
          [ids.node('TEST-HOTEL-1.0'), week],
        );
      const kitchen = async (week: string) =>
        (await completion(week)).find((r) => r.place_name.endsWith('Kitchen'))!;
      const before = await kitchen(monday);
      const create = (due: string) =>
        run<{ id: string }>(
          c,
          'test.executive-chef.1.0',
          `select ops.create_task($1, 'Wipe down', null, $2::timestamptz, 'normal', $3::jsonb, '[]') as id`,
          [
            ids.node(KITCHEN),
            due,
            JSON.stringify({ mode: 'person', user_id: ids.user('test.commis.1.0') }),
          ],
        );
      const [a] = await create(`${monday} 10:00+05:30`);
      await create(`${monday} 11:00+05:30`);
      await run(c, 'test.commis.1.0', 'select ops.complete_task($1)', [a!.id]);
      const after = await kitchen(monday);
      // done late (after its due time): done, not on time
      expect([
        after.due - before.due,
        after.done - before.done,
        after.on_time - before.on_time,
      ]).toEqual([2, 1, 0]);
      // a task due later is not counted yet
      const { rows: n } = await c.query<{ monday: string }>(
        `select date_trunc('week', (now() + interval '1 hour') at time zone 'Asia/Kolkata')::date::text as monday`,
      );
      const soon = await kitchen(n[0]!.monday);
      await create(new Date(Date.now() + 3_600_000).toISOString());
      expect((await kitchen(n[0]!.monday)).due).toBe(soon.due);
      // every department of the hotel is listed; nothing due shows no percentage
      const rows = await completion(monday);
      expect(rows.length).toBe(10);
      expect(rows.find((r) => r.place_name.endsWith('Security'))).toMatchObject({
        due: 0,
        pct: null,
      });
    });
  });
});

describe('prep lists', () => {
  it('suggest par plus event needs minus what is usable, less prep already set', async () => {
    await inRolledBackTx(async (c) => {
      // set aside the test data's open prep list (file 32)
      await c.query(
        `update ops.task set status = 'cancelled' where kind = 'prep' and status = 'open'`,
      );
      const store = ids.node(KITCHEN_STORE);
      const { rows: items } = await c.query<{ id: string }>(
        `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id
          where t.code = 'TEST-COMPANY' and i.sku = 'MINT-CHUTNEY'`,
      );
      const mint = items[0]!.id;
      await c.query(
        `update inv.item_node set par_level = 1000 where item_id = $1 and delivery_node_id = $2`,
        [mint, store],
      );
      const read = async () =>
        (
          await run<{
            sku: string;
            par: string;
            on_hand: string;
            suggested: string;
            open_tasks: string;
          }>(
            c,
            'test.commis.1.0',
            'select sku, par, on_hand, suggested, open_tasks from inv.prep_suggestions($1)',
            [store],
          )
        ).find((r) => r.sku === 'MINT-CHUTNEY')!;
      // the only batch left (140 g) is past its expiry, so none of it is usable
      expect(Number((await read()).on_hand)).toBe(0);
      expect(Number((await read()).suggested)).toBe(1000);
      const [created] = await run<{ ids: string[] }>(
        c,
        'test.sous-chef.1.0',
        `select ops.create_prep_tasks($1, $2::jsonb, now() + interval '3 hours', $3::jsonb) as ids`,
        [
          store,
          JSON.stringify([{ item_id: mint, qty: 1000 }]),
          JSON.stringify({ mode: 'job_role', role: 'COMMIS' }),
        ],
      );
      expect(Number((await read()).suggested)).toBe(0);
      const task = created!.ids[0]!;
      // a partial batch leaves the task in progress; reaching the target finishes it
      await run(c, 'test.commis.1.0', 'select ops.record_task_batch($1, 400)', [task]);
      const status = async () =>
        (await c.query<{ status: string }>('select status from ops.task where id = $1', [task]))
          .rows[0]!.status;
      expect(await status()).toBe('in_progress');
      expect(Number((await read()).open_tasks)).toBe(600);
      await run(c, 'test.commis.1.0', 'select ops.record_task_batch($1, 600)', [task]);
      expect(await status()).toBe('done');
      const { rows } = await c.query<{ n: number; made: string }>(
        `select count(*)::int as n, sum(qty_made) as made from inv.production where task_id = $1`,
        [task],
      );
      expect(rows[0]).toEqual({ n: 2, made: '1000.000000' });
    });
  });
});

describe('an expired batch, end to end', () => {
  it('report, assign, discard and remake; the trace shows on the cost side', async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node(KITCHEN_STORE);
      const { rows: b } = await c.query<{ item: string; batch_no: string }>(
        `select p.prep_item_id as item, p.batch_no from inv.production p
           join inv.item i on i.id = p.prep_item_id and i.sku = 'MINT-CHUTNEY'
          where p.delivery_node_id = $1`,
        [store],
      );
      const [r] = await run<{ id: string }>(
        c,
        'test.commis.1.0',
        'select ops.report_expired($1, $2, $3) as id',
        [store, b[0]!.item, b[0]!.batch_no],
      );
      const task = r!.id;
      expect(await notes(c, 'test.executive-chef.1.0', 'expiry_reported')).toEqual([
        `Expired: Mint Chutney batch ${b[0]!.batch_no}`,
      ]);
      // the commis cannot pick it up before the lead assigns it
      const early = await attemptAs(
        c,
        ids.user('test.commis-b.1.0'),
        'select ops.discard_expired($1, 140)',
        [task],
      );
      expect(early.error).toMatch(/NOT_AUTHORISED/);
      await run(
        c,
        'test.executive-chef.1.0',
        `select ops.assign_expiry($1, $2, now() + interval '1 hour', true)`,
        [task, ids.user('test.commis-b.1.0')],
      );
      const [d] = await run<{ d: { title: string; steps: { kind: string; value_num: number }[] } }>(
        c,
        'test.commis-b.1.0',
        'select ops.task_detail($1) as d',
        [task],
      );
      expect(d!.d.title).toBe(`Discard and remake Mint Chutney (batch ${b[0]!.batch_no})`);
      expect(d!.d.steps.map((s) => [s.kind, Number(s.value_num ?? 0)])).toEqual([
        ['discard', 140],
        ['batch', 0],
      ]);
      // assigned twice? no
      const again = await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        `select ops.assign_expiry($1, $2, now(), false)`,
        [task, ids.user('test.commis.1.0')],
      );
      expect(again.error).toMatch(/INVALID_STATE/);

      await run(c, 'test.commis-b.1.0', 'select ops.discard_expired($1, 140)', [task]);
      // the batch is gone from the store's batch list
      const batches = await run<{ batch_no: string }>(
        c,
        'test.commis-b.1.0',
        'select batch_no from inv.batches($1)',
        [store],
      );
      expect(batches.map((x) => x.batch_no)).not.toContain(b[0]!.batch_no);
      expect(
        (await c.query<{ status: string }>('select status from ops.task where id = $1', [task]))
          .rows[0]!.status,
      ).toBe('in_progress');
      await run(c, 'test.commis-b.1.0', 'select ops.record_task_batch($1, 500)', [task]);
      expect(
        (await c.query<{ status: string }>('select status from ops.task where id = $1', [task]))
          .rows[0]!.status,
      ).toBe('done');

      // the cost side: expired wastage, line by line, traced to its batch and report
      const today = new Date().toLocaleDateString('en-CA', { timeZone: IST });
      const lines = await run<{
        sku: string;
        batch_no: string;
        made_qty: string;
        wasted_qty: string;
        reported_by: string;
        discarded_by: string;
        remade_qty: string;
      }>(
        c,
        'test.cost-controller.1.0',
        'select * from inv.expired_wastage($1, $2::date, $2::date)',
        [store, today],
      );
      expect(lines).toEqual([
        expect.objectContaining({
          sku: 'MINT-CHUTNEY',
          batch_no: b[0]!.batch_no,
          made_qty: '500.000000',
          wasted_qty: '140.000',
          reported_by: 'Test Commis 1.0',
          discarded_by: 'Test Commis B 1.0',
          remade_qty: '500.000000',
        }),
      ]);
      // costs stay with cost viewers
      const commis = await attemptAs(
        c,
        ids.user('test.commis-b.1.0'),
        'select * from inv.expired_wastage($1, $2::date, $2::date)',
        [store, today],
      );
      expect(commis.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});
