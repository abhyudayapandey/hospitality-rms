import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import {
  actAs,
  appPool,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  migratorPool,
  resetRole,
  sqlState,
  type NodeKey,
  type SeedIds,
} from '../test/helpers';

// Table-driven access matrix for core.can(), evaluated as app_rw against the seed
// (packages/db/seed/001_core.sql, ADR 002). Each row is one decision.

const SAM = 'Sam Staff';
const CASEY = 'Casey Chef';
const KIM = 'Kim Storekeeper';
const OLIVIA = 'Olivia Outlet Manager';
const ARIA = 'Aria Area Manager';
const HUGO = 'Hugo Hub Manager';
const HARPER = 'Harper HR Admin';
const SASHA = 'Sasha Security Admin';
const AVERY = 'Avery Auditor';
const AGENT = 'Outlet Ops AI Agent';

const O_COMPANY: NodeKey = 'org:Company';
const O_REGION: NodeKey = 'org:Region';
const O_AREA: NodeKey = 'org:Area';
const O_A: NodeKey = 'org:Outlet A';
const O_B: NodeKey = 'org:Outlet B';
const D_NET: NodeKey = 'delivery:Company Supply Network';
const D_HUB: NodeKey = 'delivery:Hub';
const D_A: NodeKey = 'delivery:Outlet A';
const D_B: NodeKey = 'delivery:Outlet B';

type Access = 'view' | 'modify';
type Case = [
  who: string | null,
  domain: string,
  access: Access,
  node: NodeKey | null,
  owner: string | null,
  expected: boolean,
  why: string,
];

const cases: Case[] = [
  // STAFF: ROSTER V + EVENTS V at own outlet; everything else only via SELF
  [SAM, 'ROSTER', 'view', O_A, null, true, 'staff sees roster at own outlet'],
  [SAM, 'ROSTER', 'modify', O_A, null, false, 'staff cannot edit roster'],
  [SAM, 'ROSTER', 'view', O_B, null, false, 'cross-outlet denial'],
  [SAM, 'EVENTS', 'view', O_A, null, true, 'staff sees events at own outlet'],
  [SAM, 'EVENTS', 'view', O_AREA, null, false, 'assignment does not grant upwards'],
  [SAM, 'STOCK_LEVELS', 'view', D_A, null, false, 'staff has no stock access'],
  [SAM, 'LEAVE', 'view', O_A, null, false, 'no LEAVE via hierarchy'],
  [SAM, 'LEAVE', 'modify', O_A, SAM, true, 'self-service: own leave'],
  [SAM, 'LEAVE', 'modify', O_A, CASEY, false, 'self-service: not others'],
  [SAM, 'ATTENDANCE', 'modify', O_A, SAM, true, 'self-service: own attendance'],
  [SAM, 'COMPENSATION', 'view', O_A, SAM, true, 'self-service: view own pay'],
  [SAM, 'COMPENSATION', 'modify', O_A, SAM, false, 'self-service: pay is view-only'],
  [SAM, 'WORKERS', 'view', O_A, SAM, true, 'self-service: own worker record'],
  [SAM, 'WORKERS', 'modify', O_A, SAM, false, 'self-service: worker record view-only'],

  // Multi-assignment: STAFF@org Outlet A + CHEF@delivery Outlet A
  [CASEY, 'ROSTER', 'view', O_A, null, true, 'chef via STAFF'],
  [CASEY, 'EVENTS', 'view', O_A, null, true, 'chef via STAFF'],
  [CASEY, 'STOCK_LEVELS', 'view', D_A, null, true, 'chef via CHEF'],
  [CASEY, 'STOCK_ADJUSTMENTS', 'modify', D_A, null, true, 'chef via CHEF'],
  [CASEY, 'STOCK_ADJUSTMENTS', 'modify', D_B, null, false, 'cross-outlet denial'],
  [CASEY, 'PURCHASE_ORDERS', 'modify', D_A, null, false, 'chef cannot raise POs'],
  [CASEY, 'ROSTER', 'modify', O_A, null, false, 'chef cannot edit roster'],

  // Multi-assignment: STAFF@org Outlet A + STORE_KEEPER@delivery Outlet A
  [KIM, 'PURCHASE_ORDERS', 'modify', D_A, null, true, 'store keeper raises POs'],
  [KIM, 'TRANSFERS', 'view', D_A, null, true, 'store keeper views transfers'],
  [KIM, 'TRANSFERS', 'modify', D_A, null, true, 'store keeper initiates transfers (ADR 003)'],
  [KIM, 'STOCK_LEVELS', 'view', D_B, null, false, 'cross-outlet denial'],
  [KIM, 'EVENTS', 'view', O_A, null, true, 'store keeper via STAFF'],

  // OUTLET_MANAGER at Outlet A in both trees (+ STAFF)
  [OLIVIA, 'ROSTER', 'modify', O_A, null, true, 'manages own outlet roster'],
  [OLIVIA, 'ROSTER', 'modify', O_B, null, false, 'cross-outlet denial'],
  [OLIVIA, 'ROSTER', 'view', O_B, null, false, 'cross-outlet denial (view)'],
  [OLIVIA, 'STOCK_LEVELS', 'view', D_A, null, true, 'own outlet stock'],
  [OLIVIA, 'STOCK_LEVELS', 'view', D_B, null, false, 'cross-outlet denial (stock)'],
  [OLIVIA, 'STOCK_LEVELS', 'view', D_HUB, null, false, 'cannot see hub stock'],
  [OLIVIA, 'TRANSFERS', 'modify', D_A, null, true, 'requests transfers'],
  [OLIVIA, 'EVENTS', 'modify', O_A, null, true, 'manages events'],
  [OLIVIA, 'AI_RECOMMENDATIONS', 'modify', O_A, null, true, 'responds to AI recs'],
  [OLIVIA, 'LEAVE', 'view', O_A, null, true, 'sees team leave'],
  [OLIVIA, 'LEAVE', 'modify', O_A, null, false, 'cannot edit others leave directly'],
  [OLIVIA, 'COMPENSATION', 'view', O_A, null, false, 'no pay data'],

  // AREA_MANAGER at Area: inheritance + derived delivery views
  [ARIA, 'ROSTER', 'view', O_A, null, true, 'inherits down to Outlet A'],
  [ARIA, 'ROSTER', 'view', O_B, null, true, 'inherits down to Outlet B'],
  [ARIA, 'ROSTER', 'view', O_AREA, null, true, 'at the assigned node'],
  [ARIA, 'ROSTER', 'view', O_REGION, null, false, 'not above the assigned node'],
  [ARIA, 'ROSTER', 'modify', O_A, null, false, 'view-only'],
  [ARIA, 'STOCK_LEVELS', 'view', D_A, null, true, 'derived stock view via node_link'],
  [ARIA, 'STOCK_LEVELS', 'view', D_B, null, true, 'derived stock view via node_link'],
  [ARIA, 'STOCK_LEVELS', 'modify', D_A, null, false, 'derived access is view-only'],
  [ARIA, 'STOCK_LEVELS', 'view', D_HUB, null, false, 'hub is not linked to her area'],
  [ARIA, 'PURCHASE_ORDERS', 'view', D_A, null, true, 'derived PO view'],
  [ARIA, 'PURCHASE_ORDERS', 'modify', D_A, null, false, 'derived PO view-only'],
  [ARIA, 'TRANSFERS', 'view', D_B, null, true, 'derived transfers view'],
  [ARIA, 'STOCK_ADJUSTMENTS', 'view', D_A, null, false, 'no derived stock adjustments'],
  [ARIA, 'COMPENSATION', 'view', O_A, null, false, 'no pay data'],

  // HUB_MANAGER at Hub (no descendants) + SUPPLY_VIEWER at Hub (with descendants)
  [HUGO, 'STOCK_LEVELS', 'view', D_HUB, null, true, 'hub stock'],
  [HUGO, 'STOCK_ADJUSTMENTS', 'modify', D_HUB, null, true, 'adjusts hub stock'],
  [HUGO, 'STOCK_LEVELS', 'view', D_A, null, true, 'SUPPLY_VIEWER covers outlets'],
  [HUGO, 'STOCK_ADJUSTMENTS', 'modify', D_A, null, false, 'HUB_MANAGER does not descend'],
  [HUGO, 'STOCK_LEVELS', 'modify', D_A, null, false, 'SUPPLY_VIEWER is view-only'],
  [HUGO, 'TRANSFERS', 'modify', D_HUB, null, true, 'dispatches from hub'],
  [HUGO, 'TRANSFERS', 'modify', D_A, null, false, 'HUB_MANAGER does not descend'],
  [HUGO, 'TRANSFERS', 'view', D_A, null, false, 'SUPPLY_VIEWER is stock only'],
  [HUGO, 'STOCK_LEVELS', 'view', D_NET, null, false, 'not above the hub'],
  [HUGO, 'ROSTER', 'view', O_A, null, false, 'no org access'],

  // HR_ADMIN at Company
  [HARPER, 'WORKERS', 'modify', O_A, null, true, 'inherits from company'],
  [HARPER, 'COMPENSATION', 'modify', O_B, null, true, 'inherits from company'],
  [HARPER, 'LEAVE', 'modify', O_A, null, true, 'manages leave'],
  [HARPER, 'ROSTER', 'modify', O_A, null, false, 'roster is view-only for HR'],
  [HARPER, 'STOCK_LEVELS', 'view', D_A, null, false, 'no stock access'],

  // SECURITY_ADMIN / AUDITOR
  [SASHA, 'AUDIT', 'view', O_COMPANY, null, true, 'reads audit log'],
  [SASHA, 'AUDIT', 'modify', O_COMPANY, null, false, 'audit is never modifiable'],
  [SASHA, 'ROSTER', 'view', O_A, null, false, 'no business data'],
  [AVERY, 'AUDIT', 'view', O_COMPANY, null, true, 'reads audit log'],
  [AVERY, 'WORKERS', 'view', O_A, null, false, 'no business data'],

  // AI agent: view-only except AI recommendations
  [AGENT, 'STOCK_LEVELS', 'view', D_A, null, true, 'views outlet stock from network root'],
  [AGENT, 'STOCK_LEVELS', 'view', D_HUB, null, true, 'views hub stock'],
  [AGENT, 'STOCK_LEVELS', 'modify', D_A, null, false, 'never modifies stock'],
  [AGENT, 'PURCHASE_ORDERS', 'view', D_B, null, true, 'views POs'],
  [AGENT, 'PURCHASE_ORDERS', 'modify', D_B, null, false, 'POs only via wf.submit'],
  [AGENT, 'ROSTER', 'view', O_B, null, true, 'views roster'],
  [AGENT, 'ROSTER', 'modify', O_B, null, false, 'never edits roster'],
  [AGENT, 'AI_RECOMMENDATIONS', 'modify', O_A, null, true, 'writes recommendations'],
  [AGENT, 'COMPENSATION', 'view', O_A, null, false, 'no pay data'],
  [AGENT, 'AUDIT', 'view', O_COMPANY, null, false, 'no audit access'],

  // No user / bad input
  [null, 'STOCK_LEVELS', 'view', D_A, null, false, 'no app.user_id set'],
  [OLIVIA, 'NO_SUCH_DOMAIN', 'view', O_A, null, false, 'unknown domain'],
  [OLIVIA, 'ROSTER', 'view', null, null, false, 'row without a node'],
];

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function can(
  who: string | null,
  domain: string,
  access: Access,
  node: NodeKey | null,
  owner: string | null,
): Promise<boolean> {
  const client = await appPool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.user_id', $1, true)`, [who ? ids.user(who) : '']);
    const nodeId = node ? ids.node(node) : null;
    const isOrg = node?.startsWith('org:') ?? true;
    const { rows } = await client.query<{ ok: boolean }>(
      'select core.can($1, $2, $3, $4, $5) as ok',
      [
        domain,
        access,
        isOrg ? nodeId : null,
        isOrg ? null : nodeId,
        owner ? ids.user(owner) : null,
      ],
    );
    return rows[0]!.ok;
  } finally {
    await client.query('rollback');
    client.release();
  }
}

describe('core.can() access matrix', () => {
  it.each(cases)(
    '%s %s %s @ %s (owner %s) -> %s: %s',
    async (who, domain, access, node, owner, expected) => {
      expect(await can(who, domain, access, node, owner)).toBe(expected);
    },
  );
});

describe('AI agent is view-only (CLAUDE.md rule 6)', () => {
  it('has modify on no domain except AI_RECOMMENDATIONS', async () => {
    const { rows: domains } = await migratorPool.query<{ code: string; hierarchy_type: string }>(
      'select code, hierarchy_type from core.domain order by code',
    );
    expect(domains.length).toBeGreaterThan(0);
    const modifiable: string[] = [];
    for (const d of domains) {
      // The agent is assigned at both roots, so each domain's root covers every node below.
      const root: NodeKey = d.hierarchy_type === 'delivery' ? D_NET : O_COMPANY;
      if (await can(AGENT, d.code, 'modify', root, null)) modifiable.push(d.code);
    }
    expect(modifiable).toEqual(['AI_RECOMMENDATIONS']);
  });
});

describe('assignment lifecycle (rolled back)', () => {
  async function canIn(c: PoolClient, who: string, domain: string, access: Access, node: NodeKey) {
    await actAs(c, 'app_rw', ids.user(who));
    const nodeId = ids.node(node);
    const isOrg = node.startsWith('org:');
    const { rows } = await c.query<{ ok: boolean }>('select core.can($1, $2, $3, $4) as ok', [
      domain,
      access,
      isOrg ? nodeId : null,
      isOrg ? null : nodeId,
    ]);
    await resetRole(c);
    return rows[0]!.ok;
  }

  it('denies an expired assignment', async () => {
    await inRolledBackTx(async (c) => {
      expect(await canIn(c, ARIA, 'ROSTER', 'view', O_A)).toBe(true);
      await c.query(
        `update core.role_assignment set effective_from = current_date - 10,
                effective_to = current_date - 1 where user_id = $1`,
        [ids.user(ARIA)],
      );
      expect(await canIn(c, ARIA, 'ROSTER', 'view', O_A)).toBe(false);
    });
  });

  it('denies a future-dated assignment', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `update core.role_assignment set effective_from = current_date + 1 where user_id = $1`,
        [ids.user(ARIA)],
      );
      expect(await canIn(c, ARIA, 'ROSTER', 'view', O_A)).toBe(false);
    });
  });

  it('denies an inactive user, including self-service', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`update core.app_user set status = 'inactive' where id = $1`, [ids.user(SAM)]);
      expect(await canIn(c, SAM, 'ROSTER', 'view', O_A)).toBe(false);
      await actAs(c, 'app_rw', ids.user(SAM));
      const { rows } = await c.query<{ ok: boolean }>(
        `select core.can('LEAVE', 'modify', $1, null, $2) as ok`,
        [ids.node(O_A), ids.user(SAM)],
      );
      expect(rows[0]!.ok).toBe(false);
    });
  });

  it('moving a node re-paths its subtree and access follows', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into core.hierarchy_node (tenant_id, type, kind, name, parent_id)
         select tenant_id, 'org', 'area', 'Area 2', parent_id from core.hierarchy_node where id = $1
         returning id`,
        [ids.node(O_AREA)],
      );
      const area2 = rows[0]!.id;
      await c.query('update core.hierarchy_node set parent_id = $1 where id = $2', [
        area2,
        ids.node(O_B),
      ]);
      const paths = await c.query<{ ok: boolean }>(
        // Compare as text: ltree operators live in schema extensions, not on the search_path.
        `select b.path::text like a2.path::text || '.%' as ok
           from core.hierarchy_node b, core.hierarchy_node a2 where b.id = $1 and a2.id = $2`,
        [ids.node(O_B), area2],
      );
      expect(paths.rows[0]!.ok).toBe(true);
      expect(await canIn(c, ARIA, 'ROSTER', 'view', O_B)).toBe(false);
      expect(await canIn(c, ARIA, 'ROSTER', 'view', O_A)).toBe(true);
      expect(await canIn(c, HARPER, 'WORKERS', 'modify', O_B)).toBe(true);
    });
  });

  it('resolves codes within the user tenant when another tenant reuses them', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into core.tenant (name) values ('Other Tenant') returning id`,
      );
      const other = rows[0]!.id;
      await c.query(
        `insert into core.domain (tenant_id, code, hierarchy_type) values ($1, 'ROSTER', 'delivery')`,
        [other],
      );
      await c.query(
        `insert into core.security_group (tenant_id, code, name, kind)
         values ($1, 'SELF', 'Self', 'user_based'), ($1, 'STAFF', 'Staff', 'role')`,
        [other],
      );
      expect(await canIn(c, SAM, 'ROSTER', 'view', O_A)).toBe(true);
      expect(await canIn(c, SAM, 'ROSTER', 'modify', O_A)).toBe(false);
    });
  });

  it('rejects a parent from the other tree and cycles', async () => {
    await inRolledBackTx(async (c) => {
      expect(
        await sqlState(c, 'update core.hierarchy_node set parent_id = $1 where id = $2', [
          ids.node(D_HUB),
          ids.node(O_B),
        ]),
      ).toBe('P0001');
      expect(
        await sqlState(c, 'update core.hierarchy_node set parent_id = $1 where id = $2', [
          ids.node(O_A),
          ids.node(O_AREA),
        ]),
      ).toBe('P0001');
    });
  });
});
