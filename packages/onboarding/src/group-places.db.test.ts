import { groupFitsPlace } from '@outlet-ops/domain';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import { afterAll, describe, expect, it } from 'vitest';

// Admin → Add access offers a group only where it fits (ADR 151): every grant the test customers'
// files give (job roles, extra access, cover) is at a place the rule allows.

afterAll(closePools);

describe('where groups are given', () => {
  it('every loaded grant fits groupFitsPlace', async () => {
    await inRolledBackTx(async (c) => {
      const { rows } = await c.query<{ code: string; type: string; kind: string }>(
        `select distinct g.code, n.type, n.kind
           from core.role_assignment ra
           join core.security_group g on g.id = ra.group_id
           join core.hierarchy_node n on n.id = ra.node_id`,
      );
      expect(rows.length).toBeGreaterThan(20);
      expect(
        rows.filter((r) => !groupFitsPlace(r.code, r)).map((r) => `${r.code}@${r.type}:${r.kind}`),
      ).toEqual([]);
    });
  });
});
