import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Handing a task on (ADR 074). Test Hotel 1.0 is the Passport Hotel case: its pest control
// sits at the hotel itself, the General Manager answers for it and the Executive
// Housekeeper does it. She gives the reminder to her supervisor, who gives it to a room
// attendant. At every step: whoever has it works on it and sees when it reached them;
// the head of the department where they work, the GM, whoever handed it on and the role
// that answers for it still see it (and may give it to someone else); a cook and someone
// at another outlet do not. Every way a task is assigned records the handover and its day.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

const HOTEL = 'TEST-HOTEL-1.0';
const HK = 'TEST-HOTEL-1.0-HOUSEKEEPING';
const GM = 'test.general-manager.1.0';
const EH = 'test.executive-housekeeper.1.0'; // heads housekeeping, does the pest control
const HS = 'test.housekeeping-supervisor.1.0';
const RA = 'test.room-attendant.1.0';
const RA_B = 'test.room-attendant-b.1.0';
const COMMIS = 'test.commis.1.0'; // works at the hotel, nothing to do with it
const FOM = 'test.front-office-manager.1.0'; // another department's head at the hotel
const OUTSIDER = 'test.bar-manager.3.0'; // another outlet

async function ok<T extends object>(
  c: pg.PoolClient,
  who: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await attemptAs<T>(c, ids.user(who), text, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows;
}
const error = async (c: pg.PoolClient, who: string, text: string, params: unknown[] = []) =>
  (await attemptAs(c, ids.user(who), text, params)).error;

/** The open pest control reminder at Hotel 1.0 (the seed's tick put it on the job role). */
async function pestTask(c: pg.PoolClient): Promise<string> {
  const r = await c.query<{ id: string; job_role_code: string }>(
    `select t.id, t.job_role_code from ops.task t
       join ops.compliance_item i on i.id = t.compliance_item_id
      where i.name = 'Pest control service' and i.org_node_id = $1
        and t.status in ('open', 'in_progress')`,
    [ids.node(HOTEL)],
  );
  expect(r.rows).toHaveLength(1);
  // the Executive Housekeeper does it (file 39's doer_role)
  expect(r.rows[0]!.job_role_code).toBe('EXECUTIVE_HOUSEKEEPER');
  return r.rows[0]!.id;
}

const give = (c: pg.PoolClient, who: string, task: string, to: string) =>
  error(c, who, `select ops.reassign_task($1, $2)`, [task, ids.user(to)]);

const opens = async (c: pg.PoolClient, who: string, task: string) =>
  (await error(c, who, `select ops.task_detail($1)`, [task])) === undefined;

type Detail = {
  assignee_name: string | null;
  assigned_at: string | null;
  can_hand_on: boolean;
  handovers: { from_name: string | null; to_name: string; by_name: string | null; took: boolean }[];
};
const detail = async (c: pg.PoolClient, who: string, task: string) =>
  (await ok<{ t: Detail }>(c, who, `select ops.task_detail($1) as t`, [task]))[0]!.t;

const handedOn = async (c: pg.PoolClient, who: string) =>
  ok<{ id: string; assignee_name: string; assigned_at: Date }>(
    c,
    who,
    `select id, assignee_name, assigned_at from ops.my_handed_on()`,
  );

const notes = async (c: pg.PoolClient, who: string, kind: string, like: string) =>
  (
    await c.query<{ title: string; body: string | null }>(
      `select title, body from ops.notification
        where owner_user_id = $1 and kind = $2 and title like $3 order by created_at`,
      [ids.user(who), kind, `%${like}%`],
    )
  ).rows;

describe('the Passport case: a compliance job at the hotel, done by a department head', () => {
  it('she gives it to her supervisor: no error, and she still sees it with who has it and since when', async () => {
    await inRolledBackTx(async (c) => {
      const task = await pestTask(c);
      expect(await give(c, EH, task, HS)).toBeUndefined();
      // the page she is on after giving it reloads without an error
      const d = await detail(c, EH, task);
      expect(d.assignee_name).toBe('Test Housekeeping Supervisor 1.0');
      expect(d.can_hand_on).toBe(true);
      expect(d.handovers.at(-1)).toMatchObject({
        from_name: null,
        to_name: 'Test Housekeeping Supervisor 1.0',
        by_name: 'Test Executive Housekeeper 1.0',
        took: false,
      });
      // "Given to others" on her To do list
      const mine = await handedOn(c, EH);
      expect(mine.map((t) => [t.id, t.assignee_name])).toEqual([
        [task, 'Test Housekeeping Supervisor 1.0'],
      ]);
      // the supervisor has it, with the day it reached her (long after it was due)
      const hs = await ok<{
        id: string;
        assigned_at: Date;
        assigned_by_name: string;
        due_at: Date;
      }>(
        c,
        HS,
        `select id, assigned_at, assigned_by_name, due_at from ops.my_tasks() where id = $1`,
        [task],
      );
      expect(hs).toHaveLength(1);
      expect(hs[0]!.assigned_by_name).toBe('Test Executive Housekeeper 1.0');
      expect(hs[0]!.assigned_at.getTime()).toBeGreaterThan(hs[0]!.due_at.getTime());
      expect(Date.now() - hs[0]!.assigned_at.getTime()).toBeLessThan(60_000);
      expect(await notes(c, HS, 'task_assigned', 'Pest control')).toEqual([
        { title: 'New task: Pest control service', body: 'From Test Executive Housekeeper 1.0' },
      ]);
    });
  });

  it('the GM, who answers for it, sees who has it in every list', async () => {
    await inRolledBackTx(async (c) => {
      const task = await pestTask(c);
      await give(c, EH, task, HS);
      expect((await detail(c, GM, task)).assignee_name).toBe('Test Housekeeping Supervisor 1.0');
      const job = await ok<{ with_name: string; with_since: Date | null }>(
        c,
        GM,
        `select with_name, with_since from ops.compliance_items(null) where open_task = $1`,
        [task],
      );
      expect(job[0]!.with_name).toBe('Test Housekeeping Supervisor 1.0');
      expect(job[0]!.with_since).not.toBeNull();
      const team = await ok<{ assignee_name: string; assigned_at: Date }>(
        c,
        GM,
        `select assignee_name, assigned_at from ops.team_tasks($1, '2026-01-01', current_date + 1)
          where id = $2`,
        [ids.node(HOTEL), task],
      );
      expect(team).toHaveLength(1);
      expect(team[0]!.assignee_name).toBe('Test Housekeeping Supervisor 1.0');
      // her department's team list shows it too, though the task sits at the hotel
      const hk = await ok<{ id: string }>(
        c,
        EH,
        `select id from ops.team_tasks($1, '2026-01-01', current_date + 1) where id = $2`,
        [ids.node(HK), task],
      );
      expect(hk).toHaveLength(1);
    });
  });

  it('a chain: the supervisor passes it on; everyone before still sees it; nobody else does', async () => {
    await inRolledBackTx(async (c) => {
      const task = await pestTask(c);
      await give(c, EH, task, HS);
      expect(await give(c, HS, task, RA)).toBeUndefined();
      for (const who of [GM, EH, HS, RA]) expect(await opens(c, who, task), who).toBe(true);
      for (const who of [COMMIS, FOM, OUTSIDER]) expect(await opens(c, who, task), who).toBe(false);
      expect((await handedOn(c, HS)).map((t) => t.assignee_name)).toEqual([
        'Test Room Attendant 1.0',
      ]);
      expect((await handedOn(c, EH)).map((t) => t.assignee_name)).toEqual([
        'Test Room Attendant 1.0',
      ]);
      // the supervisor is told it moved on only if someone else moved it: she did it herself
      expect(await notes(c, HS, 'task_reassigned', 'Pest control')).toEqual([]);
      // the history, in order
      expect((await detail(c, GM, task)).handovers.map((h) => [h.by_name, h.to_name])).toEqual([
        ['Test Executive Housekeeper 1.0', 'Test Housekeeping Supervisor 1.0'],
        ['Test Housekeeping Supervisor 1.0', 'Test Room Attendant 1.0'],
      ]);
    });
  });

  it('the department head takes it back or gives it to someone else; the one who had it is told', async () => {
    await inRolledBackTx(async (c) => {
      const task = await pestTask(c);
      await give(c, EH, task, HS);
      await give(c, HS, task, RA);
      expect(await give(c, EH, task, RA_B)).toBeUndefined();
      expect(await notes(c, RA, 'task_reassigned', 'Pest control')).toHaveLength(1);
      expect(await give(c, EH, task, EH)).toBeUndefined();
      expect((await detail(c, EH, task)).assignee_name).toBe('Test Executive Housekeeper 1.0');
      // the room attendant who no longer has it: neither works it nor passes it on
      expect(await give(c, RA, task, RA)).toMatch(/NOT_AUTHORISED/);
      // a cook, another department's head, someone at another outlet: not theirs
      for (const who of [COMMIS, FOM, OUTSIDER])
        expect(await give(c, who, task, RA), who).toMatch(/NOT_AUTHORISED|NOT_FOUND/);
      // only to someone who works at the hotel
      expect(await give(c, EH, task, OUTSIDER)).toMatch(/INVALID_ASSIGNEE/);
    });
  });

  it('done: whoever handed it on is told; the GM hears once, as the one who answers for it', async () => {
    await inRolledBackTx(async (c) => {
      const task = await pestTask(c);
      await give(c, EH, task, HS);
      await give(c, HS, task, RA);
      const file = `compliance/${ids.tenant()}/${ids.node(HOTEL)}/${crypto.randomUUID()}.pdf`;
      const job = (
        await c.query<{ id: string }>(
          `select compliance_item_id as id from ops.task where id = $1`,
          [task],
        )
      ).rows[0]!.id;
      await ok(c, RA, `select ops.mark_compliance_done($1, current_date, $2, null)`, [job, [file]]);
      for (const who of [EH, HS]) {
        expect(await notes(c, who, 'task_done', 'Pest control'), who).toEqual([
          { title: 'Done: Pest control service', body: 'By Test Room Attendant 1.0' },
        ]);
      }
      expect(await notes(c, GM, 'compliance_done', 'Pest control')).toHaveLength(1);
      expect(await notes(c, GM, 'task_done', 'Pest control')).toEqual([]);
      expect(await notes(c, RA, 'task_done', 'Pest control')).toEqual([]);
      // and it leaves "Given to others"
      expect(await handedOn(c, EH)).toEqual([]);
    });
  });
});

describe('every way a task is assigned records who gave it to whom, and when', () => {
  const create = (c: pg.PoolClient, who: string, node: string, assign: object) =>
    ok<{ id: string }>(
      c,
      who,
      `select ops.create_task($1, 'Polish the lobby brass', '', now() + interval '2 hours', 'normal',
                              $2::jsonb, '[]'::jsonb) as id`,
      [ids.node(node), JSON.stringify(assign)],
    ).then((r) => r[0]!.id);

  const history = async (c: pg.PoolClient, task: string) =>
    (
      await c.query<{ from_user: string | null; to_user: string; by_user: string | null }>(
        `select from_user, to_user, by_user from ops.task_handover where task_id = $1 order by at, id`,
        [task],
      )
    ).rows;

  const assignedAt = async (c: pg.PoolClient, task: string) =>
    (
      await c.query<{ a: Date | null }>(`select assigned_at as a from ops.task where id = $1`, [
        task,
      ])
    ).rows[0]!.a;

  it('a task made for one person: the maker is its giver and follows it', async () => {
    await inRolledBackTx(async (c) => {
      const task = await create(c, GM, HOTEL, { mode: 'person', user_id: ids.user(RA) });
      expect(await history(c, task)).toEqual([
        { from_user: null, to_user: ids.user(RA), by_user: ids.user(GM) },
      ]);
      expect(await assignedAt(c, task)).not.toBeNull();
      expect((await handedOn(c, GM)).map((t) => t.id)).toContain(task);
      // her department head sees it although it sits at the hotel, and may move it
      expect(await opens(c, EH, task)).toBe(true);
      expect(await give(c, EH, task, RA_B)).toBeUndefined();
      // the room attendant who had it can't open it any more; the GM, who made it, still can
      expect(await opens(c, RA, task)).toBe(false);
      expect(await opens(c, GM, task)).toBe(true);
      expect(await opens(c, FOM, task)).toBe(false);
    });
  });

  it('a task made for a job role: given when made; taking it is recorded as taking it', async () => {
    await inRolledBackTx(async (c) => {
      const task = await create(c, EH, HK, { mode: 'job_role', role: 'ROOM_ATTENDANT' });
      expect(await history(c, task)).toEqual([]);
      expect(await assignedAt(c, task)).not.toBeNull();
      // doing it takes it (the first to start takes it)
      await ok(c, RA, `select ops.complete_task($1)`, [task]);
      expect(await history(c, task)).toEqual([
        { from_user: null, to_user: ids.user(RA), by_user: ids.user(RA) },
      ]);
      expect((await detail(c, EH, task)).handovers[0]).toMatchObject({ took: true });
      // nobody handed it on, so nobody is told it is done
      expect(await notes(c, EH, 'task_done', 'Polish the lobby brass')).toEqual([]);
      // taking it is not handing it on
      expect(await handedOn(c, RA)).toEqual([]);
    });
  });

  it('done: the maker of a task for someone else is told; the one who did it is not', async () => {
    await inRolledBackTx(async (c) => {
      const task = await create(c, GM, HOTEL, { mode: 'person', user_id: ids.user(RA) });
      await ok(c, RA, `select ops.complete_task($1)`, [task]);
      expect(await notes(c, GM, 'task_done', 'Polish the lobby brass')).toEqual([
        { title: 'Done: Polish the lobby brass', body: 'By Test Room Attendant 1.0' },
      ]);
      expect(await notes(c, RA, 'task_done', 'Polish the lobby brass')).toEqual([]);
    });
  });

  it('a licence renewal handed on by the GM', async () => {
    await inRolledBackTx(async (c) => {
      const t = await c.query<{ id: string }>(
        `select t.id from ops.task t join ops.licence l on l.id = t.licence_id
          where l.name = 'FSSAI licence' and l.org_node_id = $1 and t.status = 'open'`,
        [ids.node(HOTEL)],
      );
      const task = t.rows[0]!.id;
      expect(await give(c, GM, task, 'test.assistant-general-manager.1.0')).toBeUndefined();
      expect(await history(c, task)).toEqual([
        {
          from_user: null,
          to_user: ids.user('test.assistant-general-manager.1.0'),
          by_user: ids.user(GM),
        },
      ]);
      expect(await opens(c, GM, task)).toBe(true);
      expect(await opens(c, COMMIS, task)).toBe(false);
    });
  });

  it('an expired batch given to someone to discard', async () => {
    await inRolledBackTx(async (c) => {
      const store = ids.node('TEST-HOTEL-1.0-KITCHEN-STORE');
      const item = (
        await c.query<{ id: string }>(
          `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id
            where t.code = 'TEST-COMPANY' and i.sku = 'MINT-CHUTNEY'`,
        )
      ).rows[0]!.id;
      const batch = (
        await c.query<{ b: string }>(
          `select batch_no as b from inv.production where delivery_node_id = $1 and prep_item_id = $2
            order by made_at limit 1`,
          [store, item],
        )
      ).rows[0]!.b;
      const task = (
        await ok<{ id: string }>(c, COMMIS, `select ops.report_expired($1, $2, $3) as id`, [
          store,
          item,
          batch,
        ])
      )[0]!.id;
      expect(await assignedAt(c, task)).toBeNull(); // reported: nobody has it yet
      const chef = 'test.executive-chef.1.0';
      await ok(c, chef, `select ops.assign_expiry($1, $2, now() + interval '1 hour', false)`, [
        task,
        ids.user('test.commis-b.1.0'),
      ]);
      expect(await history(c, task)).toEqual([
        { from_user: null, to_user: ids.user('test.commis-b.1.0'), by_user: ids.user(chef) },
      ]);
      expect(await assignedAt(c, task)).not.toBeNull();
      expect((await handedOn(c, chef)).map((t) => t.id)).toContain(task);
    });
  });

  it('a repair assigned to a technician: who assigned it and when', async () => {
    await inRolledBackTx(async (c) => {
      const r = (
        await ok<{ id: string }>(
          c,
          RA,
          `select ops.raise_maintenance($1, 'Lobby door sticks', 'It drags on the floor', null) as id`,
          [ids.node(HOTEL)],
        )
      )[0]!.id;
      await ok(c, 'test.chief-engineer.1.0', `select ops.assign_maintenance($1, $2)`, [
        r,
        ids.user('test.technician.1.0'),
      ]);
      const row = await ok<{
        assigned_to_name: string;
        assigned_by_name: string;
        assigned_at: Date;
      }>(
        c,
        'test.chief-engineer.1.0',
        `select assigned_to_name, assigned_by_name, assigned_at from ops.maintenance_requests($1)`,
        [r],
      );
      expect(row[0]).toMatchObject({
        assigned_to_name: 'Test Technician 1.0',
        assigned_by_name: 'Test Chief Engineer 1.0',
      });
      expect(row[0]!.assigned_at).not.toBeNull();
    });
  });

  it("a covered role's task given by the tasks job: given by nobody, on the day it was given", async () => {
    await inRolledBackTx(async (c) => {
      const t = await c.query<{ id: string; a: Date }>(
        `select t.id, t.assigned_at as a from ops.task t
          where t.auto_assigned_at is not null and t.assignee_user_id is not null limit 1`,
      );
      if (t.rows.length === 0) return; // nobody covering is on duty at this hour
      const h = await history(c, t.rows[0]!.id);
      expect(h.at(-1)!.by_user).toBeNull();
      expect(t.rows[0]!.a).not.toBeNull();
    });
  });
});

describe('every list links to a task the person can open, and every button there works', () => {
  // For every user of both test customers and every task their lists show: the task page
  // opens; when it offers "Give it to someone", the people it lists load and giving it to
  // one of them is accepted; when it offers Cancel, cancelling is accepted. The two writes
  // are undone at once (a raised marker rolls the block back), so each user sees the data
  // as it was.
  it(
    'for every user of both test customers, after handing tasks on',
    { timeout: 600_000 },
    async () => {
      await inRolledBackTx(async (c) => {
        const task = await pestTask(c);
        await give(c, EH, task, HS);
        await give(c, HS, task, RA);
        await c.query(`
        create function pg_temp.check_task(p uuid) returns text language plpgsql as $$
        declare
          d jsonb;
          who uuid;
        begin
          begin
            d := ops.task_detail(p);
          exception when others then
            return 'does not open: ' || sqlerrm;
          end;
          if (d ->> 'can_hand_on')::boolean then
            begin
              select h.user_id into who from ops.hand_on_people(p) h
               where h.user_id is distinct from (d ->> 'assignee_user_id')::uuid limit 1;
              if who is not null then
                perform ops.reassign_task(p, who);
              end if;
              raise exception 'CHECK_OK';
            exception when others then
              if sqlerrm <> 'CHECK_OK' then
                return 'offers Give it to someone, which fails: ' || sqlerrm;
              end if;
            end;
          end if;
          if (d ->> 'can_manage')::boolean and d ->> 'status' in ('open', 'in_progress')
             and d ->> 'kind' in ('one_off', 'checklist', 'prep') then
            begin
              perform ops.cancel_task(p, 'check');
              raise exception 'CHECK_OK';
            exception when others then
              if sqlerrm <> 'CHECK_OK' then
                return 'offers Cancel, which fails: ' || sqlerrm;
              end if;
            end;
          end if;
          return null;
        end $$`);
        const users = (
          await c.query<{ id: string; username: string }>(
            `select u.id, u.username from core.app_user u join core.tenant t on t.id = u.tenant_id
              where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') and u.status = 'active'
              order by u.username`,
          )
        ).rows;
        expect(users.length).toBeGreaterThan(50);
        const broken: string[] = [];
        let checked = 0;
        for (const u of users) {
          const r = await attemptAs<{ id: string; problem: string | null }>(
            c,
            u.id,
            `select l.id, pg_temp.check_task(l.id) as problem from (
               select id from ops.my_tasks()
               union select id from ops.my_handed_on()
               union select x.id from core.screen_places('tasks') p
                      cross join lateral ops.team_tasks(p.id, current_date - 7, current_date) x
             ) l`,
          );
          if (r.error !== undefined) broken.push(`${u.username}: ${r.error}`);
          else {
            checked += r.rows.length;
            for (const x of r.rows)
              if (x.problem) broken.push(`${u.username} ${x.id}: ${x.problem}`);
          }
        }
        expect(broken).toEqual([]);
        expect(checked).toBeGreaterThan(100);
      });
    },
  );
});
