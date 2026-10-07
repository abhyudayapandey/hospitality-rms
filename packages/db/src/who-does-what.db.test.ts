import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asPlatform,
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  newPlatformAdmin,
  type SeedIds,
} from '../test/helpers';

// Admin → Who does what (ADR 065): an Account Owner or user admin changes who covers a job
// role at an outlet after go-live. The same checks as file 37 (core.role_cover_errors), the
// same guardrails as any access change (core.sync_job_role_access: your own access, rank,
// sensitive grants waiting for approval), access applied at once for everyone there, and the
// role's unstarted tasks follow. Every test starts from no covers (the seed's, ADR 066, are
// archived first) and adds its own inside a rolled-back transaction.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

/** A rolled-back transaction with the seed's covers archived and their access taken off. */
function fresh<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return inRolledBackTx(async (c) => {
    const { rows } = await c.query<{ org_node_id: string }>(
      `update hr.role_cover set archived_at = now() where archived_at is null
       returning org_node_id`,
    );
    for (const r of rows) await c.query('select core.apply_cover_access($1)', [r.org_node_id]);
    return fn(c);
  });
}

const H10 = 'TEST-HOTEL-1.0';
const H11 = 'TEST-HOTEL-1.1';
const GH = 'TEST-GUEST-HOUSE-2.0';
const BAR = 'TEST-BAR-3.0';
const OWNER = 'test.account-owner';

type Result = {
  changed: boolean;
  applied?: number;
  pending?: number;
  people?: { name: string; waiting: number }[];
  tasks_returned?: number;
  tasks_given?: number;
  tasks_open?: number;
};
type Preview = { errors: { code: string; detail: string | null }[]; result?: Result };

const set = (
  c: pg.PoolClient,
  who: string,
  outlet: string,
  role: string,
  answer: string,
  by: string | null = null,
) =>
  attemptAs<{ r: Result }>(c, ids.user(who), 'select core.set_role_cover($1, $2, $3, $4) r', [
    ids.node(outlet),
    role,
    answer,
    by,
  ]);

const preview = (
  c: pg.PoolClient,
  who: string,
  outlet: string,
  role: string,
  answer: string,
  by: string | null = null,
) =>
  attemptAs<{ r: Preview }>(c, ids.user(who), 'select core.preview_role_cover($1, $2, $3, $4) r', [
    ids.node(outlet),
    role,
    answer,
    by,
  ]);

async function saved(
  c: pg.PoolClient,
  who: string,
  outlet: string,
  role: string,
  answer: string,
  by: string | null = null,
): Promise<Result> {
  const r = await set(c, who, outlet, role, answer, by);
  expect(r.error, `${who}: ${role} ${answer} ${by ?? ''} at ${outlet}`).toBeUndefined();
  return r.rows![0]!.r;
}

async function grants(c: pg.PoolClient, username: string): Promise<string[]> {
  const { rows } = await c.query<{ g: string }>(
    `select g.code || '@' || n.code || ' ' || coalesce(ra.source_note, '') g
       from core.role_assignment ra
       join core.security_group g on g.id = ra.group_id
       join core.hierarchy_node n on n.id = ra.node_id
      where ra.user_id = $1 and ra.source = 'job_role'
        and ra.effective_from <= current_date
        and (ra.effective_to is null or ra.effective_to >= current_date)
      order by 1`,
    [ids.user(username)],
  );
  return rows.map((r) => r.g.trim());
}

async function live(c: pg.PoolClient, outlet: string) {
  const { rows } = await c.query<{ role: string; mode: string; by: string | null }>(
    `select job_role_code role, mode, covered_by_role by from hr.role_cover
      where org_node_id = $1 and archived_at is null order by 1`,
    [ids.node(outlet)],
  );
  return rows;
}

describe('who may change it', () => {
  it('the Account Owner, anywhere in the company', async () => {
    await fresh(async (c) => {
      await saved(c, OWNER, H11, 'SOUS_CHEF', 'covered_by', 'EXECUTIVE_CHEF');
      await saved(c, OWNER, GH, 'STORE_KEEPER', 'covered_by', 'GENERAL_MANAGER');
      expect(await live(c, H11)).toEqual([
        { role: 'SOUS_CHEF', mode: 'covered_by', by: 'EXECUTIVE_CHEF' },
      ]);
    });
  });

  it('a user admin, only inside their user administration', async () => {
    await fresh(async (c) => {
      // the GM of 1.0 holds USER_ADMIN at 1.0 only
      await saved(c, 'test.general-manager.1.0', H10, 'SOUS_CHEF', 'covered_by', 'EXECUTIVE_CHEF');
      for (const r of [
        await set(c, 'test.general-manager.1.0', H11, 'SOUS_CHEF', 'covered_by', 'EXECUTIVE_CHEF'),
        await preview(c, 'test.general-manager.1.0', H11, 'SOUS_CHEF', 'not_done'),
      ]) {
        expect(r.error).toBe('NOT_AUTHORISED');
      }
      // the Front Desk Executive of 2.0 holds USER_ADMIN at 2.0 only
      await saved(c, 'test.front-desk-executive.2.0', GH, 'TECHNICIAN', 'not_done');
      expect(
        (await set(c, 'test.front-desk-executive.2.0', H10, 'TECHNICIAN', 'not_done')).error,
      ).toBe('NOT_AUTHORISED');
      expect(await live(c, H11)).toEqual([]);
    });
  });

  it('nobody without user administration: not a GM, not a department head, not staff', async () => {
    await fresh(async (c) => {
      for (const who of [
        'test.general-manager.1.1',
        'test.executive-chef.1.1',
        'test.server.3.0',
      ]) {
        const node = ids.node(H11);
        for (const sql of [
          `select core.set_role_cover($1, 'SOUS_CHEF', 'not_done')`,
          `select core.preview_role_cover($1, 'SOUS_CHEF', 'not_done')`,
          `select * from core.admin_role_cover($1)`,
          `select * from core.admin_role_cover(null::uuid) where $1::uuid is not null`,
          `select * from core.admin_cover_outlets() where $1::uuid is not null`,
        ]) {
          expect((await attemptAs(c, ids.user(who), sql, [node])).error, `${who}: ${sql}`).toBe(
            'NOT_AUTHORISED',
          );
        }
      }
      expect(await live(c, H11)).toEqual([]);
    });
  });

  it('another customer’s outlet is the same as no outlet: not found, for every function', async () => {
    await fresh(async (c) => {
      for (const node of [ids.node('TEST-SOLO-BAR'), '00000000-0000-7000-8000-000000000000']) {
        for (const sql of [
          `select core.set_role_cover($1, 'BARTENDER', 'not_done')`,
          `select core.preview_role_cover($1, 'BARTENDER', 'not_done')`,
          `select * from core.admin_role_cover($1)`,
        ]) {
          expect((await attemptAs(c, ids.user(OWNER), sql, [node])).error, sql).toBe('NOT_FOUND');
        }
      }
      // a department is not an outlet either
      expect((await set(c, OWNER, `${H11}-KITCHEN`, 'SOUS_CHEF', 'not_done')).error).toBe(
        'NOT_FOUND',
      );
    });
  });

  it('the app never writes covers itself, nor calls the loader’s functions', async () => {
    await fresh(async (c) => {
      const me = ids.user(OWNER);
      for (const sql of [
        `insert into hr.role_cover (tenant_id, org_node_id, job_role_code, mode)
         values ('${ids.tenant()}', '${ids.node(H11)}', 'SOUS_CHEF', 'not_done')`,
        `update hr.role_cover set mode = 'not_done'`,
        `select * from core.role_cover_errors('${ids.tenant()}', '${ids.node(H11)}', 'SOUS_CHEF', 'not_done', null)`,
        `select core.apply_cover_access('${ids.node(H11)}')`,
        `select core.cover_outlet_check('${ids.node(H11)}', 'modify')`,
        `select core.job_role_grants_key('${me}')`,
      ]) {
        const r = await attemptAs(c, me, sql);
        if (r.error) expect(r.error, sql).toMatch(/permission denied|NOT_AUTHORISED/);
        else expect(r.rows, sql).toEqual([]); // RLS: an update that sees no rows
      }
    });
  });

  it('platform.role_cover_rows: platform admins only', async () => {
    await fresh(async (c) => {
      await saved(c, OWNER, GH, 'STORE_KEEPER', 'covered_by', 'GENERAL_MANAGER');
      const sql = 'select * from platform.role_cover_rows($1)';
      expect((await attemptAs(c, ids.user(OWNER), sql, [ids.tenant()])).error).toMatch(
        /NOT_AUTHORISED|permission denied/,
      );
      const admin = await newPlatformAdmin(c);
      expect((await asPlatform(c, admin, sql, [ids.tenant()])).rows).toEqual([
        {
          outlet_code: GH,
          job_role_code: 'STORE_KEEPER',
          mode: 'covered_by',
          covered_by_role: 'GENERAL_MANAGER',
        },
      ]);
    });
  });
});

describe('the same rules and checks as file 37', () => {
  it('refuses what core.role_cover_errors refuses, with its code, and saves nothing', async () => {
    await fresh(async (c) => {
      await saved(c, OWNER, GH, 'COOK', 'covered_by', 'FRONT_DESK_EXECUTIVE');
      const cases: [string, string, string, string | null, string][] = [
        [GH, 'STORE_KEEPER', 'covered_by', 'STORE_KEEPER', 'COVER_SELF'],
        [GH, 'NO_SUCH_ROLE', 'covered_by', 'COOK', 'INVALID_JOB_ROLE'],
        [GH, 'STORE_KEEPER', 'covered_by', null, 'INVALID_JOB_ROLE'],
        [GH, 'STORE_KEEPER', 'sometimes', null, 'INVALID_MODE'],
        [GH, 'STORE_KEEPER', 'not_done', 'COOK', 'INVALID_MODE'],
        [GH, 'STORE_KEEPER', 'have', 'COOK', 'INVALID_MODE'],
        [GH, 'AREA_MANAGER', 'covered_by', 'GENERAL_MANAGER', 'COVER_ABOVE_OUTLET'],
        [GH, 'FRONT_DESK_EXECUTIVE', 'covered_by', 'COOK', 'COVER_CHAIN'],
        [GH, 'CASHIER', 'covered_by', 'COOK', 'COVER_CHAIN'],
        [BAR, 'STORE_KEEPER', 'covered_by', 'BAR_MANAGER', 'JOB_ROLE_SCOPE'],
      ];
      for (const [outlet, role, answer, by, code] of cases) {
        const what = `${role} ${answer} ${by ?? ''} at ${outlet}`;
        expect((await set(c, OWNER, outlet, role, answer, by)).error, what).toBe(code);
        const p = await preview(c, OWNER, outlet, role, answer, by);
        expect(
          p.rows![0]!.r.errors.map((e) => e.code),
          what,
        ).toContain(code);
        expect(p.rows![0]!.r.result, what).toBeUndefined();
      }
      // every reason, not just the first
      const both = await preview(c, OWNER, GH, 'ACCOUNT_OWNER', 'covered_by', 'GENERAL_MANAGER');
      expect(new Set(both.rows![0]!.r.errors.map((e) => e.code))).toEqual(
        new Set(['COVER_ABOVE_OUTLET', 'COVER_ADMIN']),
      );
      expect(await live(c, GH)).toEqual([
        { role: 'COOK', mode: 'covered_by', by: 'FRONT_DESK_EXECUTIVE' },
      ]);
    });
  });
});

describe('access, at once', () => {
  it('"Our Sous Chef left; the Executive Chef covers": the chef gets it at that outlet only', async () => {
    await fresh(async (c) => {
      const before = await grants(c, 'test.executive-chef.1.1');
      const other = await grants(c, 'test.executive-chef.1.0');
      const r = await saved(c, OWNER, H11, 'SOUS_CHEF', 'covered_by', 'EXECUTIVE_CHEF');
      const after = await grants(c, 'test.executive-chef.1.1');
      expect(
        after.filter((g) => !before.includes(g)).every((g) => g.endsWith('covers Sous Chef')),
      ).toBe(true);
      expect(after.length).toBeGreaterThan(before.length);
      expect(r).toMatchObject({ changed: true, pending: 0 });
      expect(r.applied).toBe(after.length - before.length);
      expect(r.people).toEqual([
        {
          user_id: ids.user('test.executive-chef.1.1'),
          name: 'Test Executive Chef 1.1',
          waiting: 0,
        },
      ]);
      expect(await grants(c, 'test.executive-chef.1.0')).toEqual(other);
      // back to "We have it": the access goes the same moment
      const back = await saved(c, OWNER, H11, 'SOUS_CHEF', 'have');
      expect(back.changed).toBe(true);
      expect(await grants(c, 'test.executive-chef.1.1')).toEqual(before);
      // and nothing to do the second time
      expect(await saved(c, OWNER, H11, 'SOUS_CHEF', 'have')).toEqual({ changed: false });
    });
  });

  it('"We hired a Store Keeper; stop the GM covering"', async () => {
    await fresh(async (c) => {
      const before = await grants(c, 'test.general-manager.2.0');
      await saved(c, OWNER, GH, 'STORE_KEEPER', 'covered_by', 'GENERAL_MANAGER');
      expect(await grants(c, 'test.general-manager.2.0')).toContain(
        `STORE_KEEPER@${GH}-SUPPLY covers Store Keeper`,
      );
      // changing who covers moves it
      await saved(c, 'test.front-desk-executive.2.0', GH, 'STORE_KEEPER', 'covered_by', 'COOK');
      expect(await grants(c, 'test.general-manager.2.0')).toEqual(before);
      expect(await grants(c, 'test.cook.2.0')).toContain(
        `STORE_KEEPER@${GH}-SUPPLY covers Store Keeper`,
      );
      await saved(c, 'test.front-desk-executive.2.0', GH, 'STORE_KEEPER', 'have');
      expect(await grants(c, 'test.cook.2.0')).not.toContainEqual(
        expect.stringContaining('covers'),
      );
    });
  });

  it('your own access: refused, by the save and the preview, whichever way it changes', async () => {
    await fresh(async (c) => {
      const fd = 'test.front-desk-executive.2.0';
      expect(
        (await set(c, fd, GH, 'STORE_KEEPER', 'covered_by', 'FRONT_DESK_EXECUTIVE')).error,
      ).toBe('SELF_GRANT');
      expect(
        (await preview(c, fd, GH, 'STORE_KEEPER', 'covered_by', 'FRONT_DESK_EXECUTIVE')).rows![0]!.r
          .errors,
      ).toEqual([{ code: 'SELF_GRANT', detail: 'you cannot change your own access' }]);
      expect(await live(c, GH)).toEqual([]);
      // set by the Account Owner, "We have it" would stop the admin covering: refused too
      await saved(c, OWNER, GH, 'STORE_KEEPER', 'covered_by', 'FRONT_DESK_EXECUTIVE');
      expect((await set(c, fd, GH, 'STORE_KEEPER', 'have')).error).toBe('SELF_GRANT');
      expect(await live(c, GH)).toEqual([
        { role: 'STORE_KEEPER', mode: 'covered_by', by: 'FRONT_DESK_EXECUTIVE' },
      ]);
    });
  });

  it('a sensitive grant waits for approval: the cover is saved, the access is not live yet', async () => {
    await fresh(async (c) => {
      const before = await grants(c, 'test.general-manager.2.0');
      const r = await saved(c, OWNER, GH, 'HR_EXECUTIVE', 'covered_by', 'GENERAL_MANAGER');
      expect(r.pending).toBeGreaterThan(0);
      expect(r.people).toEqual([
        expect.objectContaining({ name: 'Test General Manager 2.0', waiting: r.pending }),
      ]);
      expect(await live(c, GH)).toEqual([
        { role: 'HR_EXECUTIVE', mode: 'covered_by', by: 'GENERAL_MANAGER' },
      ]);
      const after = await grants(c, 'test.general-manager.2.0');
      expect(after.filter((g) => g.startsWith('OUTLET_HR@'))).toEqual(
        before.filter((g) => g.startsWith('OUTLET_HR@')),
      );
      const { rows } = await c.query<{ n: number }>(
        `select count(*)::int n from hr.role_change
          where target_user_id = $1 and status = 'submitted'`,
        [ids.user('test.general-manager.2.0')],
      );
      expect(rows[0]!.n).toBe(r.pending);
    });
  });

  it('every change is in the audit, by whoever made it; Admin’s changes are marked', async () => {
    await fresh(async (c) => {
      await saved(c, OWNER, H11, 'SOUS_CHEF', 'covered_by', 'EXECUTIVE_CHEF');
      await saved(c, 'test.general-manager.1.0', H10, 'SOUS_CHEF', 'not_done');
      await saved(c, OWNER, H11, 'SOUS_CHEF', 'not_done');
      await saved(c, OWNER, H11, 'SOUS_CHEF', 'have');
      const { rows } = await c.query<{
        op: string;
        actor: string;
        mode: string;
        archived: boolean;
      }>(
        `select l.op, u.username actor, l.after ->> 'mode' mode,
                l.after ->> 'archived_at' is not null archived
           from audit.log l join core.app_user u on u.id = l.actor_id
          where l.table_name = 'hr.role_cover' order by l.occurred_at, l.id`,
      );
      expect(rows).toEqual([
        { op: 'INSERT', actor: OWNER, mode: 'covered_by', archived: false },
        { op: 'INSERT', actor: 'test.general-manager.1.0', mode: 'not_done', archived: false },
        { op: 'UPDATE', actor: OWNER, mode: 'not_done', archived: false },
        { op: 'UPDATE', actor: OWNER, mode: 'not_done', archived: true },
      ]);
      const by = await c.query<{ who: string }>(
        `select u.username who from hr.role_cover c join core.app_user u on u.id = c.set_in_app_by
          where c.org_node_id = $1 and c.set_in_app_at is not null`,
        [ids.node(H11)],
      );
      expect(by.rows).toEqual([{ who: OWNER }]);
      // the access the cover gave is in the access audit with its source
      const ra = await c.query<{ n: number }>(
        `select count(*)::int n from audit.log
          where table_name = 'core.role_assignment' and actor_id = $1
            and after ->> 'source_note' = 'covers Sous Chef'`,
        [ids.user(OWNER)],
      );
      expect(ra.rows[0]!.n).toBeGreaterThan(0);
    });
  });
});

describe('the preview', () => {
  it('says what the save does, and writes nothing', async () => {
    await fresh(async (c) => {
      const before = await grants(c, 'test.executive-chef.1.1');
      const audited = async () =>
        (
          await c.query<{ n: number }>(
            `select count(*)::int n from audit.log where table_name = 'hr.role_cover'`,
          )
        ).rows[0]!.n;
      const auditBefore = await audited();
      const p = await preview(c, OWNER, H11, 'SOUS_CHEF', 'covered_by', 'EXECUTIVE_CHEF');
      expect(await grants(c, 'test.executive-chef.1.1')).toEqual(before);
      expect(await live(c, H11)).toEqual([]);
      expect(await audited()).toBe(auditBefore);
      const r = await saved(c, OWNER, H11, 'SOUS_CHEF', 'covered_by', 'EXECUTIVE_CHEF');
      expect(p.rows![0]!.r).toEqual({ errors: [], result: r });
    });
  });
});

describe('who does what at an outlet', () => {
  it('lists the roles that work there, with their answer, people and duties', async () => {
    await fresh(async (c) => {
      await saved(c, OWNER, GH, 'STORE_KEEPER', 'covered_by', 'GENERAL_MANAGER');
      const { rows } = (await attemptAs<{
        job_role_code: string;
        people: number;
        answer: string;
        covered_by_name: string | null;
        changed_by: string | null;
        duties: string[];
        can_change: boolean;
      }>(c, ids.user('test.front-desk-executive.2.0'), 'select * from core.admin_role_cover($1)', [
        ids.node(GH),
      ])) as { rows: never[] };
      const by = new Map(rows.map((r: { job_role_code: string }) => [r.job_role_code, r]));
      expect(by.get('STORE_KEEPER')).toMatchObject({
        people: 0,
        answer: 'covered_by',
        covered_by_name: 'General Manager',
        changed_by: 'Test Account Owner',
        can_change: true,
      });
      expect(by.get('FRONT_DESK_EXECUTIVE')).toMatchObject({ people: 1, answer: 'have' });
      expect(by.get('GENERAL_MANAGER')).toMatchObject({ duties: ['RUNS_OUTLET'] });
      // never a role that works above the outlet
      for (const code of ['ACCOUNT_OWNER', 'AREA_MANAGER', 'HR_ADMIN', 'AUDITOR'])
        expect(by.has(code), code).toBe(false);
    });
  });

  it('"All outlets": only the covers, only where the admin may look', async () => {
    await fresh(async (c) => {
      await saved(c, OWNER, GH, 'STORE_KEEPER', 'covered_by', 'GENERAL_MANAGER');
      await saved(c, OWNER, H11, 'SOUS_CHEF', 'not_done');
      const all = async (who: string) =>
        (
          await attemptAs<{ outlet_name: string; job_role_code: string; answer: string }>(
            c,
            ids.user(who),
            'select outlet_name, job_role_code, answer from core.admin_role_cover(null)',
          )
        ).rows;
      expect(await all(OWNER)).toEqual([
        {
          outlet_name: 'Test Guest House 2.0',
          job_role_code: 'STORE_KEEPER',
          answer: 'covered_by',
        },
        { outlet_name: 'Test Hotel & Bar 1.1', job_role_code: 'SOUS_CHEF', answer: 'not_done' },
      ]);
      expect(await all('test.general-manager.1.0')).toEqual([]);
      const outlets = await attemptAs<{ outlet_name: string; covers: number }>(
        c,
        ids.user('test.general-manager.1.0'),
        'select outlet_name, covers from core.admin_cover_outlets()',
      );
      expect(outlets.rows).toEqual([{ outlet_name: 'Test Hotel & Bar 1.0', covers: 0 }]);
    });
  });
});

// A covered task goes to a coverer on duty; nobody here is clocked in in the test data at
// this moment, so who is on duty is set here.
async function clockIn(c: pg.PoolClient, username: string): Promise<void> {
  await c.query(
    `insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, clock_in_at,
                                in_source, in_key)
     select w.tenant_id, w.id, w.owner_user_id, w.org_node_id, now() - interval '1 hour',
            'online', 'wdw-test-' || w.id
       from hr.worker w where w.owner_user_id = $1`,
    [ids.user(username)],
  );
}

async function newTask(c: pg.PoolClient, node: string, role: string, dueIn = '10 minutes') {
  const { rows } = await c.query<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode, job_role_code)
     values ($1, $2, 'one_off', 'Covered job', now() + $3::interval, 'job_role', $4) returning id`,
    [ids.tenant(), ids.node(node), dueIn, role],
  );
  return rows[0]!.id;
}

async function holder(c: pg.PoolClient, task: string) {
  const { rows } = await c.query<{ u: string | null; auto: boolean }>(
    `select u.username u, t.auto_assigned_at is not null auto
       from ops.task t left join core.app_user u on u.id = t.assignee_user_id where t.id = $1`,
    [task],
  );
  return rows[0]!;
}

describe('open tasks of the moved duty', () => {
  it('a new cover gives what is due to a coverer on duty at once', async () => {
    await fresh(async (c) => {
      await clockIn(c, 'test.cook.2.0');
      const due = await newTask(c, GH, 'STORE_KEEPER');
      const later = await newTask(c, GH, 'STORE_KEEPER', '5 hours');
      const r = await saved(c, OWNER, GH, 'STORE_KEEPER', 'covered_by', 'COOK');
      expect(r.tasks_given).toBe(1);
      expect(await holder(c, due)).toEqual({ u: 'test.cook.2.0', auto: true });
      // not due yet: in the pool, given when it comes due
      expect(await holder(c, later)).toEqual({ u: null, auto: false });
      expect(r.tasks_open).toBe(1);
    });
  });

  it('a different coverer: unstarted tasks move to them; a started one stays', async () => {
    await fresh(async (c) => {
      await clockIn(c, 'test.cook.2.0');
      await clockIn(c, 'test.general-manager.2.0');
      const a = await newTask(c, GH, 'STORE_KEEPER');
      const b = await newTask(c, GH, 'STORE_KEEPER');
      await saved(c, OWNER, GH, 'STORE_KEEPER', 'covered_by', 'COOK');
      // cover gives one each in turn? both go to the only cook; start one of them
      expect((await holder(c, a)).u).toBe('test.cook.2.0');
      expect((await holder(c, b)).u).toBe('test.cook.2.0');
      await c.query(`update ops.task set status = 'in_progress' where id = $1`, [b]);
      const r = await saved(c, OWNER, GH, 'STORE_KEEPER', 'covered_by', 'GENERAL_MANAGER');
      expect(r).toMatchObject({ tasks_returned: 1, tasks_given: 1 });
      expect(await holder(c, a)).toEqual({ u: 'test.general-manager.2.0', auto: true });
      expect((await holder(c, b)).u).toBe('test.cook.2.0');
    });
  });

  it('"We have it" again: what the coverer was given goes back to the role', async () => {
    await fresh(async (c) => {
      await clockIn(c, 'test.cook.2.0');
      const t = await newTask(c, GH, 'STORE_KEEPER');
      await saved(c, OWNER, GH, 'STORE_KEEPER', 'covered_by', 'COOK');
      expect((await holder(c, t)).u).toBe('test.cook.2.0');
      const r = await saved(c, OWNER, GH, 'STORE_KEEPER', 'have');
      expect(r).toMatchObject({ tasks_returned: 1, tasks_given: 0, tasks_open: 1 });
      expect(await holder(c, t)).toEqual({ u: null, auto: false });
    });
  });

  it('"We don\'t do this": nothing is cancelled; unstarted ones stay unassigned and say so', async () => {
    await fresh(async (c) => {
      await clockIn(c, 'test.cook.2.0');
      const given = await newTask(c, GH, 'STORE_KEEPER');
      await newTask(c, GH, 'STORE_KEEPER', '3 hours');
      await saved(c, OWNER, GH, 'STORE_KEEPER', 'covered_by', 'COOK');
      const p = await preview(c, OWNER, GH, 'STORE_KEEPER', 'not_done');
      expect(p.rows![0]!.r.result).toMatchObject({ tasks_returned: 1, tasks_open: 2 });
      const r = await saved(c, OWNER, GH, 'STORE_KEEPER', 'not_done');
      expect(r).toMatchObject({ tasks_returned: 1, tasks_given: 0, tasks_open: 2 });
      const { rows } = await c.query<{ status: string }>(
        `select status from ops.task where id = $1`,
        [given],
      );
      expect(rows[0]!.status).toBe('open');
    });
  });

  it('a task the role’s own people took stays with them', async () => {
    await fresh(async (c) => {
      const t = await newTask(c, H11, 'SOUS_CHEF');
      await c.query(`update ops.task set assignee_user_id = $2 where id = $1`, [
        t,
        ids.user('test.sous-chef.1.1'),
      ]);
      const r = await saved(c, OWNER, H11, 'SOUS_CHEF', 'covered_by', 'EXECUTIVE_CHEF');
      expect(r.tasks_returned).toBe(0);
      expect((await holder(c, t)).u).toBe('test.sous-chef.1.1');
    });
  });
});

describe('Admin and imports together', () => {
  it('a cover ended in Admin and set again by an import gives its access back (ADR 066)', async () => {
    await inRolledBackTx(async (c) => {
      // the seed's cover: the Front Desk keeps Guest House 2.0's store
      const keeper = `STORE_KEEPER@${GH}-SUPPLY covers Store Keeper`;
      const fd = 'test.front-desk-executive.2.0';
      expect(await grants(c, fd)).toContain(keeper);
      // Admin: "We have it" ends the grant (kept as history)
      await saved(c, OWNER, GH, 'STORE_KEEPER', 'have');
      expect(await grants(c, fd)).not.toContain(keeper);
      // an import of file 37 sets it again: the same rows the loader writes
      await c.query(
        `insert into hr.role_cover (tenant_id, org_node_id, job_role_code, mode, covered_by_role)
         values ($1, $2, 'STORE_KEEPER', 'covered_by', 'FRONT_DESK_EXECUTIVE')`,
        [ids.tenant(), ids.node(GH)],
      );
      await c.query('select core.apply_cover_access($1)', [ids.node(GH)]);
      expect(await grants(c, fd)).toContain(keeper);
    });
  });
});
