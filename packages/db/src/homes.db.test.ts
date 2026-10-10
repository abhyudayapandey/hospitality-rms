import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Homes that show the job (ADR 113): breakfast is read by those who serve it, not the bar;
// an event says how many of the people it needs are rostered.

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

describe('breakfast is read by those who serve it (ADR 113)', () => {
  it('the kitchen and the restaurant read it; the bar does not', async () => {
    await inRolledBackTx(async (c) => {
      const outlets = (who: string) =>
        run<{ name: string }>(c, who, `select name from ops.breakfast_outlets()`);
      expect(await outlets('test.commis.1.0')).toHaveLength(1);
      expect(await outlets('test.steward.1.0')).toHaveLength(1);
      expect(await outlets('test.front-desk-executive.1.0')).toHaveLength(1);
      expect(await outlets('test.bartender.1.0')).toHaveLength(0);
      expect(await outlets('test.bar-back.1.0')).toHaveLength(0);
    });
  });
});

describe("an event's people (ADR 113)", () => {
  const WEDDING = `select id from ops.event where name = 'Test Wedding Reception'`;

  it('needed per job role, and rostered once a shift of that role overlaps it', async () => {
    await inRolledBackTx(async (c) => {
      const event = (await c.query<{ id: string }>(WEDDING)).rows[0]!.id;
      const staffing = () =>
        run<{ role_code: string; needed: number; rostered: number }>(
          c,
          'test.banquet-manager.1.0',
          `select * from ops.event_staffing($1)`,
          [event],
        );
      const before = await staffing();
      expect(before.length).toBeGreaterThan(0);
      for (const r of before) expect(r.needed).toBeGreaterThan(0);

      // roster one person of the first role, across the time the event needs them
      await c.query('reset role');
      const need = (
        await c.query<{ role_code: string; starts_at: Date; ends_at: Date; node: string }>(
          `select q.role_code, q.starts_at, q.ends_at, q.org_node_id as node
             from ops.event_requirement q
            where q.event_id = $1 and q.kind = 'role' and q.role_code = $2
            order by q.starts_at limit 1`,
          [event, before[0]!.role_code],
        )
      ).rows[0]!;
      const worker = (
        await c.query<{ id: string; user_id: string; node: string }>(
          `select w.id, w.owner_user_id as user_id, w.org_node_id as node from hr.worker w
            where w.tenant_id = $1 and w.role_code = $2 and w.status = 'active'
              and w.org_node_id in (select id from core.hierarchy_node
                                     where code like 'TEST-HOTEL-1.0%')
            limit 1`,
          [ids.tenant(), need.role_code],
        )
      ).rows[0];
      expect(worker, need.role_code).toBeDefined();
      if (worker) {
        const shift = (
          await c.query<{ id: string }>(
            `insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at,
                                   role_code, headcount, status)
             values ($1, $2, ($3::timestamptz at time zone 'Asia/Kolkata')::date, $3, $4, $5, 1,
                     'published')
             returning id`,
            [ids.tenant(), worker.node, need.starts_at, need.ends_at, need.role_code],
          )
        ).rows[0]!.id;
        await c.query(
          `insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id,
                                            org_node_id, start_at, end_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            ids.tenant(),
            shift,
            worker.id,
            worker.user_id,
            worker.node,
            need.starts_at,
            need.ends_at,
          ],
        );
        const after = await staffing();
        const was = before.find((r) => r.role_code === need.role_code)!.rostered;
        expect(after.find((r) => r.role_code === need.role_code)!.rostered).toBe(was + 1);
      }
    });
  });

  it('only for those who see the event', async () => {
    await inRolledBackTx(async (c) => {
      const event = (await c.query<{ id: string }>(WEDDING)).rows[0]!.id;
      const other = await attemptAs(
        c,
        ids.user('test.solo.bar-manager'),
        `select * from ops.event_staffing($1)`,
        [event],
      );
      expect(other.error).toMatch(/NOT_AUTHORISED/);

      // in the event's own company: whoever reads the event under RLS reads its people, and
      // nobody else does
      const users = (
        await c.query<{ id: string; username: string }>(
          `select id, username from core.app_user where tenant_id = $1 and status = 'active'`,
          [ids.tenant()],
        )
      ).rows;
      let seen = 0;
      let hidden = 0;
      for (const u of users) {
        const sees = await attemptAs<{ n: number }>(
          c,
          u.id,
          `select count(*)::int as n from ops.event where id = $1`,
          [event],
        );
        const r = await attemptAs(c, u.id, `select * from ops.event_staffing($1)`, [event]);
        if (sees.rows?.[0]?.n === 1) {
          seen++;
          expect(r.error, u.username).toBeUndefined();
        } else {
          hidden++;
          expect(r.error, u.username).toMatch(/NOT_AUTHORISED/);
        }
      }
      expect(seen).toBeGreaterThan(0);
      expect(hidden).toBeGreaterThan(0);
    });
  });
});

describe('who is on shift here today (ADR 113)', () => {
  const KITCHEN = 'TEST-HOTEL-1.0-KITCHEN';

  it('those rostered today, for whoever gives out tasks there; nobody else may ask', async () => {
    await inRolledBackTx(async (c) => {
      const w = (
        await c.query<{ id: string; user_id: string; role_code: string }>(
          `select id, owner_user_id as user_id, role_code from hr.worker
            where org_node_id = $1 and status = 'active'
              and owner_user_id = $2`,
          [ids.node(KITCHEN), ids.user('test.commis-b.1.0')],
        )
      ).rows[0]!;
      const on = () =>
        run<{ id: string }>(
          c,
          'test.executive-chef.1.0',
          `select x::text as id from ops.on_shift_today($1) x`,
          [ids.node(KITCHEN)],
        );
      await c.query(
        `delete from hr.shift_assignment a using hr.shift s
          where s.id = a.shift_id and a.owner_user_id = $1
            and s.local_date = rpt.business_date(now(), ops.tz_of($2))`,
        [w.user_id, ids.node(KITCHEN)],
      );
      expect((await on()).map((r) => r.id)).not.toContain(w.user_id);
      const shift = (
        await c.query<{ id: string }>(
          `insert into hr.shift (tenant_id, org_node_id, local_date, start_at, end_at, role_code,
                                 headcount, status)
           values ($1, $2, rpt.business_date(now(), ops.tz_of($2)), now(), now() + interval '6 hours',
                   $3, 1, 'published')
           returning id`,
          [ids.tenant(), ids.node(KITCHEN), w.role_code],
        )
      ).rows[0]!.id;
      await c.query(
        `insert into hr.shift_assignment (tenant_id, shift_id, worker_id, owner_user_id,
                                          org_node_id, start_at, end_at)
         select $1, s.id, $3, $4, s.org_node_id, s.start_at, s.end_at from hr.shift s
          where s.id = $2`,
        [ids.tenant(), shift, w.id, w.user_id],
      );
      expect((await on()).map((r) => r.id)).toContain(w.user_id);
      const commis = await attemptAs(
        c,
        ids.user('test.commis.1.0'),
        `select * from ops.on_shift_today($1)`,
        [ids.node(KITCHEN)],
      );
      expect(commis.error).toMatch(/NOT_AUTHORISED/);
    });
  });
});
