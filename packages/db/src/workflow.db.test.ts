import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  sqlState,
  actAs,
  resetRole,
  type Attempt,
  type SeedIds,
} from '../test/helpers';

// Workflow engine (LLD section 4, ADR 003) against the seeded users, process
// definitions and bp_policy. Every test runs in a rolled-back migrator transaction and
// calls the RPCs as app_rw acting as the named user.

const KIM = 'Kim Storekeeper';
const OLIVIA = 'Olivia Outlet Manager';
const ARIA = 'Aria Area Manager';
const HUGO = 'Hugo Hub Manager';
const HARPER = 'Harper HR Admin';
const SAM = 'Sam Staff';
const CASEY = 'Casey Chef';
const AGENT = 'Outlet Ops AI Agent';

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

interface SubmitArgs {
  process: string;
  subject: string;
  amount?: number;
  payload?: Record<string, unknown>;
  org?: string;
  delivery?: string;
  key?: string;
}

function submit(c: PoolClient, who: string, a: SubmitArgs): Promise<Attempt<{ id: string }>> {
  return attemptAs<{ id: string }>(
    c,
    ids.user(who),
    `select wf.submit($1, $2, core.uuid_v7(), $3::jsonb, $4, 'INR', $5, $6, $7) as id`,
    [
      a.process,
      a.subject,
      JSON.stringify(a.payload ?? {}),
      a.amount ?? null,
      a.org ? ids.node(`org:${a.org}`) : null,
      a.delivery ? ids.node(`delivery:${a.delivery}`) : null,
      a.key ?? null,
    ],
  );
}

const po = (amount: number, key?: string): SubmitArgs => ({
  process: 'PURCHASE_ORDER',
  subject: 'inv.purchase_order',
  amount,
  delivery: 'Outlet A',
  ...(key ? { key } : {}),
});

async function submitOk(c: PoolClient, who: string, a: SubmitArgs): Promise<string> {
  const r = await submit(c, who, a);
  if (r.error !== undefined) throw new Error(`submit failed: ${r.error}`);
  return r.rows[0]!.id;
}

function act(c: PoolClient, who: string, id: string, action: string) {
  return attemptAs<{ state: string }>(c, ids.user(who), 'select wf.act($1, $2) as state', [
    id,
    action,
  ]);
}

async function actOk(c: PoolClient, who: string, id: string, action: string): Promise<string> {
  const r = await act(c, who, id, action);
  if (r.error !== undefined) throw new Error(`act failed: ${r.error}`);
  return r.rows[0]!.state;
}

async function request(c: PoolClient, id: string) {
  const { rows } = await c.query<{
    state: string;
    current_step: string | null;
    domain_code: string;
  }>('select state, current_step, domain_code from wf.request where id = $1', [id]);
  return rows[0]!;
}

async function steps(c: PoolClient, id: string) {
  const { rows } = await c.query<{
    step: string;
    state: string;
    scope: string | null;
    grp: string;
  }>(
    `select s.step, s.state, n.type || ':' || n.name as scope, g.code as grp
       from wf.step_instance s
       join core.security_group g on g.id = s.assignee_group_id
       left join core.hierarchy_node n on n.id = s.scope_node_id
      where s.request_id = $1 order by s.seq`,
    [id],
  );
  return rows;
}

async function outbox(c: PoolClient, id: string) {
  const { rows } = await c.query<{ handler: string; status: string }>(
    'select handler, status from wf.outbox where request_id = $1 order by handler',
    [id],
  );
  return rows;
}

async function inbox(c: PoolClient, who: string): Promise<string[]> {
  const r = await attemptAs<{ request_id: string }>(
    c,
    ids.user(who),
    'select request_id from wf.my_inbox()',
  );
  if (r.error !== undefined) throw new Error(r.error);
  return r.rows.map((x) => x.request_id);
}

/** Gives `who` an extra assignment inside the rolled-back transaction. */
async function assign(
  c: PoolClient,
  who: string,
  group: string,
  node: `${'org' | 'delivery'}:${string}`,
) {
  await c.query(
    `insert into core.role_assignment (tenant_id, user_id, group_id, node_id, effective_from)
     select g.tenant_id, $1, g.id, $3, date '2026-01-01' from core.security_group g where g.code = $2`,
    [ids.user(who), group, ids.node(node)],
  );
}

describe('purchase order routing', () => {
  it('happy path: outlet approval only, area step recorded as skipped', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, KIM, po(10_000));
      expect(await request(c, id)).toEqual({
        state: 'in_approval',
        current_step: 'outlet_approval',
        domain_code: 'PURCHASE_ORDERS', // from wf.process_def, never from input
      });
      expect(await steps(c, id)).toEqual([
        {
          step: 'outlet_approval',
          state: 'pending',
          scope: 'delivery:Outlet A',
          grp: 'OUTLET_MANAGER',
        },
        { step: 'area_approval', state: 'skipped', scope: null, grp: 'AREA_MANAGER' },
      ]);
      expect(await inbox(c, OLIVIA)).toContain(id);
      expect(await actOk(c, OLIVIA, id, 'approve')).toBe('approved');
      expect(await outbox(c, id)).toEqual([{ handler: 'inv.po.release', status: 'pending' }]);
    });
  });

  it('adds the area step above the threshold and routes it across trees to the Area manager', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, KIM, po(60_000));
      expect(await steps(c, id)).toEqual([
        {
          step: 'outlet_approval',
          state: 'pending',
          scope: 'delivery:Outlet A',
          grp: 'OUTLET_MANAGER',
        },
        { step: 'area_approval', state: 'waiting', scope: 'org:Area', grp: 'AREA_MANAGER' },
      ]);
      expect(await inbox(c, ARIA)).not.toContain(id); // not active yet
      expect(await actOk(c, OLIVIA, id, 'approve')).toBe('in_approval');
      expect((await request(c, id)).current_step).toBe('area_approval');
      expect(await inbox(c, ARIA)).toContain(id);
      expect((await act(c, OLIVIA, id, 'approve')).error).toBe('NOT_AUTHORISED');
      expect(await actOk(c, ARIA, id, 'approve')).toBe('approved');
      expect(await outbox(c, id)).toEqual([{ handler: 'inv.po.release', status: 'pending' }]);
    });
  });

  it('rejection ends the request and queues the reject handler', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, KIM, po(60_000));
      expect(await actOk(c, OLIVIA, id, 'reject')).toBe('rejected');
      expect((await steps(c, id)).map((s) => s.state)).toEqual(['rejected', 'cancelled']);
      expect(await outbox(c, id)).toEqual([{ handler: 'inv.po.reject', status: 'pending' }]);
      expect((await act(c, ARIA, id, 'approve')).error).toBe('INVALID_STATE');
    });
  });

  it('only the initiator can cancel, and only while in approval', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, KIM, po(10_000));
      expect((await act(c, OLIVIA, id, 'cancel')).error).toBe('NOT_AUTHORISED');
      expect(await actOk(c, KIM, id, 'cancel')).toBe('cancelled');
      expect((await steps(c, id)).map((s) => s.state)).toEqual(['cancelled', 'skipped']);
      expect(await outbox(c, id)).toEqual([]);
      expect((await act(c, OLIVIA, id, 'approve')).error).toBe('INVALID_STATE');
    });
  });

  it('blocks self-approval (rule 7)', async () => {
    await inRolledBackTx(async (c) => {
      await assign(c, CASEY, 'OUTLET_MANAGER', 'delivery:Outlet A'); // a second eligible approver
      const id = await submitOk(c, OLIVIA, po(10_000));
      expect((await act(c, OLIVIA, id, 'approve')).error).toBe('SEGREGATION_OF_DUTIES');
      expect((await act(c, OLIVIA, id, 'reject')).error).toBe('SEGREGATION_OF_DUTIES');
      expect(await actOk(c, CASEY, id, 'approve')).toBe('approved');
    });
  });

  it("routes a sole outlet manager's PO to the Area manager (SoD fallback)", async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, OLIVIA, po(10_000));
      expect(await steps(c, id)).toEqual([
        { step: 'outlet_approval', state: 'pending', scope: 'org:Area', grp: 'AREA_MANAGER' },
        { step: 'area_approval', state: 'skipped', scope: null, grp: 'AREA_MANAGER' },
      ]);
      expect(await inbox(c, OLIVIA)).not.toContain(id);
      expect((await act(c, OLIVIA, id, 'approve')).error).toBe('SEGREGATION_OF_DUTIES');
      expect(await actOk(c, ARIA, id, 'approve')).toBe('approved');
    });
  });

  it('routes LEAVE and STOCK_ADJUSTMENT raised by the sole outlet manager to the Area manager', async () => {
    await inRolledBackTx(async (c) => {
      const leave = await submitOk(c, OLIVIA, {
        process: 'LEAVE',
        subject: 'hr.leave_request',
        org: 'Outlet A',
      });
      expect(await steps(c, leave)).toEqual([
        { step: 'outlet_approval', state: 'pending', scope: 'org:Area', grp: 'AREA_MANAGER' },
        { step: 'hr_approval', state: 'waiting', scope: 'org:Company', grp: 'HR_ADMIN' },
      ]);
      const adj = await submitOk(c, OLIVIA, {
        process: 'STOCK_ADJUSTMENT',
        subject: 'inv.stock_adjustment',
        amount: 6000, // above the variance threshold
        delivery: 'Outlet A',
      });
      expect(await steps(c, adj)).toEqual([
        { step: 'outlet_approval', state: 'pending', scope: 'org:Area', grp: 'AREA_MANAGER' },
      ]);
      expect(await inbox(c, ARIA)).toEqual(expect.arrayContaining([leave, adj]));
      expect(await actOk(c, ARIA, adj, 'approve')).toBe('approved');
    });
  });

  it('raises NO_APPROVER only when nobody exists up the tree', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `update core.role_assignment set effective_from = date '2020-01-01',
                effective_to = date '2020-12-31' where user_id = $1`,
        [ids.user(ARIA)],
      );
      expect((await submit(c, OLIVIA, po(10_000))).error).toBe('NO_APPROVER');
      const { rows } = await c.query('select 1 from wf.request');
      expect(rows).toEqual([]);
      // Kim still routes normally to Olivia.
      await submitOk(c, KIM, po(10_000));
    });
  });

  it('is idempotent per (tenant, initiator, key)', async () => {
    await inRolledBackTx(async (c) => {
      const a = await submitOk(c, KIM, po(10_000, 'k-1'));
      expect(await submitOk(c, KIM, po(99_999, 'k-1'))).toBe(a);
      const b = await submitOk(c, AGENT, po(10_000, 'k-1'));
      expect(b).not.toBe(a);
      expect(await submitOk(c, KIM, po(10_000, 'k-2'))).not.toBe(a);
    });
  });

  it('skips straight to approved when every step is skipped', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, OLIVIA, {
        process: 'STOCK_ADJUSTMENT',
        subject: 'inv.stock_adjustment',
        amount: 100, // below the variance threshold
        delivery: 'Outlet A',
      });
      expect((await request(c, id)).state).toBe('approved');
      expect((await steps(c, id)).map((s) => s.state)).toEqual(['skipped']);
      expect(await outbox(c, id)).toEqual([
        { handler: 'inv.stock_adjustment.post', status: 'pending' },
      ]);
    });
  });
});

describe('initiation rights', () => {
  it('lets the AI agent submit a PO (service user: view + bp_policy) but never act', async () => {
    await inRolledBackTx(async (c) => {
      const own = await submitOk(c, AGENT, po(10_000));
      expect((await request(c, own)).state).toBe('in_approval');
      expect((await act(c, AGENT, own, 'approve')).error).toBe('SEGREGATION_OF_DUTIES');
      const kims = await submitOk(c, KIM, po(10_000));
      expect((await act(c, AGENT, kims, 'approve')).error).toBe('NOT_AUTHORISED');
      expect(await inbox(c, AGENT)).toEqual([]);
      expect(
        (await submit(c, AGENT, { process: 'LEAVE', subject: 'hr.leave_request', org: 'Outlet A' }))
          .error,
      ).toBe('NOT_AUTHORISED');
    });
  });

  it('requires modify on the subject domain for humans', async () => {
    await inRolledBackTx(async (c) => {
      // Give CHEF the bp_policy right; the chef still lacks PURCHASE_ORDERS modify.
      await c.query(
        `insert into core.bp_policy (tenant_id, process_type, step, group_id, action)
         select tenant_id, 'PURCHASE_ORDER', '*', id, 'initiate' from core.security_group
          where code = 'CHEF'`,
      );
      expect((await submit(c, CASEY, po(10_000))).error).toBe('NOT_AUTHORISED');
    });
  });

  it('rejects unknown processes, wrong subject types and missing nodes', async () => {
    await inRolledBackTx(async (c) => {
      expect((await submit(c, KIM, { ...po(1), process: 'NOPE' })).error).toBe('UNKNOWN_PROCESS');
      expect((await submit(c, KIM, { ...po(1), subject: 'inv.transfer' })).error).toBe(
        'INVALID_SUBJECT',
      );
      expect(
        (await submit(c, KIM, { process: 'PURCHASE_ORDER', subject: 'inv.purchase_order' })).error,
      ).toBe('INVALID_SUBJECT');
    });
  });
});

describe('two-sided transfer', () => {
  const transfer = (): SubmitArgs => ({
    process: 'TRANSFER',
    subject: 'inv.transfer',
    delivery: 'Outlet A',
    payload: { from_node_id: ids.node('delivery:Hub'), to_node_id: ids.node('delivery:Outlet A') },
  });

  it('scopes dispatch to the hub and receipt to the outlet; each side acts only on its step', async () => {
    await inRolledBackTx(async (c) => {
      expect((await submit(c, OLIVIA, transfer())).error).toBe('NOT_AUTHORISED'); // not an initiator
      const id = await submitOk(c, KIM, transfer());
      expect(await steps(c, id)).toEqual([
        { step: 'dispatch', state: 'pending', scope: 'delivery:Hub', grp: 'HUB_MANAGER' },
        { step: 'receipt', state: 'waiting', scope: 'delivery:Outlet A', grp: 'OUTLET_MANAGER' },
      ]);
      expect((await act(c, OLIVIA, id, 'approve')).error).toBe('NOT_AUTHORISED');
      expect(await actOk(c, HUGO, id, 'approve')).toBe('in_approval');
      expect((await act(c, HUGO, id, 'approve')).error).toBe('NOT_AUTHORISED');
      expect(await actOk(c, OLIVIA, id, 'approve')).toBe('approved');
    });
  });
});

describe('inbox', () => {
  it('excludes requests the user initiated', async () => {
    await inRolledBackTx(async (c) => {
      await assign(c, CASEY, 'OUTLET_MANAGER', 'org:Outlet A');
      const id = await submitOk(c, OLIVIA, {
        process: 'LEAVE',
        subject: 'hr.leave_request',
        org: 'Outlet A',
      });
      expect(await inbox(c, OLIVIA)).not.toContain(id);
      expect(await inbox(c, CASEY)).toContain(id);
    });
  });
});

describe('escalation', () => {
  async function makeOverdue(c: PoolClient, id: string, hours: number) {
    await c.query(
      `update wf.step_instance set activated_at = now() - make_interval(hours => $2)
        where request_id = $1 and state = 'pending'`,
      [id, hours],
    );
  }

  it('escalates LEAVE from the outlet manager to the area manager (escalateTo)', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, SAM, {
        process: 'LEAVE',
        subject: 'hr.leave_request',
        org: 'Outlet A',
      });
      expect(await steps(c, id)).toEqual([
        { step: 'outlet_approval', state: 'pending', scope: 'org:Outlet A', grp: 'OUTLET_MANAGER' },
        { step: 'hr_approval', state: 'waiting', scope: 'org:Company', grp: 'HR_ADMIN' },
      ]);
      const none = await c.query('select * from wf.overdue_steps() where request_id = $1', [id]);
      expect(none.rows).toEqual([]);

      await makeOverdue(c, id, 49); // LEAVE SLA is 48 h
      const { rows } = await c.query<{ grp: string; node: string }>(
        `select g.code as grp, n.name as node from wf.overdue_steps() o
           join core.security_group g on g.id = o.target_group_id
           join core.hierarchy_node n on n.id = o.target_node_id
          where o.request_id = $1`,
        [id],
      );
      expect(rows).toEqual([{ grp: 'AREA_MANAGER', node: 'Area' }]);

      const escalated = await c.query<{ n: number }>('select wf.escalate_overdue() as n');
      expect(escalated.rows[0]!.n).toBe(1);
      expect((await steps(c, id))[0]).toEqual({
        step: 'outlet_approval',
        state: 'pending',
        scope: 'org:Area',
        grp: 'AREA_MANAGER',
      });
      expect(await inbox(c, OLIVIA)).not.toContain(id);
      expect(await inbox(c, ARIA)).toContain(id);
      expect(await actOk(c, ARIA, id, 'approve')).toBe('in_approval');
      expect(await inbox(c, HARPER)).toContain(id);
    });
  });

  it('keeps an overdue step pending and lists it as unroutable when no one holds the group above', async () => {
    await inRolledBackTx(async (c) => {
      // TRANSFER dispatch: HUB_MANAGER at the hub, no escalateTo, nobody above the hub.
      const id = await submitOk(c, KIM, {
        process: 'TRANSFER',
        subject: 'inv.transfer',
        delivery: 'Outlet A',
        payload: {
          from_node_id: ids.node('delivery:Hub'),
          to_node_id: ids.node('delivery:Outlet A'),
        },
      });
      await makeOverdue(c, id, 25); // TRANSFER SLA is 24 h
      const un = await c.query<{ request_id: string; step: string }>(
        'select request_id, step from wf.unroutable_steps()',
      );
      expect(un.rows).toEqual([{ request_id: id, step: 'dispatch' }]);
      const escalated = await c.query<{ n: number }>('select wf.escalate_overdue() as n');
      expect(escalated.rows[0]!.n).toBe(0);
      expect((await steps(c, id))[0]).toMatchObject({ state: 'pending', scope: 'delivery:Hub' });
      expect(await inbox(c, HUGO)).toContain(id);
    });
  });

  it('escalates an overdue PO outlet approval to the Area manager', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, KIM, po(10_000));
      await makeOverdue(c, id, 25);
      expect((await c.query<{ n: number }>('select wf.escalate_overdue() as n')).rows[0]!.n).toBe(
        1,
      );
      expect((await steps(c, id))[0]).toMatchObject({ scope: 'org:Area', grp: 'AREA_MANAGER' });
      expect(await inbox(c, ARIA)).toContain(id);
    });
  });
});

describe('wf tables under RLS', () => {
  it('app_rw cannot insert or update wf tables directly', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, KIM, po(10_000));
      await actAs(c, 'app_rw', ids.user(OLIVIA));
      for (const stmt of [
        `update wf.request set state = 'approved' where id = '${id}'`,
        `update wf.step_instance set state = 'approved' where request_id = '${id}'`,
        `insert into wf.request (tenant_id, process_type, subject_type, subject_id, domain_code,
           initiator_id, state) select tenant_id, process_type, subject_type, subject_id,
           domain_code, initiator_id, 'approved' from wf.request where id = '${id}'`,
        `insert into wf.outbox (tenant_id, request_id, handler, domain_code, initiator_id)
         select tenant_id, id, 'x', domain_code, initiator_id from wf.request where id = '${id}'`,
        `update wf.process_def set sla_hours = 1`,
        `delete from wf.request`,
      ]) {
        expect(await sqlState(c, stmt), stmt).toBe('42501');
      }
      await resetRole(c);
    });
  });

  it('shows requests and steps by the subject domain', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, KIM, po(10_000));
      const see = async (who: string) => {
        const r = await attemptAs<{ n: string }>(
          c,
          ids.user(who),
          `select (select count(*) from wf.request where id = $1)
                + (select count(*) from wf.step_instance where request_id = $1) as n`,
          [id],
        );
        return r.error ?? Number(r.rows[0]!.n);
      };
      expect(await see(KIM)).toBe(3);
      expect(await see(OLIVIA)).toBe(3);
      expect(await see(ARIA)).toBe(3); // DERIVED_PURCHASE_ORDERS
      expect(await see(HUGO)).toBe(0); // HUB_MANAGER does not descend
      expect(await see(SAM)).toBe(0);
    });
  });
});
