import { join } from 'node:path';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadCustomer, type AccessRow } from './apply';
import { readCustomerDir } from './dir';

// File 37 (ADR 061): who covers a job role an outlet doesn't have. Loading it gives the
// covering role's people the covered role's access there, a second load changes nothing,
// leaving a row out takes the cover away (a load without the file leaves covers alone), and what the database refuses or doubts is reported
// against the file's row.

afterAll(closePools);
// each test loads Test Company up to three times (see loader.db.test.ts)
vi.setConfig({ testTimeout: 400_000 });

const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'onboarding', 'test-data');
const company = readCustomerDir(join(DATA, 'test-company'));
const withCover = (rows: string[]) => ({
  ...company,
  '37_role_cover.csv':
    ['outlet_code,job_role_code,mode,covered_by_role', ...rows].join('\n') + '\n',
});

const covered = (access: AccessRow[]) =>
  access
    .filter((a) => a.source.startsWith('covers '))
    .map((a) => `${a.username} ${a.access_group}@${a.node_code} ${a.source}`)
    .sort();

describe('who covers it (file 37)', () => {
  it('loads, changes nothing the second time, and is taken away when left out', async () => {
    await inRolledBackTx(async (c) => {
      const files = withCover([
        'TEST-GUEST-HOUSE-2.0,STORE_KEEPER,covered_by,FRONT_DESK_EXECUTIVE',
        'TEST-BAR-3.0,EXECUTIVE_CHEF,covered_by,COMMIS',
        'TEST-BAR-3.0,COOK,not_done,',
      ]);
      const first = await loadCustomer(c, files, { nested: true });
      expect(first.issues).toEqual([]);
      expect(first.counts['role cover']).toEqual({ created: 3, updated: 0, unchanged: 0 });
      expect(covered(first.access)).toEqual([
        'test.commis.3.0 DEPARTMENT_HEAD@TEST-BAR-3.0-KITCHEN covers Executive Chef',
        'test.commis.3.0 STORE_KEEPER@TEST-BAR-3.0-KITCHEN-STORE covers Executive Chef',
        'test.front-desk-executive.2.0 STORE_KEEPER@TEST-GUEST-HOUSE-2.0-SUPPLY covers Store Keeper',
      ]);
      // what the dry run says to check, by row
      expect(
        first.warnings
          .filter((w) => w.file === '37_role_cover.csv')
          .map((w) => `${w.row ?? '-'}: ${w.message}`),
      ).toEqual([
        '3: COMMIS (works) covers EXECUTIVE_CHEF (runs department) at TEST-BAR-3.0: check that is meant',
        '4: TEST-BAR-3.0 has 1 COOK: its checklists stop all the same',
        '-: Kitchen opening at TEST-BAR-3.0-KITCHEN goes to COOK, which is not done there: it has no rounds',
      ]);

      const again = await loadCustomer(c, files, { nested: true });
      expect(again.issues).toEqual([]);
      expect(again.counts['role cover']).toEqual({ created: 0, updated: 0, unchanged: 3 });
      expect(again.access).toEqual(first.access);

      // a re-import without file 37 leaves the covers as they are
      const noFile = await loadCustomer(c, company, { nested: true });
      expect(noFile.issues).toEqual([]);
      expect(noFile.counts['role cover']).toBeUndefined();
      expect(covered(noFile.access)).toEqual(covered(first.access));

      // left out of the file: archived, and the access goes with it
      const without = await loadCustomer(
        c,
        withCover(['TEST-BAR-3.0,EXECUTIVE_CHEF,covered_by,COMMIS']),
        { nested: true },
      );
      expect(without.issues).toEqual([]);
      expect(without.counts['role cover']).toEqual({ created: 0, updated: 2, unchanged: 1 });
      expect(covered(without.access)).toEqual([
        'test.commis.3.0 DEPARTMENT_HEAD@TEST-BAR-3.0-KITCHEN covers Executive Chef',
        'test.commis.3.0 STORE_KEEPER@TEST-BAR-3.0-KITCHEN-STORE covers Executive Chef',
      ]);
    });
  });

  it('reports what the database refuses against the row, and loads nothing', async () => {
    await inRolledBackTx(async (c) => {
      const r = await loadCustomer(
        c,
        withCover([
          'TEST-HOTEL-1.1,HOUSEKEEPING_SUPERVISOR,covered_by,FRONT_DESK_EXECUTIVE',
          'TEST-BAR-3.0,STORE_KEEPER,covered_by,BAR_MANAGER',
          'TEST-GUEST-HOUSE-2.0,AREA_MANAGER,covered_by,GENERAL_MANAGER',
        ]),
        { nested: true, dryRun: true },
      );
      expect(r.ok).toBe(false);
      expect(r.issues.map((i) => `${i.file} ${i.row} ${i.column}: ${i.message}`)).toEqual([
        '37_role_cover.csv 3 job_role_code: MAIN_STORE_REQUIRED (main_store) (JOB_ROLE_SCOPE)',
        '37_role_cover.csv 4 job_role_code: Area Manager holds AREA_MANAGER over the whole area (COVER_ABOVE_OUTLET)',
      ]);
      // the good row still says what to check
      expect(
        r.warnings.filter((w) => w.file === '37_role_cover.csv').map((w) => w.message),
      ).toEqual([
        'TEST-HOTEL-1.1 has 1 HOUSEKEEPING_SUPERVISOR: they and every FRONT_DESK_EXECUTIVE there will share its work',
      ]);
    });
  });
});
