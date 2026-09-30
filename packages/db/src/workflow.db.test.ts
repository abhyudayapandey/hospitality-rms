import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attemptAs,
  closePools,
  inRolledBackTx,
  installSubjectFixture,
  loadSeedIds,
  sqlState,
  actAs,
  resetRole,
  type Attempt,
  type FixtureSubject,
  type SeedIds,
} from '../test/helpers';

// Workflow engine (LLD section 4, ADR 003) against the seeded users, process
// definitions and bp_policy. Every test runs in a rolled-back migrator transaction and
// calls the RPCs as app_rw acting as the named user. Subjects are stand-in rows
// (installSubjectFixture): wf.submit reads nodes and amount from the subject row, so
// the engine is tested without the module tables' own rules (inventory has its own tests).

const KIM = 'test.head-cook.3.0';
const OLIVIA = 'test.bar-manager.3.0';
const ARIA = 'test.area-manager';
const HUGO = 'test.central-kitchen-manager';
const HARPER = 'test.hr-admin';
const SAM = 'test.server.3.0';
const CASEY = 'test.cook.3.0';
const AGENT = 'ai-agent';
const FLOOR = 'test.floor-manager.3.0'; // DEPARTMENT_HEAD of Floor Service
const OWNER = 'test.account-owner';

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

interface SubmitArgs {
  process: string;
  subject: string;
  /** subject row fields (the fixture resolver returns them to wf.submit) */
  amount?: number;
  org?: string;
  delivery?: string;
  from?: string;
  to?: string;
  submittable?: boolean;
  /** caller payload */
  payload?: Record<string, unknown>;
  key?: string;
  /** submit this existing subject instead of creating one */
  subjectId?: string;
}

const SUBJECT_TYPES = [
  'inv.purchase_order',
  'inv.stock_adjustment',
  'inv.transfer',
  'hr.leave_request',
  'test.subject',
];
const fixtures = new WeakMap<PoolClient, (s: FixtureSubject) => Promise<string>>();

/** Creates the stand-in subject row for `a` (as migrator) and returns its id. */
async function subjectFor(c: PoolClient, a: SubmitArgs): Promise<string> {
  let make = fixtures.get(c);
  // Pool clients outlive each rolled-back transaction, and the fixture with it.
  const { rows } = await c.query<{ t: string | null }>(
    `select to_regclass('public.wf_test_subject')::text as t`,
  );
  if (!make || !rows[0]!.t) {
    make = await installSubjectFixture(c, SUBJECT_TYPES);
    fixtures.set(c, make);
  }
  const tenant = (
    await c.query<{ id: string }>('select tenant_id as id from core.hierarchy_node where id = $1', [
      ids.node('TEST-COMPANY'),
    ])
  ).rows[0]!.id;
  return make({
    tenant,
    org: a.org ? ids.node(a.org) : null,
    delivery: a.delivery ? ids.node(a.delivery) : null,
    from: a.from ? ids.node(a.from) : null,
    to: a.to ? ids.node(a.to) : null,
    amount: a.amount ?? null,
    submittable: a.submittable ?? true,
  });
}

async function submit(c: PoolClient, who: string, a: SubmitArgs): Promise<Attempt<{ id: string }>> {
  const subjectId = a.subjectId ?? (await subjectFor(c, a));
  return attemptAs<{ id: string }>(
    c,
    ids.user(who),
    `select wf.submit($1, $2, $3, $4::jsonb, $5) as id`,
    [a.process, a.subject, subjectId, JSON.stringify(a.payload ?? {}), a.key ?? null],
  );
}

const po = (amount: number, key?: string): SubmitArgs => ({
  process: 'PURCHASE_ORDER',
  subject: 'inv.purchase_order',
  amount,
  delivery: 'TEST-BAR-3.0-KITCHEN-STORE',
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

/** Approves the way a module RPC does (wf.act_as_module, granted here for the test only). */
async function actViaModule(c: PoolClient, who: string, id: string) {
  await c.query('grant execute on function wf.act_as_module(uuid, text, text) to app_rw');
  const step = await c.query<{ step: string }>(
    `select step from wf.step_instance where request_id = $1 and state = 'pending'`,
    [id],
  );
  return attemptAs<{ state: string }>(
    c,
    ids.user(who),
    'select wf.act_as_module($1, $2) as state',
    [id, step.rows[0]?.step ?? 'none'],
  );
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
    `select s.step, s.state, n.code as scope, g.code as grp
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
async function assign(c: PoolClient, who: string, group: string, node: string) {
  await c.query(
    `insert into core.role_assignment (tenant_id, user_id, group_id, node_id, effective_from)
     select g.tenant_id, $1, g.id, $3, date '2026-01-01' from core.security_group g
      where g.code = $2 and g.tenant_id = (select tenant_id from core.app_user where id = $1)`,
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
          scope: 'TEST-BAR-3.0-KITCHEN-STORE',
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
          scope: 'TEST-BAR-3.0-KITCHEN-STORE',
          grp: 'OUTLET_MANAGER',
        },
        { step: 'area_approval', state: 'waiting', scope: 'TEST-AREA-MUMBAI', grp: 'AREA_MANAGER' },
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
      // cancel runs onRejected too, so the subject (e.g. the PO) closes
      expect(await outbox(c, id)).toEqual([{ handler: 'inv.po.reject', status: 'pending' }]);
      expect((await act(c, OLIVIA, id, 'approve')).error).toBe('INVALID_STATE');
    });
  });

  it('blocks self-approval (rule 7)', async () => {
    await inRolledBackTx(async (c) => {
      await assign(c, CASEY, 'OUTLET_MANAGER', 'TEST-BAR-3.0-KITCHEN-STORE'); // a second eligible approver
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
        {
          step: 'outlet_approval',
          state: 'pending',
          scope: 'TEST-AREA-MUMBAI',
          grp: 'AREA_MANAGER',
        },
        { step: 'area_approval', state: 'skipped', scope: null, grp: 'AREA_MANAGER' },
      ]);
      expect(await inbox(c, OLIVIA)).not.toContain(id);
      expect((await act(c, OLIVIA, id, 'approve')).error).toBe('SEGREGATION_OF_DUTIES');
      expect(await actOk(c, ARIA, id, 'approve')).toBe('approved');
    });
  });

  it('skips a step whose approver already approved the previous step (same_approver)', async () => {
    await inRolledBackTx(async (c) => {
      // Sole outlet manager, PO over 50,000: step 1 falls back to the Area manager, who
      // is also the area_approval approver.
      const id = await submitOk(c, OLIVIA, po(60_000));
      expect(await steps(c, id)).toEqual([
        {
          step: 'outlet_approval',
          state: 'pending',
          scope: 'TEST-AREA-MUMBAI',
          grp: 'AREA_MANAGER',
        },
        { step: 'area_approval', state: 'waiting', scope: 'TEST-AREA-MUMBAI', grp: 'AREA_MANAGER' },
      ]);
      expect(await actOk(c, ARIA, id, 'approve')).toBe('approved'); // once

      const { rows } = await c.query<{
        step: string;
        state: string;
        skip_reason: string | null;
        covered_by: string | null;
      }>(
        `select s.step, s.state, s.skip_reason, c.step as covered_by
           from wf.step_instance s left join wf.step_instance c on c.id = s.covered_by_step_id
          where s.request_id = $1 order by s.seq`,
        [id],
      );
      expect(rows).toEqual([
        { step: 'outlet_approval', state: 'approved', skip_reason: null, covered_by: null },
        {
          step: 'area_approval',
          state: 'skipped',
          skip_reason: 'same_approver',
          covered_by: 'outlet_approval',
        },
      ]);

      // ...and the request completes: run the executor functions (as migrator here).
      const claimed = await c.query<{ outbox_id: string; handler: string }>(
        'select outbox_id, handler from wf.claim_next()',
      );
      expect(claimed.rows.map((r) => r.handler)).toEqual(['inv.po.release']);
      await c.query('select wf.complete_outbox($1)', [claimed.rows[0]!.outbox_id]);
      expect((await request(c, id)).state).toBe('completed');
    });
  });

  it('records condition skips with reason "condition"', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, KIM, po(10_000));
      const { rows } = await c.query<{ skip_reason: string | null }>(
        'select skip_reason from wf.step_instance where request_id = $1 order by seq',
        [id],
      );
      expect(rows.map((r) => r.skip_reason)).toEqual([null, 'condition']);
    });
  });

  it('routes LEAVE and STOCK_ADJUSTMENT raised by the sole outlet manager to the Area manager', async () => {
    await inRolledBackTx(async (c) => {
      // the Bar Manager works at the outlet itself: no department head above them
      const leave = await submitOk(c, OLIVIA, {
        process: 'LEAVE',
        subject: 'hr.leave_request',
        org: 'TEST-BAR-3.0',
      });
      expect(await steps(c, leave)).toEqual([
        {
          step: 'manager_approval',
          state: 'pending',
          scope: 'TEST-AREA-MUMBAI',
          grp: 'AREA_MANAGER',
        },
        { step: 'hr_approval', state: 'waiting', scope: 'TEST-COMPANY', grp: 'HR_ADMIN' },
      ]);
      const adj = await submitOk(c, OLIVIA, {
        process: 'STOCK_ADJUSTMENT',
        subject: 'inv.stock_adjustment',
        amount: 6000,
        delivery: 'TEST-BAR-3.0-KITCHEN-STORE',
      });
      expect(await steps(c, adj)).toEqual([
        {
          step: 'outlet_approval',
          state: 'pending',
          scope: 'TEST-AREA-MUMBAI',
          grp: 'AREA_MANAGER',
        },
      ]);
      expect(await inbox(c, ARIA)).toEqual(expect.arrayContaining([leave, adj]));
      expect(await actOk(c, ARIA, adj, 'approve')).toBe('approved');
    });
  });

  it('falls back to the account owner, and raises NO_APPROVER only when nobody exists', async () => {
    await inRolledBackTx(async (c) => {
      const end = (who: string) =>
        c.query(
          `update core.role_assignment set effective_from = date '2020-01-01',
                  effective_to = date '2020-12-31' where user_id = $1`,
          [ids.user(who)],
        );
      await end(ARIA);
      // no area manager: the account owner is the last approver of every step
      const owned = await submitOk(c, OLIVIA, po(10_000));
      expect((await steps(c, owned))[0]).toMatchObject({ state: 'pending', grp: 'ACCOUNT_OWNER' });
      expect(await inbox(c, OWNER)).toContain(owned);
      await act(c, OLIVIA, owned, 'cancel');
      await end(OWNER);
      expect((await submit(c, OLIVIA, po(10_000))).error).toBe('NO_APPROVER');
      const { rows } = await c.query(
        `select 1 from wf.request where initiator_id = $1 and state = 'in_approval'`,
        [ids.user(OLIVIA)],
      );
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
      // No MVP process is all-conditional any more; use a stand-in process.
      await c.query(
        `insert into wf.process_def (tenant_id, process_type, subject_type, domain_code,
                                     hierarchy_type, steps, on_approved, sla_hours, definition)
         select tenant_id, 'TEST_AUTO', 'test.subject', 'PURCHASE_ORDERS', 'delivery',
                '[{"step":"check","group":"OUTLET_MANAGER","scope":"subject_node",
                   "when":{"amount_gt":1000}}]', 'test.done', 24, '{}'
           from core.domain where code = 'PURCHASE_ORDERS'`,
      );
      await c.query(
        `insert into core.bp_policy (tenant_id, process_type, step, group_id, action)
         select tenant_id, 'TEST_AUTO', '*', id, 'initiate' from core.security_group
          where code = 'STORE_KEEPER'`,
      );
      const id = await submitOk(c, KIM, {
        process: 'TEST_AUTO',
        subject: 'test.subject',
        amount: 100,
        delivery: 'TEST-BAR-3.0-KITCHEN-STORE',
      });
      expect((await request(c, id)).state).toBe('approved');
      expect((await steps(c, id)).map((s) => s.state)).toEqual(['skipped']);
      expect(await outbox(c, id)).toEqual([{ handler: 'test.done', status: 'pending' }]);
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
        (
          await submit(c, AGENT, {
            process: 'LEAVE',
            subject: 'hr.leave_request',
            org: 'TEST-BAR-3.0-FLOOR-SERVICE',
          })
        ).error,
      ).toBe('NOT_AUTHORISED');
    });
  });

  it('requires modify on the subject domain for humans', async () => {
    await inRolledBackTx(async (c) => {
      // Give STOCK_USER the bp_policy right; the stock user has only PURCHASE_ORDERS view.
      await c.query(
        `insert into core.bp_policy (tenant_id, process_type, step, group_id, action)
         select tenant_id, 'PURCHASE_ORDER', '*', id, 'initiate' from core.security_group
          where code = 'STOCK_USER'`,
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

// ADR 003 "known hole", closed in ADR 006: nodes and amount come from the subject row.
describe('subject-derived nodes and amount', () => {
  it('cannot submit a subject that sits at a node the caller does not hold', async () => {
    await inRolledBackTx(async (c) => {
      // A draft at Outlet B (Kim is store keeper at Outlet A only).
      expect(
        (await submit(c, KIM, { ...po(10_000), delivery: 'TEST-GUEST-HOUSE-2.0-SUPPLY' })).error,
      ).toBe('NOT_AUTHORISED');
      // Olivia (Outlet A) cannot submit Outlet B's subject either.
      expect(
        (await submit(c, OLIVIA, { ...po(10_000), delivery: 'TEST-GUEST-HOUSE-2.0-SUPPLY' })).error,
      ).toBe('NOT_AUTHORISED');
      const { rows } = await c.query('select 1 from wf.request where delivery_node_id = $1', [
        ids.node('TEST-GUEST-HOUSE-2.0-SUPPLY'),
      ]);
      expect(rows).toEqual([]);
    });
  });

  it("records the subject row's node and amount, not anything the caller sends", async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, KIM, {
        ...po(60_000),
        payload: { amount: 1, delivery_node_id: ids.node('TEST-GUEST-HOUSE-2.0-SUPPLY') },
      });
      const { rows } = await c.query<{ amount: string; node: string }>(
        `select r.amount, n.code as node from wf.request r
           join core.hierarchy_node n on n.id = r.delivery_node_id where r.id = $1`,
        [id],
      );
      expect(rows).toEqual([{ amount: '60000.00', node: 'TEST-BAR-3.0-KITCHEN-STORE' }]);
      // the 60,000 from the row adds the area step; a caller cannot understate it
      expect((await steps(c, id)).map((s) => s.state)).toEqual(['pending', 'waiting']);
    });
  });

  it('no longer accepts caller-supplied nodes (old signature removed)', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(
        c,
        ids.user(KIM),
        `select wf.submit('PURCHASE_ORDER', 'inv.purchase_order', core.uuid_v7(), '{}', 1,
                          'INR', null, $1, null)`,
        [ids.node('TEST-BAR-3.0-KITCHEN-STORE')],
      );
      expect(r.error).toMatch(/function wf\.submit\(.*\) does not exist/);
    });
  });

  it('rejects missing, foreign-tenant, non-submittable and already-active subjects', async () => {
    await inRolledBackTx(async (c) => {
      const missing = await submit(c, KIM, { ...po(1), subjectId: ids.user(KIM) });
      expect(missing.error).toBe('INVALID_SUBJECT');
      const closed = await submit(c, KIM, { ...po(1), submittable: false });
      expect(closed.error).toBe('INVALID_SUBJECT');

      const subjectId = await subjectFor(c, po(1_000));
      await submitOk(c, KIM, { ...po(1_000), subjectId });
      expect((await submit(c, KIM, { ...po(1_000), subjectId })).error).toBe('INVALID_STATE');

      await c.query(`insert into core.tenant (id, name) values (core.uuid_v7(), 'Other')`);
      const other = await c.query<{ id: string }>(
        `select id from core.tenant where name = 'Other'`,
      );
      const make = fixtures.get(c)!;
      const foreign = await make({
        tenant: other.rows[0]!.id,
        delivery: ids.node('TEST-BAR-3.0-KITCHEN-STORE'),
        amount: 1,
      });
      expect((await submit(c, KIM, { ...po(1), subjectId: foreign })).error).toBe(
        'INVALID_SUBJECT',
      );
    });
  });

  it('refuses subject types without a registered resolver', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs(
        c,
        ids.user(SAM),
        `select wf.submit('SHIFT_SWAP', 'hr.shift_swap', core.uuid_v7())`,
      );
      expect(r.error).toBe('INVALID_SUBJECT');
    });
  });
});

describe('two-sided transfer', () => {
  const transfer = (): SubmitArgs => ({
    process: 'TRANSFER',
    subject: 'inv.transfer',
    delivery: 'TEST-BAR-3.0-KITCHEN-STORE',
    from: 'TEST-CENTRAL-KITCHEN-STORE',
    to: 'TEST-BAR-3.0-KITCHEN-STORE',
  });

  async function approveViaModule(c: PoolClient, who: string, id: string): Promise<string> {
    const r = await actViaModule(c, who, id);
    if (r.error !== undefined) throw new Error(`module approve failed: ${r.error}`);
    return r.rows[0]!.state;
  }

  it('scopes dispatch to the hub and receipt to the outlet; each side acts only on its step', async () => {
    await inRolledBackTx(async (c) => {
      expect((await submit(c, OLIVIA, transfer())).error).toBe('NOT_AUTHORISED'); // not an initiator
      const id = await submitOk(c, KIM, transfer());
      expect(await steps(c, id)).toEqual([
        {
          step: 'dispatch',
          state: 'pending',
          scope: 'TEST-CENTRAL-KITCHEN-STORE',
          grp: 'HUB_MANAGER',
        },
        {
          step: 'receipt',
          state: 'waiting',
          scope: 'TEST-BAR-3.0-KITCHEN-STORE',
          grp: 'OUTLET_MANAGER',
        },
      ]);
      expect((await actViaModule(c, OLIVIA, id)).error).toBe('NOT_AUTHORISED');
      expect(await approveViaModule(c, HUGO, id)).toBe('in_approval');
      expect((await actViaModule(c, HUGO, id)).error).toBe('NOT_AUTHORISED');
      expect(await approveViaModule(c, OLIVIA, id)).toBe('approved');
    });
  });

  it('takes from/to from the subject row, overriding the caller payload', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, KIM, {
        ...transfer(),
        payload: { from_node_id: ids.node('TEST-GUEST-HOUSE-2.0-SUPPLY'), note: 'kept' },
      });
      const { rows } = await c.query<{ payload: Record<string, string> }>(
        'select payload from wf.request where id = $1',
        [id],
      );
      expect(rows[0]!.payload).toEqual({
        note: 'kept',
        from_node_id: ids.node('TEST-CENTRAL-KITCHEN-STORE'),
        to_node_id: ids.node('TEST-BAR-3.0-KITCHEN-STORE'),
      });
    });
  });

  it('approves transfer steps only through the module (APPROVE_VIA_MODULE)', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, KIM, transfer());
      expect((await act(c, HUGO, id, 'approve')).error).toBe('APPROVE_VIA_MODULE');
      expect(await approveViaModule(c, HUGO, id)).toBe('in_approval');
      expect((await act(c, OLIVIA, id, 'approve')).error).toBe('APPROVE_VIA_MODULE');
    });
  });

  it('can be rejected or cancelled before dispatch, but not after (IRREVERSIBLE_STEP)', async () => {
    await inRolledBackTx(async (c) => {
      const early = await submitOk(c, KIM, transfer());
      expect(await actOk(c, HUGO, early, 'reject')).toBe('rejected');

      const cancelled = await submitOk(c, KIM, transfer());
      expect(await actOk(c, KIM, cancelled, 'cancel')).toBe('cancelled');

      const id = await submitOk(c, KIM, transfer());
      await approveViaModule(c, HUGO, id);
      expect((await act(c, OLIVIA, id, 'reject')).error).toBe('IRREVERSIBLE_STEP');
      expect((await act(c, KIM, id, 'cancel')).error).toBe('IRREVERSIBLE_STEP');
      expect(await approveViaModule(c, OLIVIA, id)).toBe('approved');
    });
  });
});

describe('inbox', () => {
  it('excludes requests the user initiated', async () => {
    await inRolledBackTx(async (c) => {
      await assign(c, CASEY, 'OUTLET_MANAGER', 'TEST-BAR-3.0');
      const id = await submitOk(c, OLIVIA, {
        process: 'LEAVE',
        subject: 'hr.leave_request',
        org: 'TEST-BAR-3.0',
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

  it('escalates LEAVE from the department head to the outlet manager (the chain)', async () => {
    await inRolledBackTx(async (c) => {
      const id = await submitOk(c, SAM, {
        process: 'LEAVE',
        subject: 'hr.leave_request',
        org: 'TEST-BAR-3.0-FLOOR-SERVICE',
      });
      expect(await steps(c, id)).toEqual([
        {
          step: 'manager_approval',
          state: 'pending',
          scope: 'TEST-BAR-3.0-FLOOR-SERVICE',
          grp: 'DEPARTMENT_HEAD',
        },
        { step: 'hr_approval', state: 'waiting', scope: 'TEST-COMPANY', grp: 'HR_ADMIN' },
      ]);
      expect(await inbox(c, FLOOR)).toContain(id);
      const none = await c.query('select * from wf.overdue_steps() where request_id = $1', [id]);
      expect(none.rows).toEqual([]);

      await makeOverdue(c, id, 49); // LEAVE SLA is 48 h
      const { rows } = await c.query<{ grp: string; node: string }>(
        `select g.code as grp, n.code as node from wf.overdue_steps() o
           join core.security_group g on g.id = o.target_group_id
           join core.hierarchy_node n on n.id = o.target_node_id
          where o.request_id = $1`,
        [id],
      );
      expect(rows).toEqual([{ grp: 'OUTLET_MANAGER', node: 'TEST-BAR-3.0' }]);

      const escalated = await c.query<{ n: number }>('select wf.escalate_overdue() as n');
      expect(escalated.rows[0]!.n).toBe(1);
      expect((await steps(c, id))[0]).toEqual({
        step: 'manager_approval',
        state: 'pending',
        scope: 'TEST-BAR-3.0',
        grp: 'OUTLET_MANAGER',
      });
      expect(await inbox(c, FLOOR)).not.toContain(id);
      expect(await inbox(c, OLIVIA)).toContain(id);
      // overdue again: the next group of the chain, the area manager
      await makeOverdue(c, id, 49);
      await c.query('select wf.escalate_overdue()');
      expect((await steps(c, id))[0]).toMatchObject({ grp: 'AREA_MANAGER' });
      expect(await actOk(c, ARIA, id, 'approve')).toBe('in_approval');
      expect(await inbox(c, HARPER)).toContain(id);
    });
  });

  it('keeps an overdue step pending and lists it as unroutable when no one is left in its chain', async () => {
    await inRolledBackTx(async (c) => {
      // TRANSFER dispatch: HUB_MANAGER at the hub, nobody above the hub, and (for this
      // test) no account owner at the end of the chain.
      await c.query(
        `update core.role_assignment set effective_from = date '2020-01-01',
                effective_to = date '2020-12-31' where user_id = $1`,
        [ids.user(OWNER)],
      );
      const id = await submitOk(c, KIM, {
        process: 'TRANSFER',
        subject: 'inv.transfer',
        delivery: 'TEST-BAR-3.0-KITCHEN-STORE',
        from: 'TEST-CENTRAL-KITCHEN-STORE',
        to: 'TEST-BAR-3.0-KITCHEN-STORE',
      });
      await makeOverdue(c, id, 25); // TRANSFER SLA is 24 h
      const un = await c.query<{ request_id: string; step: string }>(
        'select request_id, step from wf.unroutable_steps() where request_id = $1',
        [id],
      );
      expect(un.rows).toEqual([{ request_id: id, step: 'dispatch' }]);
      const escalated = await c.query<{ n: number }>('select wf.escalate_overdue() as n');
      expect(escalated.rows[0]!.n).toBe(0);
      expect((await steps(c, id))[0]).toMatchObject({
        state: 'pending',
        scope: 'TEST-CENTRAL-KITCHEN-STORE',
      });
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
      expect((await steps(c, id))[0]).toMatchObject({
        scope: 'TEST-AREA-MUMBAI',
        grp: 'AREA_MANAGER',
      });
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
