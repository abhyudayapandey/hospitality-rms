import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Needs attention by department (DB-2, ADR 033). A department carries a type (file 01's
// department_type): kitchen, service or housekeeping; anything else, or blank, is "other".
// core.department_of tells Home which department each flagged place belongs to and in what
// order to show them: Kitchen, then Service, then Housekeeping, then the rest; places
// outside any department (the outlet itself) come last. It returns names and order only,
// and only for the person's own company.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

interface Row {
  node_id: string;
  department_id: string | null;
  department: string | null;
  department_type: string | null;
  rank: number;
  outlet: string | null;
}

const departmentOf = (c: Parameters<typeof attemptAs>[0], user: string, codes: string[]) =>
  attemptAs<Row>(c, ids.user(user), 'select * from core.department_of($1::uuid[])', [
    codes.map((x) => ids.node(x)),
  ]);

describe('department order (DB-2)', () => {
  it('org places, stores and the outlet itself, in the agreed order', async () => {
    await inRolledBackTx(async (c) => {
      const codes = [
        'TEST-HOTEL-1.0-SECURITY',
        'TEST-HOTEL-1.0-HOUSEKEEPING',
        'TEST-HOTEL-1.0-RESTAURANT',
        'TEST-HOTEL-1.0-KITCHEN',
        'TEST-HOTEL-1.0',
        'TEST-HOTEL-1.0-KITCHEN-STORE',
        'TEST-HOTEL-1.0-MAIN-STORE',
        'TEST-HOTEL-1.0-BAR-STORE',
      ];
      const r = await departmentOf(c, 'test.general-manager.1.0', codes);
      expect(r.error).toBeUndefined();
      const by = new Map(r.rows!.map((x) => [x.node_id, x]));
      const at = (code: string) => {
        const x = by.get(ids.node(code))!;
        return [x.department, x.department_type, x.rank, x.outlet];
      };
      const outlet = 'Test Hotel & Bar 1.0';
      expect(at('TEST-HOTEL-1.0-KITCHEN')).toEqual([`${outlet} – Kitchen`, 'kitchen', 1, outlet]);
      expect(at('TEST-HOTEL-1.0-KITCHEN-STORE')).toEqual([
        `${outlet} – Kitchen`,
        'kitchen',
        1,
        outlet,
      ]);
      expect(at('TEST-HOTEL-1.0-RESTAURANT')).toEqual([
        `${outlet} – Restaurant`,
        'service',
        2,
        outlet,
      ]);
      expect(at('TEST-HOTEL-1.0-BAR-STORE')).toEqual([`${outlet} – Bar`, 'service', 2, outlet]);
      expect(at('TEST-HOTEL-1.0-HOUSEKEEPING')).toEqual([
        `${outlet} – Housekeeping`,
        'housekeeping',
        3,
        outlet,
      ]);
      expect(at('TEST-HOTEL-1.0-SECURITY')).toEqual([`${outlet} – Security`, 'other', 4, outlet]);
      expect(at('TEST-HOTEL-1.0-MAIN-STORE')).toEqual([
        `${outlet} – Stores Team`,
        'other',
        4,
        outlet,
      ]);
      expect(at('TEST-HOTEL-1.0')).toEqual([null, null, 5, outlet]);
    });
  });

  it('a blank type is other', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('update core.hierarchy_node set department_type = null where id = $1', [
        ids.node('TEST-HOTEL-1.0-KITCHEN'),
      ]);
      const r = await departmentOf(c, 'test.general-manager.1.0', ['TEST-HOTEL-1.0-KITCHEN']);
      expect(r.rows!.map((x) => [x.department_type, x.rank])).toEqual([['other', 4]]);
    });
  });

  it('only a department carries a type, and only a known one', async () => {
    await inRolledBackTx(async (c) => {
      const bad = async (code: string, type: string) => {
        await c.query('savepoint t');
        try {
          await c.query('update core.hierarchy_node set department_type = $2 where id = $1', [
            ids.node(code),
            type,
          ]);
          return 'ok';
        } catch (e) {
          return (e as { code?: string }).code;
        } finally {
          await c.query('rollback to savepoint t');
        }
      };
      expect(await bad('TEST-HOTEL-1.0', 'kitchen')).toBe('23514');
      expect(await bad('TEST-HOTEL-1.0-KITCHEN-STORE', 'kitchen')).toBe('23514');
      expect(await bad('TEST-HOTEL-1.0-KITCHEN', 'pastry')).toBe('23514');
      expect(await bad('TEST-HOTEL-1.0-KITCHEN', 'service')).toBe('ok');
    });
  });

  it('nothing about another company’s places', async () => {
    await inRolledBackTx(async (c) => {
      const r = await departmentOf(c, 'test.general-manager.1.0', [
        'TEST-SOLO-BAR-BAR',
        'TEST-SOLO-BAR-BAR-STORE',
      ]);
      expect(r.rows).toEqual([]);
      const solo = await departmentOf(c, 'test.solo.bar-manager', ['TEST-SOLO-BAR-BAR']);
      expect(solo.rows!.map((x) => [x.department_type, x.rank])).toEqual([['service', 2]]);
    });
  });
});
