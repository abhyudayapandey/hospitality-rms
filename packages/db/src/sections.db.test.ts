import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// Floor sections (ADR 133) on Test Hotel 1.0's restaurant (file 47: Section 1 to 3): its
// manager, captain or the GM gives them to the restaurant's people for a day; a server sees
// theirs on Home; nobody gives another department's sections or gives them to outsiders.

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});
afterAll(closePools);

const DEPT = 'TEST-HOTEL-1.0-RESTAURANT';

describe('floor sections (ADR 133)', () => {
  it('the restaurant manager gives Section 2 to a steward, who sees it as theirs today', async () => {
    await inRolledBackTx(async (c) => {
      const dept = ids.node(DEPT);
      const as = <T extends object>(who: string, sql: string, p: unknown[] = []) =>
        attemptAs<T>(c, ids.user(who), sql, p);
      const today = (await c.query<{ d: string }>(`select rpt.today($1)::text as d`, [dept]))
        .rows[0]!.d;
      const list = await as<{ section_id: string; name: string }>(
        'test.restaurant-manager.1.0',
        'select section_id, name from ops.sections($1, $2::date)',
        [dept, today],
      );
      expect(list.rows!.map((s) => s.name)).toEqual(['Section 1', 'Section 2', 'Section 3']);
      const two = list.rows!.find((s) => s.name === 'Section 2')!.section_id;
      const steward = ids.user('test.steward.1.0');
      const gave = await as(
        'test.restaurant-manager.1.0',
        'select ops.give_sections($1, $2::date, $3, $4::uuid[])',
        [dept, today, steward, [two]],
      );
      expect(gave.error).toBeUndefined();
      const mine = await as<{ sections: string }>(
        'test.steward.1.0',
        'select sections from ops.my_sections()',
      );
      expect(mine.rows).toEqual([{ sections: 'Section 2' }]);
      // the same section to another moves it; the first steward has none left
      await as('test.captain.1.0', 'select ops.give_sections($1, $2::date, $3, $4::uuid[])', [
        dept,
        today,
        ids.user('test.steward-b.1.0'),
        [two],
      ]);
      expect((await as('test.steward.1.0', 'select sections from ops.my_sections()')).rows).toEqual(
        [],
      );
    });
  });

  it('refuses a steward, another department, someone from elsewhere and a past day', async () => {
    await inRolledBackTx(async (c) => {
      const dept = ids.node(DEPT);
      const today = (await c.query<{ d: string }>(`select rpt.today($1)::text as d`, [dept]))
        .rows[0]!.d;
      const one = (
        await c.query<{ id: string }>(
          `select id from ops.service_section where org_node_id = $1 and name = 'Section 1'`,
          [dept],
        )
      ).rows[0]!.id;
      const give = (who: string, node: string, day: string, to: string) =>
        attemptAs(c, ids.user(who), 'select ops.give_sections($1, $2::date, $3, $4::uuid[])', [
          node,
          day,
          ids.user(to),
          [one],
        ]);
      // a steward does not give sections
      expect((await give('test.steward.1.0', dept, today, 'test.steward-b.1.0')).error).toMatch(
        /NOT_AUTHORISED/,
      );
      // the restaurant manager of another hotel does not give these
      expect(
        (await give('test.restaurant-manager.1.1', dept, today, 'test.steward.1.0')).error,
      ).toMatch(/NOT_AUTHORISED/);
      // only to someone who works in the restaurant
      expect(
        (await give('test.restaurant-manager.1.0', dept, today, 'test.commis.1.0')).error,
      ).toMatch(/INVALID_VALUE/);
      // today up to a week ahead
      const past = (await c.query<{ d: string }>(`select ($1::date - 1)::text as d`, [today]))
        .rows[0]!.d;
      expect(
        (await give('test.restaurant-manager.1.0', dept, past, 'test.steward.1.0')).error,
      ).toMatch(/INVALID_VALUE/);
      // a department with no sections has nothing to give
      const kitchen = ids.node('TEST-HOTEL-1.0-KITCHEN');
      expect(
        (
          await attemptAs<{ v: boolean }>(
            c,
            ids.user('test.restaurant-manager.1.0'),
            'select ops.gives_sections($1) as v',
            [kitchen],
          )
        ).rows,
      ).toEqual([{ v: false }]);
    });
  });
});
