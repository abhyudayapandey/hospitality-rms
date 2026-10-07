import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Who covers it (ADR 061): at one outlet, a job role the outlet doesn't have is covered by a
// role it has, or not done there. The covering role's people get the covered role's grants
// at that outlet only, through the same derivation as their own; its job-role tasks are
// given to one of them on duty (clocked in first, fewest open tasks, then round robin); a
// role not done has no checklist rounds there. The seed has one cover each (ADR 066): Guest
// House 2.0's Front Desk covers the Store Keeper, and the Solo Bar's Kitchen Steward is not
// done. The tests below start without them and add their own inside a rolled-back
// transaction.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

const GH = 'TEST-GUEST-HOUSE-2.0';
const BAR = 'TEST-BAR-3.0';

async function cover(
  c: pg.PoolClient,
  outlet: string,
  role: string,
  by: string | null,
  mode = by ? 'covered_by' : 'not_done',
): Promise<string> {
  const errors = await c.query<{ code: string; detail: string }>(
    `select * from core.role_cover_errors($1, $2, $3, $4, $5)`,
    [ids.tenant(), ids.node(outlet), role, mode, by],
  );
  expect(errors.rows, `${role} ${mode} ${by ?? ''} at ${outlet}`).toEqual([]);
  const { rows } = await c.query<{ id: string }>(
    `insert into hr.role_cover (tenant_id, org_node_id, job_role_code, mode, covered_by_role)
     values ($1, $2, $3, $4, $5) returning id`,
    [ids.tenant(), ids.node(outlet), role, mode, by],
  );
  await c.query('select core.apply_cover_access($1)', [ids.node(outlet)]);
  return rows[0]!.id;
}

async function grants(c: pg.PoolClient, username: string): Promise<string[]> {
  const { rows } = await c.query<{ g: string }>(
    `select g.code || '@' || n.code || ' ' || coalesce(ra.source_note, '') g
       from core.role_assignment ra
       join core.security_group g on g.id = ra.group_id
       join core.hierarchy_node n on n.id = ra.node_id
      where ra.user_id = $1 and ra.source = 'job_role'
        and (ra.effective_to is null or ra.effective_to >= current_date)
      order by 1`,
    [ids.user(username)],
  );
  return rows.map((r) => r.g.trim());
}

async function errorsFor(
  c: pg.PoolClient,
  outlet: string,
  role: string,
  mode: string,
  by: string | null,
): Promise<string[]> {
  const { rows } = await c.query<{ code: string }>(
    `select code from core.role_cover_errors($1, $2, $3, $4, $5)`,
    [ids.tenant(), ids.node(outlet), role, mode, by],
  );
  return rows.map((r) => r.code);
}

/** A rolled-back transaction without the seed's covers, and the access they gave. */
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

describe('cover and access', () => {
  it('in the seed, the only access from a cover is 2.0’s Store Keeper, for its Front Desk', async () => {
    const { rows } = await inRolledBackTx((c) =>
      c.query<{ username: string; access_group: string; source: string }>(
        `select u.username, d.access_group, d.source
           from hr.worker w join core.app_user u on u.id = w.owner_user_id,
                core.derive_job_role_access(w.owner_user_id) d
          where d.source like 'covers %'`,
      ),
    );
    expect(rows).toEqual([
      {
        username: 'test.front-desk-executive.2.0',
        access_group: 'STORE_KEEPER',
        source: 'covers Store Keeper',
      },
    ]);
  });

  it('gives the covering role’s people the covered role’s grants, at that outlet only', async () => {
    await fresh(async (c) => {
      const before = await grants(c, 'test.front-desk-executive.2.0');
      const otherBefore = await grants(c, 'test.front-desk-executive.1.0');
      await cover(c, GH, 'STORE_KEEPER', 'FRONT_DESK_EXECUTIVE');
      const after = await grants(c, 'test.front-desk-executive.2.0');
      // the Store Keeper keeps the outlet's stock location (2.0 has no main store)
      expect(after.filter((g) => !before.includes(g))).toEqual([
        `STORE_KEEPER@${GH}-SUPPLY covers Store Keeper`,
      ]);
      // the same role at another outlet gets nothing
      expect(await grants(c, 'test.front-desk-executive.1.0')).toEqual(otherBefore);
      // and nobody else at 2.0 changes
      expect(await grants(c, 'test.cook.2.0')).not.toContainEqual(
        expect.stringContaining('covers'),
      );
    });
  });

  it('the app follows it: the cover reaches 2.0’s store and nowhere else', async () => {
    await fresh(async (c) => {
      const fd = ids.user('test.front-desk-executive.2.0');
      const can = async (store: string) =>
        (
          await attemptAs<{ ok: boolean }>(
            c,
            fd,
            `select core.can('PURCHASE_ORDERS', 'modify', null, $1, null) ok`,
            [ids.node(store)],
          )
        ).rows?.[0]?.ok;
      expect(await can(`${GH}-SUPPLY`)).toBe(false);
      await cover(c, GH, 'STORE_KEEPER', 'FRONT_DESK_EXECUTIVE');
      expect(await can(`${GH}-SUPPLY`)).toBe(true);
      expect(await can('TEST-HOTEL-1.0-MAIN-STORE')).toBe(false);
    });
  });

  it('removing the cover takes the access away; changing who covers moves it', async () => {
    await fresh(async (c) => {
      const before = await grants(c, 'test.front-desk-executive.2.0');
      const id = await cover(c, GH, 'STORE_KEEPER', 'FRONT_DESK_EXECUTIVE');
      await c.query(`update hr.role_cover set covered_by_role = 'GENERAL_MANAGER' where id = $1`, [
        id,
      ]);
      await c.query('select core.apply_cover_access($1)', [ids.node(GH)]);
      expect(await grants(c, 'test.front-desk-executive.2.0')).toEqual(before);
      expect(await grants(c, 'test.general-manager.2.0')).toContain(
        `STORE_KEEPER@${GH}-SUPPLY covers Store Keeper`,
      );
      await c.query(`update hr.role_cover set archived_at = now() where id = $1`, [id]);
      await c.query('select core.apply_cover_access($1)', [ids.node(GH)]);
      expect(await grants(c, 'test.general-manager.2.0')).not.toContainEqual(
        expect.stringContaining('covers'),
      );
    });
  });

  it('a "runs the department" duty lands on the covered role’s department at that outlet', async () => {
    await fresh(async (c) => {
      // Bar 3.0 has no Executive Chef: a bartender covering one runs 3.0's Kitchen, not the Bar
      await cover(c, BAR, 'EXECUTIVE_CHEF', 'BARTENDER');
      const g = await grants(c, 'test.bartender.3.0');
      expect(g).toContain(`DEPARTMENT_HEAD@${BAR}-KITCHEN covers Executive Chef`);
      expect(g.filter((x) => x.includes('covers') && x.includes(`@${BAR}-BAR `))).toEqual([]);
    });
  });

  it('a department the outlet lacks: the work lands on the covering person’s own home', async () => {
    await fresh(async (c) => {
      // Bar 3.0 has no Housekeeping: a bartender's own department (the Bar) takes it
      await cover(c, BAR, 'HOUSEKEEPING_SUPERVISOR', 'BARTENDER');
      const covered = (await grants(c, 'test.bartender.3.0')).filter((x) => x.includes('covers'));
      expect(covered).toContain(`SUPERVISOR@${BAR}-BAR covers Housekeeping Supervisor`);
      for (const x of covered) expect(x).toMatch(new RegExp(`@${BAR}-BAR[ -]`));
    });
  });
});

describe('what a cover may not be', () => {
  it('refuses with a stable code', async () => {
    await fresh(async (c) => {
      expect(await errorsFor(c, GH, 'STORE_KEEPER', 'covered_by', 'STORE_KEEPER')).toEqual([
        'COVER_SELF',
      ]);
      expect(await errorsFor(c, `${BAR}-BAR`, 'STORE_KEEPER', 'covered_by', 'BARTENDER')).toEqual([
        'COVER_NOT_OUTLET',
      ]);
      expect(await errorsFor(c, GH, 'NO_SUCH_ROLE', 'covered_by', 'COOK')).toEqual([
        'INVALID_JOB_ROLE',
      ]);
      expect(await errorsFor(c, GH, 'STORE_KEEPER', 'covered_by', null)).toEqual([
        'INVALID_JOB_ROLE',
      ]);
      expect(await errorsFor(c, GH, 'STORE_KEEPER', 'sometimes', 'COOK')).toEqual(['INVALID_MODE']);
      expect(await errorsFor(c, GH, 'STORE_KEEPER', 'not_done', 'COOK')).toEqual(['INVALID_MODE']);
      // never above the outlet, never account administration
      expect(await errorsFor(c, GH, 'AREA_MANAGER', 'covered_by', 'GENERAL_MANAGER')).toEqual([
        'COVER_ABOVE_OUTLET',
      ]);
      expect(
        new Set(await errorsFor(c, GH, 'ACCOUNT_OWNER', 'covered_by', 'GENERAL_MANAGER')),
      ).toEqual(new Set(['COVER_ABOVE_OUTLET', 'COVER_ADMIN']));
      // the covered role's duties must work there: Bar 3.0 has no main store
      expect(await errorsFor(c, BAR, 'STORE_KEEPER', 'covered_by', 'BAR_MANAGER')).toEqual([
        'JOB_ROLE_SCOPE',
      ]);
    });
  });

  it('refuses chains: a covering role is one the outlet has', async () => {
    await fresh(async (c) => {
      await cover(c, GH, 'STORE_KEEPER', 'FRONT_DESK_EXECUTIVE');
      expect(await errorsFor(c, GH, 'FRONT_DESK_EXECUTIVE', 'covered_by', 'COOK')).toEqual([
        'COVER_CHAIN',
      ]);
      expect(await errorsFor(c, GH, 'CASHIER', 'covered_by', 'STORE_KEEPER')).toEqual([
        'COVER_CHAIN',
      ]);
      // one live cover per outlet and role
      await expect(
        c.query(
          `insert into hr.role_cover (tenant_id, org_node_id, job_role_code, mode)
           values ($1, $2, 'STORE_KEEPER', 'not_done')`,
          [ids.tenant(), ids.node(GH)],
        ),
      ).rejects.toThrow(/role_cover_live/);
    });
  });
});

describe('cover from the app', () => {
  it('a user admin reads their outlets’ covers; staff see none; nobody writes them', async () => {
    await fresh(async (c) => {
      await cover(c, GH, 'STORE_KEEPER', 'FRONT_DESK_EXECUTIVE');
      const read = async (u: string) =>
        (
          await attemptAs<{ n: number }>(
            c,
            ids.user(u),
            `select count(*)::int n from hr.role_cover where archived_at is null`,
          )
        ).rows?.[0]?.n;
      // whoever administers users there (2.0's front desk, the Account Owner); not 1.0's GM
      expect(await read('test.front-desk-executive.2.0')).toBe(1);
      expect(await read('test.account-owner')).toBe(1);
      expect(await read('test.general-manager.1.0')).toBe(0);
      expect(await read('test.cook.2.0')).toBe(0);
      const owner = ids.user('test.account-owner');
      for (const sql of [
        `insert into hr.role_cover (tenant_id, org_node_id, job_role_code, mode)
         values ('${ids.tenant()}', '${ids.node(GH)}', 'CASHIER', 'not_done')`,
        `update hr.role_cover set covered_by_role = 'COOK'`,
        `delete from hr.role_cover`,
        `select core.apply_cover_access('${ids.node(GH)}')`,
        `select * from core.role_cover_errors('${ids.tenant()}', '${ids.node(GH)}', 'COOK', 'not_done', null)`,
      ]) {
        const r = await attemptAs(c, owner, sql);
        expect(r.error, sql).toMatch(/permission denied/);
      }
    });
  });
});

// A time with no shifts or punches in the test data, so who is on duty is set here.
const T = '2031-03-03T06:00:00Z';

async function newTask(c: pg.PoolClient, node: string, role: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into ops.task (tenant_id, org_node_id, kind, title, due_at, assign_mode, job_role_code)
     values ($1, $2, 'one_off', 'Covered job', $3, 'job_role', $4) returning id`,
    [ids.tenant(), ids.node(node), T, role],
  );
  return rows[0]!.id;
}

async function clockIn(c: pg.PoolClient, username: string, out?: string): Promise<void> {
  await c.query(
    `insert into hr.attendance (tenant_id, worker_id, owner_user_id, org_node_id, clock_in_at,
                                clock_out_at, in_source, out_source, in_key, out_key)
     select w.tenant_id, w.id, w.owner_user_id, w.org_node_id, $2::timestamptz - interval '1 hour',
            $3, 'online', case when $3::timestamptz is null then null else 'online' end,
            'cover-test-' || $2, case when $3::timestamptz is null then null else 'cover-out' end
       from hr.worker w where w.owner_user_id = $1`,
    [ids.user(username), T, out ?? null],
  );
}

async function assignee(c: pg.PoolClient, task: string): Promise<string | null> {
  const { rows } = await c.query<{ u: string | null }>(
    `select u.username u from ops.task t left join core.app_user u on u.id = t.assignee_user_id
      where t.id = $1`,
    [task],
  );
  return rows[0]!.u;
}

const tick = (c: pg.PoolClient, at = T) => c.query('select * from ops.tasks_tick($1)', [at]);

describe('covered tasks', () => {
  it('are in the covering role’s pool at that outlet only; a task may be given to the role', async () => {
    await fresh(async (c) => {
      await cover(c, BAR, 'HOUSEKEEPING_SUPERVISOR', 'BARTENDER');
      const here = await newTask(c, BAR, 'HOUSEKEEPING_SUPERVISOR');
      const there = await newTask(c, 'TEST-HOTEL-1.0', 'HOUSEKEEPING_SUPERVISOR');
      const pool = async (task: string, u: string) =>
        (
          await c.query<{ ok: boolean }>(
            `select ops.in_pool(t, $2) ok from ops.task t where t.id = $1`,
            [task, ids.user(u)],
          )
        ).rows[0]!.ok;
      expect(await pool(here, 'test.bartender.3.0')).toBe(true);
      expect(await pool(here, 'test.server.3.0')).toBe(false);
      expect(await pool(there, 'test.bartender.3.0')).toBe(false);
      // their task list says whose work it is
      const mine = await attemptAs<{ id: string; covering: string | null }>(
        c,
        ids.user('test.bartender.3.0'),
        `select id, covering from ops.my_tasks()`,
      );
      expect(mine.rows?.find((t) => t.id === here)?.covering).toBe('Housekeeping Supervisor');
      expect(mine.rows?.filter((t) => t.id !== here).every((t) => t.covering === null)).toBe(true);
      // the task may be given to a role nobody holds there but someone covers
      await expect(
        c.query(
          `select ops.check_assign($1, '{"mode":"job_role","role":"HOUSEKEEPING_SUPERVISOR"}')`,
          [ids.node(BAR)],
        ),
      ).resolves.toBeDefined();
    });
  });

  it('go to one person on duty: fewest open tasks, then round robin', async () => {
    await fresh(async (c) => {
      await cover(c, BAR, 'HOUSEKEEPING_SUPERVISOR', 'BARTENDER');
      const servers = ['test.bartender.3.0', 'test.bartender-b.3.0'];
      // start both with nothing open
      await c.query(
        `update ops.task set status = 'cancelled'
          where assignee_user_id = any ($1) and status in ('open', 'in_progress')`,
        [servers.map((s) => ids.user(s))],
      );
      for (const s of servers) await clockIn(c, s);
      const [first, second] = [...servers].sort((a, b) => ids.user(a).localeCompare(ids.user(b)));
      const t1 = await newTask(c, BAR, 'HOUSEKEEPING_SUPERVISOR');
      await tick(c);
      expect(await assignee(c, t1)).toBe(first);
      const t2 = await newTask(c, BAR, 'HOUSEKEEPING_SUPERVISOR');
      await tick(c);
      expect(await assignee(c, t2)).toBe(second); // fewer open tasks
      await c.query(`update ops.task set status = 'done' where id = any ($1)`, [[t1, t2]]);
      const t3 = await newTask(c, BAR, 'HOUSEKEEPING_SUPERVISOR');
      await tick(c);
      expect(await assignee(c, t3)).toBe(first); // a tie: given one longest ago
      // it says why it came to them
      const { rows } = await c.query<{ body: string }>(
        `select body from ops.notification
          where owner_user_id = $1 and kind = 'task_assigned' order by created_at desc limit 1`,
        [ids.user(first!)],
      );
      expect(rows[0]?.body).toBe("Housekeeping Supervisor's work (you're covering)");
    });
  });

  it('stay in the pool while nobody is on duty, then go to whoever clocks in', async () => {
    await fresh(async (c) => {
      await cover(c, BAR, 'HOUSEKEEPING_SUPERVISOR', 'BARTENDER');
      const t = await newTask(c, BAR, 'HOUSEKEEPING_SUPERVISOR');
      await tick(c);
      expect(await assignee(c, t)).toBeNull();
      await clockIn(c, 'test.bartender-b.3.0');
      await tick(c);
      expect(await assignee(c, t)).toBe('test.bartender-b.3.0');
    });
  });

  it('move to someone else on duty if the person goes off duty before starting', async () => {
    await fresh(async (c) => {
      await cover(c, BAR, 'HOUSEKEEPING_SUPERVISOR', 'BARTENDER');
      await clockIn(c, 'test.bartender.3.0');
      const t = await newTask(c, BAR, 'HOUSEKEEPING_SUPERVISOR');
      await tick(c);
      expect(await assignee(c, t)).toBe('test.bartender.3.0');
      await c.query(
        `update hr.attendance set clock_out_at = $2, out_source = 'online', out_key = 'cover-out'
          where owner_user_id = $1 and in_key like 'cover-test-%'`,
        [ids.user('test.bartender.3.0'), '2031-03-03T05:30:00Z'],
      );
      await tick(c); // nobody else on duty: it stays with them
      expect(await assignee(c, t)).toBe('test.bartender.3.0');
      await clockIn(c, 'test.bartender-b.3.0');
      await tick(c);
      expect(await assignee(c, t)).toBe('test.bartender-b.3.0');
    });
  });

  it('a role the outlet has keeps its pool: its tasks are not given out', async () => {
    await fresh(async (c) => {
      await clockIn(c, 'test.server.3.0');
      const t = await newTask(c, BAR, 'SERVER');
      await tick(c);
      expect(await assignee(c, t)).toBeNull();
    });
  });
});

describe('not done', () => {
  it('a role not done at an outlet has no checklist rounds there; elsewhere it still does', async () => {
    await fresh(async (c) => {
      const rounds = async (node: string) =>
        (
          await c.query<{ n: number }>(
            `select count(*)::int n from ops.task t join ops.checklist_template c on c.id = t.template_id
              where c.org_node_id = $1 and c.assign ->> 'role' in ('COOK', 'BARTENDER')
                and t.due_at > $2::timestamptz - interval '1 hour'`,
            [ids.node(node), T],
          )
        ).rows[0]!.n;
      await cover(c, BAR, 'COOK', null);
      await tick(c);
      expect(await rounds(`${BAR}-KITCHEN`)).toBe(0);
      expect(await rounds(`${BAR}-BAR`)).toBeGreaterThan(0);
      // the same role at another customer's outlet still gets its rounds
      expect(await rounds('TEST-SOLO-BAR-KITCHEN')).toBeGreaterThan(0);
    });
  });
});
