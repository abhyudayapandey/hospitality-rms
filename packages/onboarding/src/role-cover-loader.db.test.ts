import { join } from 'node:path';
import { attemptAs, closePools, inRolledBackTx, loadSeedIds } from '@outlet-ops/db/test-helpers';
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
// Test Company without its own file 37 (the seed's one cover, ADR 066), so each test says
// which covers it loads
const { '37_role_cover.csv': seedCover, ...company } = readCustomerDir(join(DATA, 'test-company'));
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
      // the seed already has 2.0's (ADR 066)
      expect(seedCover).toContain(
        'TEST-GUEST-HOUSE-2.0,STORE_KEEPER,covered_by,FRONT_DESK_EXECUTIVE',
      );
      expect(first.counts['role cover']).toEqual({ created: 2, updated: 0, unchanged: 1 });
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

  it('warns before changing or removing a cover set in Admin since the last import (ADR 065)', async () => {
    await inRolledBackTx(async (c) => {
      const ids = await loadSeedIds();
      const files = withCover([
        'TEST-GUEST-HOUSE-2.0,STORE_KEEPER,covered_by,FRONT_DESK_EXECUTIVE',
        'TEST-BAR-3.0,COOK,not_done,',
      ]);
      expect((await loadCustomer(c, files, { nested: true })).issues).toEqual([]);
      // Admin → Who does what: one changed, one removed, one added, by the Account Owner
      const owner = ids.user('test.account-owner');
      for (const [outlet, role, answer, by] of [
        ['TEST-GUEST-HOUSE-2.0', 'STORE_KEEPER', 'covered_by', 'GENERAL_MANAGER'],
        ['TEST-BAR-3.0', 'COOK', 'have', null],
        ['TEST-HOTEL-1.1', 'SOUS_CHEF', 'not_done', null],
      ] as const) {
        const r = await attemptAs(c, owner, 'select core.set_role_cover($1, $2, $3, $4)', [
          ids.node(outlet),
          role,
          answer,
          by,
        ]);
        expect(r.error).toBeUndefined();
      }
      const when = (
        await c.query<{ t: string }>(
          `select to_char(now() at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') t`,
        )
      ).rows[0]!.t;
      const setInApp = (w: { message: string }) => w.message.includes('set in the app');

      const back = await loadCustomer(c, files, { nested: true });
      expect(back.issues).toEqual([]);
      expect(back.warnings.filter(setInApp)).toEqual([
        {
          file: '37_role_cover.csv',
          row: 3,
          column: 'job_role_code',
          message:
            `TEST-BAR-3.0 COOK: set in the app by Test Account Owner on ${when} Asia/Kolkata ` +
            `to "We have it"; this import makes it "We don't do this"`,
        },
        {
          file: '37_role_cover.csv',
          row: 2,
          column: 'job_role_code',
          message:
            `TEST-GUEST-HOUSE-2.0 STORE_KEEPER: set in the app by Test Account Owner on ${when} ` +
            'Asia/Kolkata to "Someone else does it: GENERAL_MANAGER"; this import makes it ' +
            '"Someone else does it: FRONT_DESK_EXECUTIVE"',
        },
        {
          file: '37_role_cover.csv',
          message:
            `TEST-HOTEL-1.1 SOUS_CHEF: set in the app by Test Account Owner on ${when} ` +
            `Asia/Kolkata to "We don't do this"; this import makes it "We have it"`,
        },
      ]);
      // the file is the whole truth again, and the next import has nothing to warn about
      const { rows } = await c.query<{ n: number }>(
        `select count(*)::int n from hr.role_cover c
          where c.archived_at is null and c.set_in_app_by is not null`,
      );
      expect(rows[0]!.n).toBe(0);
      expect((await loadCustomer(c, files, { nested: true })).warnings.filter(setInApp)).toEqual(
        [],
      );
    });
  });
});
