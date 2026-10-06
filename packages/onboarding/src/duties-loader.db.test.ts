import { join } from 'node:path';
import { expandDuty } from '@outlet-ops/domain';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import type { PoolClient } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadCustomer, type AccessRow } from './apply';
import { parseCsv } from './csv';
import { readCustomerDir } from './dir';

// Duties in file 06 (ADR 059): a job role given by its duties and the same role given by
// GROUP@scope load to the same rows and the same access, a file in the old form still
// loads without changing anything, and a bad duty is reported by file, row and column.

afterAll(closePools);
// each test loads Test Company, up to twice (see loader.db.test.ts)
vi.setConfig({ testTimeout: 300_000 });

const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data');
const FILE = '06_job_roles.csv';

const key = (r: AccessRow) =>
  [r.username, r.access_group, r.node_code, r.covers, r.source].join(' | ');

/** File 06 rewritten in the old form: every duty spelled out as GROUP@scope. */
function asDirectGrants(text: string): string {
  const table = parseCsv(text);
  const lines = ['job_role_code,job_title,outlet_format,usual_department,default_access'];
  for (const r of table.rows) {
    const v = r.values;
    const access = v['default_duties']!.split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap((p) => {
        const [code, at] = p.split('@');
        return expandDuty(code!, at).map(
          (g) => `${g.group}@${g.scope}${g.includeDescendants ? '' : '(this store only)'}`,
        );
      });
    lines.push(
      [
        v['job_role_code'],
        v['job_title'],
        v['outlet_format'],
        v['usual_department'],
        access.join('; '),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** The 1-based line of a role's row (the header is line 1). */
const rowOf = (text: string, code: string) =>
  text.split('\n').findIndex((l) => l.startsWith(`${code},`)) + 1;

async function roleRows(c: PoolClient): Promise<string[]> {
  const { rows } = await c.query<{ k: string }>(
    `select a.job_role_code || ' ' || a.outlet_format || ' ' || a.access_group || '@' || a.scope
            || ' ' || a.include_descendants || ' ' || coalesce(a.duty_code, '-') k
       from hr.job_role_access a join core.tenant t on t.id = a.tenant_id
      where t.code = 'TEST-COMPANY' order by 1`,
  );
  return rows.map((r) => r.k);
}

describe('duties in file 06', () => {
  const files = readCustomerDir(join(DATA, 'test-company'));

  it('duties and the same grants spelled out load to the same rows and access', async () => {
    await inRolledBackTx(async (c) => {
      const byDuties = await loadCustomer(c, files, { nested: true });
      expect(byDuties.issues).toEqual([]);
      const rowsByDuties = await roleRows(c);
      expect(rowsByDuties.some((r) => r.endsWith(' -'))).toBe(false);

      // the old form, over the same customer: nothing changes, labels included
      const old = { ...files, [FILE]: asDirectGrants(files[FILE]!) };
      const byGrants = await loadCustomer(c, old, { nested: true });
      expect(byGrants.issues).toEqual([]);
      expect(byGrants.access.map(key).sort()).toEqual(byDuties.access.map(key).sort());
      expect(byGrants.counts['job role access']).toMatchObject({ created: 0, updated: 0 });
      expect(await roleRows(c)).toEqual(rowsByDuties);
    });
  });

  it('labels a customer loaded in the old form with its duties', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(
        `delete from hr.job_role_access a using core.tenant t
          where t.id = a.tenant_id and t.code = 'TEST-COMPANY'`,
      );
      const old = { ...files, [FILE]: asDirectGrants(files[FILE]!) };
      const r = await loadCustomer(c, old, { nested: true });
      expect(r.issues).toEqual([]);
      expect((await roleRows(c)).some((row) => row.endsWith(' -'))).toBe(false);
    });
  });

  it('reports an unknown duty and a duty given at a department it cannot be given at', async () => {
    await inRolledBackTx(async (c) => {
      const text = files[FILE]!.replace(
        'BELLBOY,Bellboy,any,FRONT-OFFICE,WORKS_SHIFTS',
        'BELLBOY,Bellboy,any,FRONT-OFFICE,WORKS_SHIFT',
      ).replace(
        'ROOM_ATTENDANT,Room Attendant,any,HOUSEKEEPING,WORKS_SHIFTS',
        'ROOM_ATTENDANT,Room Attendant,any,HOUSEKEEPING,WORKS_SHIFTS@department:BAR',
      );
      const r = await loadCustomer(c, { ...files, [FILE]: text }, { nested: true });
      expect(r.applied).toBe(false);
      expect(r.issues.map((i) => `${i.file}:${i.row}:${i.column}:${i.message}`)).toEqual([
        `${FILE}:${rowOf(text, 'BELLBOY')}:default_duties:WORKS_SHIFT is not a duty`,
        `${FILE}:${rowOf(text, 'ROOM_ATTENDANT')}:default_duties:WORKS_SHIFTS cannot be given at another department`,
      ]);
    });
  });

  it('reports a grant given twice and a role with no access, and writes nothing', async () => {
    await inRolledBackTx(async (c) => {
      const text = files[FILE]!.replace(
        'STEWARD,Steward,any,RESTAURANT,WORKS_SHIFTS',
        'STEWARD,Steward,any,RESTAURANT,',
      ).replace(
        'HOST,Host,any,RESTAURANT / FLOOR-SERVICE,WORKS_SHIFTS',
        'HOST,Host,any,RESTAURANT / FLOOR-SERVICE,WORKS_SHIFTS; WORKS_SHIFTS',
      );
      const before = await roleRows(c);
      const r = await loadCustomer(c, { ...files, [FILE]: text }, { nested: true });
      expect(r.applied).toBe(false);
      expect(r.issues.map((i) => `${i.file}:${i.row}:${i.column}:${i.message}`)).toEqual([
        `${FILE}:${rowOf(text, 'STEWARD')}:default_duties:needs default_duties or default_access`,
        `${FILE}:${rowOf(text, 'HOST')}:default_duties:STAFF@home_department is given twice (already by WORKS_SHIFTS)`,
      ]);
      expect(await roleRows(c)).toEqual(before);
    });
  });
});
