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
    });
  });
});
