import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// core.screen_places(screen) (ADR 016): the places the "Viewing:" switcher offers on a
// screen. Each screen lists only its own kind of place, and only places where the person
// passes that screen's core.can() check; the most useful place comes first.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

interface Place {
  id: string;
  code: string;
  kind: string;
  type: string;
  preferred: number;
}

async function places(c: PoolClient, user: string, screen: string): Promise<Place[]> {
  const r = await attemptAs<Place>(
    c,
    ids.user(user),
    'select id, code, kind, type, preferred from core.screen_places($1)',
    [screen],
  );
  if (r.error) throw new Error(`${user} ${screen}: ${r.error}`);
  return r.rows;
}
const codes = (ps: Place[]) => ps.map((p) => p.code);

/** The rule each screen applies, row by row, as an independent check (n = a hierarchy_node). */
const RULES: Record<string, string> = {
  stock: `n.type = 'delivery' and n.holds_stock and core.can('STOCK_LEVELS', 'view', null, n.id)`,
  count: `n.type = 'delivery' and n.holds_stock and core.can('STOCK_ADJUSTMENTS', 'modify', null, n.id)`,
  wastage: `n.type = 'delivery' and n.holds_stock and core.can('STOCK_ADJUSTMENTS', 'modify', null, n.id)`,
  orders: `n.type = 'delivery' and n.holds_stock and core.can('PURCHASE_ORDERS', 'view', null, n.id)`,
  transfers: `n.type = 'delivery' and n.holds_stock and core.can('TRANSFERS', 'view', null, n.id)`,
  variance: `n.type = 'delivery' and n.holds_stock and core.can('MENU', 'view', null, n.id)`,
  production: `n.type = 'delivery' and n.holds_stock and inv.can_produce_at(n.id)
               and exists (select 1 from inv.item_node x where x.delivery_node_id = n.id
                              and x.made_here and x.archived_at is null)`,
  sales: `n.type = 'org' and exists (select 1 from menu.menu_outlet mo
                                       where mo.org_node_id = n.id
                                         and (mo.effective_to is null or mo.effective_to >= current_date)
                                         and core.can('SALES', 'modify', null, mo.delivery_node_id))`,
  menu: `n.type = 'org' and exists (select 1 from menu.menu_outlet mo
                                      where mo.org_node_id = n.id
                                        and (mo.effective_to is null or mo.effective_to >= current_date)
                                        and core.can('MENU', 'view', null, mo.delivery_node_id))`,
  roster: `n.type = 'org' and core.is_team_place(n.id) and core.can('ROSTER', 'view', n.id, null)`,
  exceptions: `n.type = 'org' and core.is_team_place(n.id) and core.can('ATTENDANCE', 'modify', n.id, null)`,
  events: `n.type = 'org' and n.kind in ('outlet', 'site') and ops.can_read_event_node(n.id)`,
};

describe('core.screen_places', () => {
  it('returns exactly the places that pass the screen rule, for a spread of people', async () => {
    await inRolledBackTx(async (c) => {
      const users = [
        'test.account-owner',
        'test.area-manager',
        'test.general-manager.1.0',
        'test.executive-chef.1.0',
        'test.bartender.1.0',
        'test.commis.1.0',
        'test.store-keeper.1.0',
        'test.cost-controller.1.0',
        'test.central-kitchen-manager',
        'test.front-desk-executive.2.0',
        'test.hr-admin',
        'test.solo.bar-manager',
      ];
      const mismatches: string[] = [];
      for (const u of users) {
        for (const [screen, rule] of Object.entries(RULES)) {
          const got = codes(await places(c, u, screen)).sort();
          await c.query(`select set_config('app.user_id', $1, true)`, [ids.user(u)]);
          const { rows } = await c.query<{ code: string }>(
            `select n.code from core.hierarchy_node n
              where n.tenant_id = core.my_tenant() and n.archived_at is null and ${rule}
              order by n.code`,
          );
          await c.query(`select set_config('app.user_id', '', true)`);
          const want = rows.map((r) => r.code).sort();
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            mismatches.push(`${u} ${screen}: got [${got.join(', ')}], want [${want.join(', ')}]`);
          }
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  it('stock screens list stores only, people screens departments only', async () => {
    await inRolledBackTx(async (c) => {
      const gm = 'test.general-manager.1.0';
      const stock = await places(c, gm, 'stock');
      expect(codes(stock)).toEqual([
        'TEST-HOTEL-1.0-MAIN-STORE',
        'TEST-HOTEL-1.0-BAR-STORE',
        'TEST-HOTEL-1.0-HOUSEKEEPING-STORE',
        'TEST-HOTEL-1.0-KITCHEN-STORE',
      ]);
      expect(new Set(stock.map((p) => p.type))).toEqual(new Set(['delivery']));
      const roster = await places(c, gm, 'roster');
      expect(roster.length).toBe(10);
      expect(new Set(roster.map((p) => p.kind))).toEqual(new Set(['department']));
      expect(roster.every((p) => p.code.startsWith('TEST-HOTEL-1.0-'))).toBe(true);
    });
  });

  it('the most useful place comes first', async () => {
    await inRolledBackTx(async (c) => {
      // GM -> Main Store on Stock; department head -> their department on Roster;
      // bartender -> Bar Store on Production
      expect((await places(c, 'test.general-manager.1.0', 'stock'))[0]!.code).toBe(
        'TEST-HOTEL-1.0-MAIN-STORE',
      );
      expect((await places(c, 'test.executive-chef.1.0', 'roster'))[0]!.code).toBe(
        'TEST-HOTEL-1.0-KITCHEN',
      );
      expect((await places(c, 'test.executive-chef.1.0', 'stock'))[0]!.code).toBe(
        'TEST-HOTEL-1.0-KITCHEN-STORE',
      );
      expect(codes(await places(c, 'test.bartender.1.0', 'production'))).toEqual([
        'TEST-HOTEL-1.0-BAR-STORE',
      ]);
      expect((await places(c, 'test.general-manager.1.0', 'events'))[0]!.code).toBe(
        'TEST-HOTEL-1.0',
      );
    });
  });

  it('frontline staff: no stock places; production at their store only', async () => {
    await inRolledBackTx(async (c) => {
      expect(await places(c, 'test.bartender.1.0', 'stock')).toEqual([]);
      expect(codes(await places(c, 'test.commis.1.0', 'production'))).toEqual([
        'TEST-HOTEL-1.0-KITCHEN-STORE',
      ]);
      expect(await places(c, 'test.kitchen-steward.1.0', 'production')).toEqual([]);
      // the main store makes nothing: no Production for its store keeper
      expect(await places(c, 'test.store-keeper.1.0', 'production')).toEqual([]);
      expect(codes(await places(c, 'test.commis.1.0', 'events'))).toEqual(['TEST-HOTEL-1.0']);
      expect(await places(c, 'test.commis.1.0', 'exceptions')).toEqual([]);
    });
  });

  it('an area manager sees outlets on Menu', async () => {
    await inRolledBackTx(async (c) => {
      const menu = await places(c, 'test.area-manager', 'menu');
      expect(menu.length).toBeGreaterThan(1);
      expect(new Set(menu.map((p) => p.kind))).toEqual(new Set(['outlet']));
    });
  });

  it('never another customer’s places, and unknown screens are refused', async () => {
    await inRolledBackTx(async (c) => {
      for (const screen of Object.keys(RULES)) {
        for (const p of await places(c, 'test.solo.bar-manager', screen)) {
          expect(p.code, screen).toMatch(/^TEST-SOLO-/);
        }
      }
      const r = await attemptAs(
        c,
        ids.user('test.general-manager.1.0'),
        `select * from core.screen_places('inbox')`,
      );
      expect(r.error).toBe('INVALID_SCREEN');
    });
  });
});
