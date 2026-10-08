import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Top of chain (ADR 010): an account owner's own request, at a step nobody else could
// approve, is approved at once and recorded; anyone else still gets NO_APPROVER. The sole
// owner's grants carry their marker into the access audit.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const OWNER = 'test.solo.bar-manager';

async function as<T extends object>(c: PoolClient, who: string, sql: string, params: unknown[]) {
  const r = await attemptAs<T>(c, ids.user(who), sql, params);
  if (r.error !== undefined) throw new Error(`${who}: ${r.error}`);
  return r.rows[0]!;
}

async function requestLeave(c: PoolClient, who: string) {
  const type = (
    await c.query<{ id: string }>(
      `select t.id from hr.leave_type t join core.tenant te on te.id = t.tenant_id
        where te.code = 'TEST-SOLO-COMPANY' and t.code = 'UNPAID_LEAVE'`,
    )
  ).rows[0]!.id;
  return attemptAs<{ id: string }>(
    c,
    ids.user(who),
    'select hr.request_leave($1, current_date + 60, current_date + 60) as id',
    [type],
  );
}

interface Step {
  step: string;
  state: string;
  skip_reason: string | null;
  top_of_chain: boolean;
  comment: string | null;
  actor: string | null;
}

async function steps(c: PoolClient, request: string): Promise<Step[]> {
  const { rows } = await c.query<Step>(
    `select s.step, s.state, s.skip_reason, s.top_of_chain, s.comment, u.username as actor
       from wf.step_instance s left join core.app_user u on u.id = s.actor_id
      where s.request_id = $1 order by s.seq`,
    [request],
  );
  return rows;
}

describe('the sole owner’s own requests', () => {
  it('their leave is approved at the top of the chain, and says so', async () => {
    await inRolledBackTx(async (c) => {
      const r = await requestLeave(c, OWNER);
      expect(r.error).toBeUndefined();
      const leave = r.rows![0]!.id;
      const req = (
        await c.query<{ id: string; state: string }>(
          `select q.id, q.state from wf.request q join hr.leave_request l on l.wf_request_id = q.id
            where l.id = $1`,
          [leave],
        )
      ).rows[0]!;
      expect(req.state).toBe('approved');
      const top = {
        state: 'approved',
        skip_reason: null,
        top_of_chain: true,
        comment: 'top of chain: no higher approver',
        actor: OWNER,
      };
      expect(await steps(c, req.id)).toEqual([
        { step: 'manager_approval', ...top },
        { step: 'gm_approval', ...top },
      ]);
      // in the access audit, with the note
      const audit = await attemptAs<{ action: string; person: string; note: string }>(
        c,
        ids.user(OWNER),
        `select action, person, note from core.access_audit(50)
          where action = 'approved at the top of the chain'`,
      );
      expect(audit.rows).toContainEqual({
        action: 'approved at the top of the chain',
        person: 'Test Bar Manager',
        note: 'top of chain: no higher approver (LEAVE manager_approval)',
      });
      // and in the owner's decisions (the request history)
      const mine = await attemptAs<{ request_id: string; decision: string }>(
        c,
        ids.user(OWNER),
        'select request_id, decision from wf.my_decisions()',
      );
      expect(mine.rows).toContainEqual({ request_id: req.id, decision: 'approved' });
    });
  });

  it('anyone else with no approver left still gets NO_APPROVER', async () => {
    await inRolledBackTx(async (c) => {
      // without the owner, the cook's HR step has nobody
      await c.query('alter table core.role_assignment disable trigger last_account_owner');
      await c.query(
        `update core.role_assignment set effective_from = date '2020-01-01',
                effective_to = date '2020-12-31' where user_id = $1`,
        [ids.user(OWNER)],
      );
      expect((await requestLeave(c, 'test.solo.cook')).error).toBe('NO_APPROVER');
    });
  });

  it('a step done through its module waits for the owner to do it themselves', async () => {
    await inRolledBackTx(async (c) => {
      // the owner alone, keeping the kitchen store themselves
      await c.query(
        `delete from core.role_assignment ra using core.app_user u
          where u.id = ra.user_id and u.tenant_id = $1 and u.id <> $2`,
        [ids.tenant('TEST-SOLO-COMPANY'), ids.user(OWNER)],
      );
      await c.query(
        `insert into core.role_assignment (tenant_id, user_id, group_id, node_id)
         select $1, $2, id, $3 from core.security_group where tenant_id = $1 and code = 'STORE_KEEPER'`,
        [ids.tenant('TEST-SOLO-COMPANY'), ids.user(OWNER), ids.node('TEST-SOLO-BAR-KITCHEN-STORE')],
      );
      const lemons = (
        await c.query<{ id: string }>(
          `select i.id from inv.item i join core.tenant t on t.id = i.tenant_id
            where t.code = 'TEST-SOLO-COMPANY' and i.sku = 'LEMONS'`,
        )
      ).rows[0]!.id;
      await c.query(
        `insert into inv.stock_ledger (tenant_id, item_id, delivery_node_id, movement_type, qty,
                                       unit_cost, ref_type)
         select tenant_id, $1, $2, 'receipt', 10, 5, 'test' from inv.item where id = $1`,
        [lemons, ids.node('TEST-SOLO-BAR-BAR-STORE')],
      );
      const { id: t } = await as<{ id: string }>(
        c,
        OWNER,
        'select inv.request_transfer($1, $2, $3::jsonb) as id',
        [
          ids.node('TEST-SOLO-BAR-BAR-STORE'),
          ids.node('TEST-SOLO-BAR-KITCHEN-STORE'),
          JSON.stringify([{ item_id: lemons, qty: 2 }]),
        ],
      );
      const req = (
        await c.query<{ r: string }>('select wf_request_id r from inv.transfer where id = $1', [t])
      ).rows[0]!.r;
      expect((await steps(c, req)).map((s) => [s.step, s.state, s.top_of_chain])).toEqual([
        // lemons are a menu ingredient here in a usual quantity: no approval (TR-3, ADR 044)
        ['approval', 'skipped', false],
        ['dispatch', 'pending', true],
        ['receipt', 'waiting', true],
      ]);
      expect(
        (await as<{ s: string }>(c, OWNER, 'select inv.dispatch_transfer($1) as s', [t])).s,
      ).toBe('in_approval');
      expect(
        (await as<{ s: string }>(c, OWNER, 'select inv.receive_transfer($1) as s', [t])).s,
      ).toBe('approved');
    });
  });
});

describe('the sole-owner marker', () => {
  it('shows in the access audit on grants that applied without approval', async () => {
    await inRolledBackTx(async (c) => {
      await as(c, OWNER, `select core.grant_access($1, 'OUTLET_MANAGER', $2) as r`, [
        ids.user('test.solo.floor-manager'),
        ids.node('TEST-SOLO-BAR'),
      ]);
      const audit = await attemptAs<{ action: string; person: string; note: string | null }>(
        c,
        ids.user(OWNER),
        `select action, person, note from core.access_audit(20) where action = 'granted'`,
      );
      expect(audit.rows).toContainEqual({
        action: 'granted',
        person: 'Test Floor Manager',
        note: 'sole account owner: no one else can approve',
      });
    });
  });

  it('is_sole_account_owner: true for the only owner, false once there is a second', async () => {
    await inRolledBackTx(async (c) => {
      const sole = async () =>
        (await as<{ s: boolean }>(c, OWNER, 'select core.is_sole_account_owner() as s', [])).s;
      expect(await sole()).toBe(true);
      await c.query(
        `insert into core.role_assignment (tenant_id, user_id, group_id, node_id)
         select $1, $2, id, $3 from core.security_group where tenant_id = $1 and code = 'ACCOUNT_OWNER'`,
        [
          ids.tenant('TEST-SOLO-COMPANY'),
          ids.user('test.solo.floor-manager'),
          ids.node('TEST-SOLO-COMPANY'),
        ],
      );
      expect(await sole()).toBe(false);
      // with a second owner, the first one's leave goes to them, not the top of the chain
      const r = await requestLeave(c, OWNER);
      const top = await c.query<{ n: number }>(
        `select count(*)::int n from wf.step_instance s join hr.leave_request l
            on l.wf_request_id = s.request_id where l.id = $1 and s.top_of_chain`,
        [r.rows![0]!.id],
      );
      expect(top.rows[0]!.n).toBe(0);
    });
  });
});
