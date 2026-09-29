import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_USERS } from './dev-users';
import {
  attemptAs,
  closePools,
  inRolledBackTx,
  loadSeedIds,
  migratorPool,
  type SeedIds,
} from '../test/helpers';

// Read functions used by the web app (ADR 004): core.me, core.my_domains, core.nodes,
// core.user_for_cognito_sub, wf.my_processes and the read-only admin lists.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

async function as<T extends object>(who: string, text: string, params: unknown[] = []) {
  return inRolledBackTx(async (c) => {
    const r = await attemptAs<T>(c, ids.user(who), text, params);
    if (r.error !== undefined) return { error: r.error };
    return { rows: r.rows };
  });
}

async function domains(who: string): Promise<Record<string, string>> {
  const r = await as<{ domain: string; access: string }>(who, 'select * from core.my_domains()');
  return Object.fromEntries((r.rows ?? []).map((x) => [x.domain, x.access]));
}

async function nodes(who: string, type: string | null = null): Promise<string[]> {
  const r = await as<{ type: string; name: string; derived: boolean }>(
    who,
    'select type, name, derived from core.nodes($1)',
    [type],
  );
  return (r.rows ?? []).map((n) => `${n.type}:${n.name}${n.derived ? ' (derived)' : ''}`);
}

describe('core.me', () => {
  it('returns the current active user', async () => {
    const r = await as<{ display_name: string; kind: string }>(
      'Kim Storekeeper',
      'select display_name, kind from core.me()',
    );
    expect(r.rows).toEqual([{ display_name: 'Kim Storekeeper', kind: 'human' }]);
  });

  it('returns nothing for an inactive user or no user', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`update core.app_user set status = 'inactive' where id = $1`, [
        ids.user('Sam Staff'),
      ]);
      const r = await attemptAs(c, ids.user('Sam Staff'), 'select * from core.me()');
      expect(r.rows).toEqual([]);
      const none = await attemptAs(c, '', 'select * from core.me()');
      expect(none.rows).toEqual([]);
    });
  });
});

describe('core.my_domains', () => {
  it('store keeper: stock and orders, AI recommendations view, self-service', async () => {
    const d = await domains('Kim Storekeeper');
    expect(d).toMatchObject({
      STOCK_LEVELS: 'view',
      STOCK_ADJUSTMENTS: 'modify',
      PURCHASE_ORDERS: 'modify',
      TRANSFERS: 'modify',
      AI_RECOMMENDATIONS: 'view',
      ROSTER: 'view',
      EVENTS: 'view',
      LEAVE: 'modify', // SELF
      ATTENDANCE: 'modify', // SELF
    });
    expect(d).not.toHaveProperty('SECURITY_ROLES');
    expect(d).not.toHaveProperty('AUDIT');
  });

  it('area manager: derived views surface as the underlying domain', async () => {
    const d = await domains('Aria Area Manager');
    expect(d).toMatchObject({
      STOCK_LEVELS: 'view',
      PURCHASE_ORDERS: 'view',
      TRANSFERS: 'view',
      ROSTER: 'view',
    });
    expect(d).not.toHaveProperty('STOCK_ADJUSTMENTS');
  });

  it('SECURITY_ROLES for HR admin (modify), security admin and auditor (view) only', async () => {
    expect((await domains('Harper HR Admin')).SECURITY_ROLES).toBe('modify');
    expect((await domains('Sasha Security Admin')).SECURITY_ROLES).toBe('view');
    expect((await domains('Avery Auditor')).SECURITY_ROLES).toBe('view');
    expect(await domains('Olivia Outlet Manager')).not.toHaveProperty('SECURITY_ROLES');
    expect(await domains('Sam Staff')).not.toHaveProperty('STOCK_LEVELS');
  });
});

describe('core.nodes', () => {
  it('store keeper: own outlet in both trees', async () => {
    expect(await nodes('Kim Storekeeper')).toEqual(['org:Outlet A', 'delivery:Outlet A']);
  });

  it('area manager: area subtree plus derived delivery outlets', async () => {
    expect(await nodes('Aria Area Manager')).toEqual([
      'org:Area',
      'org:Outlet A',
      'org:Outlet B',
      'delivery:Outlet A (derived)',
      'delivery:Outlet B (derived)',
    ]);
  });

  it('hub manager: the hub, plus outlets through SUPPLY_VIEWER', async () => {
    expect(await nodes('Hugo Hub Manager', 'delivery')).toEqual([
      'delivery:Hub',
      'delivery:Outlet A',
      'delivery:Outlet B',
    ]);
    expect(await nodes('Hugo Hub Manager', 'org')).toEqual([]);
  });
});

describe('core.user_for_cognito_sub', () => {
  it('maps an active user by Cognito sub, and nothing for unknown or inactive users', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`update core.app_user set cognito_sub = 'sub-kim' where id = $1`, [
        ids.user('Kim Storekeeper'),
      ]);
      const hit = await attemptAs<{ id: string | null }>(
        c,
        '',
        'select core.user_for_cognito_sub($1) as id',
        ['sub-kim'],
      );
      expect(hit.rows?.[0]?.id).toBe(ids.user('Kim Storekeeper'));
      const miss = await attemptAs<{ id: string | null }>(
        c,
        '',
        'select core.user_for_cognito_sub($1) as id',
        ['nope'],
      );
      expect(miss.rows?.[0]?.id).toBeNull();
      await c.query(`update core.app_user set status = 'inactive' where id = $1`, [
        ids.user('Kim Storekeeper'),
      ]);
      const off = await attemptAs<{ id: string | null }>(
        c,
        '',
        'select core.user_for_cognito_sub($1) as id',
        ['sub-kim'],
      );
      expect(off.rows?.[0]?.id).toBeNull();
    });
  });
});

describe('wf.my_processes', () => {
  const procs = async (who: string) =>
    (
      (await as<{ process_type: string }>(who, 'select process_type from wf.my_processes()'))
        .rows ?? []
    ).map((r) => r.process_type);

  it('lists what each user may initiate', async () => {
    expect(await procs('Kim Storekeeper')).toEqual([
      'LEAVE',
      'PURCHASE_ORDER',
      'SHIFT_SWAP',
      'STOCK_ADJUSTMENT',
      'TRANSFER',
    ]);
    expect(await procs('Olivia Outlet Manager')).toEqual([
      'LEAVE',
      'PURCHASE_ORDER',
      'SHIFT_SWAP',
      'STOCK_ADJUSTMENT',
    ]);
    expect(await procs('Outlet Ops AI Agent')).toEqual(['PURCHASE_ORDER']); // no SELF for services
    expect(await procs('Harper HR Admin')).toEqual(['LEAVE', 'ROLE_CHANGE', 'SHIFT_SWAP']);
  });
});

describe('admin reads', () => {
  it('allow SECURITY_ROLES holders and refuse everyone else', async () => {
    for (const who of ['Harper HR Admin', 'Sasha Security Admin', 'Avery Auditor']) {
      const a = await as<{ user_name: string }>(who, 'select * from core.admin_role_assignments()');
      expect(a.error, who).toBeUndefined();
      expect(a.rows!.length).toBeGreaterThan(10);
      const p = await as<{ domain_code: string }>(
        who,
        'select * from core.admin_domain_policies()',
      );
      expect(p.rows!.length).toBeGreaterThan(10);
    }
    for (const who of ['Olivia Outlet Manager', 'Kim Storekeeper', 'Outlet Ops AI Agent']) {
      expect((await as(who, 'select * from core.admin_role_assignments()')).error, who).toBe(
        'NOT_AUTHORISED',
      );
      expect((await as(who, 'select * from core.admin_domain_policies()')).error, who).toBe(
        'NOT_AUTHORISED',
      );
    }
  });
});

describe('dev users', () => {
  it('matches the seeded users', async () => {
    const { rows } = await migratorPool.query<{ id: string; display_name: string }>(
      'select id, display_name from core.app_user order by id',
    );
    expect(rows.map((r) => [r.id, r.display_name])).toEqual(
      [...DEV_USERS].sort((a, b) => a.id.localeCompare(b.id)).map((u) => [u.id, u.name]),
    );
  });
});
