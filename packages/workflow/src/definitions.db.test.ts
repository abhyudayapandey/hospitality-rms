import { closePools, migratorPool } from '@outlet-ops/db/test-helpers';
import { afterAll, describe, expect, it } from 'vitest';
import { PROCESS_DEFS } from './processes';

// Every tenant's process definitions match the code, and core.bp_policy (synced from
// bp-policy.ts) grants every group the definitions route to.

afterAll(closePools);

describe('process definitions in the database', () => {
  it('wf.process_def holds exactly the code definitions, in every tenant', async () => {
    const tenants = await migratorPool.query<{ id: string }>('select id from core.tenant');
    expect(tenants.rowCount).toBeGreaterThan(0);
    const expected = [...PROCESS_DEFS]
      .sort((a, b) => a.type.localeCompare(b.type))
      .map((d) => JSON.parse(JSON.stringify(d)) as unknown);
    for (const { id } of tenants.rows) {
      const { rows } = await migratorPool.query<{ definition: unknown }>(
        'select definition from wf.process_def where tenant_id = $1 order by process_type',
        [id],
      );
      expect(rows.map((r) => r.definition)).toEqual(expected);
    }
  });

  it('has a bp_policy approve row for every step group and escalateTo group', async () => {
    const { rows } = await migratorPool.query<{ key: string }>(
      `select bp.process_type || '/' || bp.step || '/' || g.code as key
         from core.bp_policy bp join core.security_group g on g.id = bp.group_id
        where bp.action = 'approve'`,
    );
    const have = new Set(rows.map((r) => r.key));
    for (const d of PROCESS_DEFS) {
      for (const s of d.steps) {
        expect(have, `${d.type}/${s.step}/${s.group}`).toContain(`${d.type}/${s.step}/${s.group}`);
        if (s.escalateTo) {
          expect(have).toContain(`${d.type}/${s.step}/${s.escalateTo}`);
        }
      }
    }
  });

  it('has an initiator for every process', async () => {
    const { rows } = await migratorPool.query<{ process_type: string }>(
      `select distinct process_type from core.bp_policy where action = 'initiate'`,
    );
    expect(rows.map((r) => r.process_type).sort()).toEqual(PROCESS_DEFS.map((d) => d.type).sort());
  });
});
