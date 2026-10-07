import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds, type SeedIds } from '../test/helpers';

// "A newer version" of a library checklist (ADR 068). Hotel 1.1's kitchen has the library's
// Kitchen opening as a copy (KITCHEN-OPENING@1, ADR 066). When the library has a version 2,
// whoever edits the checklist may take its steps: the steps and the version change, the name,
// schedule and who it goes to stay the outlet's. The copy must be of that library checklist
// and the version newer; anyone who may not edit it is refused.

afterAll(closePools);

let ids: SeedIds;
beforeAll(async () => {
  ids = await loadSeedIds();
});

const KITCHEN = 'TEST-HOTEL-1.1-KITCHEN';
const NEW_STEPS = [
  { label: 'Walk-in chiller', kind: 'number', min: 0, max: 5, unit: '°C' },
  { label: 'Allergen board updated', kind: 'tick' },
];

type Copy = {
  id: string;
  name: string;
  schedule: unknown;
  assign: unknown;
  steps: unknown;
  library_code: string | null;
  library_version: number | null;
};

async function copy(c: import('pg').PoolClient): Promise<Copy> {
  const { rows } = await c.query<Copy>(
    `select id, name, schedule, assign, steps, library_code, library_version
       from ops.checklist_template
      where org_node_id = $1 and library_code = 'KITCHEN-OPENING' and archived_at is null`,
    [ids.node(KITCHEN)],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const use = (
  c: import('pg').PoolClient,
  who: string,
  id: string,
  code: string,
  version: number,
  steps: unknown = NEW_STEPS,
) =>
  attemptAs(c, ids.user(who), 'select ops.use_library_version($1, $2, $3, $4::jsonb)', [
    id,
    code,
    version,
    JSON.stringify(steps),
  ]);

describe('a newer library version', () => {
  it('the checklist screen reads where a copy came from', async () => {
    await inRolledBackTx(async (c) => {
      const r = await attemptAs<{ library_code: string; library_version: number }>(
        c,
        ids.user('test.executive-chef.1.1'),
        `select library_code, library_version from ops.checklists($1) where name = 'Kitchen opening'`,
        [ids.node(KITCHEN)],
      );
      expect(r.rows).toEqual([{ library_code: 'KITCHEN-OPENING', library_version: 1 }]);
    });
  });

  it('its editor takes the new steps; the name, schedule and who it goes to stay', async () => {
    await inRolledBackTx(async (c) => {
      const before = await copy(c);
      const r = await use(c, 'test.executive-chef.1.1', before.id, 'KITCHEN-OPENING', 2);
      expect(r.error).toBeUndefined();
      const after = await copy(c);
      expect(after.steps).toEqual(NEW_STEPS);
      expect(after.library_version).toBe(2);
      expect([after.name, after.schedule, after.assign]).toEqual([
        before.name,
        before.schedule,
        before.assign,
      ]);
      // and it is in the audit, by them
      const audit = await c.query<{ actor: string }>(
        `select u.username actor from audit.log l join core.app_user u on u.id = l.actor_id
          where l.table_name = 'ops.checklist_template' and l.row_id = $1 and l.op = 'UPDATE'`,
        [before.id],
      );
      expect(audit.rows.map((a) => a.actor)).toEqual(['test.executive-chef.1.1']);
    });
  });

  it('refused: someone who may not edit it, the same or an older version, another checklist', async () => {
    await inRolledBackTx(async (c) => {
      const { id } = await copy(c);
      expect((await use(c, 'test.commis.1.1', id, 'KITCHEN-OPENING', 2)).error).toMatch(
        /NOT_AUTHORISED/,
      );
      expect((await use(c, 'test.executive-chef.1.0', id, 'KITCHEN-OPENING', 2)).error).toMatch(
        /NOT_AUTHORISED/,
      );
      for (const [code, version] of [
        ['KITCHEN-OPENING', 1],
        ['CHILLER-LOG', 2],
      ] as const) {
        expect(
          (await use(c, 'test.executive-chef.1.1', id, code, version)).error,
          `${code}@${version}`,
        ).toMatch(/INVALID_STATE/);
      }
      expect((await use(c, 'test.executive-chef.1.1', id, 'KITCHEN-OPENING', 2, [])).error).toMatch(
        /INVALID_STEPS/,
      );
      expect((await copy(c)).library_version).toBe(1);
    });
  });
});
