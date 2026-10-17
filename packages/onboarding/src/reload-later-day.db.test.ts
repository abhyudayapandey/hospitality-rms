import { join } from 'node:path';
import { closePools, inRolledBackTx } from '@outlet-ops/db/test-helpers';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadCustomer } from './apply';
import { createCustomer } from './create';
import { readCustomerDir } from './dir';

// A test customer loaded again on a later day of the same week adds no shifts (ADR 114, 167):
// this week's shifts load once a person. A reload dated Sunday after a Saturday load added
// Sunday to a week already rostered and failed on WEEKLY_HOURS_CAP, so the passport demo test
// was red every Saturday. The first loads here are the last Saturday and the Wednesday before
// it (past days: a batch is never made in the future), whatever day the test runs.

afterAll(closePools);
vi.setConfig({ testTimeout: 300_000 });

const DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'onboarding',
  'demo',
  'passport-hotel',
);
const PASSPORT = {
  code: 'PASSPORT-TEST',
  name: '[TEST] Passport Hotel',
  country: 'India',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  isTest: true,
  owner: {
    displayName: 'Ashesh Sajnani',
    email: null,
    username: 'test.ashesh-sajnani',
    loginType: 'username' as const,
  },
};

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
// the business day in India (04:00 to 04:00), as the loader counts it
const today = Date.parse(`${iso(Date.now() + 5.5 * 3_600_000 - 4 * 3_600_000)}T00:00:00Z`);
const dow = new Date(today).getUTCDay(); // 0 = Sunday
const lastSaturday = today - ((dow + 1) % 7 || 7) * DAY;
const firstLoads = [iso(lastSaturday), iso(lastSaturday - 3 * DAY)]; // a Saturday, a Wednesday

describe('a test customer loaded again the next day', () => {
  it.each(firstLoads)('first loaded %s: the next day adds no shifts', async (day) => {
    await inRolledBackTx(async (c) => {
      const exists = await c.query(`select 1 from core.tenant where code = 'PASSPORT-TEST'`);
      if (exists.rowCount) return; // loaded here already (a local database)
      await c.query('set local role platform_loader');
      expect((await createCustomer(c, PASSPORT, { nested: true })).report.issues).toEqual([]);
      await c.query(
        `update core.tenant
            set settings = jsonb_set(settings, '{bundles}',
                             coalesce(settings -> 'bundles', '{}') || '{"hotel": true}')
          where code = 'PASSPORT-TEST'`,
      );
      const files = readCustomerDir(DIR);
      expect((await loadCustomer(c, files, { nested: true, today: day })).issues).toEqual([]);
      const later = await loadCustomer(c, files, {
        nested: true,
        dryRun: true,
        today: iso(Date.parse(`${day}T00:00:00Z`) + DAY),
      });
      expect(later.issues).toEqual([]);
      expect(later.counts['shift assignments']?.created ?? 0).toBe(0);
    });
  });
});
