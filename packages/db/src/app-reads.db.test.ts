import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_USERS, devUserKey } from './dev-users';
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
      'test.head-cook.3.0',
      'select display_name, kind from core.me()',
    );
    expect(r.rows).toEqual([{ display_name: 'Test Head Cook 3.0', kind: 'human' }]);
  });

  it('returns nothing for an inactive user or no user', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`update core.app_user set status = 'inactive' where id = $1`, [
        ids.user('test.server.3.0'),
      ]);
      const r = await attemptAs(c, ids.user('test.server.3.0'), 'select * from core.me()');
      expect(r.rows).toEqual([]);
      const none = await attemptAs(c, '', 'select * from core.me()');
      expect(none.rows).toEqual([]);
    });
  });
});

describe('core.my_domains', () => {
  it('head cook: store keeper of the kitchen store and head of the kitchen', async () => {
    const d = await domains('test.head-cook.3.0');
    expect(d).toMatchObject({
      STOCK_LEVELS: 'view',
      STOCK_ADJUSTMENTS: 'modify',
      PURCHASE_ORDERS: 'modify',
      TRANSFERS: 'modify',
      AI_RECOMMENDATIONS: 'view',
      ROSTER: 'modify', // DEPARTMENT_HEAD
      EVENTS: 'modify', // DEPARTMENT_HEAD
      WORKERS: 'view', // DEPARTMENT_HEAD
      LEAVE: 'modify', // SELF
      ATTENDANCE: 'modify', // DEPARTMENT_HEAD
    });
    expect(d).not.toHaveProperty('SECURITY_ROLES');
    expect(d).not.toHaveProperty('AUDIT');
  });

  it('area manager: derived views surface as the underlying domain', async () => {
    const d = await domains('test.area-manager');
    expect(d).toMatchObject({
      STOCK_LEVELS: 'view',
      PURCHASE_ORDERS: 'view',
      TRANSFERS: 'view',
      ROSTER: 'view',
      STOCK_ADJUSTMENTS: 'view', // DERIVED_STOCK_ADJUSTMENTS (ADR 009)
    });
  });

  it('SECURITY_ROLES for the account owner, security admin and auditor (view) only', async () => {
    expect(await domains('test.hr-admin')).not.toHaveProperty('SECURITY_ROLES');
    expect((await domains('test.account-owner')).SECURITY_ROLES).toBe('view');
    expect((await domains('test.security-admin')).SECURITY_ROLES).toBe('view');
    expect((await domains('test.auditor')).SECURITY_ROLES).toBe('view');
    expect(await domains('test.bar-manager.3.0')).not.toHaveProperty('SECURITY_ROLES');
    expect(await domains('test.server.3.0')).not.toHaveProperty('STOCK_LEVELS');
  });
});

describe('core.nodes', () => {
  it('head cook: their department and the store it uses', async () => {
    expect(await nodes('test.head-cook.3.0')).toEqual([
      'org:Test Bar 3.0 – Kitchen',
      'delivery:Test Bar 3.0 – Kitchen Store',
    ]);
  });

  it('area manager: the area subtree, plus every stock place under it as derived', async () => {
    const all = await nodes('test.area-manager');
    const org = all.filter((n) => n.startsWith('org:'));
    const delivery = all.filter((n) => n.startsWith('delivery:'));
    expect(org[0]).toBe('org:Test Area Mumbai');
    expect(org).toHaveLength(31); // the area, 4 outlets and the central kitchen, departments
    expect(org).not.toContain('org:Test Company');
    expect(delivery).toHaveLength(15); // supply points and stores of all four, CK store
    expect(delivery.every((n) => n.endsWith(' (derived)'))).toBe(true);
    expect(delivery).toContain('delivery:Test Bar 3.0 – Kitchen Store (derived)');
    expect(delivery).not.toContain('delivery:Test Supply Network (derived)');
  });

  it('central kitchen manager: the store and everything it supplies; dispatch team', async () => {
    const delivery = await nodes('test.central-kitchen-manager', 'delivery');
    expect(delivery[0]).toBe('delivery:Test Central Kitchen – Store');
    expect(delivery).toHaveLength(15);
    expect(delivery).toContain('delivery:Test Guest House 2.0 – Supply Point');
    expect(await nodes('test.central-kitchen-manager', 'org')).toEqual([
      'org:Test Central Kitchen – Dispatch Team',
    ]);
  });
});

describe('core.user_for_cognito_sub', () => {
  it('maps an active user by Cognito sub, and nothing for unknown or inactive users', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`update core.app_user set cognito_sub = 'sub-kim' where id = $1`, [
        ids.user('test.head-cook.3.0'),
      ]);
      const hit = await attemptAs<{ id: string | null }>(
        c,
        '',
        'select core.user_for_cognito_sub($1) as id',
        ['sub-kim'],
      );
      expect(hit.rows?.[0]?.id).toBe(ids.user('test.head-cook.3.0'));
      const miss = await attemptAs<{ id: string | null }>(
        c,
        '',
        'select core.user_for_cognito_sub($1) as id',
        ['nope'],
      );
      expect(miss.rows?.[0]?.id).toBeNull();
      await c.query(`update core.app_user set status = 'inactive' where id = $1`, [
        ids.user('test.head-cook.3.0'),
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
    expect(await procs('test.head-cook.3.0')).toEqual([
      'LEAVE',
      'PURCHASE_ORDER',
      'SHIFT_SWAP',
      'STOCK_ADJUSTMENT',
      'TRANSFER',
    ]);
    expect(await procs('test.bar-manager.3.0')).toEqual([
      'LEAVE',
      'PURCHASE_ORDER',
      'SHIFT_SWAP',
      'STOCK_ADJUSTMENT',
    ]);
    expect(await procs('ai-agent')).toEqual(['PURCHASE_ORDER']); // no SELF for services
    // user administration moved to User Admins and Account Owners (ADR 009)
    expect(await procs('test.hr-admin')).toEqual(['LEAVE', 'SHIFT_SWAP']);
    expect(await procs('test.account-owner')).toEqual(['LEAVE', 'ROLE_CHANGE', 'SHIFT_SWAP']);
  });
});

describe('admin reads', () => {
  it('allow SECURITY_ROLES holders and refuse everyone else', async () => {
    for (const who of ['test.account-owner', 'test.security-admin', 'test.auditor']) {
      const a = await as<{ user_name: string }>(who, 'select * from core.admin_role_assignments()');
      expect(a.error, who).toBeUndefined();
      expect(a.rows!.length).toBeGreaterThan(10);
      const p = await as<{ domain_code: string }>(
        who,
        'select * from core.admin_domain_policies()',
      );
      expect(p.rows!.length).toBeGreaterThan(10);
    }
    for (const who of ['test.bar-manager.3.0', 'test.head-cook.3.0', 'ai-agent', 'test.hr-admin']) {
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
  it('each resolves, by customer and username, to an active test user of that name', async () => {
    for (const u of DEV_USERS) {
      const { rows } = await migratorPool.query<{ name: string | null }>(
        `select (select display_name from core.app_user
                  where id = core.user_for_username($1, $2)) as name`,
        [u.customer, u.username],
      );
      expect(rows[0]!.name, devUserKey(u)).toBe(u.name);
    }
    // the lookup is for people only, and only active ones
    const agent = await migratorPool.query<{ id: string | null }>(
      `select core.user_for_username('TEST-COMPANY', 'ai-agent') as id`,
    );
    expect(agent.rows[0]!.id).toBeNull();
  });
});
