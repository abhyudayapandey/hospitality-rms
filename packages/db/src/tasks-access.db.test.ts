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

// Tasks, checklists, maintenance and expired batches (Prompt 11b, ADR 020): who may create,
// see, complete and assign. Written before the feature. Domains (org tree):
//   TASKS                SELF modify (own tasks), SUPERVISOR and DEPARTMENT_HEAD modify
//                        (department), OUTLET_MANAGER modify (outlet), AREA_MANAGER and
//                        AI_AGENT view
//   CHECKLIST_TEMPLATES  DEPARTMENT_HEAD and OUTLET_MANAGER modify; SUPERVISOR, AREA_MANAGER
//                        and AI_AGENT view
//   MAINTENANCE          SELF modify (own requests), STAFF view (their department's queue),
//                        DEPARTMENT_HEAD and OUTLET_MANAGER modify, AREA_MANAGER and AI_AGENT
//                        view
// Staff see only their own tasks; tasks for a job role or "whoever is on shift" reach them
// through ops.my_tasks().

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const HOTEL = 'TEST-HOTEL-1.0';
const KITCHEN = 'TEST-HOTEL-1.0-KITCHEN';
const BAR = 'TEST-HOTEL-1.0-BAR';
const ENGINEERING = 'TEST-HOTEL-1.0-ENGINEERING';
const KITCHEN_STORE = 'TEST-HOTEL-1.0-KITCHEN-STORE';

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

type Assign =
  { mode: 'person'; user_id: string } | { mode: 'job_role'; role: string } | { mode: 'on_shift' };
const person = (username: string): Assign => ({ mode: 'person', user_id: ids.user(username) });

interface Step {
  label: string;
  kind: 'tick' | 'number' | 'text' | 'photo';
  min?: number;
  max?: number;
  unit?: string;
  photo_required?: boolean;
}

function createTask(
  c: PoolClient,
  who: string,
  node: string,
  assign: Assign,
  opts: { title?: string; due?: string; steps?: Step[]; key?: string } = {},
) {
  return attemptAs<{ id: string }>(
    c,
    ids.user(who),
    `select ops.create_task($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) as id`,
    [
      ids.node(node),
      opts.title ?? 'Deep clean the walk-in',
      'Shelves, floor and door seal',
      opts.due ?? inHours(4),
      'normal',
      JSON.stringify(assign),
      JSON.stringify(opts.steps ?? [{ label: 'Done', kind: 'tick' }]),
      opts.key ?? null,
    ],
  );
}

async function created(
  c: PoolClient,
  who: string,
  node: string,
  assign: Assign,
  opts: Parameters<typeof createTask>[4] = {},
): Promise<string> {
  const r = await createTask(c, who, node, assign, opts);
  expect(r.error, `${who} creates a task at ${node}`).toBeUndefined();
  return r.rows![0]!.id;
}

async function firstStep(c: PoolClient, task: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select id from ops.task_step where task_id = $1 order by position limit 1`,
    [task],
  );
  return rows[0]!.id;
}

const completeStep = (c: PoolClient, who: string, task: string, step: string, value: object) =>
  attemptAs<{ r: { flagged: boolean } }>(
    c,
    ids.user(who),
    'select ops.complete_step($1, $2, $3::jsonb) as r',
    [task, step, JSON.stringify(value)],
  );

const myTasks = async (c: PoolClient, who: string) =>
  (await attemptAs<{ id: string }>(c, ids.user(who), 'select id from ops.my_tasks()')).rows!.map(
    (r) => r.id,
  );

const seesRow = async (c: PoolClient, who: string, table: string, id: string) =>
  (
    await attemptAs<{ n: number }>(
      c,
      ids.user(who),
      `select count(*)::int as n from ${table} where id = $1`,
      [id],
    )
  ).rows![0]!.n === 1;

async function itemId(c: PoolClient, sku: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id
      where t.code = 'TEST-COMPANY' and i.sku = $1`,
    [sku],
  );
  return rows[0]!.id;
}

// The test data's expired batch (file 26): Mint Chutney made by the commis five days ago,
// 140 g left in the hotel kitchen store.
async function expiredBatch(c: PoolClient) {
  const { rows } = await c.query<{ batch_no: string }>(
    `select batch_no from inv.production where delivery_node_id = $1 and prep_item_id = $2
      order by made_at limit 1`,
    [ids.node(KITCHEN_STORE), await itemId(c, 'MINT-CHUTNEY')],
  );
  return {
    store: ids.node(KITCHEN_STORE),
    item: await itemId(c, 'MINT-CHUTNEY'),
    batch: rows[0]!.batch_no,
  };
}

const report = async (c: PoolClient, who: string) => {
  const b = await expiredBatch(c);
  return attemptAs<{ id: string }>(
    c,
    ids.user(who),
    'select ops.report_expired($1, $2, $3) as id',
    [b.store, b.item, b.batch],
  );
};

async function notified(c: PoolClient, username: string, kind: string): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `select count(*)::int as n from ops.notification
      where owner_user_id = $1 and kind = $2 and created_at >= now()`,
    [ids.user(username), kind],
  );
  return rows[0]!.n;
}

describe('creating tasks', () => {
  it('supervisors and department heads in their department, outlet managers outlet-wide', async () => {
    await inRolledBackTx(async (c) => {
      // the sous chef (supervisor) and executive chef (head) at the kitchen
      await created(c, 'test.sous-chef.1.0', KITCHEN, person('test.commis.1.0'));
      await created(c, 'test.executive-chef.1.0', KITCHEN, person('test.commis-b.1.0'));
      // the GM anywhere in the hotel, including the hotel itself
      await created(c, 'test.general-manager.1.0', BAR, person('test.bartender.1.0'));
      await created(c, 'test.general-manager.1.0', HOTEL, person('test.commis.1.0'));
      // the bar manager 3.0 runs a standalone bar as its outlet manager
      await created(c, 'test.bar-manager.3.0', 'TEST-BAR-3.0-KITCHEN', person('test.cook.3.0'));
    });
  });

  it('is refused outside the department, outside the outlet, to staff and to viewers', async () => {
    await inRolledBackTx(async (c) => {
      const refused: [string, string, Assign][] = [
        // a supervisor at another department
        ['test.sous-chef.1.0', BAR, person('test.bartender.1.0')],
        // a department head at the outlet itself
        ['test.executive-chef.1.0', HOTEL, person('test.commis.1.0')],
        // staff, even for themselves
        ['test.commis.1.0', KITCHEN, person('test.commis.1.0')],
        // the GM of another outlet
        ['test.general-manager.1.0', 'TEST-BAR-3.0-KITCHEN', person('test.cook.3.0')],
        // view-only: the area manager and the AI agent
        ['test.area-manager', KITCHEN, person('test.commis.1.0')],
        ['ai-agent', KITCHEN, person('test.commis.1.0')],
        // HR, cost control and the account owner hold no TASKS
        ['test.hr-admin', KITCHEN, person('test.commis.1.0')],
        ['test.cost-controller.1.0', KITCHEN, person('test.commis.1.0')],
        ['test.account-owner', KITCHEN, person('test.commis.1.0')],
        // another customer
        ['test.solo.bar-manager', KITCHEN, person('test.commis.1.0')],
      ];
      for (const [who, node, assign] of refused) {
        const r = await createTask(c, who, node, assign);
        expect(r.error, `${who} at ${node}`).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it('assigns only to someone who works at the place', async () => {
    await inRolledBackTx(async (c) => {
      // the bartender's home is the bar, not the kitchen
      const r = await createTask(
        c,
        'test.executive-chef.1.0',
        KITCHEN,
        person('test.bartender.1.0'),
      );
      expect(r.error).toMatch(/INVALID_ASSIGNEE/);
      // a job role nobody at the kitchen holds
      const role = await createTask(c, 'test.executive-chef.1.0', KITCHEN, {
        mode: 'job_role',
        role: 'TECHNICIAN',
      });
      expect(role.error).toMatch(/INVALID_ASSIGNEE/);
      // another customer's user
      const other = await createTask(
        c,
        'test.executive-chef.1.0',
        KITCHEN,
        person('test.solo.bartender'),
      );
      expect(other.error).toMatch(/INVALID_ASSIGNEE/);
    });
  });

  it('cannot be written to directly', async () => {
    await inRolledBackTx(async (c) => {
      const t = await created(c, 'test.executive-chef.1.0', KITCHEN, person('test.commis.1.0'));
      for (const sql of [
        `update ops.task set status = 'done' where id = $1`,
        `update ops.task_step set done_at = now() where task_id = $1`,
        `delete from ops.task where id = $1`,
      ]) {
        const r = await attemptAs(c, ids.user('test.executive-chef.1.0'), sql, [t]);
        expect(r.error, sql).toMatch(/permission denied/);
      }
    });
  });
});

describe('staff see and complete only their own tasks', () => {
  it('a task for one person reaches that person only', async () => {
    await inRolledBackTx(async (c) => {
      const t = await created(c, 'test.sous-chef.1.0', KITCHEN, person('test.commis.1.0'));
      expect(await myTasks(c, 'test.commis.1.0')).toContain(t);
      expect(await seesRow(c, 'test.commis.1.0', 'ops.task', t)).toBe(true);
      // a colleague at the same kitchen sees nothing of it
      expect(await myTasks(c, 'test.commis-b.1.0')).not.toContain(t);
      expect(await seesRow(c, 'test.commis-b.1.0', 'ops.task', t)).toBe(false);
      const detail = await attemptAs(
        c,
        ids.user('test.commis-b.1.0'),
        'select ops.task_detail($1)',
        [t],
      );
      expect(detail.error).toMatch(/NOT_AUTHORISED/);
      const step = await firstStep(c, t);
      const done = await completeStep(c, 'test.commis-b.1.0', t, step, { done: true });
      expect(done.error).toMatch(/NOT_AUTHORISED/);
      // the person themselves completes it
      expect((await completeStep(c, 'test.commis.1.0', t, step, { done: true })).error).toBe(
        undefined,
      );
      const fin = await attemptAs(c, ids.user('test.commis.1.0'), 'select ops.complete_task($1)', [
        t,
      ]);
      expect(fin.error).toBeUndefined();
    });
  });

  it('a task for a job role reaches everyone in that role there; the first to start takes it', async () => {
    await inRolledBackTx(async (c) => {
      const t = await created(c, 'test.executive-chef.1.0', KITCHEN, {
        mode: 'job_role',
        role: 'COMMIS',
      });
      expect(await myTasks(c, 'test.commis.1.0')).toContain(t);
      expect(await myTasks(c, 'test.commis-b.1.0')).toContain(t);
      // other roles at the kitchen, and commis elsewhere, do not get it
      expect(await myTasks(c, 'test.chef-de-partie.1.0')).not.toContain(t);
      expect(await myTasks(c, 'test.commis.3.0')).not.toContain(t);
      const step = await firstStep(c, t);
      expect((await completeStep(c, 'test.commis-b.1.0', t, step, { done: true })).error).toBe(
        undefined,
      );
      // taken: it is commis B's now
      expect(await myTasks(c, 'test.commis.1.0')).not.toContain(t);
      const late = await attemptAs(c, ids.user('test.commis.1.0'), 'select ops.complete_task($1)', [
        t,
      ]);
      expect(late.error).toMatch(/TASK_TAKEN/);
    });
  });

  it('a task for whoever is on shift reaches the people rostered at the due time', async () => {
    await inRolledBackTx(async (c) => {
      const node = ids.node('TEST-BAR-3.0-FLOOR-SERVICE');
      const tenant = ids.tenant();
      // a published shift tomorrow 10:00–18:00 for Server 3.0 only
      const { rows } = await c.query<{ id: string; start_at: string }>(
        `insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code,
                               status, published_at)
         values ($1, $2, current_date + 1, (current_date + 1) + time '04:30',
                 (current_date + 1) + time '12:30', 'SERVER', 'published', now())
         returning id, start_at`,
        [tenant, node],
      );
      const shift = rows[0]!;
      await c.query(
        `insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id,
                                          org_node_id, start_at, end_at)
         select $1, $2, w.id, w.owner_user_id, $3, s.start_at, s.end_at
           from hr.worker w, hr.shift s where w.owner_user_id = $4 and s.id = $2`,
        [tenant, shift.id, node, ids.user('test.server.3.0')],
      );
      const due = new Date(new Date(shift.start_at).getTime() + 2 * 3_600_000).toISOString();
      const t = await created(
        c,
        'test.floor-manager.3.0',
        'TEST-BAR-3.0-FLOOR-SERVICE',
        {
          mode: 'on_shift',
        },
        { due },
      );
      expect(await myTasks(c, 'test.server.3.0')).toContain(t);
      // not on shift then
      expect(await myTasks(c, 'test.server-b.3.0')).not.toContain(t);
      const step = await firstStep(c, t);
      const r = await completeStep(c, 'test.server-b.3.0', t, step, { done: true });
      expect(r.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});

describe('team tasks', () => {
  it('supervisors read their department, managers the outlet, the area manager views', async () => {
    await inRolledBackTx(async (c) => {
      const k = await created(c, 'test.executive-chef.1.0', KITCHEN, person('test.commis.1.0'));
      const b = await created(c, 'test.bar-manager.1.0', BAR, person('test.bartender.1.0'));
      const team = async (who: string, node: string) =>
        attemptAs<{ id: string }>(
          c,
          ids.user(who),
          `select id from ops.team_tasks($1, current_date - 1, current_date + 7)`,
          [ids.node(node)],
        );
      const sous = await team('test.sous-chef.1.0', KITCHEN);
      expect(sous.rows!.map((r) => r.id)).toContain(k);
      expect((await team('test.sous-chef.1.0', BAR)).error).toMatch(/NOT_AUTHORISED/);
      const gm = (await team('test.general-manager.1.0', HOTEL)).rows!.map((r) => r.id);
      expect(gm).toEqual(expect.arrayContaining([k, b]));
      const area = (await team('test.area-manager', HOTEL)).rows!.map((r) => r.id);
      expect(area).toEqual(expect.arrayContaining([k, b]));
      for (const who of ['test.commis.1.0', 'test.cost-controller.1.0', 'test.solo.bar-manager']) {
        expect((await team(who, KITCHEN)).error, who).toMatch(/NOT_AUTHORISED/);
      }
      // the table follows the same rules
      expect(await seesRow(c, 'test.sous-chef.1.0', 'ops.task', k)).toBe(true);
      expect(await seesRow(c, 'test.sous-chef.1.0', 'ops.task', b)).toBe(false);
      expect(await seesRow(c, 'test.solo.bar-manager', 'ops.task', k)).toBe(false);
    });
  });

  it('only task managers there cancel a task', async () => {
    await inRolledBackTx(async (c) => {
      const t = await created(c, 'test.sous-chef.1.0', KITCHEN, person('test.commis.1.0'));
      const cancel = (who: string) =>
        attemptAs(c, ids.user(who), `select ops.cancel_task($1, 'not needed')`, [t]);
      for (const who of ['test.commis.1.0', 'test.head-bartender.1.0', 'test.area-manager']) {
        expect((await cancel(who)).error, who).toMatch(/NOT_AUTHORISED/);
      }
      expect((await cancel('test.executive-chef.1.0')).error).toBeUndefined();
    });
  });
});

describe('checklist templates', () => {
  const save = (c: PoolClient, who: string, node: string) =>
    attemptAs<{ id: string }>(
      c,
      ids.user(who),
      `select ops.save_template(null, $1, 'Kitchen closing', $2::jsonb, $3::jsonb, $4::jsonb) as id`,
      [
        ids.node(node),
        JSON.stringify({ kind: 'daily', times: ['22:30'] }),
        JSON.stringify({ mode: 'on_shift' }),
        JSON.stringify([
          { label: 'Gas off', kind: 'tick' },
          { label: 'Walk-in temperature', kind: 'number', min: 0, max: 5, unit: '°C' },
        ]),
      ],
    );

  it('are edited by department heads (their department) and outlet managers', async () => {
    await inRolledBackTx(async (c) => {
      expect((await save(c, 'test.executive-chef.1.0', KITCHEN)).error).toBeUndefined();
      expect((await save(c, 'test.general-manager.1.0', BAR)).error).toBeUndefined();
      const refused: [string, string][] = [
        ['test.executive-chef.1.0', BAR],
        ['test.sous-chef.1.0', KITCHEN],
        ['test.commis.1.0', KITCHEN],
        ['test.area-manager', KITCHEN],
        ['ai-agent', KITCHEN],
        ['test.solo.bar-manager', KITCHEN],
      ];
      for (const [who, node] of refused) {
        expect((await save(c, who, node)).error, `${who} at ${node}`).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it('are read by supervisors, but not by staff', async () => {
    await inRolledBackTx(async (c) => {
      const id = (await save(c, 'test.executive-chef.1.0', KITCHEN)).rows![0]!.id;
      expect(await seesRow(c, 'test.sous-chef.1.0', 'ops.checklist_template', id)).toBe(true);
      expect(await seesRow(c, 'test.area-manager', 'ops.checklist_template', id)).toBe(true);
      expect(await seesRow(c, 'test.commis.1.0', 'ops.checklist_template', id)).toBe(false);
      expect(await seesRow(c, 'test.head-bartender.1.0', 'ops.checklist_template', id)).toBe(false);
      const archive = await attemptAs(
        c,
        ids.user('test.sous-chef.1.0'),
        'select ops.archive_template($1)',
        [id],
      );
      expect(archive.error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('instances are created only by the executor', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        'select * from ops.tasks_tick()',
      );
      expect(r.error).toMatch(/permission denied/);
      await actAs(c, 'wf_executor', null);
      await c.query('select * from ops.tasks_tick()');
      await resetRole(c);
    });
  });
});

describe('maintenance', () => {
  const raise = (c: PoolClient, who: string, place: string, photo: string | null = null) =>
    attemptAs<{ id: string }>(
      c,
      ids.user(who),
      `select ops.raise_maintenance($1, 'Fridge 2 not cooling', 'Reads 9 °C', $2) as id`,
      [ids.node(place), photo],
    );
  const handlingNode = async (c: PoolClient, id: string) =>
    (
      await c.query<{ code: string }>(
        `select n.code from ops.maintenance_request r
           join core.hierarchy_node n on n.id = r.org_node_id where r.id = $1`,
        [id],
      )
    ).rows[0]!.code;

  it('anyone raises one where they work; it goes to Engineering, or up the tree', async () => {
    await inRolledBackTx(async (c) => {
      const r = await raise(c, 'test.commis.1.0', KITCHEN);
      expect(r.error).toBeUndefined();
      expect(await handlingNode(c, r.rows![0]!.id)).toBe(ENGINEERING);
      expect(await notified(c, 'test.chief-engineer.1.0', 'maintenance_raised')).toBe(1);
      // Bar 3.0 has no Engineering department: its outlet manager handles it
      const bar = await raise(c, 'test.server.3.0', 'TEST-BAR-3.0-FLOOR-SERVICE');
      expect(bar.error).toBeUndefined();
      expect(await handlingNode(c, bar.rows![0]!.id)).toBe('TEST-BAR-3.0');
      expect(await notified(c, 'test.bar-manager.3.0', 'maintenance_raised')).toBe(1);
      // not at another outlet, or another customer
      expect((await raise(c, 'test.commis.1.0', 'TEST-BAR-3.0-KITCHEN')).error).toMatch(
        /NOT_AUTHORISED/,
      );
      expect((await raise(c, 'test.solo.bartender', KITCHEN)).error).toMatch(/NOT_AUTHORISED/);
    });
  });

  it('the reporter and Engineering see a request; other staff do not', async () => {
    await inRolledBackTx(async (c) => {
      const id = (await raise(c, 'test.commis.1.0', KITCHEN)).rows![0]!.id;
      const t = 'ops.maintenance_request';
      expect(await seesRow(c, 'test.commis.1.0', t, id)).toBe(true);
      expect(await seesRow(c, 'test.chief-engineer.1.0', t, id)).toBe(true);
      expect(await seesRow(c, 'test.technician.1.0', t, id)).toBe(true);
      expect(await seesRow(c, 'test.general-manager.1.0', t, id)).toBe(true);
      expect(await seesRow(c, 'test.area-manager', t, id)).toBe(true);
      for (const who of ['test.commis-b.1.0', 'test.executive-chef.1.0', 'test.bar-manager.3.0']) {
        expect(await seesRow(c, who, t, id), who).toBe(false);
      }
    });
  });

  it('Engineering assigns a technician, who alone starts and closes it with a photo', async () => {
    await inRolledBackTx(async (c) => {
      const id = (await raise(c, 'test.commis.1.0', KITCHEN)).rows![0]!.id;
      const assign = (who: string, to: string) =>
        attemptAs(c, ids.user(who), 'select ops.assign_maintenance($1, $2)', [id, ids.user(to)]);
      for (const who of [
        'test.commis.1.0',
        'test.technician.1.0',
        'test.executive-chef.1.0',
        'test.area-manager',
      ]) {
        expect((await assign(who, 'test.technician.1.0')).error, who).toMatch(/NOT_AUTHORISED/);
      }
      // only to someone in Engineering
      expect((await assign('test.chief-engineer.1.0', 'test.commis-b.1.0')).error).toMatch(
        /INVALID_ASSIGNEE/,
      );
      expect(
        (await assign('test.chief-engineer.1.0', 'test.technician.1.0')).error,
      ).toBeUndefined();
      expect(await notified(c, 'test.technician.1.0', 'maintenance_assigned')).toBe(1);

      const start = (who: string) =>
        attemptAs(c, ids.user(who), 'select ops.start_maintenance($1)', [id]);
      expect((await start('test.chief-engineer.1.0')).error).toMatch(/NOT_AUTHORISED/);
      expect((await start('test.technician.1.0')).error).toBeUndefined();

      const close = (who: string, photo: string | null) =>
        attemptAs(c, ids.user(who), `select ops.close_maintenance($1, $2, 'Replaced the fan')`, [
          id,
          photo,
        ]);
      const photo = `tasks/keep/${ids.tenant()}/${ids.node(ENGINEERING)}/0190a8a2-0000-7000-8000-000000000001.jpg`;
      expect((await close('test.technician.1.0', null)).error).toMatch(/PHOTO_REQUIRED/);
      // a photo key outside this request's place
      const elsewhere = `tasks/keep/${ids.tenant()}/${ids.node(BAR)}/0190a8a2-0000-7000-8000-000000000001.jpg`;
      expect((await close('test.technician.1.0', elsewhere)).error).toMatch(/INVALID_PHOTO/);
      expect((await close('test.commis.1.0', photo)).error).toMatch(/NOT_AUTHORISED/);
      expect((await close('test.technician.1.0', photo)).error).toBeUndefined();
      expect(await notified(c, 'test.commis.1.0', 'maintenance_done')).toBe(1);
    });
  });
});

describe('expired batches', () => {
  it('anyone who sees the batch reports it once; the lead is told', async () => {
    await inRolledBackTx(async (c) => {
      const first = await report(c, 'test.commis.1.0');
      expect(first.error).toBeUndefined();
      // the same batch again keeps the first report
      const again = await report(c, 'test.chef-de-partie.1.0');
      expect(again.rows![0]!.id).toBe(first.rows![0]!.id);
      // the executive chef heads the kitchen linked to the store
      expect(await notified(c, 'test.executive-chef.1.0', 'expiry_reported')).toBe(1);
      // people who cannot see the store's batches
      for (const who of ['test.bartender.1.0', 'test.server.3.0', 'test.solo.bar-manager']) {
        expect((await report(c, who)).error, who).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it('only a batch past its expiry with something left can be reported', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ batch_no: string }>(
        `select batch_no from inv.production where delivery_node_id = $1 and prep_item_id = $2`,
        [ids.node(KITCHEN_STORE), await itemId(c, 'GINGER-GARLIC-PASTE')],
      );
      const r = await attemptAs(
        c,
        ids.user('test.commis.1.0'),
        'select ops.report_expired($1, $2, $3)',
        [ids.node(KITCHEN_STORE), await itemId(c, 'GINGER-GARLIC-PASTE'), rows[0]!.batch_no],
      );
      expect(r.error).toMatch(/NOT_EXPIRED/);
    });
  });

  it('the lead assigns discard and remake to someone in the department', async () => {
    await inRolledBackTx(async (c) => {
      const task = (await report(c, 'test.commis.1.0')).rows![0]!.id;
      const assign = (who: string, to: string) =>
        attemptAs(c, ids.user(who), 'select ops.assign_expiry($1, $2, $3, true)', [
          task,
          ids.user(to),
          inHours(2),
        ]);
      for (const who of ['test.commis.1.0', 'test.bar-manager.1.0', 'test.area-manager']) {
        expect((await assign(who, 'test.commis-b.1.0')).error, who).toMatch(/NOT_AUTHORISED/);
      }
      expect((await assign('test.executive-chef.1.0', 'test.bartender.1.0')).error).toMatch(
        /INVALID_ASSIGNEE/,
      );
      expect((await assign('test.executive-chef.1.0', 'test.commis-b.1.0')).error).toBeUndefined();
      expect(await myTasks(c, 'test.commis-b.1.0')).toContain(task);
      expect(await notified(c, 'test.commis-b.1.0', 'task_assigned')).toBe(1);
    });
  });

  it('only the assignee discards it, as expired wastage linked to the report', async () => {
    await inRolledBackTx(async (c) => {
      const task = (await report(c, 'test.commis.1.0')).rows![0]!.id;
      await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        'select ops.assign_expiry($1, $2, $3, true)',
        [task, ids.user('test.commis-b.1.0'), inHours(2)],
      );
      const discard = (who: string, qty = 140) =>
        attemptAs<{ id: string }>(c, ids.user(who), 'select ops.discard_expired($1, $2) as id', [
          task,
          qty,
        ]);
      for (const who of ['test.commis.1.0', 'test.executive-chef.1.0']) {
        expect((await discard(who)).error, who).toMatch(/NOT_AUTHORISED/);
      }
      // another customer does not learn the task exists
      expect((await discard('test.solo.bar-manager')).error).toMatch(/NOT_FOUND/);
      // never more than is left of the batch
      expect((await discard('test.commis-b.1.0', 500)).error).toMatch(/INVALID_QUANTITY/);
      const ok = await discard('test.commis-b.1.0');
      expect(ok.error).toBeUndefined();
      const { rows } = await c.query<{ reason: string; task_id: string; outcome: string }>(
        `select reason, task_id, outcome from inv.wastage_line where wastage_id = $1`,
        [ok.rows![0]!.id],
      );
      expect(rows).toEqual([{ reason: 'expired', task_id: task, outcome: 'posted' }]);
      // the wastage line is read with stock access, as before
      const line = await attemptAs<{ n: number }>(
        c,
        ids.user('test.commis-b.1.0'),
        'select count(*)::int as n from inv.wastage_line where wastage_id = $1',
        [ok.rows![0]!.id],
      );
      expect(line.rows![0]!.n).toBe(0);
    });
  });

  it('a discard worth more than the limit still needs a photo and the outlet manager', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `insert into inv.node_setting (tenant_id, delivery_node_id, wastage_approval_value)
         values ($1, $2, 1)
         on conflict (tenant_id, delivery_node_id) do update set wastage_approval_value = 1`,
        [ids.tenant(), ids.node(KITCHEN_STORE)],
      );
      const task = (await report(c, 'test.commis.1.0')).rows![0]!.id;
      await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        'select ops.assign_expiry($1, $2, $3, false)',
        [task, ids.user('test.commis-b.1.0'), inHours(2)],
      );
      const noPhoto = await attemptAs(
        c,
        ids.user('test.commis-b.1.0'),
        'select ops.discard_expired($1, 140)',
        [task],
      );
      expect(noPhoto.error).toMatch(/PHOTO_REQUIRED/);
      const photo = `wastage/${ids.tenant()}/${ids.node(KITCHEN_STORE)}/0190a8a2-0000-7000-8000-000000000002.jpg`;
      const r = await attemptAs<{ id: string }>(
        c,
        ids.user('test.commis-b.1.0'),
        'select ops.discard_expired($1, 140, $2) as id',
        [task, photo],
      );
      expect(r.error).toBeUndefined();
      const { rows } = await c.query<{ outcome: string; process_type: string; initiator: string }>(
        `select l.outcome, q.process_type, q.initiator_id as initiator
           from inv.wastage_line l join inv.wastage w on w.id = l.wastage_id
           join inv.stock_adjustment a on a.id = w.adjustment_id
           join wf.request q on q.id = a.wf_request_id
          where l.wastage_id = $1`,
        [r.rows![0]!.id],
      );
      // the request is from the lead who decided the batch goes (a commis cannot raise
      // stock adjustments), so the outlet manager approves it as for any wastage
      expect(rows).toEqual([
        {
          outcome: 'approval',
          process_type: 'STOCK_ADJUSTMENT',
          initiator: ids.user('test.executive-chef.1.0'),
        },
      ]);
    });
  });

  it('the remake is recorded by the assignee through production, linked to the task', async () => {
    await inRolledBackTx(async (c) => {
      const task = (await report(c, 'test.commis.1.0')).rows![0]!.id;
      await attemptAs(
        c,
        ids.user('test.executive-chef.1.0'),
        'select ops.assign_expiry($1, $2, $3, true)',
        [task, ids.user('test.commis-b.1.0'), inHours(2)],
      );
      const batch = (who: string) =>
        attemptAs<{ id: string }>(c, ids.user(who), 'select ops.record_task_batch($1, 500) as id', [
          task,
        ]);
      expect((await batch('test.commis.1.0')).error).toMatch(/NOT_AUTHORISED/);
      const r = await batch('test.commis-b.1.0');
      expect(r.error).toBeUndefined();
      const { rows } = await c.query<{ task_id: string }>(
        `select task_id from inv.production where id = $1`,
        [r.rows![0]!.id],
      );
      expect(rows[0]!.task_id).toBe(task);
    });
  });
});

describe('prep lists', () => {
  it('suggestions are read where the person records production or sees stock', async () => {
    await inRolledBackTx(async (c) => {
      const read = (who: string) =>
        attemptAs(c, ids.user(who), 'select * from inv.prep_suggestions($1)', [
          ids.node(KITCHEN_STORE),
        ]);
      for (const who of [
        'test.commis.1.0',
        'test.executive-chef.1.0',
        'test.general-manager.1.0',
      ]) {
        expect((await read(who)).error, who).toBeUndefined();
      }
      for (const who of ['test.bartender.1.0', 'test.server.3.0', 'test.solo.bar-manager']) {
        expect((await read(who)).error, who).toMatch(/NOT_AUTHORISED/);
      }
    });
  });

  it('prep tasks are created by task managers of the linked department', async () => {
    await inRolledBackTx(async (c) => {
      const create = (who: string) =>
        attemptAs<{ ids: string[] }>(
          c,
          ids.user(who),
          `select ops.create_prep_tasks($1, $2::jsonb, $3, $4::jsonb) as ids`,
          [
            ids.node(KITCHEN_STORE),
            JSON.stringify([{ item_id: null, qty: 1000 }]),
            inHours(3),
            JSON.stringify({ mode: 'job_role', role: 'COMMIS' }),
          ],
        );
      // fill in the item
      const item = await itemId(c, 'MINT-CHUTNEY');
      const withItem = (who: string) =>
        attemptAs<{ ids: string[] }>(
          c,
          ids.user(who),
          `select ops.create_prep_tasks($1, $2::jsonb, $3, $4::jsonb) as ids`,
          [
            ids.node(KITCHEN_STORE),
            JSON.stringify([{ item_id: item, qty: 1000 }]),
            inHours(3),
            JSON.stringify({ mode: 'job_role', role: 'COMMIS' }),
          ],
        );
      expect((await create('test.sous-chef.1.0')).error).toMatch(/INVALID_LINES/);
      for (const who of ['test.commis.1.0', 'test.head-bartender.1.0', 'test.store-keeper.1.0']) {
        expect((await withItem(who)).error, who).toMatch(/NOT_AUTHORISED/);
      }
      const ok = await withItem('test.sous-chef.1.0');
      expect(ok.error).toBeUndefined();
      const task = ok.rows![0]!.ids[0]!;
      // a commis completes it by recording the batch; a bartender cannot
      expect(
        (
          await attemptAs(
            c,
            ids.user('test.bartender.1.0'),
            'select ops.record_task_batch($1, 400)',
            [task],
          )
        ).error,
      ).toMatch(/NOT_AUTHORISED/);
      expect(
        (
          await attemptAs(c, ids.user('test.commis.1.0'), 'select ops.record_task_batch($1, 400)', [
            task,
          ])
        ).error,
      ).toBeUndefined();
    });
  });
});

describe('test data', () => {
  it('only the loader links past batches to prep tasks, and only for test customers', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        'select ops.link_test_batch(core.uuid_v7(), core.uuid_v7())',
      );
      expect(r.error).toMatch(/permission denied/);
      // a customer that is not a test customer
      const { rows } = await c.query<{ task: string; batch: string }>(
        `select t.id as task, p.id as batch from ops.task t
           join inv.production p on p.task_id = t.id where t.kind = 'prep' limit 1`,
      );
      // (is_test never changes in the app; the fixture lifts that guard inside the rollback)
      await c.query('alter table core.tenant disable trigger is_test_fixed');
      await c.query(`update core.tenant set is_test = false where id = $1`, [ids.tenant()]);
      await c.query('savepoint s');
      await expect(
        c.query('select ops.link_test_batch($1, $2)', [rows[0]!.task, rows[0]!.batch]),
      ).rejects.toThrow(/NOT_AUTHORISED/);
      await c.query('rollback to savepoint s');
    });
  });
});

describe('the lead’s list of things to assign', () => {
  it('shows reported batches and open requests to whoever may assign them', async () => {
    await inRolledBackTx(async (c) => {
      const task = (await report(c, 'test.commis.1.0')).rows![0]!.id;
      const req = (
        await attemptAs<{ id: string }>(
          c,
          ids.user('test.commis.1.0'),
          `select ops.raise_maintenance($1, 'Tap leaking', null, null) as id`,
          [ids.node(KITCHEN)],
        )
      ).rows![0]!.id;
      const list = async (who: string) =>
        (
          await attemptAs<{ id: string }>(c, ids.user(who), 'select id from ops.my_to_assign()')
        ).rows!.map((r) => r.id);
      expect(await list('test.executive-chef.1.0')).toContain(task);
      expect(await list('test.executive-chef.1.0')).not.toContain(req);
      expect(await list('test.chief-engineer.1.0')).toContain(req);
      expect(await list('test.general-manager.1.0')).toEqual(expect.arrayContaining([task, req]));
      expect(await list('test.commis.1.0')).toEqual([]);
      expect(await list('test.area-manager')).toEqual([]);
    });
  });
});

describe('photo uploads', () => {
  const may = async (c: PoolClient, who: string, purpose: string, node: string) =>
    (
      await attemptAs<{ ok: boolean }>(
        c,
        ids.user(who),
        'select ops.can_upload_photo($1, $2) as ok',
        [purpose, ids.node(node)],
      )
    ).rows![0]!.ok;

  it('are presigned only for a task, request or discard the person works on there', async () => {
    await inRolledBackTx(async (c) => {
      await created(c, 'test.executive-chef.1.0', KITCHEN, person('test.commis.1.0'));
      expect(await may(c, 'test.commis.1.0', 'task', KITCHEN)).toBe(true);
      expect(await may(c, 'test.bartender.1.0', 'task', KITCHEN)).toBe(false);
      expect(await may(c, 'test.commis.1.0', 'task', BAR)).toBe(false);
      // maintenance: where they work, or a request assigned to them at Engineering
      expect(await may(c, 'test.commis.1.0', 'maintenance', KITCHEN)).toBe(true);
      expect(await may(c, 'test.commis.1.0', 'maintenance', 'TEST-BAR-3.0-KITCHEN')).toBe(false);
      expect(await may(c, 'test.solo.bartender', 'maintenance', KITCHEN)).toBe(false);
      // discard: only the assignee of an expiry task at that store
      const task = (await report(c, 'test.commis.1.0')).rows![0]!.id;
      expect(await may(c, 'test.commis-b.1.0', 'discard', KITCHEN_STORE)).toBe(false);
      expect(
        (
          await attemptAs(
            c,
            ids.user('test.executive-chef.1.0'),
            'select ops.assign_expiry($1, $2, $3, false)',
            [task, ids.user('test.commis-b.1.0'), inHours(2)],
          )
        ).error,
      ).toBeUndefined();
      expect(await may(c, 'test.commis-b.1.0', 'discard', KITCHEN_STORE)).toBe(true);
      expect(await may(c, 'test.commis.1.0', 'discard', KITCHEN_STORE)).toBe(false);
      expect(await may(c, 'test.commis.1.0', 'selfie', KITCHEN)).toBe(false);
    });
  });
});
